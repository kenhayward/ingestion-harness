import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { defaultSeed, rdfSeed, seedDifferences } from '../src/publish-targets/seed.js';

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
