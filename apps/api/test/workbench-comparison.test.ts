import { describe, expect, it, vi } from 'vitest';
import {
  outputKey,
  preparedTriageKey,
  type ComparisonView,
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

describe('model comparison and uncached evaluations', () => {
  it('marks uncached evaluations and passes the flag to the jobs', async () => {
    const { add, verify, evaluate, repo } = await project();
    await verify(await add(1), 'Acme');
    const iteration = (await evaluate({ uncached: true })).json() as IterationView;
    expect(iteration).toMatchObject({ uncached: true, groupId: null });
    const [run] = (await repo.listProjectRuns('letter')).filter((r) => r.job.referenceId);
    expect(repo.jobParams.get(run!.job.id)).toEqual({
      dataPolicy: 'local',
      uncached: true,
      outputs: letter(1).outputs,
    });
  });

  it('starts one iteration per model and lines them up', async () => {
    const { app, add, verify } = await project();
    await verify(await add(1), 'Acme');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/evaluations/compare',
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    const comparison = res.json() as ComparisonView;
    // Every choice the local-only project may use, the default first (the external one is out).
    expect(comparison.iterations.map((i) => i.model)).toEqual(['main', 'fast']);
    expect(new Set(comparison.iterations.map((i) => i.groupId))).toEqual(
      new Set([comparison.groupId]),
    );
    const again = (
      await app.inject(`/api/workbench/projects/letter/comparisons/${comparison.groupId}`)
    ).json() as ComparisonView;
    expect(again.iterations.map((i) => i.id)).toEqual(comparison.iterations.map((i) => i.id));
    expect(
      (await app.inject(`/api/workbench/projects/letter/comparisons/${crypto.randomUUID()}`))
        .statusCode,
    ).toBe(404);
  });

  it('checks the project, draft and references once for the whole comparison', async () => {
    const { app, add, verify, workbench } = await project();
    await verify(await add(1), 'Acme');
    const getProject = vi.spyOn(workbench, 'getProject');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/evaluations/compare',
      payload: {},
    });
    expect(res.statusCode).toBe(201);
    expect(getProject).toHaveBeenCalledTimes(1);
  });

  it('refuses a comparison exactly like an evaluation, and starts nothing', async () => {
    const { app, add, evaluate, workbench } = await project();
    await add(1); // a dev sample without a verified reference
    const compare = (payload: Record<string, unknown>) =>
      app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/evaluations/compare',
        payload,
      });
    const refused = await compare({});
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual((await evaluate()).json());
    expect(refused.json().error).toMatch(/no verified references/);
    expect(await workbench.listIterations('letter')).toEqual([]);
    expect((await compare({ uncached: true, model: 'fast' })).statusCode).toBe(400);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/nope/evaluations/compare',
      payload: {},
    });
    expect([missing.statusCode, missing.json()]).toEqual([404, { error: 'project not found' }]);
  });

  it('still completes when one model is refused by the data policy', async () => {
    const { app, add, verify, finish, repo } = await project();
    await verify(await add(1), 'Acme');
    const comparison = (
      await app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/evaluations/compare',
        payload: {},
      })
    ).json() as ComparisonView;
    const jobs = (await repo.listProjectRuns('letter'))
      .filter((r) => r.job.referenceId)
      .map((r) => r.job);
    for (const job of jobs) {
      if (job.modelOverride === 'fast') {
        repo.jobs.set(job.id, {
          ...job,
          status: 'needs_review',
          error: 'data policy: project is local-only',
        });
      } else {
        await finish(job.id, 'Acme');
      }
    }
    const view = (
      await app.inject(`/api/workbench/projects/letter/comparisons/${comparison.groupId}`)
    ).json() as ComparisonView;
    expect(view.iterations.map((i) => [i.model, i.status, i.score])).toEqual([
      ['main', 'complete', 1],
      ['fast', 'complete', null],
    ]);
  });

  it('counts step runs served from the cache', async () => {
    const { add, verify, finish, evaluate, view, repo } = await project();
    await verify(await add(1), 'Acme');
    const iteration = (await evaluate()).json() as IterationView;
    const [run] = (await repo.listProjectRuns('letter')).filter((r) => r.job.referenceId);
    await finish(run!.job.id, 'Acme');
    const base = {
      trigger: 'process' as const,
      model: 'local/qwen',
      attempts: 0,
      inputTokens: null,
      outputTokens: null,
      error: null,
      startedAt: '',
      finishedAt: '',
    };
    repo.stepRuns.set(run!.job.id, [
      { ...base, id: 1, stepId: 'head', status: 'succeeded', cached: true },
      { ...base, id: 2, stepId: 'tail', status: 'succeeded', cached: false },
      { ...base, id: 3, stepId: 'oops', status: 'failed', cached: false },
    ]);
    expect((await view(iteration.id)).cache).toEqual({ reused: 1, total: 2 });
  });
});
