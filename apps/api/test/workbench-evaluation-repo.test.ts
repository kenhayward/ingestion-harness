import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

const doc = (id: string, sha256: string) => ({
  id,
  filename: `${id}.pdf`,
  sha256,
  sizeBytes: 1,
  specId: 'letter',
  specVersion: 1,
  bucket: 'inbox',
  objectKey: `k/${id}`,
});

async function setup() {
  const ctx = await testApp();
  await ctx.workbench.createProject('letter', 'Letter');
  return ctx;
}

describe('evaluation persistence', () => {
  it('stores reference and model override on workbench jobs and lists runs with their sha', async () => {
    const { repo } = await setup();
    const plain = await repo.createWorkbenchJob(doc('d1', 'sha-a'), {
      projectId: 'letter',
      task: 'process',
    });
    const evaluation = await repo.createWorkbenchJob(doc('d2', 'sha-a'), {
      projectId: 'letter',
      task: 'process',
      referenceId: '00000000-0000-4000-8000-000000000001',
      modelOverride: 'draft',
    });
    expect(plain).toMatchObject({ referenceId: null, modelOverride: null });
    expect(evaluation).toMatchObject({
      referenceId: '00000000-0000-4000-8000-000000000001',
      modelOverride: 'draft',
    });
    const runs = await repo.listProjectRuns('letter');
    expect(runs.map((r) => [r.job.id, r.sha256])).toEqual([
      [evaluation.id, 'sha-a'],
      [plain.id, 'sha-a'],
    ]);
  });

  it('lists only process jobs as runs', async () => {
    const { repo } = await setup();
    await repo.createWorkbenchJob(doc('d1', 'sha-a'), { projectId: 'letter', task: 'prepare' });
    expect(await repo.listProjectRuns('letter')).toEqual([]);
  });

  it('keeps listing a run after review re-runs a step or approves it', async () => {
    const { repo } = await setup();
    const run = await repo.createWorkbenchJob(doc('d1', 'sha-a'), {
      projectId: 'letter',
      task: 'process',
    });
    for (const task of ['rerun', 'publish'] as const) {
      repo.jobs.set(run.id, { ...repo.jobs.get(run.id)!, task });
      expect((await repo.listProjectRuns('letter')).map((r) => r.job.id)).toEqual([run.id]);
    }
  });

  it('lists references with the sha of their document, newest first', async () => {
    const { repo } = await setup();
    const job = await repo.createWorkbenchJob(doc('d1', 'sha-b'), {
      projectId: 'letter',
      task: 'process',
    });
    const job2 = await repo.createWorkbenchJob(doc('d2', 'sha-c'), {
      projectId: 'letter',
      task: 'process',
    });
    for (const [name, j] of [
      ['first', job],
      ['second', job2],
    ] as const) {
      await repo.createReference({
        templateId: 'letter',
        name,
        documentId: j.documentId,
        sourceJobId: j.id,
        expected: { fields: {}, tables: {} },
      });
    }
    expect((await repo.listReferencesWithSha('letter')).map((r) => [r.name, r.sha256])).toEqual([
      ['second', 'sha-c'],
      ['first', 'sha-b'],
    ]);
  });

  it('records iterations and caches their scores', async () => {
    const { workbench } = await setup();
    const input = {
      projectId: 'letter',
      templateVersion: 1,
      definition: { id: 'letter', version: 1 },
      briefVersion: 2,
      set: 'dev' as const,
    };
    const a = await workbench.createIteration({
      ...input,
      model: null,
      jobIds: ['00000000-0000-4000-8000-000000000002'],
    });
    expect(a).toMatchObject({ scores: null, projectId: 'letter' });
    const b = await workbench.createIteration({ ...input, model: 'fast', jobIds: [] });
    expect((await workbench.listIterations('letter')).map((i) => i.id)).toEqual([b.id, a.id]);
    await workbench.setIterationScores(a.id, { score: 0.5, completed: 1, total: 1 });
    expect(await workbench.getIteration('letter', a.id)).toMatchObject({
      scores: { score: 0.5, completed: 1, total: 1 },
      definition: { id: 'letter', version: 1 },
    });
    expect(await workbench.getIteration('other', a.id)).toBeNull();
    expect(a.sampleShas).toBeNull();
    const c = await workbench.createIteration({
      ...input,
      model: null,
      jobIds: [],
      sampleShas: ['aa', 'bb'],
    });
    expect((await workbench.getIteration('letter', c.id))!.sampleShas).toEqual(['aa', 'bb']);
  });

  it('stores the publish gate cache of an iteration', async () => {
    const { workbench } = await setup();
    const i = await workbench.createIteration({
      projectId: 'letter',
      templateVersion: 1,
      definition: { id: 'letter', version: 1 },
      briefVersion: null,
      set: 'holdout',
      model: null,
      jobIds: [],
    });
    expect(i.gateCache).toBeNull();
    const hints = [
      { key: 'sent_on', accuracy: 0.5, cause: 'low_accuracy' as const, stage: 'revise' as const },
      { key: 'lines.qty', accuracy: 0, cause: 'no_step' as const, stage: 'steps' as const },
    ];
    const cache = {
      fingerprint: 'f'.repeat(64),
      score: 0.75,
      completed: 3,
      total: 4,
      hints,
      hintsThreshold: 0.9,
    };
    await workbench.setGateCache(i.id, cache);
    expect((await workbench.getIteration('letter', i.id))!.gateCache).toEqual(cache);
  });
});
