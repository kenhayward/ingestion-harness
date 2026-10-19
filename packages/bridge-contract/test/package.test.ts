import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { idempotencyKey, PackageSchema, partsOf } from '../src/index.js';
import { docPackage, file } from './builders.js';

describe('idempotency key', () => {
  it('derives a stable key from source, recipe and version', () => {
    const sha = 'a'.repeat(64);
    const a = idempotencyKey(sha, 'invoice', 3);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(idempotencyKey(sha, 'invoice', 3)).toBe(a);
    expect(idempotencyKey(sha, 'invoice', 4)).not.toBe(a);
    expect(a).toBe(createHash('sha256').update(`${sha}\ninvoice\n3`).digest('hex'));
  });
});

describe('package schema', () => {
  it('accepts a document package', () => {
    expect(PackageSchema.parse(docPackage)).toEqual(docPackage);
  });

  it('needs provenance on a document package and unique file names', () => {
    expect(PackageSchema.safeParse({ ...docPackage, provenance: null }).success).toBe(false);
    expect(
      PackageSchema.safeParse({ ...docPackage, files: [file('a.csv'), file('a.csv')] }).success,
    ).toBe(false);
    expect(
      PackageSchema.safeParse({ ...docPackage, kind: 'graph', provenance: null }).success,
    ).toBe(true);
  });

  it('refuses content that is not base64', () => {
    const bad = { ...file('a.csv'), content: 'not base64!' };
    expect(PackageSchema.safeParse({ ...docPackage, files: [bad] }).success).toBe(false);
  });

  it('lists the parts a package carries', () => {
    expect(partsOf({ ...docPackage, data: null, rdf: null })).toEqual(['files']);
    expect(partsOf(docPackage)).toEqual(['files', 'data']);
    expect(partsOf({ ...docPackage, files: [], data: null })).toEqual([]);
  });
});
