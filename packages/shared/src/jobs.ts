import { z } from 'zod';

/** Mirrors the `job_status` enum in db/migrations and worker/src/ingest_worker/queue.py. */
export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'needs_review'] as const;
export const JobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const TERMINAL_STATUSES: ReadonlySet<JobStatus> = new Set([
  'succeeded',
  'failed',
  'needs_review',
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
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type JobSummary = z.infer<typeof JobSummarySchema>;

export const JobOutputSchema = z.object({
  outputId: z.string(),
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
