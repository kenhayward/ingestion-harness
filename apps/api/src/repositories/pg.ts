import { randomUUID } from 'node:crypto';
import pg from 'pg';
import type { MetricsData } from '../metrics.js';
import type {
  JobDetail,
  JobStatus,
  JobSummary,
  ModelInfo,
  ProviderKind,
  Reference,
  RerunRequest,
  ResultSummary,
  ReviewEdit,
  StepRun,
  OutputFormat,
  SuggestParams,
} from '@ih/shared';
import { DELETABLE_STATUSES, modelRef, sourceContentType, type Creator } from '@ih/shared';
import {
  ReferenceConflictError,
  type DeleteJobResult,
  type IngestionRepo,
  type JobEventRecord,
  type QueueStats,
  type JobReview,
  type ListJobsQuery,
  type ListPublishedQuery,
  type RetryOptions,
  SEGMENT_PRIORITY,
  type SegmentJob,
  type SegmentJobParams,
  type GraphJobParams,
  type PluginJobParams,
  type NewDocument,
  type NewReference,
  type NewEdit,
  type StoredObject,
  WORKBENCH_PRIORITY,
  type WorkbenchJobOptions,
  type WithdrawalStatus,
  BACKGROUND_JOBS,
  type BackgroundTask,
  graphWithdrawals,
  type WithdrawnGraph,
  type DeliveryUpdate,
  backgroundFinish,
  finishEvent,
  type JobDelivery,
  type JobFinish,
  type EventFilter,
} from './types.js';

// Inner-joins documents, so document-less jobs (segment previews) never become JobSummaries.
// Any query on `jobs` that does not go through JOB_SELECT must exclude `document_id IS NULL` rows.
const JOB_SELECT = `
  SELECT j.id, j.document_id, d.filename, d.object_key, d.spec_id, d.spec_version, j.status,
         j.model_override, j.attempts, j.error, j.task, j.test, j.reference_id, j.project_id, j.created_by, j.created_by_user, j.review_reasons, j.reviewer,
         j.review_note, j.reviewed_at, j.created_at, j.updated_at,
         j.params->>'batchId' AS batch_id, j.started_at, j.finished_at,
         array(SELECT model FROM step_runs
                WHERE job_id = j.id AND model IS NOT NULL
                GROUP BY model ORDER BY min(started_at)) AS models_used
    FROM jobs j JOIN documents d ON d.id = j.document_id`;

interface SegmentRow {
  id: string;
  project_id: string;
  status: JobStatus;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  attempts?: number;
  max_attempts?: number;
}

const toSegmentJob = (r: SegmentRow): SegmentJob => ({
  id: r.id,
  projectId: r.project_id,
  status: r.status,
  error: r.error,
  createdAt: r.created_at.toISOString(),
  updatedAt: r.updated_at.toISOString(),
  ...(r.attempts === undefined ? {} : { attempts: r.attempts }),
  ...(r.max_attempts === undefined ? {} : { maxAttempts: r.max_attempts }),
});

interface JobRow {
  id: string;
  document_id: string;
  filename: string;
  object_key: string;
  spec_id: string;
  spec_version: number;
  status: JobStatus;
  model_override: string | null;
  models_used: string[];
  attempts: number;
  error: string | null;
  task: JobSummary['task'];
  test: boolean;
  reference_id: string | null;
  project_id: string | null;
  created_by: string | null;
  created_by_user: string | null;
  review_reasons: string[] | null;
  reviewer: string | null;
  review_note: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
  batch_id: string | null;
  started_at: Date | null;
  finished_at: Date | null;
}

function toSummary(r: JobRow): JobSummary {
  return {
    id: r.id,
    documentId: r.document_id,
    filename: r.filename,
    contentType: sourceContentType(r.object_key),
    specId: r.spec_id,
    specVersion: r.spec_version,
    status: r.status,
    modelOverride: r.model_override,
    modelsUsed: r.models_used,
    attempts: r.attempts,
    error: r.error,
    task: r.task,
    test: r.test,
    referenceId: r.reference_id,
    projectId: r.project_id,
    createdBy: r.created_by,
    createdByUser: r.created_by_user,
    reviewReasons: r.review_reasons,
    reviewer: r.reviewer,
    reviewNote: r.review_note,
    reviewedAt: r.reviewed_at ? r.reviewed_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    batchId: r.batch_id,
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
  };
}

interface EditRow {
  id: string;
  at: Date;
  field_id: string | null;
  table_id: string | null;
  row_number: number | null;
  column_id: string | null;
  old_value: unknown;
  new_value: unknown;
  editor: string | null;
  reason: string | null;
}

function toEdit(r: EditRow): ReviewEdit {
  return {
    id: Number(r.id),
    at: r.at.toISOString(),
    field: r.field_id,
    table: r.table_id,
    row: r.row_number,
    column: r.column_id,
    oldValue: r.old_value,
    newValue: r.new_value,
    editor: r.editor,
    reason: r.reason,
  };
}

interface ReferenceRow {
  id: string;
  template_id: string;
  name: string;
  document_id: string;
  source_job_id: string | null;
  expected: Reference['expected'];
  created_at: Date;
  template_version: number | null;
  copied_from: string | null;
  verified_outputs: unknown;
  superseded_at: Date | null;
}

const toReference = (r: ReferenceRow): Reference => ({
  id: r.id,
  templateId: r.template_id,
  name: r.name,
  documentId: r.document_id,
  sourceJobId: r.source_job_id,
  expected: r.expected,
  createdAt: r.created_at.toISOString(),
  templateVersion: r.template_version,
  copiedFrom: r.copied_from,
  verifiedOutputs: r.verified_outputs ?? null,
  supersededAt: r.superseded_at?.toISOString() ?? null,
});

/** Postgres-backed repo. Covered by integration tests (test/integration), not unit tests. */
async function queueBackground(
  client: pg.PoolClient,
  task: BackgroundTask,
  params: unknown,
  by: string | null,
): Promise<string> {
  const { priority, maxAttempts } = BACKGROUND_JOBS[task];
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO jobs (task, priority, max_attempts, params, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [task, priority, maxAttempts, JSON.stringify(params), by],
  );
  return rows[0]!.id;
}

/**
 * Forget graphs' current versions and their entity sources, then the entities no source names
 * any more: only those the removed sources named, locked first so that the sweep (a new
 * statement, a new snapshot) sees a source a concurrent publish committed meanwhile.
 */
async function forgetGraphs(client: pg.PoolClient, where: string, args: unknown[]) {
  const sources = await client.query<{ iri: string }>(
    `DELETE FROM published_entity_sources WHERE ${where} RETURNING iri`,
    args,
  );
  await client.query(`DELETE FROM published_graphs WHERE ${where}`, args);
  const iris = [...new Set(sources.rows.map((r) => r.iri))];
  if (!iris.length) return;
  await client.query(
    'SELECT 1 FROM published_entities WHERE iri = ANY($1) ORDER BY iri FOR UPDATE',
    [iris],
  );
  await client.query(
    `DELETE FROM published_entities e WHERE e.iri = ANY($1)
        AND NOT EXISTS (SELECT 1 FROM published_entity_sources s WHERE s.iri = e.iri)`,
    [iris],
  );
}

/** Each graph's lock (the worker's publish takes the same one), in a stable order. */
async function lockGraphs(client: pg.PoolClient, keys: { sha256: string; template_id: string }[]) {
  const sorted = [...keys].sort((a, b) =>
    `${a.sha256}:${a.template_id}`.localeCompare(`${b.sha256}:${b.template_id}`),
  );
  for (const k of sorted) {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('graph:' || $1 || ':' || $2))", [
      k.sha256,
      k.template_id,
    ]);
  }
}

/**
 * Inside a job deletion: what the job delivered (its published target objects and graph
 * versions) is queued for withdrawal; the graph itself only when the job published its current
 * version. Its version rows go. Null when it delivered nothing.
 */
async function withdrawJob(client: pg.PoolClient, jobId: string): Promise<string | null> {
  const objects = await client.query<{ bucket: string; key: string; target: string }>(
    `SELECT bucket, object_key AS key, target_id AS target FROM job_outputs
      WHERE job_id = $1 AND stage = 'published' AND withdrawn_at IS NULL ORDER BY object_key`,
    [jobId],
  );
  const keys = await client.query<{ sha256: string; template_id: string }>(
    'SELECT DISTINCT sha256, template_id FROM published_graph_versions WHERE job_id = $1',
    [jobId],
  );
  await lockGraphs(client, keys.rows);
  const versions = await client.query<{
    sha256: string;
    template_id: string;
    versions: { version: number; targetId: string }[];
    current_iri: string | null;
    current_target: string | null;
  }>(
    `SELECT v.sha256, v.template_id,
            json_agg(json_build_object('version', v.version, 'targetId', v.target_id)
                     ORDER BY v.version) AS versions,
            g.graph_iri AS current_iri, g.target_id AS current_target
       FROM published_graph_versions v
       LEFT JOIN published_graphs g
         ON g.sha256 = v.sha256 AND g.template_id = v.template_id AND g.job_id = $1
      WHERE v.job_id = $1
      GROUP BY v.sha256, v.template_id, g.graph_iri, g.target_id
      ORDER BY v.sha256, v.template_id`,
    [jobId],
  );
  const graphs: WithdrawnGraph[] = [];
  for (const r of versions.rows) {
    if (r.current_iri) {
      await forgetGraphs(client, 'sha256 = $1 AND template_id = $2', [r.sha256, r.template_id]);
    }
    graphs.push(
      ...graphWithdrawals(
        { sha256: r.sha256, templateId: r.template_id },
        r.versions,
        r.current_iri ? { graphIri: r.current_iri, targetId: r.current_target! } : null,
      ),
    );
  }
  await client.query('DELETE FROM published_graph_versions WHERE job_id = $1', [jobId]);
  if (!objects.rows.length && !graphs.length) return null;
  return queueBackground(client, 'withdraw', { objects: objects.rows, graphs }, null);
}

export class PgRepo implements IngestionRepo {
  constructor(private readonly pool: pg.Pool) {}

  static fromUrl(databaseUrl: string): PgRepo {
    return new PgRepo(new pg.Pool({ connectionString: databaseUrl, max: 10 }));
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  async createDocumentAndJob(
    doc: NewDocument,
    modelOverride: string | null,
    test = false,
    referenceId: string | null = null,
    params: Record<string, unknown> | null = null,
    createdBy: Creator | null = null,
  ): Promise<JobSummary> {
    return this.insertDocumentAndJob(doc, {
      modelOverride,
      test,
      referenceId,
      projectId: null,
      task: 'process',
      priority: 0,
      params,
      createdBy,
    });
  }

  async createWorkbenchJob(
    doc: NewDocument,
    { projectId, task, params, referenceId, modelOverride, createdBy }: WorkbenchJobOptions,
  ) {
    return this.insertDocumentAndJob(doc, {
      modelOverride: modelOverride ?? null,
      test: true,
      referenceId: referenceId ?? null,
      projectId,
      task,
      priority: WORKBENCH_PRIORITY,
      params: params ?? null,
      createdBy: createdBy ?? null,
    });
  }

  async createDraftJob(projectId: string, params: Record<string, unknown>) {
    const { rows } = await this.pool.query<SegmentRow>(
      `INSERT INTO jobs (project_id, task, test, priority, max_attempts, params)
       VALUES ($1, 'draft', true, $2, 3, $3)
       RETURNING id, project_id, status, error, created_at, updated_at`,
      [projectId, WORKBENCH_PRIORITY, JSON.stringify(params)],
    );
    return toSegmentJob(rows[0]!);
  }

  async createFinishedDraftJob(projectId: string, params: Record<string, unknown>) {
    const { rows } = await this.pool.query<SegmentRow>(
      `INSERT INTO jobs (project_id, task, test, priority, max_attempts, params, status)
       VALUES ($1, 'draft', true, $2, 3, $3, 'succeeded')
       RETURNING id, project_id, status, error, created_at, updated_at`,
      [projectId, WORKBENCH_PRIORITY, JSON.stringify(params)],
    );
    return toSegmentJob(rows[0]!);
  }

  async listDraftJobs(projectId: string) {
    const { rows } = await this.pool.query<SegmentRow>(
      `SELECT id, project_id, status, error, created_at, updated_at, attempts, max_attempts
         FROM jobs
        WHERE project_id = $1 AND task = 'draft' ORDER BY created_at DESC, id DESC`,
      [projectId],
    );
    return rows.map(toSegmentJob);
  }

  async createExportJob(projectId: string, params: Record<string, unknown>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // One export per project: serialize concurrent starts so neither misses the other's insert.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext('export:' || $1))`, [projectId]);
      const removed = await client.query<{ id: string }>(
        `DELETE FROM jobs WHERE project_id = $1 AND task = 'export' RETURNING id`,
        [projectId],
      );
      const { rows } = await client.query<SegmentRow>(
        `INSERT INTO jobs (project_id, task, test, priority, max_attempts, params)
         VALUES ($1, 'export', true, $2, 3, $3)
         RETURNING id, project_id, status, error, created_at, updated_at`,
        [projectId, WORKBENCH_PRIORITY, JSON.stringify(params)],
      );
      await client.query('COMMIT');
      return { job: toSegmentJob(rows[0]!), removed: removed.rows.map((r) => r.id) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listExportJobs(projectId: string) {
    const { rows } = await this.pool.query<SegmentRow>(
      `SELECT id, project_id, status, error, created_at, updated_at FROM jobs
        WHERE project_id = $1 AND task = 'export' ORDER BY created_at DESC, id DESC`,
      [projectId],
    );
    return rows.map(toSegmentJob);
  }

  async createSegmentJob(projectId: string, params: SegmentJobParams) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // READ COMMITTED lets two concurrent calls both miss each other's insert; serialize per project.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId]);
      // Deleting a running job is safe: the claim guard stops its status writes, and the worker
      // notices the cancellation and removes its own result object.
      const removed = await client.query<{ id: string }>(
        `DELETE FROM jobs WHERE project_id = $1 AND task = 'segment' RETURNING id`,
        [projectId],
      );
      const { rows } = await client.query<SegmentRow>(
        `INSERT INTO jobs (project_id, task, test, priority, max_attempts, params)
         VALUES ($1, 'segment', true, $2, 1, $3)
         RETURNING id, project_id, status, error, created_at, updated_at`,
        [projectId, SEGMENT_PRIORITY, JSON.stringify(params)],
      );
      await client.query('COMMIT');
      return { job: toSegmentJob(rows[0]!), removed: removed.rows.map((r) => r.id) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async createGraphJob(projectId: string, params: GraphJobParams) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialized with the project's segment previews: one lock per project.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId]);
      const removed = await client.query<{ id: string }>(
        `DELETE FROM jobs WHERE project_id = $1 AND task = 'graph' RETURNING id`,
        [projectId],
      );
      const { rows } = await client.query<SegmentRow>(
        `INSERT INTO jobs (project_id, task, test, priority, max_attempts, params)
         VALUES ($1, 'graph', true, $2, 1, $3)
         RETURNING id, project_id, status, error, created_at, updated_at`,
        [projectId, SEGMENT_PRIORITY, JSON.stringify(params)],
      );
      await client.query('COMMIT');
      return { job: toSegmentJob(rows[0]!), removed: removed.rows.map((r) => r.id) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async createPluginJob(projectId: string, params: PluginJobParams) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialized with the project's other previews: one lock per project.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId]);
      const removed = await client.query<{ id: string }>(
        `DELETE FROM jobs WHERE project_id = $1 AND task = 'plugin' RETURNING id`,
        [projectId],
      );
      const { rows } = await client.query<SegmentRow>(
        `INSERT INTO jobs (project_id, task, test, priority, max_attempts, params)
         VALUES ($1, 'plugin', true, $2, 1, $3)
         RETURNING id, project_id, status, error, created_at, updated_at`,
        [projectId, SEGMENT_PRIORITY, JSON.stringify(params)],
      );
      await client.query('COMMIT');
      return { job: toSegmentJob(rows[0]!), removed: removed.rows.map((r) => r.id) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getPluginJob(projectId: string, id: string) {
    const { rows } = await this.pool.query<SegmentRow>(
      `SELECT id, project_id, status, error, created_at, updated_at FROM jobs
        WHERE id = $1 AND project_id = $2 AND task = 'plugin'`,
      [id, projectId],
    );
    return rows[0] ? toSegmentJob(rows[0]) : null;
  }

  async getGraphJob(projectId: string, id: string) {
    const { rows } = await this.pool.query<SegmentRow>(
      `SELECT id, project_id, status, error, created_at, updated_at FROM jobs
        WHERE id = $1 AND project_id = $2 AND task = 'graph'`,
      [id, projectId],
    );
    return rows[0] ? toSegmentJob(rows[0]) : null;
  }
  async createSuggestJob(projectId: string, params: SuggestParams) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialized with the project's segment and graph previews: one lock per project.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId]);
      const removed = await client.query<{ id: string }>(
        `DELETE FROM jobs WHERE project_id = $1 AND task = 'suggest' RETURNING id`,
        [projectId],
      );
      const { rows } = await client.query<SegmentRow>(
        `INSERT INTO jobs (project_id, task, test, priority, max_attempts, params)
         VALUES ($1, 'suggest', true, $2, 3, $3)
         RETURNING id, project_id, status, error, created_at, updated_at`,
        [projectId, SEGMENT_PRIORITY, JSON.stringify(params)],
      );
      await client.query('COMMIT');
      return { job: toSegmentJob(rows[0]!), removed: removed.rows.map((r) => r.id) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async latestSuggestJob(projectId: string) {
    const { rows } = await this.pool.query<SegmentRow & { params: SuggestParams }>(
      `SELECT id, project_id, status, error, created_at, updated_at, params FROM jobs
        WHERE project_id = $1 AND task = 'suggest' ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    return rows[0] ? { ...toSegmentJob(rows[0]), params: rows[0].params } : null;
  }

  async getSegmentJob(projectId: string, id: string) {
    const { rows } = await this.pool.query<SegmentRow>(
      `SELECT id, project_id, status, error, created_at, updated_at FROM jobs
        WHERE id = $1 AND project_id = $2 AND task = 'segment'`,
      [id, projectId],
    );
    return rows[0] ? toSegmentJob(rows[0]) : null;
  }

  async listProjectJobs(projectId: string): Promise<JobSummary[]> {
    const { rows } = await this.pool.query<JobRow>(
      `${JOB_SELECT} WHERE j.project_id = $1 ORDER BY j.created_at DESC`,
      [projectId],
    );
    return rows.map(toSummary);
  }

  async listProjectRuns(projectId: string): Promise<{ job: JobSummary; sha256: string }[]> {
    const { rows } = await this.pool.query<JobRow & { sha256: string }>(
      `SELECT jb.*, d.sha256 FROM (${JOB_SELECT} WHERE j.project_id = $1 AND j.task IN ('process', 'rerun', 'publish')) jb
         JOIN documents d ON d.id = jb.document_id
        ORDER BY jb.created_at DESC, jb.id DESC`,
      [projectId],
    );
    return rows.map((r) => ({ job: toSummary(r), sha256: r.sha256 }));
  }

  private async insertDocumentAndJob(
    doc: NewDocument,
    job: {
      modelOverride: string | null;
      test: boolean;
      referenceId: string | null;
      projectId: string | null;
      task: 'process' | 'prepare';
      priority: number;
      params: Record<string, unknown> | null;
      createdBy: Creator | null;
    },
  ): Promise<JobSummary> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO documents (id, filename, sha256, size_bytes, spec_id, spec_version, bucket, object_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          doc.id,
          doc.filename,
          doc.sha256,
          doc.sizeBytes,
          doc.specId,
          doc.specVersion,
          doc.bucket,
          doc.objectKey,
        ],
      );
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO jobs (document_id, model_override, test, reference_id, project_id, task, priority, params, created_by, created_by_user)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          doc.id,
          job.modelOverride,
          job.test,
          job.referenceId,
          job.projectId,
          job.task,
          job.priority,
          job.params === null ? null : JSON.stringify(job.params),
          job.createdBy?.name ?? null,
          job.createdBy?.userId ?? null,
        ],
      );
      await client.query('COMMIT');
      return (await this.getJob(rows[0]!.id))!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async countUnfinishedJobsWithModel(model: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM jobs
        WHERE model_override = $1 AND status IN ('queued', 'running', 'awaiting_review')`,
      [model],
    );
    return Number(rows[0]!.n);
  }

  async listJobs({ limit, status, mine }: ListJobsQuery): Promise<JobSummary[]> {
    // "Mine" (isMine): by user id, else by name for jobs from before migration 0041.
    const { rows } = await this.pool.query<JobRow>(
      `${JOB_SELECT} WHERE ($1::job_status IS NULL OR j.status = $1) AND j.task <> 'prepare'
         AND ($3::boolean IS NOT TRUE
              OR (j.created_by_user IS NOT NULL AND j.created_by_user = $4::uuid)
              OR (j.created_by_user IS NULL AND j.created_by = $5))
       ORDER BY j.created_at DESC LIMIT $2`,
      [status ?? null, limit, mine !== undefined, mine?.userId ?? null, mine?.name ?? null],
    );
    return rows.map(toSummary);
  }

  async getDocumentObject(jobId: string): Promise<(StoredObject & { filename: string }) | null> {
    const { rows } = await this.pool.query<{
      bucket: string;
      object_key: string;
      filename: string;
    }>(
      `SELECT d.bucket, d.object_key, d.filename
         FROM jobs j JOIN documents d ON d.id = j.document_id
        WHERE j.id = $1`,
      [jobId],
    );
    const row = rows[0];
    return row ? { bucket: row.bucket, key: row.object_key, filename: row.filename } : null;
  }

  async getJobParams(id: string): Promise<Record<string, unknown> | null> {
    const { rows } = await this.pool.query<{ params: Record<string, unknown> | null }>(
      'SELECT params FROM jobs WHERE id = $1',
      [id],
    );
    return rows[0]?.params ?? null;
  }

  async latestEvents(jobIds: string[], messages: readonly string[]): Promise<JobEventRecord[]> {
    if (!jobIds.length || !messages.length) return [];
    const { rows } = await this.pool.query<{
      job_id: string;
      message: string;
      data: unknown;
      at: Date;
    }>(
      `SELECT DISTINCT ON (job_id, message) job_id, message, data, at
         FROM job_events
        WHERE job_id = ANY($1::uuid[]) AND message = ANY($2::text[])
        ORDER BY job_id, message, at DESC, id DESC`,
      [jobIds, [...messages]],
    );
    return rows.map((r) => ({
      jobId: r.job_id,
      message: r.message,
      data: r.data,
      at: r.at.toISOString(),
    }));
  }

  async listEvents(
    jobId: string,
    opts: EventFilter = {},
  ): Promise<{ message: string; data: unknown; at: string }[]> {
    const { messages } = opts;
    // A prefix is matched literally: LIKE's wildcards in it are escaped.
    const prefixes = (messages?.prefixes ?? []).map((p) => p.replace(/[!%_]/g, (c) => `!${c}`));
    const { rows } = await this.pool.query<{ message: string; data: unknown; at: Date }>(
      `SELECT message, data, at FROM job_events
        WHERE job_id = $1
          AND ($2::timestamptz IS NULL OR at >= $2)
          AND ($3::boolean OR message = ANY($4::text[])
               OR EXISTS (SELECT 1 FROM unnest($5::text[]) AS p WHERE message LIKE p || '%' ESCAPE '!'))
        ORDER BY at, id`,
      [jobId, opts.since ?? null, messages === undefined, messages?.exact ?? [], prefixes],
    );
    return rows.map((r) => ({ message: r.message, data: r.data, at: r.at.toISOString() }));
  }

  async firstEventAt(
    jobId: string,
    message: string,
    since: string,
    match: Record<string, unknown>,
  ): Promise<string | null> {
    const { rows } = await this.pool.query<{ at: Date | null }>(
      `SELECT min(at) AS at FROM job_events
        WHERE job_id = $1 AND message = $2 AND at >= $3 AND data @> $4::jsonb`,
      [jobId, message, since, JSON.stringify(match)],
    );
    return rows[0]?.at?.toISOString() ?? null;
  }

  async cancelDraftJob(projectId: string, jobId: string, error: string) {
    const { rows } = await this.pool.query<SegmentRow>(
      `WITH cancelled AS (
         UPDATE jobs SET status = 'cancelled', error = $3, locked_by = NULL, locked_at = NULL,
                updated_at = now()
          WHERE id = $1 AND project_id = $2 AND task = 'draft' AND status IN ('queued', 'running')
          RETURNING id, project_id, status, error, created_at, updated_at, attempts, max_attempts),
       logged AS (
         INSERT INTO job_events (job_id, level, message) SELECT id, 'warn', 'cancelled' FROM cancelled)
       SELECT * FROM cancelled`,
      [jobId, projectId, error],
    );
    return rows[0] ? toSegmentJob(rows[0]) : null;
  }

  async queuePaused(): Promise<boolean> {
    const { rows } = await this.pool.query<{ paused: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM queue_control WHERE paused) AS paused',
    );
    return rows[0]?.paused ?? false;
  }

  async queueStats(): Promise<QueueStats> {
    // Document jobs only (any query bypassing JOB_SELECT must exclude document-less rows).
    // A requeued job keeps its old times until reclaimed, so the median reads finished runs only,
    // and only those that did the whole extraction (a quick failure or review would drag it down).
    const { rows } = await this.pool.query<{
      queued: string;
      running: string;
      median: number | null;
    }>(
      `SELECT count(*) FILTER (WHERE status = 'queued') AS queued,
              count(*) FILTER (WHERE status = 'running') AS running,
              (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY secs)
                 FROM (SELECT extract(epoch FROM finished_at - started_at)::float8 AS secs
                         FROM jobs
                        WHERE document_id IS NOT NULL
                          AND status IN ('succeeded', 'awaiting_review')
                          AND finished_at >= started_at
                          AND finished_at > now() - interval '24 hours'
                        ORDER BY finished_at DESC LIMIT 50) t) AS median
         FROM jobs
        WHERE document_id IS NOT NULL AND status IN ('queued', 'running')`,
    );
    const row = rows[0]!;
    return {
      queued: Number(row.queued),
      running: Number(row.running),
      medianSeconds: row.median === null ? null : Number(row.median),
    };
  }

  async getJob(id: string): Promise<JobDetail | null> {
    const { rows } = await this.pool.query<JobRow>(`${JOB_SELECT} WHERE j.id = $1`, [id]);
    if (!rows[0]) return null;
    const outputs = await this.pool.query<{
      output_id: string;
      stage: 'draft' | 'published';
      format: OutputFormat;
      bucket: string;
      object_key: string;
      row_count: number | null;
      target_id: string | null;
    }>(
      // Readers see the drafts and what the primary target holds; an archive's rows are for
      // withdrawal and target usage only.
      `SELECT output_id, stage, format, bucket, object_key, row_count, target_id FROM job_outputs
        WHERE job_id = $1 AND withdrawn_at IS NULL AND (stage = 'draft' OR is_primary)
        ORDER BY stage, output_id`,
      [id],
    );
    return {
      ...toSummary(rows[0]),
      outputs: outputs.rows.map((o) => ({
        outputId: o.output_id,
        stage: o.stage,
        format: o.format,
        bucket: o.bucket,
        key: o.object_key,
        rowCount: o.row_count,
        targetId: o.target_id,
      })),
    };
  }

  async listPublished({
    limit,
    templateId,
    before,
    beforeId,
    q,
    show,
  }: ListPublishedQuery): Promise<ResultSummary[]> {
    // Publish time = latest published job_outputs.created_at, compared at millisecond precision
    // because the `before` cursor is an ISO string (ms) taken from a previous page. Ties at the
    // same millisecond break on job id (uuid order), so `beforeId` resumes exactly after a page.
    const { rows } = await this.pool.query<{
      id: string;
      document_id: string;
      filename: string;
      object_key: string;
      spec_id: string;
      spec_version: number;
      reviewer: string | null;
      reviewed_at: Date | null;
      published_at: Date;
      output_count: number;
      issue_count: number | null;
      outputs: { outputId: string; format: OutputFormat; key: string; rowCount: number | null }[];
    }>(
      `SELECT j.id, j.document_id, d.filename, d.object_key, d.spec_id, d.spec_version, j.reviewer, j.reviewed_at,
              date_trunc('milliseconds', max(o.created_at)) AS published_at,
              count(*)::int AS output_count,
              max(o.row_count) FILTER (WHERE o.output_id = 'issues') AS issue_count,
              json_agg(json_build_object('outputId', o.output_id, 'format', o.format,
                                         'key', o.object_key, 'rowCount', o.row_count)
                       ORDER BY o.output_id) AS outputs
         FROM jobs j
         JOIN documents d ON d.id = j.document_id
         JOIN job_outputs o ON o.job_id = j.id AND o.stage = 'published' AND o.is_primary
                          AND o.withdrawn_at IS NULL
        WHERE NOT j.test AND ($1::text IS NULL OR d.spec_id = $1)
          AND ($5::text IS NULL OR d.filename ILIKE '%' || $5 || '%' ESCAPE '!')
          AND ($6::text IS DISTINCT FROM 'reviewed' OR j.reviewed_at IS NOT NULL)
          AND ($6::text IS DISTINCT FROM 'auto' OR j.reviewed_at IS NULL)
        GROUP BY j.id, d.id
       HAVING ($2::timestamptz IS NULL
           OR date_trunc('milliseconds', max(o.created_at)) < $2
           OR ($4::uuid IS NOT NULL
               AND date_trunc('milliseconds', max(o.created_at)) = $2
               AND j.id < $4))
          AND ($6::text IS DISTINCT FROM 'issues'
               OR coalesce(max(o.row_count) FILTER (WHERE o.output_id = 'issues'), 0) > 0)
        ORDER BY published_at DESC, j.id DESC
        LIMIT $3`,
      [
        templateId ?? null,
        before ?? null,
        limit,
        beforeId ?? null,
        // % and _ are literal in a file name filter: escape them (and the escape character, !).
        q?.replace(/[!%_]/g, (c) => `!${c}`) ?? null,
        show ?? null,
      ],
    );
    return rows.map((r) => ({
      jobId: r.id,
      documentId: r.document_id,
      filename: r.filename,
      contentType: sourceContentType(r.object_key),
      specId: r.spec_id,
      specVersion: r.spec_version,
      publishedAt: r.published_at.toISOString(),
      reviewer: r.reviewer,
      reviewedAt: r.reviewed_at?.toISOString() ?? null,
      outputCount: r.output_count,
      outputs: r.outputs.map((o) => ({
        outputId: o.outputId,
        format: o.format,
        name: o.key.split('/').pop() ?? o.outputId,
        rowCount: o.rowCount,
      })),
      issueCount: r.issue_count,
    }));
  }

  async getPublishedAt(jobId: string): Promise<string | null> {
    const { rows } = await this.pool.query<{ published_at: Date | null }>(
      `SELECT date_trunc('milliseconds', max(created_at)) AS published_at
         FROM job_outputs WHERE job_id = $1 AND stage = 'published' AND withdrawn_at IS NULL`,
      [jobId],
    );
    return rows[0]?.published_at?.toISOString() ?? null;
  }

  async retryJob(
    id: string,
    { model, specVersion, outputs }: RetryOptions = {},
  ): Promise<JobSummary | null> {
    const { rowCount } = await this.pool.query(
      // A cancelled publish/rerun resumes as that task; a preparation stays a preparation; other
      // failures re-run processing. A succeeded
      // job re-runs from scratch: its review (decision, reasons, edits) belonged to the old
      // extraction. CASE/WHERE read the pre-update row; all CTEs share one snapshot.
      `WITH prev AS (SELECT status FROM jobs WHERE id = $1),
       retried AS (
         UPDATE jobs SET task = CASE WHEN status = 'cancelled' OR task = 'prepare' THEN task ELSE 'process' END,
                reviewer = CASE WHEN status = 'succeeded' THEN NULL ELSE reviewer END,
                review_note = CASE WHEN status = 'succeeded' THEN NULL ELSE review_note END,
                reviewed_at = CASE WHEN status = 'succeeded' THEN NULL ELSE reviewed_at END,
                review_reasons = CASE WHEN status = 'succeeded' THEN NULL ELSE review_reasons END,
                status = 'queued', attempts = 0, error = NULL, run_after = now(),
                locked_by = NULL, locked_at = NULL, updated_at = now(),
                model_override = CASE WHEN $2 THEN $3 ELSE model_override END,
                params = CASE WHEN $5 THEN COALESCE(params, '{}'::jsonb)
                                           || jsonb_build_object('outputs', $6::jsonb)
                              ELSE params END
          -- document_id IS NOT NULL: segment previews (document-less) are not retryable
          WHERE id = $1 AND status IN ('failed', 'needs_review', 'cancelled', 'succeeded')
            AND document_id IS NOT NULL
          RETURNING document_id),
       cleared AS (
         DELETE FROM review_edits
          WHERE job_id = $1 AND EXISTS (SELECT 1 FROM retried)
            AND (SELECT status FROM prev) = 'succeeded')
       UPDATE documents d SET spec_version = COALESCE($4::int, d.spec_version)
         FROM retried WHERE d.id = retried.document_id`,
      [
        id,
        model !== undefined,
        model ?? null,
        specVersion ?? null,
        outputs !== undefined,
        JSON.stringify(outputs ?? null),
      ],
    );
    return rowCount ? await this.getJob(id) : null;
  }

  async cancelJob(id: string): Promise<JobSummary | null> {
    const { rowCount } = await this.pool.query(
      `WITH cancelled AS (
         UPDATE jobs SET status = 'cancelled', locked_by = NULL, locked_at = NULL, updated_at = now()
          WHERE id = $1 AND status IN ('queued', 'running') AND document_id IS NOT NULL
          RETURNING id)
       INSERT INTO job_events (job_id, level, message) SELECT id, 'warn', 'cancelled' FROM cancelled`,
      [id],
    );
    return rowCount ? await this.getJob(id) : null;
  }

  async withdrawType(typeId: string, by: string | null): Promise<string | null> {
    return this.inTransaction(async (client) => {
      const objects = await client.query<{ bucket: string; key: string; target: string }>(
        `UPDATE job_outputs o SET withdrawn_at = now()
           FROM jobs j JOIN documents d ON d.id = j.document_id
          WHERE o.job_id = j.id AND d.spec_id = $1 AND o.stage = 'published'
            AND o.withdrawn_at IS NULL
            -- The bridge may still write a delivering job's objects: retiring again withdraws them.
            AND j.status <> 'delivering'
        RETURNING o.bucket, o.object_key AS key, o.target_id AS target`,
        [typeId],
      );
      // No per-graph locks (a large type would exhaust them): a publish committed meanwhile
      // keeps its current row, and the worker's withdrawal spares a graph that has one.
      const graphs = await client.query<{
        sha256: string;
        template_id: string;
        graph_iri: string;
        target_id: string;
        versions: { version: number; targetId: string }[] | null;
      }>(
        `SELECT g.sha256, g.template_id, g.graph_iri, g.target_id,
                (SELECT json_agg(json_build_object('version', v.version, 'targetId', v.target_id)
                                 ORDER BY v.version)
                   FROM published_graph_versions v
                  WHERE v.sha256 = g.sha256 AND v.template_id = g.template_id) AS versions
           FROM published_graphs g WHERE g.template_id = $1 ORDER BY g.sha256`,
        [typeId],
      );
      await forgetGraphs(client, 'template_id = $1', [typeId]);
      if (!objects.rows.length && !graphs.rows.length) return null;
      return queueBackground(
        client,
        'withdraw',
        {
          objects: [...objects.rows].sort((a, b) => a.key.localeCompare(b.key)),
          graphs: graphs.rows.flatMap((g) =>
            graphWithdrawals({ sha256: g.sha256, templateId: g.template_id }, g.versions ?? [], {
              graphIri: g.graph_iri,
              targetId: g.target_id,
            }),
          ),
        },
        by,
      );
    });
  }

  async republishType(typeId: string, by: string | null): Promise<string | null> {
    return this.inTransaction(async (client) => {
      const { rowCount } = await client.query(
        `SELECT 1 FROM job_outputs o JOIN jobs j ON j.id = o.job_id
           JOIN documents d ON d.id = j.document_id
          WHERE d.spec_id = $1 AND o.withdrawn_at IS NOT NULL AND j.status = 'succeeded'
          LIMIT 1`,
        [typeId],
      );
      return rowCount ? queueBackground(client, 'republish', { templateId: typeId }, by) : null;
    });
  }

  async withdrawalStatus(): Promise<WithdrawalStatus> {
    const { rows } = await this.pool.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM jobs
        WHERE task IN ('withdraw', 'republish')
          AND status IN ('queued', 'running', 'failed', 'needs_review')
        GROUP BY status`,
    );
    const n = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
    return {
      queued: n('queued'),
      running: n('running'),
      failed: n('failed') + n('needs_review'),
    };
  }

  private async inTransaction<T>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async deleteJob(id: string): Promise<DeleteJobResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<{
        status: JobStatus;
        document_id: string;
        bucket: string;
        object_key: string;
      }>(
        `SELECT j.status, j.document_id, d.bucket, d.object_key
           FROM jobs j JOIN documents d ON d.id = j.document_id
          WHERE j.id = $1 FOR UPDATE OF j`,
        [id],
      );
      const row = found.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { result: 'not_found' };
      }
      if (!DELETABLE_STATUSES.includes(row.status)) {
        await client.query('ROLLBACK');
        return { result: 'conflict', status: row.status };
      }
      const drafts = await client.query<{ bucket: string; object_key: string }>(
        `SELECT bucket, object_key FROM job_outputs WHERE job_id = $1 AND stage = 'draft'`,
        [id],
      );
      const withdrawJobId = await withdrawJob(client, id);
      await client.query('DELETE FROM jobs WHERE id = $1', [id]);
      const doc = await client.query(
        `DELETE FROM documents d WHERE d.id = $1
            AND NOT EXISTS (SELECT 1 FROM jobs WHERE document_id = d.id)
            AND NOT EXISTS (SELECT 1 FROM template_references WHERE document_id = d.id)
            AND NOT EXISTS (SELECT 1 FROM workbench_samples WHERE document_id = d.id)`,
        [row.document_id],
      );
      let inboxObject: StoredObject | null = null;
      if (doc.rowCount) {
        const shared = await client.query(
          'SELECT 1 FROM documents WHERE bucket = $1 AND object_key = $2 LIMIT 1',
          [row.bucket, row.object_key],
        );
        if (!shared.rowCount) inboxObject = { bucket: row.bucket, key: row.object_key };
      }
      await client.query('COMMIT');
      return {
        result: 'deleted',
        removed: {
          jobId: id,
          draftObjects: drafts.rows.map((d) => ({ bucket: d.bucket, key: d.object_key })),
          inboxObject,
          withdrawJobId,
        },
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async finishedJobIdsBefore(cutoffIso: string, includeRegression = false): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM jobs
        WHERE status = ANY($1::job_status[]) AND updated_at < $2
          AND ($3 OR reference_id IS NULL) AND task <> 'prepare' AND document_id IS NOT NULL
        ORDER BY updated_at`,
      [DELETABLE_STATUSES, cutoffIso, includeRegression],
    );
    return rows.map((r) => r.id);
  }

  async listEdits(jobId: string): Promise<ReviewEdit[]> {
    const { rows } = await this.pool.query<EditRow>(
      `SELECT * FROM review_edits WHERE job_id = $1 ORDER BY id`,
      [jobId],
    );
    return rows.map(toEdit);
  }

  async listJobReviews(jobIds: readonly string[]): Promise<JobReview[]> {
    if (jobIds.length === 0) return [];
    // One round trip for every row of a References list (no per-reference query); edits use
    // review_edits_job_idx (job_id, id).
    const { rows } = await this.pool.query<{
      id: string;
      status: JobStatus;
      reviewer: string | null;
      reviewed_at: Date | null;
      model_override: string | null;
      edits: (Omit<EditRow, 'at'> & { at: string })[];
    }>(
      `SELECT j.id, j.status, j.reviewer, j.reviewed_at, j.model_override,
              coalesce(json_agg(e ORDER BY e.id) FILTER (WHERE e.id IS NOT NULL), '[]') AS edits
         FROM jobs j LEFT JOIN review_edits e ON e.job_id = j.id
        WHERE j.id = ANY($1::uuid[])
        GROUP BY j.id`,
      [[...new Set(jobIds)]],
    );
    return rows.map((r) => ({
      jobId: r.id,
      status: r.status,
      reviewer: r.reviewer,
      reviewedAt: r.reviewed_at?.toISOString() ?? null,
      modelOverride: r.model_override,
      // json_agg renders timestamptz as text: parse it back so `at` matches toEdit's ISO.
      edits: r.edits.map((e) => toEdit({ ...e, at: new Date(e.at) })),
    }));
  }

  async addEdit(jobId: string, e: NewEdit): Promise<ReviewEdit> {
    const { rows } = await this.pool.query<EditRow>(
      `INSERT INTO review_edits
         (job_id, field_id, table_id, row_number, column_id, old_value, new_value, editor, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        jobId,
        e.field,
        e.table,
        e.row,
        e.column,
        JSON.stringify(e.oldValue ?? null),
        JSON.stringify(e.newValue ?? null),
        e.editor,
        e.reason,
      ],
    );
    return toEdit(rows[0]!);
  }

  async approve(jobId: string, reviewer: string | null, note: string | null) {
    const { rowCount } = await this.pool.query(
      `UPDATE jobs SET status = 'queued', task = 'publish', attempts = 0, error = NULL,
              run_after = now(), reviewer = $2, review_note = $3, reviewed_at = now(),
              updated_at = now()
        WHERE id = $1 AND status = 'awaiting_review'`,
      [jobId, reviewer, note],
    );
    return rowCount ? await this.getJob(jobId) : null;
  }

  async createReference(input: NewReference): Promise<Reference> {
    const version = input.templateVersion ?? null;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      if (version !== null) {
        const { rows: docs } = await client.query<{ sha256: string }>(
          'SELECT sha256 FROM documents WHERE id = $1',
          [input.documentId],
        );
        const sha = docs[0]?.sha256 ?? '';
        // Two saves of the same PDF at the same version serialize here, so the second one
        // sees (and supersedes) the first instead of both staying live.
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1 || ':' || $2 || ':' || $3))`, [
          input.templateId,
          String(version),
          sha,
        ]);
        // Re-verifying a sample at this version: the old reference is kept for older iterations.
        await client.query(
          `UPDATE template_references SET superseded_at = now()
            WHERE template_id = $1 AND template_version = $2 AND superseded_at IS NULL
              AND document_id IN (SELECT id FROM documents WHERE sha256 = $3)`,
          [input.templateId, version, sha],
        );
      }
      // Names are unique among live references of one version (template_references_live_name_idx).
      const { rows } = await client.query<ReferenceRow>(
        `INSERT INTO template_references
           (template_id, template_version, name, document_id, source_job_id, expected, verified_outputs)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT DO NOTHING RETURNING *`,
        [
          input.templateId,
          version,
          input.name,
          input.documentId,
          input.sourceJobId,
          JSON.stringify(input.expected),
          version === null ? null : JSON.stringify(input.verifiedOutputs ?? null),
        ],
      );
      // A refused save rolls back the supersede above: nothing changes.
      if (!rows[0]) throw new ReferenceConflictError(`reference "${input.name}" already exists`);
      await client.query('COMMIT');
      return toReference(rows[0]);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listReferences(templateId: string, version?: number): Promise<Reference[]> {
    const { rows } = await this.pool.query<ReferenceRow>(
      `SELECT * FROM template_references
        WHERE template_id = $1 AND superseded_at IS NULL
          AND ($2::int IS NULL OR template_version IS NULL OR template_version = $2)
        ORDER BY created_at, id`,
      [templateId, version ?? null],
    );
    return rows.map(toReference);
  }

  async listReferencesWithSha(templateId: string) {
    const { rows } = await this.pool.query<ReferenceRow & { sha256: string }>(
      `SELECT r.*, d.sha256 FROM template_references r JOIN documents d ON d.id = r.document_id
        WHERE r.template_id = $1 ORDER BY r.created_at DESC, r.id DESC`,
      [templateId],
    );
    return rows.map((r) => ({ ...toReference(r), sha256: r.sha256 }));
  }

  async carryReferencesForward(templateId: string, toVersion: number): Promise<number> {
    // Concurrent callers both pass NOT EXISTS; the live-name unique index makes the second a no-op.
    // Any row of the target version, live or superseded (deleted), means it has its own set.
    // The source is the newest earlier version with any row, so an emptied version passes on
    // nothing rather than the set before it.
    // Copies keep the source's created_at: when the sample was verified.
    const { rowCount } = await this.pool.query(
      `INSERT INTO template_references
         (template_id, template_version, name, document_id, source_job_id, expected,
          verified_outputs, copied_from, created_at)
       SELECT r.template_id, $2, r.name, r.document_id, r.source_job_id, r.expected,
              r.verified_outputs, r.id, r.created_at
         FROM template_references r
        WHERE r.template_id = $1 AND r.superseded_at IS NULL
          AND r.template_version = (SELECT max(template_version) FROM template_references
                                     WHERE template_id = $1 AND template_version < $2)
          AND NOT EXISTS (SELECT 1 FROM template_references
                           WHERE template_id = $1 AND template_version = $2)
        ORDER BY r.created_at, r.id
       ON CONFLICT DO NOTHING`,
      [templateId, toVersion],
    );
    return rowCount ?? 0;
  }

  async deleteReference(templateId: string, id: string): Promise<boolean> {
    // A pinned reference is superseded, not removed: iterations keep their comparison and the
    // version keeps a row, so the next read does not carry the earlier set back.
    const pinned = await this.pool.query(
      `UPDATE template_references SET superseded_at = now()
        WHERE template_id = $1 AND id = $2 AND template_version IS NOT NULL
          AND superseded_at IS NULL`,
      [templateId, id],
    );
    if ((pinned.rowCount ?? 0) > 0) return true;
    const { rowCount } = await this.pool.query(
      'DELETE FROM template_references WHERE template_id = $1 AND id = $2 AND template_version IS NULL',
      [templateId, id],
    );
    return (rowCount ?? 0) > 0;
  }

  async createRegressionJob(
    reference: Reference,
    version: number,
    params: Record<string, unknown> | null = null,
    createdBy: Creator | null = null,
  ): Promise<JobSummary> {
    const { rows } = await this.pool.query<{
      filename: string;
      sha256: string;
      size_bytes: string;
      spec_id: string;
      bucket: string;
      object_key: string;
    }>('SELECT * FROM documents WHERE id = $1', [reference.documentId]);
    const source = rows[0]!;
    return this.createDocumentAndJob(
      {
        id: randomUUID(),
        filename: source.filename,
        sha256: source.sha256,
        sizeBytes: Number(source.size_bytes),
        specId: source.spec_id,
        specVersion: version,
        bucket: source.bucket,
        objectKey: source.object_key,
      },
      null,
      true,
      reference.id,
      params,
      createdBy,
    );
  }

  async listLatestRegressionJobs(templateId: string, version: number): Promise<JobDetail[]> {
    // One row per reference however many times regression ran: the list endpoint reads these.
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT DISTINCT ON (j.reference_id) j.id FROM jobs j JOIN documents d ON d.id = j.document_id
        WHERE j.reference_id IS NOT NULL AND d.spec_id = $1 AND d.spec_version = $2
        ORDER BY j.reference_id, j.created_at DESC, j.id DESC`,
      [templateId, version],
    );
    const jobs = await Promise.all(rows.map((r) => this.getJob(r.id)));
    return jobs.filter((j): j is JobDetail => j !== null);
  }

  async metricsData(templateId: string): Promise<MetricsData> {
    const { rows: jobRows } = await this.pool.query<JobRow>(
      `${JOB_SELECT} WHERE d.spec_id = $1 AND j.task <> 'prepare'`,
      [templateId],
    );
    const { rows: edits } = await this.pool.query<{
      job_id: string;
      field_id: string | null;
      table_id: string | null;
      column_id: string | null;
    }>(
      `SELECT e.job_id, e.field_id, e.table_id, e.column_id FROM review_edits e
         JOIN jobs j ON j.id = e.job_id JOIN documents d ON d.id = j.document_id
        WHERE d.spec_id = $1`,
      [templateId],
    );
    const { rows: runs } = await this.pool.query<{
      id: string;
      job_id: string;
      step_id: string;
      trigger: 'process' | 'rerun';
      model: string | null;
      attempts: number;
      input_tokens: number | null;
      output_tokens: number | null;
      status: 'succeeded' | 'failed';
      cached: boolean;
      error: string | null;
      started_at: Date;
      finished_at: Date;
    }>(
      `SELECT s.* FROM step_runs s
         JOIN jobs j ON j.id = s.job_id JOIN documents d ON d.id = j.document_id
        WHERE d.spec_id = $1`,
      [templateId],
    );
    return {
      jobs: jobRows.map(toSummary),
      edits: edits.map((e) => ({
        jobId: e.job_id,
        field: e.field_id,
        table: e.table_id,
        column: e.column_id,
      })),
      stepRuns: runs.map((r) => ({
        id: Number(r.id),
        jobId: r.job_id,
        stepId: r.step_id,
        trigger: r.trigger,
        model: r.model,
        attempts: r.attempts,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        status: r.status,
        cached: r.cached,
        error: r.error,
        startedAt: r.started_at.toISOString(),
        finishedAt: r.finished_at.toISOString(),
      })),
    };
  }

  async listStepRuns(jobId: string): Promise<StepRun[]> {
    const { rows } = await this.pool.query<{
      id: string;
      step_id: string;
      trigger: 'process' | 'rerun';
      model: string | null;
      attempts: number;
      input_tokens: number | null;
      output_tokens: number | null;
      status: 'succeeded' | 'failed';
      cached: boolean;
      error: string | null;
      started_at: Date;
      finished_at: Date;
    }>('SELECT * FROM step_runs WHERE job_id = $1 ORDER BY id', [jobId]);
    return rows.map((r) => ({
      id: Number(r.id),
      stepId: r.step_id,
      trigger: r.trigger,
      model: r.model,
      attempts: r.attempts,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      status: r.status,
      cached: r.cached,
      error: r.error,
      startedAt: r.started_at.toISOString(),
      finishedAt: r.finished_at.toISOString(),
    }));
  }

  async requestRerun(jobId: string, step: string, params: RerunRequest) {
    const { rowCount } = await this.pool.query(
      `UPDATE jobs SET status = 'queued', task = 'rerun', rerun = $2, attempts = 0, error = NULL,
              run_after = now(), updated_at = now()
        WHERE id = $1 AND status = 'awaiting_review'`,
      [jobId, JSON.stringify({ step, ...params })],
    );
    return rowCount ? await this.getJob(jobId) : null;
  }

  async reject(jobId: string, reviewer: string | null, reason: string) {
    const { rowCount } = await this.pool.query(
      `UPDATE jobs SET status = 'rejected', reviewer = $2, review_note = $3, reviewed_at = now(),
              updated_at = now()
        WHERE id = $1 AND status = 'awaiting_review'`,
      [jobId, reviewer, reason],
    );
    return rowCount ? await this.getJob(jobId) : null;
  }

  async listModels(): Promise<ModelInfo[]> {
    const { rows } = await this.pool.query<{
      provider: string;
      provider_kind: ProviderKind;
      model_id: string;
      display_name: string | null;
      enabled: boolean;
      discovered_at: Date;
      curated: boolean;
    }>(
      // Curated counts only on an endpoint that still exists and is enabled (ADR 0010).
      `SELECT m.provider, m.provider_kind, m.model_id, m.display_name, m.enabled, m.discovered_at,
              (m.curated AND COALESCE(e.enabled, false)) AS curated
         FROM llm_models m LEFT JOIN llm_endpoints e ON e.name = m.provider
        ORDER BY m.provider, m.model_id`,
    );
    return rows.map((r) => ({
      ref: modelRef(r.provider, r.model_id),
      provider: r.provider,
      providerKind: r.provider_kind,
      modelId: r.model_id,
      displayName: r.display_name,
      enabled: r.enabled,
      discoveredAt: r.discovered_at.toISOString(),
      curated: r.curated,
    }));
  }

  async recordDeliveries(
    jobId: string,
    rows: { targetId: string; deliveryId: string }[],
  ): Promise<void> {
    // One statement, so one round (one created_at), as the worker's hand-off records them.
    await this.pool.query(
      `INSERT INTO job_deliveries (delivery_id, job_id, target_id, status)
       SELECT d, $1, t, 'queued' FROM unnest($2::uuid[], $3::text[]) AS r(d, t)
       ON CONFLICT (delivery_id) DO NOTHING`,
      [jobId, rows.map((r) => r.deliveryId), rows.map((r) => r.targetId)],
    );
  }

  async applyDeliveryUpdate(
    deliveryId: string,
    update: DeliveryUpdate,
    finish: (deliveries: JobDelivery[]) => JobFinish | null,
  ): Promise<{ outcome: 'applied' | 'stale' | 'unknown'; finished: JobFinish | null }> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<{ job_id: string }>(
        'SELECT job_id FROM job_deliveries WHERE delivery_id = $1',
        [deliveryId],
      );
      const jobId = found.rows[0]?.job_id;
      if (!jobId) {
        await client.query('ROLLBACK');
        return { outcome: 'unknown', finished: null };
      }
      // The job's row first: events for its other deliveries wait, so the one that makes the
      // last delivery final sees every other one final too, and finishes the job once.
      const job = await client.query<{ status: string; background: boolean }>(
        'SELECT status, document_id IS NULL AS background FROM jobs WHERE id = $1 FOR UPDATE',
        [jobId],
      );
      const updated = await client.query(
        `UPDATE job_deliveries
            SET status = $2, error = $3, receipt = $4, last_sequence = $5, updated_at = now()
          WHERE delivery_id = $1 AND last_sequence < $5`,
        [
          deliveryId,
          update.status,
          update.error === null ? null : JSON.stringify(update.error),
          update.receipt === null ? null : JSON.stringify(update.receipt),
          update.sequence,
        ],
      );
      if (updated.rowCount === 0) {
        await client.query('ROLLBACK');
        return { outcome: 'stale', finished: null };
      }
      // A delivery that ends without its objects written: its published rows are withdrawn, so a
      // republish (or approving again) delivers them anew and readers don't look for them.
      if (update.status === 'failed' || update.status === 'needs_user') {
        await client.query(
          `UPDATE job_outputs SET withdrawn_at = now()
            WHERE delivery_id = $1 AND stage = 'published' AND withdrawn_at IS NULL`,
          [deliveryId],
        );
      }
      const finishedAs = finish(await deliveriesIn(client, jobId));
      const outcome =
        finishedAs && job.rows[0]?.background ? backgroundFinish(finishedAs) : finishedAs;
      let finished: JobFinish | null = null;
      if (outcome && job.rows[0]?.status === 'delivering') {
        await client.query(
          `UPDATE jobs SET status = $2::job_status,
                  error = CASE WHEN $2::text = 'failed' THEN $3 ELSE NULL END,
                  review_reasons = CASE WHEN $2::text = 'awaiting_review' THEN $4::jsonb
                                        ELSE review_reasons END,
                  updated_at = now()
            WHERE id = $1 AND status = 'delivering'`,
          [
            jobId,
            outcome.status,
            outcome.status === 'failed' ? outcome.error : null,
            outcome.status === 'awaiting_review' ? JSON.stringify(outcome.reasons) : null,
          ],
        );
        const e = finishEvent(outcome);
        await client.query(
          'INSERT INTO job_events (job_id, level, message, data) VALUES ($1, $2, $3, $4)',
          [jobId, e.level, e.message, JSON.stringify(e.data)],
        );
        finished = outcome;
      }
      await client.query('COMMIT');
      return { outcome: 'applied', finished };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async deliveriesOf(jobId: string): Promise<JobDelivery[]> {
    return deliveriesIn(this.pool, jobId);
  }

  async stragglers(olderThanMinutes: number, now: Date): Promise<JobDelivery[]> {
    const { rows } = await this.pool.query<DeliveryRow>(
      `SELECT ${DELIVERY_COLUMNS} FROM job_deliveries d JOIN jobs j ON j.id = d.job_id
        WHERE j.status = 'delivering'
          AND d.status NOT IN ('succeeded', 'skipped', 'needs_user', 'failed')
          AND d.updated_at < $1::timestamptz - make_interval(mins => $2)
        ORDER BY d.updated_at`,
      [now, olderThanMinutes],
    );
    return rows.map(toDelivery);
  }
}

interface DeliveryRow {
  delivery_id: string;
  job_id: string;
  target_id: string;
  status: JobDelivery['status'];
  error: JobDelivery['error'];
  receipt: JobDelivery['receipt'];
  last_sequence: number;
  updated_at: Date;
}

const DELIVERY_COLUMNS = `d.delivery_id::text, d.job_id::text, d.target_id, d.status, d.error,
  d.receipt, d.last_sequence, d.updated_at`;

const toDelivery = (r: DeliveryRow): JobDelivery => ({
  deliveryId: r.delivery_id,
  jobId: r.job_id,
  targetId: r.target_id,
  status: r.status,
  error: r.error,
  receipt: r.receipt,
  lastSequence: r.last_sequence,
  updatedAt: r.updated_at.toISOString(),
});

/**
 * The deliveries of a job's latest round: every row recorded with its last hand-off (one
 * transaction, so one `created_at`), however many go to one target (a republish, ontology loads).
 * An approval again starts a new round; the rounds before stay for the record but no longer judge
 * the job.
 */
async function deliveriesIn(db: pg.Pool | pg.PoolClient, jobId: string): Promise<JobDelivery[]> {
  const { rows } = await db.query<DeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS} FROM job_deliveries d
      WHERE d.job_id = $1
        AND d.created_at = (SELECT max(created_at) FROM job_deliveries WHERE job_id = $1)
      ORDER BY d.delivery_id`,
    [jobId],
  );
  return rows.map(toDelivery);
}
