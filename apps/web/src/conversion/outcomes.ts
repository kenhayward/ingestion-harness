import type { Item, ItemOutcome, ItemResolution } from '@ih/shared';
import type { Tone } from '../jobs/derive.js';

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
};

/**
 * Still under way: the batch view refreshes while any item is. `in_flight` is not: the item is
 * final, because another batch's delivery owns the document's register entry.
 */
export const UNFINISHED: readonly ItemOutcome[] = ['queued', 'decomposing', 'delivering'];

/** Outcomes a person should look at (the "Needs attention" filter), until resolved. */
export const NEEDS_ATTENTION: readonly ItemOutcome[] = [
  'duplicate',
  'changed_in_target',
  'read_back_mismatch',
  'unresolved',
  'failed',
];

export const isUnfinished = (item: Item) => UNFINISHED.includes(item.outcome);
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
 * How long a document took to convert ("took 1 min 12 s", from `startedAt` to `finishedAt`), or
 * how long an unfinished one has run so far ("running for 40 s"); null before it started, and
 * for a document converted before CT Studio timed them.
 */
export function itemTiming(
  item: Pick<Item, 'outcome' | 'startedAt' | 'finishedAt'>,
  now: number,
): string | null {
  if (!item.startedAt) return null;
  const start = Date.parse(item.startedAt);
  if (item.finishedAt)
    return `took ${spokenDuration((Date.parse(item.finishedAt) - start) / 1000)}`;
  return UNFINISHED.includes(item.outcome)
    ? `running for ${spokenDuration((now - start) / 1000)}`
    : null;
}
