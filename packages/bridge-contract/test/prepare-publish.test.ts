import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prepareContractManifest } from '../scripts/prepare-publish.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as Record<
  string,
  unknown
>;

/** The package.json the release job publishes for external sinks to install. */
describe('prepareContractManifest', () => {
  const published = prepareContractManifest(pkg, 'kenhayward') as Record<string, unknown>;

  it('is scoped to the owning account, as GitHub Packages requires, and is public', () => {
    expect(published.name).toBe('@kenhayward/bridge-contract');
    expect(published).not.toHaveProperty('private');
    expect(published.publishConfig).toEqual({ registry: 'https://npm.pkg.github.com' });
  });

  it('points its types at the built declarations, not the TypeScript source', () => {
    expect(published.exports).toEqual({
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
    });
  });

  it('ships what the conformance suite reads at run time', () => {
    expect(published.files).toEqual(['dist', 'src', 'test/fixtures', 'LICENSE']);
  });

  it('names its source repository', () => {
    expect(published.repository).toEqual({
      type: 'git',
      url: 'git+https://github.com/kenhayward/ingestion-harness.git',
      directory: 'packages/bridge-contract',
    });
  });

  it('keeps the version, module type, licence and dependencies as they are', () => {
    for (const key of ['version', 'type', 'license', 'dependencies'])
      expect(published[key]).toEqual(pkg[key]);
  });

  it('does not change the manifest it was given', () => {
    const before = JSON.stringify(pkg);
    prepareContractManifest(pkg, 'kenhayward');
    expect(JSON.stringify(pkg)).toBe(before);
  });
});
