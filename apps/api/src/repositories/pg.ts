import pg from 'pg';
import type { JobDetail, JobStatus, JobSummary, ModelInfo, ProviderKind } from '@ih/shared';
import { modelRef } from '@ih/shared';
import type { IngestionRepo, ListJobsQuery, NewDocument } from './types.js';

const JOB_SELECT = `
  SELECT j.id, j.document_id, d.filename, d.spec_id, d.spec_version, j.status,
         j.model_override, j.attempts, j.error, j.created_at, j.updated_at
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
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
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

  async createDocumentAndJob(doc: NewDocument, modelOverride: string | null): Promise<JobSummary> {
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
        `INSERT INTO jobs (document_id, model_override) VALUES ($1, $2) RETURNING id`,
        [doc.id, modelOverride],
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
      format: 'csv' | 'json';
      bucket: string;
      object_key: string;
      row_count: number | null;
    }>(
      `SELECT output_id, format, bucket, object_key, row_count FROM job_outputs WHERE job_id = $1 ORDER BY output_id`,
      [id],
    );
    return {
      ...toSummary(rows[0]),
      outputs: outputs.rows.map((o) => ({
        outputId: o.output_id,
        format: o.format,
        bucket: o.bucket,
        key: o.object_key,
        rowCount: o.row_count,
      })),
    };
  }

  async retryJob(id: string): Promise<JobSummary | null> {
    const { rowCount } = await this.pool.query(
      `UPDATE jobs SET status = 'queued', attempts = 0, error = NULL, run_after = now(),
              locked_by = NULL, locked_at = NULL, updated_at = now()
        WHERE id = $1 AND status IN ('failed', 'needs_review')`,
      [id],
    );
    return rowCount ? await this.getJob(id) : null;
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
