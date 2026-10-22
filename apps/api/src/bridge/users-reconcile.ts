import type { BridgeApi } from './client.js';

export interface UsersReconcileDeps {
  users: { listUsers(): Promise<{ id: string; disabledReason: string | null }[]> };
  bridge: Pick<BridgeApi, 'reconcileUsers'>;
  log: { info(o: object, msg: string): void; warn(o: object, msg: string): void };
}

/**
 * Tells the bridge who is still here, so the personal connections of anyone else are deleted:
 * a user an admin disabled (whose own deletion at the disable may not have reached the bridge),
 * or one the bridge knows from another deployment's backup. A user disabled by failed sign-ins
 * keeps theirs: the account was attacked, not removed. Never sends an empty list.
 */
export async function reconcileUsersOnce(deps: UsersReconcileDeps): Promise<void> {
  try {
    const live = (await deps.users.listUsers())
      .filter((u) => u.disabledReason !== 'admin')
      .map((u) => u.id);
    if (!live.length) return;
    const deleted = await deps.bridge.reconcileUsers(live);
    if (deleted) deps.log.info({ deleted }, 'personal connections of removed users deleted');
  } catch (err) {
    deps.log.warn({ err }, 'personal connection reconcile failed');
  }
}
