import { z } from 'zod';
import type { JobStatus } from './jobs.js';
import { MAX_SAMPLES } from './workbench.js';

/**
 * Drafting bundle (Workbench phase 6, ADR 0007): what the in-harness drafter sees, for
 * air-gapped drafting or another deployment. Written by the worker's export task
 * (worker/src/ingest_worker/bundle.py), read by the import route. Dev samples only.
 */
export const BUNDLE_FORMAT = 'ih-workbench-bundle';

const Sha256 = z.string().regex(/^[0-9a-f]{64}$/);

export const BundleManifestSchema = z
  .object({
    format: z.literal(BUNDLE_FORMAT),
    formatVersion: z.literal(1),
    project: z.object({ id: z.string().min(1), name: z.string().min(1) }).strict(),
    templateVersion: z.number().int().positive(),
    briefVersion: z.number().int().positive().nullable(),
    samples: z
      .array(
        z
          .object({
            sampleId: z.string(),
            filename: z.string().min(1).max(255),
            sha256: Sha256,
            file: z.string().regex(/^samples\/[0-9a-f]{64}\.pdf$/),
            /** Its text is in context.md (the drafter reads at most 8 samples). */
            inContext: z.boolean(),
          })
          .strict()
          .refine((s) => s.file === `samples/${s.sha256}.pdf`, {
            message: 'file must match sha256',
          }),
      )
      .max(MAX_SAMPLES),
    stages: z.array(z.string()),
    /**
     * Proposal stages accepted or skipped at export time (absent in older bundles). Import
     * accepts the survey from `survey.json` and records the others as skipped.
     */
    completedStages: z.array(z.enum(['survey', 'outputs', 'sections', 'steps'])).optional(),
  })
  .strict();
export type BundleManifest = z.infer<typeof BundleManifestSchema>;

/** An export job of a project, newest first in lists. */
export interface ExportView {
  jobId: string;
  status: JobStatus;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}
