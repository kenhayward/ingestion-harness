import {
  bridgeError,
  BridgeErrorSchema,
  CONNECTION_ID,
  ConnectionListQuerySchema,
  ConnectionPutRequestSchema,
  ConnectionsDeletedSchema,
  ConnectionSummarySchema,
  UsersReconcileRequestSchema,
  type ConnectionSummary,
} from '@ih/bridge-contract';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { connectionProblem, INTERNAL_CONNECTION_ID } from '../connections/repo.js';
import { encryptSecret } from '../secrets.js';

const Params = z.strictObject({ id: z.string().regex(CONNECTION_ID) });
const UserParams = z.strictObject({ userId: z.string().min(1) });

/**
 * Connections as the producer reaches them (signed): secret-free lists (the shared connections
 * for its pickers, one user's personal ones for their Profile), a write used by the one-off move
 * of the keys CT Studio held for its targets, and the removal of the personal connections of
 * users who are gone. People manage connections on the connections page; nothing here ever
 * answers with a secret, or with what a user entered for a personal connection.
 */
export const connectionRoutes: FastifyPluginAsync = async (app) => {
  const tags = ['Connections'];

  /** A connection's stored values for its sink's non-secret fields only: never a secret. */
  const publicFields = async (
    sinkId: string,
    fields: Record<string, string>,
  ): Promise<Record<string, string>> => {
    const describe = await app.deps.sinks
      .get(sinkId)
      ?.describe()
      .catch(() => null);
    const ids = new Set(
      (describe?.credentialFields ?? []).filter((f) => !f.secret).map((f) => f.id),
    );
    return Object.fromEntries(Object.entries(fields).filter(([k]) => ids.has(k)));
  };

  app.get(
    '/v1/connections',
    {
      schema: {
        summary: 'List connections',
        tags,
        querystring: ConnectionListQuerySchema,
        response: {
          200: z.strictObject({ connections: z.array(ConnectionSummarySchema) }),
          400: BridgeErrorSchema,
        },
      },
    },
    async (req, reply) => {
      const query = ConnectionListQuerySchema.safeParse(req.query);
      if (!query.success) {
        return reply.code(400).send(bridgeError('content_rejected', 'unknown connection kind'));
      }
      const { kind, owner } = query.data;
      if (kind === 'personal' && owner === undefined) {
        return reply
          .code(400)
          .send(bridgeError('content_rejected', 'personal connections are listed for one owner'));
      }
      const listed = await app.deps.connections.list(
        kind === 'personal' ? { kind, owner: owner! } : { kind: 'shared' },
      );
      const connections: ConnectionSummary[] = [];
      for (const c of listed) {
        connections.push({
          id: c.id,
          name: c.name,
          sinkId: c.sinkId,
          kind: c.kind,
          instanceId: c.instanceId,
          status: c.status,
          statusReason: c.statusReason,
          lastUsedAt: c.lastUsedAt?.toISOString() ?? null,
          fields: c.kind === 'personal' ? {} : await publicFields(c.sinkId, c.fields),
        });
      }
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

  app.delete(
    '/v1/users/:userId/connections',
    {
      schema: {
        summary: "Delete a user's personal connections",
        description: 'Called by the producer when a user is disabled. Shared connections stay.',
        tags,
        params: UserParams,
        response: { 200: ConnectionsDeletedSchema, 400: BridgeErrorSchema },
      },
    },
    async (req, reply) => {
      const params = UserParams.safeParse(req.params);
      if (!params.success) {
        return reply.code(400).send(bridgeError('content_rejected', 'the request is not valid'));
      }
      return { deleted: await app.deps.connections.removeOwner(params.data.userId) };
    },
  );

  app.post(
    '/v1/users:reconcile',
    {
      schema: {
        summary: 'Keep the personal connections of live users only',
        description:
          'The producer sends the ids of its live users; the personal connections of anyone else are deleted. An empty list is refused.',
        tags,
        body: UsersReconcileRequestSchema,
        response: { 200: ConnectionsDeletedSchema, 422: BridgeErrorSchema },
      },
    },
    async (req, reply) => {
      const body = UsersReconcileRequestSchema.safeParse(req.body);
      if (!body.success) {
        return reply
          .code(422)
          .send(bridgeError('content_rejected', 'a reconcile names at least one live user'));
      }
      return { deleted: await app.deps.connections.removeOwnersNotIn(body.data.liveUserIds) };
    },
  );
};
