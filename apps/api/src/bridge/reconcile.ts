import { randomUUID } from 'node:crypto';
import { bridgeError, type BridgeError } from '@ih/bridge-contract';
import type { PublishTargetRepo } from '../publish-targets/repo.js';
import { FINAL_DELIVERY, type IngestionRepo } from '../repositories/types.js';
import type { BridgeApi } from './client.js';
import { applyEvent } from './events.js';
import { applyRegisterEvent } from './register.js';

/** A delivery not heard of for this long is asked about. */
export const STRAGGLER_MINUTES = 10;

/**
 * A register entry the worker left `pending` without recording a delivery is failed after this
 * long. Safe in the usual case: a later run reuses the same idempotency key, which the sink
 * recognises, so a delivery the bridge did take finds its document rather than making another.
 * The exception is a forced create, whose key carried a fresh token: there the sink cannot tell
 * the two apart, so a second document is possible.
 */
export const UNRECORDED_MINUTES = 30;

/** Not a bridge error code: the API's own, for an entry the bridge was never known to take. */
const NOT_RECORDED: BridgeError = {
  class: 'retryable',
  code: 'not_recorded',
  message: 'the delivery was never recorded',
};

/**
 * So a lost event cannot strand a job: every unfinished delivery not updated for ten minutes is
 * read from the bridge, and applied as the next event when the bridge has moved it on. A bridge
 * that cannot answer is asked again next time. A delivery the bridge has no record of (its data
 * lost or restored) will never get an event, so it fails, which finishes its job the normal way.
 * Register entries stuck `pending` are settled the same way (`reconcileRegister`). Returns how
 * many deliveries and entries were moved on.
 */
export async function reconcileOnce(
  deps: { repo: IngestionRepo; bridge: BridgeApi; targets: PublishTargetRepo },
  now: Date,
): Promise<number> {
  let moved = 0;
  for (const d of await deps.repo.stragglers(STRAGGLER_MINUTES, now)) {
    let view;
    try {
      view = await deps.bridge.getDelivery(d.deliveryId);
    } catch {
      continue;
    }
    if (view?.status === d.status) continue;
    const applied = await applyEvent(deps, {
      eventId: randomUUID(),
      deliveryId: d.deliveryId,
      sequence: d.lastSequence + 1,
      ...(view
        ? { status: view.status, error: view.error, receipt: view.receipt }
        : {
            status: 'failed' as const,
            error: bridgeError('not_found', 'the bridge has no record of this delivery'),
            receipt: null,
          }),
      at: now.toISOString(),
    });
    if (applied === 'applied') moved += 1;
  }
  moved += await reconcileRegister(deps, now);
  return moved;
}

/**
 * The same for the decomposition register: an entry still `pending` on a delivery not heard of
 * for ten minutes (a decomposition delivered without a job has no job delivery to reconcile) is
 * settled from the bridge's view once that is final, or failed when the bridge has no record of
 * it. A delivery a job also waits on settles its job's row through the loop above; only the
 * register is settled here. An entry without a delivery is the worker's still, until
 * UNRECORDED_MINUTES pass: then it is failed (`not_recorded`).
 */
async function reconcileRegister(
  deps: { repo: IngestionRepo; bridge: BridgeApi },
  now: Date,
): Promise<number> {
  let moved = await deps.repo.expireUnrecordedRegisterEntries(
    UNRECORDED_MINUTES,
    now,
    NOT_RECORDED,
  );
  for (const entry of await deps.repo.registerStragglers(STRAGGLER_MINUTES, now)) {
    const deliveryId = entry.deliveryId!;
    let view;
    try {
      view = await deps.bridge.getDelivery(deliveryId);
    } catch {
      continue;
    }
    if (view && !FINAL_DELIVERY.has(view.status)) continue;
    const settled = await applyRegisterEvent(deps.repo, {
      eventId: randomUUID(),
      deliveryId,
      sequence: 1,
      ...(view
        ? { status: view.status, error: view.error, receipt: view.receipt }
        : {
            status: 'failed' as const,
            error: bridgeError('not_found', 'the bridge has no record of this delivery'),
            receipt: null,
          }),
      at: now.toISOString(),
    });
    if (settled === 'applied') moved += 1;
  }
  return moved;
}
