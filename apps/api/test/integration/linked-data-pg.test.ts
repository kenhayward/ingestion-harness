/**
 * Opt-in Postgres test for PgLinkedDataRepo (migration 0034). Skipped unless
 * IH_TEST_DATABASE_URL points at a THROWAWAY database: it applies db/migrations and empties the
 * linked data tables.
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { PgLinkedDataRepo } from '../../src/linked-data/repo.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('linked data settings against Postgres', { timeout: 30_000 }, () => {
  let pool: pg.Pool;
  let repo: PgLinkedDataRepo;

  beforeAll(async () => {
    await migrate(url!, migrations);
    pool = new pg.Pool({ connectionString: url, max: 3 });
    repo = new PgLinkedDataRepo(pool);
    await pool.query('DELETE FROM linked_data_settings');
    await pool.query('DELETE FROM linked_data_base_history');
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('seeds once, saves, and records base changes', async () => {
    expect(await repo.get()).toMatchObject({ customerSlug: null, baseIri: null });
    await repo.seed({ customerName: 'Acme', customerSlug: 'acme', baseIri: null });
    await repo.seed({ customerName: 'Other', customerSlug: 'other', baseIri: null });
    expect(await repo.get()).toMatchObject({ customerName: 'Acme', updatedBy: '.env' });
    await repo.save(
      { customerName: 'Acme', customerSlug: 'acme', baseIri: 'https://data.acme.example/ct/' },
      'Ken',
    );
    await repo.save(
      {
        customerName: 'Acme Pharma',
        customerSlug: 'acme',
        baseIri: 'https://data.acme.example/ct/',
      },
      'Ken',
    );
    const history = await repo.history();
    expect(history.map((h) => [h.fromBase, h.toBase])).toEqual([
      ['https://id.stocks-hayward.com/acme/', 'https://data.acme.example/ct/'],
      [null, 'https://id.stocks-hayward.com/acme/'],
    ]);
    expect(await repo.rdfPublishedCount()).toBe(0);
    await expect(
      pool.query(`INSERT INTO linked_data_settings (id) VALUES (false)`),
    ).rejects.toThrow();
  });
});
