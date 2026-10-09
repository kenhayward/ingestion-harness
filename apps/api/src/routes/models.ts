import type { FastifyPluginAsync } from 'fastify';

export const modelRoutes: FastifyPluginAsync = async (app) => {
  /** Models discovered by the worker (llm_models table). `?all=true` includes disabled ones. */
  app.get<{ Querystring: { all?: string } }>('/models', async (req) => {
    const models = await app.deps.repo.listModels();
    return req.query.all === 'true' ? models : models.filter((m) => m.enabled);
  });
};
