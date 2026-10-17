import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { defaultSeed, seedDifferences } from '../src/publish-targets/seed.js';

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
) as { seed: SeedCase[] };

describe('defaultSeed', () => {
  it.each(fixture.seed.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const config = loadConfig({ DATABASE_URL: 'postgres://u:p@localhost:5432/ih', ...c.env });
    expect(defaultSeed(config)).toStrictEqual(c.expected);
  });

  it('names the fields that moved since the first start', () => {
    const config = loadConfig({
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
