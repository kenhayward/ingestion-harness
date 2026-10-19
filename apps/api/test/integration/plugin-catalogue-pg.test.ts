/**
 * Opt-in Postgres test of the plugin catalogue read (recipe plugins 3b): the rows the worker
 * publishes (worker/tests/test_plugin_catalogue.py writes them the same way) come back as
 * `PluginInfo`. Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY database (it applies
 * db/migrations and rewrites plugin_catalogue):
 *   IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres \
 *     npx vitest run --config apps/api/vitest.integration.config.ts plugin-catalogue-pg
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { PluginInfo } from '@ih/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { PgPluginCatalogue } from '../../src/plugins/catalogue.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));
const fixture = JSON.parse(
  readFileSync(
    new URL('../../../../packages/shared/test/fixtures/plugin-catalogue.json', import.meta.url),
    'utf8',
  ),
) as { plugins: PluginInfo[] };

describe.skipIf(!url)('plugin catalogue against Postgres', { timeout: 30_000 }, () => {
  let pool: pg.Pool;

  beforeAll(async () => {
    await migrate(url!, migrations);
    pool = new pg.Pool({ connectionString: url, max: 2 });
  });
  afterAll(async () => {
    await pool?.query('DELETE FROM plugin_catalogue');
    await pool?.end();
  });

  it('reads back what the worker publishes, by ref', async () => {
    await pool.query('DELETE FROM plugin_catalogue');
    for (const p of [...fixture.plugins].reverse()) {
      await pool.query(
        `INSERT INTO plugin_catalogue (ref, plugin_id, major, summary, egress, settings_schema)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [p.ref, p.id, p.major, p.summary, p.egress, JSON.stringify(p.settingsSchema)],
      );
    }
    expect(await new PgPluginCatalogue(pool).list()).toEqual(fixture.plugins);
  });

  it('refuses a ref that does not name its plugin and major', async () => {
    const p = fixture.plugins[0]!;
    await expect(
      pool.query(
        `INSERT INTO plugin_catalogue (ref, plugin_id, major, summary, egress, settings_schema)
         VALUES ('other@9', $1, $2, $3, $4, '{}')`,
        [p.id, p.major, p.summary, p.egress],
      ),
    ).rejects.toThrow(/check/);
  });
});
