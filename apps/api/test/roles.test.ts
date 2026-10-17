import type { FastifyInstance } from 'fastify';
import { describe, expect, it } from 'vitest';
import { OPERATOR_REFUSED, operatorMayCall } from '@ih/shared';
import { accessApp, registeredRoutes, signInNewUser } from './helpers.js';

const routesOf = (app: FastifyInstance) =>
  registeredRoutes(app.printRoutes({ commonPrefix: false }))
    .filter((r) => r.path.startsWith('/api/'))
    .filter((r) => !['HEAD', 'OPTIONS'].includes(r.method));

const PUBLIC = new Set([
  // A restore's token or an admin session, checked by the routes themselves (backup.ts).
  'DELETE /api/backup/restores/:id',
  'GET /api/backup/restores/:id',
  'POST /api/backup/restores/:id/confirm',
  'GET /api/docs',
  'GET /api/docs/',
  'GET /api/docs/js/scalar.js',
  'GET /api/docs/openapi.json',
  'GET /api/docs/openapi.yaml',
  'GET /api/maintenance',
  'GET /api/profile/github/callback',
  'GET /api/version',
  'POST /api/auth/login',
  'POST /api/auth/logout',
]);

const ID = '00000000-0000-4000-8000-000000000000';

describe('user classes', () => {
  it('admins add operators and designers; designer is the default', async () => {
    const { app, adminCookie } = await accessApp();
    const add = (payload: object) =>
      app.inject({ method: 'POST', url: '/api/users', headers: { cookie: adminCookie }, payload });
    const operator = await add({ name: 'Olu', email: 'olu@example.test', role: 'operator' });
    expect(operator.statusCode).toBe(201);
    expect(operator.json().user.role).toBe('operator');
    const designer = await add({ name: 'Dee', email: 'dee@example.test' });
    expect(designer.json().user.role).toBe('designer');
    expect((await add({ name: 'U', email: 'u@example.test', role: 'user' })).statusCode).toBe(400);
  });

  it('operators are refused every guarded route outside their allow-list, and only those', async () => {
    const { app, access } = await accessApp();
    const { cookie } = await signInNewUser(app, access, 'Olu', 'operator');
    const wrong: string[] = [];
    for (const { method, path } of routesOf(app)) {
      const call = `${method} ${path}`;
      if (PUBLIC.has(call)) continue;
      const url = path.replace(/:[A-Za-z]+/g, ID);
      const res = await app.inject({ method: method as 'GET', url, headers: { cookie } });
      const refused = res.statusCode === 403 && res.json().error === OPERATOR_REFUSED;
      if (refused === operatorMayCall(method, path)) wrong.push(call);
    }
    expect(wrong).toEqual([]);
  });

  it('operators cannot re-run a step or reach the Workbench; designers can', async () => {
    const { app, access, userCookie } = await accessApp();
    const { cookie } = await signInNewUser(app, access, 'Olu', 'operator');
    const rerun = { method: 'POST' as const, url: `/api/jobs/${ID}/steps/head/rerun`, payload: {} };
    expect((await app.inject({ ...rerun, headers: { cookie } })).statusCode).toBe(403);
    expect((await app.inject({ ...rerun, headers: { cookie: userCookie } })).statusCode).not.toBe(
      403,
    );
    const wb = { url: '/api/workbench/projects' };
    expect((await app.inject({ ...wb, headers: { cookie } })).json()).toEqual({
      error: OPERATOR_REFUSED,
    });
    expect((await app.inject({ ...wb, headers: { cookie: userCookie } })).statusCode).toBe(200);
  });

  it('an admin cannot make themselves a designer or an operator', async () => {
    const { app, access } = await accessApp();
    const { cookie, user } = await signInNewUser(app, access, 'Ada', 'admin');
    for (const role of ['designer', 'operator']) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/users/${user.id}`,
        headers: { cookie },
        payload: { role },
      });
      expect(res.statusCode).toBe(409);
    }
  });
});
