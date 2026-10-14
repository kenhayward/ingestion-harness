import {
  BRIEF_SECTIONS,
  BriefBodySchema,
  briefDiff,
  type BriefBody,
  type BriefSection,
  type BriefVersionView,
  type ExportView,
  type SurveyBody,
} from '@ih/shared';
import { relativeTime } from '../jobs/derive.js';
import { parseCsv } from '../results/csv.js';
import { keepDraft, loadKept } from '../ui/keptDraft.js';
import { formatBytes, plural } from './samples.js';

export type TextSection = Exclude<BriefSection, 'answers'>;

export const BRIEF_LABEL: Record<BriefSection, string> = {
  purpose: 'Purpose',
  outputs: 'Outputs wanted',
  glossary: 'Glossary',
  exampleOutput: 'Example output',
  variants: 'Variants',
  rules: 'Rules',
  answers: 'Survey answers',
};

export const BRIEF_HINT: Record<TextSection, string> = {
  purpose: 'What the outputs are for and who consumes them.',
  outputs: 'Must-have and nice-to-have values, in plain words.',
  glossary: 'Domain terms and abbreviations.',
  exampleOutput: 'A mock CSV or a few example rows — shown as a table below.',
  variants: 'Known issuers, layouts, languages, blank vs executed copies.',
  rules: 'For example: placeholders are null; use the executed copy; dates are DMY.',
};

export const TEXT_SECTIONS = BRIEF_SECTIONS.filter((s): s is TextSection => s !== 'answers');

/** "Saved as v3 · 2 days ago · 1 field changed since" (handoff §2). */
export function briefStatus(version: number, createdAt: string, changed: number, now: number) {
  const age = relativeTime(createdAt, now);
  const parts = [`Saved as v${version}`, age.charAt(0).toLowerCase() + age.slice(1)];
  if (changed > 0) parts.push(`${changed} ${changed === 1 ? 'field' : 'fields'} changed since`);
  return parts.join(' · ');
}

/** What a version changed, for the Versions list. */
export function versionChangeText(v: BriefVersionView): string {
  if (v.version === 1) return 'First brief';
  if (v.changedSections.length === 0) return 'No changes';
  const [first, ...rest] = v.changedSections.map((s) => BRIEF_LABEL[s]);
  return [first!, ...rest.map((l) => l.toLowerCase())].join(', ');
}

/** The example output as a table: a header and at least one row of two or more columns. */
export function csvPreview(text: string): { header: string[]; rows: string[][] } | null {
  const lines = parseCsv(text.trim()).filter((r) => r.some((c) => c.trim() !== ''));
  if (lines.length < 2 || lines[0]!.length < 2) return null;
  return { header: lines[0]!, rows: lines.slice(1) };
}

/** Survey questions the brief has no answer to yet. */
export function openQuestions(survey: SurveyBody, answers: BriefBody['answers']): number {
  return survey.questions.filter(
    (q) => !answers.some((a) => a.question === q.question && a.answer.trim() !== ''),
  ).length;
}

/**
 * What *Compare* on a version compares: an older version with the current one; the current
 * one with its predecessor; null with a single version. `versions` is newest first.
 */
export function compareOf(
  version: number,
  versions: readonly BriefVersionView[],
): [number, number] | null {
  const current = versions[0]?.version;
  if (current === undefined) return null;
  if (version !== current) return [version, current];
  const previous = versions[1]?.version;
  return previous === undefined ? null : [previous, current];
}

/** The drafting bundle's status line (handoff §2, BR3). */
export function exportStatusText(e: ExportView): string {
  if (e.status === 'succeeded') {
    const parts = [
      'Export ready',
      e.briefVersion === null ? 'no brief' : `brief v${e.briefVersion}`,
    ];
    if (e.devSamples !== null) parts.push(plural(e.devSamples, 'dev sample'));
    if (e.bytes !== null) parts.push(formatBytes(e.bytes));
    return parts.join(' · ');
  }
  if (e.status === 'queued' || e.status === 'running') return `Export ${e.status}…`;
  if (e.status === 'cancelled') return 'Export cancelled';
  return `Export failed${e.error ? `: ${e.error}` : ''}`;
}

/**
 * Unsaved Brief edits, kept per project in this browser (ui/keptDraft.ts) so leaving the tab
 * loses nothing. Only the sections that were edited are kept, with the version they were made
 * on: restored, they go on top of whatever is saved by then, so a newer version's other sections
 * are never undone.
 */
export type BriefDraft = { base: number | null; changes: Partial<BriefBody> };

const draftKey = (projectId: string) => `ih.briefDraft.${projectId}`;
const briefChanges = (value: unknown): Partial<BriefBody> | null => {
  const changes = BriefBodySchema.partial().safeParse(value);
  return changes.success ? changes.data : null;
};

export function loadBriefDraft(projectId: string): BriefDraft | null {
  const kept = loadKept(draftKey(projectId), briefChanges);
  if (!kept || typeof kept.base === 'string') return null;
  return { base: kept.base, changes: kept.value };
}

/** Remembers `body`'s edits against `saved`, or forgets them when there are none. */
export function keepBriefDraft(
  projectId: string,
  base: number | null,
  saved: BriefBody,
  body: BriefBody,
): void {
  const changed = briefDiff(saved, body).map((d) => d.section);
  keepDraft(
    draftKey(projectId),
    changed.length
      ? { base, value: Object.fromEntries(changed.map((s) => [s, body[s]])) as Partial<BriefBody> }
      : null,
  );
}

/** What the Brief tab says above edits it put back (`from`: their version; `now`: the saved one). */
export function restoredNote(from: number | null, now: number | null): string {
  if (from === now) {
    return 'Restored your unsaved changes from your last visit: save them as a new version, or discard them.';
  }
  const made = from === null ? 'made before the first version' : `made on v${from}`;
  return `Restored your unsaved changes, ${made}. The brief is now v${now}: check them before saving.`;
}
