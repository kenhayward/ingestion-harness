import { ConnectionSummarySchema } from '@ih/bridge-contract';
import { describe, expect, it } from 'vitest';
import { MemoryConnectionRepo } from '../src/connections/repo.js';
import { decryptSecret } from '../src/secrets.js';
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
  const app = await testBridge({ targets, connections, sinks: new MapSinkRegistry({ s3, rdf }) });
  const call = (method: 'GET' | 'PUT', url: string, body?: unknown) =>
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
        status: 'needs_attention',
        statusReason: 'access denied',
        fields: { endpoint: 'https://s3.example.com', accessKeyId: 'AKIA1' },
      },
      {
        id: 'internal',
        name: 'This deployment',
        sinkId: 's3',
        status: 'untested',
        statusReason: null,
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
