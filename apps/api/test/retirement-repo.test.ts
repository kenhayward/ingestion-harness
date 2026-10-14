import { describe, expect, it } from 'vitest';
import { MemoryTemplateRepo } from '../src/templates/repo.js';
import { testApp } from './helpers.js';

describe('MemoryTemplateRepo retirements', () => {
  it('retires once, keeps the first retirement, and unretires', async () => {
    const repo = new MemoryTemplateRepo();
    expect(await repo.retirement('letter')).toBeNull();
    const first = await repo.retire('letter', 'ken');
    expect(first).toEqual({
      created: true,
      retirement: { retiredAt: expect.any(String), retiredBy: 'ken' },
    });
    const again = await repo.retire('letter', 'someone else');
    expect(again).toEqual({ created: false, retirement: first.retirement });
    expect([...(await repo.listRetirements())]).toEqual([['letter', first.retirement]]);
    expect(await repo.unretire('letter')).toBe(true);
    expect(await repo.unretire('letter')).toBe(false);
    expect(await repo.retirement('letter')).toBeNull();
  });

  it('is removed with a deleted never-published project (D11)', async () => {
    const { app, templates, workbench } = await testApp();
    await app.inject({
      method: 'POST',
      url: '/api/workbench/projects',
      payload: { id: 'letter', name: 'Letter' },
    });
    await templates.retire('letter', 'ken');
    expect(await workbench.deleteProject('letter')).not.toBeNull();
    expect(await templates.retirement('letter')).toBeNull();
  });

  it('keeps the retirement of a legacy type that still has its spec file (M1)', async () => {
    const { app, templates } = await testApp();
    await app.inject({
      method: 'POST',
      url: '/api/workbench/projects',
      payload: { id: 'demo', name: 'Demo' },
    });
    await templates.retire('demo', 'ken');
    const res = await app.inject({ method: 'DELETE', url: '/api/workbench/projects/demo' });
    expect(res.statusCode).toBe(204);
    expect(await templates.retirement('demo')).not.toBeNull();
  });
});
