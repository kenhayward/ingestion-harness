import {
  BridgeEventSchema,
  HandoffRedeemRequestSchema,
  HandoffUserSchema,
} from '@ih/bridge-contract';
import {
  ConnectionsLinkBodySchema,
  ConnectionsLinkSchema,
  MyConnectionsSchema,
  type ConnectionsLink,
  type MyConnection,
} from '@ih/shared';
import type { FastifyInstance } from 'fastify';
import { applyEvent } from '../bridge/events.js';
import { guardBridgeSigned } from '../bridge/guard.js';
import { error, md, noContent, res } from '../openapi/zod.js';

const SIGNED = md`
  **Signed by the bridge (x-bridge-signature):** HMAC-SHA256 with the shared
  \`BRIDGE_CLIENT_KEY\` over the method, path, timestamp, nonce and body; no session. A stale,
  replayed or unsigned request is \`401\`.
`;

const REFUSED = error('`bridge signature refused`.');

/**
 * The delivery bridge's side of CT Studio: a link to its connections page for the signed-in
 * user, a secret-free list of their personal connections for Profile, and the routes the bridge
 * itself calls (signed with BRIDGE_CLIENT_KEY): redeeming that link's one-time code, and the
 * delivery events that finish delivering jobs.
 */
export async function bridgeRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/bridge/connections-link',
    {
      schema: {
        tags: ['Bridge'],
        operationId: 'createConnectionsLink',
        summary: 'Open the connections page',
        description: md`
          A one-time link to the delivery bridge's connections page, good for 60 seconds, for
          the signed-in user, whatever their role, and the bridge redeems its code with a signed
          call. Everyone manages their own personal connections there; admins also manage the
          shared ones. Credentials are entered there, never in CT Studio.

          \`embed\` is set when the page has its own origin and may be framed by this app's
          (\`BRIDGE_APP_ORIGIN\`): the web app opens it in a modal and accepts the page's messages
          from \`pageOrigin\` only. Null: it opens a new tab. \`theme\` (light or dark) is passed
          on for the page to match.
        `,
        body: ConnectionsLinkBodySchema,
        response: {
          200: res('The link.', ConnectionsLinkSchema),
          400: error('A `theme` other than light or dark.'),
        },
      },
    },
    async (req, reply) => {
      const body = ConnectionsLinkBodySchema.safeParse(req.body ?? {});
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const { codes, publicUrl, appOrigin } = app.deps.bridgeAuth;
      const auth = req.auth ?? {
        userId: 'unit-test-admin',
        label: 'admin',
        email: null,
        role: 'admin' as const,
      };
      const code = codes.mint({
        id: auth.userId,
        name: auth.label,
        email: auth.email,
        role: auth.role,
      });
      const url = new URL(`${publicUrl.replace(/\/+$/, '')}/connections/start`);
      url.searchParams.set('code', code);
      if (body.data?.theme) url.searchParams.set('theme', body.data.theme);
      const link: ConnectionsLink = {
        url: url.toString(),
        embed: appOrigin ? { appOrigin, pageOrigin: new URL(publicUrl).origin } : null,
      };
      return link;
    },
  );

  app.get(
    '/profile/connections',
    {
      schema: {
        tags: ['Bridge'],
        operationId: 'listMyConnections',
        summary: 'List my connections',
        description: md`
          The signed-in user's personal connections on the delivery bridge, as Profile shows
          them: name, system, instance, status and when a delivery last used it. Never a
          credential, and never another user's. \`personalSinks\` says whether any system uses
          personal connections at all.
        `,
        response: {
          200: res('The connections.', MyConnectionsSchema),
          502: error('`connections are unavailable right now`: the bridge did not answer.'),
        },
      },
    },
    async (req, reply) => {
      const { bridge } = app.deps;
      const owner = req.auth?.userId ?? 'unit-test-admin';
      try {
        const [sinks, listed] = await Promise.all([
          bridge.listSinks(),
          bridge.listPersonalConnections(owner),
        ]);
        const byId = new Map(sinks.map((s) => [s.id, s]));
        const connections = listed.map((c): MyConnection => {
          const sink = byId.get(c.sinkId);
          const instance = sink?.instances.find((i) => i.id === c.instanceId);
          return {
            id: c.id,
            name: c.name,
            sinkName: sink?.name ?? c.sinkId,
            instanceLabel: instance?.label ?? c.instanceId ?? '',
            status: c.status,
            statusReason: c.statusReason,
            lastUsedAt: c.lastUsedAt,
          };
        });
        return {
          personalSinks: sinks.some((s) => s.connectionKind === 'personal'),
          connections,
        };
      } catch (err) {
        req.log.warn({ err }, 'personal connections not listed');
        return reply.code(502).send({ error: 'connections are unavailable right now' });
      }
    },
  );

  await app.register(signedRoutes);
}

async function signedRoutes(app: FastifyInstance): Promise<void> {
  const { key, nonces } = app.deps.bridgeAuth;
  guardBridgeSigned(app, { key, nonces: nonces! });

  app.post(
    '/bridge/handoff/redeem',
    {
      config: { public: true },
      schema: {
        tags: ['Bridge'],
        operationId: 'redeemBridgeHandoff',
        summary: 'Redeem a connections-page code',
        description: md`
          The bridge exchanges the one-time code of a connections link for the user it was
          minted for (id, name, email, role). An unknown, used or expired code is \`404\`.

          ${SIGNED}
        `,
        body: HandoffRedeemRequestSchema,
        response: {
          200: res('The user.', HandoffUserSchema),
          400: error('The body is not `{ code }`.'),
          401: REFUSED,
          404: error('`unknown or expired code`.'),
        },
      },
    },
    async (req, reply) => {
      const body = HandoffRedeemRequestSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const user = app.deps.bridgeAuth.codes.redeem(body.data.code);
      if (!user) return reply.code(404).send({ error: 'unknown or expired code' });
      return user;
    },
  );

  app.post(
    '/bridge/events',
    {
      config: { public: true },
      schema: {
        tags: ['Bridge'],
        operationId: 'receiveBridgeEvent',
        summary: 'Receive a delivery event',
        description: md`
          The bridge reports a delivery's status change (sequence-numbered, at least once). An
          event newer than the last one recorded updates the delivery, and the job finishes once
          every one of its deliveries has.

          ${SIGNED}
        `,
        body: BridgeEventSchema,
        response: {
          204: noContent('Recorded (or older than what is recorded).'),
          400: error('The body is not a delivery event.'),
          401: REFUSED,
          409: error(
            '`unknown delivery`: not recorded here yet (the worker records it as it hands the job over); the bridge sends it again later.',
          ),
        },
      },
    },
    async (req, reply) => {
      const body = BridgeEventSchema.safeParse(req.body);
      if (!body.success) return reply.code(400).send({ error: body.error.issues });
      const outcome = await applyEvent(
        { repo: app.deps.repo, targets: app.deps.targets },
        body.data,
      );
      if (outcome === 'unknown') return reply.code(409).send({ error: 'unknown delivery' });
      return reply.code(204).send();
    },
  );
}
