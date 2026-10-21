import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  connectionIdOf,
  destinationOf,
  mirrorTargets,
  moveTargetsToBridge,
  resyncAfterRestore,
  syncTargetsWithBridge,
} from '../src/bridge/mirror.js';
import { encryptSecret, type SecretsKeys } from '../src/llm/secrets.js';
import { MemoryPublishTargetRepo, type NewTarget } from '../src/publish-targets/repo.js';
import { FakeBridgeApi } from './fake-bridge.js';

const KEYS: SecretsKeys = { current: Buffer.alloc(32, 5), previous: null };

const external = (id: string, over: Partial<NewTarget> = {}): NewTarget => ({
  id,
  label: `Lake ${id}`,
  kind: 'external',
  bucket: 'lake',
  prefix: 'out/',
  endpoint: 'https://s3.eu-west-2.amazonaws.com',
  region: 'eu-west-2',
  accessKeyId: 'AKIAFIN',
  secretKeyEnc: encryptSecret('fin-secret', KEYS),
  accessKeyEnv: null,
  secretKeyEnv: null,
  forcePathStyle: false,
  sse: 'aws:kms',
  kmsKeyId: 'kms-1',
  storageClass: null,
  ...over,
});

function logger() {
  const warnings: string[] = [];
  const log = {
    warn: (obj: unknown, msg?: string) => void warnings.push(msg ?? String(obj)),
    info: () => {},
    error: () => {},
  } as unknown as FastifyBaseLogger;
  return { log, warnings };
}

async function setup() {
  const targets = new MemoryPublishTargetRepo();
  await targets.seedDefault({
    kind: 'internal',
    bucket: 'published',
    prefix: 'pub/',
    endpoint: null,
    region: null,
    accessKeyEnv: null,
    secretKeyEnv: null,
    forcePathStyle: true,
  });
  return { targets, bridge: new FakeBridgeApi(), ...logger() };
}

describe('destinationOf and connectionIdOf', () => {
  it('maps a target row to the S3 sink’s destination, blanks for unset options', async () => {
    const { targets } = await setup();
    await targets.create(external('finance'), null);
    expect(destinationOf((await targets.get('finance'))!)).toEqual({
      bucket: 'lake',
      prefix: 'out/',
      sse: 'aws:kms',
      kmsKeyId: 'kms-1',
      storageClass: '',
      layout: 'files',
    });
    await targets.update('finance', { layout: 'package' }, null);
    expect(destinationOf((await targets.get('finance'))!).layout).toBe('package');
    expect(connectionIdOf((await targets.get('default'))!)).toBe('internal');
    expect(connectionIdOf((await targets.get('finance'))!)).toBeNull();
    await targets.markMoved('finance', 'target-finance');
    expect(connectionIdOf((await targets.get('finance'))!)).toBe('target-finance');
  });
});

describe('mirrorTargets', () => {
  it('mirrors internal targets with the internal connection', async () => {
    const { targets, bridge, log } = await setup();
    expect(await mirrorTargets({ targets, bridge, log })).toBe(1);
    expect(bridge.targets.get('default')).toEqual({
      label: 'Default',
      sinkId: 's3',
      instanceId: null,
      connectionId: 'internal',
      destination: {
        bucket: 'published',
        prefix: 'pub/',
        sse: 'none',
        kmsKeyId: '',
        storageClass: '',
        layout: 'files',
      },
    });
  });
});

describe('moveTargetsToBridge', () => {
  it("moves an external target's decrypted secret into a shared connection and nulls the row's ciphertext", async () => {
    const { targets, bridge, log } = await setup();
    await targets.create(external('finance'), null);
    const result = await moveTargetsToBridge({ targets, bridge, secrets: KEYS, log });
    expect(result).toEqual({ moved: ['finance'], skipped: [] });
    expect(bridge.connections.get('target-finance')).toEqual({
      id: 'target-finance',
      name: 'Lake finance',
      fields: {
        endpoint: 'https://s3.eu-west-2.amazonaws.com',
        region: 'eu-west-2',
        accessKeyId: 'AKIAFIN',
        forcePathStyle: 'false',
      },
      secret: 'fin-secret',
      secretEnv: null,
    });
    const row = await targets.get('finance');
    expect(row?.secretKeyEnc).toBeNull();
    expect(row?.movedToBridgeAt).not.toBeNull();
    expect(bridge.targets.get('finance')).toMatchObject({
      connectionId: 'target-finance',
      destination: { bucket: 'lake', prefix: 'out/' },
    });
  });

  it('env-keyed default target becomes an env connection', async () => {
    const targets = new MemoryPublishTargetRepo();
    await targets.seedDefault({
      kind: 'external',
      bucket: 'ingest-published',
      prefix: '',
      endpoint: 'https://s3.example.com',
      region: 'eu-west-1',
      accessKeyEnv: 'TARGET_S3_ACCESS_KEY',
      secretKeyEnv: 'TARGET_S3_SECRET_KEY',
      forcePathStyle: true,
    });
    const bridge = new FakeBridgeApi();
    const { log } = logger();
    const result = await moveTargetsToBridge({ targets, bridge, secrets: null, log });
    expect(result.moved).toEqual(['default']);
    expect(bridge.connections.get('target-default')).toEqual({
      id: 'target-default',
      name: 'Default',
      fields: {
        endpoint: 'https://s3.example.com',
        region: 'eu-west-1',
        accessKeyIdEnv: 'TARGET_S3_ACCESS_KEY',
        forcePathStyle: 'true',
      },
      secret: null,
      secretEnv: 'TARGET_S3_SECRET_KEY',
    });
    expect(bridge.targets.get('default')?.connectionId).toBe('target-default');
  });

  it('is idempotent: a second run moves nothing', async () => {
    const { targets, bridge, log } = await setup();
    await targets.create(external('finance'), null);
    await moveTargetsToBridge({ targets, bridge, secrets: KEYS, log });
    const puts = bridge.connectionPuts;
    expect(await moveTargetsToBridge({ targets, bridge, secrets: KEYS, log })).toEqual({
      moved: [],
      skipped: [],
    });
    expect(bridge.connectionPuts).toBe(puts);
  });

  it('skips and logs a row it cannot decrypt, leaving it unmoved', async () => {
    const { targets, bridge, log, warnings } = await setup();
    const other: SecretsKeys = { current: Buffer.alloc(32, 9), previous: null };
    await targets.create(external('finance', { secretKeyEnc: encryptSecret('x', other) }), null);
    await targets.create(external('nokeys', { secretKeyEnc: null }), null);
    const result = await moveTargetsToBridge({ targets, bridge, secrets: KEYS, log });
    expect(result).toEqual({ moved: [], skipped: ['finance', 'nokeys'] });
    expect(warnings).toHaveLength(2);
    expect(warnings.join(' ')).not.toContain('fin-secret');
    expect(bridge.connections.size).toBe(0);
    expect((await targets.get('finance'))?.secretKeyEnc).not.toBeNull();
    expect((await targets.get('finance'))?.movedToBridgeAt).toBeNull();
    // Mirrored without a connection: its deliveries fail visibly (credential_missing).
    expect(bridge.targets.get('finance')?.connectionId).toBeNull();
  });

  it('leaves the rows untouched when the bridge refuses the connection', async () => {
    const { targets, bridge, log } = await setup();
    await targets.create(external('finance'), null);
    bridge.failNext = new Error('bridge down');
    await expect(moveTargetsToBridge({ targets, bridge, secrets: KEYS, log })).rejects.toThrow(
      'bridge down',
    );
    expect((await targets.get('finance'))?.secretKeyEnc).not.toBeNull();
  });
});

describe('syncTargetsWithBridge', () => {
  it('retries until the bridge answers, so a bridge that starts late is caught up', async () => {
    const { targets, bridge, log } = await setup();
    await targets.create(external('finance'), null);
    bridge.failNext = new Error('bridge not up yet');
    const waits: number[] = [];
    const result = await syncTargetsWithBridge(
      { targets, bridge, secrets: KEYS, log },
      { retryMs: 5, sleep: async (ms) => void waits.push(ms) },
    );
    expect(result.moved).toEqual(['finance']);
    expect(waits).toEqual([5]);
    expect(bridge.targets.has('default')).toBe(true);
  });
});

describe('mirrorTargets after a restore', () => {
  it('mirrors a target whose connection the bridge lacks without it, and goes on', async () => {
    const { targets, bridge } = await setup();
    await targets.create(external('finance'), null);
    await targets.markMoved('finance', 'target-finance');
    await targets.create(external('archive', { secretKeyEnc: null }), null);
    const put = bridge.putTarget.bind(bridge);
    bridge.putTarget = async (id, t) => {
      if (t.connectionId === 'target-finance') {
        throw FakeBridgeApi.refusal('there is no connection target-finance', 'connection_missing');
      }
      return put(id, t);
    };
    expect(await mirrorTargets({ targets, bridge, log: logger().log })).toBe(3);
    expect(bridge.targets.get('finance')?.connectionId).toBeNull();
    expect(bridge.targets.has('archive')).toBe(true);
  });
});

describe('the triple store target on the bridge', () => {
  const RDF = { endpoint: 'http://fuseki:3030', dataset: 'ct', user: 'ct-writer' };

  it('is mirrored to the rdf sink, with its env connection made once', async () => {
    const { targets, bridge, log } = await setup();
    await targets.seedRdf(RDF);
    await mirrorTargets({ targets, bridge, log });
    expect(bridge.targets.get('rdf-default')).toEqual({
      label: 'Triple store',
      sinkId: 'rdf',
      instanceId: null,
      connectionId: 'rdf-default',
      destination: { dataset: 'ct' },
    });
    expect(bridge.connections.get('rdf-default')).toEqual({
      id: 'rdf-default',
      name: 'Triple store',
      sinkId: 'rdf',
      fields: { endpoint: 'http://fuseki:3030', user: 'ct-writer' },
      secret: null,
      secretEnv: 'RDF_PASSWORD',
    });
  });

  it('leaves a connection the bridge already has (an admin may have stored a password)', async () => {
    const { targets, bridge, log } = await setup();
    await targets.seedRdf(RDF);
    bridge.summaries.push({
      id: 'rdf-default',
      name: 'Triple store',
      sinkId: 'rdf',
      status: 'ok',
      statusReason: null,
    });
    await mirrorTargets({ targets, bridge, log });
    expect(bridge.connections.has('rdf-default')).toBe(false);
    expect(bridge.targets.get('rdf-default')?.connectionId).toBe('rdf-default');
  });
});

describe('after a restore swaps the database in', () => {
  it('seeds the triple store target again (a backup from before it lacks it) and mirrors it', async () => {
    const { targets, bridge, log } = await setup();
    expect(await targets.get('rdf-default')).toBeNull(); // the restored database has none
    await resyncAfterRestore({
      targets,
      bridge,
      secrets: KEYS,
      log,
      rdfSeed: { endpoint: 'http://fuseki:3030', dataset: 'ct', user: 'ct-writer' },
    });
    expect(await targets.get('rdf-default')).toMatchObject({ kind: 'rdf', bucket: 'ct' });
    expect(bridge.targets.get('rdf-default')?.sinkId).toBe('rdf');
  });

  it('without RDF_ENDPOINT only mirrors', async () => {
    const { targets, bridge, log } = await setup();
    await resyncAfterRestore({ targets, bridge, secrets: KEYS, log, rdfSeed: null });
    expect(await targets.get('rdf-default')).toBeNull();
    expect(bridge.targets.has('default')).toBe(true);
  });
});

describe('one row the bridge refuses', () => {
  it('is logged and skipped while the other targets are mirrored', async () => {
    const { targets, bridge, log, warnings } = await setup();
    await targets.create(external('finance'), null);
    await targets.markMoved('finance', 'target-finance');
    await targets.create(external('archive', { secretKeyEnc: null }), null);
    const put = bridge.putTarget.bind(bridge);
    bridge.putTarget = async (id, t) => {
      if (id === 'finance') throw FakeBridgeApi.refusal('bucket name not allowed');
      return put(id, t);
    };
    expect(await mirrorTargets({ targets, bridge, log })).toBe(2);
    expect([...bridge.targets.keys()].sort()).toEqual(['archive', 'default']);
    expect(warnings).toEqual([
      'publishing target finance was refused by the bridge: bucket name not allowed',
    ]);
  });

  it('keeps a refused connection unmoved, moves the others, and does not retry', async () => {
    const { targets, bridge, log, warnings } = await setup();
    await targets.create(external('finance'), null);
    await targets.create(external('archive'), null);
    const putConnection = bridge.putSharedConnection.bind(bridge);
    bridge.putSharedConnection = async (c) => {
      if (c.id === 'target-finance') throw FakeBridgeApi.refusal('endpoint not allowed');
      return putConnection(c);
    };
    const waits: number[] = [];
    const result = await syncTargetsWithBridge(
      { targets, bridge, secrets: KEYS, log },
      { retryMs: 5, sleep: async (ms) => void waits.push(ms) },
    );
    expect(result).toEqual({ moved: ['archive'], skipped: ['finance'] });
    expect(waits).toEqual([]);
    expect((await targets.get('finance'))?.secretKeyEnc).not.toBeNull();
    expect((await targets.get('finance'))?.movedToBridgeAt).toBeNull();
    expect(warnings).toEqual([
      'publishing target finance: the bridge refused its connection (endpoint not allowed), so its keys were not moved; enter them on the connections page',
    ]);
    expect(bridge.targets.has('archive')).toBe(true);
  });
});
