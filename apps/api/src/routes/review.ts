import type { FastifyInstance, FastifyPluginAsync, FastifyReply } from 'fastify';
import {
  ApproveRequestSchema,
  EditRequestSchema,
  RejectRequestSchema,
  RerunRequestSchema,
  type JobDetail,
  type Template,
} from '@ih/shared';
import { z } from 'zod';
import { resolveDefinition } from '../templates/definitions.js';

const UUID = z.string().uuid();

/** Draft document.json written by the worker (template jobs). */
interface DraftDocument {
  fields: Record<string, { value: unknown; evidence: string | null; page: number | null }>;
  tables: Record<string, Record<string, unknown>[]>;
  [key: string]: unknown;
}

interface ReviewContext {
  job: JobDetail;
  template: Template;
  document: DraftDocument;
}

async function loadContext(
  app: FastifyInstance,
  jobId: string,
  reply: FastifyReply,
): Promise<ReviewContext | null> {
  const notFound = (error: string) => {
    void reply.code(404).send({ error });
    return null;
  };
  if (!UUID.safeParse(jobId).success) return notFound('not found');
  const job = await app.deps.repo.getJob(jobId);
  if (!job) return notFound('not found');
  const resolved = await resolveDefinition(app.deps, job.specId, job.specVersion);
  const def = resolved?.ok ? resolved.definition : undefined;
  if (def?.kind !== 'template') return notFound('job is not a template document');
  const draft = job.outputs.find((o) => o.stage === 'draft' && o.outputId === 'document');
  if (!draft) return notFound('no draft document for this job');
  const body = await app.deps.store.get(draft.bucket, draft.key);
  if (!body) return notFound('draft document missing from storage');
  return { job, template: def.template, document: JSON.parse(body.toString('utf8')) };
}

export const reviewRoutes: FastifyPluginAsync = async (app) => {
  /** Everything a reviewer needs: job, template definitions, draft document, edits so far. */
  app.get<{ Params: { id: string } }>('/jobs/:id/review', async (req, reply) => {
    const ctx = await loadContext(app, req.params.id, reply);
    if (!ctx) return reply;
    const edits = await app.deps.repo.listEdits(ctx.job.id);
    return { job: ctx.job, template: ctx.template, document: ctx.document, edits };
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/edits', async (req, reply) => {
    const ctx = await loadContext(app, req.params.id, reply);
    if (!ctx) return reply;
    if (ctx.job.status !== 'awaiting_review') {
      return reply.code(409).send({ error: `job is ${ctx.job.status}, not awaiting_review` });
    }
    const parsed = EditRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid edit', issues: parsed.error.issues });
    }
    const edit = parsed.data;
    const { template, document } = ctx;
    const previous = await app.deps.repo.listEdits(ctx.job.id);

    let draftValue: unknown;
    let sameTarget: (e: (typeof previous)[number]) => boolean;
    if ('field' in edit) {
      if (!template.outputs.fields.some((f) => f.id === edit.field)) {
        return reply.code(400).send({ error: `unknown field "${edit.field}"` });
      }
      draftValue = document.fields[edit.field]?.value ?? null;
      sameTarget = (e) => e.field === edit.field;
    } else {
      const table = template.outputs.tables.find((t) => t.id === edit.table);
      if (!table) return reply.code(400).send({ error: `unknown table "${edit.table}"` });
      if (!table.columns.some((c) => c.id === edit.column)) {
        return reply.code(400).send({ error: `unknown column "${edit.table}.${edit.column}"` });
      }
      const rows = document.tables[edit.table] ?? [];
      if (edit.row > rows.length) {
        return reply.code(400).send({
          error: `row ${edit.row} of "${edit.table}" does not exist (${rows.length} rows)`,
        });
      }
      draftValue = rows[edit.row - 1]?.[edit.column] ?? null;
      sameTarget = (e) => e.table === edit.table && e.row === edit.row && e.column === edit.column;
    }
    const last = previous.filter(sameTarget).at(-1);

    const saved = await app.deps.repo.addEdit(ctx.job.id, {
      field: 'field' in edit ? edit.field : null,
      table: 'table' in edit ? edit.table : null,
      row: 'table' in edit ? edit.row : null,
      column: 'table' in edit ? edit.column : null,
      oldValue: last ? last.newValue : draftValue,
      newValue: edit.value ?? null,
      editor: edit.editor ?? null,
      reason: edit.reason ?? null,
    });
    return reply.code(201).send(saved);
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/approve', async (req, reply) => {
    const body = ApproveRequestSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    if (!UUID.safeParse(req.params.id).success) return reply.code(404).send({ error: 'not found' });
    if ((await app.deps.repo.getJob(req.params.id))?.test) {
      return reply.code(409).send({ error: 'test runs are never published; reject or discard it' });
    }
    const job = await app.deps.repo.approve(
      req.params.id,
      body.data.reviewer ?? null,
      body.data.note ?? null,
    );
    return job ?? reply.code(409).send({ error: 'job not found or not awaiting review' });
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/reject', async (req, reply) => {
    const body = RejectRequestSchema.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    if (!UUID.safeParse(req.params.id).success) return reply.code(404).send({ error: 'not found' });
    const job = await app.deps.repo.reject(
      req.params.id,
      body.data.reviewer ?? null,
      body.data.reason,
    );
    return job ?? reply.code(409).send({ error: 'job not found or not awaiting review' });
  });

  /** Recorded executions of each extract step (model, attempts, tokens, timing). */
  app.get<{ Params: { id: string } }>('/jobs/:id/steps', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return reply.code(404).send({ error: 'not found' });
    return app.deps.repo.listStepRuns(req.params.id);
  });

  /** Re-run one extract step of a document in review (worker reuses OCR; checks re-run). */
  app.post<{ Params: { id: string; step: string } }>(
    '/jobs/:id/steps/:step/rerun',
    async (req, reply) => {
      const body = RerunRequestSchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      if (!UUID.safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'not found' });
      }
      const job = await app.deps.repo.getJob(req.params.id);
      if (!job) return reply.code(404).send({ error: 'not found' });
      if (job.status !== 'awaiting_review') {
        return reply.code(409).send({ error: `job is ${job.status}, not awaiting_review` });
      }
      const resolved = await resolveDefinition(app.deps, job.specId, job.specVersion);
      const def = resolved?.ok ? resolved.definition : undefined;
      if (def?.kind !== 'template') {
        return reply.code(404).send({ error: 'job is not a template document' });
      }
      const step = def.template.pipeline.find(
        (s) => s.type === 'extract' && s.id === req.params.step,
      );
      if (!step || step.type !== 'extract') {
        return reply.code(400).send({ error: `no extract step "${req.params.step}"` });
      }
      const edited = (await app.deps.repo.listEdits(job.id)).filter((e) =>
        e.field ? step.fields.includes(e.field) : e.table === step.table,
      );
      if (edited.length) {
        return reply.code(409).send({
          error: `step "${step.id}" outputs already have ${edited.length} reviewer edits; a re-run would discard them`,
        });
      }
      const updated = await app.deps.repo.requestRerun(job.id, step.id, body.data);
      return updated ?? reply.code(409).send({ error: 'job is no longer awaiting review' });
    },
  );
};
