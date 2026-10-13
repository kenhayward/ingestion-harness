import { z } from 'zod';
import type { JobStatus } from './jobs.js';

/** Workbench evaluation (ADR 0007, phase 4a): comparisons, scorecards, iterations. */

const Row = z.record(z.string(), z.unknown());

export const FieldComparisonSchema = z.object({
  id: z.string(),
  expected: z.unknown(),
  actual: z.unknown(),
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

export const EVALUATION_MODELS = ['default', 'fast', 'draft'] as const;
export type EvaluationModel = (typeof EVALUATION_MODELS)[number];

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

export interface Accuracy {
  id: string;
  matched: number;
  total: number;
  accuracy: number;
}

export interface SampleResult {
  sampleId: string | null;
  filename: string;
  jobId: string | null;
  status: JobStatus | null;
  error: string | null;
  comparison: Comparison | null;
}

export interface Scorecard {
  /** Mean per-sample score over compared samples; null when none was compared. */
  score: number | null;
  completed: number;
  total: number;
  /** Worst first. */
  fields: Accuracy[];
  /** `table.column`, worst first. */
  columns: Accuracy[];
}

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

export interface IterationSummary {
  id: string;
  projectId: string;
  templateVersion: number;
  briefVersion: number | null;
  set: EvaluationSet;
  /** Alias every step was overridden with; null = the template's own models. */
  model: EvaluationModel | null;
  /** Shared by the iterations of one model comparison. */
  groupId: string | null;
  /** Every step called its model (the step cache was not read). */
  uncached: boolean;
  createdAt: string;
  status: 'running' | 'complete';
  score: number | null;
  completed: number;
  total: number;
}

export interface IterationView extends IterationSummary {
  /** Succeeded step runs of the iteration's jobs; `reused` were served from the step cache. */
  cache: { reused: number; total: number };
  scorecard: Scorecard;
  samples: SampleResult[];
}

export interface ComparisonView {
  groupId: string;
  iterations: IterationView[];
}

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

/** One dev sample on the References tab. */
export interface ReferenceRow {
  sampleId: string;
  filename: string;
  sha256: string;
  reference: {
    id: string;
    name: string;
    createdAt: string;
    /** Version it is pinned to; null for an unpinned (legacy) reference. */
    version: number | null;
    /** Version it was carried forward from, when it is a copy. */
    carriedFrom: number | null;
    /** `outputChanges` against the version's outputs: non-empty means re-verify before use. */
    outdated: string[];
  } | null;
  /** Latest test run of this sample that is not an evaluation run. */
  run: {
    jobId: string;
    status: JobStatus;
    error: string | null;
    modelOverride: string | null;
  } | null;
}

export const FEEDBACK_TARGETS = ['field', 'table', 'step', 'section'] as const;
/** Longest feedback body the API accepts (the UI caps its text boxes to match). */
export const FEEDBACK_MAX_CHARS = 2000;
export type FeedbackTarget = (typeof FEEDBACK_TARGETS)[number];

export const FeedbackBodySchema = z
  .object({
    target: z.enum(FEEDBACK_TARGETS),
    targetId: z.string().regex(/^[a-z][a-z0-9_-]*$/),
    body: z.string().trim().min(1).max(FEEDBACK_MAX_CHARS),
    sampleId: z.string().uuid().optional(),
    iterationId: z.string().uuid().optional(),
  })
  .strict();

export interface FeedbackItem {
  id: string;
  projectId: string;
  target: FeedbackTarget;
  targetId: string;
  sampleId: string | null;
  iterationId: string | null;
  body: string;
  createdAt: string;
  /** The revise proposal that answered it (accepted or partly accepted); null while open. */
  resolvedBy: string | null;
}

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

export const PublishBodySchema = z
  .object({ overrideReason: z.string().trim().min(10).max(1000).optional() })
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
  /** Model override of the iteration; only null (the template's own models) counts. */
  model: string | null;
  /** Currently ready holdout samples the iteration evaluated / currently ready holdout samples. */
  covered: number;
  holdoutSamples: number;
}

export const GateViewSchema = z.object({
  threshold: z.number(),
  iterationId: z.string().nullable(),
  score: z.number().nullable(),
  passes: z.boolean(),
  reason: z.string(),
});
export type GateView = z.infer<typeof GateViewSchema>;

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

export interface Publication {
  id: string;
  projectId: string;
  version: number;
  iterationId: string | null;
  score: number | null;
  threshold: number;
  overrideReason: string | null;
  /** Label of the session's token. */
  publishedBy: string | null;
  publishedAt: string;
}
