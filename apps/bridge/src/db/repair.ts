/** Postgres: undefined_table. */
const UNDEFINED_TABLE = '42P01';

/**
 * A loop tick that puts the bridge's schema back when it is gone: CT Studio's restore swaps the
 * whole database, and a backup from before the bridge has no `bridge` schema. `repair` runs the
 * bridge's migrations (and seeds what they need), then the next tick carries on; the tick that
 * found the schema missing reports no work done.
 */
export function withSchemaRepair(
  tick: () => Promise<boolean>,
  repair: () => Promise<void>,
): () => Promise<boolean> {
  return async () => {
    try {
      return await tick();
    } catch (err) {
      if ((err as { code?: string }).code !== UNDEFINED_TABLE) throw err;
      await repair();
      return false;
    }
  };
}
