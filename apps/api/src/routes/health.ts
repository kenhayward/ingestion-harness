import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get('/healthz', async () => ({ status: 'ok' }));

  app.get('/readyz', async (_req, reply) => {
    const { repo, store, buckets } = app.deps;
    const checks: Record<string, string> = {};
    for (const [name, check] of [
      ['db', () => repo.ping()],
      ['storage', () => store.ping(buckets.inbox)],
    ] as const) {
      try {
        await check();
        checks[name] = 'ok';
      } catch (err) {
        checks[name] = err instanceof Error ? err.message : 'error';
      }
    }
    const ok = Object.values(checks).every((v) => v === 'ok');
    return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', checks });
  });
};
