import type { FastifyPluginAsync } from 'fastify';
import { listDefinitions, resolveDefinition } from '../templates/definitions.js';

export const specRoutes: FastifyPluginAsync = async (app) => {
  /** Document types available for upload (published templates + file definitions). */
  app.get('/specs', async () => listDefinitions(app.deps));

  app.get<{ Params: { id: string }; Querystring: { version?: string } }>(
    '/specs/:id',
    async (req, reply) => {
      const version = req.query.version ? Number(req.query.version) : undefined;
      const resolved = await resolveDefinition(app.deps, req.params.id, version);
      if (!resolved) return reply.code(404).send({ error: 'spec not found' });
      if (!resolved.ok) return reply.code(422).send({ error: resolved.error });
      return resolved.definition;
    },
  );
};
