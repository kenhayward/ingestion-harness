import pg from 'pg';
import { REBUILD_JOB } from '../repositories/types.js';
import { applyCopyRules, readKeptState, type CopyResult, type KeptState } from './copy-rules.js';
import type { LiveDatabase, ObjectRef, RebuildMode, SideDatabase } from './ports.js';

/** The restore's SQL on Postgres: the live database through the API's pool, the side one direct. */

export class PgLiveDatabase implements LiveDatabase {
  constructor(private readonly pool: pg.Pool) {}

  async pauseQueue(by: string, reason: string): Promise<void> {
    await this.pool.query(
      `UPDATE queue_control SET paused = true,
         paused_at = CASE WHEN paused THEN paused_at ELSE now() END,
         paused_by = CASE WHEN paused THEN paused_by ELSE $1 END,
         reason = CASE WHEN paused THEN reason ELSE $2 END`,
      [by, reason],
    );
  }

  async runningJobs(): Promise<number> {
    const { rows } = await this.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM jobs WHERE status = 'running'",
    );
    return rows[0]!.n;
  }

  async cancelRunning(reason: string): Promise<number> {
    const { rowCount } = await this.pool.query(
      `WITH cancelled AS (
         UPDATE jobs SET status = 'cancelled', locked_by = NULL, locked_at = NULL, updated_at = now()
          WHERE status = 'running'
          RETURNING id)
       INSERT INTO job_events (job_id, level, message, data)
       SELECT id, 'warn', 'cancelled', $1::jsonb FROM cancelled`,
      [JSON.stringify({ reason })],
    );
    return rowCount ?? 0;
  }

  async readKeptState(): Promise<KeptState> {
    const client = await this.pool.connect();
    try {
      return await readKeptState(client);
    } finally {
      client.release();
    }
  }
}

/** The tables the report counts. */
const COUNTED = [
  'users',
  'templates',
  'workbench_projects',
  'documents',
  'jobs',
  'job_outputs',
  'ontologies',
  'published_graphs',
] as const;

export class PgSideDatabase implements SideDatabase {
  private constructor(private readonly client: pg.Client) {}

  static async open(url: string): Promise<PgSideDatabase> {
    const client = new pg.Client({ connectionString: url });
    // The swap ends this connection if it is still open: never an unhandled 'error'.
    client.on('error', () => {});
    await client.connect();
    return new PgSideDatabase(client);
  }

  /** Its own transaction (see copy-rules.ts): never called inside another. */
  applyCopyRules(kept: KeptState): Promise<CopyResult> {
    return applyCopyRules(this.client, kept);
  }

  async prepare(opts: {
    message: string;
    by: string;
    buckets: { from: string; to: string }[];
  }): Promise<void> {
    const c = this.client;
    await c.query('BEGIN');
    try {
      await c.query('DELETE FROM sessions');
      await c.query(
        `INSERT INTO queue_control (id, paused, paused_at, paused_by, reason)
         VALUES (true, true, now(), $1, 'restored from backup')
         ON CONFLICT (id) DO UPDATE SET paused = true, paused_at = now(), paused_by = $1,
           reason = 'restored from backup'`,
        [opts.by],
      );
      await c.query(
        `INSERT INTO maintenance (id, enabled, message, since, updated_by, updated_at)
         VALUES (true, true, $1, now(), $2, now())
         ON CONFLICT (id) DO UPDATE SET enabled = true, message = $1, since = now(),
           updated_by = $2, updated_at = now()`,
        [opts.message, opts.by],
      );
      // One statement per table, so names that trade places (a ↔ b) map correctly.
      const from = opts.buckets.map((b) => b.from);
      const to = opts.buckets.map((b) => b.to);
      for (const table of ['documents', 'job_outputs']) {
        await c.query(
          `UPDATE ${table} t SET bucket = m.to_bucket
             FROM (SELECT unnest($1::text[]) AS from_bucket, unnest($2::text[]) AS to_bucket) m
            WHERE t.bucket = m.from_bucket`,
          [from, to],
        );
      }
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  async referencedObjects(): Promise<ObjectRef[]> {
    const { rows } = await this.client.query<ObjectRef>(
      `SELECT bucket, object_key AS key FROM documents
       UNION
       SELECT o.bucket, o.object_key FROM job_outputs o
         JOIN publish_targets p ON p.id = o.target_id
        WHERE o.stage = 'published' AND o.withdrawn_at IS NULL
          AND p.kind = 'internal' AND p.inert_at IS NULL`,
    );
    return rows;
  }

  async lakeAccessKeys() {
    const { rows } = await this.client.query<{
      consumer: string;
      userName: string;
      accessKeyId: string;
    }>(
      `SELECT c.label AS consumer, c.user_name AS "userName", k.access_key_id AS "accessKeyId"
         FROM s3_access_keys k JOIN s3_consumers c ON c.id = k.consumer_id
        WHERE k.revoked_at IS NULL`,
    );
    return rows;
  }

  async queueRebuild(mode: RebuildMode, by: string): Promise<void> {
    // As the API's queueBackground: no document, no project.
    await this.client.query(
      `INSERT INTO jobs (task, priority, max_attempts, params, created_by)
       VALUES ('rebuild', $1, $2, $3, $4)`,
      [REBUILD_JOB.priority, REBUILD_JOB.maxAttempts, JSON.stringify({ mode }), by],
    );
  }

  async embeddingModel(): Promise<string | null> {
    const { rows } = await this.client.query<{ value: string }>(
      "SELECT value FROM llm_settings WHERE name = 'embedding_model'",
    );
    return rows[0]?.value ?? null;
  }

  async tableCounts(): Promise<{ table: string; rows: number }[]> {
    const out: { table: string; rows: number }[] = [];
    for (const table of COUNTED) {
      const { rows } = await this.client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${table}`,
      );
      out.push({ table, rows: rows[0]!.n });
    }
    return out;
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}
