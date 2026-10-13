import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Brief, BriefVersionView } from '@ih/shared';
import { testApp } from './helpers.js';

async function withBriefs() {
  const ctx = await testApp();
  await ctx.workbench.createProject('letter', 'Letter');
  const save = (payload: Record<string, unknown>) =>
    ctx.app.inject({ method: 'PUT', url: '/api/workbench/projects/letter/brief', payload });
  return { ...ctx, save };
}

describe('brief versions', () => {
  it('lists versions newest first with what changed and which stages use them', async () => {
    const { app, workbench, save } = await withBriefs();
    expect((await app.inject('/api/workbench/projects/letter/briefs')).json()).toEqual([]);
    await save({ purpose: 'Letters' });
    await save({ purpose: 'Letters', glossary: 'PO: purchase order' });
    await save({
      purpose: 'Letters',
      glossary: 'PO: purchase order',
      variants: 'two',
      rules: 'DMY',
    });
    const applied = await workbench.createProposal({
      id: randomUUID(),
      projectId: 'letter',
      stage: 'outputs',
      briefVersion: 2,
    });
    await workbench.decideProposal('letter', applied.id, 'accepted');
    // Undecided: drafted from v3, but nothing of it is in the draft.
    await workbench.createProposal({
      id: randomUUID(),
      projectId: 'letter',
      stage: 'steps',
      briefVersion: 3,
    });

    const res = await app.inject('/api/workbench/projects/letter/briefs');
    expect(res.statusCode).toBe(200);
    const versions = res.json() as BriefVersionView[];
    expect(versions.map(({ createdAt: _at, ...v }) => v)).toEqual([
      { version: 3, changedSections: ['variants', 'rules'], usedBy: [] },
      { version: 2, changedSections: ['glossary'], usedBy: ['outputs'] },
      { version: 1, changedSections: ['purpose'], usedBy: [] },
    ]);
    expect(versions.every((v) => typeof v.createdAt === 'string')).toBe(true);
  });

  it('reads one version', async () => {
    const { app, save } = await withBriefs();
    await save({ purpose: 'Letters' });
    await save({ purpose: 'Memos' });
    const res = await app.inject('/api/workbench/projects/letter/briefs/1');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      projectId: 'letter',
      version: 1,
      body: { purpose: 'Letters' },
    });
    const latest = (await app.inject('/api/workbench/projects/letter/briefs/2')).json() as Brief;
    expect(latest.body.purpose).toBe('Memos');
  });

  it.each([
    ['/api/workbench/projects/letter/briefs/3', 'brief version not found'],
    ['/api/workbench/projects/letter/briefs/0', 'brief version not found'],
    ['/api/workbench/projects/letter/briefs/latest', 'brief version not found'],
    ['/api/workbench/projects/nope/briefs/1', 'project not found'],
    ['/api/workbench/projects/nope/briefs', 'project not found'],
  ])('%s is a 404 (%s)', async (url, error) => {
    const { app, save } = await withBriefs();
    await save({ purpose: 'Letters' });
    const res = await app.inject(url);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error });
  });
});
