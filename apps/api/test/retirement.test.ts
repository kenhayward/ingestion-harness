import { describe, expect, it } from 'vitest';
import { accessApp, letter, testApp } from './helpers.js';

const retire = (id: string, cookie?: string) => ({
  method: 'PUT' as const,
  url: `/api/specs/${id}/retirement`,
  ...(cookie ? { headers: { cookie } } : {}),
});
const unretire = (id: string, cookie?: string) => ({
  method: 'DELETE' as const,
  url: `/api/specs/${id}/retirement`,
  ...(cookie ? { headers: { cookie } } : {}),
});

describe('PUT /api/specs/:id/retirement', () => {
  it('retires a recipe type, and a second retire keeps the first (D8)', async () => {
    const { app, templates } = await testApp();
    await templates.create('letter', 1, letter(1), 'published');
    const first = await app.inject(retire('letter'));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      id: 'letter',
      retired: { retiredAt: expect.any(String), retiredBy: null },
    });
    const again = await app.inject(retire('letter'));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
  });

  it('retires a file-only legacy spec type (D10)', async () => {
    const { app, templates } = await testApp();
    expect((await app.inject(retire('demo'))).statusCode).toBe(200);
    expect(await templates.retirement('demo')).not.toBeNull();
  });

  it('answers 404 for an unknown type, for both verbs', async () => {
    const { app } = await testApp();
    for (const req of [retire('nope'), unretire('nope')]) {
      const res = await app.inject(req);
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('document type not found');
    }
  });

  it('records the admin who retired it; users are refused', async () => {
    const { app, templates, adminCookie, userCookie } = await accessApp();
    await templates.create('letter', 1, letter(1), 'published');
    const user = await app.inject(retire('letter', userCookie));
    expect(user.statusCode).toBe(403);
    expect(user.json().error).toBe('admins only');
    expect((await app.inject(unretire('letter', userCookie))).statusCode).toBe(403);
    const me = (await app.inject({ url: '/api/auth/me', headers: { cookie: adminCookie } })).json();
    const res = await app.inject(retire('letter', adminCookie));
    expect(res.json().retired.retiredBy).toBe(me.label);
  });
});

describe('DELETE /api/specs/:id/retirement', () => {
  it('unretires, and answers 204 for a type that is not retired (D8)', async () => {
    const { app, templates } = await testApp();
    await templates.create('letter', 1, letter(1), 'published');
    await app.inject(retire('letter'));
    expect((await app.inject(unretire('letter'))).statusCode).toBe(204);
    expect(await templates.retirement('letter')).toBeNull();
    expect((await app.inject(unretire('letter'))).statusCode).toBe(204);
  });
});
