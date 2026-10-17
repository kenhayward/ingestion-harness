import type { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { z } from 'zod';
import {
  PublishLabelSchema,
  PushOutcomeSchema,
  RECIPE_FILE_FORMAT,
  RetirementSchema,
  VersionLabelBodySchema,
  VersionLabelSchema,
  versionName,
} from '@ih/shared';
import { pushAfterPublish } from '../github-sync/auto.js';
import { publishProjectDraft } from './workbench.js';
import { parseRecipeFile } from '../github-sync/file.js';
import { ImportConflict, ImportInvalid, importRecipeFile } from '../github-sync/import.js';
import { regressionFinished, regressionReport, versionReferences } from '../regression/report.js';
import { binary, error, md, noContent, res } from '../openapi/zod.js';
import {
  TemplateIssueSchema,
  blockingIssues,
  templateIssues,
  validateTemplate,
} from '../templates/definitions.js';
import { refuseRetired, retiredProblem, RETIRED_DOC } from '../templates/retirement.js';
import { byHand, draftChange, startedChange } from '../templates/changes.js';
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
  .object({
    definition: z.record(z.string(), z.unknown()).describe('The whole definition, as authored.'),
    baseUpdatedAt: z
      .string()
      .datetime()
      .optional()
      .describe(
        'The `updatedAt` the edit started from. When the draft was written since (a proposal ' +
          'applied, another tab saved), nothing is saved and the answer is a 409.',
      ),
  })
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
const RenameBody = z
  .object({
    name: z.string().trim().min(1).max(200).describe('The new name, trimmed; 1 to 200 characters.'),
  })
  .strict();
const RestoreBody = z
  .object({
    from: z.number().int().positive().describe('The version whose definition to write.'),
    baseUpdatedAt: z
      .string()
      .datetime()
      .optional()
      .describe('The draft `updatedAt` the user saw: a draft written since is a 409.'),
  })
  .strict();
export const DRAFT_CHANGED = 'the draft changed since you opened it; reload it to see the changes';
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
export const RecordView = z.object({
  record: TemplateRecordSchema,
  issues: z.array(TemplateIssueSchema).describe('Validation issues; empty when valid.'),
});

/** A published version, with what the automatic GitHub push did. */
const PublishedView = RecordView.extend({
  github: PushOutcomeSchema.nullable().describe(
    'The automatic push to GitHub: null when the document type is not linked or pushes only on ' +
      'request. A skipped or failed push never fails the publish. A push still going after 15 s ' +
      'is `failed` with `GitHub is slow: check Versions for the result.` and finishes afterwards.',
  ),
});

const TemplateTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  published: z.number().int().nullable().describe('The latest published version.'),
  draft: z.number().int().nullable().describe('The open draft version.'),
  retired: RetirementSchema.nullable().describe(
    'Set when the document type is retired (hidden from new work); null when it is not.',
  ),
  versions: z.array(
    z.object({
      version: z.number().int(),
      status: TemplateStatusSchema,
      updatedAt: z.string(),
      label: z.string().nullable().describe('What the version is for; null when unlabelled.'),
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

/** One row of a document type's version list (#144): everything but the definition. */
const VersionItem = z.object({
  version: z.number().int(),
  status: TemplateStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  publishedAt: z.string().nullable(),
  ...VersionLabelSchema.shape,
});

const NOT_FOUND = error('`recipe not found`.');

/** The record with its issues, the models its steps name included (ADR 0010). */
export const issuesOf = (app: FastifyInstance) => async (record: TemplateRecord) => ({
  record,
  issues: await templateIssues(app.deps, record.definition, { draft: record.status === 'draft' }),
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
  const notRetired = refuseRetired(app);
  const repo = () => app.deps.templates;
  const versionOf = (p: Params) => Number(p.version);
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'recipe not found' });
  /** A publish's label and note, set on the draft before it is published. */
  const labelFirst = async (
    id: string,
    version: number,
    body: z.infer<typeof PublishLabelSchema>,
    by: string | null,
  ) => {
    if (body.label !== undefined || body.note !== undefined) {
      await repo().setLabel(id, version, body, by);
    }
  };

  app.get<{ Params: { id: string } }>(
    '/templates/:id/versions',
    {
      schema: {
        tags: ['Recipes'],
        operationId: 'listTemplateVersions',
        summary: 'List the versions of a document type',
        description: md`
          Every recipe version of a database document type, newest first, with its label and
          note and without its definition (\`GET …/versions/{version}\` has it).
        `,
        params: TypeParams,
        response: { 200: res('The versions, newest first.', z.array(VersionItem)), 404: NOT_FOUND },
      },
    },
    async (req, reply) => {
      const versions = (await repo().list()).filter((r) => r.id === req.params.id);
      if (!versions.length) return notFound(reply);
      return versions
        .sort((a, b) => b.version - a.version)
        .map(({ id: _id, definition: _definition, ...item }) => item);
    },
  );

  app.patch<{ Params: Params }>(
    '/templates/:id/versions/:version',
    {
      schema: {
        tags: ['Recipes'],
        operationId: 'setVersionLabel',
        summary: "Set a version's label and note",
        description: md`
          Sets what a recipe version is for: a short \`label\` and a longer \`note\`. A field
          left out keeps its value and \`null\` clears it. Drafts and published versions alike
          (published versions stay immutable: the label is not part of the definition), retired
          document types too. Not an edit of the draft: its \`updatedAt\` and change log are
          left alone.
        `,
        params: VersionParams,
        body: VersionLabelBodySchema,
        response: {
          200: res('The version.', RecordView),
          400: error('Zod issues: a blank or too long label or note, or neither sent.'),
          404: NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      const body = VersionLabelBodySchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const record = await repo().setLabel(
        req.params.id,
        versionOf(req.params),
        body.data,
        req.auth?.label ?? null,
      );
      return record ? await withIssues(record) : notFound(reply);
    },
  );

  app.post<{ Params: Params }>(
    '/templates/:id/versions/:version/restore',
    {
      schema: {
        tags: ['Recipes'],
        operationId: 'restoreVersion',
        summary: 'Replace the draft with another version',
        description: md`
          Writes the definition of version \`from\` into the open draft \`version\`, replacing
          it, to go back to an earlier version. Logged in the draft's change log as a
          \`restore\` (nothing is written when the draft already equals it). To make an earlier
          version the latest, restore it into the draft and publish.
        `,
        params: VersionParams,
        body: RestoreBody,
        response: {
          200: res('The draft.', RecordView),
          400: error('Zod issues, or `a draft cannot be restored from itself`.'),
          404: NOT_FOUND,
          409: error(
            '`{id} v{version} is not an open draft`, or `' +
              DRAFT_CHANGED +
              '` when `baseUpdatedAt` is not its `updatedAt` (or it changed while restoring).',
          ),
        },
      },
    },
    async (req, reply) => {
      const body = RestoreBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { id } = req.params;
      const version = versionOf(req.params);
      if (body.data.from === version) {
        return reply.code(400).send({ error: 'a draft cannot be restored from itself' });
      }
      const [draft, source] = await Promise.all([
        repo().get(id, version),
        repo().get(id, body.data.from),
      ]);
      if (!draft || !source) return notFound(reply);
      if (draft.status !== 'draft') {
        return reply.code(409).send({ error: `${id} v${version} is not an open draft` });
      }
      const base = body.data.baseUpdatedAt ?? draft.updatedAt;
      if (base !== draft.updatedAt) return reply.code(409).send({ error: DRAFT_CHANGED });
      const definition = pinned(source.definition, id, version);
      const change = draftChange(
        draft.definition,
        definition,
        { source: 'restore', stage: null, proposalId: null, by: req.auth?.label ?? null },
        ` (from ${versionName(source.version, source.label)})`,
      );
      if (!change) return await withIssues(draft); // already that version: nothing to write
      const record = await repo().updateDraft(id, version, definition, {
        expectedUpdatedAt: base,
        change,
      });
      if (!record) {
        const now = await repo().get(id, version);
        return reply.code(409).send({
          error: now?.status === 'draft' ? DRAFT_CHANGED : `${id} v${version} is not an open draft`,
        });
      }
      req.log.info({ templateId: id, version, from: source.version }, 'version restored');
      return await withIssues(record);
    },
  );

  /** One entry per document type: name, latest published version, open draft. */
  app.get(
    '/templates',
    {
      schema: {
        tags: ['Recipes'],
        operationId: 'listTemplates',
        summary: 'List document types',
        description: md`
          One entry per database document type: its name, latest published version, open draft,
          every version, and a summary of the version shown (the draft first): counts of
          sections, fields, tables and references, the draft's validation issues, and that
          version's last regression (\`matched\` counts references reproduced exactly).
          \`retired\` is set for a retired document type.
        `,
        response: { 200: res('The document types.', z.array(TemplateTypeSchema)) },
      },
    },
    async (req) => {
      const byId = new Map<string, TemplateRecord[]>();
      const [records, retirements] = await Promise.all([
        repo().list(),
        app.deps.templates.listRetirements(),
      ]);
      for (const r of records) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
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
          retired: retirements.get(id) ?? null,
          versions: versions.map((v) => ({
            version: v.version,
            status: v.status,
            updatedAt: v.updatedAt,
            label: v.label,
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
        tags: ['Recipes'],
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
          409: error('`document type {id} already exists`, or ' + RETIRED_DOC + '.'),
        },
      },
    },
    async (req, reply) => {
      const body = CreateBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      if ((await repo().list()).some((r) => r.id === body.data.id)) {
        return reply.code(409).send({ error: `document type ${body.data.id} already exists` });
      }
      // A retired legacy spec id stays retired: no new recipe type under it.
      const retired = await retiredProblem(app.deps, body.data.id);
      if (retired) return reply.code(409).send({ error: retired });
      const record = await repo().create(
        body.data.id,
        1,
        skeleton(body.data.id, body.data.name),
        'draft',
        startedChange('Draft v1 created', req.auth?.label ?? null),
      );
      return reply.code(201).send(await withIssues(record));
    },
  );

  app.get<{ Params: Params }>(
    '/templates/:id/versions/:version',
    {
      schema: {
        tags: ['Recipes'],
        operationId: 'getTemplateVersion',
        summary: 'Get a recipe version',
        description: md`
          A recipe version of a document type as stored (a draft may be work in progress), with
          the validation issues of its definition.
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
        tags: ['Recipes'],
        operationId: 'saveDraft',
        summary: 'Save a draft',
        description: md`
          Replaces a draft's definition. Invalid definitions are saved too, so work in progress
          is never lost; \`issues\` says what still needs fixing before it can be published.
          The definition's \`id\` and \`version\` are pinned to the URL's. Published versions
          are immutable. Each save that changes the definition is recorded in the draft's change
          log (\`GET /api/workbench/projects/{id}/draft/changes\`).
        `,
        params: VersionParams,
        body: SaveBody,
        response: {
          200: res('The saved draft.', RecordView),
          400: error('Zod issues: `definition` must be an object.'),
          404: NOT_FOUND,
          409: error(
            '`{id} v{version} is published; start a new draft`, or `the draft changed since you opened it; reload it to see the changes` when `baseUpdatedAt` is not its `updatedAt`.',
          ),
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
      const definition = pinned(body.data.definition, id, version);
      const record = await repo().updateDraft(id, version, definition, {
        expectedUpdatedAt: body.data.baseUpdatedAt,
        change: draftChange(existing.definition, definition, byHand(req.auth?.label ?? null)),
      });
      if (!record) {
        const now = await repo().get(id, version);
        return reply.code(409).send({
          error:
            now?.status === 'draft'
              ? 'the draft changed since you opened it; reload it to see the changes'
              : `${id} v${version} is published; start a new draft`,
        });
      }
      return await withIssues(record);
    },
  );

  app.post<{ Params: Params }>(
    '/templates/:id/versions/:version/publish',
    {
      preHandler: notRetired,
      schema: {
        tags: ['Recipes'],
        operationId: 'publishTemplate',
        summary: 'Publish a draft',
        description: md`
          Publishes a valid draft. It becomes immutable and the version new uploads use by
          default. A Workbench document type publishes as its project does
          (\`POST /api/workbench/projects/{id}/publish\`): the publication is recorded with the
          gate's iteration and score, which never block. \`label\` and \`note\`, when given,
          are set on the version first (it keeps the draft's otherwise).
        `,
        params: VersionParams,
        body: PublishLabelSchema,
        response: {
          200: res('The published version.', PublishedView),
          400: res(
            'Zod issues for an invalid label or note, or the definition is not valid: ' +
              '`recipe is not valid`, with `issues`.',
            z.object({
              error: z.unknown().optional(),
              issues: z.array(TemplateIssueSchema).optional(),
            }),
          ),
          404: NOT_FOUND,
          409: error(
            '`{id} v{version} is already published`, `the draft changed while publishing; ' +
              'reload it and try again` (a Workbench document type), or ' +
              RETIRED_DOC +
              '.',
          ),
        },
      },
    },
    async (req, reply) => {
      const body = PublishLabelSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { id } = req.params;
      const version = versionOf(req.params);
      const existing = await repo().get(id, version);
      if (!existing) return notFound(reply);
      if (existing.status !== 'draft') {
        return reply.code(409).send({ error: `${id} v${version} is already published` });
      }
      const project = await app.deps.workbench.getProject(id);
      if (project) {
        // A Workbench type publishes as its project page does: the publication is recorded.
        const outcome = await publishProjectDraft(app, req, project, body.data);
        if (outcome.result === 'invalid') {
          return reply.code(400).send({ error: 'recipe is not valid', issues: outcome.issues });
        }
        if (outcome.result !== 'published') {
          return reply.code(409).send({
            error:
              outcome.result === 'changed'
                ? 'the draft changed while publishing; reload it and try again'
                : `${id} v${version} is already published`,
          });
        }
        const published = (await repo().get(id, outcome.version))!;
        const github = await pushAfterPublish(app.deps, req, id, outcome.version);
        return { ...(await withIssues(published)), github };
      }
      const issues = blockingIssues(
        await templateIssues(app.deps, existing.definition, { draft: true }),
      );
      if (issues.length) return reply.code(400).send({ error: 'recipe is not valid', issues });
      await labelFirst(id, version, body.data, req.auth?.label ?? null);
      const published = (await repo().publish(id, version, req.auth?.label ?? null))!;
      const github = await pushAfterPublish(app.deps, req, id, version);
      return { ...(await withIssues(published)), github };
    },
  );

  /** New draft (next version) copied from a version (default: the latest). */
  app.post<{ Params: { id: string } }>(
    '/templates/:id/drafts',
    {
      preHandler: notRetired,
      schema: {
        tags: ['Recipes'],
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
          409: error('`a draft already exists; edit or delete it first`, or ' + RETIRED_DOC + '.'),
        },
      },
    },
    async (req, reply) => {
      const body = DraftBody.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const created = await createNextDraft(
        repo(),
        req.params.id,
        body.data.from,
        req.auth?.label ?? null,
      );
      if (created === 'not-found') return notFound(reply);
      if (created === 'draft-exists') {
        return reply.code(409).send({ error: 'a draft already exists; edit or delete it first' });
      }
      return reply.code(201).send(await withIssues(created));
    },
  );

  /** Rename a document type: its open draft (started when none is) and its Workbench project. */
  app.put<{ Params: { id: string } }>(
    '/templates/:id/name',
    {
      preHandler: notRetired,
      schema: {
        tags: ['Recipes'],
        operationId: 'renameTemplate',
        summary: 'Rename a document type',
        description: md`
          Sets the document type's name in its open draft, recorded in the draft's change log as
          a hand edit. Published versions keep the name they were published with, so when no
          draft is open one is started from the latest version (as \`POST …/drafts\`) and
          renamed; the new name reaches uploads and jobs once that draft is published. A
          Workbench project of the type is renamed at once. The same name as now changes
          nothing and starts no draft.
        `,
        params: TypeParams,
        body: RenameBody,
        response: {
          200: res('The renamed draft (or, when nothing changed, the version shown).', RecordView),
          400: error('Zod issues: a blank name or one over 200 characters.'),
          404: NOT_FOUND,
          409: error('`the draft changed while renaming; try again`, or ' + RETIRED_DOC + '.'),
        },
      },
    },
    async (req, reply) => {
      const body = RenameBody.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { id } = req.params;
      const { name } = body.data;
      const by = req.auth?.label ?? null;
      const versions = (await repo().list()).filter((r) => r.id === id);
      if (!versions.length) return notFound(reply);
      const open = versions.find((v) => v.status === 'draft');
      const shown = open ?? versions.at(-1)!;
      const before = shown.definition.name;
      let record = shown;
      if (before !== name) {
        let draft = open;
        if (!draft) {
          const created = await createNextDraft(repo(), id, undefined, by);
          if (typeof created === 'string') {
            return reply.code(409).send({ error: 'the draft changed while renaming; try again' });
          }
          draft = created;
        }
        const definition = { ...draft.definition, name };
        const change = draftChange(draft.definition, definition, byHand(by));
        const saved = await repo().updateDraft(id, draft.version, definition, {
          expectedUpdatedAt: draft.updatedAt,
          change: change && {
            ...change,
            summary: `Renamed “${String(before ?? id)}” to “${name}”`,
          },
        });
        if (!saved) {
          return reply.code(409).send({ error: 'the draft changed while renaming; try again' });
        }
        record = saved;
      }
      if (await app.deps.workbench.renameProject(id, name)) {
        req.log.info({ projectId: id, by }, 'workbench project renamed');
      }
      return await withIssues(record);
    },
  );

  app.delete<{ Params: Params }>(
    '/templates/:id/versions/:version',
    {
      schema: {
        tags: ['Recipes'],
        operationId: 'deleteDraft',
        summary: 'Delete a draft',
        description: md`
          Deletes a draft version. Published versions cannot be deleted: jobs and references
          record the version they ran with. Deleting a type's only version (a never-published
          type) also removes its GitHub link and push records.
        `,
        params: VersionParams,
        response: {
          204: noContent('Deleted.'),
          409: error('`only existing drafts can be deleted`.'),
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      const deleted = await repo().deleteDraft(id, versionOf(req.params));
      // A never-published type's only draft is the type: its GitHub link and pushes go with it.
      if (deleted && !(await repo().list()).some((r) => r.id === id)) {
        await app.deps.githubSync.forgetType(id);
      }
      return deleted
        ? reply.code(204).send()
        : reply.code(409).send({ error: 'only existing drafts can be deleted' });
    },
  );

  app.get<{ Params: Params }>(
    '/templates/:id/versions/:version/export',
    {
      schema: {
        tags: ['Recipes'],
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
        tags: ['Recipes'],
        operationId: 'importTemplate',
        summary: 'Import a definition as a new version',
        description: md`
          Creates the version named by the definition's \`id\` and \`version\` (a new document
          type, or a new version of one): a draft, or published when \`publish\` is true and the
          definition is valid. A draft may be imported invalid and fixed in the editor. A
          **CT Studio recipe file** (\`format: ct-recipe\`, as pushed to GitHub) is always
          imported as a draft: a new document type's v1, or an existing type's next free
          version (409 while a draft is open); its label and note are copied, and
          \`publish: true\` is a 400. A
          Workbench document type can be imported as a draft but not published. See the
          [recipe format](https://github.com/kenhayward/ingestion-harness/blob/main/docs/adr/0003-versioned-document-specs.md).
        `,
        body: ImportBody,
        response: {
          201: res('The imported version.', RecordView),
          400: res(
            'Zod issues for an invalid body, `not valid YAML: …`, `definition needs a valid id ' +
              'and version`, `recipe is not valid` (with `issues`) when publishing, an unusable ' +
              'recipe file, or `a CT Studio recipe file is always imported as a draft`.',
            z.object({
              error: z.unknown().optional(),
              issues: z.array(TemplateIssueSchema).optional(),
            }),
          ),
          409: error(
            'The version already exists, `a draft already exists; edit or delete it first` (a ' +
              'recipe file), `publish {id} from the Workbench (holdout gate)`, or ' +
              RETIRED_DOC +
              '.',
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
      if ((definition as { format?: unknown } | null)?.format === RECIPE_FILE_FORMAT) {
        // A CT Studio recipe file (as pushed to GitHub): always a draft, at a free version.
        if (body.data.publish) {
          return reply
            .code(400)
            .send({ error: 'a CT Studio recipe file is always imported as a draft' });
        }
        const file = parseRecipeFile(body.data.yaml);
        if ('error' in file) return reply.code(400).send({ error: file.error });
        const target = typeof file.definition.id === 'string' ? file.definition.id : null;
        if (!target || !Id.safeParse(target).success) {
          return reply.code(400).send({ error: 'definition needs a valid id and version' });
        }
        const gone = await retiredProblem(app.deps, target);
        if (gone) return reply.code(409).send({ error: gone });
        try {
          const record = await importRecipeFile(app.deps, file, {
            commit: null,
            by: req.auth?.label ?? null,
          });
          return reply.code(201).send(await withIssues(record));
        } catch (err) {
          if (err instanceof ImportInvalid) return reply.code(400).send({ error: err.message });
          if (err instanceof ImportConflict) return reply.code(409).send({ error: err.message });
          throw err;
        }
      }
      const ident = z
        .object({ id: Id, version: z.number().int().positive() })
        .passthrough()
        .safeParse(definition);
      if (!ident.success) {
        return reply.code(400).send({ error: 'definition needs a valid id and version' });
      }
      const retired = await retiredProblem(app.deps, ident.data.id);
      if (retired) return reply.code(409).send({ error: retired });
      if (body.data.publish && (await app.deps.workbench.getProject(ident.data.id))) {
        // Importing as a draft is fine; publishing must go through the holdout gate (ADR 0007).
        return reply
          .code(409)
          .send({ error: `publish ${ident.data.id} from the Workbench (holdout gate)` });
      }
      // Imported as a draft, it is checked as one; published, it keeps any legacy model refs.
      const issues = blockingIssues(
        await templateIssues(app.deps, definition, { draft: !body.data.publish }),
      );
      if (body.data.publish && issues.length) {
        return reply.code(400).send({ error: 'recipe is not valid', issues });
      }
      try {
        const record = await repo().create(
          ident.data.id,
          ident.data.version,
          ident.data,
          body.data.publish ? 'published' : 'draft',
          body.data.publish
            ? undefined
            : startedChange('Imported from YAML', req.auth?.label ?? null, 'import'),
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
