import { describe, expect, it } from 'vitest';
import { BundleManifestSchema } from '../src/bundle.js';

const sha = 'a'.repeat(64);
// What worker/src/ingest_worker/bundle.py writes (keep in step with test_bundle.py).
const manifest = {
  format: 'ih-workbench-bundle',
  formatVersion: 1,
  project: { id: 'letter', name: 'Letter' },
  templateVersion: 2,
  briefVersion: 3,
  samples: [
    { sampleId: 's1', filename: 'a.pdf', sha256: sha, file: `samples/${sha}.pdf`, inContext: true },
  ],
  stages: ['survey', 'outputs', 'sections', 'steps', 'revise'],
};

describe('BundleManifestSchema', () => {
  it('parses a worker-written manifest', () => {
    expect(BundleManifestSchema.parse(manifest)).toEqual(manifest);
  });
  it.each([
    ['another format', { ...manifest, format: 'zip' }],
    ['a newer format version', { ...manifest, formatVersion: 2 }],
    ['a bad sha256', { ...manifest, samples: [{ ...manifest.samples[0], sha256: 'x' }] }],
    [
      'a file outside samples/',
      { ...manifest, samples: [{ ...manifest.samples[0], file: '../a.pdf' }] },
    ],
    ['an unknown key', { ...manifest, extra: 1 }],
  ])('rejects %s', (_name, value) => {
    expect(BundleManifestSchema.safeParse(value).success).toBe(false);
  });
});
