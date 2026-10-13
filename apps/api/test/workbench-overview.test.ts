import { describe, expect, it, vi } from 'vitest';
import { preparedTriageKey, type ProjectOverview, type SampleView } from '@ih/shared';
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
  return { ...ctx, overview, item, addSample };
}

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
      state: 'locked',
      status: 'Locked by the gate',
    });
    expect(o.stages.find((s) => s.stage === 'template')).toMatchObject({
      stage: 'template',
      state: 'none',
      status: 'Draft v1',
    });
    expect(o.next).toEqual({
      stage: 'samples',
      title: 'Next: add sample PDFs',
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

  it('reads no prepared triage for its own sample counts', async () => {
    const p = await project();
    const s = await p.addSample(1, true);
    const get = vi.spyOn(p.store, 'get');
    await p.overview();
    const triageReads = get.mock.calls.filter(([, key]) => String(key).startsWith('prepared/'));
    // The publish gate and the references stage still read it through `sampleViews` (one read
    // each; sharing their context is PR 6); the overview's own sample counts add none.
    expect(triageReads).toEqual([
      ['runs', preparedTriageKey(s.sha256)],
      ['runs', preparedTriageKey(s.sha256)],
    ]);
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
    expect((await p.item('runs')).state).toBe('running');
    for (const job of p.repo.jobs.values()) {
      if (job.task === 'process') p.repo.jobs.set(job.id, { ...job, status: 'awaiting_review' });
    }
    expect(await p.item('runs')).toMatchObject({
      stage: 'runs',
      state: 'warn',
      status: '1 awaiting review',
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
