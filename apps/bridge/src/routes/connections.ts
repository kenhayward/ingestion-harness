import {
  bridgeError,
  BridgeErrorSchema,
  CONNECTION_ID,
  ConnectionPutRequestSchema,
  ConnectionSummarySchema,
  type ConnectionSummary,
} from '@ih/bridge-contract';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { connectionProblem, INTERNAL_CONNECTION_ID } from '../connections/repo.js';
import { encryptSecret } from '../secrets.js';

const Params = z.strictObject({ id: z.string().regex(CONNECTION_ID) });
const Query = z.strictObject({ kind: z.enum(['shared', 'personal']).optional() });

/**
 * Connections as the producer reaches them (signed): a secret-free list for its pickers, and a
 * write used by the one-off move of the keys CT Studio held for its targets. Admins manage
 * connections on the connections page; nothing here ever answers with a secret.
 */
export const connectionRoutes: FastifyPluginAsync = async (app) => {
  const tags = ['Connections'];

  app.get(
    '/v1/connections',
    {
      schema: {
        summary: 'List connections',
        tags,
        querystring: Query,
        response: {
          200: z.strictObject({ connections: z.array(ConnectionSummarySchema) }),
          400: BridgeErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const query = Query.safeParse(req.query);
      if (!query.success) {
        return reply.code(400).send(bridgeError('content_rejected', 'unknown connection kind'));
      }
      const listed = await app.deps.connections.list(
        query.data.kind ? { kind: query.data.kind } : {},
      );
      const connections: ConnectionSummary[] = listed.map((c) => ({
        id: c.id,
        name: c.name,
        sinkId: c.sinkId,
        status: c.status,
        statusReason: c.statusReason,
      }));
      return { connections };
    },
  );

  app.put(
    '/v1/connections/:id',
    {
      schema: {
        summary: 'Write a shared connection',
        description:
          'Used by the producer to move the keys it held for a target onto the bridge. The secret is encrypted on arrival.',
        tags,
        params: Params,
        body: ConnectionPutRequestSchema,
        response: { 204: z.null(), 400: BridgeErrorSchema, 422: BridgeErrorSchema },
      },
    },
    async (req, reply) => {
      const params = Params.safeParse(req.params);
      const body = ConnectionPutRequestSchema.safeParse(req.body);
      if (!params.success || !body.success) {
        return reply.code(400).send(bridgeError('content_rejected', 'the request is not valid'));
      }
      const { id } = params.data;
      const c = body.data;
      const refuse = (message: string) =>
        reply.code(422).send(bridgeError('content_rejected', message));
      if (id === INTERNAL_CONNECTION_ID) return refuse('the built-in connection cannot be written');
      if (!app.deps.sinks.get(c.sinkId)) return refuse(`there is no sink ${c.sinkId}`);
      if (c.secret !== null && c.secretEnv !== null) {
        return refuse('a connection has a secret or a secret variable, not both');
      }
      const record = {
        id,
        kind: 'shared' as const,
        owner: null,
        sinkId: c.sinkId,
        instanceId: null,
        name: c.name,
        fields: c.fields,
        secretEnv: c.secretEnv,
        status: 'untested' as const,
        statusReason: null,
      };
      const problem = connectionProblem(record);
      if (problem) return refuse(problem);
      await app.deps.connections.put({
        ...record,
        secretEnc: c.secret === null ? null : encryptSecret(c.secret, app.deps.config.secrets),
      });
      return reply.code(204).send();
    },
  );
};
