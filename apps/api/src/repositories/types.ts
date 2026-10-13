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
  SegmentDocument,
  StepRun,
} from '@ih/shared';

/**
 * A reference to save. `templateVersion` pins it to a version (Workbench types) together with the
 * outputs definition its values were verified against; without it the reference is unpinned.
 */
export type NewReference = Omit<
  Reference,
  'id' | 'createdAt' | 'templateVersion' | 'copiedFrom' | 'verifiedOutputs' | 'supersededAt'
> & { templateVersion?: number | null; verifiedOutputs?: unknown };

/** Segment previews run before other workbench work, still after production (ADR 0007). */
export const SEGMENT_PRIORITY = -5;

export interface SegmentJob {
  id: string;
  projectId: string;
  status: JobStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A document-less project job (segment previews, drafting runs, bundle exports). */
export type ProjectJob = SegmentJob;

/** jobs.params of a segment job (worker: workbench.SegmentParams). */
export interface SegmentJobParams {
  samples: { sampleId: string; sha256: string }[];
  document: SegmentDocument;
}

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
  /** jobs.params, e.g. `{ dataPolicy }`; the worker enforces it (ADR 0007). */
  params?: Record<string, unknown>;
  /** Evaluation run: the reference it is scored against. Default null. */
  referenceId?: string | null;
  /** Every step runs on this alias, e.g. `draft` for reference runs. Default null. */
  modelOverride?: string | null;
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
  /** Case-insensitive file name substring (matched literally). */
  q?: string;
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
  /**
   * The project's test runs (`process` jobs, still listed once review moves them to `rerun` or
   * `publish`), newest first, each with its document's sha256.
   */
  listProjectRuns(projectId: string): Promise<{ job: JobSummary; sha256: string }[]>;
  /**
   * Queue a segmentation preview for a project (no document). Earlier segment jobs of the project
   * are deleted first (only the latest preview matters); their ids are returned in `removed`.
   */
  createSegmentJob(
    projectId: string,
    params: SegmentJobParams,
  ): Promise<{ job: SegmentJob; removed: string[] }>;
  getSegmentJob(projectId: string, id: string): Promise<SegmentJob | null>;
  /**
   * Queue a drafting run (document-less, task 'draft'). Unlike segment previews, earlier draft
   * jobs are kept: each one backs a proposal.
   */
  createDraftJob(projectId: string, params: Record<string, unknown>): Promise<ProjectJob>;
  /** Draft jobs of a project, newest first. */
  listDraftJobs(projectId: string): Promise<ProjectJob[]>;
  /**
   * Queue a bundle export (document-less, task 'export'). One per project: earlier export jobs
   * of the project are deleted first; their ids are returned in `removed` (their zips are the
   * caller's to delete).
   */
  createExportJob(
    projectId: string,
    params: Record<string, unknown>,
  ): Promise<{ job: ProjectJob; removed: string[] }>;
  /** Export jobs of a project, newest first. */
  listExportJobs(projectId: string): Promise<ProjectJob[]>;
  /** Jobs page listing; prepare jobs are excluded (they belong to the Workbench). */
  listJobs(query: ListJobsQuery): Promise<JobSummary[]>;
  getJob(id: string): Promise<JobDetail | null>;
  /** jobs.params (free-form; null when unset or the job is unknown). */
  getJobParams(id: string): Promise<Record<string, unknown> | null>;
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
   * Prepare jobs and document-less (segment) jobs are never returned (they belong to the Workbench).
   */
  finishedJobIdsBefore(cutoffIso: string, includeRegression?: boolean): Promise<string[]>;
  listModels(): Promise<ModelInfo[]>;

  // --- references and regression runs ---
  /**
   * Throws ReferenceConflictError when the name is taken among live references of the template
   * and version (unpinned references share one namespace). With `templateVersion`, live
   * references of that version for the same PDF (sha256) are superseded first: re-verifying.
   */
  createReference(input: NewReference): Promise<Reference>;
  /** Live references, oldest first; with `version`, those pinned to it or unpinned. */
  listReferences(templateId: string, version?: number): Promise<Reference[]>;
  /** Every reference (superseded and of every version) with its PDF's sha256, newest first. */
  listReferencesWithSha(templateId: string): Promise<(Reference & { sha256: string })[]>;
  /**
   * Copies the live references of the newest earlier version to `toVersion`, unless that version
   * already has live pinned references. Idempotent; returns the number of copies.
   */
  carryReferencesForward(templateId: string, toVersion: number): Promise<number>;
  deleteReference(templateId: string, id: string): Promise<boolean>;
  /** Test job of `version` re-running the reference's PDF (new document row, same object). */
  createRegressionJob(reference: Reference, version: number): Promise<JobSummary>;
  /** Regression jobs of a template version, newest first. */
  /** The newest regression job per reference for a version (older runs are history). */
  listLatestRegressionJobs(templateId: string, version: number): Promise<JobDetail[]>;

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
