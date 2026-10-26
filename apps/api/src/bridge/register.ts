import { isDocumentMissing, type BridgeEvent, type Receipt } from '@ih/bridge-contract';
import { GONE_DETAIL, type ItemOutcome } from '@ih/shared';
import {
  FINAL_DELIVERY,
  type IngestionRepo,
  type ItemSettlement,
  type RegisterEntry,
  type RegisterSettlement,
} from '../repositories/types.js';

/**
 * How a delivery event settles its register entry (spec §8), or null for one not final yet:
 * - succeeded with a document receipt: `delivered`, or `incomplete` when its read-back failed;
 * - succeeded (or skipped) without one: `incomplete`, keeping the entry's persistent id;
 * - needs_user with `changed_in_target`: `changed`;
 * - any other final failure: `failed`, recording a persistent id its receipt reports.
 */
export function settlementOf(
  e: Pick<BridgeEvent, 'status' | 'error' | 'receipt'>,
): RegisterSettlement | null {
  if (!FINAL_DELIVERY.has(e.status)) return null;
  const document = e.receipt?.document;
  const reported = {
    persistentId: document?.persistentId ?? null,
    receipt: document ? e.receipt : null,
    error: e.error,
  };
  if (e.status === 'succeeded' || e.status === 'skipped') {
    return {
      ...reported,
      state: document?.readBack.ok ? 'delivered' : 'incomplete',
      delivered: document !== undefined,
    };
  }
  if (e.status === 'needs_user' && e.error?.code === 'changed_in_target') {
    return { ...reported, state: 'changed', delivered: false };
  }
  return { ...reported, state: 'failed', delivered: false };
}

/** The written kinds that are the document itself (a sink may name it a map). */
const DOCUMENT_KINDS: ReadonlySet<string> = new Set(['document', 'map']);

/**
 * The document's link in the target: the URL of the receipt's own entry for the document, a
 * written entry of kind `document` or `map`; of several, the one that is the receipt's map
 * component. Never another part's (a topic or an image): without one the item has no link.
 * Migration 202610261330 applies the same rule to items settled before it.
 */
export function linkOf(receipt: Receipt | null): string | null {
  const own = (receipt?.written ?? []).filter((w) => DOCUMENT_KINDS.has(w.kind) && w.url !== null);
  const maps = new Set(
    (receipt?.document?.components ?? []).filter((c) => c.kind === 'map').map((c) => c.id),
  );
  return (own.find((w) => maps.has(w.id)) ?? own[0])?.url ?? null;
}

/** How an item outcome reads in a job's events (worker `job.OUTCOME_LABELS`). */
export const OUTCOME_LABELS: Record<ItemOutcome, string> = {
  queued: 'queued',
  decomposing: 'decomposing',
  delivering: 'delivering',
  created: 'created',
  updated: 'updated',
  already_loaded: 'already loaded',
  duplicate: 'duplicate',
  in_flight: 'in flight',
  changed_in_target: 'changed in target',
  read_back_mismatch: 'read-back mismatch',
  unresolved: 'unresolved',
  failed: 'failed',
};

/** An outcome and its detail as one event message, e.g. `changed in target: …`. */
export function describeOutcome(outcome: ItemOutcome, detail: string | null): string {
  return detail ? `${OUTCOME_LABELS[outcome]}: ${detail}` : OUTCOME_LABELS[outcome];
}

/**
 * How a settled register entry settles the conversion item that delivered it (plan ruling R3):
 * - delivered: `updated` when the entry had a persistent id before this delivery (a document
 *   was replaced), else `created`, with the document's link;
 * - incomplete with a failed read-back: `read_back_mismatch`, naming where it differed;
 * - incomplete without a document receipt: `failed`, since nothing shows the document arrived;
 * - changed: `changed_in_target`; failed: `failed`, each with the bridge's message;
 * - failed with the sink's missing-document marker for the document it updated
 *   (`isDocumentMissing`): `unresolved`, the document gone from the target (deleted there,
 *   say), with `GONE_DETAIL` (owner's call, 2026-10-26). Any other `not_found` fails.
 */
export function itemSettlementOf(s: RegisterSettlement, before: RegisterEntry): ItemSettlement {
  const link = linkOf(s.receipt);
  const document = s.receipt?.document;
  if (s.state === 'delivered') {
    return {
      outcome: before.persistentId !== null ? 'updated' : 'created',
      detail: `document ${s.persistentId ?? before.persistentId}`,
      link,
    };
  }
  if (s.state === 'incomplete') {
    if (document && !document.readBack.ok) {
      const { at, detail } = document.readBack;
      return {
        outcome: 'read_back_mismatch',
        detail: `the target's copy differs at ${at ?? 'the document'}${detail ? `: ${detail}` : ''}`,
        link,
      };
    }
    return { outcome: 'failed', detail: 'the target reported no document for it', link };
  }
  if (s.state === 'changed') {
    return {
      outcome: 'changed_in_target',
      detail: s.error?.message ?? 'the document changed in the target',
      link,
    };
  }
  if (isDocumentMissing(s.error, before.persistentId)) {
    return { outcome: 'unresolved', detail: GONE_DETAIL, link };
  }
  return { outcome: 'failed', detail: s.error?.message ?? 'the delivery failed', link };
}

/**
 * Settles the register entry a delivery was made for, from the delivery's final event, and the
 * conversion item that made it (`itemSettlementOf`). Only a `pending` entry moves, so a repeated
 * event, or one after the worker's next delivery, changes nothing. `unknown`: no entry has this
 * delivery (or the event is not final).
 */
export async function applyRegisterEvent(
  repo: IngestionRepo,
  e: BridgeEvent,
): Promise<'applied' | 'stale' | 'unknown'> {
  const settlement = settlementOf(e);
  if (!settlement) {
    return (await repo.registerEntryByDelivery(e.deliveryId)) ? 'stale' : 'unknown';
  }
  return repo.settleRegisterEntry(e.deliveryId, settlement, (before) =>
    itemSettlementOf(settlement, before),
  );
}
