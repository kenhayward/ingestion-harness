import { z } from 'zod';

/** Workbench (ADR 0007): sample roles, brief, prepared text. Mirrors worker/src/ingest_worker/workbench.py. */
export const SAMPLE_ROLES = ['dev', 'holdout'] as const;
export const SampleRoleSchema = z.enum(SAMPLE_ROLES);
export type SampleRole = z.infer<typeof SampleRoleSchema>;

/** Most samples a project holds: 3–8 dev samples plus a few held out. */
export const MAX_SAMPLES = 12;

export const BriefBodySchema = z
  .object({
    purpose: z.string().default(''),
    outputs: z.string().default(''),
    exampleOutput: z.string().default(''),
    glossary: z.string().default(''),
    variants: z.string().default(''),
    rules: z.string().default(''),
  })
  .strict();
export type BriefBody = z.infer<typeof BriefBodySchema>;

export const EMPTY_BRIEF: BriefBody = {
  purpose: '',
  outputs: '',
  exampleOutput: '',
  glossary: '',
  variants: '',
  rules: '',
};

export interface Brief {
  projectId: string;
  version: number;
  body: BriefBody;
  createdAt: string;
}

export interface WorkbenchProject {
  id: string;
  name: string;
  createdAt: string;
}

export interface ProjectSummary extends WorkbenchProject {
  draft: number | null;
  published: number | null;
  samples: number;
}

export interface ProjectView {
  project: WorkbenchProject;
  /** The open draft version being developed; null when every version is published. */
  draft: number | null;
  published: number | null;
  brief: Brief | null;
}

/** Written by the worker's prepare task (runs bucket, preparedTextKey). */
export const PreparedTextSchema = z.object({
  sha256: z.string(),
  pages: z.array(
    z.object({ number: z.number().int().positive(), text: z.string(), ocr: z.boolean() }),
  ),
});
export type PreparedText = z.infer<typeof PreparedTextSchema>;

/** Written by the worker's prepare task (runs bucket, preparedTriageKey). */
export const PreparedTriageSchema = z.object({
  sha256: z.string(),
  pageCount: z.number().int().nonnegative(),
  /** 1-based pages that were OCR'd (no usable text layer). */
  ocrPages: z.array(z.number().int().positive()),
  chars: z.number().int().nonnegative(),
  ocrModel: z.string().nullable(),
});
export type PreparedTriage = z.infer<typeof PreparedTriageSchema>;

/** Derived from the sample's prepare job: queued/running, succeeded, anything else. */
export type SampleState = 'preparing' | 'ready' | 'failed';

export interface SampleView {
  id: string;
  projectId: string;
  documentId: string;
  filename: string;
  sizeBytes: number;
  sha256: string;
  role: SampleRole;
  addedForVersion: number;
  createdAt: string;
  state: SampleState;
  prepareJobId: string | null;
  error: string | null;
  triage: PreparedTriage | null;
}
