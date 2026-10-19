import type pg from 'pg';
import {
  DEFAULT_TARGET_ID,
  TRIPLE_STORE_TARGET_ID,
  targetInUse,
  type PublishTargetView,
  type TargetChoice,
  type TargetUsage,
} from '@ih/shared';
import {
  byDefaultThenLabel,
  EMPTY_USAGE,
  patched,
  rdfRecord,
  rdfSeedDiffers,
  recordFrom,
  seeded,
  toView,
  type NewTarget,
  type PublishTargetRepo,
  type SeedOutcome,
  type TargetPatch,
  type TargetRecord,
} from './repo.js';
import { seedDifferences, type DefaultSeed, type RdfSeed } from './seed.js';

interface Row {
  id: string;
  label: string;
  kind: 'internal' | 'external' | 'rdf';
  bucket: string;
  prefix: string;
  endpoint: string | null;
  region: string | null;
  access_key_id: string | null;
  secret_key_enc: string | null;
  access_key_env: string | null;
  secret_key_env: string | null;
  force_path_style: boolean;
  sse: 'none' | 'AES256' | 'aws:kms';
  kms_key_id: string | null;
  storage_class: string | null;
  source: 'env' | 'ui';
  seeded_at: Date | null;
  edited_at: Date | null;
  updated_by: string | null;
  created_at: Date;
  connection_id: string | null;
  moved_to_bridge_at: Date | null;
}

const iso = (d: Date | null): string | null => d?.toISOString() ?? null;

const toRecord = (r: Row): TargetRecord => ({
  id: r.id,
  label: r.label,
  kind: r.kind,
  bucket: r.bucket,
  prefix: r.prefix,
  endpoint: r.endpoint,
  region: r.region,
  accessKeyId: r.access_key_id,
  secretKeyEnc: r.secret_key_enc,
  accessKeyEnv: r.access_key_env,
  secretKeyEnv: r.secret_key_env,
  forcePathStyle: r.force_path_style,
  sse: r.sse,
  kmsKeyId: r.kms_key_id,
  storageClass: r.storage_class,
  source: r.source,
  seededAt: iso(r.seeded_at),
  editedAt: iso(r.edited_at),
  updatedBy: r.updated_by,
  createdAt: r.created_at.toISOString(),
  connectionId: r.connection_id,
  movedToBridgeAt: iso(r.moved_to_bridge_at),
});

const COLUMNS = `id, label, kind, bucket, prefix, endpoint, region, access_key_id, secret_key_enc,
  access_key_env, secret_key_env, force_path_style, sse, kms_key_id, storage_class, source,
  seeded_at, edited_at, updated_by, created_at, connection_id, moved_to_bridge_at`;

/**
 * Rows a copy restore made inert (`inert_at`: a dropped external target its delivery records
 * still name) are kept for the foreign keys only: never listed, offered, read or changed.
 */
const LIVE = 'inert_at IS NULL';

/** The columns an update or a seed rewrites, in `values()` order. */
const WRITE = [
  'label',
  'bucket',
  'prefix',
  'endpoint',
  'region',
  'access_key_id',
  'secret_key_enc',
  'access_key_env',
  'secret_key_env',
  'force_path_style',
  'sse',
  'kms_key_id',
  'storage_class',
  'source',
  'seeded_at',
  'edited_at',
  'updated_by',
  'connection_id',
] as const;

const values = (r: TargetRecord): unknown[] => [
  r.label,
  r.bucket,
  r.prefix,
  r.endpoint,
  r.region,
  r.accessKeyId,
  r.secretKeyEnc,
  r.accessKeyEnv,
  r.secretKeyEnv,
  r.forcePathStyle,
  r.sse,
  r.kmsKeyId,
  r.storageClass,
  r.source,
  r.seededAt,
  r.editedAt,
  r.updatedBy,
  r.connectionId,
];

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

  async create(input: NewTarget, by: string | null): Promise<PublishTargetView | 'exists'> {
    const r = recordFrom(input, by, new Date());
    const { rowCount } = await this.pool.query(
      `INSERT INTO publish_targets (id, kind, ${WRITE.join(', ')})
       VALUES ($1, $2, ${WRITE.map((_, i) => `$${i + 3}`).join(', ')})
       ON CONFLICT (id) DO NOTHING`,
      [r.id, r.kind, ...values(r)],
    );
    if (rowCount === 0) return 'exists';
    return toView(r, (await this.usageOf(r.id)).get(r.id) ?? EMPTY_USAGE);
  }

  async update(
    id: string,
    patch: TargetPatch,
    by: string | null,
  ): Promise<PublishTargetView | null> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<Row>(
        `SELECT ${COLUMNS} FROM publish_targets WHERE id = $1 AND ${LIVE} FOR UPDATE`,
        [id],
      );
      if (!rows[0]) {
        await client.query('ROLLBACK');
        return null;
      }
      const next = patched(toRecord(rows[0]), patch, by, new Date());
      await client.query(
        `UPDATE publish_targets SET ${WRITE.map((c, i) => `${c} = $${i + 2}`).join(', ')}
         WHERE id = $1`,
        [id, ...values(next)],
      );
      await client.query('COMMIT');
      return toView(next, (await this.usageOf(id)).get(id) ?? EMPTY_USAGE);
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async remove(id: string): Promise<'deleted' | 'missing' | 'default' | 'seeded' | 'in_use'> {
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
      if (targetInUse((await this.usageOf(id, client)).get(id) ?? EMPTY_USAGE)) {
        await client.query('ROLLBACK');
        return 'in_use';
      }
      try {
        await client.query('DELETE FROM publish_targets WHERE id = $1', [id]);
      } catch (e) {
        // A row recorded against it between the count and the delete: the foreign key says in use.
        if ((e as { code?: string }).code === '23503') {
          await client.query('ROLLBACK');
          return 'in_use';
        }
        throw e;
      }
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
    const { rows } = await this.pool.query<TargetChoice>(
      `SELECT id, label, kind, bucket FROM publish_targets WHERE ${LIVE} AND kind <> 'rdf'`,
    );
    return rows.sort(byDefaultThenLabel);
  }

  async version(): Promise<number> {
    const { rows } = await this.pool.query<{ version: string }>(
      'SELECT version FROM publish_targets_state',
    );
    return Number(rows[0]?.version ?? 0);
  }

  async seedDefault(seed: DefaultSeed): Promise<SeedOutcome> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<Row>(
        `SELECT ${COLUMNS} FROM publish_targets WHERE id = $1 FOR UPDATE`,
        [DEFAULT_TARGET_ID],
      );
      if (!rows[0]) throw new Error('the default publishing target row is missing');
      const current = toRecord(rows[0]);
      if (current.seededAt !== null) {
        await client.query('ROLLBACK');
        return seedDifferences(current, seed).length > 0 ? 'differs' : 'kept';
      }
      const next = seeded(current, seed, new Date());
      await client.query(
        `UPDATE publish_targets SET kind = $2, ${WRITE.map((c, i) => `${c} = $${i + 3}`).join(', ')}
         WHERE id = $1`,
        [DEFAULT_TARGET_ID, next.kind, ...values(next)],
      );
      await client.query('COMMIT');
      return 'seeded';
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async seedRdf(seed: RdfSeed): Promise<SeedOutcome> {
    const r = rdfRecord(seed, new Date());
    const inserted = await this.pool.query(
      `INSERT INTO publish_targets (id, kind, ${WRITE.join(', ')})
       VALUES ($1, $2, ${WRITE.map((_, i) => `$${i + 3}`).join(', ')})
       ON CONFLICT (id) DO NOTHING`,
      [r.id, r.kind, ...values(r)],
    );
    if (inserted.rowCount) return 'seeded';
    const stored = await this.get(TRIPLE_STORE_TARGET_ID);
    return stored && rdfSeedDiffers(stored, seed) ? 'differs' : 'kept';
  }

  async markMoved(id: string, connectionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE publish_targets
          SET connection_id = $2, secret_key_enc = NULL, moved_to_bridge_at = now()
        WHERE id = $1`,
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
      `SELECT coalesce(definition->'delivery'->>'publishTo', $2) AS target, id AS template,
              count(*) AS versions
         FROM templates WHERE status = 'published'
          AND ($1::text IS NULL OR coalesce(definition->'delivery'->>'publishTo', $2) = $1)
        GROUP BY 1, 2 ORDER BY 2`,
      [id, DEFAULT_TARGET_ID],
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
