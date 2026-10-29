import {
  healthOf,
  WATCH_CANCELLED_DETAIL,
  WATCH_LOCKED_SETTINGS,
  type StopBody,
  type WatchEvent,
  type WatchRunAs,
  type WatchSettings,
  type WatchState,
  type WatchView,
} from '@ih/shared';
import type pg from 'pg';
import { RUNNING_OUTCOMES } from '../conversions/repo.js';
import { NOT_AT_BRIDGE } from './repo.js';
import type {
  CancelledItem,
  CreateWatchResult,
  RemoveWatchResult,
  StopResult,
  UnfinishedItem,
  UpdateWatchResult,
  WatchRepo,
  WatchUpdate,
} from './repo.js';

interface WatchRow {
  id: string;
  name: string;
  target_id: string;
  source: Record<string, string>;
  source_path: string;
  run_as: WatchRunAs;
  force: boolean;
  auto_approve: boolean;
  reason_files: boolean;
  sleep_seconds: number;
  admit: number;
  state: WatchState;
  batch_id: string | null;
  problem: string | null;
  root_waiting: number;
  last_pickup_at: Date | null;
  total_delivered: string;
  total_failed: string;
  created_at: Date;
  in_progress: string;
  day_delivered: string;
  day_failed: string;
}

/** The watch with the figures read from its batches and finishes (the rest are its own columns). */
const SELECT = `
  SELECT w.id, w.name, w.target_id, w.source, w.source_path, w.run_as, w.force, w.auto_approve,
         w.reason_files, w.sleep_seconds, w.admit, w.state, w.batch_id, w.problem, w.root_waiting,
         w.last_pickup_at, w.total_delivered, w.total_failed, w.created_at,
         (SELECT count(*) FROM decomposition_items i
            JOIN decomposition_batches b ON b.id = i.batch_id
           WHERE b.watch_id = w.id AND i.outcome = ANY($1::text[])) AS in_progress,
         (SELECT count(*) FROM watch_finishes f
           WHERE f.watch_id = w.id AND f.delivered AND f.finished_at > now() - interval '24 hours')
           AS day_delivered,
         (SELECT count(*) FROM watch_finishes f
           WHERE f.watch_id = w.id AND NOT f.delivered AND f.finished_at > now() - interval '24 hours')
           AS day_failed
    FROM watched_folders w`;

const viewOf = (r: WatchRow): WatchView => ({
  id: r.id,
  name: r.name,
  targetId: r.target_id,
  source: r.source,
  force: r.force,
  autoApprove: r.auto_approve,
  reasonFiles: r.reason_files,
  sleepSeconds: r.sleep_seconds,
  admit: r.admit,
  state: r.state,
  health: healthOf({ state: r.state, problem: r.problem }),
  problem: r.problem,
  sourcePath: r.source_path,
  runAs: r.run_as,
  queue: { waiting: r.root_waiting, inProgress: Number(r.in_progress) },
  throughput: {
    day: { delivered: Number(r.day_delivered), failed: Number(r.day_failed) },
    total: { delivered: Number(r.total_delivered), failed: Number(r.total_failed) },
  },
  lastPickupAt: r.last_pickup_at ? r.last_pickup_at.toISOString() : null,
  batchId: r.batch_id,
  createdAt: r.created_at.toISOString(),
});

const UNIQUE_VIOLATION = '23505';
const FOREIGN_KEY_VIOLATION = '23503';
const codeOf = (e: unknown): string | undefined => (e as { code?: string }).code;

/** Column of each updatable setting. */
const COLUMNS: Record<keyof WatchSettings, string> = {
  name: 'name',
  targetId: 'target_id',
  source: 'source',
  force: 'force',
  autoApprove: 'auto_approve',
  reasonFiles: 'reason_files',
  sleepSeconds: 'sleep_seconds',
  admit: 'admit',
};

/** Watched folders in Postgres (migration 202610291400). */
export class PgWatchRepo implements WatchRepo {
  constructor(private readonly pool: pg.Pool) {}

  private async one(db: pg.Pool | pg.PoolClient, id: string): Promise<WatchView | null> {
    const { rows } = await db.query<WatchRow>(`${SELECT} WHERE w.id = $2`, [RUNNING_OUTCOMES, id]);
    return rows[0] ? viewOf(rows[0]) : null;
  }

  async list() {
    const { rows } = await this.pool.query<WatchRow>(`${SELECT} ORDER BY lower(w.name)`, [
      RUNNING_OUTCOMES,
    ]);
    return rows.map(viewOf);
  }

  async get(id: string) {
    return this.one(this.pool, id);
  }

  async create(
    s: WatchSettings,
    runAs: WatchRunAs,
    sourcePath: string,
    createdBy: WatchRunAs,
  ): Promise<CreateWatchResult> {
    try {
      const { rows } = await this.pool.query<{ id: string }>(
        `INSERT INTO watched_folders
           (name, target_id, source, source_path, run_as, force, auto_approve, reason_files,
            sleep_seconds, admit, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [
          s.name,
          s.targetId,
          JSON.stringify(s.source),
          sourcePath,
          JSON.stringify(runAs),
          s.force,
          s.autoApprove,
          s.reasonFiles,
          s.sleepSeconds,
          s.admit,
          JSON.stringify(createdBy),
        ],
      );
      return { ok: true, watch: (await this.one(this.pool, rows[0]!.id))! };
    } catch (e) {
      if (codeOf(e) === UNIQUE_VIOLATION) return { ok: false, reason: 'name_taken' };
      if (codeOf(e) === FOREIGN_KEY_VIOLATION) return { ok: false, reason: 'unknown_target' };
      throw e;
    }
  }

  async update(
    id: string,
    patch: WatchUpdate,
    expectState?: WatchState,
  ): Promise<UpdateWatchResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ state: WatchState }>(
        'SELECT state FROM watched_folders WHERE id = $1 FOR UPDATE',
        [id],
      );
      const cur = rows[0];
      if (!cur) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'missing' };
      }
      if (expectState && cur.state !== expectState) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'state' };
      }
      const locked =
        patch.runAs !== undefined ||
        patch.sourcePath !== undefined ||
        WATCH_LOCKED_SETTINGS.some((k) => patch.settings[k] !== undefined);
      if (locked && cur.state !== 'stopped') {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'running' };
      }
      const sets: string[] = ['updated_at = now()'];
      const values: unknown[] = [];
      const set = (column: string, value: unknown) => {
        values.push(value);
        sets.push(`${column} = $${values.length + 1}`);
      };
      for (const [key, value] of Object.entries(patch.settings)) {
        if (value === undefined) continue;
        set(COLUMNS[key as keyof WatchSettings], key === 'source' ? JSON.stringify(value) : value);
      }
      if (patch.runAs) set('run_as', JSON.stringify(patch.runAs));
      if (patch.sourcePath !== undefined) set('source_path', patch.sourcePath);
      await client.query(`UPDATE watched_folders SET ${sets.join(', ')} WHERE id = $1`, [
        id,
        ...values,
      ]);
      const watch = (await this.one(client, id))!;
      await client.query('COMMIT');
      return { ok: true, watch };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (codeOf(e) === UNIQUE_VIOLATION) return { ok: false, reason: 'name_taken' };
      if (codeOf(e) === FOREIGN_KEY_VIOLATION) return { ok: false, reason: 'unknown_target' };
      throw e;
    } finally {
      client.release();
    }
  }

  async setState(id: string, state: WatchState) {
    // Starting makes the worker look at once.
    const { rowCount } = await this.pool.query(
      `UPDATE watched_folders
          SET state = $2, updated_at = now(),
              next_look_at = CASE WHEN $2 = 'running' THEN now() ELSE next_look_at END
        WHERE id = $1`,
      [id, state],
    );
    return rowCount ? this.one(this.pool, id) : null;
  }

  async start(id: string) {
    const { rowCount } = await this.pool.query(
      `WITH started AS (
         UPDATE watched_folders
            SET state = 'running', problem = NULL, next_look_at = now(), updated_at = now()
          WHERE id = $1
          RETURNING id),
       retried AS (
         -- Moves the sink refused are tried again: an admin cleared the folder, stopped and started.
         UPDATE watch_pickups SET move_failures = 0
          WHERE watch_id IN (SELECT id FROM started) AND move_failures > 0
            AND step NOT IN ('finished', 'abandoned'))
       SELECT id FROM started`,
      [id],
    );
    return rowCount ? this.one(this.pool, id) : null;
  }

  async stop(id: string, mode: StopBody['mode']): Promise<StopResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ state: WatchState }>(
        'SELECT state FROM watched_folders WHERE id = $1 FOR UPDATE',
        [id],
      );
      const state = rows[0]?.state;
      if (!state) {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'missing' };
      }
      if (mode === 'drain' ? state !== 'running' : state === 'stopped') {
        await client.query('ROLLBACK');
        return { ok: false, reason: 'state' };
      }
      await client.query(
        `UPDATE watched_folders SET state = $2, updated_at = now() WHERE id = $1`,
        [id, mode === 'drain' ? 'draining' : 'stopped'],
      );
      const cancelled: CancelledItem[] = [];
      const dropped: string[] = [];
      if (mode === 'now') {
        // Files taken but not queued are let go (the worker's admit would abandon them on a
        // stopped watch too): their copies go back to the caller to delete.
        const letGo = await client.query<{ object_key: string | null }>(
          `UPDATE watch_pickups SET step = 'abandoned', updated_at = now()
            WHERE watch_id = $1 AND step IN ('stored', 'moved')
           RETURNING object_key`,
          [id],
        );
        dropped.push(...letGo.rows.flatMap((r) => (r.object_key ? [r.object_key] : [])));
        // The items first, locked: the worker's own writes to them wait. Then their jobs,
        // locked too (a claim cannot slip in), to see which a worker holds.
        const items = await client.query<{ id: string; batch_id: string; job_id: string | null }>(
          `SELECT i.id, i.batch_id, i.job_id FROM decomposition_items i
             JOIN decomposition_batches b ON b.id = i.batch_id
            WHERE b.watch_id = $1 AND i.outcome = ANY($2::text[])
            ORDER BY i.id FOR UPDATE OF i`,
          [id, NOT_AT_BRIDGE],
        );
        const jobIds = items.rows.flatMap((r) => (r.job_id ? [r.job_id] : []));
        const jobs = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM jobs WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
          [jobIds],
        );
        const running = new Set(jobs.rows.filter((j) => j.status === 'running').map((j) => j.id));
        await client.query(
          `WITH cancelled AS (
             UPDATE jobs SET status = 'cancelled', locked_by = NULL, locked_at = NULL,
                             updated_at = now()
              WHERE id = ANY($1::uuid[]) AND status IN ('queued', 'running')
              RETURNING id)
           INSERT INTO job_events (job_id, level, message)
           SELECT id, 'warn', 'cancelled' FROM cancelled`,
          [jobIds],
        );
        // A running job's item is the worker's to decide: it fails it on noticing the cancel,
        // or, if it was past its last check, goes on to deliver it. Nothing is written over it.
        const direct = items.rows.filter((r) => !(r.job_id && running.has(r.job_id)));
        const ids = direct.map((r) => r.id);
        if (ids.length) {
          await client.query(
            `UPDATE decomposition_items
                SET outcome = 'failed', detail = $2, finished_at = now()
              WHERE id = ANY($1::uuid[]) AND outcome = ANY($3::text[])`,
            [ids, WATCH_CANCELLED_DETAIL, NOT_AT_BRIDGE],
          );
          await client.query(
            `UPDATE watch_pickups SET step = 'abandoned', updated_at = now()
              WHERE watch_id = $1 AND item_id = ANY($2::uuid[])
                AND step NOT IN ('finished', 'abandoned')`,
            [id, ids],
          );
          await client.query(
            `INSERT INTO watch_finishes (watch_id, delivered)
             SELECT $1, false FROM generate_series(1, $2::int)`,
            [id, ids.length],
          );
          await client.query(
            `UPDATE watched_folders SET total_failed = total_failed + $2 WHERE id = $1`,
            [id, ids.length],
          );
        }
        cancelled.push(...direct.map((r) => ({ itemId: r.id, batchId: r.batch_id })));
      }
      const watch = (await this.one(client, id))!;
      await client.query('COMMIT');
      return { ok: true, watch, cancelled, dropped };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async countForTarget(targetId: string) {
    const { rows } = await this.pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM watched_folders WHERE target_id = $1',
      [targetId],
    );
    return Number(rows[0]!.n);
  }

  async remove(id: string): Promise<RemoveWatchResult> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM watched_folders WHERE id = $1 AND state = 'stopped'`,
      [id],
    );
    if (rowCount) return 'removed';
    const { rows } = await this.pool.query('SELECT 1 FROM watched_folders WHERE id = $1', [id]);
    return rows.length ? 'not_stopped' : 'missing';
  }

  async events(id: string, limit = 100): Promise<WatchEvent[]> {
    const { rows } = await this.pool.query<{
      id: string;
      at: Date;
      level: WatchEvent['level'];
      message: string;
      details: unknown;
    }>(
      `SELECT id, at, level, message, details FROM watch_events
        WHERE watch_id = $1 ORDER BY id DESC LIMIT $2`,
      [id, limit],
    );
    return rows.map((r) => ({
      id: Number(r.id),
      at: r.at.toISOString(),
      level: r.level,
      message: r.message,
      details: r.details ?? null,
    }));
  }

  async unfinishedItems(id: string): Promise<UnfinishedItem[]> {
    const { rows } = await this.pool.query<{ id: string; job_id: string | null; outcome: string }>(
      `SELECT i.id, i.job_id, i.outcome FROM decomposition_items i
         JOIN decomposition_batches b ON b.id = i.batch_id
        WHERE b.watch_id = $1 AND i.outcome = ANY($2::text[])
        ORDER BY i.created_at, i.id`,
      [id, RUNNING_OUTCOMES],
    );
    return rows.map((r) => ({ itemId: r.id, jobId: r.job_id, outcome: r.outcome }));
  }

  async problemCount() {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM watched_folders WHERE state <> 'stopped' AND problem IS NOT NULL`,
    );
    return Number(rows[0]!.n);
  }
}
