import { z } from 'zod';

/** Mirrors the `job_status` enum in db/migrations and worker/src/ingest_worker/queue.py. */
/**
 * needs_review: processing problem for an operator (document/spec/config error).
 * awaiting_review: extracted data waiting for a reviewer to approve (-> publish) or reject.
 */
export const JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'needs_review',
  'awaiting_review',
  'rejected',
  'cancelled',
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

/** Finished jobs: these can be deleted (queued/running must be cancelled, review decided). */
export const DELETABLE_STATUSES: readonly JobStatus[] = [
  'succeeded',
  'failed',
  'needs_review',
  'rejected',
  'cancelled',
];

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  'succeeded',
  'failed',
  'needs_review',
  'rejected',
]);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export const JobSummarySchema = z.object({
  id: z.string().uuid(),
  documentId: z.string().uuid(),
  filename: z.string(),
  /** The uploaded file's type: `application/pdf`, or the .docx type for a Word document. */
  contentType: z.string(),
  specId: z.string(),
  specVersion: z.number().int(),
  status: JobStatusSchema,
  modelOverride: z.string().nullable(),
  /** Distinct resolved models the job's steps ran on (step_runs), oldest first. */
  modelsUsed: z.array(z.string()),
  attempts: z.number().int(),
  error: z.string().nullable(),
  /**
   * process: extraction; publish: apply review edits and deliver to the final target;
   * rerun: one step again; prepare: workbench sample text + OCR only; segment: workbench
   * anchor preview over a project's prepared samples (no document; ADR 0007);
   * draft: workbench drafting stage (no document); export: workbench drafting bundle (no
   * document, migration 0019).
   */
  task: z.enum(['process', 'publish', 'rerun', 'prepare', 'segment', 'draft', 'export']),
  /** Test run of a (draft) template: reviewable, never published. */
  test: z.boolean(),
  /** Regression run: the reference document this test job re-runs. */
  referenceId: z.string().nullable(),
  /** Workbench project the job belongs to (prepare jobs and dev test runs). */
  projectId: z.string().nullable(),
  /**
   * Label of the access token that queued the job (migration 0023); null for older jobs and
   * without access control. Retries keep it.
   */
  createdBy: z.string().nullable(),
  reviewReasons: z.array(z.string()).nullable(),
  reviewer: z.string().nullable(),
  reviewNote: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /**
   * Workbench test runs started together (one `POST …/test-runs`) share this id
   * (`params.batchId`; handoff TR2). Null for every other job and for runs from before batches.
   */
  batchId: z.string().nullable(),
  /**
   * The latest extraction attempt's start and end (migration 0028: a database trigger on
   * `process` runs; approving and step re-runs keep them). Null before the first claim, for
   * other tasks, and for jobs from before the migration; `finishedAt` is null while running.
   */
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

/** Job event a Workbench run's worker writes per model call (worker: template_pipeline.STEP_PROGRESS). */
export const STEP_PROGRESS_EVENT = 'step progress';

/**
 * Where a running Workbench extraction is (handoff TR3): extract step `index` of `of` (check
 * steps are not counted), its id, the attempt of the current call and, for a chunked step, the
 * chunk. Shared fixture: packages/shared/test/fixtures/step-progress.json.
 */
export const StepProgressSchema = z.object({
  step: z.string(),
  index: z.number().int().positive(),
  of: z.number().int().positive(),
  attempt: z.number().int().positive(),
  chunk: z.object({ n: z.number().int().positive(), of: z.number().int().positive() }).nullable(),
});
export type StepProgress = z.infer<typeof StepProgressSchema>;

/** A project's job as the Test runs tab lists it: the summary plus a running run's progress. */
export const TestRunSchema = JobSummarySchema.extend({
  /** While running: the latest progress of this attempt; null otherwise or before any. */
  progress: StepProgressSchema.nullable(),
});
export type TestRun = z.infer<typeof TestRunSchema>;

export const JobOutputSchema = z.object({
  outputId: z.string(),
  /** draft: outputs bucket (pre-review); published: final target. */
  stage: z.enum(['draft', 'published']),
  format: z.enum(['csv', 'json']),
  bucket: z.string(),
  key: z.string(),
  rowCount: z.number().int().nullable(),
});
export type JobOutput = z.infer<typeof JobOutputSchema>;

export const JobDetailSchema = JobSummarySchema.extend({
  outputs: z.array(JobOutputSchema),
});
export type JobDetail = z.infer<typeof JobDetailSchema>;

/** A reviewer edit: either a field (atom) or a table cell (1-based row). */
export const EditRequestSchema = z.union([
  z
    .object({
      field: z.string().min(1),
      value: z.unknown(),
      editor: z.string().optional(),
      reason: z.string().optional(),
    })
    .strict(),
  z
    .object({
      table: z.string().min(1),
      row: z.number().int().positive(),
      column: z.string().min(1),
      value: z.unknown(),
      editor: z.string().optional(),
      reason: z.string().optional(),
    })
    .strict(),
]);
export type EditRequest = z.infer<typeof EditRequestSchema>;

/** A recorded reviewer edit: a field, or a table cell (`table`, 1-based `row`, `column`). */
export const ReviewEditSchema = z.object({
  id: z.number().int(),
  at: z.string(),
  field: z.string().nullable(),
  table: z.string().nullable(),
  row: z.number().int().nullable(),
  column: z.string().nullable(),
  /** The value before this edit: the previous edit's value, or the draft's. */
  oldValue: z.unknown(),
  newValue: z.unknown(),
  editor: z.string().nullable(),
  reason: z.string().nullable(),
});
export type ReviewEdit = z.infer<typeof ReviewEditSchema>;

export const ApproveRequestSchema = z
  .object({ reviewer: z.string().optional(), note: z.string().optional() })
  .strict();
export const RejectRequestSchema = z
  .object({ reviewer: z.string().optional(), reason: z.string().min(1) })
  .strict();

/** One extract step execution recorded by the worker (step_runs). */
export const StepRunSchema = z.object({
  id: z.number().int(),
  stepId: z.string(),
  trigger: z.enum(['process', 'rerun']),
  model: z.string().nullable(),
  attempts: z.number().int(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  status: z.enum(['succeeded', 'failed']),
  /** Served from the workbench step cache (no model call). */
  cached: z.boolean(),
  error: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string(),
});
export type StepRun = z.infer<typeof StepRunSchema>;

export const RerunRequestSchema = z
  .object({
    model: z.string().min(1).optional(),
    instructions: z.string().min(1).optional(),
    /** 1-based pages sent as images so a vision model reads them directly (e.g. handwriting). */
    pageImages: z.array(z.number().int().positive()).min(1).max(20).optional(),
  })
  .strict();
export type RerunRequest = z.infer<typeof RerunRequestSchema>;

/** A reference document of a document type: approved values used as the expected result. */
export const ReferenceSchema = z.object({
  id: z.string().uuid(),
  templateId: z.string(),
  /** Workbench types: the template version it belongs to. Null: every version (other types). */
  templateVersion: z.number().int().nullable(),
  name: z.string(),
  documentId: z.string().uuid(),
  sourceJobId: z.string().uuid().nullable(),
  /** The reference it was carried forward from (a copy for the next version). */
  copiedFrom: z.string().uuid().nullable(),
  /** The outputs definition the expected values were verified against (null: unpinned). */
  verifiedOutputs: z.unknown(),
  /** Set when a re-verified reference replaced this one; kept for older iterations. */
  supersededAt: z.string().nullable(),
  expected: z.object({
    fields: z.record(z.string(), z.unknown()),
    tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  }),
  createdAt: z.string(),
});
export type Reference = z.infer<typeof ReferenceSchema>;
