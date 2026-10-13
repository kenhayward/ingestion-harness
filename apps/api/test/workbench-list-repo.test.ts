import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EMPTY_BRIEF } from '@ih/shared';
import type { NewDocument } from '../src/repositories/types.js';
import { testApp } from './helpers.js';

const doc = (projectId: string): NewDocument => {
  const id = randomUUID();
  return {
    id,
    filename: `${id}.pdf`,
    sha256: id.replaceAll('-', '').padEnd(64, '0'),
    sizeBytes: 10,
    specId: projectId,
    specVersion: 1,
    bucket: 'inbox',
    objectKey: `${id}.pdf`,
  };
};

async function setup() {
  const ctx = await testApp();
  await ctx.workbench.createProject('alpha', 'Alpha');
  await ctx.workbench.createProject('beta', 'Beta');
  await ctx.templates.create('alpha', 1, { outputs: { fields: [] } }, 'draft');
  const prepare = await ctx.repo.createWorkbenchJob(doc('alpha'), {
    projectId: 'alpha',
    task: 'prepare',
  });
  const sample = await ctx.workbench.addSample({
    projectId: 'alpha',
    documentId: prepare.documentId!,
    role: 'dev',
    addedForVersion: 1,
  });
  const draft = await ctx.repo.createDraftJob('alpha', { stage: 'survey' });
  const fingerprint = async (id = 'alpha') =>
    (await ctx.workbench.projectFingerprints()).find((f) => f.id === id)!;
  return { ...ctx, prepare, sample, draft, fingerprint };
}

describe('MemoryWorkbenchRepo project list support', () => {
  it('fingerprints every project and is stable while nothing changes', async () => {
    const { workbench, fingerprint } = await setup();
    const all = await workbench.projectFingerprints();
    expect(all.map((f) => f.id).sort()).toEqual(['alpha', 'beta']);
    expect(all.every((f) => typeof f.fingerprint === 'string' && f.fingerprint.length > 0)).toBe(
      true,
    );
    expect(all[0]!.fingerprint).not.toBe(all[1]!.fingerprint);
    expect(await fingerprint()).toEqual(await fingerprint());
  });

  // One row per input the project overview reads: each must move the fingerprint.
  const changes: [string, (ctx: Awaited<ReturnType<typeof setup>>) => Promise<unknown>][] = [
    [
      'adding a sample',
      async ({ repo, workbench }) => {
        const job = await repo.createWorkbenchJob(doc('alpha'), {
          projectId: 'alpha',
          task: 'prepare',
        });
        // Only the sample row: the job alone already moves it.
        repo.jobs.delete(job.id);
        await workbench.addSample({
          projectId: 'alpha',
          documentId: job.documentId!,
          role: 'dev',
          addedForVersion: 1,
        });
      },
    ],
    [
      'switching a sample role',
      ({ workbench, sample }) => workbench.setSampleRole('alpha', sample.id, 'holdout'),
    ],
    ['removing a sample', ({ workbench, sample }) => workbench.removeSample('alpha', sample.id)],
    [
      'a job status change',
      async ({ repo, prepare }) => {
        repo.jobs.set(prepare.id, { ...repo.jobs.get(prepare.id)!, status: 'succeeded' });
      },
    ],
    [
      'a draft job status change',
      async ({ repo, draft }) => {
        repo.draftJobs.set(draft.id, { ...repo.draftJobs.get(draft.id)!, status: 'running' });
      },
    ],
    ['saving a brief', ({ workbench }) => workbench.saveBrief('alpha', EMPTY_BRIEF)],
    [
      'a template draft edit',
      ({ templates }) => templates.updateDraft('alpha', 1, { outputs: { fields: [{ id: 'x' }] } }),
    ],
    ['a threshold change', ({ workbench }) => workbench.setPublishThreshold('alpha', 0.8, 'me')],
    ['a data policy change', ({ workbench }) => workbench.setDataPolicy('alpha', 'external', 'me')],
    ['skipping a stage', ({ workbench }) => workbench.addSkip('alpha', 'survey')],
    [
      'keeping a stale stage',
      ({ workbench }) => workbench.addConfirm('alpha', 'sections', '2026-10-13T09:00:00.000Z'),
    ],
    [
      'recording a publication',
      ({ workbench }) =>
        workbench.recordPublication({
          projectId: 'alpha',
          version: 1,
          iterationId: null,
          score: null,
          threshold: 0.9,
          overrideReason: null,
          publishedBy: null,
        }),
    ],
    [
      'adding feedback',
      ({ workbench }) =>
        workbench.createFeedback({
          projectId: 'alpha',
          target: 'field',
          targetId: 'x',
          sampleId: null,
          iterationId: null,
          body: 'wrong',
        }),
    ],
    [
      'saving a reference',
      ({ repo, prepare }) =>
        repo.createReference({
          templateId: 'alpha',
          name: 'a',
          documentId: prepare.documentId!,
          sourceJobId: prepare.id,
          expected: { fields: {}, tables: {} },
        }),
    ],
  ];

  it.each(changes)('changes the fingerprint after %s', async (_name, change) => {
    const ctx = await setup();
    const before = await ctx.fingerprint();
    const other = await ctx.fingerprint('beta');
    await change(ctx);
    expect((await ctx.fingerprint()).fingerprint).not.toBe(before.fingerprint);
    expect(await ctx.fingerprint('beta')).toEqual(other);
  });

  it('changes the fingerprint when a proposal is made, decided, and an iteration scored', async () => {
    const ctx = await setup();
    const { workbench, repo, fingerprint } = ctx;
    const prints = [(await fingerprint()).fingerprint];
    const job = await repo.createDraftJob('alpha', { stage: 'survey' });
    await workbench.createProposal({
      id: job.id,
      projectId: 'alpha',
      stage: 'survey',
      briefVersion: null,
    });
    prints.push((await fingerprint()).fingerprint);
    await workbench.decideProposal('alpha', job.id, 'accepted');
    prints.push((await fingerprint()).fingerprint);
    const iteration = await workbench.createIteration({
      projectId: 'alpha',
      templateVersion: 1,
      definition: {},
      briefVersion: null,
      set: 'dev',
      model: null,
      jobIds: [],
    });
    prints.push((await fingerprint()).fingerprint);
    await workbench.setIterationScores(iteration.id, { score: 1, completed: 0, total: 0 });
    prints.push((await fingerprint()).fingerprint);
    await workbench.setGateCache(iteration.id, {
      fingerprint: 'f',
      score: 1,
      completed: 0,
      total: 0,
    });
    prints.push((await fingerprint()).fingerprint);
    expect(new Set(prints).size).toBe(prints.length);
  });

  it('moves lastActivityAt forward after adding a sample', async () => {
    const { repo, workbench, fingerprint } = await setup();
    const before = (await fingerprint('beta')).lastActivityAt;
    expect(before).toBe((await workbench.getProject('beta'))!.createdAt);
    const job = await repo.createWorkbenchJob(doc('beta'), { projectId: 'beta', task: 'prepare' });
    repo.jobs.delete(job.id);
    await workbench.addSample({
      projectId: 'beta',
      documentId: job.documentId!,
      role: 'dev',
      addedForVersion: 1,
    });
    expect((await fingerprint('beta')).lastActivityAt > before).toBe(true);
  });

  it('round-trips the list cache and ignores an unknown project', async () => {
    const { workbench } = await setup();
    expect((await workbench.listCache()).size).toBe(0);
    await workbench.putListCache('alpha', 'f1', { name: 'Alpha' });
    await workbench.putListCache('alpha', 'f2', { name: 'Alpha 2' });
    await workbench.putListCache('nope', 'f1', { name: 'Nope' });
    const cache = await workbench.listCache();
    expect([...cache.keys()]).toEqual(['alpha']);
    expect(cache.get('alpha')).toEqual({ fingerprint: 'f2', item: { name: 'Alpha 2' } });
  });

  it('pins per owner, newest first, refuses unknown projects and unpins idempotently', async () => {
    const { workbench } = await setup();
    expect(await workbench.listPins('me')).toEqual([]);
    expect(await workbench.pin('me', 'alpha')).toBe(true);
    expect(await workbench.pin('me', 'beta')).toBe(true);
    expect(await workbench.pin('you', 'alpha')).toBe(true);
    expect(await workbench.pin('me', 'nope')).toBe(false);
    expect(await workbench.listPins('me')).toEqual(['beta', 'alpha']);
    expect(await workbench.listPins('you')).toEqual(['alpha']);
    await workbench.unpin('me', 'beta');
    await workbench.unpin('me', 'beta');
    await workbench.unpin('me', 'nope');
    expect(await workbench.listPins('me')).toEqual(['alpha']);
  });

  it('drops the cache row and pins of a deleted project', async () => {
    const { workbench } = await setup();
    await workbench.putListCache('alpha', 'f', {});
    await workbench.putListCache('beta', 'f', {});
    await workbench.pin('me', 'alpha');
    await workbench.pin('me', 'beta');
    expect(await workbench.deleteProject('alpha')).not.toBeNull();
    expect([...(await workbench.listCache()).keys()]).toEqual(['beta']);
    expect(await workbench.listPins('me')).toEqual(['beta']);
    expect((await workbench.projectFingerprints()).map((f) => f.id)).toEqual(['beta']);
  });
});
