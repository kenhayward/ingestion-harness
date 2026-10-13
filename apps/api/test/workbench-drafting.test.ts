import { describe, expect, it } from 'vitest';
import {
  EMPTY_BRIEF,
  draftingKey,
  preparedTriageKey,
  type ProposalView,
  type SampleView,
} from '@ih/shared';
import { MemoryAccessRepo } from '../src/access/repo.js';
import { letter, multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);
const survey = {
  summary: 'Letters.',
  structure: [],
  variants: [],
  candidates: [],
  questions: [{ question: 'Which date?', why: 'Two dates' }],
};

async function project(overrides = {}) {
  const ctx = await testApp(overrides);
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  await ctx.templates.updateDraft('letter', 1, letter(1));
  const add = async (n: number, role = 'dev', ready = true) => {
    const s = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/samples',
        ...multipart({ role }, { filename: `s${n}.pdf`, content: pdf(n) }),
      })
    ).json() as SampleView;
    if (ready) {
      const job = ctx.repo.jobs.get(s.prepareJobId!)!;
      ctx.repo.jobs.set(job.id, { ...job, status: 'succeeded' });
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
  const start = (stage = 'survey') =>
    ctx.app.inject({ method: 'POST', url: `/api/workbench/projects/letter/stages/${stage}` });
  return { ...ctx, add, start };
}

describe('data policy', () => {
  it('lets an admin allow external models', async () => {
    const { app } = await project();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/workbench/projects/letter/data-policy',
      payload: { dataPolicy: 'external' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().project).toMatchObject({ dataPolicy: 'external' });
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/workbench/projects/letter/data-policy',
      payload: { dataPolicy: 'cloud' },
    });
    expect(bad.statusCode).toBe(400);
    const unknown = await app.inject({
      method: 'PUT',
      url: '/api/workbench/projects/nope/data-policy',
      payload: { dataPolicy: 'external' },
    });
    expect(unknown.statusCode).toBe(404);
  });

  it('refuses user tokens and allows the admin', async () => {
    const access = new MemoryAccessRepo();
    const { app, workbench } = await testApp({ access });
    await workbench.createProject('letter', 'Letter');
    const login = async (token: string) => {
      const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { token } });
      return `ih_session=${/ih_session=([^;]*)/.exec(String(res.headers['set-cookie']))![1]}`;
    };
    const put = (cookie: string) =>
      app.inject({
        method: 'PUT',
        url: '/api/workbench/projects/letter/data-policy',
        payload: { dataPolicy: 'external' },
        headers: { cookie },
      });
    const { token } = await access.createToken('user', null);
    expect((await put(await login(token))).statusCode).toBe(403);
    expect((await workbench.getProject('letter'))!.dataPolicy).toBe('local');
    const admin = await access.rotateAdminToken();
    expect((await put(await login(admin))).statusCode).toBe(200);
    expect((await workbench.getProject('letter'))!.dataPolicy).toBe('external');
  });

  it('is carried by prepare jobs and test runs', async () => {
    const { app, repo, add } = await project();
    const s = await add(1);
    expect(repo.jobParams.get(s.prepareJobId!)).toEqual({ dataPolicy: 'local' });
    const run = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/test-runs',
    });
    const [job] = run.json().jobs as { id: string; batchId: string }[];
    expect(repo.jobParams.get(job!.id)).toEqual({
      dataPolicy: 'local',
      batchId: job!.batchId,
      outputs: letter(1).outputs,
    });
  });

  it('revoking to local downgrades the project jobs already created; allowing never upgrades', async () => {
    const { app, repo, add, start } = await project();
    const setPolicy = (dataPolicy: string) =>
      app.inject({
        method: 'PUT',
        url: '/api/workbench/projects/letter/data-policy',
        payload: { dataPolicy },
      });
    expect((await setPolicy('external')).statusCode).toBe(200);
    const s = await add(1);
    const run = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects/letter/test-runs',
    });
    const [testJob] = run.json().jobs as { id: string }[];
    const draft = (await start()).json() as ProposalView;
    expect(repo.jobParams.get(s.prepareJobId!)).toEqual({ dataPolicy: 'external' });
    expect(repo.draftJobs.get(draft.id)!.params).toMatchObject({ dataPolicy: 'external' });

    expect((await setPolicy('local')).statusCode).toBe(200);
    const policies = () => [
      repo.jobParams.get(s.prepareJobId!)?.dataPolicy,
      repo.jobParams.get(testJob!.id)?.dataPolicy,
      repo.draftJobs.get(draft.id)!.params.dataPolicy,
    ];
    expect(policies()).toEqual(['local', 'local', 'local']);
    // The rest of the draft job's params is untouched.
    expect(repo.draftJobs.get(draft.id)!.params).toMatchObject({ stage: 'survey' });

    expect((await setPolicy('external')).statusCode).toBe(200);
    expect(policies()).toEqual(['local', 'local', 'local']);
  });

  it('revoking leaves other projects jobs alone', async () => {
    const { app, repo, workbench, add } = await project();
    await workbench.createProject('other', 'Other');
    await app.inject({
      method: 'PUT',
      url: '/api/workbench/projects/letter/data-policy',
      payload: { dataPolicy: 'external' },
    });
    const s = await add(1);
    await workbench.setDataPolicy('other', 'local', null);
    expect(repo.jobParams.get(s.prepareJobId!)).toEqual({ dataPolicy: 'external' });
  });
});

describe('survey stage', () => {
  it('sends the brief, the draft and only the ready dev samples', async () => {
    const { repo, add, start } = await project();
    const dev = await add(1);
    await add(2, 'holdout');
    await add(3, 'dev', false);
    const res = await start();
    expect(res.statusCode).toBe(202);
    const view = res.json() as ProposalView;
    expect(view).toMatchObject({ stage: 'survey', status: 'running', body: null });
    expect(repo.draftJobs.get(view.id)!.params).toEqual({
      stage: 'survey',
      dataPolicy: 'local',
      briefVersion: null,
      brief: EMPTY_BRIEF,
      draft: letter(1),
      samples: [{ sampleId: dev.id, filename: 's1.pdf', sha256: dev.sha256, role: 'dev' }],
    });
  });

  it('refuses when only holdout samples are ready, and unknown stages', async () => {
    const { add, start } = await project();
    await add(1, 'holdout');
    expect((await start()).statusCode).toBe(409);
    const references = await start('references');
    expect(references.statusCode).toBe(409);
    expect(references.json().error).toBe('finish the survey stage first (accept or skip it)');
    expect((await start('bogus')).statusCode).toBe(400);
  });

  it('shows the survey once ready and records one decision', async () => {
    const { app, repo, store, add, start } = await project();
    await add(1);
    const { id } = (await start()).json() as ProposalView;
    const list = async () => (await app.inject('/api/workbench/projects/letter/proposals')).json();
    expect((await list())[0]).toMatchObject({ id, status: 'running' });

    repo.draftJobs.set(id, { ...repo.draftJobs.get(id)!, status: 'succeeded' });
    const result = {
      stage: 'survey',
      model: 'local/big',
      body: survey,
      usage: { inputTokens: 1, outputTokens: 2 },
    };
    await store.put(
      'runs',
      draftingKey('letter', id),
      Buffer.from(JSON.stringify(result)),
      'application/json',
    );
    expect((await list())[0]).toMatchObject({ status: 'ready', model: 'local/big', body: survey });

    const decide = (decision: string) =>
      app.inject({
        method: 'POST',
        url: `/api/workbench/projects/letter/proposals/${id}/decision`,
        payload: { decision },
      });
    expect((await decide('accepted')).json()).toMatchObject({ status: 'accepted', body: survey });
    expect((await decide('rejected')).statusCode).toBe(409);
  });

  it('reports a failed draft with its reason', async () => {
    const { app, repo, add, start } = await project();
    await add(1);
    const { id } = (await start()).json() as ProposalView;
    repo.draftJobs.set(id, {
      ...repo.draftJobs.get(id)!,
      status: 'needs_review',
      error: 'data policy: project is local-only but draft resolves to external provider anthropic',
    });
    const [view] = (await app.inject('/api/workbench/projects/letter/proposals')).json();
    expect(view).toMatchObject({ status: 'failed', error: expect.stringContaining('data policy') });
    const decide = await app.inject({
      method: 'POST',
      url: `/api/workbench/projects/letter/proposals/${id}/decision`,
      payload: { decision: 'accepted' },
    });
    expect(decide.statusCode).toBe(409);
  });

  it.each([
    ['missing', null, 'result missing'],
    ['corrupt', Buffer.from('{not json'), 'result unreadable'],
    ['malformed', Buffer.from('{"stage":"survey"}'), 'result unreadable'],
  ])('a succeeded job with a %s result is failed, not a 500', async (_name, bytes, error) => {
    const { app, repo, store, add, start } = await project();
    await add(1);
    const { id } = (await start()).json() as ProposalView;
    repo.draftJobs.set(id, { ...repo.draftJobs.get(id)!, status: 'succeeded' });
    if (bytes) await store.put('runs', draftingKey('letter', id), bytes, 'application/json');
    const res = await app.inject('/api/workbench/projects/letter/proposals');
    expect(res.statusCode).toBe(200);
    expect(res.json()[0]).toMatchObject({ status: 'failed', error, model: null, body: null });
  });

  it('404s an unknown or malformed proposal id', async () => {
    const { app } = await project();
    for (const pid of ['nope', '00000000-0000-4000-8000-000000000000']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/workbench/projects/letter/proposals/${pid}/decision`,
        payload: { decision: 'accepted' },
      });
      expect(res.statusCode).toBe(404);
    }
  });
});
