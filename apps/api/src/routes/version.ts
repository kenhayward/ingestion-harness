import type { FastifyPluginAsync } from 'fastify';
import { DEV_VERSION, VersionInfoSchema } from '@ih/shared';
import { md, res } from '../openapi/zod.js';

export const versionRoutes: FastifyPluginAsync = async (app) => {
  const version = app.deps.version ?? DEV_VERSION;

  app.get(
    '/version',
    {
      config: { public: true },
      schema: {
        tags: ['Health'],
        operationId: 'version',
        summary: 'Show which build of CT Studio is running',
        description: md`
          The build's version (ADR 0014). CI tags every merge to \`main\` \`YYYY.MM.DD.N\`
          (the UTC date, \`N\` from 1 each day), and the deploy bakes the tag into the images. A
          build of an untagged commit reads \`<nearest tag>+<commit>\` (\`dev+<commit>\` without
          one), and \`+dirty\`/\`.dirty\` marks uncommitted changes. \`previous\` is the tag before
          this build's (null for the first tag or a dev build); \`commit\` is the short hash.
          Needs no session.
        `,
        response: { 200: res('The build.', VersionInfoSchema) },
      },
    },
    async () => version,
  );
};
