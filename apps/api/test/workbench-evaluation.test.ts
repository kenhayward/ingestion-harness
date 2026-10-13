import { describe, expect, it } from 'vitest';
import {
  outputKey,
  preparedTriageKey,
  type IterationSummary,
  type IterationView,
  type SampleView,
} from '@ih/shared';
import { letter, multipart, seedModelChoices, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);

async function project() {
  const ctx = await testApp();
  seedModelChoices(ctx); // main (the default), fast (local), cloud (external)
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  await ctx.templates.updateDraft('letter', 1, letter(1));
  const add = async (n: number) => {
    const s = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/samples',
        ...multipart({ role: 'dev' }, { filename: `s${n}.pdf`, content: pdf(n) }),
      })
    ).json() as SampleView;
    const prep = ctx.repo.jobs.get(s.prepareJobId!)!;
    ctx.repo.jobs.set(prep.id, { ...prep, status: 'succeeded' });
    const triage = { sha256: s.sha256, pageCount: 1, ocrPages: [], chars: 5, ocrModel: null };
    await ctx.store.put(
      'runs',
      preparedTriageKey(s.sha256),
      Buffer.from(JSON.stringify(triage)),
      'application/json',
    );
    return s;
  };
  /** A verified reference for a sample: a finished test run of it, saved with `expected`. */
  const verify = async (s: SampleView, sender: string) => {
    const job = await ctx.repo.createWorkbenchJob(
      {
        id: crypto.randomUUID(),
        filename: s.filename,
        sha256: s.sha256,
        sizeBytes: 1,
        specId: 'letter',
        specVersion: 1,
        bucket: 'inbox',
        objectKey: `letter/${s.id}`,
      },
      { projectId: 'letter', task: 'process' },
    );
    return ctx.repo.createReference({
      templateId: 'letter',
      name: s.filename,
      documentId: job.documentId,
      sourceJobId: job.id,
      expected: { fields: { sender }, tables: {} },
    });
  };
  /** Finish an evaluation job with a document whose sender is `sender`. */
  const finish = async (jobId: string, sender: string) => {
    const job = ctx.repo.jobs.get(jobId)!;
    const key = outputKey('letter', 1, 'document', job.documentId, 'json');
    await ctx.store.put(
      'outputs',
      key,
      Buffer.from(JSON.stringify({ fields: { sender: { value: sender } }, tables: {} })),
      'application/json',
    );
    ctx.repo.outputs.set(jobId, [
      {
        outputId: 'document',
        stage: 'draft',
        format: 'json',
        bucket: 'outputs',
        key,
        rowCount: null,
      },
    ]);
    ctx.repo.jobs.set(jobId, { ...job, status: 'succeeded' });
  };
  const evaluate = (payload: Record<string, unknown> = {}) =>
    ctx.app.inject({ method: 'POST', url: '/api/workbench/projects/letter/evaluations', payload });
  const view = async (id: string) =>
    (
      await ctx.app.inject(`/api/workbench/projects/letter/iterations/${id}`)
    ).json() as IterationView;
  return { ...ctx, add, verify, finish, evaluate, view };
}

describe('evaluations', () => {
  it('needs at least one verified dev sample', async () => {
    const { add, evaluate } = await project();
    await add(1);
    const res = await evaluate();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(
      'no verified references for the dev samples; verify some on the References tab first',
    );
  });

  it('runs verified samples against their references, with the model and data policy', async () => {
    const { add, verify, evaluate, repo } = await project();
    const a = await add(1);
    await add(2); // no reference: not evaluated
    const ref = await verify(a, 'Acme');
    const res = await evaluate({ model: 'fast' });
    expect(res.statusCode).toBe(201);
    const it = res.json() as IterationView;
    expect(it).toMatchObject({
      templateVersion: 1,
      set: 'dev',
      model: 'fast',
      status: 'running',
      total: 1,
      score: null,
    });
    const [jobId] = (await repo.listProjectRuns('letter'))
      .filter((r) => r.job.referenceId === ref.id)
      .map((r) => r.job.id);
    expect(repo.jobs.get(jobId!)).toMatchObject({
      referenceId: ref.id,
      modelOverride: 'fast',
      specVersion: 1,
    });
    expect(repo.jobParams.get(jobId!)).toEqual({ dataPolicy: 'local', outputs: letter(1).outputs });
    expect((await evaluate({ model: 'opus' })).statusCode).toBe(400);
  });

  it('scores finished samples, counts failures as finished, and caches the summary', async () => {
    const { app, add, verify, finish, evaluate, view, repo, workbench } = await project();
    const a = await add(1);
    const b = await add(2);
    await verify(a, 'Acme');
    await verify(b, 'Globex');
    const it = (await evaluate()).json() as IterationView;
    const [jobA, jobB] = (await repo.listProjectRuns('letter'))
      .filter((r) => r.job.referenceId)
      .map((r) => r.job.id)
      .reverse();
    await finish(jobA!, 'Acme');
    expect((await view(it.id)).status).toBe('running');
    repo.jobs.set(jobB!, { ...repo.jobs.get(jobB!)!, status: 'failed', error: 'boom' });
    const done = await view(it.id);
    expect(done).toMatchObject({ status: 'complete', score: 1, completed: 1, total: 2 });
    expect(done.scorecard.fields).toEqual([{ id: 'sender', matched: 1, total: 1, accuracy: 1 }]);
    expect(done.samples.find((s) => s.jobId === jobB)).toMatchObject({
      status: 'failed',
      error: 'boom',
      comparison: null,
    });
    expect((await workbench.getIteration('letter', it.id))!.scores).toEqual({
      score: 1,
      completed: 1,
      total: 2,
    });
    const [summary] = (
      await app.inject('/api/workbench/projects/letter/iterations')
    ).json() as IterationSummary[];
    expect(summary).toMatchObject({ id: it.id, status: 'complete', score: 1 });
  });

  it('restores an iteration into the open draft', async () => {
    const { app, add, verify, evaluate, templates } = await project();
    const a = await add(1);
    await verify(a, 'Acme');
    const it = (await evaluate()).json() as IterationView;
    await templates.updateDraft('letter', 1, { ...letter(1), name: 'Changed later' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/workbench/projects/letter/iterations/${it.id}/restore`,
    });
    expect(res.statusCode).toBe(200);
    expect((await templates.get('letter', 1))!.definition).toEqual(letter(1));
    expect(
      (await app.inject('/api/workbench/projects/letter/iterations/not-a-uuid')).statusCode,
    ).toBe(404);
  });

  it('survives a deleted job and an unreadable document', async () => {
    const { add, verify, evaluate, view, repo, store } = await project();
    const a = await add(1);
    const b = await add(2);
    await verify(a, 'Acme');
    await verify(b, 'Globex');
    const it = (await evaluate()).json() as IterationView;
    const [jobA, jobB] = (await repo.listProjectRuns('letter'))
      .filter((r) => r.job.referenceId)
      .map((r) => r.job.id)
      .reverse();
    repo.jobs.delete(jobA!);
    const job = repo.jobs.get(jobB!)!;
    const key = outputKey('letter', 1, 'document', job.documentId, 'json');
    await store.put('outputs', key, Buffer.from('{not json'), 'application/json');
    repo.outputs.set(jobB!, [
      {
        outputId: 'document',
        stage: 'draft',
        format: 'json',
        bucket: 'outputs',
        key,
        rowCount: null,
      },
    ]);
    repo.jobs.set(jobB!, { ...job, status: 'succeeded' });
    const done = await view(it.id);
    expect(done).toMatchObject({ status: 'complete', score: null, completed: 0, total: 2 });
    expect(done.samples).toContainEqual({
      sampleId: null,
      filename: 'deleted job',
      jobId: null,
      status: null,
      error: null,
      comparison: null,
    });
    expect(done.samples.find((s) => s.jobId === jobB)).toMatchObject({
      status: 'succeeded',
      comparison: null,
    });
  });

  it('completes when a job was rejected in review', async () => {
    const { add, verify, evaluate, view, repo } = await project();
    await verify(await add(1), 'Acme');
    const it = (await evaluate()).json() as IterationView;
    const [jobId] = (await repo.listProjectRuns('letter')).map((r) => r.job.id);
    repo.jobs.set(jobId!, { ...repo.jobs.get(jobId!)!, status: 'rejected' });
    expect(await view(it.id)).toMatchObject({ status: 'complete', completed: 0, total: 1 });
  });

  it('updates the cached summary when a finished job changes (retried, re-reviewed)', async () => {
    const { app, add, verify, finish, evaluate, view, repo, workbench } = await project();
    await verify(await add(1), 'Acme');
    const it = (await evaluate()).json() as IterationView;
    const [jobId] = (await repo.listProjectRuns('letter'))
      .filter((r) => r.job.referenceId)
      .map((r) => r.job.id);
    repo.jobs.set(jobId!, { ...repo.jobs.get(jobId!)!, status: 'failed', error: 'boom' });
    expect(await view(it.id)).toMatchObject({ status: 'complete', score: null, completed: 0 });
    expect((await workbench.getIteration('letter', it.id))!.scores).toEqual({
      score: null,
      completed: 0,
      total: 1,
    });

    await finish(jobId!, 'Acme'); // retried and succeeded
    expect(await view(it.id)).toMatchObject({ status: 'complete', score: 1, completed: 1 });
    const [summary] = (
      await app.inject('/api/workbench/projects/letter/iterations')
    ).json() as IterationSummary[];
    expect(summary).toMatchObject({ id: it.id, status: 'complete', score: 1, completed: 1 });
  });

  it('refuses to evaluate without an open draft, or with an invalid one', async () => {
    const { add, verify, evaluate, templates } = await project();
    await verify(await add(1), 'Acme');
    await templates.updateDraft('letter', 1, { ...letter(1), pipeline: [] });
    const invalid = await evaluate();
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe('the draft is not valid');
    expect(invalid.json().issues.length).toBeGreaterThan(0);

    await templates.updateDraft('letter', 1, letter(1));
    await templates.publish('letter', 1);
    const closed = await evaluate();
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error).toBe('no open draft; start the next version on the Recipe tab');
  });

  it('refuses to restore without an open draft', async () => {
    const { app, add, verify, evaluate, templates } = await project();
    await verify(await add(1), 'Acme');
    const it = (await evaluate()).json() as IterationView;
    await templates.publish('letter', 1);
    const res = await app.inject({
      method: 'POST',
      url: `/api/workbench/projects/letter/iterations/${it.id}/restore`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no open draft; start the next version on the Recipe tab');
  });
});
