import type { FastifyPluginAsync } from 'fastify';

export const specRoutes: FastifyPluginAsync = async (app) => {
  app.get('/specs', async () => app.deps.specs.list());

  app.get<{ Params: { id: string }; Querystring: { version?: string } }>(
    '/specs/:id',
    async (req, reply) => {
      const version = req.query.version ? Number(req.query.version) : undefined;
      const spec = app.deps.specs.get(req.params.id, version);
      return spec ?? reply.code(404).send({ error: 'spec not found' });
    },
  );
};
