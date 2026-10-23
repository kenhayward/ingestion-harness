import type { BridgeEvent } from '@ih/bridge-contract';
import type { PublishTargetRepo } from '../publish-targets/repo.js';
import {
  FINAL_DELIVERY,
  type IngestionRepo,
  type JobDelivery,
  type JobFinish,
} from '../repositories/types.js';
import { applyRegisterEvent } from './register.js';

/** Refusals a person settles with their connection on the bridge's page. */
export const CONNECTION_CODES: ReadonlySet<string> = new Set([
  'connection_missing',
  'credential_missing',
  'credential_rejected',
  'credential_mfa_required',
]);

/**
 * How a delivering job ends, once every delivery is final: succeeded when all succeeded or were
 * skipped; back to review when any needs a person (`<target label>: <message>` each); otherwise
 * failed, naming the target. Null while any delivery is still on its way.
 */
export function finishOf(
  label: (targetId: string) => string,
): (deliveries: JobDelivery[]) => JobFinish | null {
  return (deliveries) => {
    if (deliveries.length === 0 || deliveries.some((d) => !FINAL_DELIVERY.has(d.status))) {
      return null;
    }
    const said = (d: JobDelivery, fallback: string) =>
      `${label(d.targetId)}: ${d.error?.message ?? fallback}`;
    const needs = deliveries.filter((d) => d.status === 'needs_user');
    if (needs.length > 0) {
      return {
        status: 'awaiting_review',
        reasons: needs.map((d) => said(d, 'needs attention')),
        connectionNeeded: needs.some((d) => CONNECTION_CODES.has(d.error?.code ?? '')),
      };
    }
    const failed = deliveries.filter((d) => d.status === 'failed');
    if (failed.length > 0) {
      return { status: 'failed', error: failed.map((d) => said(d, 'delivery failed')).join('; ') };
    }
    return { status: 'succeeded', targets: deliveries.map((d) => d.targetId) };
  };
}

/**
 * Records one of the bridge's delivery events (signed, at least once, maybe out of order): only
 * an event newer than the delivery's last one, for a delivery not final yet, counts, and the job
 * finishes once, when its last
 * delivery is final and it is still delivering. A final event also settles the decomposition
 * register entry the delivery was made for (`register.ts`). `unknown`: no such delivery here yet
 * (the worker may not have recorded it), so the bridge should send it again later.
 */
export async function applyEvent(
  deps: { repo: IngestionRepo; targets: PublishTargetRepo },
  e: BridgeEvent,
): Promise<'applied' | 'stale' | 'unknown'> {
  const labels = new Map((await deps.targets.list()).map((t) => [t.id, t.label]));
  const { outcome } = await deps.repo.applyDeliveryUpdate(
    e.deliveryId,
    { status: e.status, error: e.error, receipt: e.receipt, sequence: e.sequence },
    finishOf((id) => labels.get(id) ?? id),
  );
  // A stale non-final event changes nothing anywhere. A final one still reaches the register,
  // whose pending-only settle makes a repeat harmless, so a resend heals a register write that
  // failed after the job's delivery was recorded.
  if (outcome === 'stale' && !FINAL_DELIVERY.has(e.status)) return outcome;
  const registered = await applyRegisterEvent(deps.repo, e);
  // A decomposition delivered without a job is known to the register alone.
  return outcome === 'unknown' ? registered : outcome;
}
