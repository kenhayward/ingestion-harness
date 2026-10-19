import type pg from 'pg';
import {
  connectionProblem,
  type Connection,
  type ConnectionRepo,
  type ConnectionStatus,
  type NewConnection,
} from './repo.js';

interface Row {
  id: string;
  kind: Connection['kind'];
  owner: string | null;
  sink_id: string;
  instance_id: string | null;
  name: string;
  fields: Record<string, string>;
  secret_set: boolean;
  secret_env: string | null;
  status: ConnectionStatus;
  status_reason: string | null;
  last_used_at: Date | null;
}

const toConnection = (r: Row): Connection => ({
  id: r.id,
  kind: r.kind,
  owner: r.owner,
  sinkId: r.sink_id,
  instanceId: r.instance_id,
  name: r.name,
  fields: r.fields,
  secretSet: r.secret_set,
  secretEnv: r.secret_env,
  status: r.status,
  statusReason: r.status_reason,
  lastUsedAt: r.last_used_at,
});

const SELECT = `SELECT id, kind, owner, sink_id, instance_id, name, fields,
  secret_enc IS NOT NULL AS secret_set, secret_env, status, status_reason, last_used_at
  FROM bridge.connections`;

/** ConnectionRepo on schema `bridge`; the ciphertext leaves the table only through secretOf. */
export class PgConnectionRepo implements ConnectionRepo {
  constructor(private readonly pool: pg.Pool) {}

  async list(filter: { kind?: 'shared' | 'personal'; owner?: string }): Promise<Connection[]> {
    const { rows } = await this.pool.query<Row>(
      `${SELECT} WHERE ($1::text IS NULL OR kind = $1) AND ($2::text IS NULL OR owner = $2)
       ORDER BY id`,
      [filter.kind ?? null, filter.owner ?? null],
    );
    return rows.map(toConnection);
  }

  async get(id: string): Promise<Connection | null> {
    const { rows } = await this.pool.query<Row>(`${SELECT} WHERE id = $1`, [id]);
    return rows[0] ? toConnection(rows[0]) : null;
  }

  async put(c: NewConnection): Promise<void> {
    const problem = connectionProblem(c);
    if (problem) throw new Error(problem);
    const keep = c.secretEnc === undefined;
    await this.pool.query(
      `INSERT INTO bridge.connections
         (id, kind, owner, sink_id, instance_id, name, fields, secret_enc, secret_env, status, status_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, owner = EXCLUDED.owner,
         sink_id = EXCLUDED.sink_id, instance_id = EXCLUDED.instance_id, name = EXCLUDED.name,
         fields = EXCLUDED.fields,
         secret_enc = CASE WHEN $12 THEN bridge.connections.secret_enc ELSE EXCLUDED.secret_enc END,
         secret_env = EXCLUDED.secret_env, status = EXCLUDED.status,
         status_reason = EXCLUDED.status_reason, updated_at = now()`,
      [
        c.id,
        c.kind,
        c.owner,
        c.sinkId,
        c.instanceId,
        c.name,
        JSON.stringify(c.fields),
        c.secretEnc ?? null,
        c.secretEnv,
        c.status,
        c.statusReason,
        keep,
      ],
    );
  }

  async remove(id: string): Promise<'deleted' | 'missing' | 'in_use'> {
    const { rows } = await this.pool.query<{ used: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM bridge.targets WHERE connection_id = $1) AS used',
      [id],
    );
    if (rows[0]!.used) return 'in_use';
    const { rowCount } = await this.pool.query('DELETE FROM bridge.connections WHERE id = $1', [
      id,
    ]);
    return rowCount ? 'deleted' : 'missing';
  }

  async secretOf(
    id: string,
  ): Promise<{ secretEnc: string | null; secretEnv: string | null } | null> {
    const { rows } = await this.pool.query<{
      secret_enc: string | null;
      secret_env: string | null;
    }>('SELECT secret_enc, secret_env FROM bridge.connections WHERE id = $1', [id]);
    return rows[0] ? { secretEnc: rows[0].secret_enc, secretEnv: rows[0].secret_env } : null;
  }

  async mark(
    id: string,
    status: ConnectionStatus,
    reason: string | null,
    usedAt?: Date,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE bridge.connections
          SET status = $2, status_reason = $3, last_used_at = COALESCE($4, last_used_at),
              updated_at = now()
        WHERE id = $1`,
      [id, status, reason, usedAt ?? null],
    );
  }
}
