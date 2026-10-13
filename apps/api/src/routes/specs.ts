import type { FastifyPluginAsync } from 'fastify';
import { DocumentSpecSchema, TemplateSchema } from '@ih/shared';
import { z } from 'zod';
import { error, md, res } from '../openapi/zod.js';
import { DefinitionSummarySchema } from '../specs/spec-registry.js';
import { listDefinitions, resolveDefinition } from '../templates/definitions.js';

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

export const specRoutes: FastifyPluginAsync = async (app) => {
  /** Document types available for upload (published templates + file definitions). */
  app.get(
    '/specs',
    {
      schema: {
        tags: ['Specs'],
        operationId: 'listSpecs',
        summary: 'List the document types available for upload',
        description: md`
          Every version a document can be uploaded with: published database templates, and the
          definitions in the repository's \`specs/\` folder (legacy \`spec.yaml\`, and
          \`template.yaml\` files not yet seeded into the database), sorted by id and version.
          Drafts are not listed; they can only be test-run.
        `,
        response: { 200: res('The document type versions.', z.array(DefinitionSummarySchema)) },
      },
    },
    async () => listDefinitions(app.deps),
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
          template (\`kind: template\`). Without \`version\`, the latest published version (a
          database template first, then the newest file). A \`version\` may name a draft.
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
};
