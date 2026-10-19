import { z } from 'zod';
import { TargetIdSchema } from './publish-targets.js';

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
  /** Handed to the delivery bridge: waiting for every delivery to finish. */
  'delivering',
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
   * document, migration 0019); ontology: parse and index an imported ontology version (no
   * document, migration 0032; never a JobSummary).
   */
  task: z.enum([
    'process',
    'publish',
    'rerun',
    'prepare',
    'segment',
    'draft',
    'export',
    'ontology',
  ]),
  /** Test run of a (draft) template: reviewable, never published. */
  test: z.boolean(),
  /** Regression run: the reference document this test job re-runs. */
  referenceId: z.string().nullable(),
  /** Workbench project the job belongs to (prepare jobs and dev test runs). */
  projectId: z.string().nullable(),
  /**
   * Name of the user who queued the job (migration 0023), for people to read; null for older
   * jobs and without access control. Retries keep it.
   */
  createdBy: z.string().nullable(),
  /**
   * Id of the user who queued the job (migration 0041): what "mine" means, since a name can
   * change or pass to someone else. Null for jobs from before it and without access control.
   */
  createdByUser: z.string().nullable(),
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

/** Who queued a job (ADR 0013): the name people read, and the user id "mine" is decided on. */
export interface Creator {
  name: string;
  userId: string | null;
}

/**
 * Whether `me` queued the job: by user id when the job has one (a name can change or pass to
 * someone else), else by name (jobs from before migration 0041).
 */
export function isMine(job: Pick<JobSummary, 'createdBy' | 'createdByUser'>, me: Creator): boolean {
  if (job.createdByUser !== null) return job.createdByUser === me.userId;
  return job.createdBy !== null && job.createdBy === me.name;
}

/** Job event the worker writes per model call of an extraction (worker: template_pipeline.STEP_PROGRESS). */
export const STEP_PROGRESS_EVENT = 'step progress';

/**
 * Job event the worker writes while it reads a document: the text layer, then each OCR page
 * (worker: pipeline.PREPARE_PROGRESS, also written by Workbench `prepare` jobs).
 */
export const PREPARE_PROGRESS_EVENT = 'prepare progress';

/** Job event the worker writes once a document is split into sections (worker: pipeline.SEGMENTED). */
export const SEGMENTED_EVENT = 'segmented';

/**
 * Job event when a publish delivered its document's graph (ADR 0011 step 6; worker
 * `template_pipeline.GRAPH_PUBLISHED`): the graph's IRI, its new version, its triples and whether
 * it went to the triple store (`endpoint`; false: S3 only, no `RDF_ENDPOINT`).
 */
export const GRAPH_PUBLISHED_EVENT = 'graph published';
export const GraphPublishedSchema = z.object({
  graph: z.string(),
  version: z.number().int().positive(),
  triples: z.number().int().nonnegative(),
  endpoint: z.boolean(),
});

/**
 * A `withdraw` job's params (ADR 0011 step 7; worker `withdrawal.WithdrawParams`): what a job
 * deletion or a retirement removes from the target and the triple store. `objects` are target
 * keys as recorded; each graph's version copies (`graphs/{sha256}/{type}/v{n}.ttl`) go, and the
 * graph itself when `graphIri` is set (the current version's job was deleted, or the type retired).
 */
export const WithdrawParamsSchema = z
  .object({
    objects: z.array(
      z
        .object({ bucket: z.string().min(1), key: z.string().min(1), target: TargetIdSchema })
        .strict(),
    ),
    graphs: z.array(
      z
        .object({
          sha256: z.string().min(1),
          templateId: z.string().min(1),
          graphIri: z.string().min(1).nullable(),
          target: TargetIdSchema,
          versions: z.array(z.number().int().positive()),
        })
        .strict(),
    ),
  })
  .strict();
export type WithdrawParams = z.infer<typeof WithdrawParamsSchema>;

/** A `republish` job's params: unretiring re-delivers the type's withdrawn outputs. */
export const RepublishParamsSchema = z.object({ templateId: z.string().min(1) }).strict();

/** `JobDetail.graph`: the newest graph this job published. */
export const JobGraphSchema = z.object({
  iri: z.string(),
  version: z.number().int(),
  triples: z.number().int(),
  endpoint: z.boolean(),
  publishedAt: z.string(),
});
export type JobGraph = z.infer<typeof JobGraphSchema>;

/**
 * Where a document read is: the text layer read, or `page` of `of` OCR pages done. `pages` is
 * the document's page count (#142); events from workers before it lack it.
 */
export const PrepareProgressSchema = z.object({
  stage: z.enum(['text', 'ocr']),
  page: z.number().int().nonnegative(),
  of: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative().optional(),
});
export type PrepareProgress = z.infer<typeof PrepareProgressSchema>;

/**
 * Where a running extraction is (handoff TR3): extract step `index` of `of` (check steps are not
 * counted), its id, the attempt of the current call and, for a chunked step, the chunk. Shared
 * fixture: packages/shared/test/fixtures/step-progress.json.
 */
export const StepProgressSchema = z.object({
  step: z.string(),
  index: z.number().int().positive(),
  of: z.number().int().positive(),
  attempt: z.number().int().positive(),
  chunk: z.object({ n: z.number().int().positive(), of: z.number().int().positive() }).nullable(),
  /** The occurrence of a repeating section this call reads (null: a plain step, or an event
   * from before repeating sections). */
  occurrence: z
    .object({
      n: z.number().int().positive(),
      of: z.number().int().positive(),
      key: z.string().nullable(),
    })
    .nullable()
    .default(null),
});
export type StepProgress = z.infer<typeof StepProgressSchema>;

/** A project's job as the Test runs tab lists it: the summary plus a running run's progress. */
export const TestRunSchema = JobSummarySchema.extend({
  /** While running: the latest progress of this attempt; null otherwise or before any. */
  progress: StepProgressSchema.nullable(),
});
export type TestRun = z.infer<typeof TestRunSchema>;

/**
 * The queue a new Workbench run waits behind (handoff TR4): queued document jobs (production
 * and earlier Workbench runs), the jobs running now, and a rough wait (null without recent timed
 * runs; 0 when nothing is queued).
 */
export const QueueSummarySchema = z.object({
  ahead: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  etaSeconds: z.number().int().nonnegative().nullable(),
});
export type QueueSummary = z.infer<typeof QueueSummarySchema>;

/**
 * A document graph's SHACL report (ADR 0011 step 5; worker `rdf.ShaclReport.to_json`). Only
 * violations block (review reasons, a refused publish); warnings and infos become issues.
 */
export const ShaclResultSchema = z.object({
  severity: z.enum(['Violation', 'Warning', 'Info']),
  /** The node shape whose constraint failed. */
  shape: z.string(),
  focus: z.string(),
  path: z.string(),
  /** The output the path publishes (`field`, `table`, `table.column`), else the path IRI. */
  output: z.string(),
  message: z.string(),
  value: z.string(),
});
export type ShaclResult = z.infer<typeof ShaclResultSchema>;
export const ShaclReportSchema = z.object({
  conforms: z.boolean(),
  results: z.array(ShaclResultSchema),
});
export type ShaclReport = z.infer<typeof ShaclReportSchema>;

/** What an output is written as; `rdf` is the document's graph in Turtle (ADR 0011). */
export const OUTPUT_FORMATS = ['csv', 'json', 'rdf'] as const;
export type OutputFormat = (typeof OUTPUT_FORMATS)[number];

/** The file extension of an output format. */
export const outputExtension = (format: OutputFormat): string =>
  format === 'rdf' ? 'ttl' : format;

/** The content type an output is served with. */
export const outputContentType = (format: OutputFormat): string =>
  format === 'csv'
    ? 'text/csv; charset=utf-8'
    : format === 'rdf'
      ? 'text/turtle; charset=utf-8'
      : 'application/json';

export const JobOutputSchema = z.object({
  outputId: z.string(),
  /** draft: outputs bucket (pre-review); published: final target. */
  stage: z.enum(['draft', 'published']),
  format: z.enum(OUTPUT_FORMATS),
  bucket: z.string(),
  key: z.string(),
  rowCount: z.number().int().nullable(),
  /** The publishing target a published output went to (null for drafts). */
  targetId: z.string().nullable(),
});
export type JobOutput = z.infer<typeof JobOutputSchema>;

/**
 * Where a running extraction is now, from its latest progress event of this attempt: reading the
 * document (`prepare`), split into sections (`segmented`), or calling the model (`step`).
 */
export const JobProgressSchema = z.discriminatedUnion('kind', [
  PrepareProgressSchema.extend({ kind: z.literal('prepare') }),
  z.object({ kind: z.literal('segmented') }),
  StepProgressSchema.extend({ kind: z.literal('step') }),
]);
export type JobProgress = z.infer<typeof JobProgressSchema>;

/**
 * When this attempt finished reading the document (its last `prepare progress` event: the text
 * layer, or the last OCR page) and found its sections (`segmented`); null when not (yet) known.
 * The Progress list times each step from these, the step runs and the job's own times.
 */
export const StageTimesSchema = z.object({
  readAt: z.string().nullable(),
  segmentedAt: z.string().nullable(),
});
export type StageTimes = z.infer<typeof StageTimesSchema>;

/** One delivery of a job through the delivery bridge, as its events last reported it. */
export const JobDeliveryViewSchema = z.object({
  targetId: z.string(),
  /** The target's label (its id when the target is gone). */
  label: z.string(),
  status: z.enum(['queued', 'running', 'waiting', 'succeeded', 'skipped', 'needs_user', 'failed']),
  /** What went wrong, in the bridge's words; null when nothing did. */
  message: z.string().nullable(),
});
export type JobDeliveryView = z.infer<typeof JobDeliveryViewSchema>;

export const JobDetailSchema = JobSummarySchema.extend({
  outputs: z.array(JobOutputSchema),
  /** `GET /api/jobs/:id` only: the newest graph this job published (ADR 0011), else null. */
  graph: JobGraphSchema.nullable().optional(),
  /** `GET /api/jobs/:id` only: a running extraction's progress (null otherwise or before any). */
  progress: JobProgressSchema.nullable().optional(),
  /** `GET /api/jobs/:id` only: when this attempt finished reading and segmenting. */
  stageTimes: StageTimesSchema.optional(),
  /** `GET /api/jobs/:id` only: its deliveries through the bridge (none before it delivers). */
  deliveries: z.array(JobDeliveryViewSchema).optional(),
});
export type JobDetail = z.infer<typeof JobDetailSchema>;

/** One message of a job's live stream (`GET /api/jobs/:id/events`): the job and its progress. */
export const JobLiveSchema = z.object({
  job: JobSummarySchema,
  progress: JobProgressSchema.nullable(),
  stageTimes: StageTimesSchema,
});
export type JobLive = z.infer<typeof JobLiveSchema>;

/** A reviewer edit: either a field (atom) or a table cell (1-based row). */
export const EditRequestSchema = z.union([
  z
    .object({
      field: z.string().min(1),
      value: z.unknown().optional(),
      editor: z.string().optional(),
      reason: z.string().optional(),
    })
    .strict(),
  z
    .object({
      table: z.string().min(1),
      row: z.number().int().positive(),
      column: z.string().min(1),
      value: z.unknown().optional(),
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
  oldValue: z.unknown().optional(),
  newValue: z.unknown().optional(),
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
  verifiedOutputs: z.unknown().optional(),
  /** Set when a re-verified reference replaced this one; kept for older iterations. */
  supersededAt: z.string().nullable(),
  expected: z.object({
    fields: z.record(z.string(), z.unknown()),
    tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  }),
  createdAt: z.string(),
});
export type Reference = z.infer<typeof ReferenceSchema>;
