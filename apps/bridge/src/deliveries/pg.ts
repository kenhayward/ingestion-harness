import type pg from 'pg';
import {
  applyTransition,
  type ClaimedRow,
  eventFor,
  type DeliveryRepo,
  FINAL_STATUSES,
  type DeliveryRow,
  type NewDelivery,
  type NewPackage,
  type OutboxEvent,
  type Transition,
} from './repo.js';

const COLUMNS = `id, package_id, target_id, idempotency_key, acting_user, overrides, destination, status, attempts,
  run_after, sink_job_id, error, receipt, skipped_for, claim_id, created_at, updated_at`;

interface Row {
  id: string;
  package_id: string;
  target_id: string;
  idempotency_key: string;
  acting_user: DeliveryRow['actingUser'];
  overrides: Record<string, string>;
  destination: Record<string, string> | null;
  status: DeliveryRow['status'];
  attempts: number;
  run_after: Date;
  sink_job_id: string | null;
  error: DeliveryRow['error'];
  receipt: DeliveryRow['receipt'];
  skipped_for: string | null;
  claim_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const toRow = (r: Row): DeliveryRow => ({
  id: r.id,
  packageId: r.package_id,
  targetId: r.target_id,
  idempotencyKey: r.idempotency_key,
  actingUser: r.acting_user,
  overrides: r.overrides,
  destination: r.destination,
  status: r.status,
  attempts: r.attempts,
  runAfter: r.run_after,
  sinkJobId: r.sink_job_id,
  error: r.error,
  receipt: r.receipt,
  skippedFor: r.skipped_for,
  claimId: r.claim_id,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));

/** DeliveryRepo on schema `bridge`; claims with FOR UPDATE SKIP LOCKED. */
export class PgDeliveryRepo implements DeliveryRepo {
  constructor(private readonly pool: pg.Pool) {}

  private async tx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private async emit(c: pg.PoolClient, row: DeliveryRow, now: Date): Promise<void> {
    const { rows } = await c.query<{ next: number }>(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM bridge.events WHERE delivery_id = $1',
      [row.id],
    );
    const body = eventFor(row, rows[0]!.next, now);
    await c.query(
      `INSERT INTO bridge.events (id, delivery_id, sequence, body, run_after)
       VALUES ($1, $2, $3, $4, $5)`,
      [body.eventId, row.id, body.sequence, JSON.stringify(body), now],
    );
  }

  async create(pkg: NewPackage, deliveries: NewDelivery[], now: Date): Promise<void> {
    await this.tx(async (c) => {
      await c.query(
        `INSERT INTO bridge.packages (id, kind, idempotency_key, manifest, staged_key, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          pkg.id,
          pkg.kind,
          pkg.idempotencyKey,
          JSON.stringify(pkg.manifest),
          pkg.stagedKey,
          now,
          pkg.expiresAt,
        ],
      );
      for (const d of deliveries) {
        const { rows } = await c.query<Row>(
          `INSERT INTO bridge.deliveries
             (id, package_id, target_id, idempotency_key, acting_user, overrides, destination, status, run_after, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $8, 'queued', $7, $7, $7)
           RETURNING ${COLUMNS}`,
          [
            d.id,
            pkg.id,
            d.targetId,
            pkg.idempotencyKey,
            json(d.actingUser),
            JSON.stringify(d.overrides),
            now,
            d.destination === null ? null : JSON.stringify(d.destination),
          ],
        );
        await this.emit(c, toRow(rows[0]!), now);
      }
    });
  }

  async claim(now: Date, leaseSeconds: number): Promise<ClaimedRow | null> {
    const { rows } = await this.pool.query<Row>(
      `UPDATE bridge.deliveries
          SET attempts = attempts + CASE WHEN status = 'waiting' THEN 0 ELSE 1 END,
              status = 'running', claim_id = gen_random_uuid(), updated_at = $1,
              lease_until = $1 + make_interval(secs => $2)
        WHERE id = (
          SELECT id FROM bridge.deliveries
           WHERE (status IN ('queued', 'waiting') AND run_after <= $1)
              OR (status = 'running' AND lease_until < $1)
           ORDER BY run_after, created_at, id
           FOR UPDATE SKIP LOCKED
           LIMIT 1)
        RETURNING ${COLUMNS}`,
      [now, leaseSeconds],
    );
    return rows[0] ? (toRow(rows[0]) as ClaimedRow) : null;
  }

  async transition(id: string, t: Transition, now: Date, claimId: string): Promise<boolean> {
    return this.tx(async (c) => {
      const { rows } = await c.query<Row>(
        `SELECT ${COLUMNS} FROM bridge.deliveries
          WHERE id = $1 AND status = 'running' AND claim_id = $2 FOR UPDATE`,
        [id, claimId],
      );
      if (!rows[0]) return false;
      const next = applyTransition(toRow(rows[0]), t, now);
      await c.query(
        `UPDATE bridge.deliveries
            SET status = $2, run_after = $3, sink_job_id = $4, error = $5, receipt = $6,
                skipped_for = $7, updated_at = $8, lease_until = NULL, claim_id = NULL
          WHERE id = $1`,
        [
          id,
          next.status,
          next.runAfter,
          next.sinkJobId,
          json(next.error),
          json(next.receipt),
          next.skippedFor,
          now,
        ],
      );
      await this.emit(c, next, now);
      return true;
    });
  }

  async get(id: string): Promise<DeliveryRow | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM bridge.deliveries WHERE id = $1`,
      [id],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  async latestSucceeded(
    targetId: string,
    idempotencyKey: string,
    exceptId: string,
  ): Promise<DeliveryRow | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM bridge.deliveries
        WHERE target_id = $1 AND idempotency_key = $2 AND status = 'succeeded' AND id <> $3
        ORDER BY updated_at DESC LIMIT 1`,
      [targetId, idempotencyKey, exceptId],
    );
    return rows[0] ? toRow(rows[0]) : null;
  }

  async getPackage(id: string): Promise<NewPackage | null> {
    const { rows } = await this.pool.query<{
      id: string;
      kind: NewPackage['kind'];
      idempotency_key: string;
      manifest: unknown;
      staged_key: string;
      expires_at: Date | null;
    }>(
      'SELECT id, kind, idempotency_key, manifest, staged_key, expires_at FROM bridge.packages WHERE id = $1',
      [id],
    );
    const r = rows[0];
    return r
      ? {
          id: r.id,
          kind: r.kind,
          idempotencyKey: r.idempotency_key,
          manifest: r.manifest,
          stagedKey: r.staged_key,
          expiresAt: r.expires_at,
        }
      : null;
  }

  async usesTarget(targetId: string): Promise<boolean> {
    const { rows } = await this.pool.query<{ used: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM bridge.deliveries WHERE target_id = $1
         AND status NOT IN ('succeeded', 'skipped', 'needs_user', 'failed')) AS used`,
      [targetId],
    );
    return rows[0]!.used;
  }

  async expiredPackages(now: Date, limit: number): Promise<{ id: string; stagedKey: string }[]> {
    const { rows } = await this.pool.query<{ id: string; staged_key: string }>(
      `SELECT p.id, p.staged_key FROM bridge.packages p
        WHERE p.pruned_at IS NULL AND p.expires_at <= $1
          AND NOT EXISTS (SELECT 1 FROM bridge.deliveries d
                           WHERE d.package_id = p.id AND d.status::text <> ALL ($3::text[]))
        ORDER BY p.expires_at LIMIT $2`,
      [now, limit, [...FINAL_STATUSES]],
    );
    return rows.map((r) => ({ id: r.id, stagedKey: r.staged_key }));
  }

  async markPruned(id: string, now: Date): Promise<void> {
    await this.pool.query('UPDATE bridge.packages SET pruned_at = $2 WHERE id = $1', [id, now]);
  }

  async dueEvents(now: Date, limit: number): Promise<OutboxEvent[]> {
    const { rows } = await this.pool.query<{
      id: string;
      body: OutboxEvent['body'];
      attempts: number;
    }>(
      `SELECT id, body, attempts FROM bridge.events
        WHERE sent_at IS NULL AND run_after <= $1
        ORDER BY run_after, delivery_id, sequence LIMIT $2`,
      [now, limit],
    );
    return rows;
  }

  async markSent(eventId: string, now: Date): Promise<void> {
    await this.pool.query('UPDATE bridge.events SET sent_at = $2 WHERE id = $1', [eventId, now]);
  }

  async retryEvent(eventId: string, runAfter: Date): Promise<void> {
    await this.pool.query(
      'UPDATE bridge.events SET attempts = attempts + 1, run_after = $2 WHERE id = $1',
      [eventId, runAfter],
    );
  }
}
