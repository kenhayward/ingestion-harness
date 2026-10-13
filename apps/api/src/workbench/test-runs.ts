import {
  STEP_PROGRESS_EVENT,
  StepProgressSchema,
  type JobSummary,
  type StepProgress,
} from '@ih/shared';
import type { JobEventRecord } from '../repositories/types.js';

/**
 * A running test run's progress in this attempt (handoff TR3): the newest `step progress` event
 * written since the job was claimed (`startedAt`, else the claim's `updatedAt` for rows from
 * before migration 0028), so an earlier attempt's progress never shows. Only a running job has
 * progress: a requeued job keeps its previous `startedAt` until it is claimed again.
 */
export function stepProgress(
  job: JobSummary,
  events: readonly JobEventRecord[],
): StepProgress | null {
  // Only an extraction reports steps: a step re-run or publish reuses the row's startedAt.
  if (job.status !== 'running' || job.task !== 'process') return null;
  const latest = events.find((e) => e.jobId === job.id && e.message === STEP_PROGRESS_EVENT);
  if (!latest || Date.parse(latest.at) < Date.parse(job.startedAt ?? job.updatedAt)) return null;
  const parsed = StepProgressSchema.safeParse(latest.data);
  return parsed.success ? parsed.data : null;
}
