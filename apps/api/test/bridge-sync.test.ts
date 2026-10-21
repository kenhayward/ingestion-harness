import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  moveTargetsToBridge,
  pullTargets,
  resyncAfterRestore,
  startTargetSync,
} from '../src/bridge/sync.js';
import { encryptSecret, type SecretsKeys } from '../src/llm/secrets.js';
import { MemoryPublishTargetRepo, type LegacyKeys } from '../src/publish-targets/repo.js';
import type { DefaultSeed } from '../src/publish-targets/seed.js';
import { FakeBridgeApi } from './fake-bridge.js';
import { cacheS3, rdfView, s3View } from './target-views.js';

const KEYS: SecretsKeys = { current: Buffer.alloc(32, 5), previous: null };

const SEED: DefaultSeed = {
  kind: 'internal',
  bucket: 'published',
  prefix: 'pub/',
  endpoint: null,
  region: null,
  accessKeyEnv: null,
  secretKeyEnv: null,
  forcePathStyle: true,
};
const RDF = { endpoint: 'http://fuseki:3030', dataset: 'ct', user: 'ct-writer' };

const legacy = (id: string, over: Partial<LegacyKeys> = {}): LegacyKeys => ({
  id,
  endpoint: 'https://s3.eu-west-2.amazonaws.com',
  region: 'eu-west-2',
  accessKeyId: 'AKIAFIN',
  secretKeyEnc: encryptSecret('fin-secret', KEYS),
  accessKeyEnv: null,
  secretKeyEnv: null,
  forcePathStyle: false,
  movedToBridgeAt: null,
  ...over,
});

function logger() {
  const warnings: string[] = [];
  const infos: string[] = [];
  const log = {
    warn: (obj: unknown, msg?: string) => void warnings.push(msg ?? String(obj)),
    info: (obj: unknown, msg?: string) => void infos.push(msg ?? String(obj)),
    error: () => {},
  } as unknown as FastifyBaseLogger;
  return { log, warnings, infos };
}

function setup() {
  const targets = new MemoryPublishTargetRepo();
  return { targets, bridge: new FakeBridgeApi(), ...logger() };
}

/** A target the bridge holds (as if written there earlier). */
const onBridge = (bridge: FakeBridgeApi, view: ReturnType<typeof s3View>) => {
  const { id, ...put } = view;
  bridge.targets.set(id, put);
};

describe('pullTargets', () => {
  it('pull caches every bridge target and derives its kind', async () => {
    const { targets, bridge, log } = setup();
    onBridge(bridge, s3View({ id: 'default', kind: 'internal', bucket: 'published' }));
    onBridge(bridge, s3View({ id: 'finance', connectionId: 'target-finance', layout: 'package' }));
    onBridge(bridge, rdfView());
    onBridge(bridge, {
      id: 'box',
      label: 'Box',
      sinkId: 'archive-sink',
      instanceId: 'eu',
      connectionId: null,
      destination: { folder: 'ct' },
    });
    const result = await pullTargets({ targets, bridge, log });
    expect(result).toEqual({ cached: 4, missing: [] });
    const kinds = Object.fromEntries((await targets.list()).map((t) => [t.id, t.kind]));
    expect(kinds).toEqual({
      default: 'internal',
      finance: 'external',
      'rdf-default': 'rdf',
      box: 'sink',
    });
    expect(await targets.get('finance')).toMatchObject({
      connectionId: 'target-finance',
      destination: { bucket: 'lake', layout: 'package' },
      onBridge: true,
    });
    expect((await targets.get('default'))?.syncedAt).not.toBeNull();
    expect(bridge.targetPuts).toBe(0);
  });

  it('pull never touches inert_at, source, seeded_at or edited_at', async () => {
    const { targets, bridge, log } = setup();
    const at = '2026-10-01T00:00:00.000Z';
    await cacheS3(targets, { id: 'default', kind: 'internal' }, { source: 'env', seededAt: at });
    await cacheS3(targets, { id: 'lake' }, { source: 'ui', by: 'Ann' });
    await cacheS3(targets, { id: 'lake' }, { by: 'Bob' });
    const edited = await targets.get('lake');
    await cacheS3(targets, { id: 'gone' });
    targets.makeInert('gone');
    onBridge(bridge, s3View({ id: 'default', kind: 'internal', bucket: 'moved' }));
    onBridge(bridge, s3View({ id: 'lake', label: 'Renamed' }));
    onBridge(bridge, s3View({ id: 'gone' }));
    await pullTargets({ targets, bridge, log });
    expect(await targets.get('default')).toMatchObject({
      source: 'env',
      seededAt: at,
      destination: { bucket: 'moved' },
    });
    expect(await targets.get('lake')).toMatchObject({
      label: 'Renamed',
      source: 'ui',
      updatedBy: 'Bob',
      editedAt: edited?.editedAt,
    });
    expect(await targets.get('gone')).toBeNull();
    expect(await targets.cachedIds()).toContainEqual({ id: 'gone', live: false });
  });

  it('a cached target the bridge no longer lists is marked not on the bridge, never deleted', async () => {
    const { targets, bridge, log, warnings } = setup();
    await cacheS3(targets, { id: 'lake' });
    await cacheS3(targets, { id: 'old' });
    targets.makeInert('old');
    onBridge(bridge, s3View({ id: 'default', kind: 'internal' }));
    const result = await pullTargets({ targets, bridge, log });
    expect(result).toEqual({ cached: 1, missing: ['lake'] });
    expect(await targets.get('lake')).toMatchObject({ onBridge: false });
    expect(warnings).toEqual([
      'publishing target lake is not on the delivery bridge: its deliveries fail until it is added there again',
    ]);
    // Listed again: on the bridge again.
    onBridge(bridge, s3View({ id: 'lake' }));
    expect(await pullTargets({ targets, bridge, log })).toEqual({ cached: 2, missing: [] });
    expect((await targets.get('lake'))?.onBridge).toBe(true);
  });

  it('takes nothing from a backfilled synced_at: a row the bridge lacks is not on it', async () => {
    const { targets, bridge, log } = setup();
    // The migration marked every row on the bridge and synced; the bridge never had this one.
    await cacheS3(targets, { id: 'never-mirrored' });
    onBridge(bridge, s3View({ id: 'default', kind: 'internal' }));
    expect((await pullTargets({ targets, bridge, log })).missing).toEqual(['never-mirrored']);
  });
});

describe('moveTargetsToBridge', () => {
  it('moveTargetsToBridge reads the legacy table and empties a moved row', async () => {
    const { targets, bridge, log } = setup();
    await cacheS3(targets, { id: 'finance', sse: 'aws:kms', kmsKeyId: 'kms-1' });
    targets.putLegacyKeys(legacy('finance'));
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
    // The bridge's target now delivers with it, at the same place; the cache holds its answer.
    expect(bridge.targets.get('finance')).toEqual({
      label: 'Lake finance',
      sinkId: 's3',
      instanceId: null,
      connectionId: 'target-finance',
      destination: s3View({ id: 'finance', sse: 'aws:kms', kmsKeyId: 'kms-1' }).destination,
    });
    expect(await targets.connectionOf('finance')).toBe('target-finance');
    expect(await targets.legacyKeys()).toEqual([]);
  });

  it('drops the legacy row of an inert or non-external target, moving nothing', async () => {
    const { targets, bridge, log } = setup();
    await cacheS3(targets, { id: 'gone' });
    targets.makeInert('gone');
    targets.putLegacyKeys(legacy('gone'));
    await cacheS3(targets, { id: 'archive', kind: 'internal' });
    targets.putLegacyKeys(legacy('archive'));
    const result = await moveTargetsToBridge({ targets, bridge, secrets: KEYS, log });
    expect(result).toEqual({ moved: [], skipped: [] });
    expect(await targets.legacyKeys()).toEqual([]);
    expect(bridge.connectionPuts).toBe(0);
  });

  it('env-keyed keys become an env connection', async () => {
    const { targets, bridge, log } = setup();
    await cacheS3(targets, { id: 'default', label: 'Default', bucket: 'ingest-published' });
    targets.putLegacyKeys(
      legacy('default', {
        endpoint: 'https://s3.example.com',
        region: 'eu-west-1',
        accessKeyId: null,
        secretKeyEnc: null,
        accessKeyEnv: 'TARGET_S3_ACCESS_KEY',
        secretKeyEnv: 'TARGET_S3_SECRET_KEY',
        forcePathStyle: true,
      }),
    );
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

  it('drops a row an earlier move already took, writing nothing to the bridge', async () => {
    const { targets, bridge, log } = setup();
    await cacheS3(targets, { id: 'default', connectionId: 'target-default' });
    targets.putLegacyKeys(
      legacy('default', {
        secretKeyEnc: null,
        accessKeyEnv: 'TARGET_S3_ACCESS_KEY',
        secretKeyEnv: 'TARGET_S3_SECRET_KEY',
        movedToBridgeAt: '2026-10-20T12:00:00.000Z',
      }),
    );
    expect(await moveTargetsToBridge({ targets, bridge, secrets: KEYS, log })).toEqual({
      moved: [],
      skipped: [],
    });
    expect(bridge.connectionPuts + bridge.targetPuts).toBe(0);
    expect(await targets.legacyKeys()).toEqual([]);
  });

  it('is idempotent: a second run moves nothing', async () => {
    const { targets, bridge, log } = setup();
    await cacheS3(targets, { id: 'finance' });
    targets.putLegacyKeys(legacy('finance'));
    await moveTargetsToBridge({ targets, bridge, secrets: KEYS, log });
    const puts = bridge.connectionPuts;
    expect(await moveTargetsToBridge({ targets, bridge, secrets: KEYS, log })).toEqual({
      moved: [],
      skipped: [],
    });
    expect(bridge.connectionPuts).toBe(puts);
  });

  it('skips and logs a row it cannot decrypt or that has no keys, keeping its keys', async () => {
    const { targets, bridge, log, warnings } = setup();
    const other: SecretsKeys = { current: Buffer.alloc(32, 9), previous: null };
    await cacheS3(targets, { id: 'finance' });
    await cacheS3(targets, { id: 'nokeys' });
    targets.putLegacyKeys(legacy('finance', { secretKeyEnc: encryptSecret('x', other) }));
    targets.putLegacyKeys(legacy('nokeys', { secretKeyEnc: null }));
    const result = await moveTargetsToBridge({ targets, bridge, secrets: KEYS, log });
    expect(result).toEqual({ moved: [], skipped: ['finance', 'nokeys'] });
    expect(warnings).toHaveLength(2);
    expect(warnings.join(' ')).not.toContain('fin-secret');
    expect(bridge.connections.size).toBe(0);
    expect((await targets.legacyKeys()).map((k) => k.id)).toEqual(['finance', 'nokeys']);
  });

  it('keeps a refused connection unmoved, moves the others', async () => {
    const { targets, bridge, log, warnings } = setup();
    await cacheS3(targets, { id: 'finance' });
    await cacheS3(targets, { id: 'archive' });
    targets.putLegacyKeys(legacy('finance'));
    targets.putLegacyKeys(legacy('archive'));
    const putConnection = bridge.putSharedConnection.bind(bridge);
    bridge.putSharedConnection = async (c) => {
      if (c.id === 'target-finance') throw FakeBridgeApi.refusal('endpoint not allowed');
      return putConnection(c);
    };
    const result = await moveTargetsToBridge({ targets, bridge, secrets: KEYS, log });
    expect(result).toEqual({ moved: ['archive'], skipped: ['finance'] });
    expect((await targets.legacyKeys()).map((k) => k.id)).toEqual(['finance']);
    expect(warnings).toEqual([
      'publishing target finance: the bridge refused its connection (endpoint not allowed), so its keys were not moved; enter them on the connections page',
    ]);
  });

  it('a bridge that cannot be reached leaves the keys for the next try', async () => {
    const { targets, bridge, log } = setup();
    await cacheS3(targets, { id: 'finance' });
    targets.putLegacyKeys(legacy('finance'));
    bridge.failNext = new Error('bridge down');
    await expect(moveTargetsToBridge({ targets, bridge, secrets: KEYS, log })).rejects.toThrow(
      'bridge down',
    );
    expect(await targets.legacyKeys()).toHaveLength(1);
  });
});

describe('startTargetSync', () => {
  it('retries until the bridge answers, then moves keys, seeds and pulls', async () => {
    const { targets, bridge, log } = setup();
    await cacheS3(targets, { id: 'finance' });
    targets.putLegacyKeys(legacy('finance'));
    onBridge(bridge, s3View({ id: 'finance' }));
    bridge.failNext = new Error('bridge not up yet');
    const waits: number[] = [];
    const result = await startTargetSync(
      { targets, bridge, secrets: KEYS, log, seed: SEED, rdfSeed: RDF },
      { retryMs: 5, sleep: async (ms) => void waits.push(ms) },
    );
    expect(waits).toEqual([5]);
    expect(result).toMatchObject({
      moved: ['finance'],
      skipped: [],
      seeded: { default: 'seeded', rdf: 'seeded' },
      pulled: { cached: 3, missing: [] },
    });
    expect(bridge.targets.get('default')?.destination).toMatchObject({ bucket: 'published' });
    expect((await targets.get('rdf-default'))?.kind).toBe('rdf');
    expect((await targets.get('finance'))?.connectionId).toBe('target-finance');
  });
});

describe('after a restore swaps the database in', () => {
  it('seeds the triple store target again (a backup from before it lacks it) and pulls', async () => {
    const { targets, bridge, log } = setup();
    const main = { id: 'default', kind: 'internal', bucket: 'published', prefix: 'pub/' } as const;
    onBridge(bridge, s3View({ ...main, label: 'Main' }));
    await cacheS3(targets, main, { seededAt: '2026-10-01T00:00:00.000Z' });
    const result = await resyncAfterRestore(
      { targets, bridge, secrets: KEYS, log, seed: SEED, rdfSeed: RDF },
      { retryMs: 5, sleep: async () => undefined },
    );
    expect(result.seeded).toEqual({ default: 'kept', rdf: 'seeded' });
    expect(await targets.get('rdf-default')).toMatchObject({
      kind: 'rdf',
      destination: { dataset: 'ct' },
    });
    expect(bridge.targets.get('rdf-default')?.sinkId).toBe('rdf');
    // The restored default was on the bridge: it is not written again.
    expect(bridge.targets.get('default')?.label).toBe('Main');
    expect((await targets.get('default'))?.label).toBe('Main');
  });

  it('writes back the live cached targets the bridge lacks, before the pull', async () => {
    const { targets, bridge, log, warnings } = setup();
    // A backup from before the merge: the cache holds its targets, the bridge none of them.
    await cacheS3(targets, { id: 'archive', kind: 'internal', bucket: 'arch', layout: 'package' });
    await cacheS3(targets, { id: 'lake', connectionId: 'target-lake' });
    await targets.cache(rdfView('restored'), { source: 'env', seededAt: '2026-10-01T00:00:00Z' });
    // Keys not moved (they cannot be decrypted): left to the next move, not written back.
    await cacheS3(targets, { id: 'stuck' });
    targets.putLegacyKeys(legacy('stuck', { secretKeyEnc: 'v1:not-ours' }));
    await cacheS3(targets, { id: 'gone' });
    targets.makeInert('gone');
    const result = await resyncAfterRestore(
      { targets, bridge, secrets: KEYS, log, seed: SEED, rdfSeed: RDF },
      { retryMs: 5, sleep: async () => undefined },
    );
    expect(result.restored).toEqual(['archive', 'lake', 'rdf-default']);
    expect(bridge.targets.get('archive')).toMatchObject({
      connectionId: 'internal',
      destination: { bucket: 'arch', layout: 'package' },
    });
    expect(bridge.targets.get('lake')?.connectionId).toBe('target-lake');
    // The triple store keeps its restored dataset (the seed then finds it held).
    expect(bridge.targets.get('rdf-default')).toMatchObject({
      connectionId: 'rdf-default',
      destination: { dataset: 'restored' },
    });
    expect(result.seeded.rdf).toBe('differs');
    expect(bridge.targets.has('stuck')).toBe(false);
    expect(bridge.targets.has('gone')).toBe(false);
    expect(result.pulled.missing).toEqual(['stuck']);
    expect(warnings.some((w) => w.includes('stuck'))).toBe(true);
  });

  it('at start a cached target the bridge lacks is only marked missing', async () => {
    const { targets, bridge, log } = setup();
    await cacheS3(targets, { id: 'archive', kind: 'internal' });
    const result = await startTargetSync(
      { targets, bridge, secrets: KEYS, log, seed: SEED, rdfSeed: null },
      { retryMs: 5, sleep: async () => undefined },
    );
    expect(result.restored).toBeUndefined();
    expect(bridge.targets.has('archive')).toBe(false);
    expect(result.pulled.missing).toEqual(['archive']);
  });

  it('a target the bridge refuses is logged and skipped; the others are written back', async () => {
    const { targets, bridge, log, warnings } = setup();
    await cacheS3(targets, { id: 'odd' });
    await cacheS3(targets, { id: 'fine' });
    const put = bridge.putTarget.bind(bridge);
    bridge.putTarget = async (id, t) => {
      if (id === 'odd') throw FakeBridgeApi.refusal('no such sink');
      return put(id, t);
    };
    const result = await resyncAfterRestore(
      { targets, bridge, secrets: KEYS, log, seed: SEED, rdfSeed: null },
      { retryMs: 5, sleep: async () => undefined },
    );
    expect(result.restored).toEqual(['fine']);
    expect(warnings).toContain(
      'publishing target odd could not be written back to the bridge after the restore: the bridge refused it (no such sink)',
    );
  });

  it('without RDF_ENDPOINT seeds no triple store', async () => {
    const { targets, bridge, log } = setup();
    const result = await resyncAfterRestore(
      { targets, bridge, secrets: KEYS, log, seed: SEED, rdfSeed: null },
      { retryMs: 5, sleep: async () => undefined },
    );
    expect(result.seeded.rdf).toBeNull();
    expect(await targets.get('rdf-default')).toBeNull();
    expect(bridge.targets.has('default')).toBe(true);
  });
});
