/**
 * Opt-in Postgres integration test for PgMaintenanceRepo (migration 0046), matching the memory
 * adapter: `since` set when switched on, kept while on, cleared when off; the message kept.
 *
 * Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY database: it applies db/migrations
 * and rewrites the `maintenance` row there. See workbench-pg.test.ts for how to start one.
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import {
  MemoryMaintenanceRepo,
  PgMaintenanceRepo,
  type MaintenanceRepo,
} from '../../src/maintenance/repo.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('PgMaintenanceRepo', { timeout: 60_000 }, () => {
  let pool: pg.Pool | undefined;
  afterAll(async () => {
    await pool?.end();
  });

  const pgRepo = async () => {
    if (!pool) {
      await migrate(url!, migrations);
      pool = new pg.Pool({ connectionString: url, max: 2 });
    }
    const repo = new PgMaintenanceRepo(pool);
    await repo.set({ enabled: false, message: '' }, null);
    return repo;
  };

  it.each([
    ['memory', async (): Promise<MaintenanceRepo> => new MemoryMaintenanceRepo()],
    ['pg', pgRepo],
  ])('%s: on, edited, off', async (_name, make) => {
    const repo = await make();
    const on = await repo.set({ enabled: true, message: 'Deploying' }, 'Ken');
    expect(on).toMatchObject({ enabled: true, message: 'Deploying', updatedBy: 'Ken' });
    expect(on.since).toEqual(expect.any(String));
    const edited = await repo.set({ enabled: true, message: 'Back at 3' }, 'Ken');
    expect(edited.since).toBe(on.since);
    const off = await repo.set({ enabled: false, message: 'Back at 3' }, 'Ann');
    expect(off).toMatchObject({
      enabled: false,
      since: null,
      message: 'Back at 3',
      updatedBy: 'Ann',
    });
    expect(await repo.get()).toEqual(off);
  });
});
