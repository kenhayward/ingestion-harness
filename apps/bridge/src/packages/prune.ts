import type { DeliveryRepo } from '../deliveries/repo.js';
import type { PackageStore } from './store.js';

/**
 * Deletes the staged bytes of packages past their retention (`BRIDGE_PACKAGE_RETENTION_DAYS`)
 * whose deliveries are all final: only the runner reads them, and only for a delivery still on
 * its way. Returns how many it pruned (at most `limit`).
 */
export async function prunePackagesOnce(
  deps: { deliveries: DeliveryRepo; packages: PackageStore },
  now: Date,
  limit = 50,
): Promise<number> {
  const expired = await deps.deliveries.expiredPackages(now, limit);
  for (const p of expired) {
    await deps.packages.delete(p.stagedKey);
    await deps.deliveries.markPruned(p.id, now);
  }
  return expired.length;
}
