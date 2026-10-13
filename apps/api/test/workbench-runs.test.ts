import { describe, expect, it } from 'vitest';
import {
  EMPTY_BRIEF,
  preparedTextKey,
  preparedTriageKey,
  STEP_PROGRESS_EVENT,
  type SampleView,
} from '@ih/shared';
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
      await ctx.store.put(
        'runs',
        preparedTextKey(sample.sha256),
        Buffer.from(
          JSON.stringify({
            sha256: sample.sha256,
            pages: [{ number: 1, text: 'hello', ocr: false }],
          }),
        ),
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

  const runWith = (app: Awaited<ReturnType<typeof project>>['app'], payload: object) =>
    app.inject({ method: 'POST', url: '/api/workbench/projects/letter/test-runs', payload });

  it('runs only the chosen ready dev samples, as one batch (TR1, TR2)', async () => {
    const { app, repo, add, templates } = await project();
    await templates.updateDraft('letter', 1, letter(1));
    const a = await add(1);
    await add(2);
    const c = await add(3);
    const res = await runWith(app, { sampleIds: [a.id, c.id] });
    expect(res.statusCode).toBe(201);
    const jobs = res.json().jobs as { id: string; filename: string; batchId: string }[];
    expect(jobs.map((j) => j.filename).sort()).toEqual(['s1.pdf', 's3.pdf']);
    const [batch] = new Set(jobs.map((j) => j.batchId));
    expect(batch).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(jobs.map((j) => j.batchId)).size).toBe(1);
    for (const j of jobs) expect(repo.jobParams.get(j.id)).toMatchObject({ batchId: batch });

    const again = (await runWith(app, {})).json().jobs as { batchId: string }[];
    expect(again).toHaveLength(3); // no sampleIds: every ready dev sample
    expect(new Set(again.map((j) => j.batchId)).size).toBe(1);
    expect(again[0]!.batchId).not.toBe(batch);
    const listed = (await app.inject('/api/workbench/projects/letter/test-runs')).json() as {
      batchId: string | null;
    }[];
    expect(new Set(listed.map((j) => j.batchId))).toEqual(new Set([batch, again[0]!.batchId]));
  });

  it('refuses holdout, unknown and unprepared samples before queuing anything', async () => {
    const { app, repo, add, templates } = await project();
    await templates.updateDraft('letter', 1, letter(1));
    const dev = await add(1);
    const holdout = await add(2, 'holdout');
    const preparing = await add(3, 'dev', false);
    const before = repo.jobs.size;

    const held = await runWith(app, { sampleIds: [dev.id, holdout.id] });
    expect(held.statusCode).toBe(400);
    expect(held.json().error).toBe(
      's2.pdf is a holdout sample: holdout samples are never test-run',
    );
    const unknown = await runWith(app, { sampleIds: ['00000000-0000-4000-8000-000000000009'] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe(
      'sample 00000000-0000-4000-8000-000000000009 is not a sample of this project',
    );
    const notReady = await runWith(app, { sampleIds: [preparing.id] });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json().error).toBe('s3.pdf is not prepared yet');
    expect(repo.jobs.size).toBe(before);
  });

  it.each([
    ['an empty selection', { sampleIds: [] }],
    [
      'a duplicate',
      {
        sampleIds: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'],
      },
    ],
    ['a non-uuid', { sampleIds: ['s1.pdf'] }],
  ])('rejects %s', async (_name, payload) => {
    const { app, add, templates } = await project();
    await templates.updateDraft('letter', 1, letter(1));
    await add(1);
    expect((await runWith(app, payload)).statusCode).toBe(400);
  });

  it('keeps a retried run in its batch', async () => {
    const { app, repo, add, templates } = await project();
    await templates.updateDraft('letter', 1, letter(1));
    await add(1);
    const [job] = (await runWith(app, {})).json().jobs as { id: string; batchId: string }[];
    repo.jobs.set(job!.id, { ...repo.jobs.get(job!.id)!, status: 'failed' });
    const retried = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job!.id}/retry`,
      payload: {},
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().batchId).toBe(job!.batchId);
  });
});

describe('dev test run housekeeping', () => {
  async function finishedRun() {
    const ctx = await project();
    await ctx.templates.updateDraft('letter', 1, letter(1));
    const sample = await ctx.add(1);
    const created = (await ctx.run()).json().jobs as { id: string }[];
    const runId = created[0]!.id;
    const job = ctx.repo.jobs.get(runId)!;
    ctx.repo.jobs.set(runId, { ...job, status: 'succeeded' });
    const doc = ctx.repo.documents.get(ctx.repo.documents.get(sample.documentId)!.id)!;
    return { ...ctx, sample, runId, doc };
  }
  async function expectSampleIntact(c: Awaited<ReturnType<typeof finishedRun>>) {
    expect(c.store.objects.has(`${c.doc.bucket}/${c.doc.objectKey}`)).toBe(true);
    const listed = (await c.app.inject('/api/workbench/projects/letter/samples')).json();
    expect(listed.find((s: SampleView) => s.id === c.sample.id).state).toBe('ready');
    const text = await c.app.inject(`/api/workbench/projects/letter/samples/${c.sample.id}/text`);
    expect(text.statusCode).toBe(200);
  }

  it('keeps the sample PDF when a run job is deleted', async () => {
    const c = await finishedRun();
    expect((await c.app.inject({ method: 'DELETE', url: `/api/jobs/${c.runId}` })).statusCode).toBe(
      204,
    );
    expect(c.repo.jobs.has(c.runId)).toBe(false);
    await expectSampleIntact(c);
  });

  it('keeps the sample PDF through bulk clean-up', async () => {
    const c = await finishedRun();
    const res = await c.app.inject({
      method: 'POST',
      url: '/api/jobs/cleanup',
      payload: { olderThanDays: 1, dryRun: false, cutoff: '2999-01-01T00:00:00.000Z' },
    });
    expect(res.json().deleted).toBe(1);
    expect(c.repo.jobs.has(c.runId)).toBe(false);
    await expectSampleIntact(c);
  });
});

describe('test runs list: holdout stays sealed', () => {
  it('leaves out every job whose sample is a holdout sample', async () => {
    const ctx = await project();
    await ctx.templates.updateDraft('letter', 1, letter(1));
    await ctx.add(1);
    const holdout = await ctx.add(2, 'holdout');
    await ctx.run();
    // A holdout reference run and a holdout evaluation job, as the routes create them.
    for (const params of [{ forceReview: true }, { referenceId: 'r' }]) {
      await ctx.repo.createWorkbenchJob(
        {
          id: crypto.randomUUID(),
          filename: holdout.filename,
          sha256: holdout.sha256,
          sizeBytes: holdout.sizeBytes,
          specId: 'letter',
          specVersion: 1,
          bucket: 'inbox',
          objectKey: `${holdout.sha256}.pdf`,
        },
        { projectId: 'letter', task: 'process', params },
      );
    }
    const listed = (await ctx.app.inject('/api/workbench/projects/letter/test-runs')).json() as {
      filename: string;
    }[];
    expect(listed.map((j) => j.filename)).toEqual(['s1.pdf']);
  });
});

describe('test run progress (TR3)', () => {
  async function runningRun() {
    const ctx = await project();
    await ctx.templates.updateDraft('letter', 1, letter(1));
    await ctx.add(1);
    const [created] = (await ctx.run()).json().jobs as { id: string }[];
    const id = created!.id;
    const startedAt = ctx.repo.now();
    ctx.repo.jobs.set(id, { ...ctx.repo.jobs.get(id)!, status: 'running', startedAt });
    const listed = async () =>
      (
        (await ctx.app.inject('/api/workbench/projects/letter/test-runs')).json() as {
          id: string;
          progress: unknown;
        }[]
      ).find((j) => j.id === id)!;
    return { ...ctx, id, listed };
  }
  const event = { step: 'totals', index: 3, of: 3, attempt: 2, chunk: null };

  it("shows a running run's latest progress of this attempt", async () => {
    const r = await runningRun();
    expect((await r.listed()).progress).toBeNull(); // nothing reported yet
    r.repo.addEvent(r.id, 'info', STEP_PROGRESS_EVENT, { ...event, attempt: 1 });
    r.repo.addEvent(r.id, 'info', STEP_PROGRESS_EVENT, event);
    expect((await r.listed()).progress).toEqual(event);
  });

  it("ignores an earlier attempt's progress, malformed data and finished runs", async () => {
    const r = await runningRun();
    r.repo.addEvent(r.id, 'info', STEP_PROGRESS_EVENT, event);
    // The run is claimed again (retry or reaped lock): the old event predates this attempt.
    r.repo.jobs.set(r.id, { ...r.repo.jobs.get(r.id)!, startedAt: r.repo.now() });
    expect((await r.listed()).progress).toBeNull();
    r.repo.addEvent(r.id, 'info', STEP_PROGRESS_EVENT, { step: 'totals' });
    expect((await r.listed()).progress).toBeNull();
    r.repo.addEvent(r.id, 'info', STEP_PROGRESS_EVENT, event);
    r.repo.jobs.set(r.id, { ...r.repo.jobs.get(r.id)!, status: 'succeeded' });
    expect((await r.listed()).progress).toBeNull();
  });

  it('shows no step progress for a running step re-run or publish', async () => {
    const r = await runningRun();
    r.repo.addEvent(r.id, 'info', STEP_PROGRESS_EVENT, event);
    expect((await r.listed()).progress).toEqual(event);
    for (const task of ['rerun', 'publish'] as const) {
      r.repo.jobs.set(r.id, { ...r.repo.jobs.get(r.id)!, task });
      expect((await r.listed()).progress).toBeNull();
    }
  });
});
