import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

const ListQuery = z.object({
  templateId: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.string().datetime({ offset: true }).optional(),
});

/** Published results: what each document delivered to the final target. */
export const resultRoutes: FastifyPluginAsync = async (app) => {
  app.get('/results', async (req, reply) => {
    const query = ListQuery.safeParse(req.query);
    if (!query.success) {
      const error = query.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
      return reply.code(400).send({ error });
    }
    return app.deps.repo.listPublished(query.data);
  });
};
