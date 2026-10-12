import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { LoginLimiter } from './limiter.js';
import type { SessionInfo } from './repo.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The signed-in token (set by the access hook). */
    auth?: SessionInfo;
  }
}

export const SESSION_COOKIE = 'ih_session';
const PUBLIC = new Set(['/api/auth/login', '/api/auth/logout']);
const UUID = z.string().uuid();

const LoginBody = z.object({ token: z.string().min(1).max(200) });
const CreateBody = z.object({
  label: z.string().trim().min(1).max(100),
  expiresInDays: z.union([
    z.literal(1),
    z.literal(7),
    z.literal(30),
    z.literal(90),
    z.literal(365),
    z.null(),
  ]),
});

function setSession(req: FastifyRequest, reply: FastifyReply, sessionId: string) {
  // Secure only over HTTPS (via the proxies' X-Forwarded-Proto): plain-HTTP LAN access must work.
  void reply.setCookie(SESSION_COOKIE, sessionId, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: req.protocol === 'https',
  });
}

/**
 * Token access (ADR 0006): every /api route needs a valid session cookie except sign-in and
 * sign-out; token management needs the admin role. `deps.access === null` disables it (unit
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
    // be bypassed. Unmatched requests (no pattern) just 404 and serve nothing.
    const route = req.routeOptions.url;
    if (route === undefined || !route.startsWith('/api/') || PUBLIC.has(route)) return;
    const sessionId = req.cookies[SESSION_COOKIE];
    const session = sessionId ? await access.session(sessionId) : null;
    if (!session) return reply.code(401).send({ error: 'sign in required' });
    req.auth = session;
  });

  const adminOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.auth?.role !== 'admin') return reply.code(403).send({ error: 'admins only' });
  };

  app.post('/api/auth/login', async (req, reply) => {
    if (!limiter.allowed(req.ip)) {
      return reply.code(429).send({ error: 'too many attempts, try again later' });
    }
    const body = LoginBody.safeParse(req.body ?? {});
    const result = body.success ? await access.login(body.data.token) : null;
    if (!result) {
      limiter.fail(req.ip);
      req.log.warn({ ip: req.ip }, 'failed sign-in');
      return reply.code(401).send({ error: 'invalid or expired token' });
    }
    setSession(req, reply, result.sessionId);
    const { role, label, expiresAt } = result.session;
    return { role, label, expiresAt };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const sessionId = req.cookies[SESSION_COOKIE];
    if (sessionId) await access.logout(sessionId);
    void reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.code(204).send();
  });

  app.get('/api/auth/me', async (req) => {
    const { role, label, expiresAt } = req.auth!;
    return { role, label, expiresAt };
  });

  app.get('/api/auth/tokens', { preHandler: adminOnly }, async () => access.listTokens());

  app.post('/api/auth/tokens', { preHandler: adminOnly }, async (req, reply) => {
    const body = CreateBody.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: 'label (1-100 chars) and expiresInDays are required' });
    }
    return access.createToken(body.data.label, body.data.expiresInDays);
  });

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

  app.post<{ Params: { id: string } }>(
    '/api/auth/tokens/:id/revoke',
    { preHandler: adminOnly },
    change((id) => access.revokeToken(id)),
  );
  app.delete<{ Params: { id: string } }>(
    '/api/auth/tokens/:id',
    { preHandler: adminOnly },
    change((id) => access.deleteToken(id)),
  );
}
