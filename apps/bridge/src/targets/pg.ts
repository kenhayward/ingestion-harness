import type pg from 'pg';
import type { Target, TargetRepo } from './repo.js';

interface Row {
  id: string;
  label: string;
  sink_id: string;
  instance_id: string | null;
  connection_id: string | null;
  destination: Record<string, string>;
}

const toTarget = (r: Row): Target => ({
  id: r.id,
  label: r.label,
  sinkId: r.sink_id,
  instanceId: r.instance_id,
  connectionId: r.connection_id,
  destination: r.destination,
});

const SELECT =
  'SELECT id, label, sink_id, instance_id, connection_id, destination FROM bridge.targets';

export class PgTargetRepo implements TargetRepo {
  constructor(private readonly pool: pg.Pool) {}

  async get(id: string): Promise<Target | null> {
    const { rows } = await this.pool.query<Row>(`${SELECT} WHERE id = $1`, [id]);
    return rows[0] ? toTarget(rows[0]) : null;
  }

  async list(): Promise<Target[]> {
    const { rows } = await this.pool.query<Row>(`${SELECT} ORDER BY id`);
    return rows.map(toTarget);
  }

  async put(t: Target): Promise<void> {
    await this.pool.query(
      `INSERT INTO bridge.targets (id, label, sink_id, instance_id, connection_id, destination)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, sink_id = EXCLUDED.sink_id,
         instance_id = EXCLUDED.instance_id, connection_id = EXCLUDED.connection_id,
         destination = EXCLUDED.destination, updated_at = now()`,
      [t.id, t.label, t.sinkId, t.instanceId, t.connectionId, JSON.stringify(t.destination)],
    );
  }
}
