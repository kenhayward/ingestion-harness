import {
  PREPARE_FAILED_EVENT,
  PREPARE_PROGRESS_EVENT,
  PrepareErrorSchema,
  PrepareProgressSchema,
  type JobSummary,
  type PrepareError,
  type PrepareProgress,
  type SampleState,
} from '@ih/shared';
import type { JobEventRecord } from '../repositories/types.js';

/** The events `sampleViews` reads for the prepare jobs that are running or need review. */
export const PREPARE_EVENTS = [PREPARE_PROGRESS_EVENT, PREPARE_FAILED_EVENT] as const;

/**
 * A running preparation's progress in this attempt: the newest progress event written since the
 * job was claimed (the claim sets `updated_at`), so an earlier attempt's progress never shows.
 */
export function prepareProgress(
  job: JobSummary | null,
  events: readonly JobEventRecord[],
): PrepareProgress | null {
  if (!job || job.status !== 'running') return null;
  const latest = events.find((e) => e.jobId === job.id && e.message === PREPARE_PROGRESS_EVENT);
  if (!latest || Date.parse(latest.at) < Date.parse(job.updatedAt)) return null;
  const parsed = PrepareProgressSchema.safeParse(latest.data);
  return parsed.success ? parsed.data : null;
}

/**
 * Why a sample failed: the worker's code when its `prepare failed` event explains the job's
 * current error (same message), else `other` with the error the sample already shows.
 */
export function prepareError(
  state: SampleState,
  job: JobSummary | null,
  events: readonly JobEventRecord[],
): PrepareError | null {
  if (state !== 'failed') return null;
  const message = job?.error ?? job?.status ?? 'preparation job missing';
  const latest = job
    ? events.find((e) => e.jobId === job.id && e.message === PREPARE_FAILED_EVENT)
    : undefined;
  const parsed = latest ? PrepareErrorSchema.safeParse(latest.data) : null;
  if (job && parsed?.success && parsed.data.message === job.error) {
    return parsed.data;
  }
  return { code: 'other', message };
}
