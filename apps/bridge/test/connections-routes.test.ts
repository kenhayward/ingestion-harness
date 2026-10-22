import { ConnectionSummarySchema } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { MemoryConnectionRepo } from '../src/connections/repo.js';
import { decryptSecret } from '../src/secrets.js';
import { FakeSink } from '../src/sinks/fake.js';
import { MapSinkRegistry } from '../src/sinks/port.js';
import { RdfSink } from '../src/sinks/rdf.js';
import { S3Sink } from '../src/sinks/s3.js';
import { MemoryTargetRepo } from '../src/targets/repo.js';
import { connection } from './connections-contract.js';
import { KEY, SECRETS, signedInject, testBridge } from './helpers.js';

async function setup() {
  const targets = new MemoryTargetRepo();
  const connections = new MemoryConnectionRepo(targets);
  const s3 = new S3Sink({
    internal: {
      endpoint: 'http://seaweedfs:8333',
      region: 'us-east-1',
      accessKeyId: 'k',
      secretAccessKey: 's',
      forcePathStyle: true,
    },
  });
  const rdf = new RdfSink({
    store: () => {
      throw new Error('no triple store in these tests');
    },
  });
  const acme = new FakeSink({
    name: 'Acme',
    connectionKind: 'personal',
    instances: [{ id: 'sandbox', label: 'Sandbox' }],
    credentialFields: [
      { id: 'username', label: 'Username', secret: false },
      { id: 'password', label: 'Password', secret: true },
    ],
  });
  const app = await testBridge({
    targets,
    connections,
    sinks: new MapSinkRegistry({ s3, rdf, acme }),
  });
  const call = (method: 'GET' | 'PUT' | 'POST' | 'DELETE', url: string, body?: unknown) =>
    signedInject(app, KEY, { method, url, body });
  return { app, call, connections };
}

describe('PUT /v1/connections/:id (the one-off move of a target’s keys)', () => {
  it('stores a shared S3 connection with its secret encrypted under the bridge key', async () => {
    const { call, connections } = await setup();
    const res = await call('PUT', '/v1/connections/target-finance-lake', {
      name: 'Finance lake',
      sinkId: 's3',
      fields: { endpoint: 'https://s3.example.com', accessKeyId: 'AKIA' },
      secret: 'the-secret',
      secretEnv: null,
    });
    expect(res.statusCode).toBe(204);
    expect(await connections.get('target-finance-lake')).toMatchObject({
      kind: 'shared',
      owner: null,
      sinkId: 's3',
      secretSet: true,
      status: 'untested',
    });
    const stored = await connections.secretOf('target-finance-lake');
    expect(decryptSecret(stored!.secretEnc!, SECRETS)).toBe('the-secret');
  });

  it('stores an env-keyed connection by variable name only', async () => {
    const { call, connections } = await setup();
    const res = await call('PUT', '/v1/connections/target-default', {
      name: 'Default',
      sinkId: 's3',
      fields: { endpoint: 'https://s3.example.com', accessKeyIdEnv: 'TARGET_S3_ACCESS_KEY' },
      secret: null,
      secretEnv: 'TARGET_S3_SECRET_KEY',
    });
    expect(res.statusCode).toBe(204);
    expect(await connections.secretOf('target-default')).toEqual({
      secretEnc: null,
      secretEnv: 'TARGET_S3_SECRET_KEY',
    });
  });

  it('refuses a variable outside the allowlist, an unknown sink, the internal id and both secrets', async () => {
    const { call } = await setup();
    const base = { name: 'X', sinkId: 's3', fields: {}, secret: null, secretEnv: null };
    for (const [id, body] of [
      ['x', { ...base, secretEnv: 'DATABASE_URL' }],
      ['x', { ...base, sinkId: 'nope' }],
      ['internal', base],
      ['x', { ...base, secret: 's', secretEnv: 'TARGET_S3_SECRET_KEY' }],
    ] as const) {
      expect((await call('PUT', `/v1/connections/${id}`, body)).statusCode).toBe(422);
    }
  });

  it('takes ids long enough for target-<40-character target id>', async () => {
    const { call } = await setup();
    const id = `target-${'a'.repeat(40)}`;
    const res = await call('PUT', `/v1/connections/${id}`, {
      name: 'Long',
      sinkId: 's3',
      fields: {},
      secret: 's',
      secretEnv: null,
    });
    expect(res.statusCode).toBe(204);
  });
});

describe('GET /v1/connections', () => {
  it('lists shared connections without secrets', async () => {
    const { call, connections } = await setup();
    await connections.put(connection('internal', { name: 'This deployment', fields: {} }));
    await connections.put({
      ...connection('finance', { status: 'needs_attention', statusReason: 'access denied' }),
      secretEnc: 'v1:ciphertext',
    });
    await connections.put(connection('mine', { kind: 'personal', owner: 'u1' }));
    const res = await call('GET', '/v1/connections?kind=shared');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('v1:ciphertext');
    const list = res.json().connections.map((c: unknown) => ConnectionSummarySchema.parse(c));
    expect(list).toEqual([
      {
        id: 'finance',
        name: 'Connection finance',
        sinkId: 's3',
        kind: 'shared',
        instanceId: null,
        status: 'needs_attention',
        statusReason: 'access denied',
        lastUsedAt: null,
        fields: { endpoint: 'https://s3.example.com', accessKeyId: 'AKIA1' },
      },
      {
        id: 'internal',
        name: 'This deployment',
        sinkId: 's3',
        kind: 'shared',
        instanceId: null,
        status: 'untested',
        statusReason: null,
        lastUsedAt: null,
        fields: {},
      },
    ]);
  });

  it('a summary lists the non-secret fields and never a secret one', async () => {
    const { call, connections } = await setup();
    // Stored straight into the repo: a secret or undeclared field must still never be answered.
    await connections.put({
      ...connection('lake', {
        fields: {
          endpoint: 'https://s3.example.com',
          accessKeyId: 'AKIA9',
          secretAccessKey: 'leaked-if-listed',
          accessKeyIdEnv: 'TARGET_S3_ACCESS_KEY',
        },
        secretEnv: 'TARGET_S3_SECRET_KEY',
      }),
    });
    await connections.put({
      ...connection('rdf-default', {
        sinkId: 'rdf',
        name: 'Triple store',
        fields: { endpoint: 'http://fuseki:3030', user: 'ct-writer', password: 'pw-if-listed' },
      }),
      secretEnc: 'v1:rdf-ciphertext',
    });
    const res = await call('GET', '/v1/connections?kind=shared');
    expect(res.statusCode).toBe(200);
    for (const leak of ['leaked-if-listed', 'pw-if-listed', 'v1:rdf-ciphertext', 'TARGET_S3_']) {
      expect(res.body).not.toContain(leak);
    }
    const byId = Object.fromEntries(
      res.json().connections.map((c: unknown) => {
        const s = ConnectionSummarySchema.parse(c);
        return [s.id, s.fields];
      }),
    );
    expect(byId).toEqual({
      lake: { endpoint: 'https://s3.example.com', accessKeyId: 'AKIA9' },
      'rdf-default': { endpoint: 'http://fuseki:3030', user: 'ct-writer' },
    });
  });
});

const mine = (id: string, owner: string, over: Parameters<typeof connection>[1] = {}) =>
  connection(id, {
    kind: 'personal',
    owner,
    sinkId: 'acme',
    instanceId: 'sandbox',
    fields: { username: `${owner}-login` },
    ...over,
  });

describe('personal connections, as the producer reaches them', () => {
  it("lists one owner's connections, with no fields and never a secret", async () => {
    const { call, connections } = await setup();
    await connections.put({ ...mine('u-1', 'u1'), secretEnc: 'v1:personal-cipher' });
    await connections.put(mine('u-2', 'u2'));
    await connections.put(connection('finance'));
    const res = await call('GET', '/v1/connections?kind=personal&owner=u1');
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('v1:personal-cipher');
    expect(res.body).not.toContain('u1-login');
    const list = res.json().connections.map((c: unknown) => ConnectionSummarySchema.parse(c));
    expect(list).toEqual([
      {
        id: 'u-1',
        name: 'Connection u-1',
        sinkId: 'acme',
        kind: 'personal',
        instanceId: 'sandbox',
        status: 'untested',
        statusReason: null,
        lastUsedAt: null,
        fields: {},
      },
    ]);
  });

  it('never lists every owner: personal needs an owner, and no kind is shared only', async () => {
    const { call, connections } = await setup();
    await connections.put(mine('u-1', 'u1'));
    await connections.put(connection('finance'));
    expect((await call('GET', '/v1/connections?kind=personal')).statusCode).toBe(400);
    const all = (await call('GET', '/v1/connections')).json().connections;
    expect(all.map((c: { id: string }) => c.id)).toEqual(['finance']);
  });

  it("deletes one user's personal connections, and no shared one", async () => {
    const { call, connections } = await setup();
    await connections.put(mine('u-1', 'u1'));
    await connections.put(mine('u-2', 'u2'));
    await connections.put(connection('finance'));
    const res = await call('DELETE', '/v1/users/u1/connections');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 1 });
    expect((await connections.list({})).map((c) => c.id)).toEqual(['finance', 'u-2']);
  });

  it('reconciles against the live users, and refuses an empty list', async () => {
    const { call, connections } = await setup();
    await connections.put(mine('u-1', 'u1'));
    await connections.put(mine('u-2', 'u2'));
    await connections.put(mine('u-3', 'u3'));
    await connections.put(connection('finance'));
    const empty = await call('POST', '/v1/users:reconcile', { liveUserIds: [] });
    expect(empty.statusCode).toBe(422);
    expect(await connections.list({})).toHaveLength(4);
    const res = await call('POST', '/v1/users:reconcile', { liveUserIds: ['u2'] });
    expect(res.json()).toEqual({ deleted: 2 });
    expect((await connections.list({})).map((c) => c.id)).toEqual(['finance', 'u-2']);
  });
});
