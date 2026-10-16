import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

const rename = (name: unknown, id = 'letter') => ({
  method: 'PUT' as const,
  url: `/api/templates/${id}/name`,
  payload: { name },
});

async function letterType() {
  const ctx = await testApp();
  await ctx.app.inject({
    method: 'POST',
    url: '/api/templates',
    payload: { id: 'letter', name: 'Letter' },
  });
  return ctx;
}

describe('PUT /api/templates/:id/name', () => {
  it('renames the open draft, logged as a hand change', async () => {
    const { app, templates } = await letterType();
    const res = await app.inject(rename('  Supplier letter '));
    expect(res.statusCode).toBe(200);
    expect(res.json().record).toMatchObject({ version: 1, status: 'draft' });
    expect(res.json().record.definition.name).toBe('Supplier letter');
    expect((await templates.get('letter', 1))!.definition.name).toBe('Supplier letter');
    const [newest] = await templates.listChanges('letter', 1);
    expect(newest).toMatchObject({
      source: 'hand',
      summary: 'Renamed “Letter” to “Supplier letter”',
    });
    const list = (await app.inject('/api/templates')).json() as { id: string; name: string }[];
    expect(list.find((t) => t.id === 'letter')!.name).toBe('Supplier letter');
  });

  it('starts a draft from the published version when none is open', async () => {
    const { app, templates } = await letterType();
    await templates.publish('letter', 1);
    const published = (await templates.get('letter', 1))!.definition;

    const res = await app.inject(rename('Supplier letter'));
    expect(res.statusCode).toBe(200);
    expect(res.json().record).toMatchObject({ version: 2, status: 'draft' });
    expect(res.json().record.definition).toEqual({
      ...published,
      version: 2,
      name: 'Supplier letter',
    });
    expect((await templates.get('letter', 1))!.definition).toEqual(published);
    expect((await templates.listChanges('letter', 2)).map((c) => c.source)).toEqual([
      'hand',
      'started',
    ]);
  });

  it('changes nothing when the name is the same', async () => {
    const { app, templates } = await letterType();
    await templates.publish('letter', 1);
    const res = await app.inject(rename('Letter'));
    expect(res.statusCode).toBe(200);
    expect(res.json().record).toMatchObject({ version: 1, status: 'published' });
    expect(await templates.get('letter', 2)).toBeNull();
  });

  it('renames the Workbench project too', async () => {
    const { app, workbench } = await testApp();
    await app.inject({
      method: 'POST',
      url: '/api/workbench/projects',
      payload: { id: 'letter', name: 'Letter' },
    });
    expect((await app.inject(rename('Supplier letter'))).statusCode).toBe(200);
    expect((await workbench.getProject('letter'))!.name).toBe('Supplier letter');
    const view = (await app.inject('/api/workbench/projects/letter')).json() as {
      project: { name: string };
    };
    expect(view.project.name).toBe('Supplier letter');
  });

  it('refuses a blank name, an unknown type and a retired one', async () => {
    const { app } = await letterType();
    expect((await app.inject(rename('   '))).statusCode).toBe(400);
    expect((await app.inject(rename(7))).statusCode).toBe(400);
    expect((await app.inject(rename('x'.repeat(201)))).statusCode).toBe(400);
    const missing = await app.inject(rename('Nope', 'nope'));
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'recipe not found' });
    await app.inject({ method: 'PUT', url: '/api/specs/letter/retirement' });
    const retired = await app.inject(rename('Supplier letter'));
    expect(retired.statusCode).toBe(409);
    expect(retired.json().error).toMatch(/is retired/);
  });
});
