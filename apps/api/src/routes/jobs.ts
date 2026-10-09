import type { FastifyPluginAsync } from 'fastify';
import { JobStatusSchema, pagePreviewKey } from '@ih/shared';
import { z } from 'zod';

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

  app.get<{ Params: { id: string; outputId: string } }>(
    '/jobs/:id/outputs/:outputId',
    async (req, reply) => {
      if (!UUID.safeParse(req.params.id).success)
        return reply.code(404).send({ error: 'not found' });
      const job = await app.deps.repo.getJob(req.params.id);
      const output = job?.outputs.find((o) => o.outputId === req.params.outputId);
      if (!output) return reply.code(404).send({ error: 'output not found' });

      const body = await app.deps.store.get(output.bucket, output.key);
      if (!body) return reply.code(404).send({ error: 'output object missing from storage' });
      const filename = output.key.split('/').pop() ?? `${output.outputId}.${output.format}`;
      return reply
        .header('content-type', output.format === 'csv' ? 'text/csv' : 'application/json')
        .header('content-disposition', `attachment; filename="${filename}"`)
        .send(body);
    },
  );

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
