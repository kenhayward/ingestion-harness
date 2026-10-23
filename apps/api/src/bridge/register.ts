import type { BridgeEvent } from '@ih/bridge-contract';
import {
  FINAL_DELIVERY,
  type IngestionRepo,
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

/**
 * Settles the register entry a delivery was made for, from the delivery's final event. Only a
 * `pending` entry moves, so a repeated event, or one after the worker's next delivery, changes
 * nothing. `unknown`: no entry has this delivery (or the event is not final).
 */
export async function applyRegisterEvent(
  repo: IngestionRepo,
  e: BridgeEvent,
): Promise<'applied' | 'stale' | 'unknown'> {
  const settlement = settlementOf(e);
  if (!settlement) {
    return (await repo.registerEntryByDelivery(e.deliveryId)) ? 'stale' : 'unknown';
  }
  return repo.settleRegisterEntry(e.deliveryId, settlement);
}
