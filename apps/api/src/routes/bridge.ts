import {
  BridgeEventSchema,
  HandoffRedeemRequestSchema,
  HandoffUserSchema,
} from '@ih/bridge-contract';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
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
 * user, and the routes the bridge itself calls (signed with BRIDGE_CLIENT_KEY): redeeming that
 * link's one-time code, and the delivery events that finish delivering jobs.
 */
export async function bridgeRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    '/bridge/connections-link',
    {
      schema: {
        tags: ['Bridge'],
        'x-admin': true,
        operationId: 'createConnectionsLink',
        summary: 'Open the connections page',
        description: md`
          **Admins only** (shared connections; personal ones come later). A one-time link to
          the delivery bridge's connections page, good for 60 seconds, for the signed-in user:
          the web app opens it in a new tab, and the bridge redeems its code with a signed call.
          Credentials are entered there, never in CT Studio.
        `,
        response: {
          200: res('The link.', z.object({ url: z.string().url() })),
          403: error('`admins only`.'),
        },
      },
    },
    async (req, reply) => {
      if (app.deps.access && req.auth?.role !== 'admin') {
        return reply.code(403).send({ error: 'admins only' });
      }
      const { codes, publicUrl } = app.deps.bridgeAuth;
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
      return { url: url.toString() };
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
