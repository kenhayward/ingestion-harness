import { randomUUID } from 'node:crypto';
import { TargetTestResultSchema, TargetViewSchema } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { Credentials } from '../src/connections/credential.js';
import { MemoryConnectionRepo } from '../src/connections/repo.js';
import { MemoryDeliveryRepo } from '../src/deliveries/repo.js';
import { MemoryObjectStore } from '../src/s3/store.js';
import { encryptSecret } from '../src/secrets.js';
import { FakeSink } from '../src/sinks/fake.js';
import type { BrowseRequest, BrowseResult } from '@ih/bridge-contract';

/** A shared sink with a browsable `space`. */
class ShelfSink extends FakeSink {
  constructor() {
    super({
      destinationFields: [
        {
          id: 'space',
          label: 'Space',
          kind: 'fixed',
          required: true,
          overridable: false,
          browse: true,
        },
      ],
      capabilities: {
        browse: true,
        replace: true,
        withdraw: false,
        readBack: false,
        accepts: ['files', 'data'],
      },
    });
  }
}

/** A sink with a browsable `space`: two spaces at the root, and what each browse was sent. */
class TreeSink extends FakeSink {
  readonly browsed: BrowseRequest[] = [];
  constructor() {
    super({
      connectionKind: 'personal',
      instances: [{ id: 'sandbox', label: 'Sandbox' }],
      credentialFields: [{ id: 'token', label: 'Token', secret: true }],
      destinationFields: [
        {
          id: 'space',
          label: 'Space',
          kind: 'fixed',
          required: true,
          overridable: false,
          browse: true,
        },
        {
          id: 'name',
          label: 'Name',
          kind: 'pattern',
          required: true,
          overridable: true,
          browse: false,
        },
      ],
      capabilities: {
        browse: true,
        replace: true,
        withdraw: false,
        readBack: false,
        accepts: ['files', 'data'],
      },
    });
  }
  override async browse(req: BrowseRequest): Promise<BrowseResult> {
    this.browsed.push(structuredClone(req));
    return {
      nodes: [
        { id: 'reports', label: 'Reports', kind: 'space', hasChildren: false, selectable: true },
        { id: 'archive', label: 'Archive', kind: 'space', hasChildren: true, selectable: false },
      ],
      nextCursor: null,
    };
  }
}
import { MapSinkRegistry } from '../src/sinks/port.js';
import { RdfSink } from '../src/sinks/rdf.js';
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
  await connections.put(connection('triples', { sinkId: 'rdf' }));
  await connections.put(connection('acme-shared', { sinkId: 'acme' }));
  await connections.put(connection('shelf-keys', { sinkId: 'shelf', fields: {} }));
  await connections.put({
    ...connection('u-ada', {
      kind: 'personal',
      owner: 'u1',
      sinkId: 'tree',
      instanceId: 'sandbox',
      fields: {},
    }),
    secretEnc: encryptSecret('ada-token', SECRETS),
  });
  await connections.put(
    connection('u-mine', { kind: 'personal', owner: 'u1', sinkId: 'fake', instanceId: null }),
  );
  const app = await testBridge({
    targets,
    connections,
    deliveries,
    credentials: new Credentials({ connections, secrets: SECRETS, env: {} }),
    sinks: new MapSinkRegistry({
      s3,
      fake: new FakeSink(),
      tree: new TreeSink(),
      shelf: new ShelfSink(),
      named: new FakeSink({
        destinationFields: [
          {
            id: 'bucket',
            label: 'Bucket',
            kind: 'fixed',
            required: true,
            overridable: false,
            browse: false,
          },
          {
            id: 'name',
            label: 'Name',
            kind: 'pattern',
            required: true,
            overridable: true,
            browse: false,
          },
        ],
      }),
      acme: new FakeSink({
        connectionKind: 'personal',
        instances: [{ id: 'sandbox', label: 'Sandbox' }],
        credentialFields: [{ id: 'token', label: 'Token', secret: true }],
      }),
      rdf: new RdfSink({ store: () => ({}) as never }),
    }),
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

  it('refuses an undeclared destination field, naming it', async () => {
    const { call } = await setup();
    const res = await call('PUT', '/v1/targets/x', {
      ...finance,
      destination: { bucket: 'b', colour: 'red' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      class: 'needs_user',
      code: 'content_rejected',
      message: 'colour is not a destination field of s3',
    });
  });

  it('accepts every declared destination field', async () => {
    const { call } = await setup();
    const s3 = {
      bucket: 'b',
      prefix: 'p/',
      sse: 'none',
      kmsKeyId: '',
      storageClass: '',
      layout: 'flat',
    };
    expect((await call('PUT', '/v1/targets/a', { ...finance, destination: s3 })).statusCode).toBe(
      200,
    );
  });

  it('accepts the rdf dataset field', async () => {
    const { call } = await setup();
    const res = await call('PUT', '/v1/targets/g', {
      label: 'Graph',
      sinkId: 'rdf',
      instanceId: null,
      connectionId: 'triples',
      destination: { dataset: 'ds' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses an internal target on its own staging bucket, which holds every package', async () => {
    const { call } = await setup();
    const staging = {
      ...finance,
      destination: { ...finance.destination, bucket: 'ingest-bridge' },
    };
    const res = await call('PUT', '/v1/targets/x', { ...staging, connectionId: 'internal' });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({
      class: 'needs_user',
      code: 'content_rejected',
      message: "ingest-bridge is the bridge's staging bucket: pick another",
    });
    expect((await call('GET', '/v1/targets')).json().targets).toEqual([]);
    // Another server's bucket of that name is not the bridge's.
    expect((await call('PUT', '/v1/targets/x', staging)).statusCode).toBe(200);
  });
});

describe('DELETE /v1/targets/:id', () => {
  it('removes a target, and refuses one an unfinished delivery names', async () => {
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
      [{ id: randomUUID(), targetId: 'b', actingUser: null, overrides: {}, destination: null }],
      new Date(),
    );
    expect((await call('DELETE', '/v1/targets/a')).statusCode).toBe(204);
    expect((await call('DELETE', '/v1/targets/a')).statusCode).toBe(204);
    const inUse = await call('DELETE', '/v1/targets/b');
    expect(inUse.statusCode).toBe(409);
    expect(
      (await call('GET', '/v1/targets')).json().targets.map((t: { id: string }) => t.id),
    ).toEqual(['b']);
    // Once its delivery is final the target goes, and its id is not taken up again.
    const claimed = (await deliveries.claim(new Date(), 300))!;
    await deliveries.transition(
      claimed.id,
      { status: 'failed', error: { class: 'needs_user', code: 'not_found', message: 'x' } },
      new Date(),
      claimed.claimId,
    );
    expect((await call('DELETE', '/v1/targets/b')).statusCode).toBe(204);
    expect((await call('GET', '/v1/targets')).json().targets).toEqual([]);
    const again = await call('PUT', '/v1/targets/b', finance);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({
      class: 'needs_user',
      code: 'name_conflict',
      message: 'target b was removed, and its id is not used again: pick another',
    });
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

describe('targets of a personal sink', () => {
  const acme = (over: Record<string, unknown> = {}) => ({
    label: 'Acme',
    sinkId: 'acme',
    instanceId: 'sandbox',
    connectionId: null,
    destination: { bucket: 'b' },
    ...over,
  });

  it('name an instance of the sink and no connection', async () => {
    const { call } = await setup();
    expect((await call('PUT', '/v1/targets/acme', acme())).statusCode).toBe(200);
    const named = await call('PUT', '/v1/targets/acme', acme({ connectionId: 'acme-shared' }));
    expect(named.statusCode).toBe(422);
    expect(named.json().message).toBe(
      "a personal sink's target names no connection: each delivery uses its acting user's",
    );
    const other = await call('PUT', '/v1/targets/acme', acme({ instanceId: 'other' }));
    expect(other.statusCode).toBe(422);
    expect(other.json().message).toBe('other is not an instance of acme');
  });

  it("a shared sink's target never names a personal connection", async () => {
    const { call } = await setup();
    const res = await call('PUT', '/v1/targets/f', {
      label: 'F',
      sinkId: 'fake',
      instanceId: null,
      connectionId: 'u-mine',
      destination: { bucket: 'b' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toBe('u-mine is a personal connection');
  });
});

describe('a target’s own name patterns', () => {
  it('are checked when it is written', async () => {
    const { call } = await setup();
    const res = await call('PUT', '/v1/targets/named', {
      label: 'Named',
      sinkId: 'named',
      instanceId: null,
      connectionId: null,
      destination: { bucket: 'b', name: '{nope}' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toBe('Name: `{nope}`: unknown variable nope at 1');
    const ok = await call('PUT', '/v1/targets/named', {
      label: 'Named',
      sinkId: 'named',
      instanceId: null,
      connectionId: null,
      destination: { bucket: 'b', name: '{source.stem}' },
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('POST /v1/targets:browse', () => {
  const browse = (over: Record<string, unknown> = {}) => ({
    sinkId: 'tree',
    instanceId: 'sandbox',
    connectionId: null,
    field: 'space',
    parentId: null,
    cursor: null,
    actingUser: { id: 'u1', name: 'Ada', email: null },
    ...over,
  });

  it("browses a personal sink with the acting admin's own connection", async () => {
    const { call, app } = await setup();
    const res = await call('POST', '/v1/targets:browse', browse());
    expect(res.statusCode).toBe(200);
    expect(res.json().nodes.map((n: { id: string }) => n.id)).toEqual(['reports', 'archive']);
    const tree = app.deps.sinks.get('tree') as unknown as TreeSink;
    expect(tree.browsed).toEqual([
      {
        instanceId: 'sandbox',
        credential: { token: 'ada-token' },
        field: 'space',
        parentId: null,
        cursor: null,
      },
    ]);
  });

  it('refuses an admin with no connection for the instance, a field it cannot browse, or no sink', async () => {
    const { call } = await setup();
    const none = await call(
      'POST',
      '/v1/targets:browse',
      browse({ actingUser: { id: 'u9', name: 'Zed', email: null } }),
    );
    expect(none.statusCode).toBe(422);
    expect(none.json()).toMatchObject({
      code: 'connection_missing',
      message: 'Zed has no connection for sandbox: add one on the connections page',
    });
    const field = await call('POST', '/v1/targets:browse', browse({ field: 'name' }));
    expect(field.statusCode).toBe(422);
    expect(field.json().message).toBe('name of tree cannot be browsed');
    const sink = await call('POST', '/v1/targets:browse', browse({ sinkId: 'nosuch' }));
    expect(sink.statusCode).toBe(422);
  });
});

describe('POST /v1/targets:browse of a shared sink', () => {
  const browse = (connectionId: string | null) => ({
    sinkId: 'shelf',
    instanceId: null,
    connectionId,
    field: 'space',
    parentId: null,
    cursor: null,
    actingUser: { id: 'u1', name: 'Ada', email: null },
  });

  it("uses only a shared connection of that sink: never a person's, nor another sink's", async () => {
    const { call } = await setup();
    expect((await call('POST', '/v1/targets:browse', browse('shelf-keys'))).statusCode).toBe(200);
    for (const id of ['u-ada', 'finance', 'nosuch']) {
      const res = await call('POST', '/v1/targets:browse', browse(id));
      expect([id, res.statusCode]).toEqual([id, 422]);
      expect(res.json().message).toBe(`there is no shared connection ${id} for shelf`);
    }
  });
});
