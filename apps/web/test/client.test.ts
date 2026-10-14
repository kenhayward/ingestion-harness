import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpApi } from '../src/api/client.js';

const respond = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('http api: ended sessions', () => {
  it('reports a 401 from any call, including token management', async () => {
    const api = createHttpApi('/api');
    const ended = vi.fn();
    const off = api.onUnauthorized(ended);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(401, { error: 'sign in required' })),
    );
    await expect(api.listJobs()).rejects.toThrow('sign in required');
    await expect(api.listTokens()).rejects.toThrow('sign in required');
    expect(ended).toHaveBeenCalledTimes(2);
    off();
  });

  it('does not treat sign-in and the startup check as an ended session', async () => {
    const api = createHttpApi('/api');
    const ended = vi.fn();
    const off = api.onUnauthorized(ended);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(401, { error: 'invalid or expired token' })),
    );
    expect(await api.me()).toBeNull();
    await expect(api.login('ih_x')).rejects.toMatchObject({ status: 401 });
    expect(ended).not.toHaveBeenCalled();
    off();
  });
});

describe('http api: access tokens', () => {
  it('sends the role of a new token', async () => {
    const fetch = vi.fn(async () => respond(200, { token: 'ih_x', record: {} }));
    vi.stubGlobal('fetch', fetch);
    await createHttpApi('/api').createToken('Ops laptop', 90, 'admin');
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/auth/tokens');
    expect(JSON.parse(String(init.body))).toEqual({
      label: 'Ops laptop',
      expiresInDays: 90,
      role: 'admin',
    });
  });
});

describe('http api: URLs', () => {
  it('links the uploaded PDF of a job', () => {
    expect(createHttpApi('/api').documentUrl('j1')).toBe('/api/jobs/j1/document');
  });
  it('links the ZIP of a result', () => {
    expect(createHttpApi('/api').archiveUrl('j1')).toBe('/api/results/j1/archive');
  });
});

describe('http api: workbench', () => {
  it('imports a bundle as multipart with id and name before the file', async () => {
    const fetchMock = vi.fn(async () => respond(201, { draft: 1 }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['PK'], 'b.zip', { type: 'application/zip' });
    await createHttpApi('/api').importBundle(file, { id: 'memo2', name: 'Memo' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/workbench/projects/import');
    expect(init.method).toBe('POST');
    expect([...(init.body as FormData).keys()]).toEqual(['id', 'name', 'bundle']);
  });

  it("explains a proxy 413 on import, and keeps the API's own 413 message", async () => {
    const file = new File(['PK'], 'b.zip', { type: 'application/zip' });
    const html = '<html><body><h1>413 Request Entity Too Large</h1></body></html>';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(html, { status: 413, headers: { 'content-type': 'text/html' } }),
      ),
    );
    await expect(createHttpApi('/api').importBundle(file, {})).rejects.toMatchObject({
      message: 'bundle too large for the proxy',
      status: 413,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(413, { error: 'request file too large' })),
    );
    await expect(createHttpApi('/api').importBundle(file, {})).rejects.toThrow(
      'request file too large',
    );
  });

  it("shows the API's 400 for a bundle over its limit", async () => {
    // What the API answers for an upload past maxUploadBytes * MAX_SAMPLES + 8 MiB.
    const file = new File(['PK'], 'b.zip', { type: 'application/zip' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(400, { error: 'bundle is too large' })),
    );
    await expect(createHttpApi('/api').importBundle(file, {})).rejects.toMatchObject({
      message: 'bundle is too large',
      status: 400,
    });
  });

  it('deletes a workbench project', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await createHttpApi('/api').deleteProject('letter');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/workbench/projects/letter',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('links the bundle download of an export', () => {
    expect(createHttpApi('/api').exportBundleUrl('letter', 'j1')).toBe(
      '/api/workbench/projects/letter/exports/j1/bundle',
    );
  });

  it('uploads a sample as multipart with its role before the file', async () => {
    const fetchMock = vi.fn(async () => respond(201, { id: 's1' }));
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['%PDF-1'], 'one.pdf', { type: 'application/pdf' });
    await createHttpApi('/api').uploadSample('letter', file, 'holdout');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/workbench/projects/letter/samples');
    expect(init.method).toBe('POST');
    const form = init.body as FormData;
    expect([...form.keys()]).toEqual(['role', 'file']);
    expect(form.get('role')).toBe('holdout');
  });
});

describe('http api: segmentation', () => {
  it('posts candidate anchors and reads a preview', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      respond(202, { jobId: 'j1', status: 'queued', error: null, result: null }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    const document = {
      sections: [{ id: 'all', anchor: '\\A', required: true }],
      pageMarkers: true,
    };
    await api.startSegmentation('letter', document);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/workbench/projects/letter/segmentations');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual({ document });
    await api.getSegmentation('letter', 'j1');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/workbench/projects/letter/segmentations/j1');
  });
});

describe('http api: results query', () => {
  it('sends the file name filter with the other parameters', async () => {
    const fetch = vi.fn(async () => respond(200, []));
    vi.stubGlobal('fetch', fetch);
    await createHttpApi('/api').listResults({
      templateId: 't',
      q: 'a b%',
      before: 'x',
      beforeId: 'y',
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/results?templateId=t&q=a+b%25&before=x&beforeId=y',
      undefined,
    );
  });
});

describe('http api: long results filter', () => {
  it('clamps q to the 100 characters the API accepts', async () => {
    const fetch = vi.fn(async () => respond(200, []));
    vi.stubGlobal('fetch', fetch);
    await createHttpApi('/api').listResults({ q: 'x'.repeat(150) });
    expect(fetch).toHaveBeenCalledWith(`/api/results?q=${'x'.repeat(100)}`, undefined);
  });
});

describe('http api: drafting', () => {
  it('changes the data policy and starts a stage', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => respond(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.setDataPolicy('letter', 'external');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/workbench/projects/letter/data-policy');
    expect(fetchMock.mock.calls[0]![1]!.method).toBe('PUT');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      dataPolicy: 'external',
    });
    await api.startStage('letter', 'survey');
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/workbench/projects/letter/stages/survey');
    await api.decideProposal('letter', 'p1', 'accepted');
    expect(fetchMock.mock.calls[2]![0]).toBe(
      '/api/workbench/projects/letter/proposals/p1/decision',
    );
    expect(JSON.parse(String(fetchMock.mock.calls[2]![1]!.body))).toEqual({
      decision: 'accepted',
    });
  });

  it('lists proposals', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => respond(200, []));
    vi.stubGlobal('fetch', fetchMock);
    await createHttpApi('/api').listProposals('letter');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/workbench/projects/letter/proposals');
  });
});

describe('http api: drafting stages', () => {
  it('decides chosen changes, skips and lists stages', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => respond(200, []));
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.decideProposal('letter', 'p1', 'accepted', [0, 2]);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      decision: 'accepted',
      changes: [0, 2],
    });
    await api.decideProposal('letter', 'p1', 'rejected');
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]!.body))).toEqual({ decision: 'rejected' });
    await api.skipStage('letter', 'survey');
    expect(fetchMock.mock.calls[2]![0]).toBe('/api/workbench/projects/letter/stages/survey/skip');
    await api.listStages('letter');
    expect(fetchMock.mock.calls[3]![0]).toBe('/api/workbench/projects/letter/stages');
    await api.confirmStage('letter', 'sections');
    expect(fetchMock.mock.calls[4]![0]).toBe(
      '/api/workbench/projects/letter/stages/sections/confirm',
    );
    expect(fetchMock.mock.calls[4]![1]!.method).toBe('POST');
  });
});

describe('http api: evaluation', () => {
  it('reads one reference detail', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => respond(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.getReferenceDetail('letter', 's1');
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/workbench/projects/letter/references/s1');
  });

  it('proposes references, evaluates, lists, opens and restores iterations', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      respond(200, { jobs: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.listReferenceRows('letter');
    await api.proposeReferences('letter');
    await api.startEvaluation('letter', 'fast');
    await api.startEvaluation('letter', null);
    await api.listIterations('letter');
    await api.getIteration('letter', 'i1');
    await api.restoreIteration('letter', 'i1');
    const calls = fetchMock.mock.calls.map(([url, init]) => [
      init?.method ?? 'GET',
      url,
      init?.body ? JSON.parse(String(init.body)) : undefined,
    ]);
    expect(calls).toEqual([
      ['GET', '/api/workbench/projects/letter/references', undefined],
      ['POST', '/api/workbench/projects/letter/stages/references', {}],
      ['POST', '/api/workbench/projects/letter/evaluations', { model: 'fast' }],
      ['POST', '/api/workbench/projects/letter/evaluations', {}],
      ['GET', '/api/workbench/projects/letter/iterations', undefined],
      ['GET', '/api/workbench/projects/letter/iterations/i1', undefined],
      ['POST', '/api/workbench/projects/letter/iterations/i1/restore', {}],
    ]);
  });
});

describe('http api: S3 keys (ADR 0008)', () => {
  it('lists, issues, rotates, revokes and deletes through /api/access/s3-keys', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'POST' && !String(_url).endsWith('/revoke')
        ? respond(200, { secretAccessKey: 's' })
        : init?.method
          ? new Response(null, { status: 204 })
          : respond(200, { bucket: 'b', endpoint: null, consumers: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.listS3Keys();
    await api.createS3Key('Lake', 90);
    await api.rotateS3Key('c1', 365, 7);
    await api.revokeS3Key('k1');
    await api.deleteS3Consumer('c1');
    const calls = fetchMock.mock.calls.map(([url, init]) => [
      init?.method ?? 'GET',
      url,
      init?.body ? JSON.parse(String(init.body)) : undefined,
    ]);
    expect(calls).toEqual([
      ['GET', '/api/access/s3-keys', undefined],
      ['POST', '/api/access/s3-keys', { label: 'Lake', expiresInDays: 90 }],
      ['POST', '/api/access/s3-keys/c1/rotate', { expiresInDays: 365, graceDays: 7 }],
      ['POST', '/api/access/s3-keys/keys/k1/revoke', undefined],
      ['DELETE', '/api/access/s3-keys/c1', undefined],
    ]);
  });

  it('carries the status of a failure (404: keys not available here)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(404, { error: 'S3 keys are not available' })),
    );
    await expect(createHttpApi('/api').listS3Keys()).rejects.toMatchObject({
      status: 404,
      message: 'S3 keys are not available',
    });
  });
});

describe('http api: comparison', () => {
  it('sends the uncached flag and starts and opens comparisons', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => respond(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.startEvaluation('letter', null, { uncached: true });
    await api.startComparison('letter', { uncached: true });
    await api.startComparison('letter', { models: ['main', 'test'] });
    await api.getComparison('letter', 'g1');
    const calls = fetchMock.mock.calls.map(([url, init]) => [
      init?.method ?? 'GET',
      url,
      init?.body ? JSON.parse(String(init.body)) : undefined,
    ]);
    expect(calls).toEqual([
      ['POST', '/api/workbench/projects/letter/evaluations', { uncached: true }],
      ['POST', '/api/workbench/projects/letter/evaluations/compare', { uncached: true }],
      ['POST', '/api/workbench/projects/letter/evaluations/compare', { models: ['main', 'test'] }],
      ['GET', '/api/workbench/projects/letter/comparisons/g1', undefined],
    ]);
  });
});

describe('http api: model choices', () => {
  it('lists the choices every picker offers', async () => {
    const choices = [
      {
        id: 'main',
        label: 'Main',
        description: '',
        ref: 'local/q',
        location: 'local',
        isDefault: true,
      },
    ];
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => respond(200, { choices }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await createHttpApi('/api').listPickerChoices()).toEqual(choices);
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/models/choices');
  });
});

describe('http api: holdout and publishing', () => {
  it('lists holdout references, evaluates the holdout, sets the threshold and publishes', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      respond(200, { jobs: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.listReferenceRows('letter', 'dev');
    await api.listReferenceRows('letter', 'holdout');
    await api.startHoldoutReferenceRuns('letter');
    await api.startEvaluation('letter', null, { set: 'holdout' });
    await api.startEvaluation('letter', null, { set: 'dev' });
    await api.setPublishThreshold('letter', 0.8);
    await api.getPublishGate('letter');
    await api.publish('letter');
    await api.publish('letter', 'Known bad scan');
    await api.listPublications('letter');
    const calls = fetchMock.mock.calls.map(([url, init]) => [
      init?.method ?? 'GET',
      url,
      init?.body ? JSON.parse(String(init.body)) : undefined,
    ]);
    expect(calls).toEqual([
      ['GET', '/api/workbench/projects/letter/references', undefined],
      ['GET', '/api/workbench/projects/letter/references?set=holdout', undefined],
      ['POST', '/api/workbench/projects/letter/holdout/reference-runs', {}],
      ['POST', '/api/workbench/projects/letter/evaluations', { set: 'holdout' }],
      ['POST', '/api/workbench/projects/letter/evaluations', {}],
      ['PATCH', '/api/workbench/projects/letter', { publishThreshold: 0.8 }],
      ['GET', '/api/workbench/projects/letter/publish-gate', undefined],
      ['POST', '/api/workbench/projects/letter/publish', {}],
      ['POST', '/api/workbench/projects/letter/publish', { overrideReason: 'Known bad scan' }],
      ['GET', '/api/workbench/projects/letter/publications', undefined],
    ]);
  });
});

describe('http api: feedback', () => {
  it('lists, adds and deletes feedback', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'DELETE' ? new Response(null, { status: 204 }) : respond(200, []),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.listFeedback('letter');
    await api.addFeedback('letter', { target: 'field', targetId: 'sender', body: 'Letterhead' });
    await api.deleteFeedback('letter', 'f1');
    const calls = fetchMock.mock.calls.map(([url, init]) => [
      init?.method ?? 'GET',
      url,
      init?.body ? JSON.parse(String(init.body)) : undefined,
    ]);
    expect(calls).toEqual([
      ['GET', '/api/workbench/projects/letter/feedback', undefined],
      [
        'POST',
        '/api/workbench/projects/letter/feedback',
        { target: 'field', targetId: 'sender', body: 'Letterhead' },
      ],
      ['DELETE', '/api/workbench/projects/letter/feedback/f1', undefined],
    ]);
  });

  it('reads the revise preview', async () => {
    const fetchMock = vi.fn(async (_url: string) => respond(200, {}));
    vi.stubGlobal('fetch', fetchMock);
    await createHttpApi('/api').getRevisePreview('letter');
    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/workbench/projects/letter/stages/revise/preview',
    );
  });
});

describe('http api: brief versions', () => {
  it('lists versions and reads one', async () => {
    const fetchMock = vi.fn(async () => respond(200, []));
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.listBriefVersions('letter');
    await api.getBriefVersion('letter', 2);
    const urls = (fetchMock.mock.calls as unknown as [string][]).map(([url]) => url);
    expect(urls).toEqual([
      '/api/workbench/projects/letter/briefs',
      '/api/workbench/projects/letter/briefs/2',
    ]);
  });
});

describe('http api: project overview', () => {
  it('reads a project overview', async () => {
    const body = { project: { id: 'letter' }, stages: [], next: null, gate: {} };
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => respond(200, body));
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    expect(await api.getProjectOverview('letter')).toEqual(body);
    const calls = fetchMock.mock.calls.map(([url, init]) => [init?.method ?? 'GET', url]);
    expect(calls).toEqual([['GET', '/api/workbench/projects/letter/overview']]);
  });
});

describe('http api: workbench list and pins', () => {
  it('requests only the set params, in order, with ids comma-joined', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      Response.json({ items: [], total: 0, facets: {} }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.listProjectPage({
      q: 'inv',
      filter: 'attention',
      ids: ['a', 'b'],
      page: 2,
      size: 50,
    });
    await api.listProjectPage({});
    const expected = new URLSearchParams({
      q: 'inv',
      filter: 'attention',
      ids: 'a,b',
      page: '2',
      size: '50',
    }).toString();
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `/api/workbench/projects?${expected}`,
      '/api/workbench/projects',
    ]);
  });

  it('lists, pins and unpins', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT' || init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : Response.json(['a']),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    expect(await api.listPins()).toEqual(['a']);
    await api.pin('a b');
    await api.unpin('a b');
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET'])).toEqual([
      ['/api/workbench/pins', 'GET'],
      ['/api/workbench/pins/a%20b', 'PUT'],
      ['/api/workbench/pins/a%20b', 'DELETE'],
    ]);
  });
});

describe('http api: jobs', () => {
  it('asks for every job, or only mine', async () => {
    const fetch = vi.fn(async () => respond(200, []));
    vi.stubGlobal('fetch', fetch);
    const api = createHttpApi('/api');
    await api.listJobs();
    await api.listJobs({ mine: true });
    const urls = fetch.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls).toEqual(['/api/jobs', '/api/jobs?mine=1']);
  });
});

describe('http api: LLM endpoints', () => {
  it('calls the admin routes', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'DELETE' ? new Response(null, { status: 204 }) : respond(200, {}),
    );
    vi.stubGlobal('fetch', fetch);
    const api = createHttpApi('/api');
    await api.listLlmEndpoints();
    await api.createLlmEndpoint({
      name: 'gpu2',
      kind: 'openai-chat',
      baseUrl: 'http://x/v1',
      location: 'local',
    });
    await api.updateLlmEndpoint('gpu 2', { enabled: false });
    await api.setLlmEndpointModels('gpu2', ['a']);
    await api.deleteLlmEndpoint('gpu2');
    const calls = fetch.mock.calls.map((c) => [
      c[0],
      (c[1] as RequestInit | undefined)?.method ?? 'GET',
      (c[1] as RequestInit | undefined)?.body ?? null,
    ]);
    expect(calls).toEqual([
      ['/api/llm/endpoints', 'GET', null],
      [
        '/api/llm/endpoints',
        'POST',
        JSON.stringify({
          name: 'gpu2',
          kind: 'openai-chat',
          baseUrl: 'http://x/v1',
          location: 'local',
        }),
      ],
      ['/api/llm/endpoints/gpu%202', 'PATCH', JSON.stringify({ enabled: false })],
      ['/api/llm/endpoints/gpu2/models', 'PUT', JSON.stringify({ models: ['a'] })],
      ['/api/llm/endpoints/gpu2', 'DELETE', null],
    ]);
  });
});

describe('http api: runs with a model choice (phase 4d)', () => {
  it('sends the model choice of a dev test run and of a test upload, before the file', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) =>
      respond(200, { jobs: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.runDevTests('letter', { model: 'test' });
    await api.runDevTests('letter', { model: null });
    await api.runDevTests('letter', { sampleIds: ['s1', 's2'] });
    await api.runDevTests('letter');
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { model: 'test' },
      {},
      { sampleIds: ['s1', 's2'] },
      {},
    ]);
    fetchMock.mockClear();
    await api.testRun(new File(['%PDF'], 'a.pdf'), 'letter', 2, 'test');
    const form = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect([...form.keys()]).toEqual(['specId', 'specVersion', 'test', 'model', 'file']);
    expect(form.get('model')).toBe('test');
  });

  it('reads the queue summary', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      respond(200, { ahead: 3, running: 1, etaSeconds: 120 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    expect(await api.getQueueSummary()).toEqual({ ahead: 3, running: 1, etaSeconds: 120 });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/queue/summary');
  });
});

describe('http api: template drafts (TP1)', () => {
  it('lists the draft changes and saves with the base it started from', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => respond(200, []));
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.listDraftChanges('letter');
    await api.saveTemplate('letter', 2, { name: 'A' }, '2026-10-13T10:00:00.000Z');
    await api.saveTemplate('letter', 2, { name: 'A' });
    await api.saveTemplate('letter', 2, { name: 'A' }, '');
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      '/api/workbench/projects/letter/draft/changes',
      '/api/templates/letter/versions/2',
      '/api/templates/letter/versions/2',
      '/api/templates/letter/versions/2',
    ]);
    expect(fetchMock.mock.calls.slice(1).map(([, init]) => JSON.parse(String(init?.body)))).toEqual(
      [
        { definition: { name: 'A' }, baseUpdatedAt: '2026-10-13T10:00:00.000Z' },
        { definition: { name: 'A' } },
        { definition: { name: 'A' } },
      ],
    );
  });
});

describe('http api: following a job live', () => {
  /** A stand-in for the browser's EventSource: tests fire its events. */
  class FakeEventSource {
    static last: FakeEventSource | null = null;
    static readonly CLOSED = 2;
    readyState = 0;
    onerror: (() => void) | null = null;
    private readonly handlers = new Map<string, ((e: MessageEvent) => void)[]>();
    constructor(readonly url: string) {
      FakeEventSource.last = this;
    }
    addEventListener(type: string, handler: (e: MessageEvent) => void) {
      this.handlers.set(type, [...(this.handlers.get(type) ?? []), handler]);
    }
    emit(type: string, data: unknown) {
      for (const h of this.handlers.get(type) ?? [])
        h(new MessageEvent(type, { data: JSON.stringify(data) }));
    }
    close() {
      this.readyState = FakeEventSource.CLOSED;
    }
  }
  const live = (status: string) => ({ job: { id: 'j1', status }, progress: null });

  function watch() {
    vi.stubGlobal('EventSource', FakeEventSource);
    const on = { update: vi.fn(), gone: vi.fn(), error: vi.fn() };
    const stop = createHttpApi('/api').watchJob('j1', on);
    return { on, stop, source: FakeEventSource.last! };
  }

  it("opens the job's event stream and passes each update on", () => {
    const { on, source } = watch();
    expect(source.url).toBe('/api/jobs/j1/events');
    source.emit('job', live('running'));
    expect(on.update).toHaveBeenCalledWith(live('running'));
    expect(source.readyState).not.toBe(FakeEventSource.CLOSED);
  });

  it('closes once the job has finished, so the browser does not reconnect', () => {
    const { on, source } = watch();
    source.emit('job', live('succeeded'));
    expect(on.update).toHaveBeenCalledTimes(1);
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });

  it('reports a deleted job and closes', () => {
    const { on, source } = watch();
    source.emit('gone', {});
    expect(on.gone).toHaveBeenCalled();
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });

  it('reports an error only when the browser gives up, not while it reconnects', () => {
    const { on, source } = watch();
    source.onerror!();
    expect(on.error).not.toHaveBeenCalled();
    source.readyState = FakeEventSource.CLOSED;
    source.onerror!();
    expect(on.error).toHaveBeenCalledTimes(1);
  });

  it('reports an error (after returning) when the browser has no EventSource', async () => {
    vi.stubGlobal('EventSource', undefined);
    const on = { update: vi.fn(), gone: vi.fn(), error: vi.fn() };
    createHttpApi('/api').watchJob('j1', on);
    expect(on.error).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(on.error).toHaveBeenCalled();
  });

  it('stops on request', () => {
    const { stop, source } = watch();
    stop();
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
  });
});

describe('http api: retired document types', () => {
  it('lists specs with or without retired ones, and retires', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? Response.json({ id: 'a b', retired: { retiredAt: 'x', retiredBy: null } })
        : Response.json([]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.listSpecs();
    await api.listSpecs({ retired: 'include' });
    await api.retireType('a b');
    await api.listProjectPage({ retired: 'include' });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET'])).toEqual([
      ['/api/specs', 'GET'],
      ['/api/specs?retired=include', 'GET'],
      ['/api/specs/a%20b/retirement', 'PUT'],
      ['/api/workbench/projects?retired=include', 'GET'],
    ]);
    // Unretiring is API-only (D14): the web client has no call for it.
    expect('unretireType' in api).toBe(false);
  });
});

describe('http api: ontologies', () => {
  it('sends ontology fields before the file', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(JSON.stringify({ ontologyId: 'pv', version: 1 }), { status: 202 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const file = new File(['x'], 'pv.ttl');
    await createHttpApi('/api').importOntology(file, {
      id: 'pv',
      label: 'PV',
      tags: ['a', 'b'],
      localOnly: true,
    });
    const form = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect([...form.keys()]).toEqual(['id', 'label', 'tags', 'localOnly', 'file']);
    expect(form.get('tags')).toBe('a,b');
  });

  it('builds term queries', async () => {
    const fetchMock = vi.fn(
      async (_url: string) =>
        new Response(JSON.stringify({ items: [], total: 0, offset: 0, limit: 100 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    await createHttpApi('/api').listOntologyTerms('pv', 2, { group: 'classes', root: true });
    expect(fetchMock.mock.calls[0]![0]).toBe(
      '/api/ontologies/pv/versions/2/terms?group=classes&root=1',
    );
  });
});
