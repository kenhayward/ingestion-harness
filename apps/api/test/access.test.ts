import type { FastifyInstance } from 'fastify';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
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

  it('keeps the strict cookie when framing is allowed but the request is plain HTTP', async () => {
    const access = new MemoryAccessRepo();
    const { app } = await testApp({ access, frameAncestors: 'https://*.3dexperience.3ds.com' });
    const { res } = await login(app, await access.rotateAdminToken());
    expect(cookieOf(res).header).toMatch(/SameSite=Strict/i);
    expect(cookieOf(res).header).not.toMatch(/Partitioned/i);
  });

  it('sends the cookie into allowed frames over HTTPS: SameSite=None, Secure, Partitioned', async () => {
    const access = new MemoryAccessRepo();
    const { app } = await testApp({ access, frameAncestors: 'https://*.3dexperience.3ds.com' });
    const { res, cookie } = await login(app, await access.rotateAdminToken(), {
      'x-forwarded-proto': 'https',
    });
    const { header } = cookieOf(res);
    expect(header).toMatch(/SameSite=None/i);
    expect(header).toMatch(/Secure/i);
    expect(header).toMatch(/Partitioned/i);
    expect(header).toMatch(/HttpOnly/i);
    const out = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie, 'x-forwarded-proto': 'https' },
    });
    // A partitioned cookie is only cleared by a Set-Cookie with the same attributes.
    expect(cookieOf(out).header).toMatch(/ih_session=;.*Partitioned/i);
    expect(cookieOf(out).header).toMatch(/SameSite=None/i);
  });

  it("refuses another site's state-changing requests, whatever the cookie", async () => {
    const { app, adminToken } = await setup();
    const { cookie } = await login(app, adminToken);
    const send = (method: 'POST' | 'DELETE' | 'GET', url: string, site?: string) =>
      app.inject({
        method,
        url,
        headers: { cookie, ...(site ? { 'sec-fetch-site': site } : {}) },
        ...(method === 'POST' ? { payload: {} } : {}),
      });
    const crossSite = await send('POST', '/api/auth/logout', 'cross-site');
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json()).toEqual({ error: 'cross-site request refused' });
    expect((await send('DELETE', '/api/jobs/x', 'cross-site')).statusCode).toBe(403);
    const forged = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { token: adminToken },
      headers: { 'sec-fetch-site': 'cross-site' },
    });
    expect(forged.statusCode).toBe(403); // no signing someone in from another site either
    // Reads, the app's own requests and clients that send no Sec-Fetch-Site (scripts) pass.
    expect((await send('GET', '/api/specs', 'cross-site')).statusCode).toBe(200);
    expect((await send('GET', '/api/specs', 'same-origin')).statusCode).toBe(200);
    expect(
      (await send('POST', '/api/jobs/00000000-0000-4000-8000-000000000000/cancel', 'same-origin'))
        .statusCode,
    ).not.toBe(403);
    expect((await send('POST', '/api/auth/logout')).statusCode).toBe(204);
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

  it('lets admins issue named, expiring admin tokens that any admin can revoke', async () => {
    const { app, adminToken, access } = await setup();
    const warn = vi.spyOn(app.log, 'warn');
    const admin = (await login(app, adminToken)).cookie;
    const issue = (cookie: string, label: string, expiresInDays: number | null) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/tokens',
        headers: { cookie },
        payload: { label, expiresInDays, role: 'admin' },
      });

    const res = await issue(admin, 'Ops laptop', 90);
    expect(res.statusCode).toBe(200);
    const { token, record } = res.json();
    expect(record).toMatchObject({
      label: 'Ops laptop',
      role: 'admin',
      status: 'active',
      issuedBy: 'admin',
    });
    expect(warn).toHaveBeenCalledWith(
      { tokenId: record.id, label: 'Ops laptop', expiresAt: record.expiresAt, issuedBy: 'admin' },
      'admin token issued',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain(token);

    // Every admin is equal: an issued admin token can issue and revoke admin tokens too.
    const ops = (await login(app, token)).cookie;
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: ops } })).json()).toEqual({
      role: 'admin',
      label: 'Ops laptop',
      expiresAt: record.expiresAt,
    });
    const second = await issue(ops, 'CI', 7);
    expect(second.json().record).toMatchObject({ role: 'admin', issuedBy: 'Ops laptop' });
    const revoke = await app.inject({
      method: 'POST',
      url: `/api/auth/tokens/${second.json().record.id}/revoke`,
      headers: { cookie: ops },
    });
    expect(revoke.statusCode).toBe(204);

    const never = await issue(admin, 'forever', null);
    expect(never.statusCode).toBe(400);
    expect(never.json()).toEqual({ error: 'admin tokens must expire' });

    const user = (await access.createToken('user', 7)).token;
    expect((await issue((await login(app, user)).cookie, 'sneaky', 7)).statusCode).toBe(403);
  });

  it('records who issued a user token', async () => {
    const { app, adminToken } = await setup();
    const admin = (await login(app, adminToken)).cookie;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/tokens',
      headers: { cookie: admin },
      payload: { label: 'Phone', expiresInDays: 30 },
    });
    expect(res.json().record).toMatchObject({ role: 'user', issuedBy: 'admin' });
  });

  it.each([
    { label: '', expiresInDays: 7 },
    { label: 'x', expiresInDays: 3 },
    { label: 'x' },
    { label: 'x', expiresInDays: 7, role: 'owner' },
  ])('validates new tokens: %j', async (payload) => {
    const { app, adminToken } = await setup();
    const admin = (await login(app, adminToken)).cookie;
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/tokens',
      headers: { cookie: admin },
      payload,
    });
    expect(res.statusCode).toBe(400);
  });

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
