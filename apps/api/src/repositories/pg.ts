import pg from 'pg';
import type {
  JobDetail,
  JobStatus,
  JobSummary,
  ModelInfo,
  ProviderKind,
  RerunRequest,
  ReviewEdit,
  StepRun,
} from '@ih/shared';
import { modelRef } from '@ih/shared';
import type { IngestionRepo, ListJobsQuery, NewDocument, NewEdit } from './types.js';

const JOB_SELECT = `
  SELECT j.id, j.document_id, d.filename, d.spec_id, d.spec_version, j.status,
         j.model_override, j.attempts, j.error, j.task, j.test, j.review_reasons, j.reviewer,
         j.review_note, j.reviewed_at, j.created_at, j.updated_at
    FROM jobs j JOIN documents d ON d.id = j.document_id`;

interface JobRow {
  id: string;
  document_id: string;
  filename: string;
  spec_id: string;
  spec_version: number;
  status: JobStatus;
  model_override: string | null;
  attempts: number;
  error: string | null;
  task: 'process' | 'publish';
  test: boolean;
  review_reasons: string[] | null;
  reviewer: string | null;
  review_note: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toSummary(r: JobRow): JobSummary {
  return {
    id: r.id,
    documentId: r.document_id,
    filename: r.filename,
    specId: r.spec_id,
    specVersion: r.spec_version,
    status: r.status,
    modelOverride: r.model_override,
    attempts: r.attempts,
    error: r.error,
    task: r.task,
    test: r.test,
    reviewReasons: r.review_reasons,
    reviewer: r.reviewer,
    reviewNote: r.review_note,
    reviewedAt: r.reviewed_at ? r.reviewed_at.toISOString() : null,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
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

/** Postgres-backed repo. Covered by integration tests (test/integration), not unit tests. */
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
        `INSERT INTO jobs (document_id, model_override, test) VALUES ($1, $2, $3) RETURNING id`,
        [doc.id, modelOverride, test],
      );
      await client.query('COMMIT');
      const job = await this.getJob(rows[0]!.id);
      return job!;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async listJobs({ limit, status }: ListJobsQuery): Promise<JobSummary[]> {
    const { rows } = await this.pool.query<JobRow>(
      `${JOB_SELECT} WHERE ($1::job_status IS NULL OR j.status = $1) ORDER BY j.created_at DESC LIMIT $2`,
      [status ?? null, limit],
    );
    return rows.map(toSummary);
  }

  async getJob(id: string): Promise<JobDetail | null> {
    const { rows } = await this.pool.query<JobRow>(`${JOB_SELECT} WHERE j.id = $1`, [id]);
    if (!rows[0]) return null;
    const outputs = await this.pool.query<{
      output_id: string;
      stage: 'draft' | 'published';
      format: 'csv' | 'json';
      bucket: string;
      object_key: string;
      row_count: number | null;
    }>(
      `SELECT output_id, stage, format, bucket, object_key, row_count FROM job_outputs
        WHERE job_id = $1 ORDER BY stage, output_id`,
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
      })),
    };
  }

  async retryJob(id: string): Promise<JobSummary | null> {
    const { rowCount } = await this.pool.query(
      `UPDATE jobs SET status = 'queued', task = 'process', attempts = 0, error = NULL, run_after = now(),
              locked_by = NULL, locked_at = NULL, updated_at = now()
        WHERE id = $1 AND status IN ('failed', 'needs_review')`,
      [id],
    );
    return rowCount ? await this.getJob(id) : null;
  }

  async listEdits(jobId: string): Promise<ReviewEdit[]> {
    const { rows } = await this.pool.query<EditRow>(
      `SELECT * FROM review_edits WHERE job_id = $1 ORDER BY id`,
      [jobId],
    );
    return rows.map(toEdit);
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
    }>(`SELECT * FROM llm_models ORDER BY provider, model_id`);
    return rows.map((r) => ({
      ref: modelRef(r.provider, r.model_id),
      provider: r.provider,
      providerKind: r.provider_kind,
      modelId: r.model_id,
      displayName: r.display_name,
      enabled: r.enabled,
      discoveredAt: r.discovered_at.toISOString(),
    }));
  }
}
