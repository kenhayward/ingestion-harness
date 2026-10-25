import {
  ITEM_OUTCOMES,
  type Batch,
  type BatchSummary,
  type Creator,
  type Item,
  type ItemCounts,
} from '@ih/shared';

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
}

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
