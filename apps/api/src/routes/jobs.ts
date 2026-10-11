import type { FastifyPluginAsync } from 'fastify';
import { JobStatusSchema, pagePreviewKey } from '@ih/shared';
import { z } from 'zod';
import { storeFor } from '../storage/stage.js';

const ListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  status: JobStatusSchema.optional(),
});

const UUID = z.string().uuid();

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

  app.post<{ Params: { id: string } }>('/jobs/:id/retry', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return reply.code(404).send({ error: 'not found' });
    const job = await app.deps.repo.retryJob(req.params.id);
    return job ?? reply.code(409).send({ error: 'job not found or not in a retryable state' });
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
        .header('content-type', output.format === 'csv' ? 'text/csv' : 'application/json')
        .header(
          'content-disposition',
          `${inline === '1' ? 'inline' : 'attachment'}; filename="${filename}"`,
        )
        // Output bodies are LLM-derived: never let a browser sniff them into another type.
        .header('x-content-type-options', 'nosniff')
        .send(body)
    );
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
