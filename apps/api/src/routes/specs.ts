import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { DocumentSpecSchema, RetirementSchema, TemplateSchema } from '@ih/shared';
import { z } from 'zod';
import { error, md, noContent, res } from '../openapi/zod.js';
import { DefinitionSummarySchema } from '../specs/spec-registry.js';
import { listDefinitions, resolveDefinition } from '../templates/definitions.js';
import { typeExists } from '../templates/retirement.js';

const DefinitionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('spec'),
    id: z.string(),
    version: z.number().int(),
    spec: DocumentSpecSchema,
  }),
  z.object({
    kind: z.literal('template'),
    id: z.string(),
    version: z.number().int(),
    template: TemplateSchema,
  }),
]);

const TypeParams = z.object({ id: z.string().describe('The document type id.') });
const RetirementView = z.object({ id: z.string(), retired: RetirementSchema });
const ADMINS_ONLY = error('`admins only`: the session was opened with a user token.');
const TYPE_NOT_FOUND = error('`document type not found`.');

export const specRoutes: FastifyPluginAsync = async (app) => {
  /** Document types available for upload (published templates + file definitions). */
  app.get<{ Querystring: Record<string, string> }>(
    '/specs',
    {
      schema: {
        tags: ['Specs'],
        operationId: 'listSpecs',
        summary: 'List the document types available for upload',
        description: md`
          Every version a document can be uploaded with: published database recipes, and the
          definitions in the repository's \`specs/\` folder (legacy \`spec.yaml\`, and
          \`template.yaml\` files not yet seeded into the database), sorted by id and version.
          Drafts are not listed; they can only be test-run. Retired document types are left out
          unless \`retired=include\`.
        `,
        querystring: z
          .object({
            retired: z
              .enum(['include'])
              .optional()
              .describe('`include`: list retired document types too, each with `retired`.'),
          })
          .strict(),
        response: {
          200: res('The document type versions.', z.array(DefinitionSummarySchema)),
          400: error('Zod issues for an invalid query.'),
        },
      },
    },
    async (req, reply) => {
      const query = z
        .object({ retired: z.enum(['include']).optional() })
        .strict()
        .safeParse(req.query);
      if (!query.success) return reply.code(400).send({ error: query.error.issues });
      return listDefinitions(app.deps, { includeRetired: query.data.retired === 'include' });
    },
  );

  app.get<{ Params: { id: string }; Querystring: { version?: string } }>(
    '/specs/:id',
    {
      schema: {
        tags: ['Specs'],
        operationId: 'getSpec',
        summary: 'Get a document type definition',
        description: md`
          The parsed definition of a document type version: a legacy spec (\`kind: spec\`) or a
          recipe (\`kind: template\`). Without \`version\`, the latest published version (a
          database recipe first, then the newest file). A \`version\` may name a draft.
        `,
        params: z.object({ id: z.string().describe('The document type id.') }),
        querystring: z.object({
          version: z.string().optional().describe('A version number. Default: the latest.'),
        }),
        response: {
          200: res('The definition.', DefinitionSchema),
          404: error('`spec not found`.'),
          422: error('`{id} v{version} is not valid`: a stored draft that does not parse.'),
        },
      },
    },
    async (req, reply) => {
      const version = req.query.version ? Number(req.query.version) : undefined;
      const resolved = await resolveDefinition(app.deps, req.params.id, version);
      if (!resolved) return reply.code(404).send({ error: 'spec not found' });
      if (!resolved.ok) return reply.code(422).send({ error: resolved.error });
      return resolved.definition;
    },
  );

  /** Admins only (ADR 0006); `deps.access === null` disables it in unit tests. */
  const adminOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (app.deps.access && req.auth?.role !== 'admin') {
      return reply.code(403).send({ error: 'admins only' });
    }
  };

  app.put<{ Params: { id: string } }>(
    '/specs/:id/retirement',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Specs'],
        'x-admin': true,
        operationId: 'retireDocumentType',
        summary: 'Retire a document type',
        description: md`
          Retires every version of a document type (a recipe or a legacy spec). Nothing is
          deleted: its jobs, results, references and versions stay readable, and jobs already
          queued or running finish. It is left out of \`GET /api/specs\` (unless
          \`?retired=include\`) and of the Workbench list (unless \`retired=include\`), and new
          work for it is refused with a 409 \`{name} is retired: unretire it to use it again\`:
          uploads, retries, test and regression runs, new drafts, publishing, imports and the
          Workbench actions that queue jobs. Retiring a retired type keeps its first retirement.
        `,
        params: TypeParams,
        response: {
          200: res('The retirement (the first one when it was already retired).', RetirementView),
          403: ADMINS_ONLY,
          404: TYPE_NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      if (!(await typeExists(app.deps, id))) {
        return reply.code(404).send({ error: 'document type not found' });
      }
      const by = req.auth?.label ?? null;
      const { retirement, created } = await app.deps.templates.retire(id, by);
      if (created) req.log.info({ typeId: id, by }, 'document type retired');
      return { id, retired: retirement };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/specs/:id/retirement',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Specs'],
        'x-admin': true,
        operationId: 'unretireDocumentType',
        summary: 'Unretire a document type',
        description: md`
          Makes a retired document type available again for uploads and new work. This route is
          the only way to unretire a type: the web app has no Unretire button (retiring is also on
          the Document types page). A type that is not retired is left as it is (still a 204).
        `,
        params: TypeParams,
        response: { 204: noContent('Unretired.'), 403: ADMINS_ONLY, 404: TYPE_NOT_FOUND },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      if (!(await typeExists(app.deps, id))) {
        return reply.code(404).send({ error: 'document type not found' });
      }
      if (await app.deps.templates.unretire(id)) {
        req.log.info({ typeId: id, by: req.auth?.label ?? null }, 'document type unretired');
      }
      return reply.code(204).send();
    },
  );
};
