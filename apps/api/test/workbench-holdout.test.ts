import { describe, expect, it } from 'vitest';
import { outputKey, preparedTriageKey, type FeedbackItem, type SampleView } from '@ih/shared';
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
  const start = (stage: string) =>
    ctx.app.inject({ method: 'POST', url: `/api/workbench/projects/letter/stages/${stage}` });
  const feedback = async (payload: Record<string, unknown>) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/feedback',
      payload,
    });
    expect(res.statusCode).toBe(201);
    return res.json() as FeedbackItem;
  };
  return { ...ctx, add, setRole, verify, finish, evaluate, start, feedback };
}

const holdoutRuns = (ctx: Awaited<ReturnType<typeof project>>) =>
  ctx.app.inject({ method: 'POST', url: '/api/workbench/projects/letter/holdout/reference-runs' });

describe('holdout', () => {
  it('runs the template’s own models on unverified holdout samples, forcing review', async () => {
    const ctx = await project();
    const { app, add, setRole, repo } = ctx;
    await add(1);
    const h = await add(2);
    await setRole(h.id, 'holdout');
    const res = await holdoutRuns(ctx);
    expect(res.statusCode).toBe(201);
    const [job] = res.json().jobs as { id: string; modelOverride: string | null }[];
    expect(job!.modelOverride).toBeNull();
    expect(repo.jobParams.get(job!.id)).toEqual({ dataPolicy: 'local', forceReview: true });
    const rows = (await app.inject('/api/workbench/projects/letter/references?set=holdout')).json();
    expect(rows.map((r: { filename: string }) => r.filename)).toEqual(['s2.pdf']);
    const dev = (await app.inject('/api/workbench/projects/letter/references')).json();
    expect(dev.map((r: { filename: string }) => r.filename)).toEqual(['s1.pdf']);
  });

  it('refuses holdout runs with no holdout samples, or when all are verified', async () => {
    const ctx = await project();
    const { add, setRole, verify } = ctx;
    await add(1);
    const none = await holdoutRuns(ctx);
    expect(none.json().error).toBe('no prepared holdout samples to run');
    const h = await add(2);
    await setRole(h.id, 'holdout');
    await verify(h, 'Acme');
    const done = await holdoutRuns(ctx);
    expect(done.json().error).toBe('every holdout sample already has a reference');
  });

  it('evaluates on holdout, counts each sample’s holdout runs, and never feeds revise', async () => {
    const { app, add, setRole, verify, evaluate, finish, repo, start, feedback } = await project();
    const d = await add(1);
    const h = await add(2);
    await setRole(h.id, 'holdout');
    await verify(d, 'Acme');
    expect((await evaluate({ set: 'holdout' })).json().error).toBe(
      'no verified references for the holdout samples; verify them on the References tab first',
    );
    await verify(h, 'Globex');
    const holdout = (await evaluate({ set: 'holdout' })).json();
    expect(holdout).toMatchObject({ set: 'holdout', total: 1 });
    for (const r of (await repo.listProjectRuns('letter')).filter((x) => x.job.referenceId))
      await finish(r.job.id, 'Wrong');
    const samples = (await app.inject('/api/workbench/projects/letter/samples')).json() as {
      id: string;
      holdoutRuns: number;
    }[];
    expect(samples.find((s) => s.id === h.id)!.holdoutRuns).toBe(1);
    expect(samples.find((s) => s.id === d.id)!.holdoutRuns).toBe(0);
    await feedback({ target: 'field', targetId: 'sender', body: 'Letterhead' });
    const revise = (await start('revise')).json();
    expect((repo.draftJobs.get(revise.id)!.params as { failures: unknown[] }).failures).toEqual([]);
  });

  it('keeps model comparison dev-only', async () => {
    const { app, add, setRole, verify } = await project();
    const h = await add(1);
    await setRole(h.id, 'holdout');
    await verify(h, 'Acme');
    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/evaluations/compare',
      payload: {},
    });
    expect(res.statusCode).toBe(409); // no verified DEV references
  });
});
