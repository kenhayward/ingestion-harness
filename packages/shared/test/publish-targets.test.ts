import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TARGET_ID,
  normalisePrefix,
  publishTargetIdFrom,
  TargetCreateBodySchema,
  TargetIdSchema,
  TargetPatchBodySchema,
  TargetTestBodySchema,
  targetInUse,
} from '../src/publish-targets.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/publish-targets.json', import.meta.url), 'utf8'),
) as { prefixes: { input: string; expected: string }[] };

describe('publishTargetIdFrom', () => {
  it.each([
    ['Finance lake', 'finance-lake'],
    ['Default', 'target'],
    ['  !!! ', 'target'],
  ])('%s -> %s', (label, id) => {
    expect(publishTargetIdFrom(label)).toBe(id);
  });
  it('makes ids the id rule accepts', () => {
    expect(TargetIdSchema.safeParse(publishTargetIdFrom('A'.repeat(100))).success).toBe(true);
    expect(DEFAULT_TARGET_ID).toBe('default');
  });
});

describe('normalisePrefix (shared with the worker)', () => {
  it.each(fixture.prefixes.map((c) => [c.input, c.expected] as const))('%j -> %j', (i, e) => {
    expect(normalisePrefix(i)).toBe(e);
  });
});

describe('target bodies', () => {
  const external = {
    label: 'Lake',
    kind: 'external',
    bucket: 'my-lake',
    region: 'eu-west-2',
    accessKeyId: 'AKIA',
    secretAccessKey: 'secret',
  };
  it('accepts an internal and an external target, with defaults', () => {
    expect(
      TargetCreateBodySchema.parse({ label: 'In', kind: 'internal', bucket: 'pub' }),
    ).toMatchObject({
      label: 'In',
      kind: 'internal',
      bucket: 'pub',
      prefix: '',
    });
    expect(TargetCreateBodySchema.parse(external)).toMatchObject({
      prefix: '',
      forcePathStyle: false,
      sse: 'none',
    });
  });
  it.each([
    ['internal with a region', { label: 'x', kind: 'internal', bucket: 'pub', region: 'r' }],
    ['external without a region', { ...external, region: undefined }],
    ['kms key without aws:kms', { ...external, sse: 'AES256', kmsKeyId: 'k' }],
    ['bad bucket', { ...external, bucket: 'My_Bucket' }],
  ])('refuses %s', (_n, body) => {
    expect(TargetCreateBodySchema.safeParse(body).success).toBe(false);
  });
  it('says why an internal target refuses external fields', () => {
    const r = TargetCreateBodySchema.safeParse({
      label: 'x',
      kind: 'internal',
      bucket: 'pub',
      region: 'r',
    });
    expect(JSON.stringify(r.error?.issues)).toContain(
      'internal targets take only a bucket and prefix',
    );
  });
  it('refuses an empty patch', () => {
    const r = TargetPatchBodySchema.safeParse({});
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('nothing to change');
    expect(TargetPatchBodySchema.safeParse({ label: 'New' }).success).toBe(true);
  });
  it('knows when a target is in use', () => {
    const none = { publishedVersions: 0, documentTypes: [], deliveredOutputs: 0, consumers: 0 };
    expect(targetInUse(none)).toBe(false);
    expect(targetInUse({ ...none, consumers: 1 })).toBe(true);
    expect(targetInUse({ ...none, deliveredOutputs: 1 })).toBe(true);
    expect(targetInUse({ ...none, publishedVersions: 1 })).toBe(true);
  });
  it('test bodies: an id alone or with overrides, else a full create body', () => {
    expect(TargetTestBodySchema.safeParse({ id: 'finance-lake' }).success).toBe(true);
    expect(
      TargetTestBodySchema.safeParse({ id: 'finance-lake', secretAccessKey: 'new' }).success,
    ).toBe(true);
    expect(TargetTestBodySchema.safeParse(external).success).toBe(true);
    expect(TargetTestBodySchema.safeParse({ bucket: 'my-lake' }).success).toBe(false);
  });
});

describe('target prefix', () => {
  const body = (prefix: string) => ({ label: 'In', kind: 'internal', bucket: 'pub', prefix });
  it.each(['a*b', 'a?b', '${aws:username}', 'a/../b', 'a b', 'x'.repeat(513)])(
    'refuses %s',
    (prefix) => {
      expect(TargetCreateBodySchema.safeParse(body(prefix)).success).toBe(false);
      expect(TargetPatchBodySchema.safeParse({ prefix }).success).toBe(false);
      expect(TargetTestBodySchema.safeParse({ ...body(prefix), id: 'x' }).success).toBe(false);
    },
  );
  it('accepts ordinary prefixes, trimmed', () => {
    expect(TargetCreateBodySchema.parse(body(' ingest/2026_q3/ ')).prefix).toBe('ingest/2026_q3/');
    expect(TargetCreateBodySchema.safeParse(body("it's(1)-a.b/")).success).toBe(true);
  });
});
