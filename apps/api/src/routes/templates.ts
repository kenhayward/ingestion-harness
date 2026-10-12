import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { parse as parseYaml, stringify as toYaml } from 'yaml';
import { z } from 'zod';
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

export const templateRoutes: FastifyPluginAsync = async (app) => {
  const repo = () => app.deps.templates;
  const versionOf = (p: Params) => Number(p.version);
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'template not found' });

  /** One entry per document type: name, latest published version, open draft. */
  app.get('/templates', async () => {
    const byId = new Map<string, TemplateRecord[]>();
    for (const r of await repo().list()) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
    return [...byId.entries()].map(([id, versions]) => {
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
      };
    });
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
