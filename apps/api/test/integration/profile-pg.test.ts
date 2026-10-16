/**
 * Opt-in Postgres integration test for PgProfileRepo (migration 0044): the shared profile
 * contract. Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY database: it applies
 * db/migrations and empties `users` there. See workbench-pg.test.ts for how to start one.
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, describe } from 'vitest';
import { PgAccessRepo } from '../../src/access/pg.js';
import { migrate } from '../../src/db/migrate.js';
import { PgProfileRepo } from '../../src/profile/pg.js';
import { profileContract } from '../profile-contract.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('PgProfileRepo', { timeout: 60_000 }, () => {
  let pool: pg.Pool | undefined;
  afterAll(async () => {
    await pool?.end();
  });

  profileContract(
    'pg',
    async () => {
      if (!pool) {
        await migrate(url!, migrations);
        pool = new pg.Pool({ connectionString: url, max: 5 });
      }
      await pool.query('TRUNCATE users CASCADE');
      const access = new PgAccessRepo(pool);
      const user = async (name: string) => {
        const created = await access.createUser(
          { name, email: `${name}@example.com`, role: 'designer' },
          null,
        );
        if (typeof created === 'string') throw new Error(created);
        return created.user.id;
      };
      return { repo: new PgProfileRepo(pool), ken: await user('ken'), ada: await user('ada') };
    },
    { clock: false },
  );
});
