import {
  EVALUATION_MODELS,
  type Accuracy,
  type Comparison,
  type EvaluationSet,
  type GateHint,
  type GateView,
  type IterationSummary,
  type Scorecard,
  type TableComparison,
} from '@ih/shared';

/** Pure helpers of the Evaluate tab (handoff §8). */

const pct = (n: number) => `${Math.round(n * 100)}%`;
const DOT = '·';

/** Accuracy colours: red under 70 %, amber under the threshold, green at or above it. */
export const LOW_ACCURACY = 0.7;
export type AccuracyTone = 'low' | 'below' | 'ok';

export function accuracyTone(accuracy: number, threshold: number): AccuracyTone {
  if (accuracy >= threshold) return 'ok';
  return accuracy < LOW_ACCURACY ? 'low' : 'below';
}

const TONE_WORDS: Record<AccuracyTone, string> = {
  low: 'under 70%',
  below: 'under the threshold',
  ok: 'meets the threshold',
};

/** An accuracy bar's text alternative: the colour in words, never colour alone. */
export function accuracyLabel(a: Accuracy, threshold: number): string {
  return `${a.id}: ${pct(a.accuracy)}, ${a.matched} of ${a.total}, ${TONE_WORDS[accuracyTone(a.accuracy, threshold)]}`;
}

export const ACCURACY_ROWS = 8;

/** Fields and columns worst first; those at 100 % are only counted. */
export function accuracyList(
  scorecard: Pick<Scorecard, 'fields' | 'columns'>,
  limit = ACCURACY_ROWS,
): { rows: Accuracy[]; more: number; perfect: number } {
  const all = [...scorecard.fields, ...scorecard.columns].sort(
    (a, b) => a.accuracy - b.accuracy || a.id.localeCompare(b.id),
  );
  const imperfect = all.filter((a) => a.accuracy < 1);
  const rows = imperfect.slice(0, limit);
  return { rows, more: imperfect.length - rows.length, perfect: all.length - imperfect.length };
}

const tableDiffers = (t: TableComparison) =>
  t.missing.length + t.extra.length + t.changed.length > 0;

/** "Off: …": the fields that differ, then the tables with a missing, extra or changed row. */
export function offOutputs(c: Comparison): string[] {
  return [
    ...c.fields.filter((f) => !f.match).map((f) => f.id),
    ...c.tables.filter(tableDiffers).map((t) => t.id),
  ];
}

export function outputsDiffering(c: Comparison): { differ: number; of: number } {
  return { differ: offOutputs(c).length, of: c.fields.length + c.tables.length };
}

const rows = (n: number) => `${n} row${n === 1 ? '' : 's'}`;

/** A table's actual rows and, when it differs, the non-zero changed / missing / extra counts. */
export function tableDiff(t: TableComparison): string {
  const parts = [
    [t.changed.length, 'changed'],
    [t.missing.length, 'missing'],
    [t.extra.length, 'extra'],
  ] as const;
  return [rows(t.actual), ...parts.filter(([n]) => n > 0).map(([n, w]) => `${n} ${w}`)].join(
    ` ${DOT} `,
  );
}

/** The newest iteration of a set that is not a member of a model comparison. */
export function latestOf(
  history: readonly IterationSummary[],
  set: EvaluationSet,
): IterationSummary | null {
  return history.find((h) => h.set === set && h.groupId === null) ?? null;
}

const templateRun = (h: IterationSummary) => h.model === null && h.groupId === null;

/** The Dev meter: the newest complete dev run of `version` with the template's own models. */
export function devScore(
  history: readonly IterationSummary[],
  version: number | null,
): number | null {
  if (version === null) return null;
  return (
    history.find(
      (h) =>
        h.set === 'dev' &&
        templateRun(h) &&
        h.status === 'complete' &&
        h.templateVersion === version,
    )?.score ?? null
  );
}

export interface HistoryRow {
  id: string;
  /** The iteration Restore uses (a comparison's members share the definition snapshot). */
  restoreId: string;
  version: number;
  set: EvaluationSet;
  label: string;
  createdAt: string;
  /** Null while running or when nothing was compared. */
  score: number | null;
  running: boolean;
}

const modelRank = (h: IterationSummary) => (h.model ? EVALUATION_MODELS.indexOf(h.model) : -1);
const scoreOf = (h: IterationSummary) => (h.status === 'complete' ? h.score : null);
const whole = (n: number | null) => (n === null ? '–' : String(Math.round(n * 100)));

/** The iteration list, newest first; a model comparison is one row ("Compare · default 91 · …"). */
export function historyRows(history: readonly IterationSummary[]): HistoryRow[] {
  const members = new Map<string, IterationSummary[]>();
  for (const h of history) {
    if (h.groupId) members.set(h.groupId, [...(members.get(h.groupId) ?? []), h]);
  }
  const seen = new Set<string>();
  return history.flatMap((h): HistoryRow[] => {
    const base = {
      id: h.id,
      restoreId: h.id,
      version: h.templateVersion,
      set: h.set,
      createdAt: h.createdAt,
    };
    const fresh = h.uncached ? ` ${DOT} fresh` : '';
    if (!h.groupId) {
      return [
        {
          ...base,
          label: `${h.model ?? "Template's models"}${fresh}`,
          score: scoreOf(h),
          running: h.status === 'running',
        },
      ];
    }
    if (seen.has(h.groupId)) return [];
    seen.add(h.groupId);
    const group = [...members.get(h.groupId)!].sort((a, b) => modelRank(a) - modelRank(b));
    const scores = group.map(scoreOf).filter((s): s is number => s !== null);
    return [
      {
        ...base,
        label: `Compare ${DOT} ${group.map((g) => `${g.model ?? 'template'} ${whole(scoreOf(g))}`).join(` ${DOT} `)}${fresh}`,
        score: scores.length ? Math.max(...scores) : null,
        running: group.some((g) => g.status === 'running'),
      },
    ];
  });
}

export interface HistoryBar {
  id: string;
  version: number;
  set: EvaluationSet;
  score: number;
  /** A run of another version than the current one. */
  dimmed: boolean;
}

export const HISTORY_BARS = 12;

/** The chart: finished template-model runs with a score, the newest `limit`, oldest first. */
export function historyBars(
  history: readonly IterationSummary[],
  version: number | null,
  limit = HISTORY_BARS,
): HistoryBar[] {
  const current = version ?? Math.max(0, ...history.map((h) => h.templateVersion));
  return history
    .filter((h) => templateRun(h) && h.status === 'complete' && h.score !== null)
    .slice(0, limit)
    .reverse()
    .map((h) => ({
      id: h.id,
      version: h.templateVersion,
      set: h.set,
      score: h.score!,
      dimmed: h.templateVersion !== current,
    }));
}

/** The chart's text alternative. */
export function historySummary(bars: readonly HistoryBar[], threshold: number): string {
  if (!bars.length) return 'No template-model runs yet';
  const part = (set: EvaluationSet) => {
    const b = [...bars].reverse().find((x) => x.set === set);
    return b ? `latest ${set} ${pct(b.score)} (v${b.version})` : `no ${set} run`;
  };
  return `${bars.length} template-model runs; ${part('dev')}; ${part('holdout')}; threshold ${pct(threshold)}`;
}

/** The threshold box: a whole percentage from 0 to 100, as a fraction. */
export function parseThreshold(text: string): { value: number } | { error: string } {
  const t = text.trim();
  const n = Number(t);
  if (!/^\d{1,3}$/.test(t) || n > 100) {
    return { error: 'Enter a whole percentage from 0 to 100' };
  }
  return { value: n / 100 };
}

export interface GateTag {
  label: 'PUBLISHED' | 'MEETS THRESHOLD' | 'BELOW THRESHOLD' | 'NOT MEASURED';
  tone: 'ok' | 'warn' | 'neutral';
}

/** Informational (#77): nothing is ever locked. */
export function gateTag(gate: GateView | null, draft: number | null): GateTag {
  if (draft === null) return { label: 'PUBLISHED', tone: 'ok' };
  if (gate?.passes) return { label: 'MEETS THRESHOLD', tone: 'ok' };
  if (!gate || gate.score === null) return { label: 'NOT MEASURED', tone: 'neutral' };
  return { label: 'BELOW THRESHOLD', tone: 'warn' };
}

export function gateTitle(
  gate: GateView | null,
  draft: number | null,
  published: number | null,
): string {
  if (draft === null) {
    return published === null
      ? 'Nothing to publish'
      : `v${published} is live. Start the next version on the Template tab.`;
  }
  return gate ? `Publish v${draft} — ${gate.reason}` : `Publish v${draft}`;
}

/** A hint in plain words (EV1); the link text comes from `HINT_LINK`. */
export function hintText(h: GateHint): string {
  return h.cause === 'no_step'
    ? `${h.key} scores ${pct(h.accuracy)} on holdout: no step of the draft fills it.`
    : `${h.key} is right on ${pct(h.accuracy)} of holdout values. Comment on its dev mismatches, then revise.`;
}

export const HINT_LINK: Record<GateHint['stage'], string> = {
  steps: 'Open Steps',
  revise: 'Open Revise',
};
