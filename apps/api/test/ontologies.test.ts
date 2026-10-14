import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryOntologyRepo } from '../src/ontologies/repo.js';
import { accessApp, multipart, testApp } from './helpers.js';

const TTL = Buffer.from(
  '@prefix owl: <http://www.w3.org/2002/07/owl#> .\n<https://e.org/A> a owl:Class .\n',
);
const sha = createHash('sha256').update(TTL).digest('hex');
const ttlFile = { filename: 'pv.ttl', content: TTL, contentType: 'text/turtle' };

async function setup() {
  const ontologies = new MemoryOntologyRepo();
  const ctx = await testApp({ ontologies });
  const upload = (fields: Record<string, string>, file = ttlFile) =>
    ctx.app.inject({ method: 'POST', url: '/api/ontologies', ...multipart(fields, file) });
  return { ...ctx, ontologies, upload };
}

describe('POST /api/ontologies', () => {
  it('stores the file by its bytes and queues an import', async () => {
    const { upload, store, ontologies } = await setup();
    const res = await upload({
      id: 'pv',
      label: 'Process validation',
      tags: 'industry:pharma, customer:acme',
      localOnly: 'true',
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      ontologyId: 'pv',
      version: 1,
      status: 'queued',
      sha256: sha,
      mediaType: 'text/turtle',
      importedBy: null,
    });
    expect(store.objects.get(`runs/ontologies/pv/sources/${sha}.ttl`)?.body.equals(TTL)).toBe(true);
    expect(ontologies.jobs[0]!.params).toMatchObject({
      sourceKey: `ontologies/pv/sources/${sha}.ttl`,
      fileName: 'pv.ttl',
      mediaType: 'text/turtle',
    });
    expect(await ontologies.get('pv')).toMatchObject({
      label: 'Process validation',
      tags: ['industry:pharma', 'customer:acme'],
      localOnly: true,
    });
  });

  it.each([
    [{ id: 'PV', label: 'x' }, /id must be/],
    [{ id: 'pv' }, /name is required for a new ontology/],
    [{ id: 'pv', label: 'x', tags: 'Not A Tag' }, /tag "Not A Tag"/],
  ])('refuses %j', async (fields, message) => {
    const { upload, store } = await setup();
    const res = await upload(fields);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(message);
    expect(store.objects.size).toBe(0);
  });

  it('refuses files that are not RDF, and the same bytes twice', async () => {
    const { upload } = await setup();
    const pdf = await upload(
      { id: 'pv', label: 'x' },
      { filename: 'pv.pdf', content: TTL, contentType: 'application/pdf' },
    );
    expect(pdf.statusCode).toBe(415);
    expect(pdf.json().error).toMatch(/not a supported RDF format \(\.ttl,\.owl/);
    expect((await upload({ id: 'pv', label: 'x' })).statusCode).toBe(202);
    const again = await upload({ id: 'pv' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('this file is already version 1 of pv');
  });

  it('is admin-only', async () => {
    const { app, userCookie, adminCookie } = await accessApp();
    const send = (cookie: string) => {
      const body = multipart({ id: 'pv', label: 'x' }, ttlFile);
      return app.inject({
        method: 'POST',
        url: '/api/ontologies',
        payload: body.payload,
        headers: { ...body.headers, cookie },
      });
    };
    const refused = await send(userCookie);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toEqual({ error: 'admins only' });
    const accepted = await send(adminCookie);
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json().importedBy).toBe('admin');
  });
});

describe('reading and managing ontologies', () => {
  it('lists, hides retired ones unless asked, and shows versions newest first', async () => {
    const { app, upload } = await setup();
    await upload({ id: 'pv', label: 'Process validation' });
    expect((await app.inject({ url: '/api/ontologies' })).json()).toMatchObject([{ id: 'pv' }]);
    const retire = await app.inject({
      method: 'PATCH',
      url: '/api/ontologies/pv',
      payload: { retired: true },
    });
    expect(retire.statusCode).toBe(200);
    expect((await app.inject({ url: '/api/ontologies' })).json()).toEqual([]);
    const all = (await app.inject({ url: '/api/ontologies?retired=include' })).json();
    expect(all).toMatchObject([{ id: 'pv', retiredAt: expect.any(String), versionCount: 1 }]);
    const detail = await app.inject({ url: '/api/ontologies/pv' });
    expect(detail.json()).toMatchObject({ id: 'pv', versions: [{ version: 1 }] });
    expect((await app.inject({ url: '/api/ontologies/nope' })).statusCode).toBe(404);
  });

  it('patches with a strict body', async () => {
    const { app, upload } = await setup();
    await upload({ id: 'pv', label: 'Process validation' });
    const patch = (url: string, payload: object) => app.inject({ method: 'PATCH', url, payload });
    expect((await patch('/api/ontologies/pv', { version: 3 })).statusCode).toBe(400);
    const ok = await patch('/api/ontologies/pv', { label: 'PV', tags: ['customer:acme'] });
    expect(ok.json()).toMatchObject({ label: 'PV', tags: ['customer:acme'] });
    expect((await patch('/api/ontologies/nope', { label: 'x' })).statusCode).toBe(404);
  });

  it('deletes a finished version and its files; refuses one still importing', async () => {
    const { app, upload, ontologies, store } = await setup();
    await upload({ id: 'pv', label: 'Process validation' });
    const busy = await app.inject({ method: 'DELETE', url: '/api/ontologies/pv/versions/1' });
    expect(busy.statusCode).toBe(409);
    expect(busy.json().error).toBe('version 1 of pv is still being imported');
    ontologies.markReady('pv', 1);
    await store.put('runs', 'ontologies/pv/v1/normalized.nt', Buffer.from('x'), 'text/plain');
    const gone = await app.inject({ method: 'DELETE', url: '/api/ontologies/pv/versions/1' });
    expect(gone.statusCode).toBe(204);
    expect([...store.objects.keys()].filter((k) => k.includes('ontologies/pv'))).toEqual([]);
    const again = await app.inject({ method: 'DELETE', url: '/api/ontologies/pv/versions/1' });
    expect(again.statusCode).toBe(404);
  });

  it('downloads the source as imported', async () => {
    const { app, upload } = await setup();
    await upload({ id: 'pv', label: 'Process validation' });
    const res = await app.inject({ url: '/api/ontologies/pv/versions/1/source' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/turtle');
    expect(res.headers['content-disposition']).toBe('attachment; filename="pv.ttl"');
    expect(res.rawPayload.equals(TTL)).toBe(true);
    expect((await app.inject({ url: '/api/ontologies/pv/versions/9/source' })).statusCode).toBe(
      404,
    );
  });
});

describe('non-ASCII file names', () => {
  it('downloads under an ASCII fallback and the exact UTF-8 name', async () => {
    const { app, upload } = await setup();
    await upload(
      { id: 'pv', label: 'Process validation' },
      { filename: '本体 é.ttl', content: TTL, contentType: 'text/turtle' },
    );
    const res = await app.inject({ url: '/api/ontologies/pv/versions/1/source' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(
      `attachment; filename="__ _.ttl"; filename*=UTF-8''${encodeURIComponent('本体 é.ttl')}`,
    );
  });
});

describe('browsing terms', () => {
  const C = 'https://example.org/pv#';
  async function ready() {
    const ctx = await setup();
    await ctx.upload({ id: 'pv', label: 'Process validation' });
    ctx.ontologies.markReady('pv', 1);
    ctx.ontologies.seedTerms('pv', 1, [
      { iri: `${C}Document`, kind: 'class', label: 'Document', root: true, childCount: 1 },
      { iri: `${C}Protocol`, kind: 'class', label: 'Protocol', parents: [`${C}Document`] },
    ]);
    return ctx;
  }
  const terms = '/api/ontologies/pv/versions/1/terms';
  const term = (iri: string) => `/api/ontologies/pv/versions/1/term?iri=${encodeURIComponent(iri)}`;

  it('pages roots, children and search hits', async () => {
    const { app } = await ready();
    const roots = await app.inject({ url: `${terms}?group=classes&root=1` });
    expect(roots.json()).toMatchObject({
      total: 1,
      offset: 0,
      limit: 100,
      items: [{ label: 'Document', childCount: 1 }],
    });
    const kids = await app.inject({ url: `${terms}?parent=${encodeURIComponent(`${C}Document`)}` });
    expect(kids.json().items.map((t: { label: string }) => t.label)).toEqual(['Protocol']);
    const hits = await app.inject({ url: `${terms}?q=proto&limit=5` });
    expect(hits.json()).toMatchObject({ limit: 5, items: [{ label: 'Protocol' }] });
  });

  it('refuses a bad query and an unknown version', async () => {
    const { app } = await ready();
    expect((await app.inject({ url: `${terms}?group=nope` })).statusCode).toBe(400);
    expect((await app.inject({ url: `${terms}?limit=999` })).statusCode).toBe(400);
    const unknown = await app.inject({ url: '/api/ontologies/pv/versions/2/terms' });
    expect(unknown.statusCode).toBe(404);
  });

  it('describes a term', async () => {
    const { app } = await ready();
    const res = await app.inject({ url: term(`${C}Protocol`) });
    expect(res.json()).toMatchObject({ label: 'Protocol', parentTerms: [{ label: 'Document' }] });
    const missing = await app.inject({ url: '/api/ontologies/pv/versions/1/term' });
    expect(missing.statusCode).toBe(400);
    expect((await app.inject({ url: term(`${C}Nope`) })).statusCode).toBe(404);
  });
});

describe('importing by URL', () => {
  const post = (app: Awaited<ReturnType<typeof setup>>['app'], payload: object) =>
    app.inject({ method: 'POST', url: '/api/ontologies/from-url', payload });

  it('queues a fetch for an allowed https URL', async () => {
    const { app, ontologies, store } = await setup();
    const res = await post(app, {
      id: 'idmp-o',
      label: 'IDMP-O',
      url: 'https://w3id.org/idmp/core.ttl',
      tags: ['industry:pharma'],
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({
      sourceKind: 'url',
      sourceUrl: 'https://w3id.org/idmp/core.ttl',
      fileName: 'core.ttl',
      sha256: null,
    });
    expect(ontologies.jobs[0]!.params).toMatchObject({
      sourceUrl: 'https://w3id.org/idmp/core.ttl',
    });
    expect(await ontologies.get('idmp-o')).toMatchObject({ tags: ['industry:pharma'] });
    expect(store.objects.size).toBe(0);
  });

  it.each([
    [{ id: 'x1', label: 'X', url: 'http://w3id.org/a' }, 'only https URLs can be imported'],
    [
      { id: 'x1', label: 'X', url: 'https://evil.org/a' },
      'evil.org is not on ONTOLOGY_FETCH_ALLOW',
    ],
    [{ id: 'x1', url: 'https://w3id.org/a' }, 'name is required for a new ontology'],
  ])('refuses %j', async (payload, error) => {
    const { app } = await setup();
    const res = await post(app, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(error);
  });

  it('refuses a malformed body', async () => {
    const { app } = await setup();
    expect((await post(app, { id: 'x1', url: 'https://w3id.org/a', extra: 1 })).statusCode).toBe(
      400,
    );
  });

  it('is off without allowed hosts, and tells everyone the policy', async () => {
    const { app } = await testApp({
      ontologies: new MemoryOntologyRepo(),
      ontologyFetch: { hosts: [], maxBytes: 5 },
    });
    const res = await post(app, { id: 'x1', label: 'X', url: 'https://w3id.org/a' });
    expect(res.json().error).toBe('URL imports are off: set ONTOLOGY_FETCH_ALLOW');
    expect((await app.inject({ url: '/api/ontology-settings' })).json()).toEqual({
      fetchHosts: [],
      maxBytes: 5,
    });
  });

  it('is admin-only, and a URL version has no source to download yet', async () => {
    const { app, userCookie, adminCookie } = await accessApp();
    const send = (cookie: string) =>
      app.inject({
        method: 'POST',
        url: '/api/ontologies/from-url',
        headers: { cookie },
        payload: { id: 'x1', label: 'X', url: 'https://w3id.org/a' },
      });
    expect((await send(userCookie)).statusCode).toBe(403);
    expect((await send(adminCookie)).statusCode).toBe(202);
    const dl = await app.inject({
      url: '/api/ontologies/x1/versions/1/source',
      headers: { cookie: adminCookie },
    });
    expect(dl.statusCode).toBe(404);
  });
});
