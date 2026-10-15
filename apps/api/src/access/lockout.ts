/**
 * ADR 0013, D3: the 10th consecutive failed sign-in locks the account for 15 minutes, each one
 * after it (possible only once a lock has run out) doubles the lock (at most 24 h), and the 20th
 * disables the account until an admin enables it.
 */
export const LOCK_AFTER = 10;
export const DISABLE_AFTER = 20;
export const FIRST_LOCK_MS = 15 * 60_000;
export const MAX_LOCK_MS = 24 * 3_600_000;

/** What a failure that brings the count to `failures` does: nothing, lock for N ms, or disable. */
export function lockFor(failures: number): number | 'disable' | null {
  if (failures >= DISABLE_AFTER) return 'disable';
  if (failures < LOCK_AFTER) return null;
  return Math.min(FIRST_LOCK_MS * 2 ** (failures - LOCK_AFTER), MAX_LOCK_MS);
}
