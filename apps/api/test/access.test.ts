import type { FastifyInstance } from 'fastify';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { z } from 'zod';
import { MemoryAccessRepo, type AccessToken } from '../src/access/repo.js';
import { AccessTokenSchema } from '../src/access/routes.js';
import { registeredRoutes, testApp } from './helpers.js';

async function setup() {
  const access = new MemoryAccessRepo();
  const ctx = await testApp({ access });
  const adminToken = await access.rotateAdminToken();
  return { ...ctx, access, adminToken };
}

const cookieOf = (res: { headers: Record<string, unknown> }) => {
  const raw = res.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : String(raw ?? '');
  return { header, value: /ih_session=([^;]*)/.exec(header)?.[1] ?? '' };
};

async function login(app: FastifyInstance, token: string, headers: Record<string, string> = {}) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { token },
    headers,
  });
  return { res, cookie: `ih_session=${cookieOf(res).value}` };
}

describe('token access', () => {
  it('requires a session for the API', async () => {
    const { app } = await setup();
    const res = await app.inject('/api/specs');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'sign in required' });
  });

  it('guards every /api route except login, logout and the API docs', async () => {
    const { app } = await setup();
    const routes = registeredRoutes(app.printRoutes({ commonPrefix: false }))
      .filter((r) => r.path.startsWith('/api/'))
      .filter((r) => !['HEAD', 'OPTIONS'].includes(r.method));
    expect(routes.length).toBeGreaterThan(20);
    const open: string[] = [];
    for (const { method, path } of routes) {
      const url = path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
      const res = await app.inject({ method: method as 'GET', url });
      // Login's own 401 (no token) is not the access hook's.
      const guarded = res.statusCode === 401 && res.json().error === 'sign in required';
      if (!guarded) open.push(`${method} ${path}`);
    }
    expect(open.sort()).toEqual([
      'GET /api/docs',
      'GET /api/docs/',
      'GET /api/docs/js/scalar.js',
      'GET /api/docs/openapi.json',
      'GET /api/docs/openapi.yaml',
      'POST /api/auth/login',
      'POST /api/auth/logout',
    ]);
  });

  it.each(['/api/docs/', '/api/docs/openapi.json', '/api/docs/js/scalar.js', '/api/%64ocs/'])(
    'serves %s without a session',
    async (url) => {
      const { app } = await setup();
      expect((await app.inject(url)).statusCode).toBe(200);
    },
  );

  it('signs in with the admin token and sets a strict, http-only session cookie', async () => {
    const { app, adminToken } = await setup();
    const { res, cookie } = await login(app, adminToken);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ role: 'admin', label: 'admin', expiresAt: null });
    const { header } = cookieOf(res);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Strict/i);
    expect(header).toMatch(/Path=\//);
    expect(header).not.toMatch(/Secure/i);
    expect((await app.inject({ url: '/api/specs', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).json()).toMatchObject({
      role: 'admin',
      label: 'admin',
    });
  });

  it('keeps the session cookie for the token lifetime (not just the browser session)', async () => {
    const { app, adminToken, access } = await setup();
    const never = cookieOf((await login(app, adminToken)).res).header;
    expect(never).toMatch(/Max-Age=34560000/); // 400 days: browsers cap cookie lifetimes there
    const { token } = await access.createToken('week', 7);
    const week = cookieOf((await login(app, token)).res).header;
    const maxAge = Number(/Max-Age=(\d+)/.exec(week)?.[1]);
    expect(maxAge).toBeGreaterThan(7 * 86_400 - 60);
    expect(maxAge).toBeLessThanOrEqual(7 * 86_400);
  });

  it('keeps trusting the private proxies when TRUST_PROXY adds one', async () => {
    const access = new MemoryAccessRepo();
    const { app } = await testApp({ access, trustProxy: '203.0.113.10' });
    const adminToken = await access.rotateAdminToken();
    const { res } = await login(app, adminToken, { 'x-forwarded-proto': 'https' });
    expect(cookieOf(res).header).toMatch(/Secure/i); // inject() comes from 127.0.0.1
  });

  it('marks the cookie Secure behind an HTTPS proxy', async () => {
    const { app, adminToken } = await setup();
    const { res } = await login(app, adminToken, { 'x-forwarded-proto': 'https' });
    expect(cookieOf(res).header).toMatch(/Secure/i);
  });

  it.each([{ token: 'ih_wrong' }, { token: '' }, {}])('rejects %j', async (payload) => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid or expired token' });
  });

  it('lets admins issue, revoke and delete user tokens; users cannot', async () => {
    const { app, adminToken } = await setup();
    const admin = (await login(app, adminToken)).cookie;
    const create = (cookie: string) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/tokens',
        headers: { cookie },
        payload: { label: 'Ken – laptop', expiresInDays: 30 },
      });

    const created = await create(admin);
    expect(created.statusCode).toBe(200);
    const { token, record } = created.json();
    expect(token).toMatch(/^ih_/);
    expect(record).toMatchObject({ label: 'Ken – laptop', role: 'user', status: 'active' });

    const user = (await login(app, token)).cookie;
    expect(
      (await app.inject({ url: '/api/auth/me', headers: { cookie: user } })).json(),
    ).toMatchObject({ role: 'user' });
    expect((await create(user)).statusCode).toBe(403);
    expect(
      (await app.inject({ url: '/api/auth/tokens', headers: { cookie: user } })).statusCode,
    ).toBe(403);

    const list = (await app.inject({ url: '/api/auth/tokens', headers: { cookie: admin } })).json();
    expect(list.map((t: { label: string }) => t.label).sort()).toEqual(['Ken – laptop', 'admin']);
    const adminRow = list.find((t: { role: string }) => t.role === 'admin');

    const revoke = (id: string) =>
      app.inject({
        method: 'POST',
        url: `/api/auth/tokens/${id}/revoke`,
        headers: { cookie: admin },
      });
    expect((await revoke(adminRow.id)).statusCode).toBe(409);
    expect((await revoke('00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await revoke(record.id)).statusCode).toBe(204);
    expect((await app.inject({ url: '/api/specs', headers: { cookie: user } })).statusCode).toBe(
      401,
    );

    const del = (id: string) =>
      app.inject({ method: 'DELETE', url: `/api/auth/tokens/${id}`, headers: { cookie: admin } });
    expect((await del(adminRow.id)).statusCode).toBe(409);
    expect((await del(record.id)).statusCode).toBe(204);
  });

  it.each([{ label: '', expiresInDays: 7 }, { label: 'x', expiresInDays: 3 }, { label: 'x' }])(
    'validates new tokens: %j',
    async (payload) => {
      const { app, adminToken } = await setup();
      const admin = (await login(app, adminToken)).cookie;
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/tokens',
        headers: { cookie: admin },
        payload,
      });
      expect(res.statusCode).toBe(400);
    },
  );

  it('signs out', async () => {
    const { app, adminToken } = await setup();
    const { cookie } = await login(app, adminToken);
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(res.statusCode).toBe(204);
    expect(cookieOf(res).header).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    expect((await app.inject({ url: '/api/specs', headers: { cookie } })).statusCode).toBe(401);
    // signing out without a session is harmless
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(204);
  });

  it('limits failed sign-ins per client IP (behind the proxies)', async () => {
    const { app, adminToken } = await setup();
    const from = (ip: string, token: string) => login(app, token, { 'x-forwarded-for': ip });
    for (let i = 0; i < 10; i++) {
      expect((await from('203.0.113.5', 'ih_wrong')).res.statusCode).toBe(401);
    }
    const blocked = await from('203.0.113.5', adminToken);
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.json()).toEqual({ error: 'too many attempts, try again later' });
    expect((await from('203.0.113.6', adminToken)).res.statusCode).toBe(200);
  });

  it('leaves health checks public', async () => {
    const { app } = await setup();
    expect((await app.inject('/healthz')).statusCode).toBe(200);
  });
});

describe('token access path handling', () => {
  it.each(['/%61pi/specs', '/api/%73pecs', '/API/specs', '/api//specs', '/api/specs/'])(
    'never serves %s without a session',
    async (url) => {
      const access = new MemoryAccessRepo();
      const { app } = await testApp({ access });
      const res = await app.inject(url);
      expect([401, 404]).toContain(res.statusCode);
    },
  );
});

describe('access token docs', () => {
  it('describe the AccessToken type exactly', () => {
    expectTypeOf<z.infer<typeof AccessTokenSchema>>().toEqualTypeOf<AccessToken>();
  });
});
