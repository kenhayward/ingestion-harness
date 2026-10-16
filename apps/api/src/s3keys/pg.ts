import type pg from 'pg';
import type { S3Consumer, S3Key, S3KeyRepo, S3KeyStatus } from './repo.js';

const STATUS = `CASE WHEN k.revoked_at IS NOT NULL THEN 'revoked'
                     WHEN k.expires_at IS NOT NULL AND k.expires_at <= now() THEN 'expired'
                     ELSE 'active' END`;
const ACTIVE = `k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())`;
const KEY_COLUMNS = `k.id, k.consumer_id, k.access_key_id, k.created_at, k.expires_at,
                     k.revoked_at, ${STATUS} AS status`;

interface KeyRow {
  id: string;
  consumer_id: string;
  access_key_id: string;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  status: S3KeyStatus;
}

interface ConsumerRow {
  id: string;
  label: string;
  user_name: string;
  created_at: Date;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function toKey(r: KeyRow): S3Key {
  return {
    id: r.id,
    accessKeyId: r.access_key_id,
    createdAt: r.created_at.toISOString(),
    expiresAt: iso(r.expires_at),
    revokedAt: iso(r.revoked_at),
    status: r.status,
  };
}

/** S3 consumer and key metadata in Postgres (migration 0010). Semantics match MemoryS3KeyRepo. */
export class PgS3KeyRepo implements S3KeyRepo {
  constructor(private readonly pool: pg.Pool) {}

  async createConsumer(id: string, label: string, userName: string): Promise<void> {
    await this.pool.query(`INSERT INTO s3_consumers (id, label, user_name) VALUES ($1, $2, $3)`, [
      id,
      label,
      userName,
    ]);
  }

  async addKey(
    consumerId: string,
    accessKeyId: string,
    expiresInDays: number | null,
    rotatedFrom: string | null,
  ): Promise<S3Key> {
    const { rows } = await this.pool.query<KeyRow>(
      `WITH k AS (
         INSERT INTO s3_access_keys (consumer_id, access_key_id, expires_at, rotated_from)
         VALUES ($1, $2,
                 CASE WHEN $3::int IS NULL THEN NULL ELSE now() + make_interval(days => $3::int) END,
                 $4)
         RETURNING *)
       SELECT ${KEY_COLUMNS} FROM k`,
      [consumerId, accessKeyId, expiresInDays, rotatedFrom],
    );
    return toKey(rows[0]!);
  }

  async listConsumers(): Promise<S3Consumer[]> {
    return this.consumers(`ORDER BY c.created_at DESC`, []);
  }

  async getConsumer(id: string): Promise<S3Consumer | null> {
    return (await this.consumers(`WHERE c.id::text = $1`, [id]))[0] ?? null;
  }

  async findKey(id: string) {
    const { rows } = await this.pool.query<KeyRow & { user_name: string }>(
      `SELECT ${KEY_COLUMNS}, c.user_name
         FROM s3_access_keys k JOIN s3_consumers c ON c.id = k.consumer_id
        WHERE k.id::text = $1`,
      [id],
    );
    const row = rows[0];
    return row ? { key: toKey(row), consumerId: row.consumer_id, userName: row.user_name } : null;
  }

  async revokeKey(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE s3_access_keys SET revoked_at = COALESCE(revoked_at, now()) WHERE id = $1`,
      [id],
    );
  }

  async capExpiry(consumerId: string, days: number, exceptKeyId: string): Promise<void> {
    await this.pool.query(
      `UPDATE s3_access_keys k
          SET expires_at = LEAST(COALESCE(k.expires_at, 'infinity'),
                                 now() + make_interval(days => $2::int))
        WHERE k.consumer_id = $1 AND k.id <> $3 AND ${ACTIVE}`,
      [consumerId, days, exceptKeyId],
    );
  }

  async deleteConsumer(id: string): Promise<void> {
    await this.pool.query(`DELETE FROM s3_consumers WHERE id = $1`, [id]); // keys cascade
  }

  async grants(consumerId: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ target_id: string }>(
      `SELECT target_id FROM s3_consumer_targets WHERE consumer_id = $1 ORDER BY target_id`,
      [consumerId],
    );
    return rows.map((r) => r.target_id);
  }

  async setGrants(consumerId: string, targetIds: string[]): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM s3_consumer_targets WHERE consumer_id = $1`, [consumerId]);
      await client.query(
        `INSERT INTO s3_consumer_targets (consumer_id, target_id)
         SELECT $1, t FROM unnest($2::text[]) AS t`,
        [consumerId, [...new Set(targetIds)]],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private async consumers(where: string, params: unknown[]): Promise<S3Consumer[]> {
    const { rows } = await this.pool.query<ConsumerRow>(
      `SELECT c.* FROM s3_consumers c ${where}`,
      params,
    );
    if (rows.length === 0) return [];
    const keys = await this.pool.query<KeyRow>(
      `SELECT ${KEY_COLUMNS} FROM s3_access_keys k
        WHERE k.consumer_id = ANY($1::uuid[]) ORDER BY k.created_at DESC`,
      [rows.map((r) => r.id)],
    );
    const targets = await this.pool.query<{ consumer_id: string; target_id: string }>(
      `SELECT consumer_id, target_id FROM s3_consumer_targets
        WHERE consumer_id = ANY($1::uuid[]) ORDER BY target_id`,
      [rows.map((r) => r.id)],
    );
    return rows.map((c) => ({
      id: c.id,
      label: c.label,
      userName: c.user_name,
      createdAt: c.created_at.toISOString(),
      keys: keys.rows.filter((k) => k.consumer_id === c.id).map(toKey),
      targets: targets.rows.filter((t) => t.consumer_id === c.id).map((t) => t.target_id),
    }));
  }
}
