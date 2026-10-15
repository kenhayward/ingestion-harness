import type { Creator } from '@ih/shared';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ErrorBody, error, md, noContent, res } from '../openapi/zod.js';
import { LoginLimiter } from './limiter.js';
import { MAX_PASSWORD } from './passwords.js';
import {
  DISABLE_AFTER,
  LOCK_AFTER,
  SESSION_MAX_MS,
  USER_AGENT_MAX,
  type AccessRepo,
  type NewSignInEvent,
  type SessionInfo,
} from './repo.js';
import { registerUserRoutes } from './users-routes.js';
import { registerProfileRoutes } from '../profile/routes.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in user (set by the access hook). */
    auth?: SessionInfo;
  }
}

export const SESSION_COOKIE = 'ih_session';

/** Who is making the request, recorded on the jobs it queues; null without access control. */
export const creatorOf = (req: FastifyRequest): Creator | null =>
  req.auth ? { name: req.auth.label, userId: req.auth.userId } : null;

/** What a session opened with a one-time password may call (ADR 0013). */
const WHILE_CHANGING = new Set(['GET /api/auth/me', 'PUT /api/auth/password']);
export const CHANGE_FIRST = 'change your one-time password first';
export const INVALID_LOGIN = 'invalid email or password';
const BUSY = 'too many sign-ins at once, try again in a moment';

const LoginBody = z.object({
  login: z
    .string()
    .min(1)
    .max(254)
    .describe('The email address (any case), or `admin` for the admin from the API log.'),
  password: z
    .string()
    .min(1)
    .max(MAX_PASSWORD)
    .describe('The password, a one-time password, or for `admin` the token from the log.'),
});
const PasswordBody = z.object({
  currentPassword: z
    .string()
    .min(1)
    .max(MAX_PASSWORD)
    .describe('The current or one-time password.'),
  newPassword: z
    .string()
    .min(1)
    .max(1000)
    .describe(
      '12 to 200 characters, different from the current one, not containing the email address.',
    ),
});

const Role = z.enum(['admin', 'user']);

/** The signed-in user, as login and me return it. */
export const MeSchema = z.object({
  userId: z.string().uuid().describe('The user id: what jobs record as `createdByUser`.'),
  role: Role,
  label: z.string().describe("The user's name, as recorded on the jobs and changes they make."),
  email: z.string().nullable().describe('null for the admin from the API log.'),
  mustChangePassword: z
    .boolean()
    .describe('A one-time password session: only me, the password change and sign-out work.'),
  avatarUrl: z
    .string()
    .url()
    .nullable()
    .describe("The linked GitHub account's picture (`GET /api/profile`); null: none linked."),
});
const SignedInSchema = MeSchema.extend({
  failedSinceLastSignIn: z
    .number()
    .int()
    .describe('Failed sign-ins this success cleared: worth telling the person about.'),
  lastFailedAt: z.string().datetime().nullable().describe('When the last failed sign-in was.'),
});
export const LockedBody = ErrorBody.extend({
  lockedUntil: z.string().datetime().describe('When sign-in works again.'),
});

/** The signed-in user with their picture: the linked GitHub account's, if any. */
const meView = async (req: FastifyRequest, s: SessionInfo) => ({
  userId: s.userId,
  role: s.role,
  label: s.label,
  email: s.email,
  mustChangePassword: s.mustChangePassword,
  avatarUrl: (await req.server.deps.profiles.get(s.userId)).github?.avatarUrl ?? null,
});

const lockedMessage = (until: string) =>
  `too many failed sign-ins for this account: try again after ${until}`;

/**
 * The session cookie's cross-site attributes. Normally SameSite=Strict. When other sites may frame
 * the app (`deps.frameAncestors`, ADR 0012) and the request came over HTTPS, the cookie must
 * reach the app inside their frame: SameSite=None (which needs Secure) and Partitioned (CHIPS,
 * so browsers that block third-party cookies keep one per embedding site). The cross-site guard
 * in `registerAccess` takes over SameSite=Strict's protection against forged requests.
 */
function cookieSite(req: FastifyRequest) {
  const framed = Boolean(req.server.deps.frameAncestors) && req.protocol === 'https';
  return framed
    ? ({ sameSite: 'none', secure: true, partitioned: true } as const)
    : ({ sameSite: 'strict', secure: req.protocol === 'https' } as const);
}

function setSession(req: FastifyRequest, reply: FastifyReply, sessionId: string) {
  // Persistent for the session's longest life (30 days, D10), not a browser-session cookie:
  // people shouldn't sign in after every browser restart. The server also ends idle sessions.
  // Secure only over HTTPS (via the proxies' X-Forwarded-Proto): plain-HTTP LAN access must work.
  void reply.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    path: '/',
    ...cookieSite(req),
    maxAge: SESSION_MAX_MS / 1000,
  });
}

/** Methods that change something: refused when the browser says another site sent them. */
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** Records a sign-in event (D11); a failed write is logged and never changes the answer. */
function recorder(access: AccessRepo, req: FastifyRequest) {
  const userAgent = req.headers['user-agent']?.slice(0, USER_AGENT_MAX) ?? null;
  return (event: Omit<NewSignInEvent, 'ip' | 'userAgent'>) =>
    access
      .recordSignIn({ ...event, ip: req.ip, userAgent })
      .catch((err: unknown) => req.log.warn({ err }, 'sign-in event not recorded'));
}

/**
 * Email and password access (ADR 0013): every /api route needs a valid session cookie except the
 * routes marked `config.public` (sign-in, sign-out and the API docs); a session opened with a
 * one-time password can only change it; user management needs the admin role.
 * `deps.access === null` disables it (unit tests only - server.ts always provides a repo).
 * Registered on the root instance before the route plugins, so the hook covers every route.
 */
export async function registerAccess(app: FastifyInstance): Promise<void> {
  const access = app.deps.access;
  if (!access) return;
  const limiter = new LoginLimiter();

  app.addHook('onRequest', async (req, reply) => {
    // Another site's page may not change anything here (forged form posts and fetches), signing
    // in included. Browsers mark such requests `Sec-Fetch-Site: cross-site`; the app's own
    // requests, framed or not, are same-origin, and scripts send no such header.
    if (UNSAFE.has(req.method) && req.headers['sec-fetch-site'] === 'cross-site') {
      return reply.code(403).send({ error: 'cross-site request refused' });
    }
    // Decide on the *matched route pattern*, never the raw URL: the router decodes and
    // normalises paths (e.g. /%61pi/specs matches /api/specs), so string checks on req.url can
    // be bypassed. Unmatched requests (no pattern) just 404 and serve nothing. Public routes are
    // marked on the route itself, never matched by path.
    const route = req.routeOptions.url;
    if (route === undefined || !route.startsWith('/api/') || req.routeOptions.config.public) return;
    const sessionId = req.cookies[SESSION_COOKIE];
    const session = sessionId ? await access.session(sessionId) : null;
    if (!session) return reply.code(401).send({ error: 'sign in required' });
    if (session.mustChangePassword && !WHILE_CHANGING.has(`${req.method} ${route}`)) {
      return reply.code(403).send({ error: CHANGE_FIRST });
    }
    req.auth = session;
  });

  app.post(
    '/api/auth/login',
    {
      config: { public: true },
      schema: {
        tags: ['Auth & sessions'],
        operationId: 'login',
        summary: 'Sign in with an email address and a password',
        description: md`
          Opens a session and sets the \`ih_session\` cookie (HttpOnly, SameSite=Strict, Secure
          when the request came over HTTPS). A session ends 30 days after sign-in, or after 7
          days without use. \`login\` is the email address, or \`admin\` for the admin from the
          API log, whose password is the token the API prints on every start.

          A session opened with a one-time password (\`mustChangePassword: true\`) can only read
          \`/api/auth/me\`, change the password and sign out until the password is changed.

          An unknown email and a wrong password are the same \`401\`. The ${LOCK_AFTER}th
          failed sign-in in a row locks the account for 15 minutes, each one after doubles the
          lock (at most 24 hours), and the ${DISABLE_AFTER}th disables the account until an
          admin enables it; the admin from the log is never locked. While locked, any password
          gets \`429\` with \`lockedUntil\`, unchecked. Separately, after 10 failed attempts in 15
          minutes a client (an IP address, or an IPv6 /64) gets \`429\` until older failures
          age out. Every attempt is recorded for admins (\`GET /api/sign-ins\`).
        `,
        body: LoginBody,
        response: {
          200: res('Signed in; the session cookie is set.', SignedInSchema),
          401: error(`\`${INVALID_LOGIN}\`.`),
          403: error(
            '`this account is disabled: ask an admin`, or `this one-time password has expired: ask an admin for a new one`.',
          ),
          429: res(
            '`too many failed sign-ins for this account: try again after <time>` (with `lockedUntil`), or `too many attempts, try again later` for the client.',
            LockedBody.partial({ lockedUntil: true }),
          ),
          503: error(`\`${BUSY}\`: too many sign-ins are being checked at this moment.`),
        },
      },
    },
    async (req, reply) => {
      // A place is reserved before the password is checked, so a burst of parallel attempts
      // counts against the client at once and at most a few scrypts run together.
      const slot = limiter.begin(req.ip);
      if (slot === null) {
        return reply.code(429).send({ error: 'too many attempts, try again later' });
      }
      if (slot === 'busy') return reply.code(503).send({ error: BUSY });
      let ok = true;
      try {
        const body = LoginBody.safeParse(req.body ?? {});
        if (!body.success) {
          ok = false;
          return reply.code(401).send({ error: INVALID_LOGIN }); // nothing to attribute: not recorded
        }
        const result = await access.login(body.data.login, body.data.password);
        const record = recorder(access, req);
        switch (result.kind) {
          case 'invalid': {
            ok = false;
            const lockedUntil =
              typeof result.locked === 'object' && result.locked ? result.locked.until : null;
            await record({
              userId: result.userId,
              result: result.userId ? 'wrong-password' : 'unknown-login',
              failures: result.failures,
              lockedUntil,
            });
            req.log.warn({ ip: req.ip, userId: result.userId }, 'failed sign-in');
            if (lockedUntil) {
              req.log.warn(
                { userId: result.userId, failures: result.failures, lockedUntil },
                'user locked',
              );
            }
            if (result.locked === 'disabled') {
              req.log.warn(
                { userId: result.userId, failures: result.failures },
                'user disabled after failed sign-ins',
              );
            }
            if (limiter.surge()) req.log.warn('many failed sign-ins from many clients (scan?)');
            return reply.code(401).send({ error: INVALID_LOGIN });
          }
          case 'locked':
            // Not limiter.fail: the password was not checked, so this is not a guess.
            await record({ userId: result.userId, result: 'locked', lockedUntil: result.until });
            return reply
              .code(429)
              .send({ error: lockedMessage(result.until), lockedUntil: result.until });
          case 'disabled':
            await record({ userId: result.userId, result: 'disabled' });
            return reply.code(403).send({ error: 'this account is disabled: ask an admin' });
          case 'expired':
            await record({ userId: result.userId, result: 'expired-one-time' });
            return reply
              .code(403)
              .send({ error: 'this one-time password has expired: ask an admin for a new one' });
          case 'ok':
            await record({
              userId: result.session.userId,
              result: 'ok',
              failures: result.failedSinceLastSignIn,
            });
            setSession(req, reply, result.sessionId);
            return {
              ...(await meView(req, result.session)),
              failedSinceLastSignIn: result.failedSinceLastSignIn,
              lastFailedAt: result.lastFailedAt,
            };
        }
      } finally {
        slot.done(ok);
      }
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
          Ends the current session and clears the \`ih_session\` cookie. Other sessions of the
          same user stay signed in (an admin's Disable ends them all). Answers \`204\` even when
          there is no session.
        `,
        response: { 204: noContent('Signed out.') },
      },
    },
    async (req, reply) => {
      const sessionId = req.cookies[SESSION_COOKIE];
      if (sessionId) await access.logout(sessionId);
      void reply.clearCookie(SESSION_COOKIE, { path: '/', httpOnly: true, ...cookieSite(req) });
      return reply.code(204).send();
    },
  );

  app.get(
    '/api/auth/me',
    {
      schema: {
        tags: ['Auth & sessions'],
        operationId: 'me',
        summary: 'Get the signed-in user',
        description: md`
          The role, name, email and picture of the signed-in user, and whether the session was
          opened with a one-time password. The web app calls this on load to choose between the
          sign-in page, the password change and the app, and to show the admin pages only to
          admins.
        `,
        response: { 200: res('The signed-in user.', MeSchema) },
      },
    },
    async (req) => meView(req, req.auth!),
  );

  app.put(
    '/api/auth/password',
    {
      schema: {
        tags: ['Auth & sessions'],
        operationId: 'changePassword',
        summary: 'Change your password',
        description: md`
          Changes the signed-in user's password; with a one-time password session this is the
          first sign-in step. The new password is 12 to 200 characters, differs from the current
          one and does not contain the email address. Every other session of the user ends;
          this one stays signed in.

          A wrong current password counts as a failed sign-in and can lock the account, as for
          sign-in. The admin from the API log cannot change its password: it rotates on every
          API start.
        `,
        body: PasswordBody,
        response: {
          204: noContent('Changed.'),
          400: error('`the current password is wrong`, or why the new password is refused.'),
          409: error('`the admin password rotates on restart and cannot be changed`.'),
          429: res(
            '`too many failed sign-ins for this account: try again after <time>`.',
            LockedBody,
          ),
        },
      },
    },
    async (req, reply) => {
      const body = PasswordBody.safeParse(req.body ?? {});
      if (!body.success) {
        return reply.code(400).send({ error: 'currentPassword and newPassword are required' });
      }
      const auth = req.auth!;
      const record = recorder(access, req);
      const result = await access.changePassword(
        req.cookies[SESSION_COOKIE]!,
        body.data.currentPassword,
        body.data.newPassword,
      );
      if (result === 'admin-from-log') {
        return reply
          .code(409)
          .send({ error: 'the admin password rotates on restart and cannot be changed' });
      }
      if (result === 'wrong' || result === 'locked') {
        const user = (await access.listUsers()).find((u) => u.id === auth.userId);
        await record({
          userId: auth.userId,
          result: 'password-change-refused',
          failures: user?.failedSignIns ?? null,
          lockedUntil: user?.status === 'locked' ? user.lockedUntil : null,
        });
        if (result === 'wrong') {
          limiter.fail(req.ip);
          return reply.code(400).send({ error: 'the current password is wrong' });
        }
        const until = user?.lockedUntil ?? new Date().toISOString();
        return reply.code(429).send({ error: lockedMessage(until), lockedUntil: until });
      }
      if (typeof result === 'object') return reply.code(400).send({ error: result.problem });
      await record({ userId: auth.userId, result: 'password-changed' });
      req.log.info({ userId: auth.userId }, 'password changed');
      return reply.code(204).send();
    },
  );

  registerUserRoutes(app, access);
  registerProfileRoutes(app, access);
}
