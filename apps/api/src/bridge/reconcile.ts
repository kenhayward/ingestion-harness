import { randomUUID } from 'node:crypto';
import { bridgeError } from '@ih/bridge-contract';
import type { PublishTargetRepo } from '../publish-targets/repo.js';
import { FINAL_DELIVERY, type IngestionRepo } from '../repositories/types.js';
import type { BridgeApi } from './client.js';
import { applyEvent } from './events.js';
import { applyRegisterEvent } from './register.js';

/** A delivery not heard of for this long is asked about. */
export const STRAGGLER_MINUTES = 10;

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
 * register is settled here. An entry without a delivery is the worker's still.
 */
async function reconcileRegister(
  deps: { repo: IngestionRepo; bridge: BridgeApi },
  now: Date,
): Promise<number> {
  let moved = 0;
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
