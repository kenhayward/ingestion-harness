import { z } from 'zod';
import { RetirementSchema } from './retirement.js';
import { CopySelectionSchema, SectionSchema } from './spec.js';
import { JobStatusSchema } from './jobs.js';

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

export const BriefSchema = z.object({
  projectId: z.string(),
  version: z.number().int(),
  body: BriefBodySchema,
  createdAt: z.string(),
});
export type Brief = z.infer<typeof BriefSchema>;

export const WorkbenchProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: z.string(),
  /** Where sample text may go (ADR 0007): local models only, or external providers too. */
  dataPolicy: DataPolicySchema,
  dataPolicyChangedAt: z.string().nullable(),
  /** Label of the admin token that last changed the policy. */
  dataPolicyChangedBy: z.string().nullable(),
  /** Holdout score (0..1) a draft needs to publish without an override (ADR 0007). */
  publishThreshold: z.number(),
  /** Label of the token that last changed the threshold (null: never, or no access control). */
  thresholdSetBy: z.string().nullable(),
  thresholdSetAt: z.string().nullable(),
});
export type WorkbenchProject = z.infer<typeof WorkbenchProjectSchema>;

export const ProjectSummarySchema = WorkbenchProjectSchema.extend({
  draft: z.number().int().nullable(),
  published: z.number().int().nullable(),
  samples: z.number().int(),
});
export type ProjectSummary = z.infer<typeof ProjectSummarySchema>;

export const ProjectViewSchema = z.object({
  project: WorkbenchProjectSchema,
  /** The open draft version being developed; null when every version is published. */
  draft: z.number().int().nullable(),
  published: z.number().int().nullable(),
  brief: BriefSchema.nullable(),
  /** The document type is retired: nothing new runs for it (null when it is not). */
  retired: RetirementSchema.nullable(),
});
export type ProjectView = z.infer<typeof ProjectViewSchema>;

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
export const SampleStateSchema = z.enum(['preparing', 'ready', 'failed']);
export type SampleState = z.infer<typeof SampleStateSchema>;

/** Job events the worker's prepare task writes (worker: workbench.PREPARE_PROGRESS / _FAILED). */
export const PREPARE_PROGRESS_EVENT = 'prepare progress';
export const PREPARE_FAILED_EVENT = 'prepare failed';

/** Where a running preparation is: the text layer read, or `page` of `of` OCR pages done. */
export const PrepareProgressSchema = z.object({
  stage: z.enum(['text', 'ocr']),
  page: z.number().int().nonnegative(),
  of: z.number().int().nonnegative(),
});
export type PrepareProgress = z.infer<typeof PrepareProgressSchema>;

/** Why a preparation failed (worker: workbench.PrepareErrorCode). */
export const PREPARE_ERROR_CODES = ['password', 'corrupt', 'too_large', 'other'] as const;
export const PrepareErrorSchema = z.object({
  code: z.enum(PREPARE_ERROR_CODES),
  message: z.string(),
});
export type PrepareError = z.infer<typeof PrepareErrorSchema>;

export const SampleViewSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string(),
  documentId: z.string().uuid(),
  filename: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  role: SampleRoleSchema,
  addedForVersion: z.number().int(),
  createdAt: z.string(),
  state: SampleStateSchema,
  prepareJobId: z.string().uuid().nullable(),
  error: z.string().nullable(),
  /** While the prepare job runs: its latest progress in this attempt (null before any). */
  prepare: PrepareProgressSchema.nullable(),
  /** When `failed`: the reason's code and message (`other` when the worker gave none). */
  prepareError: PrepareErrorSchema.nullable(),
  triage: PreparedTriageSchema.nullable(),
  /**
   * The number of holdout evaluations (iterations) that evaluated this sample's PDF. A sample
   * moved back to dev keeps its count; the count survives the evaluation jobs being deleted.
   */
  holdoutRuns: z.number().int(),
});
export type SampleView = z.infer<typeof SampleViewSchema>;

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

/** A one-click fix for a required section that missed a sample (worker anchor_hints, SC2). */
export const AnchorSuggestionSchema = z.object({
  section: z.string(),
  sampleId: z.string(),
  /** The anchor with the sample's way of writing the label added; it matches that sample. */
  anchor: z.string(),
  reason: z.string(),
});
export type AnchorSuggestion = z.infer<typeof AnchorSuggestionSchema>;

/** Written by the worker's segment task (runs bucket, segmentationKey). */
export const SegmentationResultSchema = z.object({
  /** Invalid regexes: section id (or "copies") -> message. Those anchors are skipped. */
  anchorErrors: z.record(z.string(), z.string()),
  samples: z.array(SegmentedSampleSchema),
  /** Required sections that missed a sample, with an anchor that finds it; none before SC2. */
  suggestions: z.array(AnchorSuggestionSchema).default([]),
});
export type SegmentationResult = z.infer<typeof SegmentationResultSchema>;

export const SegmentationViewSchema = z.object({
  jobId: z.string().uuid(),
  status: JobStatusSchema,
  error: z.string().nullable(),
  /** Present once the job succeeded. */
  result: SegmentationResultSchema.nullable(),
});
export type SegmentationView = z.infer<typeof SegmentationViewSchema>;

export const DRAFT_STAGES = [
  'survey',
  'outputs',
  'sections',
  'steps',
  'references',
  'revise',
] as const;
export type DraftStage = (typeof DRAFT_STAGES)[number];
/** Stages that can be run in this release (3b); `references` comes with phase 4. */
export const AVAILABLE_STAGES: readonly DraftStage[] = [
  'survey',
  'outputs',
  'sections',
  'steps',
  'revise',
];

/** In how many of the samples the model was shown it saw a candidate (handoff SV2). */
export const SeenInSchema = z
  .object({ n: z.number().int().nonnegative(), of: z.number().int().nonnegative() })
  .strict();
export type SeenIn = z.infer<typeof SeenInSchema>;

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
          /** Written by the model since SV2; surveys stored before it have none. */
          seenIn: SeenInSchema.optional(),
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

export const ProposalStatusSchema = z.enum([
  'running',
  'ready',
  'failed',
  'accepted',
  'partially_accepted',
  'rejected',
]);
export type ProposalStatus = z.infer<typeof ProposalStatusSchema>;
