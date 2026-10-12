import { z } from 'zod';
import { CopySelectionSchema, SectionSchema } from './spec.js';
import type { JobStatus } from './jobs.js';

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

/** The part of a template's `document` block the segmentation preview applies. */
export const SegmentDocumentSchema = z
  .object({
    sections: z.array(SectionSchema).min(1),
    copies: CopySelectionSchema.optional(),
    pageMarkers: z.boolean().default(true),
  })
  .strict();
export type SegmentDocument = z.infer<typeof SegmentDocumentSchema>;

/** One sample × section cell of the preview grid. */
export const SectionCellSchema = z.object({
  id: z.string(),
  found: z.boolean(),
  /** 1-based PDF page where the section starts (null when not found). */
  page: z.number().int().positive().nullable(),
  /** The line the anchor matched, trimmed to 200 characters. */
  line: z.string().nullable(),
  /** Characters of section text (0 when not found or empty). */
  chars: z.number().int().nonnegative(),
});
export type SectionCell = z.infer<typeof SectionCellSchema>;

export const SegmentedSampleSchema = z.object({
  sampleId: z.string(),
  /** 1-based first page of the kept copy (copy selection). */
  firstPage: z.number().int().positive(),
  pageCount: z.number().int().nonnegative(),
  /** e.g. "not prepared" or a copies-anchor problem; sections are empty when set. */
  error: z.string().nullable(),
  missingRequired: z.array(z.string()),
  sections: z.array(SectionCellSchema),
});
export type SegmentedSample = z.infer<typeof SegmentedSampleSchema>;

/** Written by the worker's segment task (runs bucket, segmentationKey). */
export const SegmentationResultSchema = z.object({
  /** Invalid regexes: section id (or "copies") -> message. Those anchors are skipped. */
  anchorErrors: z.record(z.string(), z.string()),
  samples: z.array(SegmentedSampleSchema),
});
export type SegmentationResult = z.infer<typeof SegmentationResultSchema>;

export interface SegmentationView {
  jobId: string;
  status: JobStatus;
  error: string | null;
  /** Present once the job succeeded. */
  result: SegmentationResult | null;
}
