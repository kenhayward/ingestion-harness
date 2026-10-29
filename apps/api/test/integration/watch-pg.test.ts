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
    const batches = new Map<string, string>();
    let n = 0;
    const item = async (id: string, outcome: string) => {
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
      await p.query(
        `INSERT INTO decomposition_items
           (batch_id, source_key, filename, content_sha256, size_bytes, object_key, outcome, watched)
         VALUES ($1, $2, 'a.docx', 'sha', 1, 'k', $3, true)`,
        [batch, `k-${++n}`, outcome],
      );
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
        addUnfinished: (id, outcome) => item(id, outcome),
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
