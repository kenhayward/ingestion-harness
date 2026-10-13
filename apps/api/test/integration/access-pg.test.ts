/**
 * Opt-in Postgres integration test for PgAccessRepo (issued admin tokens, migration 0021).
 *
 * Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY database: it applies db/migrations
 * and rotates the admin token there. See workbench-pg.test.ts for how to start one.
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgAccessRepo } from '../../src/access/pg.js';
import { migrate } from '../../src/db/migrate.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('access tokens against Postgres', { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  let repo: PgAccessRepo;

  beforeAll(async () => {
    await migrate(url!, migrations);
    pool = new pg.Pool({ connectionString: url, max: 3 });
    repo = new PgAccessRepo(pool);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('keeps issued admin tokens across restarts; only the log token is protected', async () => {
    await repo.rotateAdminToken();
    const { token, record } = await repo.createToken('Ops laptop', 90, {
      role: 'admin',
      issuedBy: 'admin',
    });
    expect(record).toMatchObject({ role: 'admin', status: 'active', issuedBy: 'admin' });
    const { sessionId } = (await repo.login(token))!;

    await repo.rotateAdminToken();
    expect(await repo.session(sessionId)).toMatchObject({ role: 'admin', label: 'Ops laptop' });
    const tokens = await repo.listTokens();
    const bootstrap = tokens.filter((t) => t.status === 'current-admin');
    expect(bootstrap).toHaveLength(1);
    expect(tokens.find((t) => t.id === record.id)?.status).toBe('active');

    expect(await repo.revokeToken(bootstrap[0]!.id)).toBe('admin');
    expect(await repo.revokeToken(record.id)).toBe('ok');
    expect(await repo.session(sessionId)).toBeNull();
    expect(await repo.deleteToken(record.id)).toBe('ok');
  });

  it('refuses an admin token that never expires, in the repo and in the table', async () => {
    await expect(repo.createToken('forever', null, { role: 'admin' })).rejects.toThrow(
      'admin tokens must expire',
    );
    await expect(
      pool.query(
        `INSERT INTO access_tokens (label, role, token_hash) VALUES ('raw', 'admin', 'x-' || gen_random_uuid())`,
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
