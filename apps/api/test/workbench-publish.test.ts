import { describe, expect, it } from 'vitest';
import { stringify } from 'yaml';
import { outputKey, preparedTriageKey, type SampleView } from '@ih/shared';
import { letter, multipart, testApp } from './helpers.js';

const pdf = (n: number) =>
  Buffer.from(`%PDF-1.7
% sample ${n}
%%EOF
`);

async function project() {
  const ctx = await testApp();
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

  it('needs an override below the threshold and records it', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Wrong');
    const refused = await publish(ctx);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe(
      'holdout score 0% is below the threshold 90%; give an override reason to publish anyway',
    );
    const res = await publish(ctx, {
      overrideReason: 'Scan quality on the holdout sample is unusable',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().publication.overrideReason).toBe(
      'Scan quality on the holdout sample is unusable',
    );
    const [logged] = (await ctx.app.inject('/api/workbench/projects/letter/publications')).json();
    expect(logged.overrideReason).toBe('Scan quality on the holdout sample is unusable');
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
    expect((await publish(ctx)).statusCode).toBe(409);
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
