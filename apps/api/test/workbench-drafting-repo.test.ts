import { describe, expect, it } from 'vitest';
import { WORKBENCH_PRIORITY } from '../src/repositories/types.js';
import { testApp } from './helpers.js';

async function setup() {
  const ctx = await testApp();
  await ctx.workbench.createProject('letter', 'Letter');
  return ctx;
}

describe('drafting persistence', () => {
  it('defaults projects to local-only and records who allows external models', async () => {
    const { workbench } = await setup();
    expect(await workbench.getProject('letter')).toMatchObject({
      dataPolicy: 'local',
      dataPolicyChangedAt: null,
      dataPolicyChangedBy: null,
    });
    const changed = await workbench.setDataPolicy('letter', 'external', 'admin');
    expect(changed).toMatchObject({ dataPolicy: 'external', dataPolicyChangedBy: 'admin' });
    expect(changed?.dataPolicyChangedAt).not.toBeNull();
    expect(await workbench.setDataPolicy('nope', 'external', 'admin')).toBeNull();
  });

  it('queues draft jobs without pruning earlier ones, and keeps them out of job lists', async () => {
    const { app, repo } = await setup();
    const first = await repo.createDraftJob('letter', { stage: 'survey' });
    const second = await repo.createDraftJob('letter', { stage: 'survey' });
    expect((await repo.listDraftJobs('letter')).map((j) => j.id)).toEqual([second.id, first.id]);
    expect(repo.draftJobs.get(first.id)?.params).toEqual({ stage: 'survey' });
    expect((await app.inject('/api/jobs')).json()).toEqual([]);
    expect(await repo.getJob(first.id)).toBeNull();
  });

  it('stores params on workbench jobs', async () => {
    const { repo } = await setup();
    const job = await repo.createWorkbenchJob(
      {
        id: 'd1',
        filename: 'a.pdf',
        sha256: 'x',
        sizeBytes: 1,
        specId: 'letter',
        specVersion: 1,
        bucket: 'inbox',
        objectKey: 'k',
      },
      { projectId: 'letter', task: 'prepare', params: { dataPolicy: 'local' } },
    );
    expect(repo.jobParams.get(job.id)).toEqual({ dataPolicy: 'local' });
    expect(repo.priorities.get(job.id)).toBe(WORKBENCH_PRIORITY);
  });

  it('records proposals and one decision each', async () => {
    const { repo, workbench } = await setup();
    const job = await repo.createDraftJob('letter', {});
    await workbench.createProposal({
      id: job.id,
      projectId: 'letter',
      stage: 'survey',
      briefVersion: 2,
    });
    expect(await workbench.listProposals('letter')).toEqual([
      expect.objectContaining({ id: job.id, stage: 'survey', briefVersion: 2, decision: null }),
    ]);
    expect(await workbench.decideProposal('letter', job.id, 'accepted')).toMatchObject({
      decision: 'accepted',
    });
    expect(await workbench.decideProposal('letter', job.id, 'rejected')).toBeNull();
    expect(await workbench.decideProposal('other', job.id, 'accepted')).toBeNull();
  });
});
