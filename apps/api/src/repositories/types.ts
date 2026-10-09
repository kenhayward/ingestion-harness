import type { JobDetail, JobStatus, JobSummary, ModelInfo } from '@ih/shared';

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

/** Persistence port. `PgRepo` in production, `MemoryRepo` in unit tests. */
export interface IngestionRepo {
  ping(): Promise<void>;
  createDocumentAndJob(doc: NewDocument, modelOverride: string | null): Promise<JobSummary>;
  listJobs(query: ListJobsQuery): Promise<JobSummary[]>;
  getJob(id: string): Promise<JobDetail | null>;
  /** Re-queue a job in a terminal failure state. Returns null if not found or not retryable. */
  retryJob(id: string): Promise<JobSummary | null>;
  listModels(): Promise<ModelInfo[]>;
}
