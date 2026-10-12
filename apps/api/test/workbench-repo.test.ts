import { describe, expect, it } from 'vitest';
import { EMPTY_BRIEF } from '@ih/shared';
import { MemoryRepo } from '../src/repositories/memory.js';
import { MemoryWorkbenchRepo, WorkbenchConflictError } from '../src/workbench/repo.js';

async function setup() {
  const jobs = new MemoryRepo();
  const repo = new MemoryWorkbenchRepo(jobs);
  await repo.createProject('letter', 'Letter');
  await jobs.createDocumentAndJob(
    {
      id: 'd1',
      filename: 'a.pdf',
      sha256: 'sha-a',
      sizeBytes: 3,
      specId: 'letter',
      specVersion: 1,
      bucket: 'inbox',
      objectKey: 'letter/v1/d1.pdf',
    },
    null,
  );
  return { jobs, repo };
}

describe('MemoryWorkbenchRepo', () => {
  it('creates projects once', async () => {
    const { repo } = await setup();
    expect(await repo.getProject('letter')).toMatchObject({ id: 'letter', name: 'Letter' });
    expect(await repo.getProject('nope')).toBeNull();
    await expect(repo.createProject('letter', 'Again')).rejects.toBeInstanceOf(
      WorkbenchConflictError,
    );
    expect((await repo.listProjects()).map((p) => p.id)).toEqual(['letter']);
  });

  it('links samples to documents and pins them', async () => {
    const { jobs, repo } = await setup();
    const sample = await repo.addSample({
      projectId: 'letter',
      documentId: 'd1',
      role: 'dev',
      addedForVersion: 1,
    });
    expect(sample).toMatchObject({
      filename: 'a.pdf',
      sha256: 'sha-a',
      objectKey: 'letter/v1/d1.pdf',
    });
    expect(jobs.sampleDocuments.has('d1')).toBe(true);
    expect((await repo.setSampleRole('letter', sample.id, 'holdout'))?.role).toBe('holdout');
    expect(await repo.setSampleRole('other', sample.id, 'dev')).toBeNull();
    expect(await repo.removeSample('letter', sample.id)).toBe(true);
    expect(await repo.removeSample('letter', sample.id)).toBe(false);
    expect(jobs.sampleDocuments.has('d1')).toBe(false);
    expect(await repo.listSamples('letter')).toEqual([]);
  });

  it('rejects a document sampled twice in one project', async () => {
    const { jobs, repo } = await setup();
    const sample = {
      projectId: 'letter',
      documentId: 'd1',
      role: 'dev' as const,
      addedForVersion: 1,
    };
    await repo.addSample(sample);
    await expect(repo.addSample(sample)).rejects.toBeInstanceOf(WorkbenchConflictError);
    expect(await repo.listSamples('letter')).toHaveLength(1);
    expect(jobs.sampleDocuments.has('d1')).toBe(true);
  });

  it('rejects unknown documents and projects without changing state', async () => {
    const { jobs, repo } = await setup();
    await expect(
      repo.addSample({ projectId: 'letter', documentId: 'nope', role: 'dev', addedForVersion: 1 }),
    ).rejects.toThrow(/unknown document/);
    await expect(
      repo.addSample({ projectId: 'ghost', documentId: 'd1', role: 'dev', addedForVersion: 1 }),
    ).rejects.toThrow(/unknown project/);
    expect(await repo.listSamples('letter')).toEqual([]);
    expect(jobs.sampleDocuments.size).toBe(0);
  });

  it('keeps a document pinned while another project still samples it', async () => {
    const { jobs, repo } = await setup();
    await repo.createProject('other', 'Other');
    const a = await repo.addSample({
      projectId: 'letter',
      documentId: 'd1',
      role: 'dev',
      addedForVersion: 1,
    });
    const b = await repo.addSample({
      projectId: 'other',
      documentId: 'd1',
      role: 'dev',
      addedForVersion: 1,
    });
    await repo.removeSample('letter', a.id);
    expect(jobs.sampleDocuments.has('d1')).toBe(true);
    await repo.removeSample('other', b.id);
    expect(jobs.sampleDocuments.has('d1')).toBe(false);
  });

  it('versions briefs', async () => {
    const { repo } = await setup();
    expect(await repo.latestBrief('letter')).toBeNull();
    await repo.saveBrief('letter', { ...EMPTY_BRIEF, purpose: 'one' });
    const second = await repo.saveBrief('letter', { ...EMPTY_BRIEF, purpose: 'two' });
    expect(second).toMatchObject({ projectId: 'letter', version: 2 });
    expect((await repo.latestBrief('letter'))?.body.purpose).toBe('two');
  });
});
