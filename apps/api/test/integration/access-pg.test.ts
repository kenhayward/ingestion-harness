/**
 * Opt-in Postgres integration test for PgAccessRepo (users, migration 0040): the shared access
 * contract plus the concurrency the memory adapter cannot show.
 *
 * Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY database: it applies db/migrations
 * and empties `users` there. See workbench-pg.test.ts for how to start one.
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { PgAccessRepo } from '../../src/access/pg.js';
import { LOCK_AFTER } from '../../src/access/repo.js';
import { migrate } from '../../src/db/migrate.js';
import { accessContract } from '../access-contract.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('PgAccessRepo', { timeout: 60_000 }, () => {
  let pool: pg.Pool | undefined;
  const make = async () => {
    if (!pool) {
      await migrate(url!, migrations);
      pool = new pg.Pool({ connectionString: url, max: 10 });
    }
    await pool.query('TRUNCATE users CASCADE');
    return new PgAccessRepo(pool);
  };
  afterAll(async () => {
    await pool?.end();
  });

  accessContract('pg', make, { clock: false });

  it('parallel wrong guesses count to exactly 10, lock once, and the right one is then refused', async () => {
    const repo = await make();
    await repo.rotateAdminPassword();
    const created = await repo.createUser({ name: 'P', email: 'p@example.com', role: 'user' }, null);
    if (typeof created === 'string') throw new Error(created);
    const tries = await Promise.all(
      Array.from({ length: LOCK_AFTER + 5 }, () => repo.login('p@example.com', 'wrong')),
    );
    expect(tries.filter((r) => r.kind === 'invalid' && r.locked !== null)).toHaveLength(1);
    expect(tries.filter((r) => r.kind === 'invalid' && r.failures !== null)).toHaveLength(
      LOCK_AFTER,
    );
    expect((await repo.listUsers()).find((u) => u.email === 'p@example.com')?.failedSignIns).toBe(
      LOCK_AFTER,
    );
    expect((await repo.login('p@example.com', created.password)).kind).toBe('locked');
  });

  it('a right password racing the 10th wrong one never opens a session after the lock', async () => {
    const repo = await make();
    await repo.rotateAdminPassword();
    const created = await repo.createUser({ name: 'Q', email: 'q@example.com', role: 'user' }, null);
    if (typeof created === 'string') throw new Error(created);
    for (let i = 0; i < LOCK_AFTER - 1; i++) await repo.login('q@example.com', 'wrong');
    const [wrong, right] = await Promise.all([
      repo.login('q@example.com', 'wrong'),
      repo.login('q@example.com', created.password),
    ]);
    // Either the right one won (count reset, the wrong one counted 1) or the lock won (refused).
    if (right.kind === 'ok') expect(wrong).toMatchObject({ kind: 'invalid', locked: null });
    else expect(right.kind).toBe('locked');
  });

  it('the database refuses a second admin from the log', async () => {
    const repo = await make();
    await repo.rotateAdminPassword();
    await repo.rotateAdminPassword();
    const { rows } = await pool!.query('SELECT count(*)::int AS n FROM users WHERE bootstrap');
    expect(rows[0].n).toBe(1);
  });
});
