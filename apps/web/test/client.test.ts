import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHttpApi } from '../src/api/client.js';

const respond = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.unstubAllGlobals());

describe('http api: ended sessions', () => {
  it('reports a 401 from any call, including user management', async () => {
    const api = createHttpApi('/api');
    const ended = vi.fn();
    const off = api.onUnauthorized(ended);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(401, { error: 'sign in required' })),
    );
    await expect(api.listJobs()).rejects.toThrow('sign in required');
    await expect(api.listUsers()).rejects.toThrow('sign in required');
    expect(ended).toHaveBeenCalledTimes(2);
    off();
  });

  it('does not treat sign-in and the startup check as an ended session', async () => {
    const api = createHttpApi('/api');
    const ended = vi.fn();
    const off = api.onUnauthorized(ended);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(401, { error: 'invalid email or password' })),
    );
    expect(await api.me()).toBeNull();
    await expect(api.login('ken@example.com', 'x')).rejects.toMatchObject({ status: 401 });
    expect(ended).not.toHaveBeenCalled();
    off();
  });
});

describe('http api: maintenance', () => {
  const notice = { enabled: true, message: 'Deploying', since: '2026-10-16T13:00:00.000Z' };

  it('reports a maintenance 503 from any call with its notice, and keeps the error', async () => {
    const api = createHttpApi('/api');
    const seen = vi.fn();
    const off = api.onMaintenance(seen);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        respond(503, { error: 'CT Studio is under maintenance', maintenance: notice }),
      ),
    );
    await expect(api.listJobs()).rejects.toMatchObject({
      status: 503,
      body: { maintenance: notice },
    });
    expect(seen).toHaveBeenCalledWith(notice);
    off();
  });

  it('ignores other 503s', async () => {
    const api = createHttpApi('/api');
    const seen = vi.fn();
    const off = api.onMaintenance(seen);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(503, { error: 'too many sign-ins at once' })),
    );
    await expect(api.listJobs()).rejects.toThrow('too many sign-ins at once');
    expect(seen).not.toHaveBeenCalled();
    off();
  });

  it('reads the notice and saves the setting', async () => {
    const api = createHttpApi('/api');
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => respond(200, notice));
    vi.stubGlobal('fetch', fetch);
    expect(await api.getMaintenanceNotice()).toEqual(notice);
    await api.setMaintenance({ enabled: true, message: 'Deploying' });
    expect(
      fetch.mock.calls.map((c) => [String(c[0]), (c[1] as RequestInit | undefined)?.method]),
    ).toEqual([
      ['/api/maintenance', undefined],
      ['/api/maintenance', 'PUT'],
    ]);
  });
});

describe('http api: sign-in and users', () => {
  const calls = (fetch: ReturnType<typeof vi.fn>) =>
    (fetch.mock.calls as unknown as [string, RequestInit | undefined][]).map(([url, init]) => ({
      url,
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    }));

  it('signs in with a login and a password', async () => {
    const fetch = vi.fn(async () => respond(200, { role: 'designer', label: 'Ken' }));
    vi.stubGlobal('fetch', fetch);
    await createHttpApi('/api').login('ken@example.com', 'a long phrase');
    expect(calls(fetch)).toEqual([
      {
        url: '/api/auth/login',
        method: 'POST',
        body: { login: 'ken@example.com', password: 'a long phrase' },
      },
    ]);
  });

  it("keeps a locked account's lockedUntil on the error", async () => {
    const until = '2026-10-15T10:42:00.000Z';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(429, { error: 'too many failed sign-ins', lockedUntil: until })),
    );
    await expect(createHttpApi('/api').login('a@b.c', 'x')).rejects.toMatchObject({
      status: 429,
      body: { lockedUntil: until },
    });
  });

  it('lists the plugin catalogue with GET /api/plugins', async () => {
    const fetch = vi.fn(async () => Response.json([]));
    vi.stubGlobal('fetch', fetch);
    expect(await createHttpApi('/api').listPlugins()).toEqual([]);
    expect(calls(fetch)).toEqual([{ url: '/api/plugins', method: 'GET', body: undefined }]);
  });

  it('changes the password with PUT /api/auth/password', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    await createHttpApi('/api').changePassword('abcd-efgh-jkmn-pqrs', 'my long new phrase');
    expect(calls(fetch)).toEqual([
      {
        url: '/api/auth/password',
        method: 'PUT',
        body: { currentPassword: 'abcd-efgh-jkmn-pqrs', newPassword: 'my long new phrase' },
      },
    ]);
  });

  it('calls the user routes', async () => {
    const fetch = vi.fn(async () => respond(200, {}));
    vi.stubGlobal('fetch', fetch);
    const api = createHttpApi('/api');
    await api.listUsers();
    await api.addUser({ name: 'Ken', email: 'ken@example.com', role: 'designer' });
    await api.updateUser('u1', { email: 'k@x.com' });
    await api.setUserEnabled('u1', false);
    await api.setUserEnabled('u1', true);
    await api.reissuePassword('u1');
    await api.listSignIns({ userId: 'u1', limit: 200 });
    await api.listSignIns();
    expect(calls(fetch)).toEqual([
      { url: '/api/users', method: 'GET', body: undefined },
      {
        url: '/api/users',
        method: 'POST',
        body: { name: 'Ken', email: 'ken@example.com', role: 'designer' },
      },
      { url: '/api/users/u1', method: 'PATCH', body: { email: 'k@x.com' } },
      { url: '/api/users/u1/disable', method: 'POST', body: undefined },
      { url: '/api/users/u1/enable', method: 'POST', body: undefined },
      { url: '/api/users/u1/one-time-password', method: 'POST', body: undefined },
      { url: '/api/sign-ins?userId=u1&limit=200', method: 'GET', body: undefined },
      { url: '/api/sign-ins', method: 'GET', body: undefined },
    ]);
  });
});

describe('http api: profile', () => {
  it('calls the profile routes and links GitHub by navigation', async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'DELETE' ? new Response(null, { status: 204 }) : respond(200, {}),
    );
    vi.stubGlobal('fetch', fetch);
    const api = createHttpApi('/api');
    const details = { name: 'Ken', jobTitle: null, company: 'Acme', linkedin: 'ken-h' };
    await api.getProfile();
    await api.updateProfile(details);
    await api.listGitHubRepos();
    await api.setGitHubRepo('ken/recipes');
    await api.unlinkGitHub();
    expect(
      (fetch.mock.calls as unknown as [string, RequestInit | undefined][]).map(([url, init]) => ({
        url,
        method: init?.method ?? 'GET',
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      })),
    ).toEqual([
      { url: '/api/profile', method: 'GET', body: undefined },
      { url: '/api/profile', method: 'PUT', body: details },
      { url: '/api/profile/github/repos', method: 'GET', body: undefined },
      { url: '/api/profile/github/repo', method: 'PUT', body: { repo: 'ken/recipes' } },
      { url: '/api/profile/github', method: 'DELETE', body: undefined },
    ]);
    expect(api.gitHubConnectUrl()).toBe('/api/profile/github/connect');
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

  it('imports an ontology folder: fields, then the paths, then one part per file', async () => {
    const fetchMock = vi.fn(async () => respond(202, { versions: [], skipped: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const core = new File(['x'], 'core.ttl');
    const prod = new File(['y'], 'prod.ttl');
    await createHttpApi('/api').importOntologyBatch(
      [
        { file: core, path: 'idmp/core.ttl' },
        { file: prod, path: 'idmp/sub/prod.ttl' },
      ],
      { mode: 'separate', idPrefix: 'idmp-', tags: ['industry:pharma'], localOnly: true },
    );
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/ontologies/batch');
    const form = init.body as FormData;
    expect([...form.keys()]).toEqual([
      'mode',
      'idPrefix',
      'tags',
      'localOnly',
      'paths',
      'file',
      'file',
    ]);
    expect(form.get('paths')).toBe('["idmp/core.ttl","idmp/sub/prod.ttl"]');
    expect(form.get('tags')).toBe('industry:pharma');
  });

  it("explains a proxy 413 on an ontology folder import, keeping the API's own message", async () => {
    const html = '<html><body><h1>413 Request Entity Too Large</h1></body></html>';
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response(html, { status: 413, headers: { 'content-type': 'text/html' } }),
      ),
    );
    const files = [{ file: new File(['x'], 'a.ttl'), path: 'a/a.ttl' }];
    const fields = { mode: 'merge' as const, id: 'afo', label: 'AFO' };
    await expect(createHttpApi('/api').importOntologyBatch(files, fields)).rejects.toMatchObject({
      message: 'the files are over the upload limit of the proxy in front of CT Studio',
      status: 413,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(413, { error: 'the files are over the upload limit' })),
    );
    await expect(createHttpApi('/api').importOntologyBatch(files, fields)).rejects.toThrow(
      'the files are over the upload limit',
    );
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

  it('reports upload progress for a sample, and reads its answer or refusal', async () => {
    const sent: { method: string; url: string; body: FormData }[] = [];
    let respondWith: { status: number; body: unknown } = { status: 201, body: { id: 's1' } };
    class FakeXhr {
      status = 0;
      responseText = '';
      upload: { onprogress: ((e: ProgressEvent) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      private method = '';
      private url = '';
      open(method: string, url: string) {
        this.method = method;
        this.url = url;
      }
      send(body: FormData) {
        sent.push({ method: this.method, url: this.url, body });
        this.upload.onprogress?.({ lengthComputable: true, loaded: 3, total: 6 } as ProgressEvent);
        this.status = respondWith.status;
        this.responseText = JSON.stringify(respondWith.body);
        this.onload?.();
      }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXhr);
    const api = createHttpApi('/api');
    const file = new File(['%PDF-1'], 'one.pdf', { type: 'application/pdf' });
    const progress = vi.fn();
    expect(await api.uploadSample('letter', file, 'dev', progress)).toEqual({ id: 's1' });
    expect(progress).toHaveBeenCalledWith(3, 6);
    expect(sent[0]!.method).toBe('POST');
    expect(sent[0]!.url).toBe('/api/workbench/projects/letter/samples');
    expect([...sent[0]!.body.keys()]).toEqual(['role', 'file']);

    respondWith = { status: 409, body: { error: 'this PDF is already a sample of the project' } };
    await expect(api.uploadSample('letter', file, 'dev', progress)).rejects.toMatchObject({
      status: 409,
      message: 'this PDF is already a sample of the project',
    });

    const ended = vi.fn();
    const off = api.onUnauthorized(ended);
    respondWith = { status: 401, body: { error: 'sign in required' } };
    await expect(api.uploadSample('letter', file, 'dev', progress)).rejects.toThrow(
      'sign in required',
    );
    expect(ended).toHaveBeenCalledTimes(1);
    off();
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
      limit: 17,
    });
    expect(fetch).toHaveBeenCalledWith(
      '/api/results?templateId=t&q=a+b%25&before=x&beforeId=y&limit=17',
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
      init?.method === 'PUT'
        ? respond(200, { id: 'c1', targets: ['default'] })
        : init?.method === 'POST' && !String(_url).endsWith('/revoke')
          ? respond(200, { secretAccessKey: 's' })
          : init?.method
            ? new Response(null, { status: 204 })
            : respond(200, { endpoint: null, internalTargets: [], consumers: [] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.listS3Keys();
    await api.createS3Key('Lake', 90, ['default']);
    await api.setS3KeyTargets('c1', ['default', 'x']);
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
      ['POST', '/api/access/s3-keys', { label: 'Lake', expiresInDays: 90, targets: ['default'] }],
      ['PUT', '/api/access/s3-keys/c1/targets', { targets: ['default', 'x'] }],
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
    await api.listJobs({ group: 'attention', limit: 500 });
    const urls = fetch.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls).toEqual(['/api/jobs', '/api/jobs?mine=1', '/api/jobs?group=attention&limit=500']);
  });
});

describe('http api: job pages', () => {
  it('asks for one page, from a job, with the filters set', async () => {
    const fetch = vi.fn(async () => respond(200, {}));
    vi.stubGlobal('fetch', fetch);
    const api = createHttpApi('/api');
    await api.listJobPage({ size: 20 });
    await api.listJobPage({ size: 20, group: 'attention', mine: true, q: ' a b ', before: 'x' });
    await api.listJobPage({ size: 5, after: 'y' });
    await api.listJobPage({ size: 5, from: 'z', q: '  ' });
    const urls = fetch.mock.calls.map((c) => (c as unknown as [string])[0]);
    expect(urls).toEqual([
      '/api/jobs/page?size=20',
      '/api/jobs/page?size=20&group=attention&mine=1&q=a+b&before=x',
      '/api/jobs/page?size=5&after=y',
      '/api/jobs/page?size=5&from=z',
    ]);
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
    await api.setLlmModelSettings('gpu2', 'org/b', { maxOutputTokens: 32000 });
    await api.setLlmModelSettings('gpu2', 'org/b', { maxConcurrentCalls: null });
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
      [
        '/api/llm/endpoints/gpu2/models/org%2Fb',
        'PATCH',
        JSON.stringify({ maxOutputTokens: 32000 }),
      ],
      [
        '/api/llm/endpoints/gpu2/models/org%2Fb',
        'PATCH',
        JSON.stringify({ maxConcurrentCalls: null }),
      ],
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
  it('posts a URL import as JSON and reads the settings and neighbourhoods', async () => {
    const fetchMock = vi.fn(
      async (_u: string, _i?: RequestInit) => new Response('{}', { status: 202 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.importOntologyFromUrl({ id: 'pv', label: 'PV', url: 'https://w3id.org/pv' });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/ontologies/from-url');
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({
      id: 'pv',
      label: 'PV',
      url: 'https://w3id.org/pv',
    });
    await api.getOntologySettings();
    expect(fetchMock.mock.calls[1]![0]).toBe('/api/ontology-settings');
    await api.getNeighbourhood('pv', 2, 'https://x.org/#A', 2);
    expect(fetchMock.mock.calls[2]![0]).toBe(
      `/api/ontologies/pv/versions/2/neighbourhood?iri=${encodeURIComponent('https://x.org/#A')}&depth=2`,
    );
  });

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

  it('posts a mapping term label lookup', async () => {
    const fetchMock = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ terms: {} })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const body = { ontologies: [{ id: 'pv', version: 2 }], terms: ['pv:Protocol'] };
    expect(await createHttpApi('/api').termLabels(body)).toEqual({ terms: {} });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/ontologies/term-labels');
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual(body);
  });
});

describe('http api: error messages', () => {
  /** Zod issues, as routes send them for a body that fails validation. */
  const issues = [
    { code: 'invalid_string', path: ['id'], message: 'lowercase id: [a-z][a-z0-9_-]*' },
    { code: 'unrecognized_keys', path: [], message: 'Unrecognized key(s): "x"' },
  ];

  it.each([
    ['json', (api: ReturnType<typeof createHttpApi>) => api.createProject('Bad Id')],
    ['204', (api: ReturnType<typeof createHttpApi>) => api.deleteProject('Bad Id')],
    ['delete job', (api: ReturnType<typeof createHttpApi>) => api.deleteJob('j')],
    [
      'output text',
      (api: ReturnType<typeof createHttpApi>) => api.getOutputText('j', 'o', 'draft'),
    ],
  ])('reads validation issues as text, never [object Object] (%s)', async (_, call) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => respond(400, { error: issues })),
    );
    await expect(call(createHttpApi('/api'))).rejects.toThrow(
      'id: lowercase id: [a-z][a-z0-9_-]*; Unrecognized key(s): "x"',
    );
  });

  it('keeps a plain message, and falls back to the status', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          respond(409, { error: 'a workbench project for letter already exists' }),
        )
        .mockResolvedValueOnce(respond(500, { error: { unexpected: true } }))
        .mockResolvedValueOnce(new Response('oops', { status: 502, statusText: 'Bad Gateway' })),
    );
    const api = createHttpApi('/api');
    await expect(api.createProject('letter')).rejects.toThrow(
      'a workbench project for letter already exists',
    );
    await expect(api.createProject('letter')).rejects.toThrow('500');
    await expect(api.createProject('letter')).rejects.toThrow('502 Bad Gateway');
  });
});

describe('http api: ontology suggestions', () => {
  it('reads and refreshes the suggestions of a project', async () => {
    const view = { record: null, running: false, failed: null, stale: null };
    const fetch = vi.fn(async () => respond(200, view));
    vi.stubGlobal('fetch', fetch);
    const api = createHttpApi('/api');
    expect(await api.getOntologySuggestions('letter')).toEqual(view);
    await api.refreshOntologySuggestions('letter');
    const calls = fetch.mock.calls as unknown as [string, RequestInit | undefined][];
    expect(calls[0]![0]).toBe('/api/workbench/projects/letter/ontology-suggestions');
    expect(calls[0]![1]?.method ?? 'GET').toBe('GET');
    expect(calls[1]![0]).toBe('/api/workbench/projects/letter/ontology-suggestions');
    expect(calls[1]![1]?.method).toBe('POST');
  });
});

describe('http api: mapping memory', () => {
  it('lists with filters, reviews, adds and deletes remembered mappings', async () => {
    const calls: [string, string, unknown][] = [];
    const fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push([init?.method ?? 'GET', url, init?.body ? JSON.parse(String(init.body)) : null]);
      if (init?.method === 'DELETE') return new Response(null, { status: 204 });
      return respond(200, { entries: [], total: 0, labels: {} });
    });
    vi.stubGlobal('fetch', fetch);
    const api = createHttpApi('/api');
    await api.listMappingMemory({ status: 'review', q: 'batch no', page: 2 });
    await api.listMappingMemory({ term: 'https://x/a#b' });
    await api.getMappingMemoryEntry('m-1');
    await api.reviewMappingMemoryEntry('m-1', { status: 'confirmed' });
    await api.addMappingMemoryEntry({
      kind: 'column',
      name: 'Lot',
      answer: { form: 'literal', property: 'https://x/p' },
    });
    await api.deleteMappingMemoryEntry('m-1');
    expect(calls).toEqual([
      ['GET', '/api/ontologies/memory?status=review&q=batch+no&page=2', null],
      ['GET', '/api/ontologies/memory?term=https%3A%2F%2Fx%2Fa%23b', null],
      ['GET', '/api/ontologies/memory/m-1', null],
      ['PATCH', '/api/ontologies/memory/m-1', { status: 'confirmed' }],
      [
        'POST',
        '/api/ontologies/memory',
        { kind: 'column', name: 'Lot', answer: { form: 'literal', property: 'https://x/p' } },
      ],
      ['DELETE', '/api/ontologies/memory/m-1', null],
    ]);
  });
});

describe('http api: publishing targets', () => {
  it("lists the bridge's shared connections for the target editor", async () => {
    const api = createHttpApi('/api');
    const connections = [
      { id: 'finance-account', name: 'Finance account', status: 'ok', statusReason: null },
    ];
    const fetch = vi.fn(async () => respond(200, { connections }));
    vi.stubGlobal('fetch', fetch);
    expect(await api.listSharedConnections()).toEqual(connections);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe('/api/publish-targets/connections');
  });

  it("lists the signed-in user's personal connections for Profile", async () => {
    const api = createHttpApi('/api');
    const mine = { personalSinks: true, connections: [] };
    const fetch = vi.fn(async () => respond(200, mine));
    vi.stubGlobal('fetch', fetch);
    expect(await api.listMyConnections()).toEqual(mine);
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe('/api/profile/connections');
  });

  it('opens the connections page in a new tab, without an opener', async () => {
    const api = createHttpApi('/api');
    const url = 'https://ct.example.com/bridge/connections/start?code=abc';
    const fetch = vi.fn(async () => respond(200, { url }));
    vi.stubGlobal('fetch', fetch);
    const open = vi.fn();
    vi.stubGlobal('open', open);
    await api.openConnections();
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toBe('/api/bridge/connections-link');
    expect((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].method).toBe('POST');
    expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener');
  });
});

describe("http api: a step's model log", () => {
  it("asks for the retried runs of a step and one run's attempts", async () => {
    const api = createHttpApi('/api');
    const fetch = vi.fn(async () => respond(200, { runs: [], calls: [] }));
    vi.stubGlobal('fetch', fetch);
    await api.listRetriedStepRuns('letter', 'data');
    await api.getStepAttempts('11111111-1111-4111-8111-111111111111', 'data');
    expect(fetch.mock.calls.map((c) => String((c as unknown[])[0]))).toEqual([
      '/api/templates/letter/steps/data/retried-runs',
      '/api/jobs/11111111-1111-4111-8111-111111111111/steps/data/attempts',
    ]);
  });
});
