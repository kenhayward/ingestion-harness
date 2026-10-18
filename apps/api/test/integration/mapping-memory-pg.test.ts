/**
 * Opt-in Postgres integration test for PgMappingMemoryRepo (migration
 * 202610181509_mapping_memory): the shared contract. Skipped unless IH_TEST_DATABASE_URL points
 * at a THROWAWAY database: it applies db/migrations and empties `mapping_memory` there. See
 * workbench-pg.test.ts for how to start one.
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, describe } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { PgMappingMemoryRepo } from '../../src/mapping-memory/pg.js';
import { mappingMemoryContract } from '../mapping-memory-contract.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('PgMappingMemoryRepo', { timeout: 60_000 }, () => {
  let pool: pg.Pool | undefined;
  afterAll(async () => {
    await pool?.end();
  });

  mappingMemoryContract('pg', async () => {
    if (!pool) {
      await migrate(url!, migrations);
      pool = new pg.Pool({ connectionString: url, max: 5 });
    }
    await pool.query('DELETE FROM mapping_memory');
    return new PgMappingMemoryRepo(pool);
  });
});
