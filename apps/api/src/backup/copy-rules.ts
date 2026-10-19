/**
 * Restore as a copy (production → staging): the rules that run inside the restored side
 * database before it is swapped in. What a copy drops from the backup it keeps from this server:
 * the LLM configuration, GitHub settings, linked-data settings, data-lake consumers and
 * publishing targets are staging's; production's external targets become inert, their delivery
 * records withdrawn; nothing from the backup that reaches production's outside world survives
 * (GitHub links and tokens, external targets' credentials, queued work).
 * Spec: docs/superpowers/specs/2026-10-17-backup-and-restore-design.md, "Restore as a copy".
 */
import type pg from 'pg';
import type { RestoreReport } from '@ih/shared';

/** Tables whose rows a copy takes from this server, parents before children. */
export const KEPT_TABLES = [
  'llm_endpoints',
  'llm_models',
  'llm_choices',
  'llm_settings',
  'github_sync_settings',
  'linked_data_settings',
  'linked_data_base_history',
  's3_consumers',
  's3_access_keys',
  's3_consumer_targets',
] as const;
export type KeptTable = (typeof KEPT_TABLES)[number];

/**
 * Rows of each kept table as `row_to_json`, plus this server's live publishing targets and the
 * delivery bridge's connections (their secrets are under this server's BRIDGE_SECRETS_KEY, so
 * production's could not be read here anyway).
 */
export type KeptState = Record<KeptTable, unknown[]> & {
  targets: unknown[];
  bridgeConnections: unknown[];
};

/**
 * What the copy did, for the restore report, plus the graph IRIs whose records it dropped (they
 * name a withdrawn target): the restore deletes them from the triple store, since no record
 * points at them any more and the re-mint will not move them.
 */
export type CopyResult = NonNullable<RestoreReport['copy']> & { droppedGraphs: string[] };

const CANCEL_REASON = 'restored as a copy';

interface TargetRow {
  id: string;
  kind: 'internal' | 'external' | 'rdf';
}

const rowsOf = async (c: pg.ClientBase, sql: string, values: unknown[] = []) =>
  (await c.query<{ r: unknown }>(sql, values)).rows.map((row) => row.r);

/** Reads what a copy keeps from this server (`live`: the database about to be replaced). */
export async function readKeptState(live: pg.ClientBase): Promise<KeptState> {
  const kept = {} as Record<KeptTable, unknown[]>;
  for (const table of KEPT_TABLES) {
    kept[table] = await rowsOf(live, `SELECT row_to_json(t) AS r FROM ${table} t`);
  }
  // Inert rows are records of an earlier copy's production; this database's own are dropped.
  const targets = await rowsOf(
    live,
    'SELECT row_to_json(t) AS r FROM publish_targets t WHERE inert_at IS NULL',
  );
  const bridgeConnections = (await hasBridge(live))
    ? await rowsOf(live, 'SELECT row_to_json(c) AS r FROM bridge.connections c')
    : [];
  return { ...kept, targets, bridgeConnections };
}

/** Whether the database has the delivery bridge's schema (a backup from before it has not). */
async function hasBridge(c: pg.ClientBase): Promise<boolean> {
  const { rows } = await c.query<{ found: boolean }>(
    "SELECT to_regclass('bridge.connections') IS NOT NULL AS found",
  );
  return rows[0]!.found;
}

/** Applies the copy rules to the restored backup (`side`), in one transaction. */
export async function applyCopyRules(side: pg.ClientBase, kept: KeptState): Promise<CopyResult> {
  await side.query('BEGIN');
  try {
    const result = await apply(side, kept);
    await side.query('COMMIT');
    return result;
  } catch (err) {
    await side.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function apply(side: pg.ClientBase, kept: KeptState): Promise<CopyResult> {
  // 1. Production's backlog never runs here, whatever its task.
  const cancelled = await side.query(
    `WITH cancelled AS (
       UPDATE jobs SET status = 'cancelled', locked_by = NULL, locked_at = NULL, updated_at = now()
        WHERE status IN ('queued', 'running', 'delivering')
        RETURNING id)
     INSERT INTO job_events (job_id, level, message, data)
     SELECT id, 'warn', 'cancelled', $1::jsonb FROM cancelled`,
    [JSON.stringify({ reason: CANCEL_REASON })],
  );

  // 2. GitHub: no links, push records, link attempts or linked accounts of production's.
  await side.query('DELETE FROM template_github_pushes');
  await side.query('DELETE FROM template_github_links');
  await side.query('DELETE FROM github_link_states');
  await side.query(
    `UPDATE user_profiles
        SET github_id = NULL, github_login = NULL, github_avatar_url = NULL,
            github_token_enc = NULL, github_linked_at = NULL, github_repo = NULL
      WHERE github_id IS NOT NULL OR github_repo IS NOT NULL`,
  );

  // 3a. Production's kept-table rows go, children first (s3_consumer_targets names targets).
  for (const table of [...KEPT_TABLES].reverse()) await side.query(`DELETE FROM ${table}`);

  // 4. Publishing targets.
  const targets = await replaceTargets(side, kept.targets as TargetRow[]);

  // 3b. This server's rows, parents first (its consumers' targets now exist).
  for (const table of KEPT_TABLES) {
    await side.query(
      `INSERT INTO ${table} SELECT * FROM json_populate_recordset(null::${table}, $1::json)`,
      [JSON.stringify(kept[table])],
    );
  }
  await side.query(
    `SELECT setval(pg_get_serial_sequence('linked_data_base_history', 'id'),
                   coalesce(max(id), 0) + 1, false) FROM linked_data_base_history`,
  );
  await side.query('UPDATE llm_config_state SET version = version + 1');
  await side.query('UPDATE publish_targets_state SET version = version + 1');

  // 4b. The delivery bridge: this server's connections, production's work stopped.
  if (await hasBridge(side)) await keepBridge(side, kept.bridgeConnections);

  // 5. What the report lists for an admin to fix.
  return {
    cancelledJobs: cancelled.rowCount ?? 0,
    ...targets,
    ...(await recipesNeeding(side, kept)),
  };
}

/**
 * Staging's targets replace production's on a shared id and are added otherwise; production's
 * external-only targets, and its triple store target when this server has none, become inert
 * (no endpoint, no credentials or writer user), so nothing here delivers to production. The delivery records of every
 * target whose objects are not in this server's own SeaweedFS under that id (an inert one, or a
 * shared id that is not internal on both sides) are withdrawn, and their graph records dropped.
 */
async function replaceTargets(side: pg.ClientBase, staging: TargetRow[]) {
  const backup = (await side.query<TargetRow>('SELECT id, kind FROM publish_targets')).rows;
  const stagingById = new Map(staging.map((t) => [t.id, t]));
  const dropped = backup.filter(
    (t) => (t.kind === 'external' || t.kind === 'rdf') && !stagingById.has(t.id),
  );
  const withdrawn = [
    ...dropped.map((t) => t.id),
    ...backup
      .filter((t) => {
        const s = stagingById.get(t.id);
        return s !== undefined && !(s.kind === 'internal' && t.kind === 'internal');
      })
      .map((t) => t.id),
  ];

  const columns = (
    await side.query<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'publish_targets' AND column_name <> 'id'
        ORDER BY ordinal_position`,
    )
  ).rows.map((r) => `"${r.name}"`);
  const backupIds = new Set(backup.map((t) => t.id));
  for (const row of staging) {
    if (backupIds.has(row.id)) {
      await side.query(
        `UPDATE publish_targets SET (${columns.join(', ')}) =
           (SELECT ${columns.join(', ')} FROM json_populate_record(null::publish_targets, $1::json))
          WHERE id = $2`,
        [JSON.stringify(row), row.id],
      );
    } else {
      await side.query(
        'INSERT INTO publish_targets SELECT * FROM json_populate_record(null::publish_targets, $1::json)',
        [JSON.stringify(row)],
      );
    }
  }
  const droppedIds = dropped.map((t) => t.id).sort();
  await side.query(
    `UPDATE publish_targets
        SET inert_at = now(), endpoint = NULL, region = NULL, access_key_id = NULL,
            secret_key_enc = NULL, access_key_env = NULL, secret_key_env = NULL, kms_key_id = NULL
      WHERE id = ANY($1::text[])`,
    [droppedIds],
  );

  const outputs = await side.query(
    `UPDATE job_outputs SET withdrawn_at = now()
      WHERE target_id = ANY($1::text[]) AND stage = 'published' AND withdrawn_at IS NULL`,
    [withdrawn],
  );
  // The re-mint walks published_graphs and a job deletion withdraws published_graph_versions:
  // neither may reach for a copy that is not here.
  const graphs = await side.query<{ graph_iri: string }>(
    'DELETE FROM published_graphs WHERE target_id = ANY($1::text[]) RETURNING graph_iri',
    [withdrawn],
  );
  await side.query('DELETE FROM published_graph_versions WHERE target_id = ANY($1::text[])', [
    withdrawn,
  ]);

  return {
    droppedTargets: droppedIds,
    withdrawnOutputs: outputs.rowCount ?? 0,
    droppedGraphs: [...new Set(graphs.rows.map((g) => g.graph_iri))].sort(),
  };
}

/**
 * The bridge's side of a copy: this server's shared connections replace production's (whose
 * secrets are under production's key); a restored bridge target naming a connection this server
 * lacks loses it, so its deliveries fail visibly until an admin picks one; production's
 * unfinished deliveries are failed and its unsent events dropped, so nothing it queued is
 * delivered or reported from here. Restored targets are mirrored again after the swap.
 */
async function keepBridge(side: pg.ClientBase, connections: unknown[]): Promise<void> {
  await side.query(
    `UPDATE bridge.deliveries
        SET status = 'failed', lease_until = NULL, claim_id = NULL, updated_at = now(),
            error = $1::jsonb
      WHERE status IN ('queued', 'running', 'waiting')`,
    [JSON.stringify({ class: 'retryable', code: 'internal', message: CANCEL_REASON })],
  );
  await side.query('UPDATE bridge.events SET sent_at = now() WHERE sent_at IS NULL');
  const ids = (connections as { id: string }[]).map((c) => c.id);
  await side.query(
    `CREATE TEMP TABLE kept_target_connections ON COMMIT DROP AS
       SELECT id, connection_id FROM bridge.targets WHERE connection_id = ANY($1::text[])`,
    [ids],
  );
  await side.query(
    'UPDATE bridge.targets SET connection_id = NULL WHERE connection_id IS NOT NULL',
  );
  await side.query('DELETE FROM bridge.connections');
  await side.query(
    `INSERT INTO bridge.connections
     SELECT * FROM json_populate_recordset(null::bridge.connections, $1::json)`,
    [JSON.stringify(connections)],
  );
  await side.query(
    `UPDATE bridge.targets t SET connection_id = k.connection_id
       FROM kept_target_connections k WHERE k.id = t.id`,
  );
}

interface KeptEndpoint {
  name: string;
  enabled: boolean;
}
interface KeptModel {
  provider: string;
  model_id: string;
  curated: boolean;
  enabled: boolean;
}

/**
 * Recipes (any version) naming a model this server does not offer (a choice id it lacks, or an
 * `endpoint/model` ref not curated on an enabled endpoint; `default` is always there), and
 * recipes delivering to a target that is inert or absent here.
 */
async function recipesNeeding(side: pg.ClientBase, kept: KeptState) {
  const choices = new Set((kept.llm_choices as { id: string }[]).map((c) => c.id));
  const enabled = new Set(
    (kept.llm_endpoints as KeptEndpoint[]).filter((e) => e.enabled).map((e) => e.name),
  );
  const offered = new Set(
    (kept.llm_models as KeptModel[])
      .filter((m) => m.curated && m.enabled && enabled.has(m.provider))
      .map((m) => `${m.provider}/${m.model_id}`),
  );
  const runs = (model: string) =>
    model === 'default' || (model.includes('/') ? offered.has(model) : choices.has(model));

  const models = await side.query<{ id: string; model: string }>(
    `SELECT DISTINCT id, model FROM (
       SELECT id, definition->>'model' AS model FROM templates
       UNION ALL
       SELECT t.id, s->>'model' FROM templates t,
              jsonb_array_elements(CASE jsonb_typeof(t.definition->'pipeline')
                                     WHEN 'array' THEN t.definition->'pipeline' ELSE '[]' END) s
     ) m WHERE model IS NOT NULL`,
  );
  const needingModel = new Set(models.rows.filter((r) => !runs(r.model)).map((r) => r.id));

  const needingTarget = await side.query<{ id: string }>(
    `SELECT DISTINCT t.id FROM templates t
      WHERE t.definition->'delivery'->>'publishTo' IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM publish_targets p
                         WHERE p.id = t.definition->'delivery'->>'publishTo' AND p.inert_at IS NULL)
      ORDER BY t.id`,
  );
  return {
    recipesNeedingModel: [...needingModel].sort(),
    recipesNeedingTarget: needingTarget.rows.map((r) => r.id),
  };
}
