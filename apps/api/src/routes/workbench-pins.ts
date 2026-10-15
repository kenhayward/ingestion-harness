import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { md, noContent, res } from '../openapi/zod.js';
import { PROJECT_NOT_FOUND } from './workbench.js';

const PinParams = z.object({
  projectId: z.string().describe('The project id: the id of its document type.'),
});

/** Who the pins belong to: the signed-in user (`local` when access control is off). */
const ownerOf = (req: { auth?: { userId: string } | null }) => req.auth?.userId ?? 'local';

/** Per-user pins on the Workbench project list (handoff W3). */
export const workbenchPinsRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/workbench/pins',
    {
      schema: {
        tags: ['Projects & data policy'],
        operationId: 'listProjectPins',
        summary: 'List the pinned projects',
        description: md`
          The ids of the projects the signed-in user has pinned, most recently pinned first.
          Pins belong to the user, so each user sees their own. A deleted project is dropped.
        `,
        response: { 200: res('The pinned project ids.', z.array(z.string())) },
      },
    },
    async (req) => app.deps.workbench.listPins(ownerOf(req)),
  );

  app.put<{ Params: { projectId: string } }>(
    '/workbench/pins/:projectId',
    {
      schema: {
        tags: ['Projects & data policy'],
        operationId: 'pinProject',
        summary: 'Pin a project',
        description: md`
          Pins the project for the signed-in user. Pinning an already pinned project changes
          nothing: it keeps its original place in the order.
        `,
        params: PinParams,
        response: { 204: noContent('Pinned.'), 404: PROJECT_NOT_FOUND },
      },
    },
    async (req, reply) => {
      const found = await app.deps.workbench.pin(ownerOf(req), req.params.projectId);
      if (!found) return reply.code(404).send({ error: 'project not found' });
      return reply.code(204).send();
    },
  );

  app.delete<{ Params: { projectId: string } }>(
    '/workbench/pins/:projectId',
    {
      schema: {
        tags: ['Projects & data policy'],
        operationId: 'unpinProject',
        summary: 'Unpin a project',
        description: md`
          Removes the project from the signed-in user's pins. Unpinning a project that is not
          pinned (or does not exist) is not an error.
        `,
        params: PinParams,
        response: { 204: noContent('Unpinned.') },
      },
    },
    async (req, reply) => {
      await app.deps.workbench.unpin(ownerOf(req), req.params.projectId);
      return reply.code(204).send();
    },
  );
};
