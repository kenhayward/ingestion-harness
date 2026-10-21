/**
 * Opt-in Postgres test for migration 202610220900_targets_on_bridge.sql over existing targets:
 * publish_targets becomes the cache of the bridge's registry. Skipped unless IH_TEST_DATABASE_URL
 * points at a THROWAWAY server: it creates (and drops) its own database, migrates it to just
 * before this migration, writes targets in the old columns, then applies the rest.
 */
import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));
const MIGRATION = '202610220900_targets_on_bridge.sql';
const DB = 'ih_targets_on_bridge_test';

/** Shared with bridge-mirror.test.ts: what the mirror sent the bridge for each row. */
interface DestinationCase {
  name: string;
  row: Record<string, unknown>;
  mirror: {
    label: string;
    sinkId: string;
    instanceId: string | null;
    connectionId: string | null;
    destination: Record<string, string>;
  };
}
const cases = (
  JSON.parse(
    readFileSync(
      new URL(
        '../../../../packages/shared/test/fixtures/target-destinations.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { cases: DestinationCase[] }
).cases;

/** Rows with keys from before the bridge (the fixture's rows have none). */
const LEGACY_ROWS: Record<string, unknown>[] = [
  {
    // An external target whose keys were never moved (an upgrade from before phase 2).
    id: 'old-lake',
    label: 'Old lake',
    kind: 'external',
    bucket: 'old',
    prefix: 'x/',
    endpoint: 'https://s3.eu-west-2.amazonaws.com',
    region: 'eu-west-2',
    access_key_id: 'AKIAOLD',
    secret_key_enc: 'v1:b2xkLXNlY3JldA==',
    force_path_style: true,
    source: 'ui',
  },
  {
    // Keys read from .env (the seeded default of a deployment whose default is external).
    id: 'env-lake',
    label: 'Env lake',
    kind: 'external',
    bucket: 'env',
    prefix: '',
    endpoint: 'https://minio.example:9000',
    region: 'us-east-1',
    access_key_env: 'TARGET_S3_ACCESS_KEY',
    secret_key_env: 'TARGET_S3_SECRET_KEY',
    force_path_style: false,
    source: 'env',
    seeded_at: '2026-10-19T08:00:00.000Z',
    connection_id: 'target-env-lake',
    moved_to_bridge_at: '2026-10-20T09:00:00.000Z',
  },
];

/** The old columns this migration relaxes (202610220930 drops them). */
const OLD_COLUMNS = [
  'bucket',
  'prefix',
  'endpoint',
  'region',
  'access_key_id',
  'secret_key_enc',
  'access_key_env',
  'secret_key_env',
  'force_path_style',
  'sse',
  'kms_key_id',
  'storage_class',
  'layout',
  'moved_to_bridge_at',
];

const FK_TABLES = [
  'job_deliveries',
  'job_outputs',
  'published_graph_versions',
  'published_graphs',
  's3_consumer_targets',
];

function migrationsBefore(first: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ih-migrations-'));
  for (const f of readdirSync(migrations).filter((f) => f.endsWith('.sql') && f < first)) {
    copyFileSync(join(migrations, f), join(dir, f));
  }
  return dir;
}

async function insertRow(db: pg.Client, row: Record<string, unknown>): Promise<void> {
  const cols = Object.keys(row);
  await db.query(
    `INSERT INTO publish_targets (${cols.join(', ')})
     VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    cols.map((c) => row[c]),
  );
}

describe.skipIf(!url)(
  'migration 202610220900: publish_targets as the bridge cache',
  { timeout: 60_000 },
  () => {
    let admin: pg.Client;
    let db: pg.Client;

    beforeAll(async () => {
      admin = new pg.Client({ connectionString: url });
      await admin.connect();
      await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin.query(`CREATE DATABASE ${DB}`);
      const u = new URL(url!);
      u.pathname = `/${DB}`;
      const dbUrl = u.toString();

      const before = migrationsBefore(MIGRATION);
      try {
        await migrate(dbUrl, before);
      } finally {
        rmSync(before, { recursive: true, force: true });
      }
      db = new pg.Client({ connectionString: dbUrl });
      await db.connect();
      // The migrations' own `default` row stays as inserted: unseeded.
      for (const c of cases) await insertRow(db, c.row);
      for (const r of LEGACY_ROWS) await insertRow(db, r);
      const consumer = await db.query<{ id: string }>(
        `INSERT INTO s3_consumers (id, label, user_name)
       VALUES (gen_random_uuid(), 'c', 'reader') RETURNING id`,
      );
      await db.query(
        `INSERT INTO s3_consumer_targets (consumer_id, target_id) VALUES ($1, 'lake')`,
        [consumer.rows[0]!.id],
      );

      await migrate(dbUrl, migrations);
    });

    afterAll(async () => {
      await db?.end();
      await admin?.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
      await admin?.end();
    });

    const target = async (id: string) =>
      (
        await db.query<{
          label: string;
          kind: string;
          sink_id: string;
          instance_id: string | null;
          connection_id: string | null;
          destination: Record<string, string>;
          on_bridge: boolean;
          synced_at: Date | null;
        }>(
          `SELECT label, kind, sink_id, instance_id, connection_id, destination, on_bridge, synced_at
           FROM publish_targets WHERE id = $1`,
          [id],
        )
      ).rows[0]!;

    describe('the backfilled destination is what destinationOf sent', () => {
      it.each(cases.map((c) => [c.name, c] as const))('%s', async (_name, c) => {
        const t = await target(c.row.id as string);
        expect({
          label: t.label,
          sinkId: t.sink_id,
          instanceId: t.instance_id,
          connectionId: t.connection_id,
          destination: t.destination,
        }).toEqual(c.mirror);
        expect(t.kind).toBe(c.row.kind);
        expect(t.on_bridge).toBe(true);
        // Every fixture row was mirrored (created on the page, or seeded), so the bridge has it.
        expect(t.synced_at).not.toBeNull();
      });
    });

    it('leaves the unseeded default unsynced, so the worker waits for the API’s seed', async () => {
      const t = await target('default');
      expect(t.synced_at).toBeNull();
      expect(t.sink_id).toBe('s3');
      // The seed picks its kind, and so its connection.
      expect(t.connection_id).toBeNull();
      expect(t.destination).toEqual({
        bucket: 'ingest-published',
        prefix: '',
        sse: 'none',
        kmsKeyId: '',
        storageClass: '',
        layout: 'files',
      });
    });

    it('copies the legacy keys to publish_target_legacy_keys; the old columns are dropped', async () => {
      const legacy = await db.query(
        `SELECT id, endpoint, region, access_key_id, secret_key_enc, access_key_env, secret_key_env,
              force_path_style, moved_to_bridge_at
         FROM publish_target_legacy_keys ORDER BY id`,
      );
      expect(legacy.rows).toEqual([
        {
          id: 'env-lake',
          endpoint: 'https://minio.example:9000',
          region: 'us-east-1',
          access_key_id: null,
          secret_key_enc: null,
          access_key_env: 'TARGET_S3_ACCESS_KEY',
          secret_key_env: 'TARGET_S3_SECRET_KEY',
          force_path_style: false,
          moved_to_bridge_at: new Date('2026-10-20T09:00:00.000Z'),
        },
        {
          id: 'old-lake',
          endpoint: 'https://s3.eu-west-2.amazonaws.com',
          region: 'eu-west-2',
          access_key_id: 'AKIAOLD',
          secret_key_enc: 'v1:b2xkLXNlY3JldA==',
          access_key_env: null,
          secret_key_env: null,
          force_path_style: true,
          moved_to_bridge_at: null,
        },
      ]);

      const columns = await db.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'publish_targets'
          AND column_name = ANY($1::text[])`,
        [OLD_COLUMNS],
      );
      // 202610220930: the bridge holds them now (the keys not moved yet are in the legacy table).
      expect(columns.rows).toEqual([]);
      const layoutCheck = await db.query(
        "SELECT 1 FROM pg_constraint WHERE conname = 'publish_targets_layout_check'",
      );
      expect(layoutCheck.rowCount).toBe(0);
      // Every row names its sink: there is no default any more.
      const sink = await db.query<{ column_default: string | null }>(
        `SELECT column_default FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'publish_targets'
            AND column_name = 'sink_id'`,
      );
      expect(sink.rows).toEqual([{ column_default: null }]);

      // A cache row is written without them.
      await db.query(
        `INSERT INTO publish_targets (id, label, kind, sink_id, destination)
       VALUES ('crm', 'CRM', 'sink', 'crm', '{"object": "contact"}')`,
      );
      await db.query(`DELETE FROM publish_targets WHERE id = 'crm'`);
    });

    it('the five foreign keys still hold after the migration', async () => {
      const fks = await db.query<{ t: string }>(
        `SELECT conrelid::regclass::text AS t FROM pg_constraint
        WHERE contype = 'f' AND confrelid = 'publish_targets'::regclass`,
      );
      expect(fks.rows.map((r) => r.t).sort()).toEqual(
        [...FK_TABLES, 'publish_target_legacy_keys'].sort(),
      );
      await expect(db.query(`DELETE FROM publish_targets WHERE id = 'lake'`)).rejects.toMatchObject(
        {
          code: '23503',
        },
      );
      await expect(
        db.query(
          `INSERT INTO s3_consumer_targets (consumer_id, target_id)
         SELECT id, 'nowhere' FROM s3_consumers`,
        ),
      ).rejects.toMatchObject({ code: '23503' });
    });

    it('target_s3_place reads an S3 target’s bucket, prefix and layout; none for another sink', async () => {
      const place = async (destination: unknown, sinkId: string) =>
        (
          await db.query(`SELECT * FROM target_s3_place($1::jsonb, $2)`, [
            JSON.stringify(destination),
            sinkId,
          ])
        ).rows;
      expect(await place({ bucket: 'b', prefix: 'p/', layout: 'package' }, 's3')).toEqual([
        { bucket: 'b', prefix: 'p/', layout: 'package' },
      ]);
      expect(await place({ bucket: 'b', prefix: '', layout: '' }, 's3')).toEqual([
        { bucket: 'b', prefix: '', layout: 'files' },
      ]);
      expect(await place({ bucket: 'b' }, 's3')).toEqual([
        { bucket: 'b', prefix: '', layout: 'files' },
      ]);
      expect(await place({ dataset: 'ih' }, 'rdf')).toEqual([]);
      const archive = await db.query(
        `SELECT p.* FROM publish_targets t, target_s3_place(t.destination, t.sink_id) p
        WHERE t.id = 'archive'`,
      );
      expect(archive.rows).toEqual([{ bucket: 'archive', prefix: '', layout: 'package' }]);
    });

    it('refuses a destination layout other than files or package', async () => {
      await expect(
        db.query(
          `INSERT INTO publish_targets (id, label, kind, sink_id, destination)
         VALUES ('zip', 'Zip', 'internal', 's3', '{"bucket": "z", "layout": "zip"}')`,
        ),
      ).rejects.toThrow(/publish_targets_destination_layout_check/);
    });
  },
);
