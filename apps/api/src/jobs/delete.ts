import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RemovedJob } from '../repositories/types.js';

/**
 * Best-effort removal of a deleted job's internal files: drafts, everything under {jobId}/ in the
 * runs bucket, and the inbox PDF when nothing else needs it. Published target copies and the OCR
 * cache are never touched. Failures are logged; the database delete already happened.
 */
export async function removeJobFiles(
  deps: Pick<AppDeps, 'store' | 'buckets'>,
  removed: RemovedJob,
  log: FastifyBaseLogger,
): Promise<void> {
  const { inboxObject } = removed;
  const tasks: Promise<unknown>[] = [
    ...removed.draftObjects.map((o) => deps.store.delete(o.bucket, o.key)),
    deps.store.deletePrefix(deps.buckets.runs, `${removed.jobId}/`),
    ...(inboxObject ? [deps.store.delete(inboxObject.bucket, inboxObject.key)] : []),
  ];
  for (const result of await Promise.allSettled(tasks)) {
    if (result.status === 'rejected') {
      log.warn({ err: result.reason, jobId: removed.jobId }, 'job file clean-up failed');
    }
  }
}
