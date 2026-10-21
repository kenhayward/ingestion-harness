import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { FastifyBaseLogger } from 'fastify';
import { MemoryPublishTargetRepo } from '../src/publish-targets/repo.js';
import {
  defaultSeed,
  rdfSeed,
  rdfSeedDiffers,
  seedDefault,
  seedDifferences,
  seedRdf,
  type DefaultSeed,
} from '../src/publish-targets/seed.js';
import { FakeBridgeApi } from './fake-bridge.js';
import { cacheS3, rdfView, s3View } from './target-views.js';

interface SeedCase {
  name: string;
  env: Record<string, string>;
  expected: Record<string, unknown>;
}
const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../packages/shared/test/fixtures/publish-targets.json', import.meta.url),
    ),
    'utf8',
  ),
) as {
  seed: SeedCase[];
  rdfSeed: { name: string; env: Record<string, string>; expected: unknown }[];
};

const BRIDGE = {
  BRIDGE_URL: 'http://bridge:3100',
  BRIDGE_CLIENT_KEY: 'k'.repeat(32),
  BRIDGE_PUBLIC_URL: 'https://ct.example.com/bridge',
};

describe('defaultSeed', () => {
  it.each(fixture.seed.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const config = loadConfig({
      ...BRIDGE,
      DATABASE_URL: 'postgres://u:p@localhost:5432/ih',
      ...c.env,
    });
    expect(defaultSeed(config)).toStrictEqual(c.expected);
  });

  it('names the fields that moved since the first start', () => {
    const config = loadConfig({
      ...BRIDGE,
      DATABASE_URL: 'postgres://u:p@localhost:5432/ih',
      S3_ENDPOINT: 'http://seaweed:8333',
      S3_ACCESS_KEY: 'k',
      S3_SECRET_KEY: 's',
      TARGET_S3_BUCKET: 'other',
    });
    const seed = defaultSeed(config);
    expect(seedDifferences({ ...seed, bucket: 'ingest-published' }, seed)).toEqual(['bucket']);
    expect(seedDifferences(seed, seed)).toEqual([]);
  });
});

describe('rdfSeed (the triple store target from RDF_ENDPOINT)', () => {
  it.each(fixture.rdfSeed.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const config = loadConfig({
      ...BRIDGE,
      DATABASE_URL: 'postgres://u:p@localhost:5432/ih',
      S3_ENDPOINT: 'http://seaweed:8333',
      S3_ACCESS_KEY: 'k',
      S3_SECRET_KEY: 's',
      ...c.env,
    });
    expect(rdfSeed(config)).toStrictEqual(c.expected);
  });
});

const SEED: DefaultSeed = {
  kind: 'internal',
  bucket: 'pub',
  prefix: '',
  endpoint: null,
  region: null,
  accessKeyEnv: null,
  secretKeyEnv: null,
  forcePathStyle: true,
};
const RDF = { endpoint: 'http://fuseki:3030', dataset: 'ct', user: 'ct-writer' };

function seeding() {
  const warnings: string[] = [];
  const log = {
    warn: (obj: unknown, msg?: string) => void warnings.push(msg ?? String(obj)),
    info: () => {},
  } as unknown as FastifyBaseLogger;
  const targets = new MemoryPublishTargetRepo();
  const bridge = new FakeBridgeApi();
  return { deps: { targets, bridge, log }, targets, bridge, warnings };
}

describe('seedDefault (through the bridge)', () => {
  it('seedDefault writes to the bridge only when the bridge has no default or it was never seeded, then caches it', async () => {
    const { deps, targets, bridge, warnings } = seeding();
    // Never seeded: written to the bridge, the bridge's answer cached.
    expect(await seedDefault(deps, SEED)).toBe('seeded');
    expect(bridge.targets.get('default')).toEqual({
      label: 'Default',
      sinkId: 's3',
      instanceId: null,
      connectionId: 'internal',
      destination: {
        bucket: 'pub',
        prefix: '',
        sse: 'none',
        kmsKeyId: '',
        storageClass: '',
        layout: 'files',
      },
    });
    const cached = await targets.get('default');
    expect(cached).toMatchObject({
      kind: 'internal',
      source: 'env',
      onBridge: true,
      destination: { bucket: 'pub' },
    });
    expect(cached?.seededAt).not.toBeNull();
    // Seeded and on the bridge: nothing is written, whatever .env says now.
    const puts = bridge.targetPuts;
    expect(await seedDefault(deps, SEED)).toBe('kept');
    expect(await seedDefault(deps, { ...SEED, bucket: 'moved' })).toBe('differs');
    expect(warnings).toEqual([
      'publishing target default differs from .env (bucket): .env is ignored now',
    ]);
    expect(bridge.targetPuts).toBe(puts);
    expect(bridge.targets.get('default')?.destination.bucket).toBe('pub');
    // Seeded, but the bridge has no default: written again.
    bridge.targets.delete('default');
    expect(await seedDefault(deps, SEED)).toBe('seeded');
    expect(bridge.targets.has('default')).toBe(true);
  });

  it('rewrites a default old code seeded into the cache without its destination', async () => {
    const { deps, targets, bridge } = seeding();
    // Seeded by code from before the merge (the old columns only); the bridge never got it.
    await cacheS3(
      targets,
      { id: 'default', kind: 'internal', bucket: '' },
      { source: 'env', seededAt: '2026-10-21T08:00:00.000Z' },
    );
    expect(await seedDefault(deps, SEED)).toBe('seeded');
    expect((await targets.get('default'))?.destination.bucket).toBe('pub');
    expect(bridge.targets.get('default')?.destination.bucket).toBe('pub');
  });

  it('keeps the label CT Studio has for it', async () => {
    const { deps, targets, bridge } = seeding();
    await cacheS3(targets, { id: 'default', kind: 'internal', label: 'Main lake' }, { by: 'Ann' });
    await seedDefault(deps, SEED);
    expect(bridge.targets.get('default')?.label).toBe('Main lake');
  });

  it('an external default reads its keys from .env through an env connection', async () => {
    const { deps, targets, bridge } = seeding();
    const external: DefaultSeed = {
      ...SEED,
      kind: 'external',
      endpoint: 'https://s3.example.com',
      region: 'eu-west-2',
      accessKeyEnv: 'TARGET_S3_ACCESS_KEY',
      secretKeyEnv: 'TARGET_S3_SECRET_KEY',
    };
    expect(await seedDefault(deps, external)).toBe('seeded');
    expect(bridge.connections.get('target-default')).toEqual({
      id: 'target-default',
      name: 'Default',
      fields: {
        endpoint: 'https://s3.example.com',
        region: 'eu-west-2',
        accessKeyIdEnv: 'TARGET_S3_ACCESS_KEY',
        forcePathStyle: 'true',
      },
      secret: null,
      secretEnv: 'TARGET_S3_SECRET_KEY',
    });
    expect(await targets.get('default')).toMatchObject({
      kind: 'external',
      connectionId: 'target-default',
    });
    // The endpoint is compared with the connection's.
    expect(await seedDefault(deps, external)).toBe('kept');
    expect(await seedDefault(deps, { ...external, endpoint: 'https://other.example.com' })).toBe(
      'differs',
    );
  });
});

describe('seedRdf (through the bridge)', () => {
  it('seeds the triple store target on the bridge once, with its env connection', async () => {
    const { deps, targets, bridge } = seeding();
    expect(await seedRdf(deps, RDF)).toBe('seeded');
    expect(bridge.connections.get('rdf-default')).toEqual({
      id: 'rdf-default',
      name: 'Triple store',
      sinkId: 'rdf',
      fields: { endpoint: 'http://fuseki:3030', user: 'ct-writer' },
      secret: null,
      secretEnv: 'RDF_PASSWORD',
    });
    expect(bridge.targets.get('rdf-default')).toEqual({
      label: 'Triple store',
      sinkId: 'rdf',
      instanceId: null,
      connectionId: 'rdf-default',
      destination: { dataset: 'ct' },
    });
    expect(await targets.get('rdf-default')).toMatchObject({ kind: 'rdf', source: 'env' });
    expect(await seedRdf(deps, RDF)).toBe('kept');
  });

  it('leaves a connection the bridge already has (an admin may have stored a password)', async () => {
    const { deps, bridge } = seeding();
    bridge.summaries.push({
      id: 'rdf-default',
      name: 'Triple store',
      sinkId: 'rdf',
      status: 'ok',
      statusReason: null,
      fields: { endpoint: 'http://fuseki:3030', user: 'ct-writer' },
    });
    await seedRdf(deps, RDF);
    expect(bridge.connections.has('rdf-default')).toBe(false);
    expect(bridge.targets.get('rdf-default')?.connectionId).toBe('rdf-default');
  });

  it('seedRdf compares the seed with the rdf-default connection', async () => {
    const { deps, bridge, warnings } = seeding();
    await seedRdf(deps, RDF);
    const puts = bridge.targetPuts;
    expect(await seedRdf(deps, { ...RDF, endpoint: 'http://other:3030' })).toBe('differs');
    expect(await seedRdf(deps, { ...RDF, user: 'someone-else' })).toBe('differs');
    expect(await seedRdf(deps, { ...RDF, dataset: 'kb' })).toBe('differs');
    expect(bridge.targetPuts).toBe(puts);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toBe(
      'the triple store target differs from RDF_ENDPOINT/RDF_DATASET/RDF_USER: .env is ignored now',
    );
    // A rename is no difference.
    bridge.targets.set('rdf-default', { ...bridge.targets.get('rdf-default')!, label: 'KG' });
    expect(await seedRdf(deps, RDF)).toBe('kept');
  });

  it('rdfSeedDiffers reads the connection’s endpoint and user, the target’s dataset', () => {
    const conn = (fields: Record<string, string>) => ({
      id: 'rdf-default',
      name: 'Triple store',
      sinkId: 'rdf',
      status: 'ok' as const,
      statusReason: null,
      fields,
    });
    const both = conn({ endpoint: RDF.endpoint, user: RDF.user });
    expect(rdfSeedDiffers(rdfView('ct'), both, RDF)).toBe(false);
    expect(rdfSeedDiffers(rdfView('ct'), conn({ endpoint: RDF.endpoint }), RDF)).toBe(true);
    expect(rdfSeedDiffers(rdfView('kb'), both, RDF)).toBe(true);
    // No connection to compare with: the dataset alone.
    expect(rdfSeedDiffers(rdfView('ct'), null, RDF)).toBe(false);
    expect(rdfSeedDiffers(s3View({ id: 'x' }), null, RDF)).toBe(true);
  });
});
