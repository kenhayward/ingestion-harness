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

  it('reads the published graphs under a base and the newest event', async () => {
    await pool.query('DELETE FROM published_graphs');
    const base = 'https://data.acme.example/ct/';
    expect(await repo.graphStatus(base)).toMatchObject({ published: 0, lastPublishedAt: null });
    await pool.query(
      `INSERT INTO published_graphs (sha256, template_id, graph_iri, version, job_id,
         document_id, template_version, base_iri, triples, published_at)
       VALUES ('ab', 'demo', $1, 1, gen_random_uuid(), gen_random_uuid(), 1, $2, 5,
               '2026-10-14T10:00:00Z'),
              ('cd', 'demo', $1, 1, gen_random_uuid(), gen_random_uuid(), 1, 'https://old.example/', 5,
               '2026-10-14T11:00:00Z')`,
      [`${base}graph/source/ab/demo`, base],
    );
    const status = await repo.graphStatus(base);
    expect(status.published).toBe(1);
    expect(status.lastPublishedAt).toBe('2026-10-14T10:00:00.000Z');
    await pool.query('DELETE FROM published_graphs');
  });
});
