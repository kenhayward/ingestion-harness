import type { JobStatus } from './jobs.js';

/** Workbench evaluation (ADR 0007, phase 4a): comparisons, scorecards, iterations. */

export interface FieldComparison {
  id: string;
  expected: unknown;
  actual: unknown;
  match: boolean;
}

export interface TableComparison {
  id: string;
  expected: number;
  actual: number;
  /** Rows identical to their expected counterpart. */
  matched: number;
  /** Expected rows with no counterpart sharing any cell. */
  missing: Record<string, unknown>[];
  /** Actual rows not aligned to any expected row. */
  extra: Record<string, unknown>[];
  /** Aligned rows that differ, with the differing columns. */
  changed: {
    expected: Record<string, unknown>;
    actual: Record<string, unknown>;
    columns: string[];
  }[];
  /** Equal cells / all cells considered (aligned rows, missing rows, extra rows). */
  cells: number;
  cellsTotal: number;
  /** The same cell counts per column. */
  columns: Record<string, { matched: number; total: number }>;
}

export interface Comparison {
  /** (matched fields + equal cells) / (fields + all cells considered); 1 = identical. */
  score: number;
  fields: FieldComparison[];
  tables: TableComparison[];
}

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

export interface IterationSummary {
  id: string;
  projectId: string;
  templateVersion: number;
  briefVersion: number | null;
  set: 'dev';
  /** Alias every step was overridden with; null = the template's own models. */
  model: EvaluationModel | null;
  createdAt: string;
  status: 'running' | 'complete';
  score: number | null;
  completed: number;
  total: number;
}

export interface IterationView extends IterationSummary {
  scorecard: Scorecard;
  samples: SampleResult[];
}

/** One dev sample on the References tab. */
export interface ReferenceRow {
  sampleId: string;
  filename: string;
  sha256: string;
  reference: { id: string; name: string; createdAt: string } | null;
  /** Latest test run of this sample that is not an evaluation run. */
  run: {
    jobId: string;
    status: JobStatus;
    error: string | null;
    modelOverride: string | null;
  } | null;
}
