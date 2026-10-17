import { describe, expect, it } from 'vitest';
import {
  DRAFT_PROGRESS_EVENT,
  EMPTY_BRIEF,
  draftingKey,
  preparedTriageKey,
  type ProposalView,
  type SampleView,
} from '@ih/shared';
import { MemoryAccessRepo } from '../src/access/repo.js';
import { MemoryOntologyRepo } from '../src/ontologies/repo.js';
import { letter, multipart, signIn, signInNewUser, testApp } from './helpers.js';

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

  it('refuses users and allows admins', async () => {
    const access = new MemoryAccessRepo();
    const { app, workbench } = await testApp({ access });
    await workbench.createProject('letter', 'Letter');
    const put = (cookie: string) =>
      app.inject({
        method: 'PUT',
        url: '/api/workbench/projects/letter/data-policy',
        payload: { dataPolicy: 'external' },
        headers: { cookie },
      });
    const { cookie: user } = await signInNewUser(app, access, 'user');
    expect((await put(user)).statusCode).toBe(403);
    expect((await workbench.getProject('letter'))!.dataPolicy).toBe('local');
    const admin = await signIn(app, 'admin', await access.rotateAdminPassword());
    expect((await put(admin)).statusCode).toBe(200);
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

describe('a running stage (issue #151)', () => {
  const event = { stage: 'survey', phase: 'model', samples: 1, attempt: 1, of: 2, round: 1 };

  it("is queued, then running with this attempt's latest progress, then done", async () => {
    const { app, repo, add, start } = await project();
    await add(1);
    const started = (await start()).json() as ProposalView;
    const { id } = started;
    expect(started.run).toEqual({
      status: 'queued',
      since: repo.draftJobs.get(id)!.updatedAt,
      progress: null,
      paused: false,
      retry: null,
    });
    const listed = async () =>
      (
        (await app.inject('/api/workbench/projects/letter/proposals')).json() as ProposalView[]
      ).find((p) => p.id === id)!;
    // An earlier attempt's event: the job was claimed again after it.
    repo.addEvent(id, 'info', DRAFT_PROGRESS_EVENT, event);
    const claimed = repo.now();
    repo.draftJobs.set(id, { ...repo.draftJobs.get(id)!, status: 'running', updatedAt: claimed });
    expect((await listed()).run).toEqual({ status: 'running', since: claimed, progress: null });
    repo.addEvent(id, 'info', DRAFT_PROGRESS_EVENT, { phase: 'reading' }); // malformed
    expect((await listed()).run!.progress).toBeNull();
    repo.addEvent(id, 'info', DRAFT_PROGRESS_EVENT, { ...event, attempt: 2 });
    expect((await listed()).run!.progress).toEqual({
      ...event,
      attempt: 2,
      at: expect.any(String),
      phaseAt: expect.any(String),
    });
    repo.draftJobs.set(id, { ...repo.draftJobs.get(id)!, status: 'needs_review', error: 'x' });
    expect(await listed()).toMatchObject({ status: 'failed', run: null });
  });

  it('says when the current try began, not when its latest token count came (issue #181)', async () => {
    const { app, repo, add, start } = await project();
    await add(1);
    const { id } = (await start()).json() as ProposalView;
    const listed = async () =>
      (
        (await app.inject('/api/workbench/projects/letter/proposals')).json() as ProposalView[]
      ).find((p) => p.id === id)!.run!.progress!;
    // The same try in an earlier claim: not this attempt's start.
    repo.addEvent(id, 'info', DRAFT_PROGRESS_EVENT, event);
    const claimed = repo.now();
    repo.draftJobs.set(id, { ...repo.draftJobs.get(id)!, status: 'running', updatedAt: claimed });
    repo.addEvent(id, 'info', DRAFT_PROGRESS_EVENT, { ...event, phase: 'reading', attempt: null });
    repo.addEvent(id, 'info', DRAFT_PROGRESS_EVENT, { ...event, tokens: null });
    const tryBegan = (await listed()).at;
    expect((await listed()).phaseAt).toBe(tryBegan);
    repo.addEvent(id, 'info', DRAFT_PROGRESS_EVENT, { ...event, tokens: 500 });
    repo.addEvent(id, 'info', DRAFT_PROGRESS_EVENT, { ...event, tokens: 1000 });
    const streaming = await listed();
    expect(streaming).toMatchObject({ tokens: 1000, phaseAt: tryBegan });
    expect(streaming.at > tryBegan).toBe(true);
    // A tool starting in the same try is said, and leaves the try's clock alone too.
    const tool = { name: 'test_anchors', summary: 'Testing 2 anchors on 1 dev sample' };
    repo.addEvent(id, 'info', DRAFT_PROGRESS_EVENT, { ...event, tokens: 1000, tool, toolCalls: 1 });
    expect(await listed()).toMatchObject({ tool, toolCalls: 1, phaseAt: tryBegan });
    // A second try starts its own clock.
    repo.addEvent(id, 'info', DRAFT_PROGRESS_EVENT, { ...event, attempt: 2, tokens: null });
    const second = await listed();
    expect(second.phaseAt).toBe(second.at);
    expect(second.phaseAt > tryBegan).toBe(true);
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

  it('sends the ontology library and the vocabulary pins with a survey', async () => {
    const ontologies = new MemoryOntologyRepo();
    const { app, repo, add, start } = await project({ ontologies });
    const upload = await app.inject({
      method: 'POST',
      url: '/api/ontologies',
      ...multipart(
        { id: 'domain', label: 'Domain' },
        { filename: 'd.ttl', content: Buffer.from('# d'), contentType: 'text/turtle' },
      ),
    });
    expect(upload.statusCode).toBe(202);
    ontologies.markReady('domain', 1);
    await app.inject({
      method: 'PUT',
      url: '/api/workbench/projects/letter/brief',
      payload: { ontologies: [{ ontologyId: 'qudt', version: 1, role: 'vocabulary' }] },
    });
    await add(1);
    const view = (await start()).json() as ProposalView;
    expect(repo.draftJobs.get(view.id)!.params).toMatchObject({
      library: [{ id: 'domain', version: 1, label: 'Domain', terms: 0 }],
      pinned: [{ ontologyId: 'qudt', version: 1 }],
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

describe("a proposal's model log", () => {
  const prompt = { kind: 'prompt', text: '<context>', images: 0 };
  const reply = (text: string) => ({ kind: 'reply', text, inputTokens: 10, outputTokens: 5 });
  const log = {
    stage: 'survey',
    model: 'local/qwen',
    tools: true,
    rounds: [
      {
        label: 'draft-survey',
        entries: [
          prompt,
          reply(''),
          {
            kind: 'toolCall',
            id: 'c1',
            name: 'read_sample_pages',
            input: { file: 's1.pdf', fromPage: 1, toPage: 1 },
            summary: 'Reading page 1 of s1.pdf',
          },
          { kind: 'toolResult', id: 'c1', name: 'read_sample_pages', text: 'p1', isError: false },
          reply('{}'),
          { kind: 'error', message: 'drafting model refused: no' },
        ],
      },
    ],
  };
  const url = (pid: string, project = 'letter') =>
    `/api/workbench/projects/${project}/proposals/${pid}/log`;

  it('returns what the drafting model was sent and answered, tool calls included', async () => {
    const { app, store, add, start } = await project();
    await add(1);
    const { id } = (await start()).json() as ProposalView;
    expect((await app.inject(url(id))).statusCode).toBe(404);
    await store.put(
      'runs',
      `${id}/draft-log.json`,
      Buffer.from(JSON.stringify(log)),
      'application/json',
    );
    const res = await app.inject(url(id));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...log, legacy: false });
  });

  it("rebuilds an older run's log from its attempt audit", async () => {
    const { app, store, add, start } = await project();
    await add(1);
    const { id } = (await start('survey')).json() as ProposalView;
    const put = (key: string, body: object) =>
      store.put('runs', key, Buffer.from(JSON.stringify(body)), 'application/json');
    await put(`${id}/draft-survey/attempt-1.json`, {
      prompt: 'first prompt',
      response: '{"summary": "x"}',
      errors: ['<root>: questions is required'],
    });
    await put(`${id}/draft-survey/attempt-2.json`, {
      prompt: 'first prompt + errors',
      response: '{"ok": true}',
      errors: [],
    });
    const res = await app.inject(url(id));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      stage: 'survey',
      model: null,
      tools: false,
      legacy: true,
      rounds: [
        {
          label: 'draft-survey',
          entries: [
            { kind: 'prompt', text: 'first prompt', images: 0 },
            { kind: 'reply', text: '{"summary": "x"}', inputTokens: null, outputTokens: null },
            { kind: 'rejected', errors: ['<root>: questions is required'] },
            { kind: 'prompt', text: 'first prompt + errors', images: 0 },
            { kind: 'reply', text: '{"ok": true}', inputTokens: null, outputTokens: null },
          ],
        },
      ],
    });
  });

  it('is a 404 for an unknown proposal or project, or a run with no log', async () => {
    const { app, add, start } = await project();
    await add(1);
    const { id } = (await start()).json() as ProposalView;
    const missing = await app.inject(url(id));
    expect(missing.json()).toEqual({ error: 'no model log for this run' });
    for (const res of [
      await app.inject(url('00000000-0000-4000-8000-000000000000')),
      await app.inject(url('not-a-uuid')),
      await app.inject(url(id, 'nope')),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'proposal not found' });
    }
  });
});

describe('why a drafting run waits', () => {
  it('says when the job queue is paused', async () => {
    const { app, repo, add, start } = await project();
    await add(1);
    const { id } = (await start()).json() as ProposalView;
    const run = async () =>
      (
        (await app.inject('/api/workbench/projects/letter/proposals')).json() as ProposalView[]
      ).find((p) => p.id === id)!.run!;
    expect(await run()).toMatchObject({ status: 'queued', paused: false, retry: null });
    repo.queuePausedNow = true;
    expect(await run()).toMatchObject({ status: 'queued', paused: true });
  });

  it('says when it waits to be tried again after an error, with the error', async () => {
    const { app, repo, add, start } = await project();
    await add(1);
    const { id } = (await start()).json() as ProposalView;
    repo.draftJobs.set(id, {
      ...repo.draftJobs.get(id)!,
      status: 'queued',
      attempts: 1,
      maxAttempts: 3,
      error: 'LLMError: openai 503: busy',
    });
    const [p] = (
      await app.inject('/api/workbench/projects/letter/proposals')
    ).json() as ProposalView[];
    expect(p!.run).toMatchObject({
      status: 'queued',
      retry: { attempt: 2, of: 3, error: 'LLMError: openai 503: busy' },
    });
  });
});

describe('cancelling a drafting run', () => {
  const cancel = (app: Awaited<ReturnType<typeof project>>['app'], pid: string, id = 'letter') =>
    app.inject({ method: 'POST', url: `/api/workbench/projects/${id}/proposals/${pid}/cancel` });

  it('cancels a queued or running run; the proposal then reads as failed: cancelled', async () => {
    const { app, repo, add, start } = await project();
    await add(1);
    const queued = (await start()).json() as ProposalView;
    const res = await cancel(app, queued.id);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      id: queued.id,
      status: 'failed',
      error: 'Cancelled.',
      run: null,
    });
    expect(repo.draftJobs.get(queued.id)!.status).toBe('cancelled');

    const running = (await start('survey')).json() as ProposalView;
    repo.draftJobs.set(running.id, { ...repo.draftJobs.get(running.id)!, status: 'running' });
    expect((await cancel(app, running.id)).json()).toMatchObject({ status: 'failed' });
    expect(repo.draftJobs.get(running.id)!.status).toBe('cancelled');
  });

  it('names who cancelled it', async () => {
    const access = new MemoryAccessRepo();
    const { app, repo, workbench } = await testApp({ access });
    await workbench.createProject('letter', 'Letter');
    const job = await repo.createDraftJob('letter', {});
    await workbench.createProposal({
      id: job.id,
      projectId: 'letter',
      stage: 'survey',
      briefVersion: null,
    });
    const { cookie } = await signInNewUser(app, access, 'Dana');
    const res = await app.inject({
      method: 'POST',
      url: `/api/workbench/projects/letter/proposals/${job.id}/cancel`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().error).toBe('Cancelled by Dana.');
  });

  it('refuses a finished run, and an unknown proposal or project', async () => {
    const { app, repo, add, start } = await project();
    await add(1);
    const { id } = (await start()).json() as ProposalView;
    repo.draftJobs.set(id, { ...repo.draftJobs.get(id)!, status: 'needs_review', error: 'x' });
    const done = await cancel(app, id);
    expect(done.statusCode).toBe(409);
    expect(done.json()).toEqual({
      error: 'proposal is failed: only a waiting or running run can be cancelled',
    });
    for (const res of [
      await cancel(app, '00000000-0000-4000-8000-000000000000'),
      await cancel(app, 'nope'),
      await cancel(app, id, 'other'),
    ]) {
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ error: 'proposal not found' });
    }
  });
});
