import { describe, expect, it, vi } from 'vitest';
import {
  preparedTriageKey,
  type ReferenceDetail,
  type ReferenceRow,
  type SampleView,
  type StageView,
} from '@ih/shared';
import type { NewEdit } from '../src/repositories/types.js';
import { letter, multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);

async function project() {
  const ctx = await testApp();
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  await ctx.templates.updateDraft('letter', 1, letter(1));
  const add = async (n: number, role = 'dev') => {
    const s = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/samples',
        ...multipart({ role }, { filename: `s${n}.pdf`, content: pdf(n) }),
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
  const skipAll = async () => {
    for (const stage of ['survey', 'outputs', 'sections', 'steps']) {
      await ctx.app.inject({
        method: 'POST',
        url: `/api/workbench/projects/letter/stages/${stage}/skip`,
      });
    }
  };
  const propose = () =>
    ctx.app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/references' });
  /** A reference run of sample `s`, reviewed with `edits`, approved by `reviewer` and saved. */
  const reviewed = async (
    s: SampleView,
    edits: Omit<NewEdit, 'editor' | 'reason'>[],
    reviewer: string | null = 'ken',
  ) => {
    await propose(); // starts runs for every sample without one; a 409 means ours is running
    const job = [...ctx.repo.jobs.values()]
      .filter((j) => ctx.repo.documents.get(j.documentId!)?.sha256 === s.sha256)
      .filter((j) => j.modelOverride === 'draft')
      .at(-1)!;
    ctx.repo.jobs.set(job.id, { ...job, status: 'awaiting_review' });
    for (const e of edits) await ctx.repo.addEdit(job.id, { ...e, editor: 'kim', reason: null });
    await ctx.repo.approve(job.id, reviewer, null);
    ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, status: 'succeeded' });
    const reference = await ctx.repo.createReference({
      templateId: 'letter',
      name: s.filename,
      documentId: job.documentId,
      sourceJobId: job.id,
      expected: { fields: { sender: 'Acme Ltd' }, tables: {} },
      templateVersion: 1,
      verifiedOutputs: letter(1).outputs,
    });
    return { job, reference };
  };
  const detail = (sid: string) =>
    ctx.app.inject(`/api/workbench/projects/letter/references/${sid}`);
  const rows = async () =>
    (await ctx.app.inject('/api/workbench/projects/letter/references')).json() as ReferenceRow[];
  const stage = async () =>
    ((await ctx.app.inject('/api/workbench/projects/letter/stages')).json() as StageView[]).find(
      (s) => s.stage === 'references',
    );
  return { ...ctx, add, skipAll, propose, reviewed, detail, rows, stage };
}

describe('references stage', () => {
  it('waits for the earlier stages', async () => {
    const { add, propose } = await project();
    await add(1);
    const res = await propose();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('finish the survey stage first (accept or skip it)');
  });

  it('runs the draft model on dev samples without a reference, carrying the data policy', async () => {
    const { add, skipAll, propose, repo, rows, stage } = await project();
    const dev = await add(1);
    await add(2, 'holdout');
    await skipAll();
    expect((await stage())!.state).toBe('pending');
    const res = await propose();
    expect(res.statusCode).toBe(201);
    const [job] = res.json().jobs as {
      id: string;
      modelOverride: string;
      referenceId: string | null;
    }[];
    expect(job).toMatchObject({ modelOverride: 'draft', referenceId: null });
    expect(repo.jobParams.get(job!.id)).toEqual({
      dataPolicy: 'local',
      forceReview: true,
      outputs: letter(1).outputs,
    });
    expect((await stage())!.state).toBe('running');
    expect(await rows()).toEqual([
      {
        sampleId: dev.id,
        filename: 's1.pdf',
        sha256: dev.sha256,
        reference: null,
        run: { jobId: job!.id, status: 'queued', error: null, modelOverride: 'draft' },
      },
    ]);
  });

  it('is accepted once every dev sample has a reference, and refuses to propose again', async () => {
    const { add, skipAll, propose, repo, rows, stage } = await project();
    await add(1);
    await skipAll();
    const [job] = (await propose()).json().jobs as { id: string; documentId: string }[];
    repo.jobs.set(job!.id, { ...repo.jobs.get(job!.id)!, status: 'succeeded' });
    await repo.createReference({
      templateId: 'letter',
      name: 's1',
      documentId: job!.documentId,
      sourceJobId: job!.id,
      expected: { fields: { sender: 'Acme' }, tables: {} },
    });
    expect((await rows())[0]!.reference).toMatchObject({ name: 's1' });
    expect((await stage())!.state).toBe('accepted');
    const again = await propose();
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('every dev sample already has a reference');
  });

  it('refuses with no prepared dev samples, distinct from every sample having a reference', async () => {
    const { add, skipAll, propose } = await project();
    await add(1, 'holdout');
    await skipAll();
    const res = await propose();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no prepared dev samples to run');
  });

  it('skips samples whose draft run is still active, and refuses when all are', async () => {
    const { add, skipAll, propose, repo } = await project();
    await add(1);
    await skipAll();
    const [first] = (await propose()).json().jobs as { id: string; documentId: string }[];
    const again = await propose();
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('reference runs are already running');

    repo.jobs.set(first!.id, { ...repo.jobs.get(first!.id)!, status: 'running' });
    const s2 = await add(2);
    const res = await propose();
    expect(res.statusCode).toBe(201);
    const jobs = res.json().jobs as { documentId: string }[];
    expect(jobs.map((j) => repo.documents.get(j.documentId)!.sha256)).toEqual([s2.sha256]);

    // a finished draft run is run again (the reviewer has not saved a reference yet)
    repo.jobs.set(first!.id, { ...repo.jobs.get(first!.id)!, status: 'failed' });
    for (const j of res.json().jobs as { id: string }[]) {
      repo.jobs.set(j.id, { ...repo.jobs.get(j.id)!, status: 'succeeded' });
    }
    expect((await propose()).json().jobs).toHaveLength(2);
  });

  it('only counts draft-model runs of samples without a reference', async () => {
    const { app, add, skipAll, stage, repo } = await project();
    await add(1);
    await skipAll();
    const testRun = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/test-runs',
      payload: {},
    });
    expect(testRun.statusCode).toBe(201);
    const [job] = testRun.json().jobs as { id: string; modelOverride: string | null }[];
    expect(job!.modelOverride).toBeNull();
    expect((await stage())!.state).toBe('pending'); // queued 3a run: not a reference run
    repo.jobs.set(job!.id, { ...repo.jobs.get(job!.id)!, status: 'succeeded' });
    expect((await stage())!.state).toBe('pending');
  });

  it('keeps showing a reference run once it is approved', async () => {
    const { app, add, skipAll, propose, repo, rows } = await project();
    await add(1);
    await skipAll();
    const [job] = (await propose()).json().jobs as { id: string }[];
    repo.jobs.set(job!.id, { ...repo.jobs.get(job!.id)!, status: 'awaiting_review' });
    const approve = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job!.id}/approve`,
      payload: {},
    });
    expect(approve.statusCode).toBe(200);
    expect((await rows())[0]!.run).toMatchObject({ jobId: job!.id, status: 'queued' });
    expect((await propose()).json().error).toBe('reference runs are already running');
  });

  it('can be skipped', async () => {
    const { app, add, skipAll, stage } = await project();
    await add(1);
    await skipAll();
    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/stages/references/skip',
    });
    expect(res.statusCode).toBe(201);
    expect((await stage())!.state).toBe('skipped');
  });
});

describe('reference corrections (RF1)', () => {
  const field = (f: string, oldValue: unknown, newValue: unknown) => ({
    field: f,
    table: null,
    row: null,
    column: null,
    oldValue,
    newValue,
  });

  it('derives corrections and the reviewer from the source run, in one review query', async () => {
    const { add, skipAll, reviewed, rows, repo } = await project();
    const s = await add(1);
    await skipAll();
    const { job } = await reviewed(s, [field('sender', 'Acme', 'Acme Ltd')]);
    const spy = vi.spyOn(repo, 'listJobReviews');
    const [row] = await rows();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(row!.reference).toMatchObject({
      sourceJobId: job.id,
      verifiedBy: 'ken',
      corrections: [{ key: 'sender', kind: 'corrected', proposed: 'Acme' }],
      reverified: null,
    });
  });

  it('reports a value the model left empty as entered, and no corrections as []', async () => {
    const { add, skipAll, reviewed, rows } = await project();
    const s1 = await add(1);
    const s2 = await add(2);
    await skipAll();
    await reviewed(s1, [field('sender', null, 'Acme Ltd')]);
    await reviewed(s2, []);
    const [r1, r2] = await rows();
    expect(r1!.reference!.corrections).toEqual([
      { key: 'sender', kind: 'entered', proposed: null },
    ]);
    expect(r2!.reference!.corrections).toEqual([]);
  });

  it('says corrections are unknown once the source run was retried after the save', async () => {
    const { app, add, skipAll, reviewed, rows } = await project();
    const s = await add(1);
    await skipAll();
    const { job } = await reviewed(s, [field('sender', 'Acme', 'Acme Ltd')]);
    expect(
      (await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry` })).statusCode,
    ).toBe(200);
    expect((await rows())[0]!.reference).toMatchObject({ corrections: null, verifiedBy: null });
  });

  it('says corrections are unknown without a source run', async () => {
    const { add, skipAll, rows, repo } = await project();
    const s = await add(1);
    await skipAll();
    const doc = [...repo.documents.values()].find((d) => d.sha256 === s.sha256)!;
    await repo.createReference({
      templateId: 'letter',
      name: 's1',
      documentId: doc.id,
      sourceJobId: null,
      expected: { fields: { sender: 'Acme' }, tables: {} },
    });
    expect((await rows())[0]!.reference).toMatchObject({
      sourceJobId: null,
      verifiedBy: null,
      corrections: null,
    });
  });

  it('reads holdout rows the same way', async () => {
    const { app, add, skipAll, repo } = await project();
    const h = await add(2, 'holdout');
    await skipAll();
    const started = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/holdout/reference-runs',
    });
    const [job] = started.json().jobs as { id: string; documentId: string }[];
    repo.jobs.set(job!.id, { ...repo.jobs.get(job!.id)!, status: 'awaiting_review' });
    await repo.approve(job!.id, 'ken', null);
    repo.jobs.set(job!.id, { ...repo.jobs.get(job!.id)!, status: 'succeeded' });
    await repo.createReference({
      templateId: 'letter',
      name: h.filename,
      documentId: job!.documentId,
      sourceJobId: job!.id,
      expected: { fields: { sender: 'Acme' }, tables: {} },
      templateVersion: 1,
      verifiedOutputs: letter(1).outputs,
    });
    const [row] = (
      await app.inject('/api/workbench/projects/letter/references?set=holdout')
    ).json() as ReferenceRow[];
    expect(row!.reference).toMatchObject({ verifiedBy: 'ken', corrections: [] });
  });
});

describe('reference detail (RF2)', () => {
  const field = (f: string, oldValue: unknown, newValue: unknown) => ({
    field: f,
    table: null,
    row: null,
    column: null,
    oldValue,
    newValue,
  });

  it('returns each output with its provenance, the run that proposed it and its models', async () => {
    const { add, skipAll, reviewed, detail, repo } = await project();
    const s = await add(1);
    await skipAll();
    const { job, reference } = await reviewed(s, [field('sender', 'Acme', 'Acme Ltd')]);
    repo.stepRuns.set(job.id, [
      {
        id: 1,
        stepId: 'head',
        trigger: 'process',
        model: 'local/qwen',
        attempts: 1,
        inputTokens: 1,
        outputTokens: 1,
        status: 'succeeded',
        cached: false,
        error: null,
        startedAt: '2026-10-13T09:00:00.000Z',
        finishedAt: '2026-10-13T09:00:01.000Z',
      },
    ]);
    const res = await detail(s.id);
    expect(res.statusCode).toBe(200);
    const body = res.json() as ReferenceDetail;
    expect(body).toMatchObject({
      sampleId: s.id,
      filename: 's1.pdf',
      role: 'dev',
      reference: { id: reference.id, verifiedBy: 'ken', sourceJobId: job.id },
      run: { jobId: job.id, modelOverride: 'draft', models: ['local/qwen'] },
      corrections: [{ key: 'sender', kind: 'corrected', proposed: 'Acme' }],
    });
    expect(body.values).toEqual([
      {
        id: 'sender',
        kind: 'field',
        value: 'Acme Ltd',
        provenance: 'corrected',
        proposed: 'Acme',
        corrections: [{ key: 'sender', kind: 'corrected', proposed: 'Acme' }],
      },
    ]);
  });

  it('marks values the reviewer typed as entered and untouched ones as model', async () => {
    const { add, skipAll, reviewed, detail } = await project();
    const s1 = await add(1);
    const s2 = await add(2);
    await skipAll();
    await reviewed(s1, [field('sender', null, 'Acme Ltd')]);
    await reviewed(s2, []);
    expect(((await detail(s1.id)).json() as ReferenceDetail).values[0]).toMatchObject({
      provenance: 'entered',
      proposed: null,
    });
    expect(((await detail(s2.id)).json() as ReferenceDetail).values[0]).toMatchObject({
      provenance: 'model',
      proposed: null,
      corrections: [],
    });
  });

  it('serves holdout samples, with null provenance when the corrections are unknown', async () => {
    const { add, skipAll, detail, repo } = await project();
    const h = await add(3, 'holdout');
    await skipAll();
    const doc = [...repo.documents.values()].find((d) => d.sha256 === h.sha256)!;
    await repo.createReference({
      templateId: 'letter',
      name: 'h',
      documentId: doc.id,
      sourceJobId: null,
      expected: { fields: { sender: 'Globex' }, tables: {} },
    });
    const body = (await detail(h.id)).json() as ReferenceDetail;
    expect(body).toMatchObject({ role: 'holdout', run: null, corrections: null });
    expect(body.values[0]).toMatchObject({ value: 'Globex', provenance: null });
  });

  it('gives outputs the reference was not verified for no provenance, not MODEL', async () => {
    const { add, skipAll, propose, detail, repo } = await project();
    const s = await add(1);
    await skipAll();
    const [job] = (await propose()).json().jobs as { id: string; documentId: string }[];
    repo.jobs.set(job!.id, { ...repo.jobs.get(job!.id)!, status: 'awaiting_review' });
    await repo.approve(job!.id, 'ken', null);
    repo.jobs.set(job!.id, { ...repo.jobs.get(job!.id)!, status: 'succeeded' });
    await repo.createReference({
      templateId: 'letter',
      name: 's1',
      documentId: job!.documentId,
      sourceJobId: job!.id,
      expected: { fields: {}, tables: {} },
      templateVersion: 1,
      verifiedOutputs: { fields: [], tables: [] }, // `sender` was added after
    });
    const body = (await detail(s.id)).json() as ReferenceDetail;
    expect(body.reference.outdated).toEqual(['field:sender']);
    expect(body.values[0]).toMatchObject({ id: 'sender', provenance: null, corrections: [] });
  });

  it('runs the review query for the references routes only', async () => {
    const { app, add, skipAll, reviewed, detail, repo } = await project();
    const s = await add(1);
    await skipAll();
    await reviewed(s, []);
    const spy = vi.spyOn(repo, 'listJobReviews');
    await app.inject('/api/workbench/projects/letter/stages');
    await app.inject('/api/workbench/projects/letter/overview');
    expect(spy).not.toHaveBeenCalled();
    await detail(s.id);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it.each([
    [
      'an unknown project',
      '/api/workbench/projects/nope/references/00000000-0000-4000-8000-000000000000',
      'project not found',
    ],
    [
      'an unknown sample',
      '/api/workbench/projects/letter/references/00000000-0000-4000-8000-000000000000',
      'sample not found',
    ],
    ['a malformed sample id', '/api/workbench/projects/letter/references/x', 'sample not found'],
  ])('is a 404 for %s', async (_name, url, error) => {
    const { app } = await project();
    const res = await app.inject(url);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error });
  });

  it('is a 404 for a sample without a reference', async () => {
    const { add, detail } = await project();
    const s = await add(1);
    const res = await detail(s.id);
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'no reference for this sample' });
  });
});
