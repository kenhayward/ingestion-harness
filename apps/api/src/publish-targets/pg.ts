import type pg from 'pg';
import type { TargetView } from '@ih/bridge-contract';
import {
  DEFAULT_TARGET_ID,
  blocksRemoval,
  type PublishTargetKind,
  type PublishTargetView,
  type TargetChoice,
  type TargetLayout,
  type TargetUsage,
} from '@ih/shared';
import { kindOf } from './place.js';
import {
  byDefaultThenLabel,
  EMPTY_USAGE,
  toView,
  type CacheFacts,
  type LegacyKeys,
  type PublishTargetRepo,
  type TargetRecord,
} from './repo.js';

interface Row {
  id: string;
  label: string;
  kind: PublishTargetKind;
  sink_id: string;
  instance_id: string | null;
  connection_id: string | null;
  destination: Record<string, string>;
  lanes: number | null;
  on_bridge: boolean;
  synced_at: Date | null;
  source: 'env' | 'ui';
  seeded_at: Date | null;
  edited_at: Date | null;
  updated_by: string | null;
  created_at: Date;
}

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

const toRecord = (r: Row): TargetRecord => ({
  id: r.id,
  label: r.label,
  kind: r.kind,
  sinkId: r.sink_id,
  instanceId: r.instance_id,
  connectionId: r.connection_id,
  destination: r.destination,
  lanes: r.lanes,
  onBridge: r.on_bridge,
  syncedAt: iso(r.synced_at),
  source: r.source,
  seededAt: iso(r.seeded_at),
  editedAt: iso(r.edited_at),
  updatedBy: r.updated_by,
  createdAt: r.created_at.toISOString(),
});

/** The cache's columns (the old S3 and key columns are no longer read: a later migration drops them). */
const COLUMNS = `id, label, kind, sink_id, instance_id, connection_id, destination, lanes,
  on_bridge, synced_at, source, seeded_at, edited_at, updated_by, created_at`;

/**
 * Rows made inert (`inert_at`: a removed target, or a dropped external target of a copy restore,
 * that delivery records may still name) are kept for the foreign keys and to keep their id
 * taken only: never listed, offered, read or changed.
 */
const LIVE = 'inert_at IS NULL';

export class PgPublishTargetRepo implements PublishTargetRepo {
  constructor(private readonly pool: pg.Pool) {}

  async list(): Promise<PublishTargetView[]> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM publish_targets WHERE ${LIVE}
        ORDER BY (id = $1) DESC, created_at, id`,
      [DEFAULT_TARGET_ID],
    );
    const usage = await this.usageOf(null);
    return rows.map((r) => toView(toRecord(r), usage.get(r.id) ?? EMPTY_USAGE));
  }

  async get(id: string): Promise<TargetRecord | null> {
    const { rows } = await this.pool.query<Row>(
      `SELECT ${COLUMNS} FROM publish_targets WHERE id = $1 AND ${LIVE}`,
      [id],
    );
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * One statement: the bridge's fields always; CT Studio's facts only when named (`by`: who
   * edited it, and when, if the row was there already). `inert_at` is never written.
   */
  async cache(view: TargetView, facts: CacheFacts = {}): Promise<TargetRecord> {
    const { rows } = await this.pool.query<Row>(
      `INSERT INTO publish_targets AS t
         (id, label, kind, sink_id, instance_id, connection_id, destination, on_bridge, synced_at,
          source, seeded_at, updated_by, lanes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, true, now(), coalesce($8, 'ui'), $9, $10, $13)
       ON CONFLICT (id) DO UPDATE SET
         label = EXCLUDED.label,
         kind = EXCLUDED.kind,
         sink_id = EXCLUDED.sink_id,
         instance_id = EXCLUDED.instance_id,
         connection_id = EXCLUDED.connection_id,
         destination = EXCLUDED.destination,
         on_bridge = true,
         synced_at = now(),
         source = coalesce($8, t.source),
         seeded_at = CASE WHEN $11 THEN EXCLUDED.seeded_at ELSE t.seeded_at END,
         updated_by = CASE WHEN $12 THEN EXCLUDED.updated_by ELSE t.updated_by END,
         edited_at = CASE WHEN $12 THEN now() ELSE t.edited_at END,
         lanes = CASE WHEN $14 THEN EXCLUDED.lanes ELSE t.lanes END
       RETURNING ${COLUMNS}`,
      [
        view.id,
        view.label,
        kindOf(view),
        view.sinkId,
        view.instanceId,
        view.connectionId,
        JSON.stringify(view.destination),
        facts.source ?? null,
        facts.seededAt ?? null,
        facts.by ?? null,
        facts.seededAt !== undefined,
        facts.by !== undefined,
        facts.lanes ?? null,
        facts.lanes !== undefined,
      ],
    );
    return toRecord(rows[0]!);
  }

  async markMissing(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    await this.pool.query(
      'UPDATE publish_targets SET on_bridge = false WHERE id = ANY($1::text[])',
      [ids],
    );
  }

  async cachedIds(): Promise<{ id: string; live: boolean }[]> {
    const { rows } = await this.pool.query<{ id: string; live: boolean }>(
      `SELECT id, ${LIVE} AS live FROM publish_targets ORDER BY id`,
    );
    return rows;
  }

  async remove(
    id: string,
    onBridge?: () => Promise<boolean>,
  ): Promise<'deleted' | 'missing' | 'default' | 'seeded' | 'in_use' | 'refused'> {
    if (id === DEFAULT_TARGET_ID) return 'default';
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<{ kind: string }>(
        `SELECT kind FROM publish_targets WHERE id = $1 AND ${LIVE} FOR UPDATE`,
        [id],
      );
      if (found.rowCount === 0) {
        await client.query('ROLLBACK');
        return 'missing';
      }
      if (found.rows[0]!.kind === 'rdf') {
        await client.query('ROLLBACK');
        return 'seeded';
      }
      if (blocksRemoval((await this.usageOf(id, client)).get(id) ?? EMPTY_USAGE)) {
        await client.query('ROLLBACK');
        return 'in_use';
      }
      // The bridge removes it while this row is locked: a job output or graph copy recorded
      // against it meanwhile waits for the lock, then commits naming the now inert target (the
      // foreign key holds; it is not refused). A recipe naming it takes no lock at all: its
      // documents go to review, as they do for any recipe naming a removed target.
      if (onBridge && !(await onBridge())) {
        await client.query('ROLLBACK');
        return 'refused';
      }
      // Made inert, not deleted: delivery records (job_deliveries) may still name it, and its id
      // stays taken, as the bridge never takes a removed target's id again. Any keys it still had
      // waiting to move to the bridge go with it.
      await client.query('UPDATE publish_targets SET inert_at = now() WHERE id = $1', [id]);
      await client.query('DELETE FROM publish_target_legacy_keys WHERE id = $1', [id]);
      await client.query('COMMIT');
      return 'deleted';
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async usage(id: string): Promise<TargetUsage> {
    return (await this.usageOf(id)).get(id) ?? EMPTY_USAGE;
  }

  async choices(): Promise<TargetChoice[]> {
    const { rows } = await this.pool.query<{
      id: string;
      label: string;
      kind: 'internal' | 'external';
      bucket: string;
      prefix: string;
      layout: TargetLayout;
    }>(
      `SELECT t.id, t.label, t.kind, p.bucket, p.prefix, p.layout
         FROM publish_targets t, target_s3_place(t.destination, t.sink_id) p
        WHERE t.${LIVE} AND t.kind IN ('internal', 'external')`,
    );
    const sinks = await this.pool.query<{ id: string; label: string }>(
      `SELECT t.id, t.label FROM publish_targets t WHERE t.${LIVE} AND t.kind = 'sink'`,
    );
    return [
      ...rows.map((r) => ({ ...r, sinkName: null, patternFields: [] })),
      ...sinks.rows.map((r) => ({
        id: r.id,
        label: r.label,
        kind: 'sink' as const,
        bucket: '',
        prefix: '',
        layout: null,
        sinkName: null,
        patternFields: [],
      })),
    ].sort(byDefaultThenLabel);
  }

  async version(): Promise<number> {
    const { rows } = await this.pool.query<{ version: string }>(
      'SELECT version FROM publish_targets_state',
    );
    return Number(rows[0]?.version ?? 0);
  }

  async legacyKeys(): Promise<LegacyKeys[]> {
    const { rows } = await this.pool.query<{
      id: string;
      endpoint: string | null;
      region: string | null;
      access_key_id: string | null;
      secret_key_enc: string | null;
      access_key_env: string | null;
      secret_key_env: string | null;
      force_path_style: boolean;
      moved_to_bridge_at: Date | null;
      connection_id: string | null;
    }>(
      `SELECT id, endpoint, region, access_key_id, secret_key_enc, access_key_env, secret_key_env,
              force_path_style, moved_to_bridge_at, connection_id
         FROM publish_target_legacy_keys ORDER BY id`,
    );
    return rows.map((r) => ({
      id: r.id,
      endpoint: r.endpoint,
      region: r.region,
      accessKeyId: r.access_key_id,
      secretKeyEnc: r.secret_key_enc,
      accessKeyEnv: r.access_key_env,
      secretKeyEnv: r.secret_key_env,
      forcePathStyle: r.force_path_style,
      movedToBridgeAt: iso(r.moved_to_bridge_at),
      connectionId: r.connection_id,
    }));
  }

  async dropLegacyKeys(id: string): Promise<void> {
    await this.pool.query('DELETE FROM publish_target_legacy_keys WHERE id = $1', [id]);
  }

  async chooseLegacyConnection(id: string, connectionId: string): Promise<void> {
    await this.pool.query(
      'UPDATE publish_target_legacy_keys SET connection_id = $2 WHERE id = $1',
      [id, connectionId],
    );
  }

  async connectionOf(id: string): Promise<string | null> {
    return (await this.get(id))?.connectionId ?? null;
  }

  /** Usage per target (one id, or all when null), from the four places a target is named. */
  private async usageOf(
    id: string | null,
    db: pg.Pool | pg.PoolClient = this.pool,
  ): Promise<Map<string, TargetUsage>> {
    const out = new Map<string, TargetUsage>();
    const at = (target: string): TargetUsage => {
      let u = out.get(target);
      if (!u) {
        u = {
          publishedVersions: 0,
          documentTypes: [],
          deliveredOutputs: 0,
          consumers: 0,
          pendingJobs: 0,
        };
        out.set(target, u);
      }
      return u;
    };
    const published = await db.query<{ target: string; template: string; versions: string }>(
      `SELECT p.target, t.id AS template, count(*) AS versions
         FROM templates t CROSS JOIN LATERAL publish_to_ids(t.definition) AS p(target)
        WHERE t.status = 'published' AND ($1::text IS NULL OR p.target = $1)
        GROUP BY 1, 2 ORDER BY 2`,
      [id],
    );
    for (const r of published.rows) {
      const u = at(r.target);
      u.publishedVersions += Number(r.versions);
      u.documentTypes.push(r.template);
    }
    const delivered = await db.query<{ target: string; n: string }>(
      `SELECT target_id AS target, sum(n) AS n FROM (
         SELECT target_id, count(*) AS n FROM job_outputs
          WHERE target_id IS NOT NULL AND ($1::text IS NULL OR target_id = $1) GROUP BY 1
         UNION ALL
         SELECT target_id, count(*) FROM published_graph_versions
          WHERE $1::text IS NULL OR target_id = $1 GROUP BY 1
         UNION ALL
         -- Another sink's target records no outputs: its deliveries are what it was handed.
         SELECT d.target_id, count(*) FROM job_deliveries d
           JOIN publish_targets t ON t.id = d.target_id AND t.kind = 'sink'
          WHERE $1::text IS NULL OR d.target_id = $1 GROUP BY 1
       ) d GROUP BY 1`,
      [id],
    );
    for (const r of delivered.rows) at(r.target).deliveredOutputs = Number(r.n);
    const consumers = await db.query<{ target: string; n: string }>(
      `SELECT target_id AS target, count(*) AS n FROM s3_consumer_targets
        WHERE $1::text IS NULL OR target_id = $1 GROUP BY 1`,
      [id],
    );
    for (const r of consumers.rows) at(r.target).consumers = Number(r.n);
    // A withdrawal still to run deletes through the targets its params name (a republish
    // delivers through its published version's target, counted above).
    const pending = await db.query<{ target: string; n: string }>(
      `SELECT t.target, count(DISTINCT j.id) AS n
         FROM jobs j,
              LATERAL (
                SELECT e->>'target' AS target
                  FROM jsonb_array_elements(coalesce(j.params->'objects', '[]'::jsonb)) e
                UNION
                SELECT e->>'target'
                  FROM jsonb_array_elements(coalesce(j.params->'graphs', '[]'::jsonb)) e
              ) t
        WHERE j.task = 'withdraw' AND j.status IN ('queued', 'running')
          AND t.target IS NOT NULL AND ($1::text IS NULL OR t.target = $1)
        GROUP BY 1`,
      [id],
    );
    for (const r of pending.rows) at(r.target).pendingJobs = Number(r.n);
    return out;
  }
}
