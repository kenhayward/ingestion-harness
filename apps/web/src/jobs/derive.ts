import {
  pickedChoice,
  type JobProgress,
  type JobStatus,
  type JobSummary,
  type ModelChoice,
  type StageTimes,
  type StepRun,
} from '@ih/shared';
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
  delivering: { label: 'Delivering', tone: 'info' },
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
  // The bridge owns a delivering job: it cannot be cancelled, only watched.
  delivering: 'view',
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
    case 'delivering':
      return { text: 'Delivering', tone: 'muted' };
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
 * The five-step progress list, derived from the status, the step runs and, while the job runs,
 * its latest progress (`GET /api/jobs/:id/events`). Without progress a step run proves text and
 * sections were done; every run succeeding proves extraction. `runs` is null while they load.
 */
export function progressSteps(
  job: JobSummary,
  runs: readonly StepRun[] | null,
  progress: JobProgress | null = null,
): { label: string; state: StepState; text: string }[] {
  const upTo = (done: number, next: StepState | null): StepState[] =>
    STEP_LABELS.map((_, i) => (i < done ? 'done' : i === done && next ? next : 'todo'));
  const ran = runs !== null && runs.length > 0;
  const extracted = ran && runs.every((r) => r.status === 'succeeded');
  let states: StepState[];
  let running: string | null = null;
  switch (job.status) {
    case 'queued':
      states = upTo(0, null);
      break;
    case 'running':
      if (progress?.kind === 'prepare') {
        states = upTo(0, 'current');
        running = readingText(progress);
      } else if (progress) {
        states = upTo(2, 'current');
        running = progress.kind === 'step' ? stepText(progress) : 'Starting';
      } else {
        states = ran ? upTo(2, 'current') : upTo(0, 'current');
      }
      break;
    case 'awaiting_review':
      states = upTo(4, 'wait');
      break;
    case 'succeeded':
      states = upTo(5, null);
      break;
    case 'delivering':
      // Reviewed (or not needed) and handed to the bridge: publishing is the step under way.
      states = upTo(4, 'current');
      running = 'Delivering';
      break;
    case 'rejected':
      states = upTo(4, 'fail');
      break;
    case 'cancelled':
    case 'failed':
    case 'needs_review':
      // Without step runs nothing shows where it stopped (legacy specs record none; config
      // errors stop before any call): claim no stage, the callout carries the message.
      if (!ran) states = upTo(0, null);
      else states = extracted && job.status !== 'cancelled' ? upTo(3, 'fail') : upTo(2, 'fail');
      break;
  }
  return STEP_LABELS.map((label, i) => ({
    label,
    state: states[i]!,
    text: states[i] === 'current' && running ? running : STATE_TEXT[states[i]!],
  }));
}

/**
 * How long each of the five progress steps took, in seconds (null: not run, or not known). From
 * the job's claim (`startedAt`): reading ends at `times.readAt` (or, for runs from before reading
 * was reported, at `segmentedAt`, with no time for Sections), Sections at `segmentedAt`,
 * Extraction at the last step run of this extraction (re-runs are not counted), Validation at
 * `finishedAt`, and Review & publish when the job was published or rejected. A step still
 * running, or a review still waiting, counts up to `now`.
 */
export function stepSeconds(
  job: JobSummary,
  runs: readonly StepRun[] | null,
  times: StageTimes | null,
  steps: readonly { state: StepState }[],
  now: number,
): (number | null)[] {
  const t = (iso: string | null | undefined) => (iso ? Date.parse(iso) : null);
  const start = t(job.startedAt);
  if (start === null || job.status === 'queued') return steps.map(() => null);
  const read = t(times?.readAt) ?? t(times?.segmentedAt);
  const segmented = t(times?.segmentedAt);
  const extracted = (runs ?? [])
    .filter((r) => r.trigger === 'process' && Date.parse(r.startedAt) >= start)
    .map((r) => Date.parse(r.finishedAt))
    .reduce<number | null>((a, b) => (a === null || b > a ? b : a), null);
  const finished = t(job.finishedAt);
  const decided = job.status === 'succeeded' || job.status === 'rejected' ? t(job.updatedAt) : null;
  const bounds: [number | null, number | null][] = [
    [start, read],
    [times?.readAt ? read : null, segmented],
    [segmented, extracted ?? finished],
    [extracted, finished],
    [finished, decided],
  ];
  return steps.map(({ state }, i) => {
    if (state === 'todo') return null;
    const [from, to] = bounds[i]!;
    const end = state === 'current' || state === 'wait' ? now : to;
    return from === null || end === null || end < from ? null : (end - from) / 1000;
  });
}

const pages = (n: number) => `${n} ${n === 1 ? 'page' : 'pages'}`;

function readingText(p: Extract<JobProgress, { kind: 'prepare' }>): string {
  return p.stage === 'ocr' ? `OCR ${p.page} of ${pages(p.of)}` : `Reading ${pages(p.of)}`;
}

function stepText(p: Extract<JobProgress, { kind: 'step' }>): string {
  const occurrence = p.occurrence
    ? ` · occurrence ${p.occurrence.n} of ${p.occurrence.of}${p.occurrence.key ? ` (${p.occurrence.key})` : ''}`
    : '';
  const where = `Step ${p.index} of ${p.of}${occurrence}`;
  if (p.chunk) return `${where} · part ${p.chunk.n} of ${p.chunk.of}`;
  return p.attempt > 1 ? `${where} · try ${p.attempt}` : where;
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

/** mm:ss ("00:31", "23:04"), h:mm:ss from an hour ("1:02:05"). */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * How long the job's latest extraction took (`startedAt` to `finishedAt`, migration 0028), up
 * to now while it runs; null when it was never timed or is queued (again).
 */
export function jobDuration(
  job: Pick<JobSummary, 'status' | 'task' | 'startedAt' | 'finishedAt'>,
  now: number,
): string | null {
  if (!job.startedAt || job.status === 'queued') return null;
  const start = Date.parse(job.startedAt);
  // A step re-run or publish keeps the extraction's start: only a running extraction counts up.
  if (job.status === 'running' && job.task === 'process') {
    return formatDuration((now - start) / 1000);
  }
  return job.finishedAt ? formatDuration((Date.parse(job.finishedAt) - start) / 1000) : null;
}

/** The drafting-model alias (reference runs store it as their model override). */
const DRAFT_ALIAS = 'draft';
const DRAFTING_MODEL = 'Drafting model';

/** Shown instead of a model ref when no model choice matches (people never see refs). */
export const MODEL_NOT_OFFERED = 'Model no longer offered';

/**
 * Stand-ins for "the choices are not known": still loading, or the load failed. They are empty
 * arrays (pickers offer nothing), told apart by identity, so a display never reads a missing
 * label as "Model no longer offered" (and never falls back to a ref).
 */
export const CHOICES_LOADING: readonly ModelChoice[] = Object.freeze([]);
export const CHOICES_FAILED: readonly ModelChoice[] = Object.freeze([]);
const LOADING_TEXT = '…';
const FAILED_TEXT = '—';

/** The placeholder to show instead of a name while the choices are unknown, else null. */
const unknownText = (choices: readonly ModelChoice[]): string | null =>
  choices === CHOICES_LOADING ? LOADING_TEXT : choices === CHOICES_FAILED ? FAILED_TEXT : null;

/**
 * The model's name for people: a choice id, `default`, or a choice's ref -> its label. Anything
 * else (a ref no choice has) is never shown; it reads "Model no longer offered". While the
 * choices load it is "…", and "—" if they could not be read.
 */
export function modelDisplayName(nameOrRef: string, choices: readonly ModelChoice[]): string {
  if (nameOrRef === DRAFT_ALIAS) return DRAFTING_MODEL;
  const unknown = unknownText(choices);
  if (unknown !== null) return unknown;
  const choice =
    pickedChoice(nameOrRef, choices) ?? choices.find((c) => c.ref === nameOrRef) ?? null;
  return choice?.label ?? MODEL_NOT_OFFERED;
}

/**
 * A stored choice name (an evaluation's or step's model: a choice id, `default`, or an older
 * name like `fast`) by its label. A name no choice has (a deleted choice, an older alias, a ref)
 * is never shown: "Model no longer offered".
 */
export function choiceName(name: string, choices: readonly ModelChoice[]): string {
  return modelDisplayName(name, choices);
}

/** The drafting model (a ref) by its choice's label; "Drafting model" when no choice has it. */
export function draftingModelName(ref: string | null, choices: readonly ModelChoice[]): string {
  return choices.find((c) => c.ref === ref)?.label ?? DRAFTING_MODEL;
}

/** What ran (step runs), else what was requested (override), else the spec default; by name. */
export function modelLabel(job: JobSummary, choices: readonly ModelChoice[]): string {
  const names = job.modelsUsed.length
    ? job.modelsUsed
    : job.modelOverride
      ? [job.modelOverride]
      : [];
  if (names.length === 0) return 'Spec default';
  // A draft-model run (reference runs): its ref usually matches no choice.
  if (
    job.modelOverride === DRAFT_ALIAS &&
    unknownText(choices) === null &&
    !names.some((n) => pickedChoice(n, choices) ?? choices.some((c) => c.ref === n))
  ) {
    return DRAFTING_MODEL;
  }
  // Choices sharing a ref (main and fast on one model): the one that was asked for names it.
  const asked = job.modelOverride ? pickedChoice(job.modelOverride, choices) : null;
  const nameOf = (n: string) =>
    asked !== null && asked.ref === n ? asked.label : modelDisplayName(n, choices);
  return [...new Set(names.map(nameOf))].join(', ');
}

const MENU = { width: 220, height: 160, gap: 4, margin: 8 };

/**
 * Where a fixed-position menu opens for a button: right-aligned under it, clamped inside the
 * viewport (phones put the button near the left edge), flipped above when there's no room below.
 */
export function menuPosition(
  button: { left: number; right: number; top: number; bottom: number },
  viewport: { width: number; height: number },
): { left: number; top?: number; bottom?: number } {
  const maxLeft = Math.max(MENU.margin, viewport.width - MENU.width - MENU.margin);
  const left = Math.min(Math.max(button.right - MENU.width, MENU.margin), maxLeft);
  const below = button.bottom + MENU.gap;
  if (below + MENU.height > viewport.height - MENU.margin) {
    return { left, bottom: viewport.height - button.top + MENU.gap };
  }
  return { left, top: below };
}
