import { FOLDER_MISSING_REASON, type SourceFile } from '@ih/bridge-contract';
import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { Credentials } from '../src/connections/credential.js';
import { MemoryConnectionRepo } from '../src/connections/repo.js';
import { encryptSecret } from '../src/secrets.js';
import { FakeDocumentSink, FAKE_SOURCE } from '../src/sinks/fake-documents.js';
import { buildDocumentServer } from '../src/sinks/fake-server.js';
import { FakeSink } from '../src/sinks/fake.js';
import { HttpSink } from '../src/sinks/http.js';
import { MapSinkRegistry, type SinkPort } from '../src/sinks/port.js';
import { MemoryTargetRepo } from '../src/targets/repo.js';
import { connection } from './connections-contract.js';
import { KEY, SECRETS, signedInject, TEST_CONFIG, testBridge } from './helpers.js';

const SINK_KEY = 's'.repeat(32);
const open: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

const source = { folder: FAKE_SOURCE };

/** A bridge with one target `watch` on `sink`, plus the bridge's connections. */
async function bridgeOn(sink: SinkPort, opts: { maxSourceMb?: number; instanceId?: string } = {}) {
  const targets = new MemoryTargetRepo();
  await targets.put({
    id: 'watch',
    label: 'Watch',
    sinkId: 'docs',
    instanceId: opts.instanceId ?? 'main',
    connectionId: null,
    destination: { space: 's' },
  });
  const connections = new MemoryConnectionRepo(targets);
  const app = await testBridge({
    config: { ...TEST_CONFIG, BRIDGE_MAX_SOURCE_MB: opts.maxSourceMb ?? 100 },
    targets,
    connections,
    credentials: new Credentials({ connections, secrets: SECRETS, env: {} }),
    sinks: new MapSinkRegistry({ docs: sink }),
  });
  open.push(app);
  const call = (op: 'list' | 'read' | 'move' | 'put', body: Record<string, unknown>) =>
    signedInject(app, KEY, {
      method: 'POST',
      url: `/v1/targets/watch/sources:${op}`,
      body: { source, actingUser: null, ...body },
    });
  return { app, call, connections };
}

/** The fake document sink served over HTTP, and the bridge reaching it through HttpSink. */
async function overHttp(opts: { maxSourceMb?: number } = {}) {
  const docs = new FakeDocumentSink();
  const server = await buildDocumentServer(SINK_KEY, false, docs);
  open.push(server);
  const url = await server.listen({ host: '127.0.0.1', port: 0 });
  const bridge = await bridgeOn(new HttpSink({ id: 'docs', url, key: SINK_KEY }), opts);
  const drop = (name: string, content: Buffer) =>
    fetch(`${url}/_drop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, content: content.toString('base64') }),
    });
  return { ...bridge, docs, drop, url };
}

const names = (files: SourceFile[]) => files.map((f) => [f.name, f.size]);

describe('watched folders through the bridge', () => {
  it('lists an empty root, then the files dropped into it with their sizes', async () => {
    const { call, drop } = await overHttp();
    const empty = await call('list', { folder: '' });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ files: [] });

    expect((await drop('a.docx', Buffer.from('aaa'))).status).toBe(204);
    expect((await drop('b.pdf', Buffer.from('bbbbb'))).status).toBe(204);
    const listed = await call('list', { folder: '' });
    expect(names(listed.json().files)).toEqual([
      ['a.docx', 3],
      ['b.pdf', 5],
    ]);
  });

  it('moves a file into processing, and a repeated move still succeeds', async () => {
    const { call, drop, url } = await overHttp();
    await drop('a.docx', Buffer.from('aaa'));
    await drop('b.pdf', Buffer.from('bbbbb'));
    const move = () =>
      call('move', {
        from: { folder: '', name: 'a.docx' },
        to: { folder: 'processing', name: 'a.docx' },
      });
    expect((await move()).statusCode).toBe(204);
    expect(names((await call('list', { folder: '' })).json().files)).toEqual([['b.pdf', 5]]);
    expect(names((await call('list', { folder: 'processing' })).json().files)).toEqual([
      ['a.docx', 3],
    ]);
    expect((await move()).statusCode).toBe(204);

    // The fake's own test view of a folder agrees.
    const seen = await fetch(`${url}/_folder?f=processing`);
    expect(names(((await seen.json()) as { files: SourceFile[] }).files)).toEqual([['a.docx', 3]]);
  });

  it('reads a moved file as its bytes', async () => {
    const { call, drop } = await overHttp();
    const bytes = Buffer.from([0, 1, 2, 250, 255]);
    await drop('x.pdf', bytes);
    await call('move', {
      from: { folder: '', name: 'x.pdf' },
      to: { folder: 'processing', name: 'x.pdf' },
    });
    const read = await call('read', { folder: 'processing', name: 'x.pdf' });
    expect(read.statusCode).toBe(200);
    expect(read.headers['content-type']).toMatch(/^application\/octet-stream/);
    expect(read.rawPayload).toEqual(bytes);
  });

  it('puts a text file, listed with the size of its text', async () => {
    const { call } = await overHttp();
    const content = 'Could not convert: the file is password protected. é';
    const put = await call('put', { folder: 'failed', name: 'x.pdf.md', content });
    expect(put.statusCode).toBe(204);
    const failed = await call('list', { folder: 'failed' });
    expect(names(failed.json().files)).toEqual([['x.pdf.md', Buffer.byteLength(content)]]);
  });

  it('a read over the cap is refused (the sink declares the length: content-length past the cap)', async () => {
    const { call, drop } = await overHttp({ maxSourceMb: 1 });
    await drop('big.pdf', Buffer.alloc(2 * 2 ** 20, 7));
    const read = await call('read', { folder: '', name: 'big.pdf' });
    expect(read.statusCode).toBe(422);
    expect(read.json()).toMatchObject({
      class: 'needs_user',
      code: 'content_rejected',
      details: { reason: 'too_large' },
    });
  });

  it('a missing source folder is not_found with folder_missing', async () => {
    const { app } = await overHttp();
    const res = await signedInject(app, KEY, {
      method: 'POST',
      url: '/v1/targets/watch/sources:list',
      body: { source: { folder: 'nowhere' }, actingUser: null, folder: '' },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({
      code: 'not_found',
      details: { reason: FOLDER_MISSING_REASON },
    });
  });

  it('refuses a source field the sink does not declare', async () => {
    const { app } = await overHttp();
    const res = await signedInject(app, KEY, {
      method: 'POST',
      url: '/v1/targets/watch/sources:list',
      body: { source: { folder: FAKE_SOURCE, other: 'x' }, actingUser: null, folder: '' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ code: 'content_rejected' });
  });

  it('refuses a body that is not valid, and an unknown target', async () => {
    const { call, app } = await overHttp();
    expect((await call('read', { folder: 'sideways', name: 'a' })).statusCode).toBe(400);
    expect((await call('read', { folder: '', name: 'a/b' })).statusCode).toBe(400);
    const missing = await signedInject(app, KEY, {
      method: 'POST',
      url: '/v1/targets/nope/sources:list',
      body: { source, actingUser: null, folder: '' },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ code: 'target_missing' });
  });

  it('a sink that does not declare watched folders is refused with 405', async () => {
    const { call } = await bridgeOn(new FakeSink({ contractVersion: 3 }));
    const res = await call('list', { folder: '' });
    expect(res.statusCode).toBe(405);
    expect(res.json()).toMatchObject({ code: 'unsupported_part' });
  });

  it("a personal sink needs the acting user's own connection", async () => {
    const docs = new FakeDocumentSink({ connectionKind: 'personal' });
    const { app, connections } = await bridgeOn(docs);
    await connections.put({
      ...connection('pat', {
        kind: 'personal',
        owner: 'u1',
        sinkId: 'docs',
        instanceId: 'main',
        fields: { username: 'pat' },
      }),
      secretEnc: encryptSecret('pat-pw', SECRETS),
    });
    const as = (actingUser: { id: string; name: string; email: null } | null) =>
      signedInject(app, KEY, {
        method: 'POST',
        url: '/v1/targets/watch/sources:list',
        body: { source, actingUser, folder: '' },
      });

    const nobody = await as(null);
    expect(nobody.statusCode).toBe(409);
    expect(nobody.json()).toMatchObject({ code: 'connection_missing' });

    const sam = { id: 'u2', name: 'Sam', email: null };
    const refused = await as(sam);
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ code: 'connection_missing' });
    expect(docs.sourceCalls).toEqual([]);

    expect((await as({ id: 'u1', name: 'Pat', email: null })).statusCode).toBe(200);
    await connections.put({
      ...connection('sam', {
        kind: 'personal',
        owner: 'u2',
        sinkId: 'docs',
        instanceId: 'main',
        fields: { username: 'sam' },
      }),
      secretEnc: encryptSecret('sam-pw', SECRETS),
    });
    expect((await as(sam)).statusCode).toBe(200);
    expect(docs.sourceCalls.map((c) => c.credential)).toEqual([
      { username: 'pat', password: 'pat-pw' },
      { username: 'sam', password: 'sam-pw' },
    ]);
  });
});

describe('browsing a source field', () => {
  it("passes the source scope to the sink and browses the sink's watched locations", async () => {
    const { app } = await bridgeOn(new FakeDocumentSink());
    const browse = (body: Record<string, unknown>) =>
      signedInject(app, KEY, {
        method: 'POST',
        url: '/v1/targets:browse',
        body: {
          sinkId: 'docs',
          instanceId: 'main',
          connectionId: null,
          parentId: null,
          cursor: null,
          actingUser: null,
          ...body,
        },
      });
    const res = await browse({ field: 'folder', scope: 'source' });
    expect(res.statusCode).toBe(200);
    expect(res.json().nodes.map((n: { id: string }) => n.id)).toContain(FAKE_SOURCE);

    // `folder` is no destination field: browsing it as one is refused.
    expect((await browse({ field: 'folder' })).statusCode).toBe(422);
    expect((await browse({ field: 'space', scope: 'source' })).statusCode).toBe(422);
  });
});
