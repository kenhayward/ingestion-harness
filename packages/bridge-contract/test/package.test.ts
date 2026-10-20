import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { graphIdempotencyKey, idempotencyKey, PackageSchema, partsOf } from '../src/index.js';
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

describe('the shared idempotency fixture (the worker computes the same key)', () => {
  it('idempotencyKey gives its key', () => {
    const f = JSON.parse(
      readFileSync(new URL('./fixtures/idempotency.json', import.meta.url), 'utf8'),
    ) as { sourceSha256: string; recipeId: string; recipeVersion: number; key: string };
    expect(idempotencyKey(f.sourceSha256, f.recipeId, f.recipeVersion)).toBe(f.key);
  });
});

describe('graph packages', () => {
  const fixture = (name: string): unknown =>
    JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

  it('graph keys match the fixture', () => {
    const f = fixture('idempotency.json') as {
      graph: { graphName: string; version: number; key: string };
    };
    expect(graphIdempotencyKey(f.graph.graphName, f.graph.version)).toBe(f.graph.key);
    expect(graphIdempotencyKey(f.graph.graphName, f.graph.version + 1)).not.toBe(f.graph.key);
  });

  it('a document package with an rdf part parses and lists the parts files, data, rdf', () => {
    const pkg = PackageSchema.parse(fixture('package-document-rdf.json'));
    expect(partsOf(pkg)).toEqual(['files', 'data', 'rdf']);
    expect(pkg.files.map((f) => f.output)).toContain('graph-version');
  });
});
