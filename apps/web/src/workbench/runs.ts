import type {
  JobStatus,
  ModelChoice,
  QueueSummary,
  SampleView,
  StepProgress,
  TestRun,
} from '@ih/shared';
import { formatDuration, jobDuration, statusLabel, statusTone, type Tone } from '../jobs/derive.js';
import { shortDateTime } from './references.js';

/** Test runs started together (one `POST …/test-runs`, handoff TR2). */
export interface RunBatch {
  id: string;
  /** The earliest run's creation time. */
  createdAt: string;
  specVersion: number;
  createdBy: string | null;
  /** The model the batch was started with (a retry may change one run's). */
  modelOverride: string | null;
  /** By file name. */
  runs: TestRun[];
  active: boolean;
}

const ACTIVE: ReadonlySet<JobStatus> = new Set(['queued', 'running']);
export const isActiveRun = (run: TestRun) => ACTIVE.has(run.status);

/** Batches newest first; runs outside a batch (older runs, reference and evaluation jobs). */
export function runBatches(runs: readonly TestRun[]): { batches: RunBatch[]; others: TestRun[] } {
  const groups = new Map<string, TestRun[]>();
  const others: TestRun[] = [];
  for (const run of runs) {
    if (run.batchId === null) others.push(run);
    else groups.set(run.batchId, [...(groups.get(run.batchId) ?? []), run]);
  }
  const batches = [...groups].map(([id, members]): RunBatch => {
    const first = members.reduce((a, b) => (b.createdAt < a.createdAt ? b : a));
    return {
      id,
      createdAt: first.createdAt,
      specVersion: first.specVersion,
      createdBy: first.createdBy,
      modelOverride: first.modelOverride,
      runs: [...members].sort(
        (a, b) => a.filename.localeCompare(b.filename) || a.id.localeCompare(b.id),
      ),
      active: members.some(isActiveRun),
    };
  });
  batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return { batches, others };
}

/** The newest two batches and any still running are shown; older ones wait behind *Show*. */
export function splitBatches(batches: readonly RunBatch[]): {
  shown: RunBatch[];
  hidden: RunBatch[];
} {
  const shown = batches.filter((b, i) => i < 2 || b.active);
  return { shown, hidden: batches.filter((b) => !shown.includes(b)) };
}

const ORDER: readonly JobStatus[] = [
  'succeeded',
  'awaiting_review',
  'running',
  'queued',
  'needs_review',
  'failed',
  'rejected',
  'cancelled',
];

export interface Segment {
  status: JobStatus;
  count: number;
  label: string;
  tone: Tone;
}

/** The batch's stacked status bar, in a fixed order. */
export function batchSegments(batch: RunBatch): Segment[] {
  return ORDER.map((status) => ({
    status,
    count: batch.runs.filter((r) => r.status === status).length,
    label: statusLabel(status).toLowerCase(),
    tone: statusTone(status),
  })).filter((s) => s.count > 0);
}

export const segmentsText = (segments: readonly Segment[]) =>
  segments.map((s) => `${s.count} ${s.label}`).join(' · ');

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "12 Oct, 10:14 · draft v4", or "Just now · draft v4" within a minute. */
export function batchTitle(batch: RunBatch, now: number): string {
  const when =
    now - Date.parse(batch.createdAt) < 60_000 ? 'Just now' : shortDateTime(batch.createdAt);
  return `${when} · draft v${batch.specVersion}`;
}

/** "6 dev samples · started by ken · template's models". */
export function batchSubtitle(batch: RunBatch, choices: readonly ModelChoice[]): string {
  const model =
    batch.modelOverride === null
      ? "recipe's models"
      : (choices.find((c) => c.id === batch.modelOverride)?.label ?? batch.modelOverride);
  return [
    plural(batch.runs.length, 'dev sample'),
    ...(batch.createdBy ? [`started by ${batch.createdBy}`] : []),
    model,
  ].join(' · ');
}

/** "Older batches: 4 more on v3 and v4". */
export function olderText(hidden: readonly RunBatch[]): string {
  const versions = [...new Set(hidden.map((b) => b.specVersion))]
    .sort((a, b) => a - b)
    .map((v) => `v${v}`);
  const list =
    versions.length <= 2
      ? versions.join(' and ')
      : `${versions.slice(0, -1).join(', ')} and ${versions.at(-1)}`;
  return `Older batches: ${hidden.length} more on ${list}`;
}

/** "Step 2 of 3 · line_items · chunk 2 of 2 · attempt 2". */
export function progressText(p: StepProgress): string {
  return [
    `Step ${p.index} of ${p.of}`,
    p.step,
    ...(p.chunk ? [`chunk ${p.chunk.n} of ${p.chunk.of}`] : []),
    ...(p.attempt > 1 ? [`attempt ${p.attempt}`] : []),
  ].join(' · ');
}

export type DetailTone = 'muted' | 'warn' | 'danger' | 'info';

/** The row's detail line: progress, what review flagged, or the error in the job's words. */
export function runDetail(run: TestRun): { text: string; tone: DetailTone } {
  switch (run.status) {
    case 'queued':
      return run.attempts > 0 && run.error
        ? { text: `Retrying after attempt ${run.attempts}: ${run.error}`, tone: 'warn' }
        : { text: 'Waiting for a worker', tone: 'muted' };
    case 'running':
      if (run.task === 'rerun') return { text: 'Re-running a step', tone: 'info' };
      if (run.task === 'publish') return { text: 'Finishing the review', tone: 'info' };
      return { text: run.progress ? progressText(run.progress) : 'Starting…', tone: 'info' };
    case 'awaiting_review':
      return {
        text: run.reviewReasons?.length ? run.reviewReasons.join('; ') : 'Waiting for your review',
        tone: 'warn',
      };
    case 'needs_review':
      return { text: run.error ?? 'Needs an operator', tone: 'warn' };
    case 'failed':
      return {
        text: `${run.error ?? 'Failed'}${run.attempts > 1 ? ` (after ${run.attempts} attempts)` : ''}`,
        tone: 'danger',
      };
    case 'succeeded': {
      const head = run.reviewedAt
        ? `Approved by ${run.reviewer ?? 'a reviewer'}`
        : 'Finished · nothing to review';
      return {
        text: run.attempts > 1 ? `${head} · took ${run.attempts} attempts` : head,
        tone: 'muted',
      };
    }
    case 'rejected':
      return { text: run.reviewNote ? `Rejected: ${run.reviewNote}` : 'Rejected', tone: 'muted' };
    case 'cancelled':
      return { text: 'Cancelled', tone: 'muted' };
  }
}

export { formatDuration };

/** The latest attempt's run time; up to now while running; "—" when not timed. */
export function runDuration(run: TestRun, now: number): string {
  return jobDuration(run, now) ?? '—';
}

export type RunAction = 'review-now' | 'review' | 'retry' | null;

const ACTIONS: Record<JobStatus, RunAction> = {
  awaiting_review: 'review-now',
  succeeded: 'review',
  failed: 'retry',
  needs_review: 'retry',
  cancelled: 'retry',
  queued: null,
  running: null,
  rejected: null,
};
export const runAction = (run: TestRun): RunAction => ACTIONS[run.status];

export interface SampleChoice {
  sample: SampleView;
  selectable: boolean;
  /** Why it cannot be picked (the tick box's title). */
  reason: string | null;
}

/** The dev samples a batch can run on (holdout is never offered). */
export function runSamples(samples: readonly SampleView[]): SampleChoice[] {
  return samples
    .filter((s) => s.role === 'dev')
    .map((sample) => ({
      sample,
      selectable: sample.state === 'ready',
      reason:
        sample.state === 'ready'
          ? null
          : sample.state === 'preparing'
            ? 'Still preparing'
            : `Preparation failed: ${sample.prepareError?.message ?? sample.error ?? 'unknown error'}`,
    }));
}

export const runLabel = (n: number) => `Run on ${plural(n, 'dev sample')}`;

/** Why *Run on n dev samples* is disabled; null when it can run. */
export function runBlockedReason(draft: number | null, selected: number): string | null {
  if (draft === null) {
    return 'Every version is published: start the next version on the Recipe tab first';
  }
  if (selected === 0) return 'Select at least one prepared dev sample';
  return null;
}

const etaText = (s: number) =>
  s < 60
    ? 'under a minute'
    : s < 5400
      ? `about ${Math.round(s / 60)} min`
      : `about ${Math.round(s / 3600)} h`;

/** "Queue: 3 jobs ahead · about 2 min"; null when the queue could not be read. */
export function queueText(q: QueueSummary | null): string | null {
  if (q === null) return null;
  if (q.ahead === 0) return 'Queue: empty, runs start right away';
  const head = `Queue: ${plural(q.ahead, 'job')} ahead`;
  return q.etaSeconds === null ? head : `${head} · ${etaText(q.etaSeconds)}`;
}
