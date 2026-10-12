import { describe, expect, it } from 'vitest';
import { EMPTY_BRIEF, preparedTriageKey, type SampleView } from '@ih/shared';
import { WORKBENCH_PRIORITY } from '../src/repositories/types.js';
import { letter, multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);

async function project() {
  const ctx = await testApp();
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  const add = async (n: number, role = 'dev', ready = true) => {
    const sample = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/samples',
        ...multipart({ role }, { filename: `s${n}.pdf`, content: pdf(n) }),
      })
    ).json() as SampleView;
    if (ready) {
      const job = ctx.repo.jobs.get(sample.prepareJobId!)!;
      ctx.repo.jobs.set(job.id, { ...job, status: 'succeeded' });
      const triage = {
        sha256: sample.sha256,
        pageCount: 1,
        ocrPages: [],
        chars: 5,
        ocrModel: null,
      };
      await ctx.store.put(
        'runs',
        preparedTriageKey(sample.sha256),
        Buffer.from(JSON.stringify(triage)),
        'application/json',
      );
    }
    return sample;
  };
  const run = () =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/test-runs',
      payload: {},
    });
  return { ...ctx, add, run };
}

describe('workbench brief', () => {
  it('saves a new version only when the brief changes', async () => {
    const { app } = await project();
    const put = (payload: object) =>
      app.inject({ method: 'PUT', url: '/api/workbench/projects/letter/brief', payload });
    const first = await put({ purpose: 'Batch records for QA' });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({
      version: 1,
      body: { ...EMPTY_BRIEF, purpose: 'Batch records for QA' },
    });
    const same = await put({ purpose: 'Batch records for QA' });
    expect(same.statusCode).toBe(200);
    expect(same.json().version).toBe(1);
    expect((await put({ purpose: 'changed' })).json().version).toBe(2);
    expect((await app.inject('/api/workbench/projects/letter')).json().brief.version).toBe(2);
    expect((await put({ colour: 'red' })).statusCode).toBe(400);
    const missing = await app.inject({
      method: 'PUT',
      url: '/api/workbench/projects/nope/brief',
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
  });
});

describe('workbench dev test runs', () => {
  it('refuses an invalid draft', async () => {
    const { add, run } = await project();
    await add(1);
    const res = await run(); // the v1 skeleton has no steps yet
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.length).toBeGreaterThan(0);
  });

  it('refuses when no dev sample is prepared', async () => {
    const { add, run, templates } = await project();
    await templates.updateDraft('letter', 1, letter(1));
    await add(1, 'dev', false);
    await add(2, 'holdout');
    expect((await run()).statusCode).toBe(409);
  });

  it('refuses when there is no open draft', async () => {
    const { add, run, templates } = await project();
    await templates.updateDraft('letter', 1, letter(1));
    await add(1);
    await templates.publish('letter', 1);
    expect((await run()).statusCode).toBe(409);
  });

  it('runs the draft on every prepared dev sample, behind production work', async () => {
    const { app, repo, add, run, templates } = await project();
    await templates.updateDraft('letter', 1, letter(1));
    const dev1 = await add(1);
    const dev2 = await add(2);
    await add(3, 'holdout');
    await add(4, 'dev', false);

    const res = await run();
    expect(res.statusCode).toBe(201);
    const jobs = res.json().jobs as { id: string; filename: string; objectKey?: string }[];
    expect(jobs.map((j) => j.filename).sort()).toEqual(['s1.pdf', 's2.pdf']);
    for (const j of jobs) {
      expect(repo.jobs.get(j.id)).toMatchObject({
        task: 'process',
        test: true,
        projectId: 'letter',
        specVersion: 1,
      });
      expect(repo.priorities.get(j.id)).toBe(WORKBENCH_PRIORITY);
      const doc = repo.documents.get(repo.jobs.get(j.id)!.documentId)!;
      const source = [dev1, dev2].find((s) => s.filename === j.filename)!;
      expect(doc.objectKey).toBe(repo.documents.get(source.documentId)!.objectKey); // same PDF
    }
    const listed = (await app.inject('/api/workbench/projects/letter/test-runs')).json();
    expect(listed.map((j: { id: string }) => j.id).sort()).toEqual(jobs.map((j) => j.id).sort());
  });
});
