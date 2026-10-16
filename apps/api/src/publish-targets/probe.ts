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

/** A plain description of an S3 error; never its message, which can echo request detail. */
function describe(err: unknown, step: Step): { step: TargetTestResult['step']; message: string } {
  const e = err as { name?: string; code?: string };
  const name = e.name ?? 'Error';
  if (
    (e.code && NETWORK_CODES.has(e.code)) ||
    name === 'TimeoutError' ||
    name === 'RequestTimeout'
  ) {
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
 * Writes a throwaway object under the prefix, reads it back and deletes it. Reports the first
 * step that failed; messages never carry credentials or the error's own text.
 */
export async function probeTarget(
  store: ObjectStore,
  bucket: string,
  prefix: string,
): Promise<TargetTestResult> {
  const key = `${prefix}.ct-studio-check-${randomUUID()}`;
  const body = Buffer.from(`ct-studio connection check ${new Date().toISOString()}`);
  let step: Step = 'write';
  try {
    await store.put(bucket, key, body, 'text/plain');
    step = 'read';
    const back = await store.get(bucket, key);
    if (!back || !back.equals(body)) {
      return {
        ok: false,
        step: 'read',
        message: 'the file read back did not match what was written',
      };
    }
    step = 'delete';
    await store.delete(bucket, key);
  } catch (err) {
    return { ok: false, ...describe(err, step) };
  }
  return { ok: true, step: null, message: 'Connected: wrote, read and deleted a test file' };
}
