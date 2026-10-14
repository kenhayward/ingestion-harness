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
