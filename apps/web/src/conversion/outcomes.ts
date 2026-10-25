import type { Item, ItemOutcome } from '@ih/shared';
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
  in_flight: { label: 'In flight', tone: 'info' },
  changed_in_target: { label: 'Changed in target', tone: 'alert' },
  read_back_mismatch: { label: 'Read-back mismatch', tone: 'alert' },
  unresolved: { label: 'Unresolved', tone: 'alert' },
  failed: { label: 'Failed', tone: 'danger' },
};

/** Still under way: the batch view refreshes while any item is. */
export const UNFINISHED: readonly ItemOutcome[] = ['queued', 'decomposing', 'delivering'];

/** Outcomes a person should look at (the "Needs attention" filter). */
export const NEEDS_ATTENTION: readonly ItemOutcome[] = [
  'duplicate',
  'changed_in_target',
  'read_back_mismatch',
  'unresolved',
  'failed',
];

export const isUnfinished = (item: Item) => UNFINISHED.includes(item.outcome);
export const needsAttention = (item: Item) => NEEDS_ATTENTION.includes(item.outcome);
export const isDone = (item: Item) => !isUnfinished(item) && !needsAttention(item);

/**
 * How a document refused as changed in the target was resolved, if it was. Detaching or
 * accepting leaves the item's outcome `changed_in_target` (ruling M7); only its detail says what
 * happened, in the words the API writes there (`apps/api/src/routes/conversions.ts`).
 */
export function resolutionOf(item: Item): 'detached' | 'accepted' | null {
  if (item.outcome !== 'changed_in_target' || !item.detail) return null;
  if (item.detail.startsWith('detached')) return 'detached';
  if (item.detail.startsWith("the target's state was accepted")) return 'accepted';
  return null;
}
