import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { error, md, noContent, res } from '../openapi/zod.js';
import { LoginLimiter } from './limiter.js';
import type { SessionInfo } from './repo.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in token (set by the access hook). */
    auth?: SessionInfo;
  }
}

export const SESSION_COOKIE = 'ih_session';
const UUID = z.string().uuid();

const LoginBody = z.object({
  token: z.string().min(1).max(200).describe('The access token: `ih_` and 43 more characters.'),
});
const CreateBody = z.object({
  label: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe('Who or what the token is for, e.g. "Ken – laptop".'),
  expiresInDays: z.union([
    z.literal(1),
    z.literal(7),
    z.literal(30),
    z.literal(90),
    z.literal(365),
    z.null(),
  ]),
});
const TokenParams = z.object({ id: z.string().uuid().describe('The token id.') });

const Role = z.enum(['admin', 'user']);
const Expiry = z.string().datetime().nullable();

/** The signed-in token, as login and me return it. */
const SessionView = z.object({
  role: Role,
  label: z.string(),
  expiresAt: Expiry.describe('When the token expires; null = never.'),
});

export const AccessTokenSchema = z.object({
  id: z.string().uuid(),
  label: z.string(),
  role: Role,
  createdAt: z.string().datetime(),
  expiresAt: Expiry,
  revokedAt: Expiry,
  lastUsedAt: Expiry,
  status: z.enum(['active', 'expired', 'revoked', 'current-admin']),
});

const CreatedToken = z.object({
  token: z.string().describe('The plaintext token. Shown only in this response.'),
  record: AccessTokenSchema,
});

const ADMINS_ONLY = error('`admins only`: the session was opened with a user token.');

/** Browsers cap cookie lifetimes at 400 days; the server still ends idle sessions after 7. */
const MAX_COOKIE_AGE_S = 400 * 86_400;

function setSession(
  req: FastifyRequest,
  reply: FastifyReply,
  sessionId: string,
  expiresAt: string | null,
) {
  // Persistent until the token expires (not a browser-session cookie): people shouldn't have to
  // re-enter a token after every browser restart.
  // Secure only over HTTPS (via the proxies' X-Forwarded-Proto): plain-HTTP LAN access must work.
  void reply.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: req.protocol === 'https',
    maxAge:
      expiresAt === null
        ? MAX_COOKIE_AGE_S
        : Math.max(
            0,
            Math.min(MAX_COOKIE_AGE_S, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000)),
          ),
  });
}

/**
 * Token access (ADR 0006): every /api route needs a valid session cookie except the routes marked
 * `config.public` (sign-in, sign-out and the API docs); token management needs the admin role. `deps.access === null` disables it (unit
 * tests only - server.ts always provides a repo). Registered on the root instance before the
 * route plugins, so the hook covers every route.
 */
export async function registerAccess(app: FastifyInstance): Promise<void> {
  const access = app.deps.access;
  if (!access) return;
  const limiter = new LoginLimiter();

  app.addHook('onRequest', async (req, reply) => {
    // Decide on the *matched route pattern*, never the raw URL: the router decodes and
    // normalises paths (e.g. /%61pi/specs matches /api/specs), so string checks on req.url can
    // be bypassed. Unmatched requests (no pattern) just 404 and serve nothing. Public routes are
    // marked on the route itself, never matched by path.
    const route = req.routeOptions.url;
    if (route === undefined || !route.startsWith('/api/') || req.routeOptions.config.public) return;
    const sessionId = req.cookies[SESSION_COOKIE];
    const session = sessionId ? await access.session(sessionId) : null;
    if (!session) return reply.code(401).send({ error: 'sign in required' });
    req.auth = session;
  });

  const adminOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.auth?.role !== 'admin') return reply.code(403).send({ error: 'admins only' });
  };

  app.post(
    '/api/auth/login',
    {
      config: { public: true },
      schema: {
        tags: ['Auth & sessions'],
        operationId: 'login',
        summary: 'Sign in with an access token',
        description: md`
          Opens a session for an active access token and sets the \`ih_session\` cookie
          (HttpOnly, SameSite=Strict, Secure when the request came over HTTPS). The cookie lasts
          until the token expires (at most 400 days, the browser limit; tokens that never expire
          get the maximum), but the server ends a session after 7 days without use.

          A wrong, expired or revoked token, or a missing one, is a \`401\`. After 10 failed
          attempts in 15 minutes a client (an IP address, or an IPv6 /64) gets \`429\` until older
          failures age out; other clients are unaffected.
        `,
        body: LoginBody,
        response: {
          200: res('Signed in; the session cookie is set.', SessionView),
          401: error('`invalid or expired token`.'),
          429: error('`too many attempts, try again later`.'),
        },
      },
    },
    async (req, reply) => {
      if (!limiter.allowed(req.ip)) {
        return reply.code(429).send({ error: 'too many attempts, try again later' });
      }
      const body = LoginBody.safeParse(req.body ?? {});
      const result = body.success ? await access.login(body.data.token) : null;
      if (!result) {
        limiter.fail(req.ip);
        req.log.warn({ ip: req.ip }, 'failed sign-in');
        if (limiter.surge()) req.log.warn('many failed sign-ins from many clients (scan?)');
        return reply.code(401).send({ error: 'invalid or expired token' });
      }
      setSession(req, reply, result.sessionId, result.session.expiresAt);
      const { role, label, expiresAt } = result.session;
      return { role, label, expiresAt };
    },
  );

  app.post(
    '/api/auth/logout',
    {
      config: { public: true },
      schema: {
        tags: ['Auth & sessions'],
        operationId: 'logout',
        summary: 'Sign out',
        description: md`
          Ends the current session and clears the \`ih_session\` cookie. Other sessions opened
          with the same token stay signed in (revoke the token to end them all). Answers \`204\`
          even when there is no session.
        `,
        response: { 204: noContent('Signed out.') },
      },
    },
    async (req, reply) => {
      const sessionId = req.cookies[SESSION_COOKIE];
      if (sessionId) await access.logout(sessionId);
      void reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/auth/me',
    {
      schema: {
        tags: ['Auth & sessions'],
        operationId: 'me',
        summary: 'Get the signed-in token',
        description: md`
          The role, label and expiry of the token the current session was opened with. The web
          app calls this on load to choose between the sign-in page and the app, and to show the
          admin pages only to admins.
        `,
        response: { 200: res('The signed-in token.', SessionView) },
      },
    },
    async (req) => {
      const { role, label, expiresAt } = req.auth!;
      return { role, label, expiresAt };
    },
  );

  app.get(
    '/api/auth/tokens',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Access tokens'],
        'x-admin': true,
        operationId: 'listTokens',
        summary: 'List access tokens',
        description: md`
          **Admin token required.** Every access token, newest first, with its status:
          \`active\`, \`expired\`, \`revoked\`, or \`current-admin\` for the admin token of the
          running API. Plaintext tokens are never stored, so they are not listed.
        `,
        response: {
          200: res('The tokens.', z.array(AccessTokenSchema)),
          403: ADMINS_ONLY,
        },
      },
    },
    async () => access.listTokens(),
  );

  app.post(
    '/api/auth/tokens',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Access tokens'],
        'x-admin': true,
        operationId: 'createToken',
        summary: 'Issue a user access token',
        description: md`
          **Admin token required.** Issues a new user token. The plaintext \`token\` is in this
          response only: give it to the person who will sign in with it. \`expiresInDays\` is
          1, 7, 30, 90 or 365, or \`null\` for a token that never expires.
        `,
        body: CreateBody,
        response: {
          200: res('The new token and its record.', CreatedToken),
          400: error('`label (1-100 chars) and expiresInDays are required`.'),
          403: ADMINS_ONLY,
        },
      },
    },
    async (req, reply) => {
      const body = CreateBody.safeParse(req.body ?? {});
      if (!body.success) {
        return reply
          .code(400)
          .send({ error: 'label (1-100 chars) and expiresInDays are required' });
      }
      return access.createToken(body.data.label, body.data.expiresInDays);
    },
  );

  const change =
    (apply: (id: string) => Promise<'ok' | 'not_found' | 'admin'>) =>
    async (req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
      if (!UUID.safeParse(req.params.id).success)
        return reply.code(404).send({ error: 'not found' });
      const result = await apply(req.params.id);
      if (result === 'not_found') return reply.code(404).send({ error: 'not found' });
      if (result === 'admin') {
        return reply
          .code(409)
          .send({ error: 'the admin token rotates on restart and cannot be revoked or deleted' });
      }
      return reply.code(204).send();
    };

  const changeResponses = (done: string) => ({
    204: noContent(done),
    403: ADMINS_ONLY,
    404: error('`not found`: no token with this id.'),
    409: error('`the admin token rotates on restart and cannot be revoked or deleted`.'),
  });

  app.post<{ Params: { id: string } }>(
    '/api/auth/tokens/:id/revoke',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Access tokens'],
        'x-admin': true,
        operationId: 'revokeToken',
        summary: 'Revoke an access token',
        description: md`
          **Admin token required.** Revokes a user token and ends every session opened with it.
          The token stays in the list as \`revoked\`, so its history is kept; delete it to remove
          it. The admin token cannot be revoked (it rotates on every API start).
        `,
        params: TokenParams,
        response: changeResponses('Revoked; its sessions are ended.'),
      },
    },
    change((id) => access.revokeToken(id)),
  );
  app.delete<{ Params: { id: string } }>(
    '/api/auth/tokens/:id',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Access tokens'],
        'x-admin': true,
        operationId: 'deleteToken',
        summary: 'Delete an access token',
        description: md`
          **Admin token required.** Deletes a user token and its sessions. Unlike revoking, the
          token disappears from the list. The admin token cannot be deleted (it rotates on every
          API start).
        `,
        params: TokenParams,
        response: changeResponses('Deleted, with its sessions.'),
      },
    },
    change((id) => access.deleteToken(id)),
  );
}
