import { describe, expect, it } from 'vitest';
import { MemoryObjectStore } from '../src/s3/store.js';
import { probe } from '../src/sinks/probe.js';
import { GarblingStore, MissingBucketStore, s3Failure, ThrowingStore } from './s3-fakes.js';

describe('probe', () => {
  it('writes, reads and deletes a throwaway object under the prefix', async () => {
    const store = new MemoryObjectStore();
    const seen: string[] = [];
    const put = store.put.bind(store);
    store.put = async (bucket, key, body, type) => {
      seen.push(`${bucket}/${key}`);
      await put(bucket, key, body, type);
    };
    expect(await probe(store, 'pub', 'out/')).toEqual({
      ok: true,
      step: null,
      message: 'Connected: wrote, read and deleted a test file',
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/^pub\/out\/\.ct-studio-check-/);
    expect(store.objects.size).toBe(0);
  });

  it('names the failed step, never the error text', async () => {
    const denied = new ThrowingStore(() => s3Failure('AccessDenied'));
    expect(await probe(denied, 'pub', '', { checkBucket: false })).toEqual({
      ok: false,
      step: 'write',
      message: 'access denied',
    });
    const offline = new ThrowingStore(() => s3Failure('Error', { code: 'ECONNREFUSED' }));
    expect(await probe(offline, 'pub', '')).toEqual({
      ok: false,
      step: 'connect',
      message: 'could not reach the endpoint',
    });
    const wrongRegion = new ThrowingStore(() => s3Failure('PermanentRedirect'));
    expect(await probe(wrongRegion, 'pub', '', { checkBucket: false })).toMatchObject({
      step: 'write',
      message: 'wrong region for this bucket',
    });
  });

  it('says no such bucket before writing anything', async () => {
    const store = new MissingBucketStore();
    expect(await probe(store, 'pub', '')).toEqual({
      ok: false,
      step: 'connect',
      message: 'no such bucket',
    });
    expect(store.objects.size).toBe(0);
  });

  it('skips the bucket check when told to (an internal bucket is created on save)', async () => {
    expect(await probe(new MissingBucketStore(), 'new', '', { checkBucket: false })).toMatchObject({
      ok: true,
    });
  });

  it('reports a read that does not match, and still deletes the object', async () => {
    const store = new GarblingStore();
    expect(await probe(store, 'pub', '')).toEqual({
      ok: false,
      step: 'read',
      message: 'the file read back did not match what was written',
    });
    expect(store.objects.size).toBe(0);
  });
});
