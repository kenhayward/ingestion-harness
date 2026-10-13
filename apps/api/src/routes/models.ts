import { ModelInfoSchema, isOffered } from '@ih/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { md, res } from '../openapi/zod.js';

export const modelRoutes: FastifyPluginAsync = async (app) => {
  /** The models offered in the pickers (curated, enabled); `?all=true` adds every other one. */
  app.get<{ Querystring: { all?: string } }>(
    '/models',
    {
      schema: {
        tags: ['Models'],
        operationId: 'listModels',
        summary: 'List the models jobs can use',
        description: md`
          The models offered in the model pickers, as \`endpoint/model-id\` refs: those chosen
          for an enabled endpoint (\`curated\`, seeded from \`.env\` or picked by an admin;
          [ADR 0010](https://github.com/kenhayward/ingestion-harness/blob/main/docs/adr/0010-llm-endpoints-in-the-database.md))
          and enabled. With \`all=true\` every known model is listed, including disabled ones
          and models the worker discovered on an endpoint but nobody chose (suggestions). A job
          or retry may name an offered model as an override; aliases such as \`default\` and
          \`fast\` are resolved by the worker and are not listed here.
        `,
        querystring: z.object({
          all: z
            .enum(['true', 'false'])
            .optional()
            .describe('`true` adds disabled models and uncurated discoveries.'),
        }),
        response: { 200: res('The models.', z.array(ModelInfoSchema)) },
      },
    },
    async (req) => {
      const models = await app.deps.repo.listModels();
      return req.query.all === 'true' ? models : models.filter(isOffered);
    },
  );
};
