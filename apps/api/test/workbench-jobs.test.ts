import { describe, expect, it } from 'vitest';
import { WORKBENCH_PRIORITY, type NewDocument } from '../src/repositories/types.js';
import { testApp } from './helpers.js';

const doc = (id: string): NewDocument => ({
  id,
  filename: `${id}.pdf`,
  sha256: `sha-${id}`,
  sizeBytes: 10,
  specId: 'tdemo',
  specVersion: 1,
  bucket: 'inbox',
  objectKey: `tdemo/v1/${id}.pdf`,
});

describe('workbench jobs', () => {
  it('queues workbench jobs as test jobs behind production work', async () => {
    const { repo } = await testApp();
    const job = await repo.createWorkbenchJob(doc('d1'), { projectId: 'tdemo', task: 'prepare' });
    expect(job).toMatchObject({
      task: 'prepare',
      test: true,
      projectId: 'tdemo',
      status: 'queued',
    });
    expect(repo.priorities.get(job.id)).toBe(WORKBENCH_PRIORITY);
    expect((await repo.listProjectJobs('tdemo')).map((j) => j.id)).toEqual([job.id]);
    expect(await repo.listProjectJobs('other')).toEqual([]);
  });

  it('keeps prepare jobs off the Jobs page and out of bulk clean-up', async () => {
    const { app, repo } = await testApp();
    const prepare = await repo.createWorkbenchJob(doc('d1'), {
      projectId: 'tdemo',
      task: 'prepare',
    });
    const run = await repo.createWorkbenchJob(doc('d2'), { projectId: 'tdemo', task: 'process' });
    for (const id of [prepare.id, run.id]) {
      repo.jobs.set(id, { ...repo.jobs.get(id)!, status: 'succeeded' });
    }
    const listed = (await app.inject('/api/jobs')).json() as { id: string }[];
    expect(listed.map((j) => j.id)).toEqual([run.id]);
    expect(await repo.finishedJobIdsBefore('2999-01-01T00:00:00.000Z', true)).toEqual([run.id]);
  });

  it('retries a failed preparation as a preparation', async () => {
    const { app, repo } = await testApp();
    const job = await repo.createWorkbenchJob(doc('d1'), { projectId: 'tdemo', task: 'prepare' });
    repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'failed', error: 'OCR down' });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry`, payload: {} });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'queued', task: 'prepare', error: null });
  });

  it('never deletes a document a sample still uses', async () => {
    const { app, repo, store } = await testApp();
    await store.put('inbox', 'tdemo/v1/d1.pdf', Buffer.from('%PDF'), 'application/pdf');
    const job = await repo.createWorkbenchJob(doc('d1'), { projectId: 'tdemo', task: 'prepare' });
    repo.sampleDocuments.add('d1');
    repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'failed' });
    const res = await app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}` });
    expect(res.statusCode).toBe(204);
    expect(repo.documents.has('d1')).toBe(true);
    expect(store.objects.has('inbox/tdemo/v1/d1.pdf')).toBe(true);
  });
});
