import { randomUUID } from 'node:crypto';
import type { TargetTestResult } from '@ih/shared';
import type { ObjectStore } from '../storage/object-store.js';

const NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

type Step = 'write' | 'read' | 'delete';

const isNetwork = (err: unknown): boolean => {
  const e = err as { name?: string; code?: string };
  return (
    (e.code !== undefined && NETWORK_CODES.has(e.code)) ||
    e.name === 'TimeoutError' ||
    e.name === 'RequestTimeout'
  );
};

/**
 * The bucket exists: a missing one is a failure before anything is written, since SeaweedFS
 * creates a missing bucket on the first put rather than refusing it. HEAD answers carry no
 * body, so a missing bucket is any 404 (`NotFound`). Any other refusal (403 for keys that may
 * write but not list) is left to the write step.
 */
async function checkBucket(store: ObjectStore, bucket: string): Promise<TargetTestResult | null> {
  try {
    await store.ping(bucket);
    return null;
  } catch (err) {
    if (isNetwork(err))
      return { ok: false, step: 'connect', message: 'could not reach the endpoint' };
    const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
    if (e.name === 'NoSuchBucket' || e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) {
      return { ok: false, step: 'connect', message: 'no such bucket' };
    }
    return null;
  }
}

/** A plain description of an S3 error; never its message, which can echo request detail. */
function describe(err: unknown, step: Step): { step: TargetTestResult['step']; message: string } {
  const name = (err as { name?: string }).name ?? 'Error';
  if (isNetwork(err)) {
    return { step: 'connect', message: 'could not reach the endpoint' };
  }
  if (
    name === 'AccessDenied' ||
    name === 'Forbidden' ||
    name === 'InvalidAccessKeyId' ||
    name === 'SignatureDoesNotMatch'
  ) {
    return { step, message: 'access denied' };
  }
  if (name === 'NoSuchBucket') return { step, message: 'no such bucket' };
  if (name === 'PermanentRedirect' || name === 'AuthorizationHeaderMalformed') {
    return { step, message: 'wrong region for this bucket' };
  }
  return { step, message: name };
}

/**
 * Checks the bucket (unless `checkBucket` is false: an internal target's bucket is created when
 * it is saved), then writes a throwaway object under the prefix, reads it back and deletes it.
 * Reports the first step that failed; messages never carry credentials or the error's own text.
 */
export async function probeTarget(
  store: ObjectStore,
  bucket: string,
  prefix: string,
  { checkBucket: check = true }: { checkBucket?: boolean } = {},
): Promise<TargetTestResult> {
  const key = `${prefix}.ct-studio-check-${randomUUID()}`;
  const body = Buffer.from(`ct-studio connection check ${new Date().toISOString()}`);
  const missing = check ? await checkBucket(store, bucket) : null;
  if (missing) return missing;
  try {
    await store.put(bucket, key, body, 'text/plain');
  } catch (err) {
    return { ok: false, ...describe(err, 'write') };
  }
  let readFailure: TargetTestResult | null = null;
  try {
    const back = await store.get(bucket, key);
    if (!back || !back.equals(body)) {
      readFailure = {
        ok: false,
        step: 'read',
        message: 'the file read back did not match what was written',
      };
    }
  } catch (err) {
    readFailure = { ok: false, ...describe(err, 'read') };
  }
  // Written, so always deleted, whatever the read found; the read's failure is the answer.
  try {
    await store.delete(bucket, key);
  } catch (err) {
    return readFailure ?? { ok: false, ...describe(err, 'delete') };
  }
  if (readFailure) return readFailure;
  return { ok: true, step: null, message: 'Connected: wrote, read and deleted a test file' };
}
