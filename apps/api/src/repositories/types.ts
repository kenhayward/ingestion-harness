import type { JobDetail, JobStatus, JobSummary, ModelInfo, ReviewEdit } from '@ih/shared';

export interface NewDocument {
  id: string;
  filename: string;
  sha256: string;
  sizeBytes: number;
  specId: string;
  specVersion: number;
  bucket: string;
  objectKey: string;
}

export interface ListJobsQuery {
  limit: number;
  status?: JobStatus;
}

export interface NewEdit {
  field: string | null;
  table: string | null;
  row: number | null;
  column: string | null;
  oldValue: unknown;
  newValue: unknown;
  editor: string | null;
  reason: string | null;
}

/** Persistence port. `PgRepo` in production, `MemoryRepo` in unit tests. */
export interface IngestionRepo {
  ping(): Promise<void>;
  createDocumentAndJob(
    doc: NewDocument,
    modelOverride: string | null,
    test?: boolean,
  ): Promise<JobSummary>;
  listJobs(query: ListJobsQuery): Promise<JobSummary[]>;
  getJob(id: string): Promise<JobDetail | null>;
  /** Re-queue a job in a terminal failure state. Returns null if not found or not retryable. */
  retryJob(id: string): Promise<JobSummary | null>;
  listModels(): Promise<ModelInfo[]>;

  // --- review (jobs in awaiting_review) ---
  listEdits(jobId: string): Promise<ReviewEdit[]>;
  addEdit(jobId: string, edit: NewEdit): Promise<ReviewEdit>;
  /** awaiting_review -> queued publish task. Null if the job is not awaiting review. */
  approve(jobId: string, reviewer: string | null, note: string | null): Promise<JobSummary | null>;
  /** awaiting_review -> rejected (final). Null if the job is not awaiting review. */
  reject(jobId: string, reviewer: string | null, reason: string): Promise<JobSummary | null>;
}
