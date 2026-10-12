import type { FastifyPluginAsync } from 'fastify';
import { JobStatusSchema, pagePreviewKey, type JobSummary } from '@ih/shared';
import { z } from 'zod';
import { removeJobFiles } from '../jobs/delete.js';
import { resolveDefinition } from '../templates/definitions.js';
import { storeFor } from '../storage/stage.js';

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  status: JobStatusSchema.optional(),
});

const UUID = z.string().uuid();

/**
 * Content-Disposition for a user-supplied file name: an ASCII fallback that can't break out of
 * the quoted value (Node rejects non-Latin-1 header bytes outright), plus the exact name as
 * RFC 5987 `filename*` when it isn't plain ASCII.
 */
/** Percent-encode for RFC 5987 ext-value (encodeURIComponent leaves ' ( ) * as-is). */
const rfc5987 = (s: string) =>
  encodeURIComponent(s).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export function contentDisposition(name: string, type: 'inline' | 'attachment' = 'inline'): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  // eslint-disable-next-line no-control-regex -- detecting non-ASCII is the point
  const exact = /[^\x00-\x7f]/.test(name) ? `; filename*=UTF-8''${rfc5987(name)}` : '';
  return `${type}; filename="${ascii}"${exact}`;
}

/** model: a ref sets the job's override, null clears it (spec default), absent keeps it. */
const RetryBody = z.object({ model: z.string().min(1).nullable().optional() });

const CleanupBody = z.object({
  olderThanDays: z.number().int().min(1).max(3650),
  dryRun: z.boolean(),
  /** Regression runs feed scores and metrics: kept unless explicitly included. */
  includeRegression: z.boolean().default(false),
  /** The preview's cutoff, so the delete matches what was previewed (not "now - N days"). */
  cutoff: z.string().datetime().optional(),
  /** Jobs deleted per request; the client repeats while `remaining` > 0. */
  limit: z.number().int().min(1).max(500).default(100),
});

export const jobRoutes: FastifyPluginAsync = async (app) => {
  app.get('/jobs', async (req, reply) => {
    const query = ListQuery.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: query.error.issues });
    return app.deps.repo.listJobs(query.data);
  });

  app.get<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return reply.code(404).send({ error: 'not found' });
    const job = await app.deps.repo.getJob(req.params.id);
    return job ?? reply.code(404).send({ error: 'not found' });
  });

  /**
   * The version a retry re-processes with: the latest published (or newest file) version.
   * Test runs (a draft under test), regression runs (pinned to a version) and cancelled
   * publish/rerun tasks (review edits belong to the reviewed version) keep theirs.
   */
  async function latestVersionFor(job: JobSummary): Promise<number | undefined> {
    const reprocesses = job.status !== 'cancelled' || job.task === 'process';
    if (!reprocesses || job.test || job.referenceId) return undefined;
    const latest = await resolveDefinition(app.deps, job.specId);
    return latest?.ok ? latest.definition.version : undefined;
  }

  app.post<{ Params: { id: string } }>('/jobs/:id/retry', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return reply.code(404).send({ error: 'not found' });
    const body = RetryBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'model must be a model ref or null' });
    const { model } = body.data;
    if (model) {
      const known = (await app.deps.repo.listModels()).some((m) => m.enabled && m.ref === model);
      if (!known) return reply.code(400).send({ error: `unknown or disabled model ${model}` });
    }
    const current = await app.deps.repo.getJob(req.params.id);
    const job = await app.deps.repo.retryJob(req.params.id, {
      model,
      specVersion: current ? await latestVersionFor(current) : undefined,
    });
    return job ?? reply.code(409).send({ error: 'job not found or not in a retryable state' });
  });

  app.post<{ Params: { id: string } }>('/jobs/:id/cancel', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return reply.code(404).send({ error: 'not found' });
    if (!(await app.deps.repo.getJob(req.params.id))) {
      return reply.code(404).send({ error: 'not found' });
    }
    const job = await app.deps.repo.cancelJob(req.params.id);
    return job ?? reply.code(409).send({ error: 'only queued or running jobs can be cancelled' });
  });

  app.delete<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return reply.code(404).send({ error: 'not found' });
    const res = await app.deps.repo.deleteJob(req.params.id);
    if (res.result === 'not_found') return reply.code(404).send({ error: 'not found' });
    if (res.result === 'conflict') {
      return reply
        .code(409)
        .send({ error: `a ${res.status} job cannot be deleted: cancel or review it first` });
    }
    await removeJobFiles(app.deps, res.removed, req.log);
    return reply.code(204).send();
  });

  /** Bulk delete of finished jobs older than N days (dryRun: count only). */
  app.post('/jobs/cleanup', async (req, reply) => {
    const body = CleanupBody.safeParse(req.body);
    if (!body.success) {
      const error = body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.code(400).send({ error });
    }
    const { olderThanDays, dryRun, includeRegression, limit } = body.data;
    const cutoff =
      body.data.cutoff ?? new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const ids = await app.deps.repo.finishedJobIdsBefore(cutoff, includeRegression);
    if (dryRun) return { count: ids.length, cutoff };
    let deleted = 0;
    for (const id of ids.slice(0, limit)) {
      const res = await app.deps.repo.deleteJob(id);
      if (res.result !== 'deleted') continue; // status changed meanwhile: skip it
      deleted++;
      await removeJobFiles(app.deps, res.removed, req.log);
    }
    return { deleted, remaining: Math.max(0, ids.length - limit), cutoff };
  });

  app.get<{
    Params: { id: string; outputId: string };
    Querystring: { stage?: string; inline?: string };
  }>('/jobs/:id/outputs/:outputId', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return reply.code(404).send({ error: 'not found' });
    const { stage, inline } = req.query;
    if (stage !== undefined && stage !== 'draft' && stage !== 'published') {
      return reply.code(400).send({ error: 'stage must be draft or published' });
    }
    const job = await app.deps.repo.getJob(req.params.id);
    const matches = (job?.outputs ?? []).filter(
      (o) => o.outputId === req.params.outputId && (stage === undefined || o.stage === stage),
    );
    // A reviewed job has a draft and a published copy: default to what was delivered.
    const output = matches.find((o) => o.stage === 'published') ?? matches[0];
    if (!output) return reply.code(404).send({ error: 'output not found' });

    const where = output.stage === 'published' ? 'target' : 'storage';
    let body: Buffer | null;
    try {
      body = await storeFor(app.deps, output.stage).get(output.bucket, output.key);
    } catch (err) {
      req.log.warn({ err, bucket: output.bucket }, 'output read failed');
      return reply
        .code(502)
        .send({ error: `${where === 'target' ? 'target ' : ''}storage unavailable` });
    }
    if (!body) return reply.code(404).send({ error: `output object missing from ${where}` });
    const filename = output.key.split('/').pop() ?? `${output.outputId}.${output.format}`;
    return (
      reply
        .header(
          'content-type',
          output.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/json',
        )
        .header(
          'content-disposition',
          `${inline === '1' ? 'inline' : 'attachment'}; filename="${filename}"`,
        )
        // Output bodies are LLM-derived: never let a browser sniff them into another type.
        .header('x-content-type-options', 'nosniff')
        .send(body)
    );
  });

  /** The uploaded PDF (Jobs "Open PDF"), served inline from the inbox bucket. */
  app.get<{ Params: { id: string } }>('/jobs/:id/document', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return reply.code(404).send({ error: 'not found' });
    const doc = await app.deps.repo.getDocumentObject(req.params.id);
    if (!doc) return reply.code(404).send({ error: 'not found' });
    let body: Buffer | null;
    try {
      body = await app.deps.store.get(doc.bucket, doc.key);
    } catch (err) {
      req.log.warn({ err, bucket: doc.bucket }, 'document read failed');
      return reply.code(502).send({ error: 'storage unavailable' });
    }
    if (!body) return reply.code(404).send({ error: 'document missing from storage' });
    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', contentDisposition(doc.filename))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, max-age=300')
      .send(body);
  });

  /** JPEG page preview rendered by the worker (review screen). */
  app.get<{ Params: { id: string; n: string } }>('/jobs/:id/pages/:n', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return reply.code(404).send({ error: 'not found' });
    const page = Number(req.params.n);
    if (!Number.isInteger(page) || page < 1 || page > 5000) {
      return reply.code(400).send({ error: 'page must be a positive integer' });
    }
    const body = await app.deps.store.get(
      app.deps.buckets.runs,
      pagePreviewKey(req.params.id, page),
    );
    if (!body) return reply.code(404).send({ error: 'page preview not found' });
    return reply
      .header('content-type', 'image/jpeg')
      .header('cache-control', 'private, max-age=3600')
      .send(body);
  });
};
