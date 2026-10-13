import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { md, res } from '../openapi/zod.js';

const Readiness = z.object({
  status: z.enum(['ok', 'degraded']),
  checks: z
    .record(z.string())
    .describe("Each dependency's result: `ok`, or the error message of the failed check."),
});

export const healthRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/healthz',
    {
      schema: {
        tags: ['Health'],
        operationId: 'liveness',
        summary: 'Check the API process is running',
        description: md`
          Liveness check: answers as long as the API process can serve requests. It checks no
          dependencies, so a database or storage outage does not make it fail (use \`/readyz\`
          for that). Behind the app's nginx, \`/healthz\` is answered by nginx itself.
        `,
        response: { 200: res('The process is up.', z.object({ status: z.literal('ok') })) },
      },
    },
    async () => ({ status: 'ok' }),
  );

  app.get(
    '/readyz',
    {
      schema: {
        tags: ['Health'],
        operationId: 'readiness',
        summary: 'Check the API can reach its database and storage',
        description: md`
          Readiness check: pings Postgres (\`db\`) and the inbox bucket in object storage
          (\`storage\`). Answers \`200\` with \`status: ok\` when both respond, otherwise \`503\`
          with \`status: degraded\` and the failed check's error message.
        `,
        response: {
          200: res('Postgres and storage are reachable.', Readiness),
          503: res('At least one dependency failed its check.', Readiness),
        },
      },
    },
    async (_req, reply) => {
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
    },
  );
};
