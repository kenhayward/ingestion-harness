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
  });
});

describe('http api: evaluation', () => {
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
    await api.getComparison('letter', 'g1');
    const calls = fetchMock.mock.calls.map(([url, init]) => [
      init?.method ?? 'GET',
      url,
      init?.body ? JSON.parse(String(init.body)) : undefined,
    ]);
    expect(calls).toEqual([
      ['POST', '/api/workbench/projects/letter/evaluations', { uncached: true }],
      ['POST', '/api/workbench/projects/letter/evaluations/compare', { uncached: true }],
      ['GET', '/api/workbench/projects/letter/comparisons/g1', undefined],
    ]);
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
});
