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
});
