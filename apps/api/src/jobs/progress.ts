import {
  GRAPH_PUBLISHED_EVENT,
  GraphPublishedSchema,
  PREPARE_PROGRESS_EVENT,
  PrepareProgressSchema,
  SEGMENTED_EVENT,
  STEP_PROGRESS_EVENT,
  StepProgressSchema,
  type JobGraph,
  type JobProgress,
  type StageTimes,
  type JobSummary,
} from '@ih/shared';
import type { JobEventRecord } from '../repositories/types.js';

/** The job events a running extraction's progress is read from. */
export const PROGRESS_EVENTS = [PREPARE_PROGRESS_EVENT, SEGMENTED_EVENT, STEP_PROGRESS_EVENT];

/**
 * A running extraction's progress: its newest progress event written since the job was claimed
 * (`startedAt`, else the claim's `updatedAt`), so an earlier attempt's never shows. Only a
 * running `process` job has progress (a step re-run or publish reuses the row's `startedAt`);
 * malformed data reads as none.
 */
export function jobProgress(
  job: JobSummary,
  events: readonly JobEventRecord[],
): JobProgress | null {
  if (job.status !== 'running' || job.task !== 'process') return null;
  const since = Date.parse(job.startedAt ?? job.updatedAt);
  const latest = events
    .filter((e) => e.jobId === job.id && PROGRESS_EVENTS.includes(e.message))
    .reduce<JobEventRecord | null>((best, e) => (best && best.at >= e.at ? best : e), null);
  if (!latest || Date.parse(latest.at) < since) return null;
  if (latest.message === SEGMENTED_EVENT) return { kind: 'segmented' };
  if (latest.message === PREPARE_PROGRESS_EVENT) {
    const parsed = PrepareProgressSchema.safeParse(latest.data);
    return parsed.success ? { kind: 'prepare', ...parsed.data } : null;
  }
  const parsed = StepProgressSchema.safeParse(latest.data);
  return parsed.success ? { kind: 'step', ...parsed.data } : null;
}

/**
 * When this attempt (events at or after `startedAt`) finished reading the document and found its
 * sections. Kept after the job finishes, so a finished job's Progress list keeps its step times;
 * nothing for a job never claimed.
 */
export function stageTimes(job: JobSummary, events: readonly JobEventRecord[]): StageTimes {
  const since = job.startedAt ? Date.parse(job.startedAt) : null;
  const latest = (message: string) => {
    if (since === null) return null;
    const at = events
      .filter((e) => e.jobId === job.id && e.message === message && Date.parse(e.at) >= since)
      .map((e) => e.at)
      .sort()
      .at(-1);
    return at ?? null;
  };
  return { readAt: latest(PREPARE_PROGRESS_EVENT), segmentedAt: latest(SEGMENTED_EVENT) };
}

/** The newest graph a job published (ADR 0011 step 6); malformed data reads as none. */
export function jobGraph(events: readonly JobEventRecord[]): JobGraph | null {
  const newest = events
    .filter((e) => e.message === GRAPH_PUBLISHED_EVENT)
    .reduce<JobEventRecord | null>((best, e) => (best && best.at >= e.at ? best : e), null);
  const parsed = GraphPublishedSchema.safeParse(newest?.data);
  if (!newest || !parsed.success) return null;
  const { graph, ...rest } = parsed.data;
  return { iri: graph, ...rest, publishedAt: newest.at };
}
