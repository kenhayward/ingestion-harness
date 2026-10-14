import { describe, expect, it } from 'vitest';
import { letter, testApp } from './helpers.js';

const post = (url: string, payload: object) => ({ method: 'POST' as const, url, payload });

describe('workbench projects', () => {
  it('creates a project and a v1 draft for a new document type', async () => {
    const { app, templates } = await testApp();
    const res = await app.inject(post('/api/workbench/projects', { id: 'letter', name: 'Letter' }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({
      project: { id: 'letter', name: 'Letter' },
      draft: 1,
      published: null,
      brief: null,
    });
    expect((await templates.get('letter', 1))?.status).toBe('draft');
    expect((await app.inject('/api/workbench/projects?all=1')).json()).toEqual([
      expect.objectContaining({ id: 'letter', draft: 1, published: null, samples: 0 }),
    ]);
    expect(
      (await app.inject(post('/api/workbench/projects', { id: 'letter', name: 'x' }))).statusCode,
    ).toBe(409);
  });

  it('needs a name for a new type and a valid id', async () => {
    const { app } = await testApp();
    const unnamed = await app.inject(post('/api/workbench/projects', { id: 'memo' }));
    expect(unnamed.statusCode).toBe(400);
    // Said for the New project dialog, whose Name may be left empty to open an existing type.
    expect(unnamed.json().error).toBe(
      'there is no document type memo yet: give it a name to create it',
    );
    expect(
      (await app.inject(post('/api/workbench/projects', { id: 'Bad Id', name: 'x' }))).statusCode,
    ).toBe(400);
  });

  it('opens a published type by starting its next draft', async () => {
    const { app, templates } = await testApp();
    await templates.create('letter', 1, letter(1), 'published');
    const res = await app.inject(post('/api/workbench/projects', { id: 'letter' }));
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ project: { name: 'Letter' }, draft: 2, published: 1 });
    expect((await templates.get('letter', 2))?.definition).toMatchObject({ version: 2 });
  });

  it('reuses an open draft', async () => {
    const { app, templates } = await testApp();
    await templates.create('letter', 1, letter(1), 'published');
    await templates.create('letter', 2, letter(2), 'draft');
    const res = await app.inject(post('/api/workbench/projects', { id: 'letter' }));
    expect(res.json()).toMatchObject({ draft: 2, published: 1 });
    expect(await templates.get('letter', 3)).toBeNull();
  });

  it('404s an unknown project', async () => {
    const { app } = await testApp();
    expect((await app.inject('/api/workbench/projects/nope')).statusCode).toBe(404);
  });
});
