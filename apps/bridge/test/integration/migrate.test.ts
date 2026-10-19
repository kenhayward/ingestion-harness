import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { migrateBridge } from '../../src/db/migrate.js';
import { migrations, url } from './db.js';

describe.skipIf(!url)('migrateBridge', () => {
  const pool = new pg.Pool({ connectionString: url });
  afterAll(() => pool.end());

  it('applies its migrations once, into the bridge schema only', async () => {
    await pool.query('DROP SCHEMA IF EXISTS bridge CASCADE');
    expect(await migrateBridge(url!, migrations)).toEqual(['202610191200_bridge_core.sql']);
    expect(await migrateBridge(url!, migrations)).toEqual([]);
    const tables = await pool.query<{ found: string | null; publicCopy: string | null }>(
      `SELECT to_regclass('bridge.deliveries')::text AS found,
              to_regclass('public.deliveries')::text AS "publicCopy"`,
    );
    expect(tables.rows[0]).toEqual({ found: 'bridge.deliveries', publicCopy: null });
    const recorded = await pool.query('SELECT filename FROM bridge.schema_migrations');
    expect(recorded.rows).toEqual([{ filename: '202610191200_bridge_core.sql' }]);
  });
});
