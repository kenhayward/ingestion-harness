import type { BatchSummary, Item, ItemOutcome, ItemResolution } from '@ih/shared';
import type { StatusIcon, Tone } from '../jobs/derive.js';

/** How an item's outcome reads on its row (spec §3's wording, and phase 3's own outcomes). */
export const OUTCOME: Record<ItemOutcome, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  decomposing: { label: 'Decomposing', tone: 'info' },
  delivering: { label: 'Delivering', tone: 'info' },
  created: { label: 'Created', tone: 'ok' },
  updated: { label: 'Updated', tone: 'ok' },
  already_loaded: { label: 'Already loaded', tone: 'neutral' },
  duplicate: { label: 'Duplicate', tone: 'warn' },
  in_flight: { label: 'In flight', tone: 'neutral' },
  changed_in_target: { label: 'Changed in target', tone: 'alert' },
  read_back_mismatch: { label: 'Read-back mismatch', tone: 'alert' },
  unresolved: { label: 'Unresolved', tone: 'alert' },
  failed: { label: 'Failed', tone: 'danger' },
  awaiting_review: { label: 'Awaiting review', tone: 'warn' },
  rejected: { label: 'Rejected', tone: 'danger' },
  waiting_to_deliver: { label: 'Waiting to deliver', tone: 'info' },
};

/**
 * Still under way: the batch view refreshes while any item is. `in_flight` is not: the item is
 * final, because another batch's delivery owns the document's register entry.
 */
export const UNFINISHED: readonly ItemOutcome[] = [
  'queued',
  'decomposing',
  'delivering',
  'waiting_to_deliver',
];

/**
 * Outcomes a person should look at (the "Needs attention" filter), until resolved. A rejected
 * document is decided but counts with the failed ones.
 */
export const NEEDS_ATTENTION: readonly ItemOutcome[] = [
  'duplicate',
  'changed_in_target',
  'read_back_mismatch',
  'unresolved',
  'failed',
  'awaiting_review',
  'rejected',
];

export const isUnfinished = (item: Item) => UNFINISHED.includes(item.outcome);
/** Held for review: not under way (nothing polls for it), but not done either. */
export const isAwaitingReview = (item: Pick<Item, 'outcome'>) => item.outcome === 'awaiting_review';
/** A document changed in the target and then detached or accepted no longer needs attention. */
export const needsAttention = (item: Item) =>
  NEEDS_ATTENTION.includes(item.outcome) && item.resolution === null;
export const isDone = (item: Item) => !isUnfinished(item) && !needsAttention(item);

/**
 * What a resolved document's row says (§8): the item's `resolution`, read by the API from its
 * register entry, so every item on that entry says it. A superseded refusal is done with here:
 * a later run moved the document on, and only that run's row may act on it.
 */
export const RESOLUTION: Record<ItemResolution, string> = {
  detached:
    'Detached: CT Studio forgot this document. It stays in the target untouched, and the next ' +
    'run of this source creates a new document.',
  accepted:
    "The target's state accepted: the next run of this source updates the document, " +
    'overwriting the edits made in the target.',
  superseded:
    'Superseded by a later run: the document has moved on since this refusal, so this row no ' +
    'longer detaches or accepts it. A later batch shows where it stands.',
};

/** What an outcome adds to its row's detail, when the outcome alone doesn't say where to look. */
export const OUTCOME_NOTE: Partial<Record<ItemOutcome, string>> = {
  in_flight: "Another batch is delivering this document: its outcome shows in that batch's view.",
};

/** A duration as a row says it: "40 s", "1 min 12 s", "2 min", "1 h 2 min". */
export function spokenDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  if (s < 3600) {
    const rest = s % 60;
    return `${Math.floor(s / 60)} min${rest ? ` ${rest} s` : ''}`;
  }
  const minutes = Math.floor((s % 3600) / 60);
  return `${Math.floor(s / 3600)} h${minutes ? ` ${minutes} min` : ''}`;
}

/**
 * How long the item has waited between decomposing and delivering (a free lane, a review), up
 * to `end`: its waits already over and the one under way.
 */
export function waitedMs(item: Pick<Item, 'waitingSince' | 'waitedMs'>, end: number): number {
  const open = item.waitingSince ? Math.max(0, end - Date.parse(item.waitingSince)) : 0;
  return item.waitedMs + open;
}

/**
 * How long a document took to convert ("took 1 min 12 s"), or how long an unfinished one has run
 * so far ("running for 40 s", "40 s so far" while it waits): from `startedAt` to `finishedAt`
 * (or now), less its waits for a lane or a review, so documents compare by the work they took.
 * Null before it started, and for a document converted before CT Studio timed them.
 */
export function itemTiming(
  item: Pick<Item, 'outcome' | 'startedAt' | 'finishedAt' | 'waitingSince' | 'waitedMs'>,
  now: number,
): string | null {
  if (!item.startedAt) return null;
  const end = item.finishedAt ? Date.parse(item.finishedAt) : now;
  const worked = spokenDuration((end - Date.parse(item.startedAt) - waitedMs(item, end)) / 1000);
  if (item.finishedAt) return `took ${worked}`;
  if (item.waitingSince) return `${worked} so far`;
  return UNFINISHED.includes(item.outcome) ? `running for ${worked}` : null;
}

/** The waits `itemTiming` leaves out ("5 min, not counted"); null under a second. */
export function itemWait(
  item: Pick<Item, 'startedAt' | 'finishedAt' | 'waitingSince' | 'waitedMs'>,
  now: number,
): string | null {
  if (!item.startedAt) return null;
  const ms = waitedMs(item, item.finishedAt ? Date.parse(item.finishedAt) : now);
  return ms >= 1000 ? `${spokenDuration(ms / 1000)}, not counted` : null;
}

/** The glyph a row shows for its outcome (the label names it). */
export const OUTCOME_ICON: Record<ItemOutcome, StatusIcon> = {
  queued: 'queued',
  decomposing: 'spinner',
  delivering: 'spinner',
  created: 'done',
  updated: 'done',
  already_loaded: 'cancelled',
  duplicate: 'warning',
  in_flight: 'cancelled',
  changed_in_target: 'warning',
  read_back_mismatch: 'warning',
  unresolved: 'warning',
  failed: 'failed',
  awaiting_review: 'review',
  rejected: 'rejected',
  waiting_to_deliver: 'queued',
};

/** Delivered as a document: created or updated. */
export const isDelivered = (item: Pick<Item, 'outcome'>) =>
  item.outcome === 'created' || item.outcome === 'updated';
/** Failed, or rejected in review: counted and listed together. */
export const isFailed = (item: Pick<Item, 'outcome'>) =>
  item.outcome === 'failed' || item.outcome === 'rejected';

/** How a batch stands, as one glyph on its row in Earlier batches. */
export function batchState(b: BatchSummary): { icon: StatusIcon; tone: Tone; label: string } {
  const n = (o: ItemOutcome) => b.counts[o] ?? 0;
  if (b.state === 'discarded') return { icon: 'rejected', tone: 'neutral', label: 'Discarded' };
  if (b.state === 'open') return { icon: 'cancelled', tone: 'neutral', label: 'Never started' };
  if (UNFINISHED.some((o) => n(o) > 0))
    return { icon: 'spinner', tone: 'info', label: 'Under way' };
  // Not finished while a document awaits review, whatever else failed.
  if (n('awaiting_review') > 0) return { icon: 'review', tone: 'warn', label: 'Awaiting review' };
  if (n('failed') + n('rejected') > 0)
    return { icon: 'failed', tone: 'danger', label: 'Some failed' };
  if (NEEDS_ATTENTION.some((o) => n(o) > 0))
    return { icon: 'warning', tone: 'warn', label: 'Needs attention' };
  if (b.itemCount > 0 && n('created') + n('updated') === 0)
    return { icon: 'cancelled', tone: 'neutral', label: 'Nothing new' };
  return { icon: 'done', tone: 'ok', label: 'Done' };
}

/** A size as the panel says it: "412 KB", "1.2 MB". */
export function spokenSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
