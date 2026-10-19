import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { migrateBridge } from '../../src/db/migrate.js';

/** A THROWAWAY database: the tests drop and recreate the `bridge` schema there. */
export const url = process.env.IH_TEST_DATABASE_URL;
export const migrations = fileURLToPath(
  new URL('../../../../db/bridge-migrations', import.meta.url),
);

/** A fresh `bridge` schema with every migration applied, and a pool on it. */
export async function freshBridge(): Promise<pg.Pool> {
  const pool = new pg.Pool({ connectionString: url, max: 12 });
  await pool.query('DROP SCHEMA IF EXISTS bridge CASCADE');
  await migrateBridge(url!, migrations);
  return pool;
}
