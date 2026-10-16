/**
 * Opt-in Postgres integration test for PgGitHubSyncRepo (migration 0046): the shared contract.
 * Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY database: it applies db/migrations and
 * empties the sync tables there. See workbench-pg.test.ts for how to start one.
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, describe } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { PgGitHubSyncRepo } from '../../src/github-sync/pg.js';
import { PgTemplateRepo } from '../../src/templates/repo.js';
import { githubSyncContract } from '../github-sync-contract.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('PgGitHubSyncRepo', { timeout: 60_000 }, () => {
  let pool: pg.Pool | undefined;
  afterAll(async () => {
    await pool?.end();
  });

  githubSyncContract('pg', async () => {
    if (!pool) {
      await migrate(url!, migrations);
      pool = new pg.Pool({ connectionString: url, max: 5 });
    }
    await pool.query(
      'TRUNCATE github_sync_settings, template_github_links, template_github_pushes',
    );
    await pool.query("DELETE FROM templates WHERE id = 'invoice_gh' AND status = 'draft'");
    return { repo: new PgGitHubSyncRepo(pool), templates: new PgTemplateRepo(pool) };
  });
});
