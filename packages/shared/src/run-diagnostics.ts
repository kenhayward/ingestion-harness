import { z } from 'zod';
import { MissedKeySchema } from './workbench.js';

/** A step is flagged from this many calls on (a handful of empty calls is noise). */
export const MIN_FLAGGED_CALLS = 4;
/** ... when at least this share of its calls came back empty. */
export const EMPTY_SHARE = 0.5;
export const MAX_EXAMPLES = 3;
export const MAX_DIAGNOSTIC_ROWS = 20;

export const DiagnosticRunSchema = z.object({
  jobId: z.string(),
  /** The sample's file name. */
  sample: z.string(),
  events: z.array(z.object({ message: z.string(), data: z.unknown() })),
  stepRuns: z.array(
    z.object({
      stepId: z.string(),
      startedAt: z.string(),
      finishedAt: z.string(),
      cached: z.boolean(),
    }),
  ),
  issues: z.array(
    z.object({
      step: z.string(),
      target: z.string(),
      column: z.string().nullable(),
      raw: z.string(),
    }),
  ),
});
export type DiagnosticRun = z.infer<typeof DiagnosticRunSchema>;

export const RunDiagnosticsSchema = z.object({
  from: z.object({
    draftVersion: z.number().int(),
    jobIds: z.array(z.string()),
    at: z.string(),
  }),
  steps: z.array(
    z.object({
      step: z.string(),
      sample: z.string(),
      calls: z.number().int(),
      emptyCalls: z.number().int(),
      seconds: z.number().int(),
    }),
  ),
  columns: z.array(
    z.object({
      step: z.string(),
      target: z.string(),
      column: z.string().nullable(),
      issues: z.number().int(),
      examples: z.array(z.string()),
    }),
  ),
  missedKeys: z.array(
    z.object({
      sample: z.string(),
      sections: z.array(z.string()),
      keys: z.array(z.string()),
      total: z.number().int(),
    }),
  ),
});
export type RunDiagnostics = z.infer<typeof RunDiagnosticsSchema>;

const StepCallsSchema = z.object({
  calls: z.number().int().nonnegative(),
  emptyCalls: z.number().int().nonnegative(),
});
const SegmentedDataSchema = z.object({
  missedKeys: z.array(MissedKeySchema).optional(),
  missedKeysTotal: z.number().int().positive().optional(),
});

const STEP_PREFIXES = ['extracted ', 're-ran '];
const CACHED_PREFIX = 'reused cached ';

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function stepSeconds(run: DiagnosticRun, step: string): number {
  let newest: { start: string; end: string } | null = null;
  for (const r of run.stepRuns) {
    if (r.stepId !== step || r.cached) continue;
    if (newest === null || r.finishedAt > newest.end)
      newest = { start: r.startedAt, end: r.finishedAt };
  }
  if (newest === null) return 0;
  const ms = Date.parse(newest.end) - Date.parse(newest.start);
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
}

function flaggedSteps(run: DiagnosticRun): RunDiagnostics['steps'] {
  // The last event of a step decides: a cache hit made no calls and is never flagged.
  const last = new Map<string, { counts: z.infer<typeof StepCallsSchema> | null }>();
  for (const e of run.events) {
    if (e.message.startsWith(CACHED_PREFIX)) {
      last.set(e.message.slice(CACHED_PREFIX.length), { counts: null });
      continue;
    }
    const prefix = STEP_PREFIXES.find((p) => e.message.startsWith(p));
    if (prefix === undefined) continue;
    const parsed = StepCallsSchema.safeParse(e.data);
    last.set(e.message.slice(prefix.length), { counts: parsed.success ? parsed.data : null });
  }
  const rows: RunDiagnostics['steps'] = [];
  for (const [step, { counts }] of last) {
    if (counts === null || counts.calls < MIN_FLAGGED_CALLS) continue;
    if (counts.emptyCalls / counts.calls < EMPTY_SHARE) continue;
    rows.push({ step, sample: run.sample, ...counts, seconds: stepSeconds(run, step) });
  }
  return rows;
}

/**
 * What dev test runs show about a draft's weak spots: steps whose repeating-section calls
 * mostly came back empty, columns the normaliser could not read, and keys no anchor caught.
 * Null when nothing is flagged.
 */
export function runDiagnostics(
  runs: DiagnosticRun[],
  draftVersion: number,
  at?: string,
): RunDiagnostics | null {
  const steps: RunDiagnostics['steps'] = [];
  const missedKeys: RunDiagnostics['missedKeys'] = [];
  const columnMap = new Map<
    string,
    { step: string; target: string; column: string | null; issues: number; examples: string[] }
  >();

  for (const run of runs) {
    steps.push(...flaggedSteps(run));

    // A step re-run segments again: like a step's, the last segmented event decides.
    const segmented = run.events.filter((e) => e.message === 'segmented').at(-1);
    const parsed = segmented ? SegmentedDataSchema.safeParse(segmented.data) : null;
    if (parsed?.success && parsed.data.missedKeys?.length) {
      const entries = parsed.data.missedKeys;
      const sections: string[] = [];
      for (const m of entries)
        for (const s of m.sections) if (!sections.includes(s)) sections.push(s);
      const keys = entries.map((m) => m.key);
      missedKeys.push({
        sample: run.sample,
        sections,
        keys,
        total: parsed.data.missedKeysTotal ?? keys.length,
      });
    }

    for (const i of run.issues) {
      const id = JSON.stringify([i.step, i.target, i.column]);
      let row = columnMap.get(id);
      if (row === undefined) {
        row = { step: i.step, target: i.target, column: i.column, issues: 0, examples: [] };
        columnMap.set(id, row);
      }
      row.issues += 1;
      if (row.examples.length < MAX_EXAMPLES && !row.examples.includes(i.raw))
        row.examples.push(i.raw);
    }
  }

  const share = (s: RunDiagnostics['steps'][number]): number => s.emptyCalls / s.calls;
  steps.sort(
    (a, b) =>
      share(b) - share(a) ||
      b.calls - a.calls ||
      byName(a.step, b.step) ||
      byName(a.sample, b.sample),
  );
  const columns = [...columnMap.values()].sort(
    (a, b) =>
      b.issues - a.issues ||
      byName(a.step, b.step) ||
      byName(a.target, b.target) ||
      byName(a.column ?? '', b.column ?? ''),
  );
  missedKeys.sort((a, b) => b.total - a.total || byName(a.sample, b.sample));

  const result: RunDiagnostics = {
    from: {
      draftVersion,
      jobIds: runs.map((r) => r.jobId),
      at: at ?? newestFinish(runs),
    },
    steps: steps.slice(0, MAX_DIAGNOSTIC_ROWS),
    columns: columns.slice(0, MAX_DIAGNOSTIC_ROWS),
    missedKeys: missedKeys.slice(0, MAX_DIAGNOSTIC_ROWS),
  };
  return diagnosticsCount(result) === 0 ? null : result;
}

function newestFinish(runs: DiagnosticRun[]): string {
  let newest = '';
  for (const r of runs)
    for (const s of r.stepRuns) if (s.finishedAt > newest) newest = s.finishedAt;
  return newest === '' ? new Date().toISOString() : newest;
}

/** The flagged rows. */
export function diagnosticsCount(d: RunDiagnostics | null): number {
  return d === null ? 0 : d.steps.length + d.columns.length + d.missedKeys.length;
}
