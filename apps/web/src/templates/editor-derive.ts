import type { JobSummary, TemplateChange } from '@ih/shared';
import { RETIRED_REASON } from '../ui/retired.js';
import { plural } from './quality.js';

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Why Publish is disabled (shown as its title and next to it), or null when it can publish. */
export function publishBlocker(dirty: boolean, issues: number, retired = false): string | null {
  if (retired) return RETIRED_REASON;
  if (dirty) return 'Save the draft before publishing';
  if (issues > 0) return `Fix ${plural(issues, 'validation issue')}`;
  return null;
}

/**
 * The narrowest a row table may be: the index, its fixed columns, 10rem for each flexible one
 * and the actions. Below that the table (and its card) grows instead of squeezing the flexible
 * columns to nothing, e.g. when the page is zoomed in.
 */
export function rowTableMinWidth(columns: readonly [string, string | undefined][]): string {
  const widths = ['2.5rem', ...columns.map(([, w]) => w ?? '10rem'), '9rem'];
  return `calc(${widths.join(' + ')})`;
}

/** Tab counts; parts an unfinished draft lacks count 0. */
export function tabCounts(def: {
  document?: { sections?: unknown };
  outputs?: { fields?: unknown; tables?: unknown };
  pipeline?: unknown;
}) {
  return {
    sections: list(def.document?.sections).length,
    fields: list(def.outputs?.fields).length,
    tables: list(def.outputs?.tables).length,
    steps: list(def.pipeline).length,
  };
}

/** What a pipeline step is, as its tag reads (an unknown or missing type reads as extract). */
export type StepKind = 'EXTRACT' | 'CHECK' | 'PLUGIN';

export function stepKind(step: Record<string, unknown>): StepKind {
  if (step.type === 'check') return 'CHECK';
  if (step.type === 'plugin') return 'PLUGIN';
  return 'EXTRACT';
}

/** The tag tone of each kind of step. */
export const STEP_KIND_TONE: Record<StepKind, string> = {
  EXTRACT: 'tone-info',
  CHECK: 'tone-neutral',
  PLUGIN: 'tone-lock',
};

/**
 * One line describing a pipeline step on its collapsed card; `modelName` turns a model choice's
 * id into its label.
 */
export function stepSummary(
  step: Record<string, unknown>,
  modelName: (id: string) => string = (id) => id,
  inherited = 'default model',
): string {
  if (step.type === 'check') {
    const values = text(step.values).trim();
    const reference = text(step.reference).trim();
    return values && reference ? `${values} vs ${reference}` : 'not set up yet';
  }
  if (step.type === 'plugin') {
    const sections = list(step.sections).map(String);
    const fills =
      typeof step.table === 'string'
        ? `Table ${step.table}`
        : plural(list(step.fields).length, 'field');
    return [text(step.uses), fills, ...(sections.length ? [`reads ${sections.join(', ')}`] : [])]
      .filter(Boolean)
      .join(' · ');
  }
  if (step.type !== 'extract') return '';
  const named = text(step.model);
  const model = named && named !== 'default' ? modelName(named) : inherited;
  if (typeof step.table === 'string') {
    const chunk = typeof step.chunkPages === 'number' ? [`${step.chunkPages} pages per call`] : [];
    return [`Table ${step.table}`, ...chunk, model].join(' · ');
  }
  const sections = list(step.sections).map(String);
  return [
    plural(list(step.fields).length, 'field'),
    ...(sections.length ? [`reads ${sections.join(', ')}`] : []),
    model,
  ].join(' · ');
}

/** The newest test runs of a document type (regression runs belong to the Quality tab). */
export function recentTestRuns(
  jobs: readonly JobSummary[],
  templateId: string,
  n = 5,
): JobSummary[] {
  return jobs
    .filter((j) => j.test && j.specId === templateId && !j.referenceId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, n);
}

/** The Pipeline list's line under a step's id: "Fills 5 · reads header, supplier". */
export function stepListSummary(step: Record<string, unknown>): string {
  if (step.type === 'check') {
    const values = text(step.values).trim();
    const reference = text(step.reference).trim();
    return values && reference ? `Checks ${values} against ${reference}` : 'Check not set up yet';
  }
  const fills = typeof step.table === 'string' ? 1 : list(step.fields).length;
  const sections = list(step.sections).map(String);
  if (step.type === 'plugin') {
    const reads = sections.length ? sections.join(', ') : 'earlier values';
    return `Runs ${text(step.uses)} · fills ${fills} · reads ${reads}`;
  }
  return `Fills ${fills} · reads ${sections.length ? sections.join(', ') : 'no sections'}`;
}

/** The unsaved bar's headline, from `describeDefinitionChange(saved, current).subjects`. */
export function unsavedText(subjects: readonly string[]): string {
  if (subjects.length === 0) return 'Unsaved changes';
  if (subjects.length === 1) return `Unsaved change to ${subjects[0]}`;
  return `Unsaved changes to ${subjects[0]} and ${subjects.length - 1} more`;
}

/** A change log entry's tag: BY HAND, OUTPUTS PROPOSAL, RESTORED, STARTED, IMPORTED. */
export function changeTag(c: Pick<TemplateChange, 'source' | 'stage'>): string {
  switch (c.source) {
    case 'hand':
      return 'BY HAND';
    case 'proposal':
      return `${(c.stage ?? 'stage').toUpperCase()} PROPOSAL`;
    case 'restore':
      return 'RESTORED';
    case 'started':
      return 'STARTED';
    case 'import':
      return 'IMPORTED';
  }
}

/** Why *Test run* is disabled (its title); null when it can run. `null` samples: loading. */
export function tryOnBlockedReason(
  dirty: boolean,
  readyDevSamples: number | null,
  issues = 0,
): string | null {
  if (readyDevSamples === null) return 'Loading the dev samples…';
  if (dirty) return 'Save the draft first: a test run uses the saved draft';
  if (issues > 0) return `${publishBlocker(false, issues)} first`;
  if (readyDevSamples === 0)
    return 'No prepared dev samples: add or prepare some on the Samples tab';
  return null;
}

/** "12 Oct 08:40" (local time), as the change log shows it. */
export function changeAtText(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export type SectionLike = { id: string; repeat?: boolean; key?: string; keyFrom?: string };

/** A step and repeating sections (spec 2026-10-16): the form's note, the sections a field step
 * cannot read (id -> reason), and why the Key column select is off (null: it is on). */
export function repeatNote(
  step: { sections?: unknown; table?: unknown; fields?: unknown },
  sections: readonly SectionLike[],
): { note: string | null; disabled: Record<string, string>; keyColumnReason: string | null } {
  const reads = Array.isArray(step.sections) ? (step.sections as unknown[]) : [];
  const repeating = sections.filter((s) => s.repeat);
  const read = repeating.find((s) => reads.includes(s.id));
  const isTable = typeof step.table === 'string';
  const disabled: Record<string, string> = isTable
    ? {}
    : Object.fromEntries(
        repeating.map((s) => [s.id, "a field step can't read a repeating section"]),
      );
  return {
    note: isTable && read ? `Runs once per occurrence of ${read.id}` : null,
    disabled,
    keyColumnReason: !read
      ? 'reads no repeating section'
      : !read.key && !read.keyFrom
        ? `${read.id} has no key`
        : null,
  };
}
