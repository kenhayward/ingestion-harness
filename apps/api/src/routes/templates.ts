import type { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { z } from 'zod';
import { regressionFinished, regressionReport, versionReferences } from '../regression/report.js';
import { binary, error, md, noContent, res } from '../openapi/zod.js';
import { TemplateIssueSchema, templateIssues, validateTemplate } from '../templates/definitions.js';
import { createNextDraft, pinned, skeleton } from '../templates/drafts.js';
import {
  TemplateConflictError,
  TemplateRecordSchema,
  TemplateStatusSchema,
  type TemplateRecord,
} from '../templates/repo.js';

const Id = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'lowercase id: [a-z][a-z0-9_-]*');
const CreateBody = z
  .object({ id: Id.describe('Lowercase: `[a-z][a-z0-9_-]*`.'), name: z.string().min(1) })
  .strict();
const SaveBody = z
  .object({ definition: z.record(z.unknown()).describe('The whole definition, as authored.') })
  .strict();
const DraftBody = z
  .object({
    from: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('The version to copy. Default: the latest.'),
  })
  .strict();
const ImportBody = z
  .object({
    yaml: z.string().min(1).describe('A definition as YAML (or JSON), with `id` and `version`.'),
    publish: z.boolean().optional().describe('Publish it if it is valid. Default: a draft.'),
  })
  .strict();

type Params = { id: string; version: string };

const VersionParams = z.object({
  id: z.string().describe('The document type id.'),
  version: z.string().describe('The version number.'),
});
const TypeParams = z.object({ id: z.string().describe('The document type id.') });

/** A version with the validation issues of its definition (empty when valid). */
const RecordView = z.object({
  record: TemplateRecordSchema,
  issues: z.array(TemplateIssueSchema).describe('Validation issues; empty when valid.'),
});

const TemplateTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  published: z.number().int().nullable().describe('The latest published version.'),
  draft: z.number().int().nullable().describe('The open draft version.'),
  versions: z.array(
    z.object({
      version: z.number().int(),
      status: TemplateStatusSchema,
      updatedAt: z.string(),
    }),
  ),
  summary: z
    .object({
      sections: z.number().int(),
      fields: z.number().int(),
      tables: z.number().int(),
      references: z.number().int(),
      draftIssues: z.number().int().nullable().describe("The open draft's issue count."),
      lastRegression: z
        .object({
          version: z.number().int(),
          matched: z.number().int().describe('References matched exactly.'),
          total: z.number().int(),
          at: z.string(),
        })
        .nullable(),
      regressionRunning: z.boolean(),
    })
    .describe('Of the version shown: the open draft, else the latest published version.'),
});

const NOT_FOUND = error('`template not found`.');
const NOT_VALID = res(
  'The definition is not valid: `template is not valid`, with `issues`.',
  z.object({ error: z.string(), issues: z.array(TemplateIssueSchema) }),
);

/** The record with its issues, the models its steps name included (ADR 0010). */
const issuesOf = (app: FastifyInstance) => async (record: TemplateRecord) => ({
  record,
  issues: await templateIssues(app.deps, record.definition),
});

const count = (value: unknown) => (Array.isArray(value) ? value.length : 0);

/**
 * The card summary for a document type (UI handoff A5): shape of the version shown (draft first),
 * references, the draft's validation issues, and that version's last regression. Definitions may
 * be unfinished drafts, so every part is read defensively.
 */
async function summarise(
  app: FastifyInstance,
  id: string,
  latest: TemplateRecord,
  draft: TemplateRecord | null,
  log: FastifyBaseLogger,
) {
  const definition = latest.definition as {
    document?: { sections?: unknown };
    outputs?: { fields?: unknown; tables?: unknown };
  };
  const refs = await versionReferences(app, id, latest.version);
  let lastRegression: { version: number; matched: number; total: number; at: string } | null = null;
  let regressionRunning = false;
  try {
    // Only each reference's newest run counts: a re-run in progress isn't a score yet.
    const report = await regressionReport(app, id, latest.version, refs);
    regressionRunning = report.jobs.some((j) => j.status === 'queued' || j.status === 'running');
    const finished = report.jobs.filter((j) => regressionFinished(j.status));
    if (!regressionRunning && finished.length) {
      lastRegression = {
        version: latest.version,
        matched: report.items.filter((i) => i.comparison?.score === 1).length,
        total: report.summary.references,
        at: finished
          .map((j) => j.updatedAt)
          .sort()
          .at(-1)!,
      };
    }
  } catch (err) {
    log.warn({ err, templateId: id }, 'regression summary unavailable'); // the list still loads
  }
  return {
    sections: count(definition.document?.sections),
    fields: count(definition.outputs?.fields),
    tables: count(definition.outputs?.tables),
    references: refs.length,
    draftIssues: draft ? validateTemplate(draft.definition).length : null,
    lastRegression,
    regressionRunning,
  };
}

export const templateRoutes: FastifyPluginAsync = async (app) => {
  const withIssues = issuesOf(app);
  const repo = () => app.deps.templates;
  const versionOf = (p: Params) => Number(p.version);
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'template not found' });

  /** One entry per document type: name, latest published version, open draft. */
  app.get(
    '/templates',
    {
      schema: {
        tags: ['Templates'],
        operationId: 'listTemplates',
        summary: 'List document types',
        description: md`
          One entry per database document type: its name, latest published version, open draft,
          every version, and a summary of the version shown (the draft first): counts of
          sections, fields, tables and references, the draft's validation issues, and that
          version's last regression (\`matched\` counts references reproduced exactly).
        `,
        response: { 200: res('The document types.', z.array(TemplateTypeSchema)) },
      },
    },
    async (req) => {
      const byId = new Map<string, TemplateRecord[]>();
      for (const r of await repo().list()) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
      const entries = [...byId.entries()].map(([id, versions]) => {
        const published = versions.filter((v) => v.status === 'published').at(-1) ?? null;
        const draft = versions.find((v) => v.status === 'draft') ?? null;
        const latest = draft ?? published ?? versions.at(-1)!;
        return {
          id,
          name: String(latest.definition.name ?? id),
          description: latest.definition.description ?? null,
          published: published?.version ?? null,
          draft: draft?.version ?? null,
          versions: versions.map((v) => ({
            version: v.version,
            status: v.status,
            updatedAt: v.updatedAt,
          })),
          latest,
          draftRecord: draft,
        };
      });
      return Promise.all(
        entries.map(async ({ latest, draftRecord, ...item }) => ({
          ...item,
          summary: await summarise(app, item.id, latest, draftRecord, req.log),
        })),
      );
    },
  );

  /** New document type: v1 draft skeleton to fill in with the editor. */
  app.post(
    '/templates',
    {
      schema: {
        tags: ['Templates'],
        operationId: 'createTemplate',
        summary: 'Create a document type',
        description: md`
          Creates a document type as a v1 draft skeleton, to fill in with the editor (or
          \`PUT\` a definition). The skeleton is not valid yet, so \`issues\` lists what is
          missing.
        `,
        body: CreateBody,
        response: {
          201: res('The v1 draft.', RecordView),
          400: error('Zod issues for an invalid id or name.'),
          409: error('`document type {id} already exists`.'),
        },
      },
    },
    async (req, reply) => {
      const body = CreateBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      if ((await repo().list()).some((r) => r.id === body.data.id)) {
        return reply.code(409).send({ error: `document type ${body.data.id} already exists` });
      }
      const record = await repo().create(
        body.data.id,
        1,
        skeleton(body.data.id, body.data.name),
        'draft',
      );
      return reply.code(201).send(await withIssues(record));
    },
  );

  app.get<{ Params: Params }>(
    '/templates/:id/versions/:version',
    {
      schema: {
        tags: ['Templates'],
        operationId: 'getTemplateVersion',
        summary: 'Get a template version',
        description: md`
          A version of a document type as stored (a draft may be work in progress), with the
          validation issues of its definition.
        `,
        params: VersionParams,
        response: { 200: res('The version.', RecordView), 404: NOT_FOUND },
      },
    },
    async (req, reply) => {
      const record = await repo().get(req.params.id, versionOf(req.params));
      return record ? await withIssues(record) : notFound(reply);
    },
  );

  /** Save a draft — even when invalid, so work in progress is never lost. */
  app.put<{ Params: Params }>(
    '/templates/:id/versions/:version',
    {
      schema: {
        tags: ['Templates'],
        operationId: 'saveDraft',
        summary: 'Save a draft',
        description: md`
          Replaces a draft's definition. Invalid definitions are saved too, so work in progress
          is never lost; \`issues\` says what still needs fixing before it can be published.
          The definition's \`id\` and \`version\` are pinned to the URL's. Published versions
          are immutable.
        `,
        params: VersionParams,
        body: SaveBody,
        response: {
          200: res('The saved draft.', RecordView),
          400: error('Zod issues: `definition` must be an object.'),
          404: NOT_FOUND,
          409: error('`{id} v{version} is published; start a new draft`.'),
        },
      },
    },
    async (req, reply) => {
      const body = SaveBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { id } = req.params;
      const version = versionOf(req.params);
      const existing = await repo().get(id, version);
      if (!existing) return notFound(reply);
      if (existing.status !== 'draft') {
        return reply.code(409).send({ error: `${id} v${version} is published; start a new draft` });
      }
      const record = await repo().updateDraft(
        id,
        version,
        pinned(body.data.definition, id, version),
      );
      return await withIssues(record!);
    },
  );

  app.post<{ Params: Params }>(
    '/templates/:id/versions/:version/publish',
    {
      schema: {
        tags: ['Templates'],
        operationId: 'publishTemplate',
        summary: 'Publish a draft',
        description: md`
          Publishes a valid draft. It becomes immutable and the version new uploads use by
          default. Workbench document types publish only through their holdout gate
          (\`POST /api/workbench/projects/{id}/publish\`), never here.
        `,
        params: VersionParams,
        response: {
          200: res('The published version.', RecordView),
          400: NOT_VALID,
          404: NOT_FOUND,
          409: error(
            '`{id} v{version} is already published`, or `publish {id} from the Workbench ' +
              '(holdout gate)` for a Workbench document type.',
          ),
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const version = versionOf(req.params);
      const existing = await repo().get(id, version);
      if (!existing) return notFound(reply);
      if (await app.deps.workbench.getProject(id)) {
        // A Workbench type publishes only through its holdout gate (ADR 0007).
        return reply.code(409).send({ error: `publish ${id} from the Workbench (holdout gate)` });
      }
      if (existing.status !== 'draft') {
        return reply.code(409).send({ error: `${id} v${version} is already published` });
      }
      const issues = await templateIssues(app.deps, existing.definition);
      if (issues.length) return reply.code(400).send({ error: 'template is not valid', issues });
      return await withIssues((await repo().publish(id, version))!);
    },
  );

  /** New draft (next version) copied from a version (default: the latest). */
  app.post<{ Params: { id: string } }>(
    '/templates/:id/drafts',
    {
      schema: {
        tags: ['Templates'],
        operationId: 'createDraft',
        summary: 'Start a new draft version',
        description: md`
          Opens the next version as a draft, copied from \`from\` (default: the latest
          version). A document type has at most one draft at a time.
        `,
        params: TypeParams,
        body: DraftBody,
        response: {
          201: res('The new draft.', RecordView),
          400: error('Zod issues for an invalid body.'),
          404: NOT_FOUND,
          409: error('`a draft already exists; edit or delete it first`.'),
        },
      },
    },
    async (req, reply) => {
      const body = DraftBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const created = await createNextDraft(repo(), req.params.id, body.data.from);
      if (created === 'not-found') return notFound(reply);
      if (created === 'draft-exists') {
        return reply.code(409).send({ error: 'a draft already exists; edit or delete it first' });
      }
      return reply.code(201).send(await withIssues(created));
    },
  );

  app.delete<{ Params: Params }>(
    '/templates/:id/versions/:version',
    {
      schema: {
        tags: ['Templates'],
        operationId: 'deleteDraft',
        summary: 'Delete a draft',
        description: md`
          Deletes a draft version. Published versions cannot be deleted: jobs and references
          record the version they ran with.
        `,
        params: VersionParams,
        response: {
          204: noContent('Deleted.'),
          409: error('`only existing drafts can be deleted`.'),
        },
      },
    },
    async (req, reply) => {
      const deleted = await repo().deleteDraft(req.params.id, versionOf(req.params));
      return deleted
        ? reply.code(204).send()
        : reply.code(409).send({ error: 'only existing drafts can be deleted' });
    },
  );

  app.get<{ Params: Params }>(
    '/templates/:id/versions/:version/export',
    {
      schema: {
        tags: ['Templates'],
        operationId: 'exportTemplate',
        summary: 'Export a version as YAML',
        description: md`
          The version's definition as a YAML file (\`{id}-v{version}.yaml\`), in the format
          \`POST /api/templates/import\` and the repository's \`specs/*/template.yaml\` use.
        `,
        params: VersionParams,
        response: { 200: binary('The YAML file.', 'application/yaml'), 404: NOT_FOUND },
      },
    },
    async (req, reply) => {
      const record = await repo().get(req.params.id, versionOf(req.params));
      if (!record) return notFound(reply);
      return reply
        .header('content-type', 'application/yaml; charset=utf-8')
        .header(
          'content-disposition',
          `attachment; filename="${record.id}-v${record.version}.yaml"`,
        )
        .send(toYaml(record.definition, { lineWidth: 100 }));
    },
  );

  /** Import a YAML (or JSON) definition as a new version: draft, or published if valid. */
  app.post(
    '/templates/import',
    {
      schema: {
        tags: ['Templates'],
        operationId: 'importTemplate',
        summary: 'Import a definition as a new version',
        description: md`
          Creates the version named by the definition's \`id\` and \`version\` (a new document
          type, or a new version of one): a draft, or published when \`publish\` is true and the
          definition is valid. A draft may be imported invalid and fixed in the editor. A
          Workbench document type can be imported as a draft but not published. See the
          [template format](https://github.com/kenhayward/ingestion-harness/blob/main/docs/adr/0003-versioned-document-specs.md).
        `,
        body: ImportBody,
        response: {
          201: res('The imported version.', RecordView),
          400: res(
            'Zod issues for an invalid body, `not valid YAML: …`, `definition needs a valid id ' +
              'and version`, or `template is not valid` (with `issues`) when publishing.',
            z.object({ error: z.unknown(), issues: z.array(TemplateIssueSchema).optional() }),
          ),
          409: error(
            'The version already exists, or `publish {id} from the Workbench (holdout gate)`.',
          ),
        },
      },
    },
    async (req, reply) => {
      const body = ImportBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      let definition: unknown;
      try {
        definition = parseYaml(body.data.yaml);
      } catch (err) {
        return reply.code(400).send({ error: `not valid YAML: ${(err as Error).message}` });
      }
      const ident = z
        .object({ id: Id, version: z.number().int().positive() })
        .passthrough()
        .safeParse(definition);
      if (!ident.success) {
        return reply.code(400).send({ error: 'definition needs a valid id and version' });
      }
      if (body.data.publish && (await app.deps.workbench.getProject(ident.data.id))) {
        // Importing as a draft is fine; publishing must go through the holdout gate (ADR 0007).
        return reply
          .code(409)
          .send({ error: `publish ${ident.data.id} from the Workbench (holdout gate)` });
      }
      const issues = await templateIssues(app.deps, definition);
      if (body.data.publish && issues.length) {
        return reply.code(400).send({ error: 'template is not valid', issues });
      }
      try {
        const record = await repo().create(
          ident.data.id,
          ident.data.version,
          ident.data,
          body.data.publish ? 'published' : 'draft',
        );
        return reply.code(201).send(await withIssues(record));
      } catch (err) {
        if (err instanceof TemplateConflictError)
          return reply.code(409).send({ error: err.message });
        throw err;
      }
    },
  );
};
