import { z } from 'zod';
import { CorrectionSchema, PROVENANCES } from './corrections.js';
import { JobProgressSchema, JobStatusSchema, type JobStatus } from './jobs.js';
import { outputCoverage } from './template.js';
import { SampleRoleSchema } from './workbench.js';
import { PublishLabelSchema } from './version-labels.js';
import { RunDiagnosticsSchema } from './run-diagnostics.js';

/** Workbench evaluation (ADR 0007, phase 4a): comparisons, scorecards, iterations. */

const Row = z.record(z.string(), z.unknown());

export const FieldComparisonSchema = z.object({
  id: z.string(),
  expected: z.unknown().optional(),
  actual: z.unknown().optional(),
  match: z.boolean(),
});
export type FieldComparison = z.infer<typeof FieldComparisonSchema>;

export const TableComparisonSchema = z.object({
  id: z.string(),
  /** Row counts. */
  expected: z.number().int(),
  actual: z.number().int(),
  /** Rows identical to their expected counterpart. */
  matched: z.number().int(),
  /** Expected rows with no counterpart sharing any cell. */
  missing: z.array(Row),
  /** Actual rows not aligned to any expected row. */
  extra: z.array(Row),
  /** Aligned rows that differ, with the differing columns. */
  changed: z.array(z.object({ expected: Row, actual: Row, columns: z.array(z.string()) })),
  /** Equal cells / all cells considered (aligned rows, missing rows, extra rows). */
  cells: z.number().int(),
  cellsTotal: z.number().int(),
  /** The same cell counts per column. */
  columns: z.record(z.string(), z.object({ matched: z.number().int(), total: z.number().int() })),
});
export type TableComparison = z.infer<typeof TableComparisonSchema>;

export const ComparisonSchema = z.object({
  /** (matched fields + equal cells) / (fields + all cells considered); 1 = identical. */
  score: z.number(),
  fields: z.array(FieldComparisonSchema),
  tables: z.array(TableComparisonSchema),
});
export type Comparison = z.infer<typeof ComparisonSchema>;

/** Most model choices one comparison runs (ADR 0010, phase 4c). */
export const MAX_COMPARED_MODELS = 6;

const FINISHED: readonly JobStatus[] = [
  'succeeded',
  'awaiting_review',
  'failed',
  'needs_review',
  'rejected',
  'cancelled',
];
/** A job that will not change its result any more (a missing job counts as finished). */
export const finishedJob = (status: JobStatus | null): boolean =>
  status === null || FINISHED.includes(status);

export const AccuracySchema = z.object({
  id: z.string(),
  matched: z.number().int(),
  total: z.number().int(),
  accuracy: z.number(),
});
export type Accuracy = z.infer<typeof AccuracySchema>;

export const SampleResultSchema = z.object({
  sampleId: z.string().nullable(),
  filename: z.string(),
  jobId: z.string().nullable(),
  status: JobStatusSchema.nullable(),
  error: z.string().nullable(),
  comparison: ComparisonSchema.nullable(),
});
export type SampleResult = z.infer<typeof SampleResultSchema>;

export const ScorecardSchema = z.object({
  /** Mean per-sample score over compared samples; null when none was compared. */
  score: z.number().nullable(),
  completed: z.number().int(),
  total: z.number().int(),
  /** Worst first. */
  fields: z.array(AccuracySchema),
  /** `table.column`, worst first. */
  columns: z.array(AccuracySchema),
});
export type Scorecard = z.infer<typeof ScorecardSchema>;

function ranked(counts: Map<string, { matched: number; total: number }>): Accuracy[] {
  return [...counts.entries()]
    .filter(([, c]) => c.total > 0)
    .map(([id, c]) => ({ id, matched: c.matched, total: c.total, accuracy: c.matched / c.total }))
    .sort((a, b) => a.accuracy - b.accuracy || a.id.localeCompare(b.id));
}

export function buildScorecard(samples: SampleResult[]): Scorecard {
  const compared = samples.flatMap((s) => (s.comparison ? [s.comparison] : []));
  const fields = new Map<string, { matched: number; total: number }>();
  const columns = new Map<string, { matched: number; total: number }>();
  for (const c of compared) {
    for (const f of c.fields) {
      const n = fields.get(f.id) ?? { matched: 0, total: 0 };
      fields.set(f.id, { matched: n.matched + (f.match ? 1 : 0), total: n.total + 1 });
    }
    for (const t of c.tables) {
      for (const [column, counts] of Object.entries(t.columns)) {
        const id = `${t.id}.${column}`;
        const n = columns.get(id) ?? { matched: 0, total: 0 };
        columns.set(id, { matched: n.matched + counts.matched, total: n.total + counts.total });
      }
    }
  }
  return {
    score: compared.length ? compared.reduce((sum, c) => sum + c.score, 0) / compared.length : null,
    completed: compared.length,
    total: samples.length,
    fields: ranked(fields),
    columns: ranked(columns),
  };
}

export const EVALUATION_SETS = ['dev', 'holdout'] as const;
export type EvaluationSet = (typeof EVALUATION_SETS)[number];

export const IterationSummarySchema = z.object({
  id: z.string().uuid(),
  projectId: z.string(),
  templateVersion: z.number().int(),
  briefVersion: z.number().int().nullable(),
  set: z.enum(EVALUATION_SETS),
  /**
   * The model choice every step was overridden with (its id; `default` is the default choice,
   * and iterations from before model choices may say `fast` or `draft`); null = the template's
   * own models.
   */
  model: z.string().nullable(),
  /** Shared by the iterations of one model comparison. */
  groupId: z.string().uuid().nullable(),
  /** Every step called its model (the step cache was not read). */
  uncached: z.boolean(),
  createdAt: z.string(),
  status: z.enum(['running', 'complete']),
  score: z.number().nullable(),
  completed: z.number().int(),
  total: z.number().int(),
});
export type IterationSummary = z.infer<typeof IterationSummarySchema>;

export const IterationViewSchema = IterationSummarySchema.extend({
  /** Succeeded step runs of the iteration's jobs; `reused` were served from the step cache. */
  cache: z.object({ reused: z.number().int(), total: z.number().int() }),
  scorecard: ScorecardSchema,
  samples: z.array(SampleResultSchema),
});
export type IterationView = z.infer<typeof IterationViewSchema>;

export const ComparisonViewSchema = z.object({
  groupId: z.string().uuid(),
  iterations: z.array(IterationViewSchema),
});
export type ComparisonView = z.infer<typeof ComparisonViewSchema>;

export interface ComparisonRow {
  id: string;
  byModel: Record<string, number | null>;
}

/** One row per measure (overall score, then each field / table.column), one column per model. */
export function comparisonRows(iterations: IterationView[]): ComparisonRow[] {
  const label = (it: IterationView) => it.model ?? 'template';
  const ids = [
    ...new Set(
      iterations.flatMap((it) =>
        [...it.scorecard.fields, ...it.scorecard.columns].map((a) => a.id),
      ),
    ),
  ].sort();
  const accuracy = (it: IterationView, id: string) =>
    [...it.scorecard.fields, ...it.scorecard.columns].find((a) => a.id === id)?.accuracy ?? null;
  return [
    { id: 'score', byModel: Object.fromEntries(iterations.map((it) => [label(it), it.score])) },
    ...ids.map((id) => ({
      id,
      byModel: Object.fromEntries(iterations.map((it) => [label(it), accuracy(it, id)])),
    })),
  ];
}

/** A sample's reference for the current version, with what the reviewer changed (RF1). */
export const ReferenceInfoSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  createdAt: z.string(),
  /** Version it is pinned to; null for an unpinned (legacy) reference. */
  version: z.number().int().nullable(),
  /** Version it was carried forward from, when it is a copy. */
  carriedFrom: z.number().int().nullable(),
  /** `outputChanges` against the version's outputs: non-empty means re-verify before use. */
  outdated: z.array(z.string()),
  /** The reviewed run the values were saved from; null when unknown or deleted. */
  sourceJobId: z.string().uuid().nullable(),
  /** The run's approver (else its last editor); null when unknown. */
  verifiedBy: z.string().nullable(),
  /**
   * What the reviewer changed (derived from the run's review edits); null when unknown: no
   * source run, or it was re-run or reviewed again after the save.
   */
  corrections: z.array(CorrectionSchema).nullable(),
  /**
   * Set when this reference re-verified a carried copy at the same version: the version that
   * copy came from and its output changes (why it needed verifying again).
   */
  reverified: z.object({ from: z.number().int(), changed: z.array(z.string()) }).nullable(),
});
export type ReferenceInfo = z.infer<typeof ReferenceInfoSchema>;

/** One ready sample (dev or holdout) on the References tab. */
export const ReferenceRowSchema = z.object({
  sampleId: z.string().uuid(),
  filename: z.string(),
  sha256: z.string(),
  reference: ReferenceInfoSchema.nullable(),
  /** Latest test run of this sample that is not an evaluation run. */
  run: z
    .object({
      jobId: z.string().uuid(),
      status: JobStatusSchema,
      error: z.string().nullable(),
      modelOverride: z.string().nullable(),
      /**
       * A running run's progress in this attempt (reading, OCR, step), as on Home; null when
       * queued, finished or nothing is reported yet. Optional for API callers built before it.
       */
      progress: JobProgressSchema.nullable().optional(),
    })
    .nullable(),
});
export type ReferenceRow = z.infer<typeof ReferenceRowSchema>;

/** One output of a reference with where its value came from (handoff RF2). */
export const ReferenceValueSchema = z.object({
  id: z.string(),
  kind: z.enum(['field', 'table']),
  /** A field's expected value, or a table's expected rows. */
  value: z.unknown().optional(),
  /** null: the corrections are unknown, or the reference is outdated for this output (re-verify). */
  provenance: z.enum(PROVENANCES).nullable(),
  /** A corrected field: the model's value (shown struck through); otherwise null. */
  proposed: z.unknown().optional(),
  /** This output's corrections (cells for a table). */
  corrections: z.array(CorrectionSchema),
});
export type ReferenceValue = z.infer<typeof ReferenceValueSchema>;

/** `GET /api/workbench/projects/:id/references/:sid` (handoff RF2): the References detail panel. */
export const ReferenceDetailSchema = z.object({
  sampleId: z.string().uuid(),
  filename: z.string(),
  role: SampleRoleSchema,
  reference: ReferenceInfoSchema,
  /** The run that proposed the values; null when it is unknown or deleted. */
  run: z
    .object({
      jobId: z.string().uuid(),
      modelOverride: z.string().nullable(),
      /** Models its succeeded step runs used (cached runs included), in first-use order. */
      models: z.array(z.string()),
    })
    .nullable(),
  /** One per output of the current version, in definition order (fields, then tables). */
  values: z.array(ReferenceValueSchema),
  corrections: z.array(CorrectionSchema).nullable(),
});
export type ReferenceDetail = z.infer<typeof ReferenceDetailSchema>;

export const FEEDBACK_TARGETS = ['field', 'table', 'step', 'section'] as const;
/** Longest feedback body the API accepts (the UI caps its text boxes to match). */
export const FEEDBACK_MAX_CHARS = 2000;
export type FeedbackTarget = (typeof FEEDBACK_TARGETS)[number];

/** A feedback target id: a lowercase output, step or section id (what `FeedbackBodySchema` takes). */
export const FEEDBACK_TARGET_ID = /^[a-z][a-z0-9_-]*$/;

export const FeedbackBodySchema = z
  .object({
    target: z.enum(FEEDBACK_TARGETS),
    targetId: z.string().regex(FEEDBACK_TARGET_ID),
    body: z.string().trim().min(1).max(FEEDBACK_MAX_CHARS),
    sampleId: z.string().uuid().optional(),
    iterationId: z.string().uuid().optional(),
  })
  .strict();

export const FeedbackItemSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string(),
  target: z.enum(FEEDBACK_TARGETS),
  targetId: z.string(),
  sampleId: z.string().uuid().nullable(),
  iterationId: z.string().uuid().nullable(),
  body: z.string(),
  createdAt: z.string(),
  /** The revise proposal that answered it (accepted or partly accepted); null while open. */
  resolvedBy: z.string().uuid().nullable(),
});
export type FeedbackItem = z.infer<typeof FeedbackItemSchema>;

export const MAX_FIELD_DIFFS = 20;
export const MAX_ROW_DIFFS = 5;

export interface FailureDiff {
  sample: string;
  score: number;
  fields: { id: string; expected: unknown; actual: unknown }[];
  tables: {
    id: string;
    missing: number;
    extra: number;
    changed: {
      expected: Record<string, unknown>;
      actual: Record<string, unknown>;
      columns: string[];
    }[];
  }[];
}

/** What a revise call sees of an evaluation: dev samples that scored below 1, trimmed. */
export function failureDiffs(
  samples: SampleResult[],
  devSampleIds: ReadonlySet<string>,
): FailureDiff[] {
  return samples.flatMap((s) => {
    const c = s.comparison;
    if (!c || c.score >= 1 || s.sampleId === null || !devSampleIds.has(s.sampleId)) return [];
    return [
      {
        sample: s.filename,
        score: c.score,
        fields: c.fields
          .filter((f) => !f.match)
          .slice(0, MAX_FIELD_DIFFS)
          .map(({ id, expected, actual }) => ({ id, expected, actual })),
        tables: c.tables
          .filter((t) => t.missing.length || t.extra.length || t.changed.length)
          .map((t) => ({
            id: t.id,
            missing: t.missing.length,
            extra: t.extra.length,
            changed: t.changed.slice(0, MAX_ROW_DIFFS),
          })),
      },
    ];
  });
}

/** Most dev samples a drafting call sees, and most failures a revision sends (worker drafting.MAX_CONTEXT_SAMPLES). */
export const MAX_CONTEXT_SAMPLES = 8;

/**
 * The failures a revision sends (mirrors worker drafting.select_failures; shared fixture
 * revise-failures.json): dev files only, lowest score first (ties keep their order), at most
 * MAX_CONTEXT_SAMPLES. The API applies it before writing the job, so the worker's own pass is a no-op.
 */
export function revisionFailures(
  failures: readonly FailureDiff[],
  devFiles: ReadonlySet<string>,
): FailureDiff[] {
  return failures
    .filter((f) => devFiles.has(f.sample))
    .sort((a, b) => a.score - b.score) // Array.prototype.sort is stable
    .slice(0, MAX_CONTEXT_SAMPLES);
}

/** `FailureDiff` as documented in the API (expected and actual are any JSON value). */
export const FailureDiffSchema = z.object({
  sample: z.string(),
  score: z.number(),
  fields: z.array(
    z.object({ id: z.string(), expected: z.unknown().optional(), actual: z.unknown().optional() }),
  ),
  tables: z.array(
    z.object({
      id: z.string(),
      missing: z.number().int(),
      extra: z.number().int(),
      changed: z.array(
        z.object({
          expected: z.record(z.string(), z.unknown()),
          actual: z.record(z.string(), z.unknown()),
          columns: z.array(z.string()),
        }),
      ),
    }),
  ),
});
export type SentFailure = z.infer<typeof FailureDiffSchema>;

/** One open feedback item as a revise job's `params.feedback` carries it (RV2: with its id). */
export const RevisionFeedbackSchema = z.object({
  id: z.string().uuid(),
  target: z.enum(FEEDBACK_TARGETS),
  targetId: z.string(),
  /** The dev sample's file name, when the feedback names one. */
  sample: z.string().nullable(),
  body: z.string(),
});
export type RevisionFeedback = z.infer<typeof RevisionFeedbackSchema>;

/** `GET …/stages/revise/preview` (handoff RV1): what the next revise call sends, and what it never does. */
export const RevisePreviewSchema = z.object({
  feedback: z.array(RevisionFeedbackSchema),
  /** Already trimmed with `revisionFailures`. */
  failures: z.array(FailureDiffSchema),
  /** Failing dev samples before the MAX_CONTEXT_SAMPLES cap. */
  failuresTotal: z.number().int(),
  /** The latest complete dev iteration the failures come from; null when there is none. */
  failuresFrom: z
    .object({
      iterationId: z.string().uuid(),
      templateVersion: z.number().int(),
      model: z.string().nullable(),
      createdAt: z.string(),
      /** Current dev samples it compared. */
      compared: z.number().int(),
    })
    .nullable(),
  /** The drafting model setting (`endpoint/model-id`); null when unset. */
  model: z.string().nullable(),
  /** What the latest dev test runs of the open draft show; null when nothing is flagged. */
  diagnostics: RunDiagnosticsSchema.nullable(),
  /** The open draft sent as `<current_draft>`; null without one (a revision needs one). */
  draft: z
    .object({ version: z.number().int(), definition: z.record(z.string(), z.unknown()) })
    .nullable(),
  /** Dev sample files whose text is sent (at most MAX_CONTEXT_SAMPLES). */
  samples: z.array(z.string()),
  limits: z.object({
    samples: z.number().int(),
    fieldDiffs: z.number().int(),
    rowDiffs: z.number().int(),
  }),
  /** Never sent (the holdout rule): shown so the user knows. */
  notSent: z.object({
    /** Ready holdout samples. */
    holdoutSamples: z.number().int(),
    /** The newest holdout iteration. */
    holdoutRun: z
      .object({
        iterationId: z.string().uuid(),
        status: z.enum(['running', 'complete']),
        score: z.number().nullable(),
      })
      .nullable(),
  }),
});
export type RevisePreview = z.infer<typeof RevisePreviewSchema>;

export const PublishBodySchema = z
  .object({
    overrideReason: z.string().trim().min(10).max(1000).optional(),
    ...PublishLabelSchema.shape,
  })
  .strict();
export const ThresholdBodySchema = z
  .object({ publishThreshold: z.number().min(0).max(1) })
  .strict();

export interface GateCandidate {
  id: string;
  status: 'running' | 'complete';
  score: number | null;
  /** The iteration ran the open draft as it is now (version and definition snapshot). */
  matchesDraft: boolean;
  createdAt: string;
  /** Samples compared with their reference / samples the iteration evaluated. */
  completed: number;
  total: number;
  /** Model override of the iteration; only null (the recipe's own models) counts. */
  model: string | null;
  /** Currently ready holdout samples the iteration evaluated / currently ready holdout samples. */
  covered: number;
  holdoutSamples: number;
}

export const GateViewSchema = z.object({
  threshold: z.number(),
  iterationId: z.string().uuid().nullable(),
  score: z.number().nullable(),
  passes: z.boolean(),
  reason: z.string(),
});
export type GateView = z.infer<typeof GateViewSchema>;

/** Why an output lowers the holdout score (handoff EV1): no step fills it, or it is often wrong. */
export const GATE_HINT_CAUSES = ['no_step', 'low_accuracy'] as const;
/** The tab that fixes each cause: Pipeline (the `steps` stage) adds the missing step; Revise improves one from dev feedback. */
export const GATE_HINT_STAGES = ['steps', 'revise'] as const;
/** At most this many hints, worst first. */
export const MAX_GATE_HINTS = 5;

export const GateHintSchema = z.object({
  /** A field id or `table.column`, as in the scorecard. */
  key: z.string(),
  accuracy: z.number(),
  cause: z.enum(GATE_HINT_CAUSES),
  stage: z.enum(GATE_HINT_STAGES),
});
export type GateHint = z.infer<typeof GateHintSchema>;

/** `GET /api/workbench/projects/:id/publish-gate`: the gate and what lowers its score. The overview's gate has no hints. */
export const PublishGateViewSchema = GateViewSchema.extend({ hints: z.array(GateHintSchema) });
export type PublishGateView = z.infer<typeof PublishGateViewSchema>;

/**
 * What lowers the deciding holdout run's score (EV1): its fields and `table.column`s below the
 * threshold, worst first (a missing step before a low accuracy on a tie, then by key), at most
 * `MAX_GATE_HINTS`. `no_step` when no extract step of `definition` fills the output (a column
 * takes its table's coverage, or its own on a table some step enriches; a key the definition
 * does not define is not filled either).
 */
export function gateHints({
  threshold,
  scorecard,
  definition,
}: {
  threshold: number;
  scorecard: Pick<Scorecard, 'fields' | 'columns'>;
  definition: unknown;
}): GateHint[] {
  const coverage = outputCoverage(definition).outputs;
  const filled = new Set([
    ...coverage.filter((o) => o.steps.length > 0).map((o) => o.id),
    // An enriched table's columns: each its own filler (P4).
    ...coverage.flatMap((o) =>
      (o.columns ?? []).filter((c) => c.steps.length > 0).map((c) => `${o.id}.${c.id}`),
    ),
  ]);
  const hint = (a: Accuracy, output: string): GateHint =>
    filled.has(output)
      ? { key: a.id, accuracy: a.accuracy, cause: 'low_accuracy', stage: 'revise' }
      : { key: a.id, accuracy: a.accuracy, cause: 'no_step', stage: 'steps' };
  const tableOf = (id: string) => {
    const dot = id.indexOf('.');
    return dot < 0 ? id : id.slice(0, dot);
  };
  const rank = (h: GateHint) => (h.cause === 'no_step' ? 0 : 1);
  return [
    ...scorecard.fields.map((a) => hint(a, a.id)),
    ...scorecard.columns.map((a) => {
      const table = coverage.find((o) => o.id === tableOf(a.id));
      return hint(a, table?.columns ? a.id : tableOf(a.id));
    }),
  ]
    .filter((h) => h.accuracy < threshold)
    .sort((a, b) => a.accuracy - b.accuracy || rank(a) - rank(b) || a.key.localeCompare(b.key))
    .slice(0, MAX_GATE_HINTS);
}

export const percent = (x: number, digits = 0) =>
  digits ? `${(x * 100).toFixed(digits)}%` : `${Math.round(x * 100)}%`;

/**
 * The publish gate (ADR 0007): the newest complete holdout run of the current draft with the
 * template's own models decides. It passes only when it covered every ready holdout sample,
 * compared every sample it evaluated, and scored at or above the threshold.
 */
export function publishGate({
  threshold,
  candidates,
}: {
  threshold: number;
  candidates: GateCandidate[];
}): GateView {
  const run = candidates
    .filter((c) => c.status === 'complete' && c.matchesDraft && c.model === null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!run) {
    return {
      threshold,
      iterationId: null,
      score: null,
      passes: false,
      reason: 'no complete holdout evaluation of the current draft',
    };
  }
  const gate = (passes: boolean, reason: string): GateView => ({
    threshold,
    iterationId: run.id,
    score: run.score,
    passes,
    reason,
  });
  if (run.covered !== run.holdoutSamples) {
    return gate(
      false,
      `holdout evaluation covered ${run.covered} of ${run.holdoutSamples} holdout samples`,
    );
  }
  if (run.completed !== run.total) {
    return gate(false, `holdout evaluation compared ${run.completed} of ${run.total} samples`);
  }
  if (run.score === null) return gate(false, 'holdout evaluation produced no score');
  const passes = run.score >= threshold;
  // A tie in whole percentages would read "90% is below 90%": show one decimal then.
  const digits = !passes && percent(run.score) === percent(threshold) ? 1 : 0;
  const [score, limit] = [percent(run.score, digits), percent(threshold, digits)];
  return gate(
    passes,
    passes
      ? `holdout score ${score} meets the threshold ${limit}`
      : `holdout score ${score} is below the threshold ${limit}`,
  );
}

export const PublicationSchema = z.object({
  id: z.string().uuid(),
  projectId: z.string(),
  version: z.number().int(),
  iterationId: z.string().uuid().nullable(),
  score: z.number().nullable(),
  threshold: z.number(),
  overrideReason: z.string().nullable(),
  /** Label of the session's token. */
  publishedBy: z.string().nullable(),
  publishedAt: z.string(),
});
export type Publication = z.infer<typeof PublicationSchema>;
