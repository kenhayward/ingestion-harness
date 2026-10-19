import { randomUUID } from 'node:crypto';
import type { PublishTargetRepo } from '../publish-targets/repo.js';
import type { IngestionRepo } from '../repositories/types.js';
import type { BridgeApi } from './client.js';
import { applyEvent } from './events.js';

/** A delivery not heard of for this long is asked about. */
export const STRAGGLER_MINUTES = 10;

/**
 * So a lost event cannot strand a job: every unfinished delivery not updated for ten minutes is
 * read from the bridge, and applied as the next event when the bridge has moved it on. A bridge
 * that cannot answer is asked again next time. Returns how many deliveries were moved on.
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
    if (!view || view.status === d.status) continue;
    const applied = await applyEvent(deps, {
      eventId: randomUUID(),
      deliveryId: d.deliveryId,
      sequence: d.lastSequence + 1,
      status: view.status,
      error: view.error,
      receipt: view.receipt,
      at: now.toISOString(),
    });
    if (applied === 'applied') moved += 1;
  }
  return moved;
}
