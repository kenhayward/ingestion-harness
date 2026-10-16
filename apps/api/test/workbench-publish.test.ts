import { describe, expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { outputKey, preparedTriageKey, type SampleView } from '@ih/shared';
import { MemoryAccessRepo } from '../src/access/repo.js';
import { letter, multipart, seedModelChoices, signInNewUser, testApp } from './helpers.js';

const pdf = (n: number) =>
  Buffer.from(`%PDF-1.7
% sample ${n}
%%EOF
`);

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
  const setRole = (sid: string, role: 'dev' | 'holdout') =>
    ctx.app.inject({
      method: 'PATCH',
      url: `/api/workbench/projects/letter/samples/${sid}`,
      payload: { role },
    });
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
        targetId: null,
      },
    ]);
    ctx.repo.jobs.set(jobId, { ...job, status: 'succeeded' });
  };
  const evaluate = (payload: Record<string, unknown> = {}) =>
    ctx.app.inject({ method: 'POST', url: '/api/workbench/projects/letter/evaluations', payload });
  return { ...ctx, add, setRole, verify, finish, evaluate };
}

type Ctx = Awaited<ReturnType<typeof project>>;

/** A complete holdout evaluation of the open draft, its one run returning `sender`. */
async function holdoutRun(ctx: Ctx, sender: string) {
  const h = await ctx.add(9);
  await ctx.setRole(h.id, 'holdout');
  await ctx.verify(h, 'Acme');
  const iteration = (await ctx.evaluate({ set: 'holdout' })).json();
  const [run] = (await ctx.repo.listProjectRuns('letter')).filter((r) => r.job.referenceId);
  await ctx.finish(run!.job.id, sender);
  return iteration as { id: string };
}

const publish = (ctx: Ctx, payload: object = {}) =>
  ctx.app.inject({ method: 'POST', url: '/api/workbench/projects/letter/publish', payload });

describe('publish gate', () => {
  it('publishes when the holdout run of the current draft meets the threshold', async () => {
    const ctx = await project();
    const iteration = await holdoutRun(ctx, 'Acme');
    const gate = (await ctx.app.inject('/api/workbench/projects/letter/publish-gate')).json();
    expect(gate).toMatchObject({ iterationId: iteration.id, passes: true, score: 1 });
    const res = await publish(ctx, { overrideReason: 'not needed but harmless here' });
    expect(res.statusCode).toBe(201);
    expect(res.json().publication).toMatchObject({
      version: 1,
      iterationId: iteration.id,
      score: 1,
      threshold: 0.9,
      overrideReason: null,
    });
    expect((await ctx.templates.get('letter', 1))!.status).toBe('published');
  });

  it('publishes below the threshold: the gate is informational, no override needed', async () => {
    const ctx = await project();
    const iteration = await holdoutRun(ctx, 'Wrong');
    const res = await publish(ctx);
    expect(res.statusCode).toBe(201);
    expect(res.json().publication).toMatchObject({
      version: 1,
      iterationId: iteration.id,
      score: 0,
      threshold: 0.9,
      overrideReason: null,
    });
    expect((await ctx.templates.get('letter', 1))!.status).toBe('published');
  });

  it('publishes before any reference or evaluation exists, and records no override', async () => {
    const ctx = await project();
    const res = await publish(ctx, { overrideReason: 'ignored: there is no gate to override' });
    expect(res.statusCode).toBe(201);
    expect(res.json().publication).toMatchObject({
      version: 1,
      iterationId: null,
      score: null,
      overrideReason: null,
    });
    const [logged] = (await ctx.app.inject('/api/workbench/projects/letter/publications')).json();
    expect(logged).toMatchObject({ version: 1, overrideReason: null });
  });

  it('sets the label and note given on the version it publishes (#144)', async () => {
    const ctx = await project();
    const res = await publish(ctx, { label: 'First release', note: 'Signed off by finance' });
    expect(res.statusCode).toBe(201);
    expect(await ctx.templates.get('letter', 1)).toMatchObject({
      status: 'published',
      label: 'First release',
      note: 'Signed off by finance',
    });
    expect((await publish(ctx, { label: ' ' })).statusCode).toBe(400);
  });

  it('does not count a holdout run of an earlier draft', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Acme');
    await ctx.templates.updateDraft('letter', 1, { ...letter(1), name: 'Edited after the run' });
    const gate = (await ctx.app.inject('/api/workbench/projects/letter/publish-gate')).json();
    expect(gate).toMatchObject({
      passes: false,
      reason: 'no complete holdout evaluation of the current draft',
    });
    expect((await publish(ctx)).statusCode).toBe(201);
  });

  it('changes the threshold within [0, 1]', async () => {
    const ctx = await project();
    const patch = (publishThreshold: number) =>
      ctx.app.inject({
        method: 'PATCH',
        url: '/api/workbench/projects/letter',
        payload: { publishThreshold },
      });
    expect((await patch(0.5)).json().project.publishThreshold).toBe(0.5);
    expect((await patch(1.5)).statusCode).toBe(400);
    await holdoutRun(ctx, 'Wrong');
    await patch(0);
    expect((await publish(ctx)).statusCode).toBe(201);
  });

  it('records who changed the threshold, and when', async () => {
    const access = new MemoryAccessRepo();
    const { app, workbench } = await testApp({ access });
    await workbench.createProject('letter', 'Letter');
    const { cookie } = await signInNewUser(app, access, 'ken');
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/workbench/projects/letter',
      payload: { publishThreshold: 0.8 },
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().project.thresholdSetBy).toBe('ken');
    const view = (
      await app.inject({ url: '/api/workbench/projects/letter', headers: { cookie } })
    ).json();
    expect(view.project).toMatchObject({ publishThreshold: 0.8, thresholdSetBy: 'ken' });
    expect(Number.isNaN(Date.parse(view.project.thresholdSetAt))).toBe(false);
  });

  it('records no actor for the threshold without access control', async () => {
    const ctx = await project();
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/workbench/projects/letter',
      payload: { publishThreshold: 0.8 },
    });
    expect(res.json().project).toMatchObject({ thresholdSetBy: null });
    expect(res.json().project.thresholdSetAt).not.toBeNull();
  });

  it('publishes and records the publication in one repo call', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Acme');
    const publishDraft = vi.spyOn(ctx.workbench, 'publishDraft');
    expect((await publish(ctx)).statusCode).toBe(201);
    expect(publishDraft).toHaveBeenCalledOnce();
    expect(publishDraft.mock.calls[0]![0]).toMatchObject({
      projectId: 'letter',
      version: 1,
      definition: letter(1),
      publication: { projectId: 'letter', version: 1, overrideReason: null, publishedBy: null },
    });
  });

  it('refuses publishing a workbench type from the Templates page', async () => {
    const ctx = await project();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/templates/letter/versions/1/publish',
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('publish letter from the Workbench (holdout gate)');
  });

  it('refuses importing a workbench type straight to published, but imports a draft', async () => {
    const ctx = await project();
    const yaml = (version: number) => stringify(letter(version));
    const published = await ctx.app.inject({
      method: 'POST',
      url: '/api/templates/import',
      payload: { yaml: yaml(2), publish: true },
    });
    expect(published.statusCode).toBe(409);
    expect(published.json().error).toBe('publish letter from the Workbench (holdout gate)');
    expect(await ctx.templates.get('letter', 2)).toBeNull();
    const draft = await ctx.app.inject({
      method: 'POST',
      url: '/api/templates/import',
      payload: { yaml: yaml(3) },
    });
    expect(draft.statusCode).toBe(201);
    expect(draft.json().record).toMatchObject({ version: 3, status: 'draft' });
  });

  it('has no gate and refuses publishing without an open draft', async () => {
    const ctx = await project();
    await ctx.templates.publish('letter', 1);
    const gate = (await ctx.app.inject('/api/workbench/projects/letter/publish-gate')).json();
    expect(gate).toEqual({
      threshold: 0.9,
      iterationId: null,
      score: null,
      passes: false,
      reason: 'no open draft to publish',
      hints: [],
    });
    const res = await publish(ctx, { overrideReason: 'An override cannot help here' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no open draft to publish');
  });

  it('refuses publishing an invalid draft, even with an override', async () => {
    const ctx = await project();
    await ctx.templates.updateDraft('letter', 1, { ...letter(1), pipeline: [] });
    const res = await publish(ctx, { overrideReason: 'An override cannot help here' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('the draft is not valid');
    expect((await ctx.templates.get('letter', 1))!.status).toBe('draft');
    expect((await ctx.app.inject('/api/workbench/projects/letter/publications')).json()).toEqual(
      [],
    );
  });

  it('refuses a draft naming a publishing target this deployment lacks', async () => {
    const ctx = await project();
    await ctx.templates.updateDraft('letter', 1, {
      ...letter(1),
      delivery: { publishTo: 'nope' },
    });
    const res = await publish(ctx);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toEqual({
      error: 'the draft is not valid',
      issues: [
        { path: 'delivery.publishTo', message: 'no publishing target nope on this deployment' },
      ],
    });
    expect((await ctx.templates.get('letter', 1))!.status).toBe('draft');
  });

  it('does not count a holdout run of another version with the same definition', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Acme');
    await ctx.templates.publish('letter', 1);
    await ctx.templates.create('letter', 2, letter(1), 'draft'); // identical definition
    const gate = (await ctx.app.inject('/api/workbench/projects/letter/publish-gate')).json();
    expect(gate).toMatchObject({
      iterationId: null,
      passes: false,
      reason: 'no complete holdout evaluation of the current draft',
    });
  });

  it('returns 404 for the settings of an unknown project', async () => {
    const ctx = await project();
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/workbench/projects/nope',
      payload: { publishThreshold: 0.5 },
    });
    expect(res.statusCode).toBe(404);
  });
});

/** Holdout samples 9, 10, …; the first `verified` of them get a reference with sender Acme. */
async function holdoutSamples(ctx: Ctx, count: number, verified = count) {
  const samples: SampleView[] = [];
  for (let n = 0; n < count; n++) {
    const s = await ctx.add(9 + n);
    await ctx.setRole(s.id, 'holdout');
    if (n < verified) await ctx.verify(s, 'Acme');
    samples.push(s);
  }
  return samples;
}

/** The evaluation jobs of the project (those with a reference), with their sample's sha256. */
const evaluationRuns = async (ctx: Ctx) =>
  (await ctx.repo.listProjectRuns('letter')).filter((r) => r.job.referenceId);

const gateOf = async (ctx: Ctx) =>
  (await ctx.app.inject('/api/workbench/projects/letter/publish-gate')).json();

describe('publish gate honesty', () => {
  it('fails when a holdout sample was not compared (its job needs review)', async () => {
    const ctx = await project();
    const [a, b] = await holdoutSamples(ctx, 2);
    const iteration = (await ctx.evaluate({ set: 'holdout' })).json();
    const runs = await evaluationRuns(ctx);
    await ctx.finish(runs.find((r) => r.sha256 === a!.sha256)!.job.id, 'Acme');
    const stuck = runs.find((r) => r.sha256 === b!.sha256)!.job.id;
    ctx.repo.jobs.set(stuck, { ...ctx.repo.jobs.get(stuck)!, status: 'needs_review' });
    expect(await gateOf(ctx)).toMatchObject({
      iterationId: iteration.id,
      score: 1,
      passes: false,
      reason: 'holdout evaluation compared 1 of 2 samples',
    });
    expect((await publish(ctx)).json().publication).toMatchObject({
      score: 1,
      overrideReason: null,
    });
  });

  it('fails when an evaluated holdout job was deleted, and keeps its holdout history', async () => {
    const ctx = await project();
    const [h] = await holdoutSamples(ctx, 1);
    await ctx.evaluate({ set: 'holdout' });
    const [run] = await evaluationRuns(ctx);
    await ctx.finish(run!.job.id, 'Acme');
    const deleted = await ctx.app.inject({ method: 'DELETE', url: `/api/jobs/${run!.job.id}` });
    expect(deleted.statusCode).toBe(204);
    expect(await gateOf(ctx)).toMatchObject({
      passes: false,
      reason: 'holdout evaluation compared 0 of 1 samples',
    });
    const samples = (
      await ctx.app.inject('/api/workbench/projects/letter/samples')
    ).json() as SampleView[];
    expect(samples.find((s) => s.id === h!.id)!.holdoutRuns).toBe(1);
  });

  it('ignores a holdout evaluation with a model override', async () => {
    const ctx = await project();
    await holdoutSamples(ctx, 1);
    expect((await ctx.evaluate({ set: 'holdout', model: 'fast' })).statusCode).toBe(201);
    const [run] = await evaluationRuns(ctx);
    await ctx.finish(run!.job.id, 'Acme');
    expect(await gateOf(ctx)).toMatchObject({
      iterationId: null,
      passes: false,
      reason: 'no complete holdout evaluation of the current draft',
    });
  });

  it('fails when the evaluation did not cover every ready holdout sample', async () => {
    const ctx = await project();
    await holdoutSamples(ctx, 2, 1);
    await ctx.evaluate({ set: 'holdout' });
    const [run] = await evaluationRuns(ctx);
    await ctx.finish(run!.job.id, 'Acme');
    expect(await gateOf(ctx)).toMatchObject({
      score: 1,
      passes: false,
      reason: 'holdout evaluation covered 1 of 2 holdout samples',
    });
  });

  it('scores the raw holdout output: a review edit does not raise the gate score', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Wrong');
    const [run] = await evaluationRuns(ctx);
    await ctx.store.put(
      'runs',
      `${run!.job.id}/reviewed-document.json`,
      Buffer.from(JSON.stringify({ fields: { sender: { value: 'Acme' } }, tables: {} })),
      'application/json',
    );
    expect(await gateOf(ctx)).toMatchObject({ score: 0, passes: false });
  });

  it('recomputes the score instead of trusting the cached one', async () => {
    const ctx = await project();
    const iteration = await holdoutRun(ctx, 'Wrong');
    expect((await gateOf(ctx)).score).toBe(0);
    await ctx.workbench.setIterationScores(iteration.id, { score: 1, completed: 1, total: 1 });
    expect(await gateOf(ctx)).toMatchObject({ score: 0, passes: false });
  });

  it('refuses to publish when the draft changed while the gate was checked', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Acme');
    const list = ctx.workbench.listIterations.bind(ctx.workbench);
    let edited = false;
    ctx.workbench.listIterations = async (projectId: string) => {
      if (!edited) {
        edited = true;
        await ctx.templates.updateDraft('letter', 1, { ...letter(1), name: 'Edited meanwhile' });
      }
      return list(projectId);
    };
    const res = await publish(ctx);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('the draft changed while publishing; check the gate again');
    expect((await ctx.templates.get('letter', 1))!.status).toBe('draft');
  });

  it('refuses to publish when the draft was published while the gate was checked', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Acme');
    const list = ctx.workbench.listIterations.bind(ctx.workbench);
    let published = false;
    ctx.workbench.listIterations = async (projectId: string) => {
      if (!published) {
        published = true;
        await ctx.templates.publish('letter', 1);
      }
      return list(projectId);
    };
    const res = await publish(ctx);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no open draft to publish');
    expect(await ctx.workbench.listPublications('letter')).toEqual([]);
  });
});

/** Counts reads of the outputs bucket (where evaluation documents live). */
function countDocumentReads(ctx: Ctx) {
  const get = ctx.store.get.bind(ctx.store);
  const reads = { count: 0 };
  vi.spyOn(ctx.store, 'get').mockImplementation(async (bucket: string, key: string) => {
    if (bucket === 'outputs') reads.count++;
    return get(bucket, key);
  });
  return reads;
}

describe('publish gate score cache', () => {
  it('reads no job documents when nothing about the iteration changed', async () => {
    const ctx = await project();
    const iteration = await holdoutRun(ctx, 'Acme');
    const reads = countDocumentReads(ctx);
    const first = await gateOf(ctx);
    expect(first).toMatchObject({ iterationId: iteration.id, score: 1, passes: true });
    expect(reads.count).toBeGreaterThan(0);
    reads.count = 0;
    expect(await gateOf(ctx)).toEqual(first);
    expect(reads.count).toBe(0);
  });

  it('serves the hints from the cache too', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Wrong');
    const reads = countDocumentReads(ctx);
    const first = await gateOf(ctx);
    expect(first.hints).toHaveLength(1);
    reads.count = 0;
    expect(await gateOf(ctx)).toEqual(first);
    expect(reads.count).toBe(0);
  });

  it('recomputes the hints of a cache row stored without them', async () => {
    const ctx = await project();
    const iteration = await holdoutRun(ctx, 'Wrong');
    const first = await gateOf(ctx);
    const { fingerprint, score, completed, total } = (await ctx.app.deps.workbench.getIteration(
      'letter',
      iteration.id,
    ))!.gateCache!;
    await ctx.app.deps.workbench.setGateCache(iteration.id, {
      fingerprint,
      score,
      completed,
      total,
    });
    const reads = countDocumentReads(ctx);
    expect(await gateOf(ctx)).toEqual(first);
    expect(reads.count).toBeGreaterThan(0);
    reads.count = 0;
    expect(await gateOf(ctx)).toEqual(first);
    expect(reads.count).toBe(0);
  });

  it('recomputes the hints when the threshold changed', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Wrong');
    await gateOf(ctx);
    await ctx.app.inject({
      method: 'PATCH',
      url: '/api/workbench/projects/letter',
      payload: { publishThreshold: 0 },
    });
    expect((await gateOf(ctx)).hints).toEqual([]);
  });

  it('keeps coverage live on a cache hit', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Acme');
    expect((await gateOf(ctx)).passes).toBe(true);
    const late = await ctx.add(20);
    await ctx.setRole(late.id, 'holdout');
    expect(await gateOf(ctx)).toMatchObject({
      score: 1,
      passes: false,
      reason: 'holdout evaluation covered 1 of 2 holdout samples',
    });
  });

  it('does not cache while a job awaits review', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Acme');
    const [run] = await evaluationRuns(ctx);
    const job = ctx.repo.jobs.get(run!.job.id)!;
    ctx.repo.jobs.set(job.id, { ...job, status: 'awaiting_review' });
    const reads = countDocumentReads(ctx);
    expect((await gateOf(ctx)).score).toBe(1);
    reads.count = 0;
    expect((await gateOf(ctx)).score).toBe(1);
    expect(reads.count).toBeGreaterThan(0);
  });

  it('recomputes after an evaluated job was deleted', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Acme');
    expect((await gateOf(ctx)).passes).toBe(true);
    const [run] = await evaluationRuns(ctx);
    const deleted = await ctx.app.inject({ method: 'DELETE', url: `/api/jobs/${run!.job.id}` });
    expect(deleted.statusCode).toBe(204);
    expect(await gateOf(ctx)).toMatchObject({
      passes: false,
      reason: 'holdout evaluation compared 0 of 1 samples',
    });
  });

  it('recomputes after a job changed status (a re-run)', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Acme');
    expect((await gateOf(ctx)).passes).toBe(true);
    const [run] = await evaluationRuns(ctx);
    const id = run!.job.id;
    ctx.repo.jobs.set(id, { ...ctx.repo.jobs.get(id)!, status: 'needs_review' });
    expect(await gateOf(ctx)).toMatchObject({
      passes: false,
      reason: 'holdout evaluation compared 0 of 1 samples',
    });
  });

  it('recomputes when a job was updated, even back to the same status', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Acme');
    expect((await gateOf(ctx)).passes).toBe(true);
    const [run] = await evaluationRuns(ctx);
    const id = run!.job.id;
    // A re-run that succeeds again, with another answer, at a later time.
    await ctx.finish(id, 'Wrong');
    ctx.repo.jobs.set(id, { ...ctx.repo.jobs.get(id)!, updatedAt: '2099-01-01T00:00:00.000Z' });
    expect(await gateOf(ctx)).toMatchObject({ score: 0, passes: false });
  });

  it('recomputes when a job lost its reference (an unpinned reference was deleted)', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Acme');
    expect((await gateOf(ctx)).passes).toBe(true);
    const [run] = await evaluationRuns(ctx);
    const id = run!.job.id;
    ctx.repo.jobs.set(id, { ...ctx.repo.jobs.get(id)!, referenceId: null });
    expect(await gateOf(ctx)).toMatchObject({
      passes: false,
      reason: 'holdout evaluation compared 0 of 1 samples',
    });
  });

  it('still scores the raw output after a review edit once cached', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Wrong');
    expect((await gateOf(ctx)).score).toBe(0);
    const [run] = await evaluationRuns(ctx);
    await ctx.store.put(
      'runs',
      `${run!.job.id}/reviewed-document.json`,
      Buffer.from(JSON.stringify({ fields: { sender: { value: 'Acme' } }, tables: {} })),
      'application/json',
    );
    expect(await gateOf(ctx)).toMatchObject({ score: 0, passes: false });
  });
});

describe('publish gate hints (EV1)', () => {
  it('has no hints without a deciding holdout run', async () => {
    const ctx = await project();
    expect(await gateOf(ctx)).toMatchObject({ iterationId: null, hints: [] });
  });

  it('has no hints when every output meets the threshold', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Acme');
    expect(await gateOf(ctx)).toMatchObject({ passes: true, hints: [] });
  });

  it('names an output the run gets wrong, fixed with Revise', async () => {
    const ctx = await project();
    const iteration = await holdoutRun(ctx, 'Wrong');
    expect(await gateOf(ctx)).toMatchObject({
      iterationId: iteration.id,
      passes: false,
      hints: [{ key: 'sender', accuracy: 0, cause: 'low_accuracy', stage: 'revise' }],
    });
  });

  it('names a referenced value no step of the draft fills, fixed on Steps', async () => {
    const ctx = await project();
    const h = await ctx.add(9);
    await ctx.setRole(h.id, 'holdout');
    // An unpinned reference (as legacy ones are) can hold a value the draft has no output for.
    const job = await ctx.repo.createWorkbenchJob(
      {
        id: crypto.randomUUID(),
        filename: h.filename,
        sha256: h.sha256,
        sizeBytes: 1,
        specId: 'letter',
        specVersion: 1,
        bucket: 'inbox',
        objectKey: `letter/${h.id}`,
      },
      { projectId: 'letter', task: 'process' },
    );
    await ctx.repo.createReference({
      templateId: 'letter',
      name: h.filename,
      documentId: job.documentId,
      sourceJobId: job.id,
      expected: { fields: { sender: 'Acme', due_date: '2026-10-03' }, tables: {} },
    });
    await ctx.evaluate({ set: 'holdout' });
    const [run] = (await ctx.repo.listProjectRuns('letter')).filter((r) => r.job.referenceId);
    await ctx.finish(run!.job.id, 'Acme');
    expect(await gateOf(ctx)).toMatchObject({
      score: 0.5,
      hints: [{ key: 'due_date', accuracy: 0, cause: 'no_step', stage: 'steps' }],
    });
  });
});
