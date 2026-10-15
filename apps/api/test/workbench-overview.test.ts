import { describe, expect, it, vi } from 'vitest';
import {
  EMPTY_BRIEF,
  draftingKey,
  preparedTriageKey,
  type DraftStage,
  type ProjectOverview,
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
  const overview = async () => {
    const res = await ctx.app.inject(`/api/workbench/projects/letter/overview`);
    expect(res.statusCode).toBe(200);
    return res.json<ProjectOverview>();
  };
  const item = async (stage: string) => (await overview()).stages.find((s) => s.stage === stage)!;
  const addSample = async (n: number, prepared: boolean) => {
    const s = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/samples',
        ...multipart({ role: 'dev' }, { filename: `s${n}.pdf`, content: pdf(n) }),
      })
    ).json<SampleView>();
    if (prepared) {
      const prep = ctx.repo.jobs.get(s.prepareJobId!)!;
      ctx.repo.jobs.set(prep.id, { ...prep, status: 'succeeded' });
      const triage = { sha256: s.sha256, pageCount: 1, ocrPages: [], chars: 5, ocrModel: null };
      await ctx.store.put(
        'runs',
        preparedTriageKey(s.sha256),
        Buffer.from(JSON.stringify(triage)),
        'application/json',
      );
    }
    return s;
  };
  const metrics = async (stage: string) => (await item(stage)).metrics;
  /** A proposal with its finished draft job and, unless null, its stored result. */
  const proposal = async (stage: DraftStage, result: Buffer | null) => {
    const job = await ctx.repo.createDraftJob('letter', {});
    ctx.repo.draftJobs.set(job.id, { ...ctx.repo.draftJobs.get(job.id)!, status: 'succeeded' });
    const p = await ctx.workbench.createProposal({
      id: job.id,
      projectId: 'letter',
      stage,
      briefVersion: null,
    });
    if (result)
      await ctx.store.put('runs', draftingKey('letter', p.id), result, 'application/json');
    return p;
  };
  const draftResult = (stage: DraftStage, body: unknown, model = 'local/big') =>
    Buffer.from(JSON.stringify({ stage, model, body, usage: { inputTokens: 1, outputTokens: 2 } }));
  return { ...ctx, overview, item, metrics, addSample, proposal, draftResult };
}

const removeStep = (id: string) => ({ op: 'removeStep', id, reason: 'not needed' });
const removeOutput = (id: string) => ({ op: 'removeOutput', id, reason: 'not needed' });

describe('GET /api/workbench/projects/:id/overview', () => {
  it('is 404 for an unknown project', async () => {
    const { app } = await testApp();
    const res = await app.inject('/api/workbench/projects/nope/overview');
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'project not found' });
  });

  it('describes a new project: no samples, no brief, nothing run', async () => {
    const p = await project();
    const o = await p.overview();
    expect(o.project.project.id).toBe('letter');
    expect(o.project.draft).toBe(1);
    expect(o.stages.map((s) => s.stage)).toEqual([
      'samples',
      'brief',
      'survey',
      'outputs',
      'sections',
      'steps',
      'mapping',
      'references',
      'evaluate',
      'revise',
      'publish',
      'template',
      'runs',
    ]);
    expect(o.stages[0]).toMatchObject({
      stage: 'samples',
      state: 'warn',
      status: 'No samples yet',
    });
    expect(o.stages[1]).toMatchObject({ stage: 'brief', state: 'warn', status: 'Not written yet' });
    expect(o.stages.find((s) => s.stage === 'publish')).toMatchObject({
      stage: 'publish',
      state: 'ready',
      status: 'Ready to publish v1',
    });
    expect(o.stages.find((s) => s.stage === 'template')).toMatchObject({
      stage: 'template',
      state: 'none',
      status: 'Draft v1',
    });
    expect(o.next).toEqual({
      stage: 'samples',
      title: 'Next: add sample documents',
      reason: 'Upload 3–8 dev samples and a few holdout samples.',
    });
    expect(o.gate.passes).toBe(false);
  });

  it('follows sample preparation and the brief', async () => {
    const p = await project();
    await p.addSample(1, false);
    expect(await p.item('samples')).toMatchObject({
      stage: 'samples',
      state: 'running',
      status: '1 of 1 preparing',
    });
    await p.addSample(2, true);
    expect((await p.item('samples')).status).toBe('1 of 2 preparing');
    const brief = await p.app.inject({
      method: 'PUT',
      url: '/api/workbench/projects/letter/brief',
      payload: { purpose: 'Letters to customers' },
    });
    expect(brief.statusCode).toBe(201);
    expect(await p.item('brief')).toMatchObject({
      stage: 'brief',
      state: 'accepted',
      status: 'Saved v1',
    });
  });

  it('shows a skipped stage', async () => {
    const p = await project();
    const res = await p.app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/stages/survey/skip',
    });
    expect(res.statusCode).toBeLessThan(300);
    expect(await p.item('survey')).toMatchObject({
      stage: 'survey',
      state: 'skipped',
      status: 'Skipped',
    });
  });

  it('does not count sample preparation as test runs', async () => {
    const p = await project();
    await p.addSample(1, false);
    expect(await p.item('runs')).toMatchObject({
      stage: 'runs',
      state: 'pending',
      status: 'No runs yet',
    });
  });

  it('shows an evaluation of the open draft as running while its jobs are queued', async () => {
    const p = await project();
    await p.addSample(1, true);
    const run = await p.app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/test-runs',
      payload: {},
    });
    const { jobs } = run.json<{ jobs: { id: string }[] }>();
    await p.workbench.createIteration({
      projectId: 'letter',
      templateVersion: 1,
      definition: (await p.templates.get('letter', 1))!.definition,
      briefVersion: null,
      set: 'dev',
      model: null,
      jobIds: jobs.map((j) => j.id),
    });
    expect(await p.item('evaluate')).toMatchObject({
      stage: 'evaluate',
      state: 'running',
      status: 'Running',
    });
  });

  it('reads prepared triage once per sample list it builds', async () => {
    const p = await project();
    const s = await p.addSample(1, true);
    const get = vi.spyOn(p.store, 'get');
    await p.overview();
    const triageReads = get.mock.calls.filter(([, key]) => String(key).startsWith('prepared/'));
    // Every `sampleViews` call reads each ready sample's triage once, and an overview makes three
    // (sharing one list between them is PR 6): the publish gate, the references stage, and the
    // overview's own sample list, which the dev and holdout reference figures (`referenceRows`)
    // reuse.
    expect(triageReads).toEqual(Array(3).fill(['runs', preparedTriageKey(s.sha256)]));
  });

  it('gives dashes and zeros for a new project', async () => {
    const p = await project();
    const o = await p.overview();
    const metrics = Object.fromEntries(o.stages.map((s) => [s.stage, s.metrics]));
    expect(metrics.samples).toEqual([
      { label: 'Dev · holdout', value: '0 · 0', at: null },
      { label: 'OCR pages', value: '—', at: null },
    ]);
    expect(metrics.survey).toEqual([
      { label: 'Questions', value: '—', at: null },
      { label: 'Fields · tables', value: '—', at: null },
    ]);
    expect(metrics.publish).toEqual([
      { label: 'Needs holdout', value: '≥ 90%', at: null },
      { label: 'Live version', value: '—', at: null },
    ]);
    for (const s of o.stages) expect(s.metrics).toHaveLength(2);
  });

  it('counts samples, OCR pages and the brief', async () => {
    const p = await project();
    await p.addSample(1, true); // triage: pageCount 1, ocrPages []
    const brief = await p.app.inject({
      method: 'PUT',
      url: '/api/workbench/projects/letter/brief',
      payload: {
        purpose: 'Letters',
        answers: [
          { question: 'Who signs?', answer: 'The clerk' },
          { question: 'Dates?', answer: ' ' },
        ],
      },
    });
    expect(brief.statusCode).toBe(201);
    const o = await p.overview();
    const of = (stage: string) => o.stages.find((s) => s.stage === stage)!.metrics;
    expect(of('samples')).toEqual([
      { label: 'Dev · holdout', value: '1 · 0', at: null },
      { label: 'OCR pages', value: '0 of 1', at: null },
    ]);
    expect(of('brief')[0]).toEqual({ label: 'Answers', value: '1', at: null });
    expect(of('brief')[1]!.at).toEqual(o.project.brief!.createdAt);
    expect(of('survey')[0]).toEqual({ label: 'Questions', value: '1 of 2 answered', at: null });
    expect(of('sections')[1]).toEqual({ label: 'Anchors found', value: '—', at: null });
    expect(of('references')).toEqual([
      { label: 'Dev', value: '0 / 1', at: null },
      { label: 'Holdout', value: '0 / 0', at: null },
    ]);
  });

  it('reads the template figures from the open draft, and the last hand edit from its log', async () => {
    const p = await project();
    const o = await p.overview();
    const template = o.stages.find((s) => s.stage === 'template')!.metrics;
    // `letter`: one pipeline step, one section, one field.
    expect(template[0]).toEqual({ label: 'Steps · sections', value: '1 · 1', at: null });
    // Only the draft's start is logged (the helper wrote the draft directly): no hand edit yet.
    expect(template[1]).toEqual({ label: 'Hand edit', value: '—', at: null });
    await p.app.inject({
      method: 'PUT',
      url: '/api/templates/letter/versions/1',
      payload: {
        definition: { ...(await p.templates.get('letter', 1))!.definition, name: 'Memo' },
      },
    });
    const [hand] = await p.templates.listChanges('letter', 1);
    expect((await p.metrics('template'))[1]).toEqual({
      label: 'Hand edit',
      value: '—',
      at: hand!.at,
    });
    expect(await p.metrics('outputs')).toEqual([
      { label: 'Fields · tables', value: '1 · 0', at: null },
      { label: 'Changes applied', value: '—', at: null },
    ]);
    expect((await p.metrics('sections'))[0]).toEqual({ label: 'Sections', value: '1', at: null });
  });

  it('shows no Hand edit for a published-only project whose live version was never hand-edited', async () => {
    const p = await project();
    await p.templates.publish('letter', 1);
    expect((await p.metrics('template'))[1]).toEqual({
      label: 'Hand edit',
      value: '—',
      at: null,
    });
  });

  it('survives a corrupt drafting body', async () => {
    const p = await project();
    const outputs = await p.proposal('outputs', Buffer.from('{not json'));
    await p.workbench.decideProposal('letter', outputs.id, 'accepted');
    await p.proposal('steps', p.draftResult('steps', { notes: 'not a change body' }));
    const res = await p.app.inject('/api/workbench/projects/letter/overview');
    expect(res.statusCode).toBe(200);
    const of = (stage: string) =>
      res.json<ProjectOverview>().stages.find((s) => s.stage === stage)!.metrics;
    expect(of('outputs')[1]).toEqual({ label: 'Changes applied', value: '—', at: null });
    expect(of('steps')).toEqual([
      { label: 'Proposed changes', value: '—', at: null },
      { label: 'Model', value: '—', at: null },
    ]);
  });

  it('reads the drafting figures from the newest proposals', async () => {
    const p = await project();
    const older = await p.proposal(
      'steps',
      p.draftResult('steps', { notes: '', changes: [removeStep('a')] }),
    );
    await p.workbench.decideProposal('letter', older.id, 'rejected');
    await p.proposal(
      'steps',
      p.draftResult(
        'steps',
        { notes: '', changes: ['a', 'b', 'c', 'd'].map(removeStep) },
        'local/qwen3.8-27b-mtp',
      ),
    );
    expect((await p.metrics('steps')).map((m) => [m.label, m.value])).toEqual([
      ['Proposed changes', '4'],
      ['Model', 'qwen3.8-27b-mtp'],
    ]);

    const outputs = await p.proposal(
      'outputs',
      p.draftResult('outputs', { notes: '', changes: [removeOutput('a'), removeOutput('b')] }),
    );
    await p.workbench.decideProposal('letter', outputs.id, 'partially_accepted', [1]);
    expect((await p.metrics('outputs'))[1]).toEqual({
      label: 'Changes applied',
      value: '1 of 2',
      at: null,
    });

    const sample = (sampleId: string, error: string | null, missingRequired: string[]) => ({
      sampleId,
      firstPage: 1,
      pageCount: 1,
      error,
      missingRequired,
      sections: [],
    });
    const [a, b, c] = [
      await p.addSample(1, true),
      await p.addSample(2, true),
      await p.addSample(3, true),
    ];
    await p.proposal(
      'sections',
      p.draftResult('sections', {
        notes: '',
        changes: [],
        anchorCheck: {
          anchorErrors: {},
          samples: [
            sample(a.id, null, []),
            sample(b.id, 'not prepared', []),
            sample(c.id, null, ['all']),
          ],
        },
      }),
    );
    expect((await p.metrics('sections'))[1]).toEqual({
      label: 'Anchors found',
      value: '1 / 3 dev',
      at: null,
    });

    const revise = await p.proposal('revise', null);
    expect((await p.metrics('revise'))[1]).toEqual({
      label: 'Last revision',
      value: '—',
      at: revise.createdAt,
    });
  });

  it('counts only anchors found in current dev samples', async () => {
    const p = await project();
    const [a, b] = [await p.addSample(1, true), await p.addSample(2, true)];
    const found = (sampleId: string) => ({
      sampleId,
      firstPage: 1,
      pageCount: 1,
      error: null,
      missingRequired: [],
      sections: [],
    });
    await p.proposal(
      'sections',
      p.draftResult('sections', {
        notes: '',
        changes: [],
        anchorCheck: {
          anchorErrors: {},
          samples: [found(a.id), found(b.id), found('removed-sample')],
        },
      }),
    );
    expect((await p.metrics('sections'))[1]).toEqual({
      label: 'Anchors found',
      value: '2 / 2 dev',
      at: null,
    });
  });

  it('keeps the newest readable drafting figures while a newer proposal is drafting', async () => {
    const p = await project();
    await p.proposal(
      'steps',
      p.draftResult(
        'steps',
        { notes: '', changes: ['a', 'b', 'c', 'd'].map(removeStep) },
        'local/qwen3.8-27b-mtp',
      ),
    );
    const running = await p.proposal('steps', null);
    p.repo.draftJobs.set(running.id, { ...p.repo.draftJobs.get(running.id)!, status: 'running' });
    expect((await p.metrics('steps')).map((m) => [m.label, m.value])).toEqual([
      ['Proposed changes', '4'],
      ['Model', 'qwen3.8-27b-mtp'],
    ]);
  });

  it("shows the newest finished dev evaluation's cached score", async () => {
    const p = await project();
    const definition = (await p.templates.get('letter', 1))!.definition;
    const iteration = (model: 'fast' | null) =>
      p.workbench.createIteration({
        projectId: 'letter',
        templateVersion: 1,
        definition,
        briefVersion: null,
        set: 'dev',
        model,
        jobIds: [],
      });
    const own = await iteration(null);
    await p.workbench.setIterationScores(own.id, { score: 0.75, completed: 1, total: 1 });
    const fast = await iteration('fast');
    await p.workbench.setIterationScores(fast.id, { score: 0.5, completed: 1, total: 1 });
    await iteration(null); // still running: no cached score yet
    expect((await p.metrics('evaluate'))[0]).toEqual({
      label: 'Dev score',
      value: '75%',
      at: null,
    });
  });

  it('counts test runs by status', async () => {
    const p = await project();
    await p.addSample(1, true);
    const run = await p.app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/test-runs',
      payload: {},
    });
    expect(run.statusCode).toBeLessThan(300);
    expect(await p.item('runs')).toMatchObject({
      state: 'running',
      status: '1 test run in progress',
    });
    for (const job of p.repo.jobs.values()) {
      if (job.task === 'process') p.repo.jobs.set(job.id, { ...job, status: 'awaiting_review' });
    }
    expect(await p.item('runs')).toMatchObject({
      stage: 'runs',
      state: 'warn',
      status: '1 awaiting review',
    });
  });

  it('suggests evaluating a revision on dev until an evaluation of the draft follows it', async () => {
    const p = await project();
    await p.addSample(1, true);
    // Brief written and drafting stages done: verification is all that is left.
    await p.app.inject({
      method: 'PUT',
      url: '/api/workbench/projects/letter/brief',
      payload: { purpose: 'Letters to customers' },
    });
    for (const stage of ['survey', 'outputs', 'sections', 'steps']) {
      const skip = await p.app.inject({
        method: 'POST',
        url: `/api/workbench/projects/letter/stages/${stage}/skip`,
      });
      expect(skip.statusCode).toBeLessThan(300);
    }
    expect((await p.overview()).next).toMatchObject({ stage: 'publish' });
    const job = await p.repo.createDraftJob('letter', {});
    p.repo.draftJobs.set(job.id, { ...p.repo.draftJobs.get(job.id)!, status: 'succeeded' });
    const proposal = await p.workbench.createProposal({
      id: job.id,
      projectId: 'letter',
      stage: 'revise',
      briefVersion: null,
    });
    await p.workbench.decideProposal('letter', proposal.id, 'accepted', [0]);
    expect((await p.overview()).next).toMatchObject({
      stage: 'evaluate',
      title: 'Next: evaluate v1 on dev',
    });

    await p.workbench.createIteration({
      projectId: 'letter',
      templateVersion: 1,
      definition: (await p.templates.get('letter', 1))!.definition,
      briefVersion: null,
      set: 'dev',
      model: null,
      jobIds: [],
    });
    expect((await p.overview()).next).toMatchObject({ stage: 'publish' });
  });

  it('uses the mapping stage only while the draft has RDF on (Outputs tab)', async () => {
    const p = await project();
    await p.workbench.saveBrief('letter', {
      ...EMPTY_BRIEF,
      ontologies: [{ ontologyId: 'acme', version: 1, role: 'vocabulary' }],
    });
    expect(await p.item('mapping')).toMatchObject({
      state: 'skipped',
      status: 'Not used: RDF is off on the Outputs tab',
    });
    await p.templates.updateDraft('letter', 1, {
      ...letter(1),
      delivery: { formats: ['csv', 'json', 'rdf'] },
    });
    expect(await p.item('mapping')).toMatchObject({
      state: 'pending',
      status: 'Optional, not started',
    });
  });

  it('ignores a revise accepted before the latest publication', async () => {
    const p = await project();
    // Seed directly: an accepted revise proposal, then a publication after it.
    const job = await p.repo.createDraftJob('letter', {});
    const proposal = await p.workbench.createProposal({
      id: job.id,
      projectId: 'letter',
      stage: 'revise',
      briefVersion: null,
    });
    await p.workbench.decideProposal('letter', proposal.id, 'accepted', [0]);
    expect((await p.item('revise')).state).toBe('accepted');
    await p.workbench.recordPublication({
      projectId: 'letter',
      version: 1,
      iterationId: null,
      score: null,
      threshold: 0.9,
      overrideReason: 'test',
      publishedBy: null,
    });
    expect((await p.item('revise')).state).toBe('pending');
  });
});
