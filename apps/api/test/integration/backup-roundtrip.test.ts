/**
 * Opt-in round trip of a whole backup and a restore as this deployment, against a real Postgres
 * (with pg_dump/pg_restore on PATH), a real SeaweedFS and, when given, a real Fuseki. Every one of
 * them must be THROWAWAY: the test creates, swaps and drops databases named ih_rt_*, writes
 * buckets named rt-<random>-*, and replaces the whole Fuseki dataset. Skipped unless
 * IH_TEST_DATABASE_URL and IH_TEST_S3_ENDPOINT/_ACCESS_KEY/_SECRET_KEY are set; the triple store
 * part needs IH_TEST_RDF_ENDPOINT/_USER/_PASSWORD (dataset IH_TEST_RDF_DATASET, default `ct`).
 *   docker run --rm -d --name ih-rt-pg -e POSTGRES_PASSWORD=test -p 55481:5432 ih-postgres:pgvector
 *   (SeaweedFS 4.48 as in deploy/scripts/external-s3.sh, on another port; Fuseki from
 *    deploy/docker/fuseki.Dockerfile with RDF_WRITER_PASSWORD set)
 *   IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55481/postgres IH_TEST_S3_ENDPOINT=… \
 *     npx vitest run --config apps/api/vitest.integration.config.ts backup-roundtrip
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkBackup } from '../../src/backup/check.js';
import { backupFileKey, createBackup } from '../../src/backup/create.js';
import { FusekiTripleStore } from '../../src/backup/fuseki.js';
import { databaseUrl, PgDatabaseTools } from '../../src/backup/pg-tools.js';
import type { BackupDeps, TripleStoreDump } from '../../src/backup/ports.js';
import { PgLiveDatabase, PgSideDatabase } from '../../src/backup/restore-pg.js';
import { runRestore } from '../../src/backup/restore.js';
import { NoLakeIdentities } from '../../src/backup/seaweed-iam-file.js';
import { uploadFileKey } from '../../src/backup/uploads.js';
import { migrate } from '../../src/db/migrate.js';
import { MaintenanceGate, PgMaintenanceRepo } from '../../src/maintenance/repo.js';
import { S3ObjectStore } from '../../src/storage/s3.js';

const env = process.env;
const url = env.IH_TEST_DATABASE_URL;
const s3 = env.IH_TEST_S3_ENDPOINT
  ? {
      endpoint: env.IH_TEST_S3_ENDPOINT,
      region: env.IH_TEST_S3_REGION ?? 'us-east-1',
      accessKeyId: env.IH_TEST_S3_ACCESS_KEY ?? '',
      secretAccessKey: env.IH_TEST_S3_SECRET_KEY ?? '',
    }
  : null;
const fuseki = env.IH_TEST_RDF_ENDPOINT
  ? {
      endpoint: env.IH_TEST_RDF_ENDPOINT,
      dataset: env.IH_TEST_RDF_DATASET ?? 'ct',
      user: env.IH_TEST_RDF_USER ?? 'ct-writer',
      password: env.IH_TEST_RDF_PASSWORD ?? '',
    }
  : null;

const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));
const LIVE = 'ih_rt_live';
const DOC = '00000000-0000-4000-8000-0000000000d1';
const JOB = '00000000-0000-4000-8000-0000000000a1';
const QUAD = '<https://id.example/s> <https://id.example/p> "backed up" <https://id.example/g> .\n';
const LATER = '<https://id.example/s> <https://id.example/p> "after" <https://id.example/g2> .\n';

async function onDb<T>(name: string, work: (c: pg.Client) => Promise<T>): Promise<T> {
  const c = new pg.Client({ connectionString: databaseUrl(url!, name) });
  c.on('error', () => {});
  await c.connect();
  try {
    return await work(c);
  } finally {
    await c.end();
  }
}

const dropAll = () =>
  onDb('postgres', async (c) => {
    const { rows } = await c.query<{ datname: string }>(
      "SELECT datname FROM pg_database WHERE datname LIKE 'ih\\_rt\\_%'",
    );
    for (const r of rows) await c.query(`DROP DATABASE IF EXISTS "${r.datname}" WITH (FORCE)`);
  });

const readAll = async (body: Readable) => {
  const chunks: Buffer[] = [];
  for await (const c of body) chunks.push(Buffer.from(c as Buffer));
  return Buffer.concat(chunks).toString('utf8');
};

const noTriples: TripleStoreDump = {
  available: async () => false,
  dump: async () => Readable.from([]),
  replace: async () => {},
  deleteGraph: async () => {},
};

describe.skipIf(!url || !s3)('backup and restore round trip', () => {
  const run = randomBytes(3).toString('hex');
  const buckets = {
    inbox: `rt-${run}-inbox`,
    outputs: `rt-${run}-outputs`,
    runs: `rt-${run}-runs`,
    backups: `rt-${run}-backups`,
  };
  let store: S3ObjectStore;
  let pool: pg.Pool;
  let deps: BackupDeps;
  const master = randomBytes(32);

  beforeAll(async () => {
    await dropAll();
    await onDb('postgres', (c) => c.query(`CREATE DATABASE ${LIVE}`));
    await migrate(databaseUrl(url!, LIVE), migrations);
    pool = new pg.Pool({ connectionString: databaseUrl(url!, LIVE), max: 3 });
    // The swap terminates this pool's connections.
    pool.on('error', () => {});
    store = new S3ObjectStore(s3!);
    for (const b of Object.values(buckets)) await store.ensureBucket(b);
    deps = {
      db: new PgDatabaseTools(databaseUrl(url!, LIVE)),
      store,
      buckets,
      internalTargetBuckets: async () => [],
      triples: fuseki ? new FusekiTripleStore(fuseki) : noTriples,
      lake: new NoLakeIdentities(),
      master,
      version: { appVersion: 'test', commit: null },
      instanceName: async () => 'roundtrip',
      baseIri: async () => 'https://id.example/',
      now: () => new Date(),
    };
  });

  afterAll(async () => {
    await pool?.end().catch(() => {});
    if (store) {
      for (const b of Object.values(buckets)) {
        await store.deletePrefix(b, '').catch(() => {});
      }
    }
    if (url) await dropAll();
  });

  it('restores the database, the objects and the graph as they were backed up', async () => {
    // Seed: a document with its file, a finished job, a graph.
    await pool.query(
      `INSERT INTO documents (id, filename, sha256, size_bytes, spec_id, spec_version, bucket, object_key)
       VALUES ($1, 'a.pdf', 'sha-a', 8, 'invoice', 1, $2, 'docs/a.pdf')`,
      [DOC, buckets.inbox],
    );
    await pool.query(
      `INSERT INTO jobs (id, document_id, task, status) VALUES ($1, $2, 'process', 'succeeded')`,
      [JOB, DOC],
    );
    await store.put(buckets.inbox, 'docs/a.pdf', Buffer.from('%PDF-1 a'), 'application/pdf');
    if (fuseki) await deps.triples.replace(Readable.from([Buffer.from(QUAD)]));

    // Back up, then "upload" the file where a restore reads it.
    const id = randomUUID();
    await createBackup(deps, id, 'Admin', () => {});
    const backup = (await store.getStream(buckets.backups, backupFileKey(id)))!;
    await store.putStream(
      buckets.backups,
      uploadFileKey('u1'),
      backup.body,
      'application/octet-stream',
    );
    const local = readdirSync(migrations).filter((f) => f.endsWith('.sql'));
    const checked = await checkBackup(
      async () => (await store.getStream(buckets.backups, uploadFileKey('u1')))!.body,
      [master],
      local,
      () => {},
    );

    // Everything changes after the backup.
    await pool.query('DELETE FROM jobs WHERE id = $1', [JOB]);
    await pool.query(
      `INSERT INTO documents (filename, sha256, size_bytes, spec_id, spec_version, bucket, object_key)
       VALUES ('b.pdf', 'sha-b', 1, 'invoice', 1, $1, 'docs/b.pdf')`,
      [buckets.inbox],
    );
    await store.put(buckets.inbox, 'docs/a.pdf', Buffer.from('changed'), 'application/pdf');
    await store.put(buckets.inbox, 'docs/b.pdf', Buffer.from('later'), 'application/pdf');
    if (fuseki) await deps.triples.replace(Readable.from([Buffer.from(LATER)]));

    let rotated = 0;
    const report = await runRestore(
      {
        ...deps,
        gate: new MaintenanceGate(new PgMaintenanceRepo(pool)),
        localMigrations: async () => local,
        migrate: async (sideUrl) => {
          await migrate(sideUrl, migrations);
        },
        rotateAdminToken: async () => {
          rotated += 1;
        },
        createEmbedJobs: async () => 0,
        liveDatabaseName: LIVE,
        live: new PgLiveDatabase(pool),
        openSide: (sideUrl) => PgSideDatabase.open(sideUrl),
        lakeIssuer: null,
        jobWaitMs: 0,
      },
      {
        id: 'r1',
        mode: 'deployment',
        key: checked.master,
        uploadKey: uploadFileKey('u1'),
        by: 'Admin',
        manifest: checked.manifest,
        contentTypes: checked.contentTypes,
      },
      async () => {},
    );

    expect(rotated).toBe(1);
    expect(report.missingObjects).toEqual([]);
    expect(report.triples).toBe(fuseki ? 'restored' : 'no-triple-store');

    // The database: the job is back, the later document gone; the old database kept.
    await onDb(LIVE, async (c) => {
      expect((await c.query('SELECT status FROM jobs WHERE id = $1', [JOB])).rows).toEqual([
        { status: 'succeeded' },
      ]);
      expect((await c.query("SELECT 1 FROM documents WHERE filename = 'b.pdf'")).rowCount).toBe(0);
      expect((await c.query('SELECT enabled, message FROM maintenance')).rows[0]).toEqual({
        enabled: true,
        message: 'CT Studio is being restored from a backup.',
      });
      expect((await c.query('SELECT paused FROM queue_control')).rows[0]).toEqual({ paused: true });
    });
    const previous = await onDb('postgres', (c) =>
      c.query('SELECT 1 FROM pg_database WHERE datname = $1', [report.previousDatabase]),
    );
    expect(previous.rowCount).toBe(1);
    await onDb(report.previousDatabase, async (c) => {
      expect((await c.query("SELECT 1 FROM documents WHERE filename = 'b.pdf'")).rowCount).toBe(1);
    });

    // The objects: as backed up, the later one gone.
    expect((await store.get(buckets.inbox, 'docs/a.pdf'))?.toString()).toBe('%PDF-1 a');
    expect(await store.get(buckets.inbox, 'docs/b.pdf')).toBeNull();

    // The graph: as backed up.
    if (fuseki) {
      const dumped = await readAll(await deps.triples.dump());
      expect(dumped).toContain('"backed up"');
      expect(dumped).not.toContain('"after"');
    }
  });

  it('the side database maps bucket names that trade places, and queues a rebuild', async () => {
    const name = 'ih_rt_side_sql';
    await onDb('postgres', (c) => c.query(`CREATE DATABASE ${name}`));
    await migrate(databaseUrl(url!, name), migrations);
    await onDb(name, async (c) => {
      await c.query(
        `INSERT INTO documents (filename, sha256, size_bytes, spec_id, spec_version, bucket, object_key)
         VALUES ('a.pdf', 's', 1, 'invoice', 1, 'p-inbox', 'a.pdf'),
                ('b.pdf', 's', 1, 'invoice', 1, 'p-outputs', 'b.pdf')`,
      );
      await c.query("INSERT INTO llm_settings (name, value) VALUES ('embedding_model', 'local/e')");
    });
    const side = await PgSideDatabase.open(databaseUrl(url!, name));
    try {
      await side.prepare({
        message: 'restoring',
        by: 'Admin',
        buckets: [
          { from: 'p-inbox', to: 'p-outputs' },
          { from: 'p-outputs', to: 'p-inbox' },
        ],
      });
      await side.queueRebuild('remint', 'Admin');
      expect(await side.embeddingModel()).toBe('local/e');
      expect((await side.referencedObjects()).sort((a, b) => a.key.localeCompare(b.key))).toEqual([
        { bucket: 'p-outputs', key: 'a.pdf' },
        { bucket: 'p-inbox', key: 'b.pdf' },
      ]);
    } finally {
      await side.close();
    }
    await onDb(name, async (c) => {
      const jobs = await c.query('SELECT task, priority, max_attempts, params FROM jobs');
      expect(jobs.rows).toEqual([
        { task: 'rebuild', priority: -10, max_attempts: 10, params: { mode: 'remint' } },
      ]);
      expect((await c.query('SELECT paused, reason FROM queue_control')).rows[0]).toEqual({
        paused: true,
        reason: 'restored from backup',
      });
    });
  });
});
