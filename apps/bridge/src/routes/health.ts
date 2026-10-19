import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const Status = z.strictObject({ status: z.string() });

/** Liveness and readiness, unsigned (Docker's healthcheck calls them). */
export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/healthz',
    { schema: { summary: 'Liveness', tags: ['Health'], response: { 200: Status } } },
    async () => ({ status: 'ok' }),
  );
  app.get(
    '/readyz',
    {
      schema: { summary: 'Readiness', tags: ['Health'], response: { 200: Status, 503: Status } },
    },
    async (_req, reply) =>
      (await app.deps.ready())
        ? { status: 'ready' }
        : reply.code(503).send({ status: 'not ready' }),
  );
};
