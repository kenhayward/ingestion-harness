import {
  adminErrorStatus,
  adminRoute,
  administrationOf,
  bridgeError,
  BridgeErrorSchema,
  SinkAdminCallSchema,
} from '@ih/bridge-contract';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { SinkError } from '../sinks/port.js';

const Params = z.strictObject({ sinkId: z.string() });

/** Instance calls need `administration.instances`, client and audit calls need `clients`. */
const INSTANCE_CALLS = new Set([
  'listInstances',
  'addInstance',
  'renameInstance',
  'removeInstance',
]);

/**
 * Contract version 3, relayed: CT Studio's administrator manages a registered sink's instances
 * and clients through the bridge, which signs each call with that sink's key. The request and the
 * answer are both checked against the call's route; a sink's refusal keeps its code and status.
 * The bridge keeps nothing: an issued client's secret passes straight back to the caller.
 */
export const sinkAdminRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/v1/sinks/:sinkId/admin',
    {
      schema: {
        summary: 'Relay an administration call to a sink',
        description:
          "One administration call (contract version 3) to a sink that declares administration: its instances, its clients or its audit log. The answer is the sink's, with the call's status (200, or 201 for an add or an issue).",
        tags: ['Catalog'],
        params: Params,
        body: SinkAdminCallSchema,
        response: {
          200: z.unknown(),
          201: z.unknown(),
          400: BridgeErrorSchema,
          404: BridgeErrorSchema,
          409: BridgeErrorSchema,
          422: BridgeErrorSchema,
          503: BridgeErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const { sinkId } = Params.parse(req.params);
      const body = SinkAdminCallSchema.safeParse(req.body);
      const route = body.success ? adminRoute(body.data.call) : null;
      const takesId = route?.path.includes('/:id:') ?? false;
      const request = route ? route.request.safeParse(body.data?.request) : null;
      if (!body.success || !request?.success || takesId !== (body.data.id !== null)) {
        return reply.code(400).send(bridgeError('content_rejected', 'the request is not valid'));
      }
      const sink = app.deps.sinks.get(sinkId);
      if (!sink)
        return reply.code(404).send(bridgeError('not_found', `there is no sink ${sinkId}`));
      try {
        const offered = administrationOf(await sink.describe());
        const part = INSTANCE_CALLS.has(body.data.call) ? 'instances' : 'clients';
        if (!offered || !offered[part] || !sink.admin) {
          return reply
            .code(422)
            .send(
              bridgeError(
                'content_rejected',
                offered
                  ? `${sinkId} does not offer administration of its ${part}`
                  : `${sinkId} does not offer administration`,
              ),
            );
        }
        const answer = await sink.admin(body.data.call, body.data.id, request.data);
        return reply.code(route!.status).send(answer);
      } catch (err) {
        if (err instanceof SinkError) {
          return reply.code(adminErrorStatus(err.error) as 404 | 409 | 422 | 503).send(err.error);
        }
        throw err;
      }
    },
  );
};
