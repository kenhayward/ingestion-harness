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
  reviewReasons: z.array(z.string()).nullable(),
  reviewer: z.string().nullable(),
  reviewNote: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

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
