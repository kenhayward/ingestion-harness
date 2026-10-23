import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  archivedPackageOf,
  ArchivedPackageSchema,
  bridgeError,
  changedInTargetDetails,
  CreateDeliveriesRequestSchema,
  decompositionIdempotencyKey,
  isDecompositionProvenance,
  isExtractionProvenance,
  packageArchiveKeys,
  PackageSchema,
  partsOf,
  ReceiptSchema,
  SinkDeliverRequestSchema,
  SinkDescribeSchema,
} from '../src/index.js';
import { decomposedPackage, docPackage, file } from './builders.js';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

/** The issue paths a failed parse reports. */
function issuePaths(schema: { safeParse(v: unknown): unknown }, value: unknown): string[] {
  const r = schema.safeParse(value) as {
    success: boolean;
    error?: { issues: { path: PropertyKey[] }[] };
  };
  expect(r.success).toBe(false);
  return r.error!.issues.map((i) => i.path.map(String).join('.'));
}

describe('contract version 2 packages', () => {
  it('the decomposed fixture parses as v2', () => {
    const json = fixture('package-decomposed.json');
    const pkg = PackageSchema.parse(json);
    expect(pkg).toEqual(json);
    expect(pkg.contractVersion).toBe(2);
    expect(pkg.provenance).toMatchObject({ kind: 'decomposition' });
    expect(partsOf(pkg)).toEqual(['images', 'document']);
    expect(pkg.images!.map((i) => i.id).sort()).toEqual(
      pkg.document!.images.map((i) => i.id).sort(),
    );
  });

  it('a v1 fixture still parses unchanged', () => {
    for (const name of ['package-document.json', 'package-graph.json']) {
      const json = fixture(name);
      const pkg = PackageSchema.parse(json);
      expect(pkg).toEqual(json);
      expect(pkg.contractVersion).toBe(1);
      expect('document' in pkg).toBe(false);
    }
    expect(PackageSchema.parse(docPackage)).toEqual(docPackage);
  });

  it('document needs contractVersion 2', () => {
    expect(issuePaths(PackageSchema, { ...decomposedPackage, contractVersion: 1 })).toContain(
      'document',
    );
    expect(PackageSchema.safeParse({ ...decomposedPackage, contractVersion: 3 }).success).toBe(
      false,
    );
  });

  it('document excludes files, data, rdf and narrative', () => {
    const paths = issuePaths(PackageSchema, {
      ...decomposedPackage,
      files: [file('a.csv')],
      data: { fields: [], tables: [] },
      rdf: { graphName: 'https://data.example/g', version: 1, turtle: '' },
      narrative: [],
    });
    expect(paths).toEqual(expect.arrayContaining(['files', 'data', 'rdf', 'narrative']));
    expect(
      issuePaths(PackageSchema, { ...decomposedPackage, provenance: docPackage.provenance }),
    ).toContain('provenance');
  });

  it('decomposition provenance needs a document', () => {
    const withoutDocument: Partial<typeof decomposedPackage> = { ...decomposedPackage };
    delete withoutDocument.document;
    expect(issuePaths(PackageSchema, withoutDocument)).toContain('provenance');
    expect(issuePaths(PackageSchema, { ...decomposedPackage, document: null })).toContain(
      'provenance',
    );
    // A version 2 extraction package (no document) is version 1 plus nothing.
    expect(PackageSchema.safeParse({ ...docPackage, contractVersion: 2 }).success).toBe(true);
  });

  it("images must match the document's images both ways", () => {
    const images = decomposedPackage.images!;
    expect(issuePaths(PackageSchema, { ...decomposedPackage, images: images.slice(1) })).toEqual([
      'document.images.0.id',
    ]);
    const extra = { id: 'not-in-document', contentType: 'image/png', content: images[0]!.content };
    expect(issuePaths(PackageSchema, { ...decomposedPackage, images: [...images, extra] })).toEqual(
      [`images.${images.length}.id`],
    );
    expect(issuePaths(PackageSchema, { ...decomposedPackage, images: null })).toEqual(
      decomposedPackage.document!.images.map((_, i) => `document.images.${i}.id`),
    );
  });

  it('archives the document as document.json', () => {
    const keys = packageArchiveKeys('p/', decomposedPackage);
    expect(keys.map((k) => k.outputId)).toEqual([
      'package:document',
      ...decomposedPackage.images!.map((i) => `package:image:${i.id}`),
      'package:manifest',
    ]);
    expect(keys[0]!.key).toBe(`p/packages/${decomposedPackage.idempotencyKey}/document.json`);
    const archived = archivedPackageOf(decomposedPackage);
    expect(ArchivedPackageSchema.parse(archived)).toEqual(archived);
    expect(archived.document).toEqual({ path: 'document.json' });
    // A version 1 package's archive is what it was: no document key at all.
    expect('document' in archivedPackageOf(docPackage)).toBe(false);
  });
});

describe('contract version 2 sinks', () => {
  it('describe-v2 parses and decomposedDocuments needs readBack and accepts document', () => {
    const json = fixture('describe-v2.json') as {
      contractVersion: number;
      capabilities: Record<string, unknown>;
    };
    expect(SinkDescribeSchema.parse(json)).toEqual(json);
    const caps = json.capabilities;
    expect(issuePaths(SinkDescribeSchema, { ...json, contractVersion: 1 })).toContain(
      'capabilities.decomposedDocuments',
    );
    expect(
      issuePaths(SinkDescribeSchema, { ...json, capabilities: { ...caps, readBack: false } }),
    ).toContain('capabilities.decomposedDocuments');
    for (const accepts of [['images'], ['document']]) {
      expect(
        issuePaths(SinkDescribeSchema, { ...json, capabilities: { ...caps, accepts } }),
      ).toContain('capabilities.decomposedDocuments');
    }
    const noEquations = { ...caps, decomposedDocuments: { equations: [] } };
    expect(SinkDescribeSchema.safeParse({ ...json, capabilities: noEquations }).success).toBe(
      false,
    );
    // Accepting the document part is version 2 only, with or without decomposedDocuments.
    const { decomposedDocuments: _dd, ...plainCaps } = caps;
    void _dd;
    expect(
      issuePaths(SinkDescribeSchema, { ...json, contractVersion: 1, capabilities: plainCaps }),
    ).toEqual(['capabilities.accepts']);
    expect(SinkDescribeSchema.safeParse({ ...json, capabilities: plainCaps }).success).toBe(true);
    // A v1 describe still parses as it did.
    const v1 = fixture('describe.json');
    expect(SinkDescribeSchema.parse(v1)).toEqual(v1);
  });

  it('a conditional update and a document receipt parse', () => {
    const update = {
      persistentId: 'doc-1',
      expected: [{ kind: 'paragraph', id: 'p-1', version: '3', element: null }],
    };
    const req = {
      instanceId: null,
      credential: null,
      destination: {},
      idempotencyKey: decomposedPackage.idempotencyKey,
      actingUser: null,
      package: decomposedPackage,
      update,
    };
    expect(SinkDeliverRequestSchema.parse(req)).toEqual(req);
    expect(
      SinkDeliverRequestSchema.safeParse({ ...req, update: { ...update, expected: [] } }).success,
    ).toBe(false);
    const receipt = {
      written: [],
      document: {
        persistentId: 'doc-1',
        components: [{ kind: 'table', id: 't-1', version: '1', element: 'el-9' }],
        readBack: { ok: true, at: '2026-10-23T10:00:00.000Z', detail: null },
      },
    };
    expect(ReceiptSchema.parse(receipt)).toEqual(receipt);
    expect(ReceiptSchema.parse({ written: [] })).toEqual({ written: [] });
  });

  it('update needs exactly one target', () => {
    const update = {
      persistentId: 'doc-1',
      expected: [{ kind: 'paragraph', id: 'p-1', version: '3', element: null }],
    };
    const base = { actingUser: null, package: decomposedPackage, update };
    expect(CreateDeliveriesRequestSchema.safeParse({ ...base, targets: ['t1'] }).success).toBe(
      true,
    );
    expect(issuePaths(CreateDeliveriesRequestSchema, { ...base, targets: ['t1', 't2'] })).toContain(
      'update',
    );
    const v1 = fixture('delivery-request.json');
    expect(CreateDeliveriesRequestSchema.parse(v1)).toEqual(v1);
  });
});

describe('changed_in_target', () => {
  const utf8 = (v: unknown) => Buffer.byteLength(JSON.stringify(v), 'utf8');

  it('changed details are capped at 40 with more', () => {
    const changed = Array.from({ length: 500 }, (_, i) => ({
      id: `section-${i}#paragraph-${i}`,
      expected: `${i}`,
      actual: i % 2 ? `${i + 1}` : null,
    }));
    const details = changedInTargetDetails(changed);
    expect((details.changed as unknown[]).length).toBe(40);
    expect(details.more).toBe(460);
    expect(utf8(details)).toBeLessThan(4096);
    expect(changedInTargetDetails(changed.slice(0, 3))).toEqual({ changed: changed.slice(0, 3) });
    expect(bridgeError('changed_in_target', 'changed', details).class).toBe('needs_user');
  });

  it('changed details fit 4 KB with realistic ids and timestamp versions', () => {
    const at = (i: number) => new Date(Date.UTC(2026, 9, 23, 10, 0, i)).toISOString();
    const changed = Array.from({ length: 500 }, (_, i) => ({
      id: `s-figures#table-1#cell-2#img-${String(i).padStart(3, '0')}#img-1`,
      expected: at(i),
      actual: i % 3 ? at(i + 1) : null,
    }));
    expect(changed[0]!.id).toHaveLength(38);
    const details = changedInTargetDetails(changed);
    const shown = details.changed as { id: string }[];
    expect(utf8(details)).toBeLessThan(4096);
    expect(utf8(details)).toBeLessThanOrEqual(3500);
    expect(shown.length).toBeGreaterThan(0);
    expect(shown.length).toBeLessThan(40);
    expect(details.more).toBe(500 - shown.length);
    expect(shown).toEqual(changed.slice(0, shown.length));
  });

  it('cuts a long id or version to 200 characters', () => {
    const details = changedInTargetDetails([
      { id: 'x'.repeat(10_000), expected: 'é'.repeat(300), actual: null },
      { id: 'short', expected: '1', actual: '2' },
    ]);
    const [first, second] = details.changed as { id: string; expected: string }[];
    expect(first!.id).toBe(`${'x'.repeat(200)}…`);
    expect(first!.expected).toBe(`${'é'.repeat(200)}…`);
    expect(second).toEqual({ id: 'short', expected: '1', actual: '2' });
    expect(details.more).toBeUndefined();
    expect(utf8(details)).toBeLessThan(4096);
  });
});

describe('provenance guards', () => {
  it('tells decomposition provenance from extraction provenance', () => {
    const decomposition = decomposedPackage.provenance;
    const extraction = docPackage.provenance;
    expect(isDecompositionProvenance(decomposition)).toBe(true);
    expect(isExtractionProvenance(decomposition)).toBe(false);
    expect(isExtractionProvenance(extraction)).toBe(true);
    expect(isDecompositionProvenance(extraction)).toBe(false);
    expect(isDecompositionProvenance(null)).toBe(false);
    expect(isExtractionProvenance(null)).toBe(false);
    // They narrow: each variant's own fields are readable without a cast.
    if (isExtractionProvenance(extraction)) expect(extraction.recipeId).toBe('invoice');
    if (isDecompositionProvenance(decomposition)) {
      expect(decomposition.sourceKey).toBe('example/source-1');
    }
  });
});

describe('decomposition idempotency key', () => {
  it('decomposition idempotency keys differ by persistent id, version and force batch', () => {
    const sha = 'a'.repeat(64);
    const first = decompositionIdempotencyKey(sha, null, 1, null);
    const forced = decompositionIdempotencyKey(sha, 'doc-1', 2, 'batch-1');
    // The same two values are asserted by the worker's test.
    expect(first).toBe('94272c6b2a68fe7f0bb80994ceac3e804b264d676e266b6f7d2d0ff20bb7e730');
    expect(forced).toBe('1096d758e38351123f98cefa632e569a8d122b940258f51851f2f0ddb59534fd');
    expect(first).toBe(
      createHash('sha256').update(['decomposition', sha, '', '1', ''].join('\n')).digest('hex'),
    );
    const keys = [
      first,
      decompositionIdempotencyKey(sha, 'doc-1', 1, null),
      decompositionIdempotencyKey(sha, null, 2, null),
      decompositionIdempotencyKey(sha, null, 1, 'batch-1'),
      forced,
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(decompositionIdempotencyKey(sha, null, 1, null)).toBe(first);
  });
});
