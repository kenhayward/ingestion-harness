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
});

describe('http api: workbench', () => {
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
