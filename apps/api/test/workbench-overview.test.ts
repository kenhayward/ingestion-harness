import { describe, expect, it } from 'vitest';
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
    expect(o.stages[0]).toEqual({ stage: 'samples', state: 'warn', status: 'No samples yet' });
    expect(o.stages[1]).toEqual({ stage: 'brief', state: 'warn', status: 'Not written yet' });
    expect(o.stages.find((s) => s.stage === 'publish')).toEqual({
      stage: 'publish',
      state: 'locked',
      status: 'Locked by the gate',
    });
    expect(o.stages.find((s) => s.stage === 'template')).toEqual({
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
    expect(await p.item('samples')).toEqual({
      stage: 'samples',
      state: 'running',
      status: 'Preparing 1 of 1',
    });
    await p.addSample(2, true);
    expect((await p.item('samples')).status).toBe('Preparing 1 of 2');
    await p.app.inject({
      method: 'PUT',
      url: '/api/workbench/projects/letter/brief',
      payload: { purpose: 'Letters to customers' },
    });
    expect(await p.item('brief')).toEqual({
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
    expect(await p.item('survey')).toEqual({
      stage: 'survey',
      state: 'skipped',
      status: 'Skipped',
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
    expect((await p.item('runs')).state).toBe('running');
    for (const job of p.repo.jobs.values()) {
      if (job.task === 'process') p.repo.jobs.set(job.id, { ...job, status: 'awaiting_review' });
    }
    expect(await p.item('runs')).toEqual({
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
