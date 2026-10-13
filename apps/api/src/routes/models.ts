import { ModelInfoSchema } from '@ih/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { md, res } from '../openapi/zod.js';

export const modelRoutes: FastifyPluginAsync = async (app) => {
  /** Models discovered by the worker (llm_models table). `?all=true` includes disabled ones. */
  app.get<{ Querystring: { all?: string } }>(
    '/models',
    {
      schema: {
        tags: ['Models'],
        operationId: 'listModels',
        summary: 'List the models jobs can use',
        description: md`
          The models the worker discovered from the providers in \`config/llm-providers.yaml\`,
          as \`provider/model-id\` refs. Only enabled models are listed unless \`all=true\`.
          A job or step re-run may name any enabled model as an override; aliases such as
          \`default\` and \`fast\` are resolved by the worker and are not listed here.
        `,
        querystring: z.object({
          all: z.enum(['true', 'false']).optional().describe('`true` includes disabled models.'),
        }),
        response: { 200: res('The models.', z.array(ModelInfoSchema)) },
      },
    },
    async (req) => {
      const models = await app.deps.repo.listModels();
      return req.query.all === 'true' ? models : models.filter((m) => m.enabled);
    },
  );
};
