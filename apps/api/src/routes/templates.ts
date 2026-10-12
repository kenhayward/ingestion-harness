import type { FastifyBaseLogger, FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { z } from 'zod';
import { regressionFinished, regressionReport } from '../regression/report.js';
import { validateTemplate } from '../templates/definitions.js';
import { createNextDraft, pinned, skeleton } from '../templates/drafts.js';
import { TemplateConflictError, type TemplateRecord } from '../templates/repo.js';

const Id = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'lowercase id: [a-z][a-z0-9_-]*');
const CreateBody = z.object({ id: Id, name: z.string().min(1) }).strict();
const SaveBody = z.object({ definition: z.record(z.unknown()) }).strict();
const DraftBody = z.object({ from: z.number().int().positive().optional() }).strict();
const ImportBody = z.object({ yaml: z.string().min(1), publish: z.boolean().optional() }).strict();

type Params = { id: string; version: string };

const withIssues = (record: TemplateRecord) => ({
  record,
  issues: validateTemplate(record.definition),
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
  const refs = await app.deps.repo.listReferences(id);
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
  const repo = () => app.deps.templates;
  const versionOf = (p: Params) => Number(p.version);
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'template not found' });

  /** One entry per document type: name, latest published version, open draft. */
  app.get('/templates', async (req) => {
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
  });

  /** New document type: v1 draft skeleton to fill in with the editor. */
  app.post('/templates', async (req, reply) => {
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
    return reply.code(201).send(withIssues(record));
  });

  app.get<{ Params: Params }>('/templates/:id/versions/:version', async (req, reply) => {
    const record = await repo().get(req.params.id, versionOf(req.params));
    return record ? withIssues(record) : notFound(reply);
  });

  /** Save a draft — even when invalid, so work in progress is never lost. */
  app.put<{ Params: Params }>('/templates/:id/versions/:version', async (req, reply) => {
    const body = SaveBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const { id } = req.params;
    const version = versionOf(req.params);
    const existing = await repo().get(id, version);
    if (!existing) return notFound(reply);
    if (existing.status !== 'draft') {
      return reply.code(409).send({ error: `${id} v${version} is published; start a new draft` });
    }
    const record = await repo().updateDraft(id, version, pinned(body.data.definition, id, version));
    return withIssues(record!);
  });

  app.post<{ Params: Params }>('/templates/:id/versions/:version/publish', async (req, reply) => {
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
    const issues = validateTemplate(existing.definition);
    if (issues.length) return reply.code(400).send({ error: 'template is not valid', issues });
    return withIssues((await repo().publish(id, version))!);
  });

  /** New draft (next version) copied from a version (default: the latest). */
  app.post<{ Params: { id: string } }>('/templates/:id/drafts', async (req, reply) => {
    const body = DraftBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const created = await createNextDraft(repo(), req.params.id, body.data.from);
    if (created === 'not-found') return notFound(reply);
    if (created === 'draft-exists') {
      return reply.code(409).send({ error: 'a draft already exists; edit or delete it first' });
    }
    return reply.code(201).send(withIssues(created));
  });

  app.delete<{ Params: Params }>('/templates/:id/versions/:version', async (req, reply) => {
    const deleted = await repo().deleteDraft(req.params.id, versionOf(req.params));
    return deleted
      ? reply.code(204).send()
      : reply.code(409).send({ error: 'only existing drafts can be deleted' });
  });

  app.get<{ Params: Params }>('/templates/:id/versions/:version/export', async (req, reply) => {
    const record = await repo().get(req.params.id, versionOf(req.params));
    if (!record) return notFound(reply);
    return reply
      .header('content-type', 'application/yaml; charset=utf-8')
      .header('content-disposition', `attachment; filename="${record.id}-v${record.version}.yaml"`)
      .send(toYaml(record.definition, { lineWidth: 100 }));
  });

  /** Import a YAML (or JSON) definition as a new version: draft, or published if valid. */
  app.post('/templates/import', async (req, reply) => {
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
    const issues = validateTemplate(definition);
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
      return reply.code(201).send(withIssues(record));
    } catch (err) {
      if (err instanceof TemplateConflictError) return reply.code(409).send({ error: err.message });
      throw err;
    }
  });
};
