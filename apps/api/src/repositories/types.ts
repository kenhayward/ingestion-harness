import type { MetricsData } from '../metrics.js';
import type {
  JobDetail,
  JobStatus,
  JobSummary,
  ModelInfo,
  RerunRequest,
  Reference,
  ResultSummary,
  ReviewEdit,
  StepRun,
} from '@ih/shared';

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

export interface StoredObject {
  bucket: string;
  key: string;
}

/** What a deleted job leaves to clean up in the internal store. */
export interface RemovedJob {
  jobId: string;
  draftObjects: StoredObject[];
  /** The inbox PDF, when no remaining document row or reference needs it. */
  inboxObject: StoredObject | null;
}

export type DeleteJobResult =
  | { result: 'deleted'; removed: RemovedJob }
  | { result: 'not_found' }
  | { result: 'conflict'; status: JobStatus };

export interface RetryOptions {
  model?: string | null;
  specVersion?: number;
}

/** Workbench jobs run after production work (jobs.priority; ADR 0007). */
export const WORKBENCH_PRIORITY = -10;

export interface WorkbenchJobOptions {
  projectId: string;
  /** prepare: sample text + OCR only; process: a test run of the project's draft. */
  task: 'prepare' | 'process';
}

export interface ListJobsQuery {
  limit: number;
  status?: JobStatus;
}

export interface ListPublishedQuery {
  limit: number;
  templateId?: string;
  /** ISO timestamp: only results published strictly before it (millisecond precision). */
  before?: string;
  /** Tie-breaker for `before`: results at exactly `before` with a job id lower than this. */
  beforeId?: string;
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
    referenceId?: string | null,
  ): Promise<JobSummary>;
  /** A test job of a workbench project, queued behind production work. */
  createWorkbenchJob(doc: NewDocument, opts: WorkbenchJobOptions): Promise<JobSummary>;
  /** Jobs of a workbench project (prepare jobs and test runs), newest first. */
  listProjectJobs(projectId: string): Promise<JobSummary[]>;
  /** Jobs page listing; prepare jobs are excluded (they belong to the Workbench). */
  listJobs(query: ListJobsQuery): Promise<JobSummary[]>;
  getJob(id: string): Promise<JobDetail | null>;
  /** The job's uploaded PDF in the inbox bucket (Jobs "Open PDF"). */
  getDocumentObject(jobId: string): Promise<(StoredObject & { filename: string }) | null>;
  /** Non-test jobs with at least one published output, newest publish first. */
  listPublished(query: ListPublishedQuery): Promise<ResultSummary[]>;
  /** Latest publish time of a job's published outputs (ISO, ms precision); null if none. */
  getPublishedAt(jobId: string): Promise<string | null>;
  /** Re-queue a job in a terminal failure state. Returns null if not found or not retryable. */
  /**
   * Re-queue a job in a terminal failure state. `model`: a ref sets the override, null clears
   * it (spec default), undefined keeps it. `specVersion`: move the job's document to that
   * version (undefined keeps it). Returns null if not found or not retryable.
   */
  retryJob(id: string, opts?: RetryOptions): Promise<JobSummary | null>;
  /** queued/running -> cancelled (+ event). Null if unknown or not cancellable. */
  cancelJob(id: string): Promise<JobSummary | null>;
  /** Delete a finished job (+ its document unless still needed). Storage is the caller's job. */
  deleteJob(id: string): Promise<DeleteJobResult>;
  /**
   * Ids of finished jobs whose updated_at is before `cutoffIso`, oldest first. Regression runs
   * (reference_id set) feed regression scores and metrics, so they're left out unless asked.
   * Prepare jobs are never returned (they belong to the Workbench).
   */
  finishedJobIdsBefore(cutoffIso: string, includeRegression?: boolean): Promise<string[]>;
  listModels(): Promise<ModelInfo[]>;

  // --- references and regression runs ---
  /** Throws ReferenceConflictError when the name is taken for the template. */
  createReference(input: Omit<Reference, 'id' | 'createdAt'>): Promise<Reference>;
  listReferences(templateId: string): Promise<Reference[]>;
  deleteReference(templateId: string, id: string): Promise<boolean>;
  /** Test job of `version` re-running the reference's PDF (new document row, same object). */
  createRegressionJob(reference: Reference, version: number): Promise<JobSummary>;
  /** Regression jobs of a template version, newest first. */
  listRegressionJobs(templateId: string, version: number): Promise<JobDetail[]>;

  /** Raw rows behind GET /api/templates/:id/metrics. */
  metricsData(templateId: string): Promise<MetricsData>;

  // --- review (jobs in awaiting_review) ---
  listEdits(jobId: string): Promise<ReviewEdit[]>;
  addEdit(jobId: string, edit: NewEdit): Promise<ReviewEdit>;
  /** awaiting_review -> queued publish task. Null if the job is not awaiting review. */
  approve(jobId: string, reviewer: string | null, note: string | null): Promise<JobSummary | null>;
  listStepRuns(jobId: string): Promise<StepRun[]>;
  /** awaiting_review -> queued rerun task for one step. Null if not awaiting review. */
  requestRerun(jobId: string, step: string, params: RerunRequest): Promise<JobSummary | null>;
  /** awaiting_review -> rejected (final). Null if the job is not awaiting review. */
  reject(jobId: string, reviewer: string | null, reason: string): Promise<JobSummary | null>;
}

export class ReferenceConflictError extends Error {}
