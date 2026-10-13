import type { OutputCoverage } from '@ih/shared';
import type { TemplateMetrics } from '../api/client.js';

/** Average attempts per run at which a step's figures turn warn and its card explains retries. */
export const RETRY_WARN_ATTEMPTS = 1.5;

export type StepMetric = TemplateMetrics['steps'][number];

export interface StepCard {
  number: number;
  id: string;
  kind: 'EXTRACT' | 'CHECK';
  /** Extract steps: the model ref (`default` when unset); check steps call no model. */
  model: string | null;
  fills: string[];
  reads: string[];
  chunkPages: number | null;
  /** Check steps: "values = reference". */
  compares: string | null;
}

type Def = Record<string, unknown>;
const obj = (v: unknown): Def =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Def) : {};
const list = (v: unknown): Def[] => (Array.isArray(v) ? v.map(obj) : []);
const ids = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** The draft's pipeline as the Steps tab's cards, numbered in order. */
export function stepCards(definition: Def): StepCard[] {
  return list(definition.pipeline)
    .filter((s): s is Def & { id: string } => typeof s.id === 'string')
    .map((s, i) =>
      s.type === 'check'
        ? {
            number: i + 1,
            id: s.id,
            kind: 'CHECK' as const,
            model: null,
            fills: [],
            reads: [],
            chunkPages: null,
            compares:
              [s.values, s.reference]
                .filter((x): x is string => typeof x === 'string' && x !== '')
                .join(' = ') || null,
          }
        : {
            number: i + 1,
            id: s.id,
            kind: 'EXTRACT' as const,
            model: typeof s.model === 'string' ? s.model : 'default',
            fills: typeof s.table === 'string' ? [s.table] : ids(s.fields),
            reads: ids(s.sections),
            chunkPages: typeof s.chunkPages === 'number' ? s.chunkPages : null,
            compares: null,
          },
    );
}

export function sectionIds(definition: Def): string[] {
  return ids(list(obj(definition.document).sections).map((s) => s.id));
}

/** The pipeline's last line: "Outputs: 9 fields · line_items". */
export function outputsLine(definition: Def): string {
  const outputs = obj(definition.outputs);
  const tables = ids(list(outputs.tables).map((t) => t.id));
  return [`Outputs: ${plural(list(outputs.fields).length, 'field')}`, ...tables].join(' · ');
}

/** The coverage strip's headline; `after` is the coverage with the selected changes applied. */
export function coverageHeadline(
  now: OutputCoverage,
  after: OutputCoverage | null,
): { tone: 'ok' | 'warn'; text: string } {
  const n = now.uncovered.length;
  if (n === 0) {
    return now.multiple.length === 0
      ? { tone: 'ok', text: 'Every output is filled by exactly one step' }
      : {
          tone: 'warn',
          text: `${plural(now.multiple.length, 'output')} ${now.multiple.length === 1 ? 'is' : 'are'} filled by more than one step`,
        };
  }
  const base = `${plural(n, 'output')} not filled by any step`;
  if (after === null) return { tone: 'warn', text: base };
  const fixed = now.uncovered.filter((id) => !after.uncovered.includes(id)).length;
  const them = n === 1 ? 'it' : 'them';
  const tail =
    fixed === n
      ? `the proposal fixes ${them}`
      : fixed > 0
        ? `the proposal fixes ${fixed}`
        : `the proposal does not fix ${them}`;
  return { tone: 'warn', text: `${base} — ${tail}` };
}

export function stepFigures(m: StepMetric | undefined) {
  if (!m) return null;
  return {
    runs: String(m.runs),
    failed: String(m.failures),
    attempts: m.avgAttempts.toFixed(1),
    avgTime: m.avgSeconds === null ? '—' : `${Math.round(m.avgSeconds)} s`,
    failedWarn: m.failures > 0,
    attemptsWarn: m.avgAttempts >= RETRY_WARN_ATTEMPTS,
  };
}

export function retryWarning(m: StepMetric | undefined): string | null {
  if (!m || m.runs === 0 || m.avgAttempts < RETRY_WARN_ATTEMPTS) return null;
  return `Needs a retry on many runs (${m.avgAttempts.toFixed(1)} attempts on average): the first answer often fails the checks. Narrow the sections it reads or add instructions on the Template tab.`;
}
