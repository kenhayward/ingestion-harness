import type { FastifyInstance } from 'fastify';
import { PluginInfoSchema } from '@ih/shared';
import { z } from 'zod';
import { md, res } from '../openapi/zod.js';

/** The plugin catalogue (docs/design/recipe-plugins.md, slice 3b). */
export async function pluginRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/plugins',
    {
      schema: {
        tags: ['Recipes'],
        operationId: 'listPlugins',
        summary: 'List the plugins recipe steps can run',
        description: md`
          The plugins this deployment's workers can run, as the worker publishes them when it
          starts: each one's ref (\`<id>@<major>\`, what a plugin step names in \`uses\`), summary,
          whether it sends data out, and the JSON Schema of its settings (a step's \`with\`).
          Empty before any worker has started. A recipe naming a plugin that is not listed, or
          settings that do not fit its schema, cannot be published.
        `,
        response: { 200: res('The plugins, by ref.', z.array(PluginInfoSchema)) },
      },
    },
    async () => (app.deps.plugins ? await app.deps.plugins.list() : []),
  );
}
