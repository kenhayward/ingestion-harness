import type { FastifyInstance } from 'fastify';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import type { z } from 'zod';
import { MemoryAccessRepo, type SignInEvent, type User } from '../src/access/repo.js';
import { SignInEventSchema, UserSchema } from '../src/access/users-routes.js';
import { TEST_PASSWORD, registeredRoutes, signInNewUser, testApp } from './helpers.js';

async function setup() {
  const access = new MemoryAccessRepo();
  const ctx = await testApp({ access });
  const adminPassword = await access.rotateAdminPassword();
  return { ...ctx, access, adminPassword };
}

const cookieOf = (res: { headers: Record<string, unknown> }) => {
  const raw = res.headers['set-cookie'];
  const header = Array.isArray(raw) ? raw[0] : String(raw ?? '');
  return { header, value: /ih_session=([^;]*)/.exec(header)?.[1] ?? '' };
};

async function login(
  app: FastifyInstance,
  loginName: string,
  password: string,
  headers: Record<string, string> = {},
) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { login: loginName, password },
    headers,
  });
  return { res, cookie: `ih_session=${cookieOf(res).value}` };
}

async function addUser(app: FastifyInstance, admin: string, body: object) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/users',
    headers: { cookie: admin },
    payload: body,
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { user: User; password: string };
}

const routesOf = (app: FastifyInstance) =>
  registeredRoutes(app.printRoutes({ commonPrefix: false }))
    .filter((r) => r.path.startsWith('/api/'))
    .filter((r) => !['HEAD', 'OPTIONS'].includes(r.method));

const PUBLIC = [
  // A restore ends every session: its token reads, confirms and cancels it (an admin too).
  'DELETE /api/backup/restores/:id',
  'GET /api/backup/restores/:id',
  'GET /api/docs',
  'GET /api/docs/',
  'GET /api/docs/js/scalar.js',
  'GET /api/docs/openapi.json',
  'GET /api/docs/openapi.yaml',
  // The sign-in page shows the maintenance notice before anyone signs in.
  'GET /api/maintenance',
  // GitHub's redirect brings no session cookie: the link's state finds the user.
  'GET /api/profile/github/callback',
  // Which build is running (ADR 0014): answered before signing in too.
  'GET /api/version',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/backup/restores/:id/confirm',
];

describe('email and password access', () => {
  it('requires a session for the API', async () => {
    const { app } = await setup();
    const res = await app.inject('/api/specs');
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'sign in required' });
  });

  it('guards every /api route except login, logout, the API docs, the maintenance notice, the version, the GitHub callback and the routes a restore token opens', async () => {
    const { app } = await setup();
    const routes = routesOf(app);
    expect(routes.length).toBeGreaterThan(20);
    const open: string[] = [];
    for (const { method, path } of routes) {
      const url = path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
      const res = await app.inject({ method: method as 'GET', url });
      // Login's own 401 (no body) is not the access hook's.
      const guarded = res.statusCode === 401 && res.json().error === 'sign in required';
      if (!guarded) open.push(`${method} ${path}`);
    }
    expect(open.sort()).toEqual(PUBLIC);
  });

  it('a restricted session is refused by every other /api route', async () => {
    const { app, access } = await setup();
    const created = await access.createUser(
      { name: 'Ken', email: 'ken@example.com', role: 'admin' },
      null,
    );
    if (typeof created === 'string') throw new Error(created);
    const { cookie } = await login(app, 'ken@example.com', created.password);
    const allowed: string[] = [];
    for (const { method, path } of routesOf(app)) {
      if (PUBLIC.includes(`${method} ${path}`)) continue;
      const url = path.replace(/:[A-Za-z]+/g, '00000000-0000-4000-8000-000000000000');
      const res = await app.inject({ method: method as 'GET', url, headers: { cookie } });
      const refused =
        res.statusCode === 403 && res.json().error === 'change your one-time password first';
      if (!refused) allowed.push(`${method} ${path}`);
    }
    expect(allowed.sort()).toEqual(['GET /api/auth/me', 'PUT /api/auth/password']);
  });

  it.each(['/api/docs/', '/api/docs/openapi.json', '/api/docs/js/scalar.js', '/api/%64ocs/'])(
    'serves %s without a session',
    async (url) => {
      const { app } = await setup();
      expect((await app.inject(url)).statusCode).toBe(200);
    },
  );

  it('signs the admin in as "admin" with the password from the log, in a strict cookie', async () => {
    const { app, adminPassword } = await setup();
    const { res, cookie } = await login(app, 'admin', adminPassword);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      userId: expect.any(String),
      role: 'admin',
      label: 'Admin',
      email: null,
      mustChangePassword: false,
      avatarUrl: null,
      failedSinceLastSignIn: 0,
      lastFailedAt: null,
    });
    const { header } = cookieOf(res);
    expect(header).toMatch(/HttpOnly/i);
    expect(header).toMatch(/SameSite=Strict/i);
    expect(header).toMatch(/Path=\//);
    expect(header).not.toMatch(/Secure/i);
    expect((await app.inject({ url: '/api/specs', headers: { cookie } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).json()).toEqual({
      userId: res.json().userId,
      role: 'admin',
      label: 'Admin',
      email: null,
      mustChangePassword: false,
      avatarUrl: null,
    });
  });

  it('the session cookie lasts 30 days (D10)', async () => {
    const { app, adminPassword } = await setup();
    const { res } = await login(app, 'admin', adminPassword);
    expect(cookieOf(res).header).toMatch(/Max-Age=2592000/);
  });

  it('keeps trusting the private proxies when TRUST_PROXY adds one', async () => {
    const access = new MemoryAccessRepo();
    const { app } = await testApp({ access, trustProxy: '203.0.113.10' });
    const adminPassword = await access.rotateAdminPassword();
    const { res } = await login(app, 'admin', adminPassword, { 'x-forwarded-proto': 'https' });
    expect(cookieOf(res).header).toMatch(/Secure/i); // inject() comes from 127.0.0.1
  });

  it('keeps the strict cookie when framing is allowed but the request is plain HTTP', async () => {
    const access = new MemoryAccessRepo();
    const { app } = await testApp({ access, frameAncestors: 'https://*.3dexperience.3ds.com' });
    const { res } = await login(app, 'admin', await access.rotateAdminPassword());
    expect(cookieOf(res).header).toMatch(/SameSite=Strict/i);
    expect(cookieOf(res).header).not.toMatch(/Partitioned/i);
  });

  it('sends the cookie into allowed frames over HTTPS: SameSite=None, Secure, Partitioned', async () => {
    const access = new MemoryAccessRepo();
    const { app } = await testApp({ access, frameAncestors: 'https://*.3dexperience.3ds.com' });
    const { res, cookie } = await login(app, 'admin', await access.rotateAdminPassword(), {
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
    const { app, adminPassword } = await setup();
    const { cookie } = await login(app, 'admin', adminPassword);
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
      payload: { login: 'admin', password: adminPassword },
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
    const { app, adminPassword } = await setup();
    const { res } = await login(app, 'admin', adminPassword, { 'x-forwarded-proto': 'https' });
    expect(cookieOf(res).header).toMatch(/Secure/i);
  });

  it.each([
    { login: 'admin', password: 'wrong' },
    { login: '', password: 'x' },
    { token: 'ih_x' },
    {},
  ])('rejects %j', async (payload) => {
    const { app } = await setup();
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'invalid email or password' });
  });

  it('answers the same 401 for an unknown email and a wrong password', async () => {
    const { app, adminPassword } = await setup();
    const { cookie } = await login(app, 'admin', adminPassword);
    await addUser(app, cookie, { name: 'Ken', email: 'ken@example.com' });
    const a = await login(app, 'nobody@example.com', 'whatever');
    const b = await login(app, 'ken@example.com', 'whatever');
    expect([a.res.statusCode, b.res.statusCode]).toEqual([401, 401]);
    expect(a.res.json()).toEqual(b.res.json());
    expect(a.res.json()).toEqual({ error: 'invalid email or password' });
  });

  it('a one-time-password session can only read me, change the password and sign out', async () => {
    const { app, adminPassword } = await setup();
    const admin = (await login(app, 'admin', adminPassword)).cookie;
    const { password } = await addUser(app, admin, { name: 'Ken', email: 'ken@example.com' });
    const { res, cookie } = await login(app, 'ken@example.com', password);
    expect(res.json()).toMatchObject({ mustChangePassword: true, label: 'Ken', role: 'designer' });
    expect((await app.inject({ url: '/api/specs', headers: { cookie } })).json()).toEqual({
      error: 'change your one-time password first',
    });
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(200);
    const weak = await app.inject({
      method: 'PUT',
      url: '/api/auth/password',
      headers: { cookie },
      payload: { currentPassword: password, newPassword: 'short' },
    });
    expect(weak.statusCode).toBe(400);
    expect(weak.json()).toEqual({ error: 'passwords need at least 12 characters' });
    const changed = await app.inject({
      method: 'PUT',
      url: '/api/auth/password',
      headers: { cookie },
      payload: { currentPassword: password, newPassword: 'a long new phrase' },
    });
    expect(changed.statusCode).toBe(204);
    expect((await app.inject({ url: '/api/specs', headers: { cookie } })).statusCode).toBe(200);
  });

  it('a wrong current password is a 400 and recorded', async () => {
    const { app, adminPassword } = await setup();
    const admin = (await login(app, 'admin', adminPassword)).cookie;
    const { user, password } = await addUser(app, admin, { name: 'Ken', email: 'ken@example.com' });
    const { cookie } = await login(app, 'ken@example.com', password);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/auth/password',
      headers: { cookie },
      payload: { currentPassword: 'not it', newPassword: 'a long new phrase' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({ error: 'the current password is wrong' });
    const [e] = (
      await app.inject({ url: `/api/sign-ins?userId=${user.id}`, headers: { cookie: admin } })
    ).json();
    expect(e).toMatchObject({ result: 'password-change-refused', failures: 1 });
  });

  it('the admin from the log cannot change its password', async () => {
    const { app, adminPassword } = await setup();
    const { cookie } = await login(app, 'admin', adminPassword);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/auth/password',
      headers: { cookie },
      payload: { currentPassword: adminPassword, newPassword: 'a long new phrase' },
    });
    expect(res.statusCode).toBe(409);
  });

  it('locks after 10 wrong passwords: 429 with the time, logged and recorded', async () => {
    const { app, adminPassword } = await setup();
    const warn = vi.spyOn(app.log, 'warn');
    const admin = (await login(app, 'admin', adminPassword)).cookie;
    const { user, password } = await addUser(app, admin, { name: 'Ken', email: 'ken@example.com' });
    // Distinct private addresses, so the per-IP limiter does not answer 429 first.
    for (let i = 0; i < 10; i++) {
      await login(app, 'ken@example.com', 'wrong', {
        'x-forwarded-for': `10.0.0.${i + 1}`,
        'user-agent': 'Guesser/1.0',
      });
    }
    const r = await login(app, 'ken@example.com', password, { 'x-forwarded-for': '10.0.1.1' });
    expect(r.res.statusCode).toBe(429);
    const body = r.res.json();
    expect(body.error).toMatch(
      /^too many failed sign-ins for this account: try again after \d{4}-/,
    );
    expect(Date.parse(body.lockedUntil)).toBeGreaterThan(Date.now() + 14 * 60_000);
    expect(warn).toHaveBeenCalledWith(
      { userId: user.id, failures: 10, lockedUntil: body.lockedUntil },
      'user locked',
    );
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/ken@example\.com|wrong/);
    const events = (
      await app.inject({ url: `/api/sign-ins?userId=${user.id}`, headers: { cookie: admin } })
    ).json();
    expect(events[0]).toMatchObject({ result: 'locked', ip: '10.0.1.1' });
    expect(events[1]).toMatchObject({
      result: 'wrong-password',
      failures: 10,
      lockedUntil: body.lockedUntil,
      userAgent: 'Guesser/1.0',
      ip: '10.0.0.10',
    });
    expect(events).toHaveLength(11);
  });

  it('a password-change attempt while locked is 429 and recorded as refused', async () => {
    const { app, adminPassword } = await setup();
    const admin = (await login(app, 'admin', adminPassword)).cookie;
    const { user, password } = await addUser(app, admin, { name: 'Ken', email: 'ken@example.com' });
    const { cookie } = await login(app, 'ken@example.com', password);
    for (let i = 0; i < 10; i++) {
      await login(app, 'ken@example.com', 'wrong', { 'x-forwarded-for': `10.0.4.${i + 1}` });
    }
    const res = await app.inject({
      method: 'PUT',
      url: '/api/auth/password',
      headers: { cookie },
      payload: { currentPassword: password, newPassword: 'a long new phrase' },
    });
    expect(res.statusCode).toBe(429);
    expect(res.json().lockedUntil).toEqual(expect.any(String));
    const [e] = (
      await app.inject({ url: `/api/sign-ins?userId=${user.id}`, headers: { cookie: admin } })
    ).json();
    expect(e).toMatchObject({ result: 'password-change-refused', failures: 10 });
  });

  it('records unknown logins without what was typed', async () => {
    const { app, adminPassword } = await setup();
    const admin = (await login(app, 'admin', adminPassword)).cookie;
    await login(app, 'someone@example.com', 'hunter2hunter2');
    const [e] = (
      await app.inject({ url: '/api/sign-ins?limit=1', headers: { cookie: admin } })
    ).json();
    expect(e).toMatchObject({ result: 'unknown-login', userId: null, name: null });
    expect(JSON.stringify(e)).not.toMatch(/someone|hunter2/);
  });

  it('a sign-in after failures says how many (D9)', async () => {
    const { app, adminPassword } = await setup();
    const admin = (await login(app, 'admin', adminPassword)).cookie;
    const { password } = await addUser(app, admin, { name: 'Ken', email: 'ken@example.com' });
    for (let i = 0; i < 3; i++) {
      await login(app, 'ken@example.com', 'wrong', { 'x-forwarded-for': `10.0.2.${i + 1}` });
    }
    const r = await login(app, 'ken@example.com', password, { 'x-forwarded-for': '10.0.3.1' });
    expect(r.res.json()).toMatchObject({
      failedSinceLastSignIn: 3,
      lastFailedAt: expect.any(String),
    });
    expect(
      (await app.inject({ url: '/api/auth/me', headers: { cookie: r.cookie } })).json(),
    ).not.toHaveProperty('failedSinceLastSignIn');
  });

  it('a disabled account with the right password gets 403', async () => {
    const { app, adminPassword } = await setup();
    const admin = (await login(app, 'admin', adminPassword)).cookie;
    const { user, password } = await addUser(app, admin, { name: 'Ken', email: 'ken@example.com' });
    const { cookie } = await login(app, 'ken@example.com', password);
    const off = await app.inject({
      method: 'POST',
      url: `/api/users/${user.id}/disable`,
      headers: { cookie: admin },
    });
    expect(off.json()).toMatchObject({ status: 'disabled', disabledBy: 'Admin' });
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
    const again = await login(app, 'ken@example.com', password);
    expect(again.res.statusCode).toBe(403);
    expect(again.res.json()).toEqual({ error: 'this account is disabled: ask an admin' });
    const on = await app.inject({
      method: 'POST',
      url: `/api/users/${user.id}/enable`,
      headers: { cookie: admin },
    });
    expect(on.json()).toMatchObject({ status: 'must-change' });
    expect((await login(app, 'ken@example.com', password)).res.statusCode).toBe(200);
  });

  it('a failing event write does not fail the sign-in', async () => {
    const { app, access, adminPassword } = await setup();
    const warn = vi.spyOn(app.log, 'warn');
    access.recordSignIn = vi.fn().mockRejectedValue(new Error('db down'));
    expect((await login(app, 'admin', adminPassword)).res.statusCode).toBe(200);
    expect(warn).toHaveBeenCalledWith(expect.anything(), 'sign-in event not recorded');
  });

  it('admins add, list, edit and reissue users; the one-time password is shown once', async () => {
    const { app, adminPassword } = await setup();
    const admin = (await login(app, 'admin', adminPassword)).cookie;
    const { user, password } = await addUser(app, admin, {
      name: ' Ken Hayward ',
      email: 'Ken@Example.com',
    });
    expect(password).toMatch(/^[a-z2-9]{4}(-[a-z2-9]{4}){3}$/);
    expect(user).toMatchObject({
      name: 'Ken Hayward',
      email: 'ken@example.com',
      role: 'designer',
      status: 'must-change',
      createdBy: 'Admin',
    });
    const list = (await app.inject({ url: '/api/users', headers: { cookie: admin } })).json();
    expect(list.map((u: User) => u.name)).toEqual(['Admin', 'Ken Hayward']);
    expect(JSON.stringify(list)).not.toContain(password);

    const dup = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: admin },
      payload: { name: 'Other', email: 'KEN@example.com' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toEqual({ error: 'a user with this email already exists' });

    const edited = await app.inject({
      method: 'PATCH',
      url: `/api/users/${user.id}`,
      headers: { cookie: admin },
      payload: { email: 'ken@new.example', role: 'admin' },
    });
    expect(edited.json()).toMatchObject({ email: 'ken@new.example', role: 'admin' });

    const re = await app.inject({
      method: 'POST',
      url: `/api/users/${user.id}/one-time-password`,
      headers: { cookie: admin },
    });
    expect(re.statusCode).toBe(200);
    expect(re.json().password).not.toBe(password);
    expect((await login(app, 'ken@new.example', re.json().password)).res.statusCode).toBe(200);
  });

  it.each([
    [{ name: '', email: 'a@example.com' }],
    [{ name: 'A', email: 'not an email' }],
    [{ name: 'A', email: 'a@example.com', role: 'owner' }],
    [{ name: 'x'.repeat(101), email: 'a@example.com' }],
  ])('validates new users: %j', async (payload) => {
    const { app, adminPassword } = await setup();
    const admin = (await login(app, 'admin', adminPassword)).cookie;
    const res = await app.inject({
      method: 'POST',
      url: '/api/users',
      headers: { cookie: admin },
      payload,
    });
    expect(res.statusCode).toBe(400);
  });

  it('the admin from the log cannot be changed; unknown ids are 404', async () => {
    const { app, adminPassword } = await setup();
    const admin = (await login(app, 'admin', adminPassword)).cookie;
    const [root] = (await app.inject({ url: '/api/users', headers: { cookie: admin } })).json();
    for (const [method, path] of [
      ['PATCH', ''],
      ['POST', '/enable'],
      ['POST', '/one-time-password'],
    ] as const) {
      const r = await app.inject({
        method,
        url: `/api/users/${root.id}${path}`,
        headers: { cookie: admin },
        ...(method === 'PATCH' ? { payload: { name: 'Root' } } : {}),
      });
      expect(r.statusCode).toBe(409);
    }
    const missing = await app.inject({
      method: 'POST',
      url: '/api/users/00000000-0000-4000-8000-000000000000/disable',
      headers: { cookie: admin },
    });
    expect(missing.statusCode).toBe(404);
    const bad = await app.inject({
      method: 'POST',
      url: '/api/users/not-a-uuid/enable',
      headers: { cookie: admin },
    });
    expect(bad.statusCode).toBe(404);
  });

  it('admins cannot disable or demote themselves', async () => {
    const { app, access } = await setup();
    const { cookie: ann, user } = await signInNewUser(app, access, 'Ann', 'admin');
    const disable = await app.inject({
      method: 'POST',
      url: `/api/users/${user.id}/disable`,
      headers: { cookie: ann },
    });
    expect(disable.statusCode).toBe(409);
    expect(disable.json()).toEqual({ error: 'you cannot disable yourself' });
    const demote = await app.inject({
      method: 'PATCH',
      url: `/api/users/${user.id}`,
      headers: { cookie: ann },
      payload: { role: 'designer' },
    });
    expect(demote.json()).toEqual({ error: 'you cannot remove your own admin role' });
    // Reissuing your own would sign you out before you could read the new password.
    const reissue = await app.inject({
      method: 'POST',
      url: `/api/users/${user.id}/one-time-password`,
      headers: { cookie: ann },
    });
    expect(reissue.statusCode).toBe(409);
    expect(reissue.json()).toEqual({
      error: 'you cannot reissue your own password: change it from the account menu',
    });
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: ann } })).statusCode).toBe(
      200,
    );
  });

  it('users get 403 on the user and sign-in routes; a bad limit is 400', async () => {
    const { app, access, adminPassword } = await setup();
    const { cookie: user } = await signInNewUser(app, access, 'Bob');
    for (const url of ['/api/users', '/api/sign-ins']) {
      expect((await app.inject({ url, headers: { cookie: user } })).statusCode).toBe(403);
    }
    const admin = (await login(app, 'admin', adminPassword)).cookie;
    for (const q of ['?limit=0', '?limit=201', '?userId=nope']) {
      expect(
        (await app.inject({ url: `/api/sign-ins${q}`, headers: { cookie: admin } })).statusCode,
      ).toBe(400);
    }
    expect(TEST_PASSWORD.length).toBeGreaterThanOrEqual(12);
  });

  it('the token routes are gone', async () => {
    const { app, adminPassword } = await setup();
    const { cookie } = await login(app, 'admin', adminPassword);
    expect((await app.inject({ url: '/api/auth/tokens', headers: { cookie } })).statusCode).toBe(
      404,
    );
  });

  it('signs out', async () => {
    const { app, adminPassword } = await setup();
    const { cookie } = await login(app, 'admin', adminPassword);
    const res = await app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie } });
    expect(res.statusCode).toBe(204);
    expect(cookieOf(res).header).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);
    expect((await app.inject({ url: '/api/specs', headers: { cookie } })).statusCode).toBe(401);
    // signing out without a session is harmless
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout' })).statusCode).toBe(204);
  });

  it('limits failed sign-ins per client IP (behind the proxies)', async () => {
    const { app, adminPassword } = await setup();
    const from = (ip: string, password: string) =>
      login(app, 'admin', password, { 'x-forwarded-for': ip });
    for (let i = 0; i < 10; i++) {
      expect((await from('203.0.113.5', 'wrong')).res.statusCode).toBe(401);
    }
    const blocked = await from('203.0.113.5', adminPassword);
    expect(blocked.res.statusCode).toBe(429);
    expect(blocked.res.json()).toEqual({ error: 'too many attempts, try again later' });
    expect((await from('203.0.113.6', adminPassword)).res.statusCode).toBe(200);
  });

  it('counts a parallel burst against the per-IP limit before any attempt finishes', async () => {
    const { app, access } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = access.login.bind(access);
    const login = vi.fn(async (l: string, p: string) => {
      await gate;
      return real(l, p);
    });
    access.login = login;
    const burst = Array.from({ length: 12 }, () =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { login: 'a@example.com', password: 'guess' },
        headers: { 'x-forwarded-for': '203.0.113.77' },
      }),
    );
    await vi.waitFor(() => expect(login).toHaveBeenCalledTimes(8)); // the global cap
    release();
    const codes = (await Promise.all(burst)).map((r) => r.statusCode).sort();
    expect(login).toHaveBeenCalledTimes(8);
    expect(codes.filter((c) => c === 401)).toHaveLength(8);
    expect(codes.filter((c) => c !== 401).every((c) => c === 429 || c === 503)).toBe(true);
  });

  it('answers 503 when too many sign-ins are being checked at once', async () => {
    const { app, access } = await setup();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const real = access.login.bind(access);
    access.login = vi.fn(async (l: string, p: string) => {
      await gate;
      return real(l, p);
    });
    const send = (i: number) =>
      app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { login: 'a@example.com', password: 'guess' },
        headers: { 'x-forwarded-for': `203.0.113.${100 + i}` },
      });
    const held = Array.from({ length: 8 }, (_, i) => send(i));
    await vi.waitFor(() => expect(access.login).toHaveBeenCalledTimes(8));
    const busy = await send(50);
    expect(busy.statusCode).toBe(503);
    expect(busy.json()).toEqual({ error: 'too many sign-ins at once, try again in a moment' });
    release();
    await Promise.all(held);
  });

  it('leaves health checks public', async () => {
    const { app } = await setup();
    expect((await app.inject('/healthz')).statusCode).toBe(200);
  });
});

describe('access path handling', () => {
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

describe('user docs', () => {
  it('describe the User and SignInEvent types exactly', () => {
    expectTypeOf<z.infer<typeof UserSchema>>().toEqualTypeOf<User>();
    expectTypeOf<z.infer<typeof SignInEventSchema>>().toEqualTypeOf<SignInEvent>();
  });
});
