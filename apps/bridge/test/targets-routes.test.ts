import { randomUUID } from 'node:crypto';
import { TargetTestResultSchema, TargetViewSchema } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { Credentials } from '../src/connections/credential.js';
import { MemoryConnectionRepo } from '../src/connections/repo.js';
import { MemoryDeliveryRepo } from '../src/deliveries/repo.js';
import { MemoryObjectStore } from '../src/s3/store.js';
import { encryptSecret } from '../src/secrets.js';
import { FakeSink } from '../src/sinks/fake.js';
import { MapSinkRegistry } from '../src/sinks/port.js';
import { S3Sink } from '../src/sinks/s3.js';
import { MemoryTargetRepo } from '../src/targets/repo.js';
import { connection } from './connections-contract.js';
import { KEY, SECRETS, signedInject, testBridge } from './helpers.js';

async function setup() {
  const objects = new MemoryObjectStore();
  const targets = new MemoryTargetRepo();
  const connections = new MemoryConnectionRepo(targets);
  const deliveries = new MemoryDeliveryRepo();
  const s3 = new S3Sink({
    internal: {
      endpoint: 'http://seaweedfs:8333',
      region: 'us-east-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
      forcePathStyle: true,
    },
    make: () => objects,
  });
  await connections.put(connection('internal', { fields: {} }));
  await connections.put({
    ...connection('finance', { fields: { endpoint: 'https://s3.example.com', accessKeyId: 'A' } }),
    secretEnc: encryptSecret('finance-secret', SECRETS),
  });
  await connections.put(connection('other-sink', { sinkId: 'fake' }));
  const app = await testBridge({
    targets,
    connections,
    deliveries,
    credentials: new Credentials({ connections, secrets: SECRETS, env: {} }),
    sinks: new MapSinkRegistry({ s3, fake: new FakeSink() }),
  });
  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, body?: unknown) =>
    signedInject(app, KEY, { method, url, body });
  return { app, call, objects, targets, deliveries };
}

const finance = {
  label: 'Finance lake',
  sinkId: 's3',
  instanceId: null,
  connectionId: 'finance',
  destination: { bucket: 'pub', prefix: 'out/', sse: 'none', kmsKeyId: '', storageClass: '' },
};

describe('PUT /v1/targets/:id', () => {
  it('upserts a target and reads it back', async () => {
    const { call } = await setup();
    const res = await call('PUT', '/v1/targets/finance-lake', finance);
    expect(res.statusCode).toBe(200);
    expect(TargetViewSchema.parse(res.json())).toEqual({ id: 'finance-lake', ...finance });
    await call('PUT', '/v1/targets/finance-lake', { ...finance, label: 'Renamed' });
    const list = (await call('GET', '/v1/targets')).json().targets;
    expect(list).toEqual([{ id: 'finance-lake', ...finance, label: 'Renamed' }]);
  });

  it('takes a target with no connection yet (it then fails delivery visibly)', async () => {
    const { call } = await setup();
    const res = await call('PUT', '/v1/targets/x', { ...finance, connectionId: null });
    expect(res.statusCode).toBe(200);
  });

  it('refuses an unknown sink, a missing or foreign connection, a missing required field', async () => {
    const { call } = await setup();
    const cases = [
      { ...finance, sinkId: 'nope' },
      { ...finance, connectionId: 'gone' },
      { ...finance, connectionId: 'other-sink' },
      { ...finance, destination: { prefix: 'out/' } },
    ];
    for (const body of cases) {
      const res = await call('PUT', '/v1/targets/x', body);
      expect(res.statusCode).toBe(422);
      expect(res.json().class).toBe('needs_user');
    }
    expect((await call('PUT', '/v1/targets/x', { label: 'no sink' })).statusCode).toBe(400);
    expect((await call('GET', '/v1/targets')).json().targets).toEqual([]);
  });
});

describe('DELETE /v1/targets/:id', () => {
  it('removes a target, and refuses one that deliveries name', async () => {
    const { call, deliveries } = await setup();
    await call('PUT', '/v1/targets/a', finance);
    await call('PUT', '/v1/targets/b', finance);
    await deliveries.create(
      {
        id: randomUUID(),
        kind: 'document',
        idempotencyKey: 'c'.repeat(64),
        manifest: {},
        stagedKey: 'k',
        expiresAt: null,
      },
      [{ id: randomUUID(), targetId: 'b', actingUser: null, overrides: {} }],
      new Date(),
    );
    expect((await call('DELETE', '/v1/targets/a')).statusCode).toBe(204);
    expect((await call('DELETE', '/v1/targets/a')).statusCode).toBe(204);
    const inUse = await call('DELETE', '/v1/targets/b');
    expect(inUse.statusCode).toBe(409);
    expect(
      (await call('GET', '/v1/targets')).json().targets.map((t: { id: string }) => t.id),
    ).toEqual(['b']);
  });
});

describe('target object routes', () => {
  it('puts, reads and deletes objects through the target', async () => {
    const { call, objects } = await setup();
    await call('PUT', '/v1/targets/finance-lake', finance);
    const put = await call('POST', '/v1/targets/finance-lake/objects:put', {
      bucket: 'pub',
      key: 'out/graphs/x/v1.ttl',
      contentType: 'text/turtle',
      content: Buffer.from('@prefix x: <y> .').toString('base64'),
    });
    expect(put.statusCode).toBe(204);
    expect(objects.objects.get('pub/out/graphs/x/v1.ttl')?.contentType).toBe('text/turtle');
    const read = await call('POST', '/v1/targets/finance-lake/objects:read', {
      bucket: 'pub',
      key: 'out/graphs/x/v1.ttl',
    });
    expect(read.statusCode).toBe(200);
    expect(Buffer.from(read.json().content, 'base64').toString()).toBe('@prefix x: <y> .');
    const missing = await call('POST', '/v1/targets/finance-lake/objects:read', {
      bucket: 'pub',
      key: 'out/none',
    });
    expect(missing.statusCode).toBe(404);
    const del = await call('POST', '/v1/targets/finance-lake/objects:delete', {
      objects: [
        { bucket: 'pub', key: 'out/graphs/x/v1.ttl' },
        { bucket: 'pub', key: 'out/never-there' },
      ],
    });
    expect(del.json()).toEqual({ deleted: 2 });
    expect(objects.objects.size).toBe(0);
  });

  it('refuses an object outside the target with 422', async () => {
    const { call } = await setup();
    await call('PUT', '/v1/targets/finance-lake', finance);
    const res = await call('POST', '/v1/targets/finance-lake/objects:read', {
      bucket: 'pub',
      key: 'elsewhere/x',
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().code).toBe('content_rejected');
  });

  it('answers 405 for a sink that cannot read back or withdraw, 404 for no target', async () => {
    const { call } = await setup();
    await call('PUT', '/v1/targets/f', {
      label: 'F',
      sinkId: 'fake',
      instanceId: null,
      connectionId: null,
      destination: { bucket: 'b' },
    });
    const res = await call('POST', '/v1/targets/f/objects:read', { bucket: 'b', key: 'k' });
    expect(res.statusCode).toBe(405);
    expect(res.json().code).toBe('unsupported_part');
    const none = await call('POST', '/v1/targets/none/objects:read', { bucket: 'b', key: 'k' });
    expect(none.statusCode).toBe(404);
    // Not `not_found`: the caller tells a target the bridge lacks (yet) from a missing object.
    expect(none.json().code).toBe('target_missing');
  });
});

describe('Test connection for targets', () => {
  it('tests a saved target and unsaved settings with the probe', async () => {
    const { call } = await setup();
    await call('PUT', '/v1/targets/finance-lake', finance);
    const saved = await call('POST', '/v1/targets/finance-lake:test');
    expect(TargetTestResultSchema.parse(saved.json())).toEqual({
      ok: true,
      step: null,
      message: 'Connected: wrote, read and deleted a test file',
    });
    const unsaved = await call('POST', '/v1/targets:test', {
      connectionId: 'internal',
      destination: { bucket: 'new', prefix: '' },
    });
    expect(unsaved.json()).toMatchObject({ ok: true });
  });

  it('answers a missing connection as a failed connect step', async () => {
    const { call } = await setup();
    const res = await call('POST', '/v1/targets:test', {
      connectionId: 'gone',
      destination: { bucket: 'b' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: false, step: 'connect' });
  });
});
