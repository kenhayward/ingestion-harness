import { z } from 'zod';
import type { ChangeBody } from './drafting.js';
import { CopySelectionSchema, SectionSchema } from './spec.js';
import type { JobStatus } from './jobs.js';

/** Workbench (ADR 0007): sample roles, brief, prepared text. Mirrors worker/src/ingest_worker/workbench.py. */
export const SAMPLE_ROLES = ['dev', 'holdout'] as const;
export const SampleRoleSchema = z.enum(SAMPLE_ROLES);
export type SampleRole = z.infer<typeof SampleRoleSchema>;

/** Most samples a project holds: 3–8 dev samples plus a few held out. */
export const MAX_SAMPLES = 12;

export const DATA_POLICIES = ['local', 'external'] as const;
export const DataPolicySchema = z.enum(DATA_POLICIES);
export type DataPolicy = z.infer<typeof DataPolicySchema>;

export const BriefBodySchema = z
  .object({
    purpose: z.string().default(''),
    outputs: z.string().default(''),
    exampleOutput: z.string().default(''),
    glossary: z.string().default(''),
    variants: z.string().default(''),
    rules: z.string().default(''),
    /** Survey questions and the user's answers (drafting stage `survey`). */
    answers: z.array(z.object({ question: z.string(), answer: z.string() }).strict()).default([]),
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
  answers: [],
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
  /** Where sample text may go (ADR 0007): local models only, or external providers too. */
  dataPolicy: DataPolicy;
  dataPolicyChangedAt: string | null;
  /** Label of the admin token that last changed the policy. */
  dataPolicyChangedBy: string | null;
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
  .strict()
  .superRefine((doc, ctx) => {
    const seen = new Set<string>();
    doc.sections.forEach((section, index) => {
      if (seen.has(section.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sections', index, 'id'],
          message: `duplicate section id ${section.id}`,
        });
      }
      seen.add(section.id);
    });
  });
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

export const DRAFT_STAGES = ['survey', 'outputs', 'sections', 'steps', 'references'] as const;
export type DraftStage = (typeof DRAFT_STAGES)[number];
/** Stages that can be run in this release (3b); `references` comes with phase 4. */
export const AVAILABLE_STAGES: readonly DraftStage[] = ['survey', 'outputs', 'sections', 'steps'];

/** Body of a `survey` proposal. Mirrors worker drafting.SURVEY_SCHEMA. */
export const SurveyBodySchema = z
  .object({
    summary: z.string(),
    structure: z.array(
      z.object({ name: z.string(), description: z.string(), howToFind: z.string() }).strict(),
    ),
    variants: z.array(z.string()),
    candidates: z.array(
      z
        .object({
          name: z.string(),
          description: z.string(),
          where: z.string(),
          kind: z.enum(['field', 'table']),
        })
        .strict(),
    ),
    questions: z.array(z.object({ question: z.string(), why: z.string() }).strict()),
  })
  .strict();
export type SurveyBody = z.infer<typeof SurveyBodySchema>;

/** Written by the worker's draft task (runs bucket, draftingKey). */
export const DraftResultSchema = z.object({
  stage: z.enum(DRAFT_STAGES),
  model: z.string(),
  body: z.unknown(),
  usage: z.object({
    inputTokens: z.number().int().nullable(),
    outputTokens: z.number().int().nullable(),
  }),
});
export type DraftResult = z.infer<typeof DraftResultSchema>;

export type ProposalStatus =
  'running' | 'ready' | 'failed' | 'accepted' | 'partially_accepted' | 'rejected';

export interface ProposalView {
  id: string;
  stage: DraftStage;
  status: ProposalStatus;
  error: string | null;
  briefVersion: number | null;
  /** Resolved model that produced it (once ready). */
  model: string | null;
  /** survey: SurveyBody; outputs/sections/steps: ChangeBody. Null until ready. */
  body: SurveyBody | ChangeBody | null;
  /** Indexes of the changes applied to the draft (accepted / partially_accepted). */
  acceptedChanges: number[] | null;
  createdAt: string;
  decidedAt: string | null;
}
