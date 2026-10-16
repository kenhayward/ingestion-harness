import { describe, expect, it } from 'vitest';
import { MAINTENANCE_ERROR } from '@ih/shared';
import { MemoryMaintenanceRepo } from '../src/maintenance/repo.js';
import { TEST_PASSWORD, accessApp, signIn, signInNewUser } from './helpers.js';

async function setup() {
  const ctx = await accessApp({ maintenance: new MemoryMaintenanceRepo() });
  const set = (payload: object, cookie = ctx.adminCookie) =>
    ctx.app.inject({ method: 'PUT', url: '/api/maintenance', headers: { cookie }, payload });
  return { ...ctx, set };
}

describe('maintenance mode', () => {
  it('starts off, and anyone can read the notice before signing in', async () => {
    const { app } = await setup();
    const res = await app.inject('/api/maintenance');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: false, message: '', since: null });
  });

  it('an admin switches it on with a message; the notice and the admin view show it', async () => {
    const { app, set, adminCookie } = await setup();
    const on = await set({ enabled: true, message: '  Swapping models, back by 3pm  ' });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({
      enabled: true,
      message: 'Swapping models, back by 3pm',
      updatedBy: 'Admin',
    });
    expect(on.json().since).toEqual(expect.any(String));
    const notice = (await app.inject('/api/maintenance')).json();
    expect(notice).toEqual({
      enabled: true,
      message: 'Swapping models, back by 3pm',
      since: on.json().since,
    });
    const admin = await app.inject({
      url: '/api/maintenance/settings',
      headers: { cookie: adminCookie },
    });
    expect(admin.json()).toMatchObject({ enabled: true, updatedBy: 'Admin' });
  });

  it('keeps the time it was switched on while it stays on, clears it when off', async () => {
    const { set } = await setup();
    const first = (await set({ enabled: true, message: 'a' })).json();
    const edited = (await set({ enabled: true, message: 'b' })).json();
    expect(edited.since).toBe(first.since);
    const off = (await set({ enabled: false, message: 'b' })).json();
    expect(off).toMatchObject({ enabled: false, since: null, message: 'b' });
  });

  it('refuses users and malformed bodies', async () => {
    const { set, userCookie } = await setup();
    expect((await set({ enabled: true, message: '' }, userCookie)).statusCode).toBe(403);
    expect((await set({ enabled: 'yes', message: '' })).statusCode).toBe(400);
    expect((await set({ enabled: true, message: 'x'.repeat(1001) })).statusCode).toBe(400);
  });

  it('while on, users get 503 with the notice on every guarded route; admins carry on', async () => {
    const { app, set, userCookie, adminCookie } = await setup();
    await set({ enabled: true, message: 'Deploying' });
    const refused = await app.inject({ url: '/api/specs', headers: { cookie: userCookie } });
    expect(refused.statusCode).toBe(503);
    expect(refused.json()).toMatchObject({
      error: MAINTENANCE_ERROR,
      maintenance: { enabled: true, message: 'Deploying' },
    });
    const me = await app.inject({ url: '/api/auth/me', headers: { cookie: userCookie } });
    expect(me.statusCode).toBe(503);
    expect(
      (await app.inject({ url: '/api/specs', headers: { cookie: adminCookie } })).statusCode,
    ).toBe(200);
    // Switched off, the user's session works again: it was never ended.
    await set({ enabled: false, message: 'Deploying' });
    expect(
      (await app.inject({ url: '/api/specs', headers: { cookie: userCookie } })).statusCode,
    ).toBe(200);
  });

  it('while on, users cannot sign in (no session is left behind); admins can', async () => {
    const { app, set, access, adminPassword } = await setup();
    const { email } = await signInNewUser(app, access, 'Pat');
    await set({ enabled: true, message: 'Deploying' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: email, password: TEST_PASSWORD },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: MAINTENANCE_ERROR, maintenance: { enabled: true } });
    expect(String(res.headers['set-cookie'] ?? '')).not.toMatch(/ih_session=[^;]/);
    // A wrong password is still the usual 401: maintenance tells nobody which emails exist.
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { login: email, password: 'not the password' },
    });
    expect(wrong.statusCode).toBe(401);
    const admin = await signIn(app, 'admin', adminPassword);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: admin } })).statusCode).toBe(
      200,
    );
  });

  it('sign-out still works for users while on', async () => {
    const { app, set, userCookie } = await setup();
    await set({ enabled: true, message: '' });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: userCookie },
    });
    expect(res.statusCode).toBe(204);
  });
});
