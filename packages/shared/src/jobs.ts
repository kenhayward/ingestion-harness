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
] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

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
  attempts: z.number().int(),
  error: z.string().nullable(),
  /** process: extraction; publish: apply review edits and deliver to the final target. */
  task: z.enum(['process', 'publish']),
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
