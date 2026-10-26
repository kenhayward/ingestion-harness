import {
  ITEM_OUTCOMES,
  type Batch,
  type BatchSummary,
  type ChangedComponent,
  type Creator,
  type Item,
  type ItemCounts,
} from '@ih/shared';
import { isDocumentMissing } from '@ih/bridge-contract';
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
   * stored under the new ids). With `of` locked, refused (`running`) while an earlier rerun of
   * it is unfinished, so a repeated request makes one batch.
   */
  rerunItem(rerun: Rerun): Promise<RerunResult>;
  /**
   * Re-run failed items (the Conversion tab's *Re-run failed*): one new batch, started at once,
   * holding a new item per item asked, in order, each under its item's source key with its
   * stored file and `redeliverOf` it, a `decompose` job each, all at once. With the items locked,
   * refused (`running`, naming the first) while an earlier rerun of any of them is unfinished,
   * so a repeated request makes one batch, and (`already_rerun`, naming the first) once any of
   * them was run again at all (`Item.rerunIn`): an item is re-run once, and a failed re-run is
   * re-run from its own batch.
   */
  retryItems(retry: Retry): Promise<RetryResult>;
  /** A decomposition register entry by id. */
  registerEntry(id: string): Promise<RegisterEntry | null>;
  /**
   * Detach (spec §8): records `register_actions{action: 'detach'}` and leaves the entry a
   * `detached` tombstone naming that action, and sets the item's detail, all at once. Refused
   * (`pending`) while a delivery for the entry is in flight, or a run of its source to a target
   * on its tenant is unfinished (a rerun queued, say); `missing` when it is gone or detached
   * already; `not_refused` unless it is `changed`, unversioned (`isUnversioned`) or gone from
   * the target (`isGone`), so a live document is never detached.
   */
  detachRegisterEntry(detach: Detach): Promise<DetachResult>;
  /**
   * Accept the target's state (spec §8, ruling R5): with the entry locked, refused (`stale`)
   * unless it is as the preview showed it (`seen`, its `updatedAt`), then `plan` decides. When it
   * can be accepted the entry's last receipt takes the plan's components and the entry becomes
   * `accepted` (the next run is an update), `register_actions{action: 'accept'}` records it and
   * the item takes `detail`.
   */
  acceptTargetState(accept: Accept): Promise<AcceptResult>;
}

export interface Detach {
  itemId: string;
  entryId: string;
  /**
   * The targets on the entry's tenant (its sink and instance): a run of the same source key to
   * any of them holds the detach off.
   */
  targetIds: string[];
  by: Batch['createdBy'];
  /** Why, when a row action detaches on the way (reload: `gone`), recorded in the details. */
  reason?: 'gone';
  detail: (entry: RegisterEntry) => string;
}

export interface Accept {
  itemId: string;
  entryId: string;
  /** The entry's `updatedAt` as the preview showed it. */
  seen: string;
  by: Batch['createdBy'];
  plan: (entry: RegisterEntry) => AcceptPlan;
  detail: (entry: RegisterEntry) => string;
}

export type RerunResult =
  { ok: true; batch: Batch; item: Item } | { ok: false; reason: 'running' | 'not_detached' };

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
  /**
   * Whether the batch is forced (default true: force-load and redeliver). Reload reruns as a
   * plain create (false): after its detach, that makes a new document.
   */
  force?: boolean;
  /**
   * A register entry that must still be a detached tombstone (reload): checked with the batch
   * insert, in one transaction, refused `not_detached` when a create replaced it meanwhile.
   */
  whileDetached?: string;
}

export interface Retry {
  /** The new batch's id. */
  batchId: string;
  /** Each item re-run, with its new item's id. */
  items: { itemId: string; of: Item }[];
  targetId: string;
  /** Deliver as an explicit update (force-load). */
  force: boolean;
  createdBy: Batch['createdBy'];
  /** Who queues the jobs. */
  by: Creator | null;
}

export type RetryResult =
  | { ok: true; batch: Batch; items: Item[] }
  | { ok: false; reason: 'running' | 'already_rerun'; itemId: string };

export type DetachResult =
  | { ok: true; entry: RegisterEntry; item: Item }
  | { ok: false; reason: 'missing' | 'pending' | 'not_refused' };

export type AcceptResult =
  | { ok: true; item: Item; changed: ChangedComponent[] }
  | { ok: false; reason: 'missing' | 'stale' }
  | { ok: false; reason: 'not_acceptable'; why: string };

/**
 * An entry whose document's component versions were never recorded (`Item.unversioned`): it
 * has a persistent id and no components in its last receipt, and is neither pending (a run is
 * on its way) nor detached. Detach takes it as it takes a `changed` one.
 */
export const isUnversioned = (
  entry: Pick<RegisterEntry, 'state' | 'persistentId' | 'lastReceipt'>,
): boolean =>
  entry.persistentId !== null &&
  entry.state !== 'pending' &&
  entry.state !== 'detached' &&
  !entry.lastReceipt?.document?.components.length;

/**
 * An entry gone from the target (`Item.gone`, owner's call 2026-10-26): it has a persistent id
 * and failed because the sink refused its update with the missing-document marker for that very
 * document (`isDocumentMissing`: `not_found`, details `reason: document_missing` and
 * `persistentId`). Any other `not_found` (a delivery the bridge lost, no route, no sink job)
 * says nothing about the document. Its updates can never go through: detach takes it, and
 * reload loads it as new.
 */
export const isGone = (
  entry: Pick<RegisterEntry, 'state' | 'persistentId' | 'lastError'>,
): boolean => entry.state === 'failed' && isDocumentMissing(entry.lastError, entry.persistentId);

/**
 * Whether reload applies (`Item.reloadable`): the entry is gone or still the detached tombstone,
 * and the row is not superseded.
 */
export const isReloadable = (gone: boolean, detached: boolean, resolution: Item['resolution']) =>
  (gone || detached) && resolution !== 'superseded';

/** The item outcomes of a run not finished yet. */
export const RUNNING_OUTCOMES: readonly Item['outcome'][] = ['queued', 'decomposing', 'delivering'];

/** One row of `register_actions`: what a person did to a register entry. */
export type RegisterAction =
  | {
      id: string;
      entryId: string;
      action: 'detach';
      by: Batch['createdBy'];
      at: string;
      details: { persistentId: string | null; sourceKey: string; reason?: 'gone' };
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
