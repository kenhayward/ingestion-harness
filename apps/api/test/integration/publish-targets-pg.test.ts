/**
 * Opt-in Postgres integration test for PgPublishTargetRepo (migration 202610170019): the shared contract.
 *
 * Skipped unless IH_TEST_DATABASE_URL points at a THROWAWAY database: it applies db/migrations
 * and empties the publishing-target tables there. See workbench-pg.test.ts for how to start one.
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { PgPublishTargetRepo } from '../../src/publish-targets/pg.js';
import type { LegacyKeys } from '../../src/publish-targets/repo.js';
import { publishTargetsContract } from '../publish-targets-contract.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('PgPublishTargetRepo', { timeout: 60_000 }, () => {
  let pool: pg.Pool | undefined;
  const make = async () => {
    if (!pool) {
      await migrate(url!, migrations);
      pool = new pg.Pool({ connectionString: url, max: 5 });
    }
    await pool.query('TRUNCATE s3_consumer_targets, job_outputs, published_graph_versions');
    await pool.query('DELETE FROM published_graphs');
    await pool.query('DELETE FROM jobs');
    await pool.query('DELETE FROM documents');
    // Published recipes refuse deletion; this is a throwaway database.
    await pool.query('ALTER TABLE templates DISABLE TRIGGER templates_no_delete');
    await pool.query('DELETE FROM templates');
    await pool.query('ALTER TABLE templates ENABLE TRIGGER templates_no_delete');
    await pool.query('DELETE FROM s3_consumers');
    await pool.query('DELETE FROM publish_target_legacy_keys');
    await pool.query("DELETE FROM publish_targets WHERE id <> 'default'");
    // The default as the migrations leave it on a fresh database: unseeded, never synced.
    await pool.query(
      `UPDATE publish_targets SET label = 'Default', kind = 'internal', sink_id = 's3',
         instance_id = NULL, connection_id = NULL, on_bridge = true, synced_at = NULL,
         destination = '{"bucket": "ingest-published", "prefix": "", "sse": "none",
                         "kmsKeyId": "", "storageClass": "", "layout": "files"}',
         source = 'env', seeded_at = NULL, edited_at = NULL, updated_by = NULL, inert_at = NULL
       WHERE id = 'default'`,
    );
    const repo = new PgPublishTargetRepo(pool);
    const p = pool;
    return {
      repo,
      facts: {
        publish: async (id: string, version: number, publishTo: string | string[] | null) => {
          const definition = publishTo === null ? {} : { delivery: { publishTo } };
          await p.query(
            `INSERT INTO templates (id, version, status, definition, published_at)
             VALUES ($1, $2, 'published', $3, now())`,
            [id, version, JSON.stringify(definition)],
          );
        },
        delivered: async (targetId: string) => {
          const jobId = await newJob(p);
          await p.query(
            `INSERT INTO job_outputs (job_id, output_id, format, bucket, object_key, stage, target_id)
             VALUES ($1, 'o', 'csv', 'b', 'k', 'published', $2)`,
            [jobId, targetId],
          );
        },
        withdrawal: async (targetId: string, status: string) => {
          const params = {
            objects: [{ bucket: 'b', key: 'k', target: targetId }],
            graphs: [
              { sha256: 's', templateId: 't', graphIri: null, target: targetId, versions: [1] },
            ],
          };
          await p.query(
            `INSERT INTO jobs (task, status, params) VALUES ('withdraw', $1::job_status, $2)`,
            [status, JSON.stringify(params)],
          );
        },
        legacyKeys: async (k: LegacyKeys) => {
          await p.query(
            `INSERT INTO publish_target_legacy_keys (id, endpoint, region, access_key_id,
               secret_key_enc, access_key_env, secret_key_env, force_path_style, moved_to_bridge_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
              k.id,
              k.endpoint,
              k.region,
              k.accessKeyId,
              k.secretKeyEnc,
              k.accessKeyEnv,
              k.secretKeyEnv,
              k.forcePathStyle,
              k.movedToBridgeAt,
            ],
          );
        },
        inert: async (targetId: string) => {
          await p.query('UPDATE publish_targets SET inert_at = now() WHERE id = $1', [targetId]);
        },
        grant: async (targetId: string) => {
          const c = await p.query<{ id: string }>(
            `INSERT INTO s3_consumers (id, label, user_name)
             VALUES (gen_random_uuid(), 'c', md5(random()::text)) RETURNING id`,
          );
          await p.query(
            'INSERT INTO s3_consumer_targets (consumer_id, target_id) VALUES ($1, $2)',
            [c.rows[0]!.id, targetId],
          );
        },
      },
    };
  };
  afterAll(async () => {
    await pool?.end();
  });

  publishTargetsContract('pg', make);

  it('requires a target for a published output but not a draft one', async () => {
    await make();
    const jobId = await newJob(pool!);
    await expect(
      pool!.query(
        `INSERT INTO job_outputs (job_id, output_id, format, bucket, object_key, stage)
         VALUES ($1, 'o', 'csv', 'b', 'k', 'published')`,
        [jobId],
      ),
    ).rejects.toThrow(/job_outputs_target_check/);
    await expect(
      pool!.query(
        `INSERT INTO job_outputs (job_id, output_id, format, bucket, object_key, stage)
         VALUES ($1, 'o', 'csv', 'b', 'k', 'draft')`,
        [jobId],
      ),
    ).resolves.toBeDefined();
  });
});

async function newJob(p: pg.Pool): Promise<string> {
  const doc = await p.query<{ id: string }>(
    `INSERT INTO documents (filename, sha256, size_bytes, spec_id, spec_version, bucket, object_key)
     VALUES ('a.pdf', md5(random()::text), 1, 's', 1, 'b', md5(random()::text)) RETURNING id`,
  );
  const job = await p.query<{ id: string }>(
    'INSERT INTO jobs (document_id) VALUES ($1) RETURNING id',
    [doc.rows[0]!.id],
  );
  return job.rows[0]!.id;
}
