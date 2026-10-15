import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { MemoryOntologyRepo } from '../src/ontologies/repo.js';
import { accessApp, multipart, testApp } from './helpers.js';

/** Ontology imports from a folder or a zip: merged into one version, or one per file. */

const ttl = (name: string) =>
  Buffer.from(
    `@prefix owl: <http://www.w3.org/2002/07/owl#> .\n<https://w3id.org/idmp/${name}> a owl:Ontology .\n`,
  );
const CORE = ttl('core');
const PROD = ttl('prod');
const hash = (b: Buffer | Uint8Array) => createHash('sha256').update(b).digest('hex');
const part = (filename: string, content: Buffer) => ({
  filename,
  content,
  contentType: 'application/octet-stream',
});
const FOLDER = {
  paths: ['idmp/core.ttl', 'idmp/sub/prod.ttl', 'idmp/README.md'],
  files: [part('core.ttl', CORE), part('prod.ttl', PROD), part('README.md', Buffer.from('# x'))],
};

async function setup() {
  const ontologies = new MemoryOntologyRepo();
  const ctx = await testApp({ ontologies });
  const batch = (fields: Record<string, string>, files = FOLDER.files, paths = FOLDER.paths) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/ontologies/batch',
      ...multipart({ ...fields, ...(paths ? { paths: JSON.stringify(paths) } : {}) }, files),
    });
  return { ...ctx, ontologies, batch };
}

describe('POST /api/ontologies/batch, merged into one ontology', () => {
  it('stores each ontology file and queues one version made of them', async () => {
    const { batch, store, ontologies } = await setup();
    const res = await batch({
      mode: 'merge',
      id: 'idmp-o',
      label: 'IDMP-O',
      tags: 'industry:pharma',
    });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.skipped).toEqual([
      { fileName: 'idmp/README.md', ontologyId: 'idmp-o', reason: 'not an ontology file' },
    ]);
    const [version] = body.versions;
    const manifest = hash(Buffer.from([hash(CORE), hash(PROD)].sort().join('\n')));
    expect(version).toMatchObject({
      ontologyId: 'idmp-o',
      version: 1,
      status: 'queued',
      sourceKind: 'files',
      fileName: 'idmp',
      sha256: manifest,
      bytes: CORE.length + PROD.length,
      sourceFiles: [
        { fileName: 'idmp/core.ttl', sha256: hash(CORE), bytes: CORE.length },
        { fileName: 'idmp/sub/prod.ttl', sha256: hash(PROD), bytes: PROD.length },
      ],
    });
    const key = (b: Buffer) => `ontologies/idmp-o/sources/${hash(b)}.ttl`;
    expect(store.objects.get(`runs/${key(CORE)}`)?.body.equals(CORE)).toBe(true);
    expect(ontologies.jobs[0]!.params).toEqual({
      ontologyId: 'idmp-o',
      version: 1,
      fileName: 'idmp',
      mediaType: '',
      sources: [
        { sourceKey: key(CORE), fileName: 'idmp/core.ttl', mediaType: 'text/turtle' },
        { sourceKey: key(PROD), fileName: 'idmp/sub/prod.ttl', mediaType: 'text/turtle' },
      ],
    });
    expect(await ontologies.get('idmp-o')).toMatchObject({
      label: 'IDMP-O',
      tags: ['industry:pharma'],
    });
  });

  it('refuses the same set of files twice, in any order', async () => {
    const { batch } = await setup();
    expect((await batch({ mode: 'merge', id: 'idmp-o', label: 'IDMP-O' })).statusCode).toBe(202);
    const again = await batch(
      { mode: 'merge', id: 'idmp-o' },
      [part('prod.ttl', PROD), part('core.ttl', CORE)],
      ['x/prod.ttl', 'x/core.ttl'],
    );
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('these files are already version 1 of idmp-o');
  });

  it('reads the ontology files of a zip, leaving out hidden and other entries', async () => {
    const { batch, ontologies } = await setup();
    const zip = Buffer.from(
      zipSync({
        'idmp/core.ttl': CORE,
        'idmp/sub/prod.owl': PROD,
        'idmp/.hidden.ttl': CORE,
        '__MACOSX/idmp/._core.ttl': strToU8('junk'),
        'idmp/notes.txt': strToU8('notes'),
        'idmp/empty/': new Uint8Array(),
      }),
    );
    const res = await batch(
      { mode: 'merge', id: 'idmp-o', label: 'IDMP-O' },
      [part('idmp-o-1.4.zip', zip)],
      undefined,
    );
    expect(res.statusCode).toBe(202);
    expect(res.json().versions[0].fileName).toBe('idmp-o-1.4.zip');
    expect(res.json().versions[0].sourceFiles.map((f: { fileName: string }) => f.fileName)).toEqual(
      ['idmp/core.ttl', 'idmp/sub/prod.owl'],
    );
    const params = ontologies.jobs[0]!.params as { sources: { mediaType: string }[] };
    expect(params.sources.map((s) => s.mediaType)).toEqual(['text/turtle', 'application/rdf+xml']);
  });
});

describe('POST /api/ontologies/batch, one ontology per file', () => {
  it('creates one version per file under ids from the prefix, in one job', async () => {
    const { batch, ontologies } = await setup();
    const res = await batch({ mode: 'separate', idPrefix: 'idmp-', localOnly: 'true' });
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.versions.map((v: { ontologyId: string }) => v.ontologyId)).toEqual([
      'idmp-core',
      'idmp-prod',
    ]);
    expect(body.skipped).toEqual([
      { fileName: 'idmp/README.md', ontologyId: 'idmp-readme', reason: 'not an ontology file' },
    ]);
    expect(ontologies.jobs).toHaveLength(1);
    expect(ontologies.jobs[0]!.params).toEqual({
      members: [
        {
          ontologyId: 'idmp-core',
          version: 1,
          sourceKey: `ontologies/idmp-core/sources/${hash(CORE)}.ttl`,
          fileName: 'idmp/core.ttl',
          mediaType: 'text/turtle',
        },
        {
          ontologyId: 'idmp-prod',
          version: 1,
          sourceKey: `ontologies/idmp-prod/sources/${hash(PROD)}.ttl`,
          fileName: 'idmp/sub/prod.ttl',
          mediaType: 'text/turtle',
        },
      ],
    });
    expect(await ontologies.get('idmp-prod')).toMatchObject({ label: 'prod', localOnly: true });
  });

  it('skips files already imported, and queues nothing when every file is', async () => {
    const { batch, ontologies } = await setup();
    await batch({ mode: 'separate', idPrefix: 'idmp-' });
    const again = await batch({ mode: 'separate', idPrefix: 'idmp-' });
    expect(again.statusCode).toBe(202);
    expect(again.json().versions).toEqual([]);
    expect(again.json().skipped.map((s: { reason: string }) => s.reason)).toEqual([
      'already version 1 of idmp-core',
      'already version 1 of idmp-prod',
      'not an ontology file',
    ]);
    expect(ontologies.jobs).toHaveLength(1);
  });

  it('adds a version to an ontology that exists', async () => {
    const { batch } = await setup();
    await batch({ mode: 'separate', idPrefix: 'idmp-' });
    const changed = Buffer.concat([CORE, Buffer.from('# v2\n')]);
    const res = await batch(
      { mode: 'separate', idPrefix: 'idmp-' },
      [part('core.ttl', changed)],
      ['idmp/core.ttl'],
    );
    expect(res.json().versions).toMatchObject([{ ontologyId: 'idmp-core', version: 2 }]);
  });
});

describe('POST /api/ontologies/batch refusals', () => {
  it.each([
    [{ mode: 'other' }, /mode must be merge or separate/],
    [{ mode: 'merge', id: 'IDMP', label: 'x' }, /id must be/],
    [{ mode: 'merge', id: 'idmp' }, /name is required for a new ontology/],
    [{ mode: 'separate', idPrefix: 'Bad Prefix' }, /prefix/],
    [{ mode: 'merge', id: 'idmp', label: 'x', tags: 'Not A Tag' }, /tag "Not A Tag"/],
  ])('refuses %j before storing anything', async (fields, message) => {
    const { batch, store } = await setup();
    const res = await batch(fields);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(message);
    expect(store.objects.size).toBe(0);
  });

  it('refuses a batch with no ontology file, a bad zip, and paths that do not match', async () => {
    const { batch, store } = await setup();
    const none = await batch(
      { mode: 'merge', id: 'idmp', label: 'x' },
      [part('a.md', Buffer.from('x'))],
      ['a.md'],
    );
    expect(none.statusCode).toBe(400);
    expect(none.json().error).toBe('no ontology files (.ttl,.owl,.rdf,.jsonld,.nt,.n3)');
    const bad = await batch(
      { mode: 'merge', id: 'idmp', label: 'x' },
      [part('x.zip', Buffer.from('not a zip'))],
      undefined,
    );
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toBe('not a valid zip');
    const mismatch = await batch({ mode: 'merge', id: 'idmp', label: 'x' }, FOLDER.files, [
      'one.ttl',
    ]);
    expect(mismatch.statusCode).toBe(400);
    expect(mismatch.json().error).toBe('paths must list one path per file');
    expect(store.objects.size).toBe(0);
  });

  it('refuses more files than ONTOLOGY_MAX_FILES', async () => {
    const { batch } = await setup();
    const files = Array.from({ length: 301 }, (_, i) => part(`m${i}.ttl`, ttl(`m${i}`)));
    const res = await batch(
      { mode: 'merge', id: 'idmp', label: 'x' },
      files,
      files.map((f) => f.filename),
    );
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('at most 300 ontology files per import');
  });

  it('is admin-only', async () => {
    const { app, userCookie, adminCookie } = await accessApp();
    const send = (cookie: string) =>
      app.inject({
        method: 'POST',
        url: '/api/ontologies/batch',
        headers: {
          cookie,
          ...multipart({ mode: 'merge', id: 'pv', label: 'x' }, [part('a.ttl', CORE)]).headers,
        },
        payload: multipart({ mode: 'merge', id: 'pv', label: 'x' }, [part('a.ttl', CORE)]).payload,
      });
    expect((await send(userCookie)).statusCode).toBe(403);
    expect((await send(adminCookie)).statusCode).toBe(202);
  });
});

describe('deleting versions of folder imports', () => {
  it('keeps the shared job and the files another version still uses', async () => {
    const { batch, ontologies, store, app } = await setup();
    await batch({ mode: 'merge', id: 'idmp-o', label: 'IDMP-O' });
    const changed = Buffer.concat([PROD, Buffer.from('# v2\n')]);
    await batch(
      { mode: 'merge', id: 'idmp-o' },
      [part('core.ttl', CORE), part('prod.ttl', changed)],
      ['idmp/core.ttl', 'idmp/sub/prod.ttl'],
    );
    ontologies.finishJob(ontologies.jobs[0]!.id, 'succeeded', null);
    ontologies.markReady('idmp-o', 1);
    const res = await app.inject({ method: 'DELETE', url: '/api/ontologies/idmp-o/versions/1' });
    expect(res.statusCode).toBe(204);
    const key = (b: Buffer) => `runs/ontologies/idmp-o/sources/${hash(b)}.ttl`;
    expect(store.objects.has(key(CORE))).toBe(true); // version 2 still uses it
    expect(store.objects.has(key(PROD))).toBe(false);
    expect(store.objects.has(key(changed))).toBe(true);
  });

  it('a folder version has no single source file to download', async () => {
    const { batch, app } = await setup();
    await batch({ mode: 'merge', id: 'idmp-o', label: 'IDMP-O' });
    const res = await app.inject('/api/ontologies/idmp-o/versions/1/source');
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('this version was imported from 2 files');
  });

  it('deleting one member keeps the job its other members share', async () => {
    const { batch, ontologies, app } = await setup();
    await batch({ mode: 'separate', idPrefix: 'idmp-' });
    ontologies.markReady('idmp-core', 1); // the job is still running for idmp-prod
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/ontologies/idmp-core/versions/1' }))
        .statusCode,
    ).toBe(204);
    expect((await ontologies.get('idmp-prod'))!.versions[0]!.status).toBe('queued');
  });
});
