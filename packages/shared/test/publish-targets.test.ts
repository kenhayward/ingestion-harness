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
  TargetTestResultSchema,
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
    connectionId: 'finance-account',
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
      sse: 'none',
      connectionId: 'finance-account',
    });
  });
  it.each([
    [
      'internal with a connection',
      { label: 'x', kind: 'internal', bucket: 'pub', connectionId: 'c' },
    ],
    ['external without a connection', { ...external, connectionId: undefined }],
    ['kms key without aws:kms', { ...external, sse: 'AES256', kmsKeyId: 'k' }],
    ['bad bucket', { ...external, bucket: 'My_Bucket' }],
    ['external on the built-in connection', { ...external, connectionId: 'internal' }],
  ])('refuses %s', (_n, body) => {
    expect(TargetCreateBodySchema.safeParse(body).success).toBe(false);
  });
  it.each(['secretAccessKey', 'accessKeyId', 'endpoint', 'region', 'forcePathStyle'])(
    'refuses a credential field: %s (credentials live on the bridge)',
    (field) => {
      const value = field === 'forcePathStyle' ? true : field === 'endpoint' ? 'https://s3.x' : 'v';
      expect(TargetCreateBodySchema.safeParse({ ...external, [field]: value }).success).toBe(false);
      expect(TargetPatchBodySchema.safeParse({ [field]: value }).success).toBe(false);
      expect(TargetTestBodySchema.safeParse({ ...external, [field]: value }).success).toBe(false);
    },
  );
  it('says why an internal target refuses external fields', () => {
    const r = TargetCreateBodySchema.safeParse({
      label: 'x',
      kind: 'internal',
      bucket: 'pub',
      connectionId: 'c',
    });
    expect(JSON.stringify(r.error?.issues)).toContain(
      'internal targets take only a bucket and prefix',
    );
  });
  it('keeps the built-in connection for internal targets (their bucket rules apply)', () => {
    const r = TargetCreateBodySchema.safeParse({ ...external, connectionId: 'internal' });
    expect(JSON.stringify(r.error?.issues)).toContain(
      'the built-in connection is for internal targets only',
    );
    expect(TargetTestBodySchema.safeParse({ ...external, connectionId: 'internal' }).success).toBe(
      false,
    );
  });
  it('refuses an empty patch', () => {
    const r = TargetPatchBodySchema.safeParse({});
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toContain('nothing to change');
    expect(TargetPatchBodySchema.safeParse({ label: 'New' }).success).toBe(true);
  });
  it('refuses a kind in a patch', () => {
    expect(TargetPatchBodySchema.safeParse({ kind: 'external' }).success).toBe(false);
    expect(TargetPatchBodySchema.safeParse({ label: 'x', kind: 'internal' }).success).toBe(false);
  });
  // A default here would overwrite the stored prefix (or trip the lock) on every label edit.
  it('adds no defaults to a one-field patch', () => {
    expect(TargetPatchBodySchema.parse({ label: 'x' })).toStrictEqual({ label: 'x' });
    expect(TargetPatchBodySchema.parse({ sse: 'AES256' })).toStrictEqual({ sse: 'AES256' });
    expect(TargetPatchBodySchema.parse({ connectionId: 'c2' })).toStrictEqual({
      connectionId: 'c2',
    });
  });
  it('clears the KMS key and storage class with null, nothing else', () => {
    const cleared = { kmsKeyId: null, storageClass: null };
    expect(TargetPatchBodySchema.parse(cleared)).toStrictEqual(cleared);
    for (const field of ['label', 'bucket', 'prefix', 'sse', 'connectionId']) {
      expect([field, TargetPatchBodySchema.safeParse({ [field]: null }).success]).toEqual([
        field,
        false,
      ]);
    }
  });
  it('knows when a target is in use', () => {
    const none = {
      publishedVersions: 0,
      documentTypes: [],
      deliveredOutputs: 0,
      consumers: 0,
      pendingJobs: 0,
    };
    expect(targetInUse(none)).toBe(false);
    expect(targetInUse({ ...none, pendingJobs: 1 })).toBe(true);
    expect(targetInUse({ ...none, consumers: 1 })).toBe(true);
    expect(targetInUse({ ...none, deliveredOutputs: 1 })).toBe(true);
    expect(targetInUse({ ...none, publishedVersions: 1 })).toBe(true);
  });
  it('test bodies: an id alone, else full settings (no label needed)', () => {
    expect(TargetTestBodySchema.safeParse({ id: 'finance-lake' }).success).toBe(true);
    expect(TargetTestBodySchema.safeParse({ id: 'finance-lake', bucket: 'b' }).success).toBe(false);
    expect(TargetTestBodySchema.safeParse(external).success).toBe(true);
    const { label: _l, ...unlabelled } = external;
    void _l;
    expect(TargetTestBodySchema.safeParse(unlabelled).success).toBe(true);
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
      expect(TargetTestBodySchema.safeParse(body(prefix)).success).toBe(false);
    },
  );
  it('accepts ordinary prefixes, trimmed', () => {
    expect(TargetCreateBodySchema.parse(body(' ingest/2026_q3/ ')).prefix).toBe('ingest/2026_q3/');
    expect(TargetCreateBodySchema.safeParse(body("it's(1)-a.b/")).success).toBe(true);
  });
});

describe('TargetTestResultSchema', () => {
  it('reads the bridge contract fixture unchanged (both sides share the shape)', () => {
    const json: unknown = JSON.parse(
      readFileSync(
        new URL('../../bridge-contract/test/fixtures/target-test-result.json', import.meta.url),
        'utf8',
      ),
    );
    expect(TargetTestResultSchema.strict().parse(json)).toEqual(json);
  });
});
