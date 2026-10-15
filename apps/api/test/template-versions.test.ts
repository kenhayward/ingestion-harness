import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

/** A minimal valid template definition. */
const definition = (name = 'Letter', field = 'sender') => ({
  id: 'letter',
  version: 1,
  name,
  document: { sections: [{ id: 'all', anchor: '\\A' }] },
  outputs: { fields: [{ id: field, type: 'text' }] },
  pipeline: [{ type: 'extract', id: 'head', fields: [field], sections: ['all'] }],
});

type Ctx = Awaited<ReturnType<typeof testApp>>;
const send = (ctx: Ctx, method: 'POST' | 'PUT' | 'PATCH', url: string, payload: object = {}) =>
  ctx.app.inject({ method, url, payload });

/** letter v1 published, v2 an open draft. */
async function twoVersions(ctx: Ctx) {
  await send(ctx, 'POST', '/api/templates', { id: 'letter', name: 'Letter' });
  await send(ctx, 'PUT', '/api/templates/letter/versions/1', { definition: definition() });
  await send(ctx, 'POST', '/api/templates/letter/versions/1/publish');
  await send(ctx, 'POST', '/api/templates/letter/drafts', {});
}

describe('version labels (#144)', () => {
  it('labels a published version and a draft without touching the draft', async () => {
    const ctx = await testApp();
    await twoVersions(ctx);
    const before = (await ctx.app.inject({ url: '/api/templates/letter/versions/2' })).json();

    const published = await send(ctx, 'PATCH', '/api/templates/letter/versions/1', {
      label: '  First cut  ',
      note: 'Handles single-page letters only.',
    });
    expect(published.statusCode).toBe(200);
    expect(published.json().record).toMatchObject({
      version: 1,
      status: 'published',
      label: 'First cut',
      note: 'Handles single-page letters only.',
      labelSetBy: null,
    });
    expect(published.json().record.labelSetAt).toBeTruthy();

    const draft = await send(ctx, 'PATCH', '/api/templates/letter/versions/2', {
      label: 'Two-page letters',
    });
    expect(draft.json().record).toMatchObject({ label: 'Two-page letters', note: null });
    // A label is not an edit: the editor's baseUpdatedAt still matches, and nothing is logged.
    expect(draft.json().record.updatedAt).toBe(before.record.updatedAt);
    expect(draft.json().record.definition).toEqual(before.record.definition);
    expect(await ctx.templates.listChanges('letter', 2)).toHaveLength(1); // only "started"

    const saved = await send(ctx, 'PUT', '/api/templates/letter/versions/2', {
      definition: definition('Letter 2'),
      baseUpdatedAt: before.record.updatedAt,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().record.label).toBe('Two-page letters'); // a save keeps the label
  });

  it('keeps a field left out, clears one sent as null, and refuses bad bodies', async () => {
    const ctx = await testApp();
    await twoVersions(ctx);
    const url = '/api/templates/letter/versions/1';
    await send(ctx, 'PATCH', url, { label: 'First', note: 'A note' });
    const kept = await send(ctx, 'PATCH', url, { note: null });
    expect(kept.json().record).toMatchObject({ label: 'First', note: null });

    for (const body of [
      {},
      { label: '   ' },
      { label: 'x'.repeat(81) },
      { note: 'x'.repeat(2001) },
      { label: 'ok', definition: {} },
    ]) {
      expect((await send(ctx, 'PATCH', url, body)).statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(
      (await send(ctx, 'PATCH', '/api/templates/letter/versions/9', { label: 'x' })).statusCode,
    ).toBe(404);
    expect(
      (await send(ctx, 'PATCH', '/api/templates/nope/versions/1', { label: 'x' })).statusCode,
    ).toBe(404);
  });

  it('labels the versions of a retired type (no job is queued)', async () => {
    const ctx = await testApp();
    await twoVersions(ctx);
    await ctx.templates.retire('letter', 'Admin');
    const res = await send(ctx, 'PATCH', '/api/templates/letter/versions/1', { label: 'Old' });
    expect(res.statusCode).toBe(200);
  });

  it('lists the versions newest first with their labels', async () => {
    const ctx = await testApp();
    await twoVersions(ctx);
    await send(ctx, 'PATCH', '/api/templates/letter/versions/1', { label: 'First cut' });
    const res = await ctx.app.inject({ url: '/api/templates/letter/versions' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject([
      { version: 2, status: 'draft', label: null, publishedAt: null },
      { version: 1, status: 'published', label: 'First cut' },
    ]);
    expect(res.json()[1].publishedAt).toBeTruthy();
    expect(res.json()[0]).not.toHaveProperty('definition');
    expect((await ctx.app.inject({ url: '/api/templates/nope/versions' })).statusCode).toBe(404);

    const types = (await ctx.app.inject({ url: '/api/templates' })).json();
    expect(types[0].versions).toMatchObject([
      { version: 1, label: 'First cut' },
      { version: 2, label: null },
    ]);
  });

  it('publishing sets the label and note given, else keeps the draft’s', async () => {
    const ctx = await testApp();
    await twoVersions(ctx);
    await send(ctx, 'PATCH', '/api/templates/letter/versions/2', { label: 'Draft label' });
    await send(ctx, 'PUT', '/api/templates/letter/versions/2', { definition: definition() });
    const kept = await send(ctx, 'POST', '/api/templates/letter/versions/2/publish');
    expect(kept.json().record).toMatchObject({ status: 'published', label: 'Draft label' });

    await send(ctx, 'POST', '/api/templates/letter/drafts', {});
    const set = await send(ctx, 'POST', '/api/templates/letter/versions/3/publish', {
      label: 'Release',
      note: 'Shipped to staging',
    });
    expect(set.json().record).toMatchObject({ label: 'Release', note: 'Shipped to staging' });
    await send(ctx, 'POST', '/api/templates/letter/drafts', {});
    expect(
      (await send(ctx, 'POST', '/api/templates/letter/versions/4/publish', { label: '' }))
        .statusCode,
    ).toBe(400);
  });

  it('names the label of the version a new draft starts from, and leaves the draft unlabelled', async () => {
    const ctx = await testApp();
    await twoVersions(ctx);
    await ctx.app.inject({ method: 'DELETE', url: '/api/templates/letter/versions/2' });
    await send(ctx, 'PATCH', '/api/templates/letter/versions/1', { label: 'First cut' });
    const draft = await send(ctx, 'POST', '/api/templates/letter/drafts', { from: 1 });
    expect(draft.json().record).toMatchObject({ version: 2, label: null });
    const [started] = await ctx.templates.listChanges('letter', 2);
    expect(started!.summary).toBe('Draft v2 created from published v1 (First cut)');
  });
});

describe('replace the draft with an earlier version (#144)', () => {
  it('writes the version into the open draft as a restore', async () => {
    const ctx = await testApp();
    await twoVersions(ctx);
    await send(ctx, 'PUT', '/api/templates/letter/versions/2', {
      definition: definition('Letter', 'recipient'),
    });
    await send(ctx, 'PATCH', '/api/templates/letter/versions/1', { label: 'First cut' });
    const res = await send(ctx, 'POST', '/api/templates/letter/versions/2/restore', { from: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().record.definition).toEqual({ ...definition(), version: 2 });
    const [restore] = await ctx.templates.listChanges('letter', 2);
    expect(restore).toMatchObject({ source: 'restore' });
    expect(restore!.summary).toContain('(from v1 · First cut)');
  });

  it('refuses a stale base, a published target, an unknown source and itself', async () => {
    const ctx = await testApp();
    await twoVersions(ctx);
    const url = '/api/templates/letter/versions/2/restore';
    const stale = await send(ctx, 'POST', url, {
      from: 1,
      baseUpdatedAt: '2000-01-01T00:00:00.000Z',
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe(
      'the draft changed since you opened it; reload it to see the changes',
    );
    expect((await send(ctx, 'POST', url, { from: 9 })).statusCode).toBe(404);
    expect((await send(ctx, 'POST', url, { from: 2 })).statusCode).toBe(400);
    expect((await send(ctx, 'POST', url, {})).statusCode).toBe(400);
    const published = await send(ctx, 'POST', '/api/templates/letter/versions/1/restore', {
      from: 2,
    });
    expect(published.statusCode).toBe(409);
    expect(published.json().error).toBe('letter v1 is not an open draft');
    // Restoring the same content logs nothing.
    await send(ctx, 'POST', url, { from: 1 });
    expect(await ctx.templates.listChanges('letter', 2)).toHaveLength(1);
  });
});
