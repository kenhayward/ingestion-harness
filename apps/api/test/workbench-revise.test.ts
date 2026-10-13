import { describe, expect, it, vi } from 'vitest';
import {
  draftingKey,
  MAX_CONTEXT_SAMPLES,
  outputKey,
  preparedTriageKey,
  type FeedbackItem,
  type RevisePreview,
  type SampleView,
} from '@ih/shared';
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
  /** Marks a draft job succeeded with `body` as its proposal. */
  const finishDraft = async (id: string, stage: string, body: unknown) => {
    ctx.repo.draftJobs.set(id, { ...ctx.repo.draftJobs.get(id)!, status: 'succeeded' });
    const result = { stage, model: 'local/big', body, usage: { inputTokens: 1, outputTokens: 1 } };
    await ctx.store.put(
      'runs',
      draftingKey('letter', id),
      Buffer.from(JSON.stringify(result)),
      'application/json',
    );
  };
  const decide = (id: string, payload: Record<string, unknown>) =>
    ctx.app.inject({
      method: 'POST',
      url: `/api/workbench/projects/letter/proposals/${id}/decision`,
      payload,
    });
  const feedback = async (payload: Record<string, unknown>) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/feedback',
      payload,
    });
    expect(res.statusCode).toBe(201);
    return res.json() as FeedbackItem;
  };
  return {
    ...ctx,
    add,
    setRole,
    verify,
    finish,
    evaluate,
    start,
    finishDraft,
    decide,
    feedback,
  };
}

const paramsOf = (ctx: Awaited<ReturnType<typeof project>>, id: string) =>
  ctx.repo.draftJobs.get(id)!.params as Record<string, unknown>;

describe('feedback', () => {
  it('only refers to dev samples', async () => {
    const { app, add, setRole } = await project();
    const dev = await add(1);
    const hold = await add(2);
    await setRole(hold.id, 'holdout');
    const post = (payload: object) =>
      app.inject({ method: 'POST', url: '/api/workbench/projects/letter/feedback', payload });
    expect(
      (await post({ target: 'field', targetId: 'sender', body: 'Letterhead', sampleId: dev.id }))
        .statusCode,
    ).toBe(201);
    const refused = await post({
      target: 'field',
      targetId: 'sender',
      body: 'x',
      sampleId: hold.id,
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toBe('feedback can only refer to dev samples');
    const unknown = await post({
      target: 'field',
      targetId: 'sender',
      body: 'x',
      sampleId: crypto.randomUUID(),
    });
    expect(unknown.json().error).toBe('feedback can only refer to dev samples');
    const iteration = await post({
      target: 'field',
      targetId: 'sender',
      body: 'x',
      iterationId: crypto.randomUUID(),
    });
    expect(iteration.statusCode).toBe(400);
    expect(iteration.json().error).toBe('unknown iteration');
    expect((await post({ target: 'field', targetId: 'sender', body: '  ' })).statusCode).toBe(400);
    expect(
      (await post({ target: 'field', targetId: 'sender', body: 'x', sampleId: 'nope' })).statusCode,
    ).toBe(400);
  });

  it('only refers to dev iterations', async () => {
    const { app, workbench } = await project();
    // The schema allows holdout iterations (eval_set); feedback must never point at one.
    const holdout = await workbench.createIteration({
      projectId: 'letter',
      templateVersion: 1,
      definition: {},
      briefVersion: null,
      set: 'holdout' as unknown as 'dev', // not producible through the routes yet
      model: null,
      jobIds: [],
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/feedback',
      payload: { target: 'field', targetId: 'sender', body: 'x', iterationId: holdout.id },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('feedback can only refer to dev iterations');
  });

  it('records the iteration it refers to and lists newest first', async () => {
    const { app, add, verify, evaluate, feedback } = await project();
    await verify(await add(1), 'Acme');
    const iteration = (await evaluate()).json() as { id: string };
    const first = await feedback({ target: 'step', targetId: 'head', body: 'one' });
    const second = await feedback({
      target: 'table',
      targetId: 'items',
      body: 'two',
      iterationId: iteration.id,
    });
    expect(second).toMatchObject({ iterationId: iteration.id, resolvedBy: null });
    const list = (await app.inject('/api/workbench/projects/letter/feedback')).json() as {
      id: string;
    }[];
    expect(list.map((f) => f.id)).toEqual([second.id, first.id]);
    expect((await app.inject('/api/workbench/projects/nope/feedback')).statusCode).toBe(404);
  });

  it('deletes open feedback only', async () => {
    const { app, feedback, workbench, repo } = await project();
    const f = await feedback({ target: 'step', targetId: 'head', body: 'Read the letterhead' });
    const job = await repo.createDraftJob('letter', {});
    await workbench.createProposal({
      id: job.id,
      projectId: 'letter',
      stage: 'revise',
      briefVersion: null,
      feedbackIds: [f.id],
    });
    await workbench.resolveFeedback('letter', [f.id], job.id);
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/workbench/projects/letter/feedback/${f.id}`,
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('resolved feedback cannot be deleted');

    const open = await feedback({ target: 'step', targetId: 'head', body: 'Again' });
    const del = (fid: string) =>
      app.inject({ method: 'DELETE', url: `/api/workbench/projects/letter/feedback/${fid}` });
    expect((await del(open.id)).statusCode).toBe(204);
    expect((await del(open.id)).statusCode).toBe(404);
    expect((await del('not-a-uuid')).statusCode).toBe(404);
  });

  it('refuses a holdout iteration made through the routes (RV3)', async () => {
    const { app, add, setRole, verify, evaluate } = await project();
    const h = await add(1);
    await setRole(h.id, 'holdout');
    await verify(h, 'Acme');
    const run = await evaluate({ set: 'holdout' });
    expect(run.statusCode).toBe(201);
    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/feedback',
      payload: {
        target: 'field',
        targetId: 'sender',
        body: 'x',
        iterationId: (run.json() as { id: string }).id,
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('feedback can only refer to dev iterations');
    expect((await app.inject('/api/workbench/projects/letter/feedback')).json()).toEqual([]);
  });
});

describe('revise', () => {
  it('needs open feedback and an open draft, and is never blocked by the stage order', async () => {
    const { start, feedback, templates } = await project();
    const none = await start('revise');
    expect(none.statusCode).toBe(409);
    expect(none.json().error).toBe('add feedback before asking for a revision');
    await feedback({ target: 'field', targetId: 'sender', body: 'Letterhead' });
    expect((await start('revise')).statusCode).toBe(202); // survey not done: revise is outside the order
    await templates.publish('letter', 1);
    const closed = await start('revise');
    expect(closed.statusCode).toBe(409);
    expect(closed.json().error).toBe('no open draft; start the next version on the Template tab');
  });

  it('sends open feedback and dev-only failures from the latest complete evaluation', async () => {
    const ctx = await project();
    const { start, feedback, repo, add, verify, evaluate, finish, setRole, workbench } = ctx;
    const a = await add(1);
    const b = await add(2);
    await verify(a, 'Acme');
    await verify(b, 'Globex');
    await evaluate();
    const runs = (await repo.listProjectRuns('letter'))
      .filter((r) => r.job.referenceId)
      .map((r) => r.job);
    for (const job of runs) await finish(job.id, 'Wrong');
    await setRole(b.id, 'holdout'); // switched after the evaluation: must not be sent
    const fb = await feedback({
      target: 'field',
      targetId: 'sender',
      body: 'Letterhead',
      sampleId: a.id,
    });
    const res = await start('revise');
    const params = paramsOf(ctx, res.json().id);
    expect(params.feedback).toEqual([
      { id: fb.id, target: 'field', targetId: 'sender', sample: 's1.pdf', body: 'Letterhead' },
    ]);
    expect((params.failures as { sample: string }[]).map((f) => f.sample)).toEqual(['s1.pdf']);
    expect(params.feedbackIds).toHaveLength(1);
    expect((params.samples as { filename: string }[]).map((s) => s.filename)).toEqual(['s1.pdf']);
    const [proposal] = await workbench.listProposals('letter');
    expect(proposal!.feedbackIds).toEqual(params.feedbackIds);
  });

  it('ignores a running evaluation and uses the latest complete one', async () => {
    const ctx = await project();
    const { start, feedback, repo, add, verify, evaluate, finish } = ctx;
    await verify(await add(1), 'Acme');
    await evaluate();
    const [first] = (await repo.listProjectRuns('letter')).filter((r) => r.job.referenceId);
    await finish(first!.job.id, 'Wrong');
    await evaluate(); // still running
    await feedback({ target: 'field', targetId: 'sender', body: 'Letterhead' });
    const params = paramsOf(ctx, (await start('revise')).json().id);
    expect(params.failures).toEqual([
      {
        sample: 's1.pdf',
        score: 0,
        fields: [{ id: 'sender', expected: 'Acme', actual: 'Wrong' }],
        tables: [],
      },
    ]);
  });

  it('drops feedback that names a sample switched to holdout', async () => {
    const ctx = await project();
    const { start, feedback, add, setRole } = ctx;
    const a = await add(1);
    const b = await add(2);
    await feedback({ target: 'field', targetId: 'sender', body: 'On a', sampleId: a.id });
    const onB = await feedback({
      target: 'field',
      targetId: 'sender',
      body: 'On b',
      sampleId: b.id,
    });
    await setRole(b.id, 'holdout');
    const params = paramsOf(ctx, (await start('revise')).json().id);
    expect((params.feedback as { body: string }[]).map((f) => f.body)).toEqual(['On a']);
    expect(params.feedbackIds).not.toContain(onB.id);
    expect(params.feedbackIds).toHaveLength(1);
  });

  it('refuses when the only open feedback names a holdout sample', async () => {
    const { start, feedback, add, setRole } = await project();
    const b = await add(2);
    await feedback({ target: 'field', targetId: 'sender', body: 'On b', sampleId: b.id });
    await setRole(b.id, 'holdout');
    const res = await start('revise');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('add feedback before asking for a revision');
  });

  it('works from feedback alone before any evaluation', async () => {
    const ctx = await project();
    const { start, feedback } = ctx;
    await feedback({ target: 'section', targetId: 'all', body: 'Split the approvals off' });
    const res = await start('revise');
    expect(paramsOf(ctx, res.json().id).failures).toEqual([]);
  });

  it('resolves its feedback when accepted, even partly, and not when rejected', async () => {
    const { app, start, feedback, finishDraft, decide } = await project();
    const f = await feedback({ target: 'field', targetId: 'sender', body: 'Describe it' });
    const first = (await start('revise')).json();
    await finishDraft(first.id, 'revise', {
      notes: '',
      changes: [
        {
          op: 'putField',
          field: { id: 'sender', type: 'text', description: 'Who' },
          reason: 'feedback',
        },
        { op: 'setPreamble', preamble: 'Letters.', reason: 'feedback' },
      ],
    });
    await decide(first.id, { decision: 'rejected' });
    const open = async () =>
      ((await app.inject('/api/workbench/projects/letter/feedback')).json() as FeedbackItem[]).find(
        (x) => x.id === f.id,
      )!;
    expect((await open()).resolvedBy).toBeNull();
    const second = (await start('revise')).json();
    await finishDraft(second.id, 'revise', {
      notes: '',
      changes: [
        {
          op: 'putField',
          field: { id: 'sender', type: 'text', description: 'Who' },
          reason: 'feedback',
        },
        { op: 'setPreamble', preamble: 'x', reason: 'r' },
      ],
    });
    expect((await decide(second.id, { decision: 'accepted', changes: [0] })).statusCode).toBe(200);
    expect((await open()).resolvedBy).toBe(second.id);
  });

  it('keeps its feedback open when the draft closed before the accept', async () => {
    const { app, start, feedback, finishDraft, decide, templates } = await project();
    const f = await feedback({ target: 'field', targetId: 'sender', body: 'Describe it' });
    const { id } = (await start('revise')).json();
    await finishDraft(id, 'revise', {
      notes: '',
      changes: [
        {
          op: 'putField',
          field: { id: 'sender', type: 'text', description: 'Who' },
          reason: 'feedback',
        },
      ],
    });
    // Published between the version check and the write: updateDraft writes nothing.
    vi.spyOn(templates, 'updateDraft').mockResolvedValueOnce(null);
    const res = await decide(id, { decision: 'accepted', changes: [0] });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(
      'the draft is no longer open; start the next version and re-run the stage',
    );
    const items = (
      await app.inject('/api/workbench/projects/letter/feedback')
    ).json() as FeedbackItem[];
    expect(items.find((x) => x.id === f.id)!.resolvedBy).toBeNull();
  });

  it('prefers failures from the template run over a later model comparison', async () => {
    const ctx = await project();
    const { app, start, feedback, repo, add, verify, evaluate, finish } = ctx;
    await verify(await add(1), 'Acme');
    await evaluate();
    const evalJobs = async () =>
      (await repo.listProjectRuns('letter')).filter((r) => r.job.referenceId).map((r) => r.job);
    const own = await evalJobs();
    for (const job of own) await finish(job.id, 'Own');
    await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/evaluations/compare' });
    const ownIds = new Set(own.map((j) => j.id));
    for (const job of await evalJobs()) if (!ownIds.has(job.id)) await finish(job.id, 'Compared');
    await feedback({ target: 'field', targetId: 'sender', body: 'Letterhead' });
    const params = paramsOf(ctx, (await start('revise')).json().id);
    expect((params.failures as { fields: { actual: unknown }[] }[])[0]!.fields[0]!.actual).toBe(
      'Own',
    );
    expect(params.failuresFrom).toEqual({ templateVersion: 1, model: null });
  });

  it('falls back to the latest complete comparison member and names its model', async () => {
    const ctx = await project();
    const { app, start, feedback, repo, add, verify, finish, workbench } = ctx;
    await verify(await add(1), 'Acme');
    await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/evaluations/compare' });
    for (const r of await repo.listProjectRuns('letter')) {
      if (r.job.referenceId) await finish(r.job.id, 'Compared');
    }
    await feedback({ target: 'field', targetId: 'sender', body: 'Letterhead' });
    const params = paramsOf(ctx, (await start('revise')).json().id);
    const [latest] = await workbench.listIterations('letter');
    expect(latest!.groupId).not.toBeNull();
    expect(params.failuresFrom).toEqual({ templateVersion: 1, model: latest!.model });
    expect((params.failures as unknown[]).length).toBe(1);
  });

  it('sends no failuresFrom without a complete evaluation', async () => {
    const ctx = await project();
    await ctx.feedback({ target: 'field', targetId: 'sender', body: 'Letterhead' });
    const params = paramsOf(ctx, (await ctx.start('revise')).json().id);
    expect(params).not.toHaveProperty('failuresFrom');
  });

  it('cannot be skipped', async () => {
    const { app } = await project();
    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/stages/revise/skip',
    });
    expect(res.statusCode).toBe(400);
  });

  it(`sends at most ${MAX_CONTEXT_SAMPLES} failures`, async () => {
    const ctx = await project();
    for (let n = 1; n <= MAX_CONTEXT_SAMPLES + 1; n++) await ctx.verify(await ctx.add(n), 'Acme');
    await ctx.evaluate();
    for (const r of await ctx.repo.listProjectRuns('letter')) {
      if (r.job.referenceId) await ctx.finish(r.job.id, 'Wrong');
    }
    await ctx.feedback({ target: 'field', targetId: 'sender', body: 'Letterhead' });
    const params = paramsOf(ctx, (await ctx.start('revise')).json().id);
    expect(params.failures as unknown[]).toHaveLength(MAX_CONTEXT_SAMPLES);
  });

  it('keeps the answers and resolves only the feedback its applied changes answer (RV2)', async () => {
    const { app, start, feedback, finishDraft, decide } = await project();
    const one = await feedback({ target: 'field', targetId: 'sender', body: 'Describe it' });
    const two = await feedback({ target: 'step', targetId: 'head', body: 'Say what letters are' });
    const { id } = (await start('revise')).json();
    await finishDraft(id, 'revise', {
      notes: '',
      changes: [
        {
          op: 'putField',
          field: { id: 'sender', type: 'text', description: 'Who' },
          reason: 'feedback 1',
          answers: [one.id],
        },
        { op: 'setPreamble', preamble: 'Letters.', reason: 'feedback 2', answers: [two.id] },
      ],
    });
    const [listed] = (await app.inject('/api/workbench/projects/letter/proposals')).json() as {
      body: { changes: { answers?: string[] }[] };
    }[];
    expect(listed!.body.changes.map((c) => c.answers)).toEqual([[one.id], [two.id]]);
    expect((await decide(id, { decision: 'accepted', changes: [0] })).statusCode).toBe(200);
    const items = (
      await app.inject('/api/workbench/projects/letter/feedback')
    ).json() as FeedbackItem[];
    expect(items.find((f) => f.id === one.id)!.resolvedBy).toBe(id);
    expect(items.find((f) => f.id === two.id)!.resolvedBy).toBeNull();
  });
});

describe('revise preview (RV1)', () => {
  const preview = async (ctx: Awaited<ReturnType<typeof project>>) => {
    const res = await ctx.app.inject('/api/workbench/projects/letter/stages/revise/preview');
    expect(res.statusCode).toBe(200);
    return res.json() as RevisePreview;
  };

  it('is a 404 for an unknown project', async () => {
    const { app } = await project();
    expect(
      (await app.inject('/api/workbench/projects/nope/stages/revise/preview')).statusCode,
    ).toBe(404);
  });

  it('shows the draft and the limits before any feedback or evaluation', async () => {
    const ctx = await project();
    expect(await preview(ctx)).toEqual({
      feedback: [],
      failures: [],
      failuresTotal: 0,
      failuresFrom: null,
      model: null,
      draft: { version: 1, definition: (await ctx.templates.get('letter', 1))!.definition },
      samples: [],
      limits: { samples: 8, fieldDiffs: 20, rowDiffs: 5 },
      notSent: { holdoutSamples: 0, holdoutRun: null },
    });
  });

  it('is exactly what the next revision sends, and names what it never sends', async () => {
    const ctx = await project();
    await ctx.app.deps.llm.setSettings({ draftingModel: 'local/qwen' }, null);
    const a = await ctx.add(1);
    const h = await ctx.add(2);
    await ctx.verify(a, 'Acme');
    await ctx.setRole(h.id, 'holdout');
    await ctx.verify(h, 'Globex');
    const dev = (await ctx.evaluate()).json() as { id: string };
    await ctx.evaluate({ set: 'holdout' });
    for (const r of await ctx.repo.listProjectRuns('letter')) {
      if (r.job.referenceId) await ctx.finish(r.job.id, 'Wrong');
    }
    await ctx.feedback({ target: 'field', targetId: 'sender', body: 'Letterhead', sampleId: a.id });

    const shown = await preview(ctx);
    const params = paramsOf(ctx, (await ctx.start('revise')).json().id);
    expect(shown.feedback).toEqual(params.feedback);
    expect(shown.failures).toEqual(params.failures);
    expect(shown.failures.map((f) => f.sample)).toEqual(['s1.pdf']);
    expect(shown.samples).toEqual(
      (params.samples as { filename: string }[]).map((s) => s.filename),
    );
    expect(shown.draft!.definition).toEqual(params.draft);
    expect(shown).toMatchObject({
      model: 'local/qwen',
      failuresTotal: 1,
      failuresFrom: { iterationId: dev.id, templateVersion: 1, model: null, compared: 1 },
      notSent: { holdoutSamples: 1, holdoutRun: { status: 'complete', score: 0 } },
    });
    expect(params.failuresFrom).toEqual({ templateVersion: 1, model: null });
  });

  it('sends the same capped sample list the start route does', async () => {
    const ctx = await project();
    for (let n = 1; n <= MAX_CONTEXT_SAMPLES + 1; n++) await ctx.add(n);
    await ctx.feedback({ target: 'field', targetId: 'sender', body: 'Letterhead' });
    const shown = await preview(ctx);
    const params = paramsOf(ctx, (await ctx.start('revise')).json().id);
    expect(shown.samples).toHaveLength(MAX_CONTEXT_SAMPLES);
    expect(shown.samples).toEqual(
      (params.samples as { filename: string }[])
        .slice(0, MAX_CONTEXT_SAMPLES)
        .map((s) => s.filename),
    );
  });

  it('has no draft once the version is published', async () => {
    const ctx = await project();
    await ctx.templates.publish('letter', 1);
    expect((await preview(ctx)).draft).toBeNull();
  });
});
