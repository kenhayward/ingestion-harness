/**
 * Opt-in: PgDatabaseTools against a real Postgres, with pg_dump and pg_restore on PATH (same or
 * newer major version). Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY server: it
 * creates, renames and drops databases named ih_bk_*. Example:
 *   docker run --rm -d --name ih-test-pg -e POSTGRES_PASSWORD=test -p 55433:5432 ih-postgres:pgvector
 *   IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres \
 *     npx vitest run --config apps/api/vitest.integration.config.ts backup-pg-tools
 */
import { Readable } from 'node:stream';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseUrl, PgDatabaseTools } from '../../src/backup/pg-tools.js';

const url = process.env.IH_TEST_DATABASE_URL;
const NAMES = ['ih_bk_live', 'ih_bk_side', 'ih_bk_previous'];

async function onDb<T>(name: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: databaseUrl(url!, name) });
  await c.connect();
  try {
    return await work(c);
  } finally {
    await c.end();
  }
}

const dropAll = () =>
  onDb('postgres', async (c) => {
    for (const n of NAMES) await c.query(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
  });

describe.skipIf(!url)('PgDatabaseTools (Postgres)', () => {
  beforeAll(async () => {
    await dropAll();
    await onDb('postgres', (c) => c.query('CREATE DATABASE ih_bk_live'));
    await onDb('ih_bk_live', async (c) => {
      await c.query('CREATE TABLE schema_migrations (filename text PRIMARY KEY)');
      await c.query(
        "INSERT INTO schema_migrations VALUES ('202610171218_b.sql'), ('0001_a.sql'), ('0049_c.sql')",
      );
      await c.query('CREATE TABLE things (id int, name text)');
      await c.query("INSERT INTO things VALUES (1, 'backed up')");
    });
  });
  afterAll(dropAll);

  it('dumps, restores into a side database and swaps it in, keeping the old one', async () => {
    const tools = new PgDatabaseTools(databaseUrl(url!, 'ih_bk_live'));
    expect(await tools.migrations()).toEqual(['0001_a.sql', '0049_c.sql', '202610171218_b.sql']);

    const { body, done } = await tools.dump();
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(c as Buffer);
    await done;
    const dump = Buffer.concat(chunks);
    expect(dump.subarray(0, 5).toString()).toBe('PGDMP');

    // The live database changes after the dump; the swap must bring back the dumped row only.
    await onDb('ih_bk_live', (c) => c.query("INSERT INTO things VALUES (2, 'after')"));
    const side = await tools.createSideDatabase('ih_bk_side');
    await tools.restore(side, Readable.from([dump]));

    // A connection to the live database must not stop the swap.
    const holder = new pg.Client({ connectionString: databaseUrl(url!, 'ih_bk_live') });
    holder.on('error', () => {});
    await holder.connect();
    await tools.swap('ih_bk_side', 'ih_bk_previous');
    await holder.end().catch(() => {});

    const live = await onDb('ih_bk_live', (c) => c.query('SELECT id FROM things ORDER BY id'));
    expect(live.rows.map((r: { id: number }) => r.id)).toEqual([1]);
    const previous = await onDb('ih_bk_previous', (c) =>
      c.query('SELECT id FROM things ORDER BY id'),
    );
    expect(previous.rows.map((r: { id: number }) => r.id)).toEqual([1, 2]);

    await tools.dropDatabase('ih_bk_previous');
    const left = await onDb('postgres', (c) =>
      c.query("SELECT datname FROM pg_database WHERE datname LIKE 'ih_bk_%' ORDER BY datname"),
    );
    expect(left.rows.map((r: { datname: string }) => r.datname)).toEqual(['ih_bk_live']);
  });

  it('a swap with a missing side database leaves the live database accepting connections', async () => {
    const tools = new PgDatabaseTools(databaseUrl(url!, 'ih_bk_live'));
    await expect(tools.swap('ih_bk_side', 'ih_bk_previous')).rejects.toThrow(/does not exist/);
    const live = await onDb('ih_bk_live', (c) => c.query('SELECT count(*)::int AS n FROM things'));
    expect(live.rows[0]).toEqual({ n: 1 });
  });

  it('reports a pg_restore failure', async () => {
    const tools = new PgDatabaseTools(databaseUrl(url!, 'ih_bk_live'));
    const side = await tools.createSideDatabase('ih_bk_side');
    await expect(tools.restore(side, Readable.from([Buffer.from('not a dump')]))).rejects.toThrow(
      /pg_restore exited with 1/,
    );
    await tools.dropDatabase('ih_bk_side');
  });
});
