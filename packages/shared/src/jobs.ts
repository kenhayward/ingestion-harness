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
   * draft: workbench drafting stage (no document).
   */
  task: z.enum(['process', 'publish', 'rerun', 'prepare', 'segment', 'draft']),
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

export interface ReviewEdit {
  id: number;
  at: string;
  field: string | null;
  table: string | null;
  row: number | null;
  column: string | null;
  oldValue: unknown;
  newValue: unknown;
  editor: string | null;
  reason: string | null;
}

export const ApproveRequestSchema = z
  .object({ reviewer: z.string().optional(), note: z.string().optional() })
  .strict();
export const RejectRequestSchema = z
  .object({ reviewer: z.string().optional(), reason: z.string().min(1) })
  .strict();

/** One extract step execution recorded by the worker (step_runs). */
export interface StepRun {
  id: number;
  stepId: string;
  trigger: 'process' | 'rerun';
  model: string | null;
  attempts: number;
  inputTokens: number | null;
  outputTokens: number | null;
  status: 'succeeded' | 'failed';
  /** Served from the workbench step cache (no model call). */
  cached: boolean;
  error: string | null;
  startedAt: string;
  finishedAt: string;
}

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
export interface Reference {
  id: string;
  templateId: string;
  name: string;
  documentId: string;
  sourceJobId: string | null;
  expected: { fields: Record<string, unknown>; tables: Record<string, Record<string, unknown>[]> };
  createdAt: string;
}
