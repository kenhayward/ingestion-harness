import type { JobStatus, JobSummary, StepRun } from '@ih/shared';
import { statusGroup, type StatusGroup } from '../shell/derive.js';

/** Status tones (UI handoff): colour + label + shape, lightness differs as well as hue. */
export type Tone = 'neutral' | 'info' | 'warn' | 'alert' | 'danger' | 'ok';

const STATUS: Record<JobStatus, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  awaiting_review: { label: 'Awaiting review', tone: 'warn' },
  needs_review: { label: 'Needs review', tone: 'alert' },
  failed: { label: 'Failed', tone: 'danger' },
  succeeded: { label: 'Succeeded', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
};

export const statusLabel = (status: JobStatus): string => STATUS[status].label;
export const statusTone = (status: JobStatus): Tone => STATUS[status].tone;

export type PrimaryAction = 'review' | 'view' | 'retry' | 'cancel' | null;

const PRIMARY: Record<JobStatus, PrimaryAction> = {
  queued: 'cancel',
  running: 'cancel',
  awaiting_review: 'review',
  needs_review: 'retry',
  failed: 'retry',
  succeeded: 'view',
  rejected: null,
  cancelled: 'retry',
};

/** The single most likely action for a job's status; the rest live in the ⋯ menu. */
export const primaryAction = (job: JobSummary): PrimaryAction => PRIMARY[job.status];

export type NoteTone = 'muted' | 'warn' | 'danger';

/** The context line under a job's file name. */
export function jobNote(job: JobSummary): { text: string; tone: NoteTone } {
  switch (job.status) {
    case 'queued':
      return { text: 'Waiting for a worker', tone: 'muted' };
    case 'running':
      return { text: 'Extracting…', tone: 'muted' };
    case 'awaiting_review':
      return { text: job.reviewReasons?.[0] ?? 'Waiting for a reviewer', tone: 'warn' };
    case 'needs_review':
      return { text: job.error ?? 'Needs an operator', tone: 'warn' };
    case 'failed':
      return { text: job.error ?? 'Failed', tone: 'danger' };
    case 'succeeded':
      return { text: job.test ? 'Test run · not published' : 'Published', tone: 'muted' };
    case 'rejected':
      return { text: job.reviewer ? `Rejected by ${job.reviewer}` : 'Rejected', tone: 'muted' };
    case 'cancelled':
      return { text: 'Cancelled by operator', tone: 'muted' };
  }
}

export type Chip = 'all' | StatusGroup;

export function inChip(job: JobSummary, chip: Chip): boolean {
  return chip === 'all' || statusGroup(job.status) === chip;
}

export function chipCounts(jobs: readonly JobSummary[]): Record<Chip, number> {
  const counts: Record<Chip, number> = { all: jobs.length, attention: 0, active: 0, done: 0 };
  for (const j of jobs) counts[statusGroup(j.status)]++;
  return counts;
}

export type StepState = 'done' | 'current' | 'wait' | 'fail' | 'todo';

const STEP_LABELS = [
  'Text & OCR',
  'Sections',
  'Extraction',
  'Validation',
  'Review & publish',
] as const;

const STATE_TEXT: Record<StepState, string> = {
  done: 'Done',
  current: 'Running',
  wait: 'Waiting for you',
  fail: 'Stopped',
  todo: '',
};

/**
 * The five-step progress list, derived from the status and the step runs: the worker doesn't
 * record its stage yet (handoff A1, phase 2). A step run proves text and sections were done;
 * every run succeeding proves extraction. `runs` is null while they load.
 */
export function progressSteps(
  job: JobSummary,
  runs: readonly StepRun[] | null,
): { label: string; state: StepState; text: string }[] {
  const upTo = (done: number, next: StepState | null): StepState[] =>
    STEP_LABELS.map((_, i) => (i < done ? 'done' : i === done && next ? next : 'todo'));
  const ran = runs !== null && runs.length > 0;
  const extracted = ran && runs.every((r) => r.status === 'succeeded');
  let states: StepState[];
  switch (job.status) {
    case 'queued':
      states = upTo(0, null);
      break;
    case 'running':
      states = ran ? upTo(2, 'current') : upTo(0, 'current');
      break;
    case 'awaiting_review':
      states = upTo(4, 'wait');
      break;
    case 'succeeded':
      states = upTo(5, null);
      break;
    case 'rejected':
      states = upTo(4, 'fail');
      break;
    case 'cancelled':
    case 'failed':
    case 'needs_review':
      if (!ran) states = /section/i.test(job.error ?? '') ? upTo(1, 'fail') : upTo(0, 'fail');
      else states = extracted && job.status !== 'cancelled' ? upTo(3, 'fail') : upTo(2, 'fail');
      break;
  }
  return STEP_LABELS.map((label, i) => ({
    label,
    state: states[i]!,
    text: STATE_TEXT[states[i]!],
  }));
}

/** "6 min ago", "Yesterday", … ; a timestamp slightly in the future (clock skew) is "Just now". */
export function relativeTime(iso: string, now: number): string {
  const mins = Math.floor(Math.max(0, now - Date.parse(iso)) / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'Yesterday';
  if (days <= 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString();
}

/** What ran (step runs), else what was requested (override), else the spec default. */
export function modelLabel(job: JobSummary): string {
  if (job.modelsUsed.length) return job.modelsUsed.join(', ');
  return job.modelOverride ?? 'Spec default';
}
