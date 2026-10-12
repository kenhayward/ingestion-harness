import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

async function setup() {
  const ctx = await testApp();
  await ctx.workbench.createProject('letter', 'Letter');
  return ctx;
}

describe('stage persistence', () => {
  it('stores the draft a proposal was made against and the changes accepted', async () => {
    const { repo, workbench } = await setup();
    const job = await repo.createDraftJob('letter', {});
    const base = { id: 'letter', version: 1, outputs: { fields: [] } };
    await workbench.createProposal({
      id: job.id,
      projectId: 'letter',
      stage: 'outputs',
      briefVersion: null,
      baseVersion: 1,
      baseDefinition: base,
    });
    const decided = await workbench.decideProposal('letter', job.id, 'partially_accepted', [0, 2]);
    expect(decided).toMatchObject({
      decision: 'partially_accepted',
      acceptedChanges: [0, 2],
      baseVersion: 1,
      baseDefinition: base,
    });
    expect(await workbench.decideProposal('letter', job.id, 'rejected')).toBeNull();
  });

  it('defaults the new fields for survey proposals', async () => {
    const { repo, workbench } = await setup();
    const job = await repo.createDraftJob('letter', {});
    const p = await workbench.createProposal({
      id: job.id,
      projectId: 'letter',
      stage: 'survey',
      briefVersion: 1,
    });
    expect(p).toMatchObject({ acceptedChanges: null, baseVersion: null, baseDefinition: null });
    expect(await workbench.decideProposal('letter', job.id, 'accepted')).toMatchObject({
      acceptedChanges: null,
    });
  });

  it('records skips newest first with strictly increasing times', async () => {
    const { workbench } = await setup();
    const a = await workbench.addSkip('letter', 'survey');
    const b = await workbench.addSkip('letter', 'outputs');
    expect(b.skippedAt > a.skippedAt).toBe(true);
    expect((await workbench.listSkips('letter')).map((s) => s.stage)).toEqual([
      'outputs',
      'survey',
    ]);
    expect(await workbench.listSkips('other')).toEqual([]);
  });
});
