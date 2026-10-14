import type { ProjectListPage } from '@ih/shared';
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

  it('removes a retirement that outlived its type, and frees the id (I1)', async () => {
    const { app, templates } = await testApp();
    await templates.create('memo', 1, { ...letter(1), id: 'memo', name: 'Memo' }, 'draft');
    expect((await app.inject(retire('memo'))).statusCode).toBe(200);
    expect(await templates.deleteDraft('memo', 1)).toBe(true);
    expect((await app.inject(unretire('memo'))).statusCode).toBe(204);
    expect(await templates.retirement('memo')).toBeNull();
    const created = await app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: { id: 'memo', name: 'Memo' },
    });
    expect(created.statusCode).not.toBe(409);
  });
});

describe('listings of a retired type', () => {
  async function retiredLetter() {
    const ctx = await testApp();
    await ctx.templates.create('letter', 1, letter(1), 'published');
    await ctx.templates.create('memo', 1, { ...letter(1), id: 'memo', name: 'Memo' }, 'published');
    await ctx.app.inject(retire('letter'));
    return ctx;
  }

  it('leaves it out of GET /api/specs unless retired=include (D2)', async () => {
    const { app } = await retiredLetter();
    const ids = (body: { id: string }[]) => [...new Set(body.map((s) => s.id))];
    const plain = (await app.inject('/api/specs')).json();
    expect(ids(plain)).not.toContain('letter');
    expect(ids(plain)).toContain('memo');
    const all = await app.inject('/api/specs?retired=include');
    expect(all.statusCode).toBe(200);
    const letterRow = all.json().find((s: { id: string }) => s.id === 'letter');
    expect(letterRow.retired).toEqual({ retiredAt: expect.any(String), retiredBy: null });
    expect(all.json().find((s: { id: string }) => s.id === 'memo').retired).toBeUndefined();
    expect((await app.inject('/api/specs?retired=yes')).statusCode).toBe(400);
  });

  it('lists legacy file-only types with kind spec until retired (the legacy cards, D16)', async () => {
    const { app } = await retiredLetter();
    const legacy = (body: { id: string; version: number; kind: string }[]) =>
      body.filter((s) => s.kind === 'spec').map((s) => `${s.id} v${s.version}`);
    expect(legacy((await app.inject('/api/specs')).json())).toEqual(['demo v1', 'demo v2']);
    await app.inject(retire('demo'));
    expect(legacy((await app.inject('/api/specs')).json())).toEqual([]);
    expect(legacy((await app.inject('/api/specs?retired=include')).json())).toEqual([
      'demo v1',
      'demo v2',
    ]);
  });

  it('still resolves the definition (reading is allowed)', async () => {
    const { app } = await retiredLetter();
    expect((await app.inject('/api/specs/letter')).statusCode).toBe(200);
  });

  it('marks it on GET /api/templates (D3)', async () => {
    const { app } = await retiredLetter();
    const list = (await app.inject('/api/templates')).json();
    expect(list.find((t: { id: string }) => t.id === 'letter').retired).toMatchObject({
      retiredBy: null,
    });
    expect(list.find((t: { id: string }) => t.id === 'memo').retired).toBeNull();
  });

  it('carries it on the project view and overview', async () => {
    const { app } = await testApp();
    await app.inject({
      method: 'POST',
      url: '/api/workbench/projects',
      payload: { id: 'letter', name: 'Letter' },
    });
    expect((await app.inject('/api/workbench/projects/letter')).json().retired).toBeNull();
    await app.inject(retire('letter'));
    expect((await app.inject('/api/workbench/projects/letter')).json().retired).toMatchObject({
      retiredBy: null,
    });
    expect(
      (await app.inject('/api/workbench/projects/letter/overview')).json().project.retired,
    ).not.toBeNull();
  });

  it('hides it from the Workbench list until asked for, live after a retire or unretire', async () => {
    const { app } = await testApp();
    for (const [id, name] of [
      ['letter', 'Letter'],
      ['memo', 'Memo'],
    ]) {
      await app.inject({ method: 'POST', url: '/api/workbench/projects', payload: { id, name } });
    }
    const list = async (qs = '') =>
      (await app.inject(`/api/workbench/projects${qs}`)).json() as ProjectListPage;
    expect((await list()).items.map((i) => i.id).sort()).toEqual(['letter', 'memo']);
    await app.inject(retire('letter'));
    expect((await list()).items.map((i) => i.id)).toEqual(['memo']);
    const all = await list('?retired=include');
    expect(all.items.find((i) => i.id === 'letter')?.retired).not.toBeNull();
    expect((await list('?ids=letter')).items.map((i) => i.id)).toEqual(['letter']);
    await app.inject(unretire('letter'));
    expect((await list()).items.map((i) => i.id).sort()).toEqual(['letter', 'memo']);
  });
});
