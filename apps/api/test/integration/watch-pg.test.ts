/**
 * Opt-in Postgres integration test for PgWatchRepo (migration 202610291400): the shared contract
 * and the unique-index change on conversion items. Skipped unless IH_TEST_DATABASE_URL points at a
 * THROWAWAY database: it applies db/migrations and empties the watch tables there.
 */
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { migrate } from '../../src/db/migrate.js';
import { PgWatchRepo } from '../../src/watches/pg.js';
import { watchContract } from '../watch-contract.js';

const url = process.env.IH_TEST_DATABASE_URL;
const migrations = fileURLToPath(new URL('../../../../db/migrations', import.meta.url));

describe.skipIf(!url)('PgWatchRepo', { timeout: 60_000 }, () => {
  let pool: pg.Pool | undefined;
  afterAll(async () => {
    await pool?.end();
  });

  const ready = async () => {
    if (!pool) {
      await migrate(url!, migrations);
      pool = new pg.Pool({ connectionString: url, max: 5 });
    }
    return pool;
  };

  watchContract('pg', async () => {
    const p = await ready();
    await p.query('TRUNCATE watched_folders CASCADE');
    await p.query('DELETE FROM decomposition_items');
    await p.query('DELETE FROM decomposition_batches');
    await p.query("DELETE FROM jobs WHERE task = 'decompose'");
    const batches = new Map<string, string>();
    let n = 0;
    const item = async (id: string, outcome: string, jobStatus?: string): Promise<string> => {
      let batch = batches.get(id);
      if (!batch) {
        const { rows } = await p.query<{ id: string }>(
          `INSERT INTO decomposition_batches (target_id, created_by, state, watch_id)
           VALUES ('default', '{"id":null,"name":null}', 'started', $1) RETURNING id`,
          [id],
        );
        batch = rows[0]!.id;
        batches.set(id, batch);
      }
      // The job as the worker leaves it for that outcome, and the pickup that led to the item.
      const status =
        jobStatus ??
        (outcome === 'queued' ? 'queued' : outcome === 'decomposing' ? 'running' : 'succeeded');
      const job = await p.query<{ id: string }>(
        `INSERT INTO jobs (task, status, params) VALUES ('decompose', $1::job_status, '{}')
         RETURNING id`,
        [status],
      );
      const added = await p.query<{ id: string }>(
        `INSERT INTO decomposition_items
           (batch_id, source_key, filename, content_sha256, size_bytes, object_key, outcome, watched,
            job_id)
         VALUES ($1, $2, 'a.docx', 'sha', 1, 'k', $3, true, $4) RETURNING id`,
        [batch, `k-${++n}`, outcome, job.rows[0]!.id],
      );
      await p.query(
        `INSERT INTO watch_pickups (watch_id, original_name, size, modified_at, step, item_id)
         VALUES ($1, $2, 1, now(), 'queued', $3)`,
        [id, `file-${n}.docx`, added.rows[0]!.id],
      );
      return added.rows[0]!.id;
    };
    return {
      repo: new PgWatchRepo(p),
      targetId: 'default',
      hooks: {
        setProblem: async (id, problem) => {
          await p.query('UPDATE watched_folders SET problem = $2 WHERE id = $1', [id, problem]);
        },
        setWaiting: async (id, waiting) => {
          await p.query('UPDATE watched_folders SET root_waiting = $2 WHERE id = $1', [
            id,
            waiting,
          ]);
        },
        addUnfinished: (id, outcome, jobStatus) => item(id, outcome, jobStatus),
        inspect: async (_id, itemId) => {
          const { rows } = await p.query<{
            outcome: string;
            detail: string | null;
            job_status: string;
            pickup: string;
          }>(
            `SELECT i.outcome, i.detail, j.status AS job_status, k.step AS pickup
               FROM decomposition_items i
               JOIN jobs j ON j.id = i.job_id
               JOIN watch_pickups k ON k.item_id = i.id
              WHERE i.id = $1`,
            [itemId],
          );
          const r = rows[0]!;
          return {
            outcome: r.outcome,
            detail: r.detail,
            jobStatus: r.job_status,
            pickup: r.pickup,
          };
        },
        addPickup: async (id, step, moveFailures) => {
          await p.query(
            `INSERT INTO watch_pickups (watch_id, original_name, size, modified_at, step, move_failures)
             VALUES ($1, $2, 1, now(), $3, $4)`,
            [id, `p-${++n}.docx`, step, moveFailures],
          );
        },
        moveFailures: async (id) => {
          const { rows } = await p.query<{ step: string; move_failures: number }>(
            'SELECT step, move_failures FROM watch_pickups WHERE watch_id = $1',
            [id],
          );
          return Object.fromEntries(rows.map((r) => [r.step, r.move_failures]));
        },
        addTaken: async (id, step, objectKey) => {
          await p.query(
            `INSERT INTO watch_pickups
               (watch_id, original_name, size, modified_at, step, working_name, item_id, object_key)
             VALUES ($1, $2, 1, now(), $3, $2, gen_random_uuid(), $4)`,
            [id, `t-${++n}.docx`, step, objectKey],
          );
        },
        steps: async (id) => {
          const { rows } = await p.query<{ step: string }>(
            'SELECT step FROM watch_pickups WHERE watch_id = $1 ORDER BY step',
            [id],
          );
          return rows.map((r) => r.step);
        },
        recordFinish: async (id, delivered, hoursAgo) => {
          await p.query(
            `INSERT INTO watch_finishes (watch_id, finished_at, delivered)
             VALUES ($1, now() - make_interval(hours => $2), $3)`,
            [id, hoursAgo, delivered],
          );
          await p.query(
            `UPDATE watched_folders SET total_delivered = total_delivered + $2,
                    total_failed = total_failed + $3 WHERE id = $1`,
            [id, delivered ? 1 : 0, delivered ? 0 : 1],
          );
        },
        addEvent: async (id, level, message) => {
          await p.query('INSERT INTO watch_events (watch_id, level, message) VALUES ($1, $2, $3)', [
            id,
            level,
            message,
          ]);
        },
      },
    };
  });

  it('allows a watched item to repeat a source key, but not an uploaded one', async () => {
    const p = await ready();
    const { rows } = await p.query<{ id: string }>(
      `INSERT INTO decomposition_batches (target_id, created_by) VALUES ('default', '{}') RETURNING id`,
    );
    const batch = rows[0]!.id;
    const add = (watched: boolean) =>
      p.query(
        `INSERT INTO decomposition_items
           (batch_id, source_key, filename, content_sha256, size_bytes, object_key, watched)
         VALUES ($1, 'same.docx', 'same.docx', 'sha', 1, NULL, $2)`,
        [batch, watched],
      );
    await add(true);
    await add(true);
    await add(false);
    await expect(add(false)).rejects.toThrow(/decomposition_items_batch_source_idx/);
    await p.query('DELETE FROM decomposition_items WHERE batch_id = $1', [batch]);
    await p.query('DELETE FROM decomposition_batches WHERE id = $1', [batch]);
  });
});
