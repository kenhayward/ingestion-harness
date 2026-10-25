import {
  ITEM_OUTCOMES,
  type Batch,
  type BatchSummary,
  type ChangedComponent,
  type Creator,
  type Item,
  type ItemCounts,
} from '@ih/shared';
import type { RegisterEntry } from '../repositories/types.js';
import type { AcceptPlan } from './accept.js';

/**
 * Decomposition batches (phase 3, migration 202610251200): what the Conversion tab uploads, one
 * batch per target, one item per file. `MemoryRepo` and `PgRepo` implement it, since starting
 * a batch queues its `decompose` jobs in the same transaction.
 */
export interface ConversionRepo {
  createBatch(batch: NewBatch): Promise<Batch>;
  getBatch(id: string): Promise<Batch | null>;
  /** Open and started batches, newest first, with their items counted per outcome. */
  listBatches(limit: number): Promise<BatchSummary[]>;
  /** The batch's items, in upload order. */
  listItems(batchId: string): Promise<Item[]>;
  getItem(id: string): Promise<Item | null>;
  /** The item whose `decompose` job made this delivery (by the job, not the register). */
  itemByDelivery(deliveryId: string): Promise<Item | null>;
  /** Adds an item to an open batch; its source key must be new in the batch. */
  addItem(item: NewItem): Promise<AddItemResult>;
  /**
   * Queues one `decompose` job per item (`BACKGROUND_JOBS.decompose`, params `DecomposeParams`), records
   * each job on its item and marks the batch started, all at once. An open batch only, with at
   * least one item.
   */
  startBatch(id: string, by: Creator | null): Promise<StartBatchResult>;
  /** Marks an open batch discarded; returns its items' object keys, which the caller deletes. */
  discardBatch(id: string): Promise<DiscardBatchResult>;
  /**
   * A row action's rerun of an item (force-load, redeliver): a new batch of one item, forced and
   * started at once, its `decompose` job queued, all at once. The item keeps `of`'s source key
   * and records `redeliverOf`; it delivers `source` (the stored file, or a replacement already
   * stored under the new ids).
   */
  rerunItem(rerun: Rerun): Promise<{ batch: Batch; item: Item }>;
  /** A decomposition register entry by id. */
  registerEntry(id: string): Promise<RegisterEntry | null>;
  /**
   * Detach (spec §8): deletes the entry unless a delivery for it is in flight (`pending`),
   * records `register_actions{action: 'detach'}` and sets the item's detail, all at once.
   */
  detachRegisterEntry(
    itemId: string,
    entryId: string,
    by: Batch['createdBy'],
    detail: (entry: RegisterEntry) => string,
  ): Promise<DetachResult>;
  /**
   * Accept the target's state (spec §8, ruling R5): with the entry locked, `plan` decides; when
   * it can be accepted the entry's last receipt takes the plan's components and the entry becomes
   * `delivered`, `register_actions{action: 'accept'}` records it and the item takes `detail`.
   */
  acceptTargetState(
    itemId: string,
    entryId: string,
    by: Batch['createdBy'],
    plan: (entry: RegisterEntry) => AcceptPlan,
    detail: (entry: RegisterEntry) => string,
  ): Promise<AcceptResult>;
}

export interface Rerun {
  /** The new batch's and item's ids (a replacement file is stored under them first). */
  batchId: string;
  itemId: string;
  /** The item rerun. */
  of: Item;
  targetId: string;
  createdBy: Batch['createdBy'];
  /** Who queues the job. */
  by: Creator | null;
  source: Pick<Item, 'filename' | 'contentSha256' | 'sizeBytes' | 'objectKey'>;
}

export type DetachResult =
  { ok: true; entry: RegisterEntry; item: Item } | { ok: false; reason: 'missing' | 'pending' };

export type AcceptResult =
  | { ok: true; item: Item; changed: ChangedComponent[] }
  | { ok: false; reason: 'missing' }
  | { ok: false; reason: 'not_acceptable'; why: string };

/** One row of `register_actions`: what a person did to a register entry. */
export type RegisterAction =
  | {
      id: string;
      entryId: string;
      action: 'detach';
      by: Batch['createdBy'];
      at: string;
      details: { persistentId: string | null; sourceKey: string };
    }
  | {
      id: string;
      entryId: string;
      action: 'accept';
      by: Batch['createdBy'];
      at: string;
      details: { changed: ChangedComponent[] };
    };

export interface NewBatch {
  targetId: string;
  force: boolean;
  createdBy: Batch['createdBy'];
}

/** An uploaded file, stored already under `objectKey`. */
export type NewItem = Pick<
  Item,
  'id' | 'batchId' | 'sourceKey' | 'filename' | 'contentSha256' | 'sizeBytes' | 'objectKey'
>;

export type AddItemResult =
  { ok: true; item: Item } | { ok: false; reason: 'missing' | 'not_open' | 'duplicate' };

export type StartBatchResult =
  | { ok: true; batch: Batch; jobIds: string[] }
  | { ok: false; reason: 'missing' | 'not_open' | 'empty' };

export type DiscardBatchResult =
  { ok: true; objectKeys: string[] } | { ok: false; reason: 'missing' | 'not_open' };

/** Every outcome at zero. */
export function emptyCounts(): ItemCounts {
  return Object.fromEntries(ITEM_OUTCOMES.map((o) => [o, 0])) as ItemCounts;
}

/** The acting user as a batch records them: `{id, name}`, null parts without access control. */
export const batchCreator = (by: Creator | null): Batch['createdBy'] => ({
  id: by?.userId ?? null,
  name: by?.name ?? null,
});
