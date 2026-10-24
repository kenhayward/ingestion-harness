// Prepares packages/bridge-contract/package.json for publishing to GitHub Packages, where
// external sinks install the contract from (delivery bridge design, "How private sinks get it").
// The workspace manifest stays as it is for local development: its types point at the source
// and it is private. The release job runs this on a fresh checkout, after building:
//
//   node packages/bridge-contract/scripts/prepare-publish.mjs <owner>
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The manifest as published: scoped to the owning account (GitHub Packages requires it), public,
 * typed from the built declarations, and shipping the fixtures the conformance suite reads and
 * the comparison-form vectors sinks run.
 */
export function prepareContractManifest(pkg, owner) {
  const rest = { ...pkg };
  delete rest.private;
  return {
    ...rest,
    name: `@${owner}/bridge-contract`,
    exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' } },
    files: ['dist', 'src', 'test/fixtures', 'vectors', 'LICENSE'],
    repository: {
      type: 'git',
      url: `git+https://github.com/${owner}/ingestion-harness.git`,
      directory: 'packages/bridge-contract',
    },
    publishConfig: { registry: 'https://npm.pkg.github.com' },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const owner = process.argv[2];
  if (!owner) {
    console.error('usage: node prepare-publish.mjs <owner>');
    process.exit(2);
  }
  const path = new URL('../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, `${JSON.stringify(prepareContractManifest(pkg, owner), null, 2)}\n`);
  console.log(`prepared @${owner}/bridge-contract@${pkg.version}`);
}
