/**
 * Opt-in Postgres test for migrations applied over existing data. Skipped unless
 * IH_TEST_DATABASE_URL points at a THROWAWAY server: it creates (and drops) its own database.
 * Example: docker run --rm -d --name ih-test-pg -e POSTGRES_PASSWORD=test -p 55433:5432 ih-postgres:pgvector
 */
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));
const DB = 'ih_migrations_test';

/** A directory holding the migrations before `first` only. */
function migrationsBefore(first: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ih-migrations-'));
  for (const f of readdirSync(migrations).filter((f) => f.endsWith('.sql') && f < first)) {
    copyFileSync(join(migrations, f), join(dir, f));
  }
  return dir;
}

describe.skipIf(!url)('migrations over existing data', { timeout: 60_000 }, () => {
  let admin: pg.Client;
  let dbUrl: string;

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
    await admin.query(`CREATE DATABASE ${DB}`);
    const u = new URL(url!);
    u.pathname = `/${DB}`;
    dbUrl = u.toString();
  });

  afterAll(async () => {
    await admin?.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin?.end();
  });

  it('0038 backfills ontology_iris on ready ontology versions', async () => {
    const before = migrationsBefore('0038');
    try {
      await migrate(dbUrl, before);
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
    const db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    try {
      await db.query(`INSERT INTO ontologies (id, label) VALUES ('qudt', 'QUDT')`);
      await db.query(
        `INSERT INTO ontology_versions
           (ontology_id, version, status, file_name, media_type, sha256, bytes, ontology_iri)
         VALUES ('qudt', 1, 'ready', 'q.ttl', 'text/turtle', 'aaa', 1, 'http://qudt.org/2.1/schema/qudt'),
                ('qudt', 2, 'ready', 'r.ttl', 'text/turtle', 'bbb', 1, NULL)`,
      );

      await migrate(dbUrl, migrations);

      const rows = await db.query(
        `SELECT version, ontology_iris FROM ontology_versions ORDER BY version`,
      );
      expect(rows.rows).toEqual([
        { version: 1, ontology_iris: ['http://qudt.org/2.1/schema/qudt'] },
        { version: 2, ontology_iris: [] },
      ]);
      // A ready version is still immutable afterwards.
      await expect(
        db.query(`UPDATE ontology_versions SET license = 'x' WHERE version = 1`),
      ).rejects.toThrow(/is ready and cannot change/);
    } finally {
      await db.end();
    }
  });

  it('0050 names the default target in pending withdrawals and grants it to consumers', async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
    await admin.query(`CREATE DATABASE ${DB}`);
    const before = migrationsBefore('0050');
    try {
      await migrate(dbUrl, before);
    } finally {
      rmSync(before, { recursive: true, force: true });
    }
    const db = new pg.Client({ connectionString: dbUrl });
    await db.connect();
    try {
      // Withdraw params as the API wrote them before publishing targets.
      const old = {
        objects: [
          { bucket: 'ingest-published', key: 'a.csv' },
          { bucket: 'ingest-published', key: 'b.json' },
        ],
        graphs: [{ sha256: 's', templateId: 't', graphIri: 'urn:g', versions: [1, 2] }],
      };
      const empty = { objects: [], graphs: [] };
      const ids: Record<string, string> = {};
      for (const [name, status, params] of [
        ['queued', 'queued', old],
        ['running', 'running', old],
        ['review', 'needs_review', old],
        ['failed', 'failed', old],
        ['empty', 'queued', empty],
        ['done', 'succeeded', old],
      ] as const) {
        const r = await db.query<{ id: string }>(
          `INSERT INTO jobs (task, status, params) VALUES ('withdraw', $1::job_status, $2)
           RETURNING id`,
          [status, JSON.stringify(params)],
        );
        ids[name] = r.rows[0]!.id;
      }
      await db.query(
        `INSERT INTO jobs (task, status, params) VALUES ('republish', 'queued', $1)`,
        [JSON.stringify({ templateId: 't' })],
      );
      await db.query(
        `INSERT INTO s3_consumers (id, label, user_name)
         VALUES ('00000000-0000-0000-0000-000000000001', 'Lake', 'lake-1')`,
      );

      await migrate(dbUrl, migrations);

      const params = async (id: string) =>
        (await db.query<{ params: unknown }>('SELECT params FROM jobs WHERE id = $1', [id]))
          .rows[0]!.params;
      const carried = {
        objects: [
          { bucket: 'ingest-published', key: 'a.csv', target: 'default' },
          { bucket: 'ingest-published', key: 'b.json', target: 'default' },
        ],
        graphs: [
          { sha256: 's', templateId: 't', graphIri: 'urn:g', versions: [1, 2], target: 'default' },
        ],
      };
      for (const name of ['queued', 'running', 'review', 'failed']) {
        expect([name, await params(ids[name]!)]).toEqual([name, carried]);
      }
      expect(await params(ids.empty!)).toEqual(empty);
      // A finished withdrawal is history: left as it ran.
      expect(await params(ids.done!)).toEqual(old);
      const republish = await db.query<{ params: unknown }>(
        `SELECT params FROM jobs WHERE task = 'republish'`,
      );
      expect(republish.rows[0]!.params).toEqual({ templateId: 't' });
      const grants = await db.query('SELECT consumer_id, target_id FROM s3_consumer_targets');
      expect(grants.rows).toEqual([
        { consumer_id: '00000000-0000-0000-0000-000000000001', target_id: 'default' },
      ]);
    } finally {
      await db.end();
    }
  });
});
