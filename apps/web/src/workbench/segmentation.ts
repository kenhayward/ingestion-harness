import type {
  AnchorSuggestion,
  SectionCell,
  SegmentationResult,
  SegmentedSample,
} from '@ih/shared';

/** A section holding more than this share of a sample's text probably swallowed its neighbours. */
export const LARGE_SHARE = 0.6;

export type CellFlag = 'missing-required' | 'missing' | 'empty' | 'large' | null;

/** What deserves attention in one sample × section cell of the preview grid. */
export function cellFlag(
  cell: SectionCell,
  required: boolean,
  sample: SegmentedSample,
  sectionCount: number,
): CellFlag {
  if (!cell.found) return required ? 'missing-required' : 'missing';
  if (cell.chars === 0) return 'empty';
  const total = sample.sections.reduce((sum, c) => sum + c.chars, 0);
  if (sectionCount > 1 && total > 0 && cell.chars / total > LARGE_SHARE) return 'large';
  return null;
}

/** In how many segmented samples (no error) the section's anchor matched. */
export function sectionHits(
  result: SegmentationResult,
  sectionId: string,
): { hits: number; of: number } {
  const segmented = result.samples.filter((s) => s.error === null);
  const hits = segmented.filter((s) => s.sections.some((c) => c.id === sectionId && c.found));
  return { hits: hits.length, of: segmented.length };
}

/** The selected sample × section of the Sections tab. */
export interface Selection {
  sampleId: string;
  sectionId: string;
}

/** The share of the sample's sectioned text a cell holds (0..1). */
export function cellShare(cell: SectionCell, sample: SegmentedSample): number {
  const total = sample.sections.reduce((sum, c) => sum + c.chars, 0);
  return total > 0 ? cell.chars / total : 0;
}

/** An anchor row's "where it lands" line for the selected sample (handoff §5). */
export function landingText(
  filename: string,
  cell: SectionCell | undefined,
  required: boolean,
): string {
  if (!cell) return `In ${filename}: not in the preview yet`;
  if (!cell.found) return `In ${filename}: no match — ${required ? 'required' : 'optional'}`;
  return `In ${filename}: p.${cell.page} · matches "${cell.line ?? ''}"`;
}

/** The hits badge: ok when every sample matched, danger when a required section misses one. */
export function hitTone(hits: number, of: number, required: boolean): 'ok' | 'danger' | 'neutral' {
  if (of === 0) return 'neutral';
  if (hits === of) return 'ok';
  return required ? 'danger' : 'neutral';
}

/** What to show first: the first required miss, else the first segmented sample's first section. */
export function initialSelection(result: SegmentationResult): Selection | null {
  const missing = result.samples.find((s) => s.error === null && s.missingRequired.length > 0);
  if (missing) return { sampleId: missing.sampleId, sectionId: missing.missingRequired[0]! };
  const first = result.samples.find((s) => s.error === null && s.sections.length > 0);
  return first ? { sampleId: first.sampleId, sectionId: first.sections[0]!.id } : null;
}

/** The worker's one-click fix for a sample × section (handoff SC2), if any. */
export function suggestionFor(
  result: SegmentationResult,
  sampleId: string,
  sectionId: string,
): AnchorSuggestion | null {
  return result.suggestions.find((s) => s.sampleId === sampleId && s.section === sectionId) ?? null;
}

/** Move one item; out of range: unchanged. */
export function move<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  if (to < 0 || to >= items.length || from === to) return next;
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item!);
  return next;
}

/** A repeating section's cell: "×3 · 4586783 · 4586784 · no key" (null: not repeating). */
export function occurrenceSummary(cell: SectionCell): string | null {
  const found = cell.occurrences ?? [];
  if (found.length === 0) return null;
  return [`×${found.length}`, ...found.map((o) => o.key ?? 'no key')].join(' · ');
}

/** A plain section whose anchor matches more than once: only the first match is used. */
export function repeatHint(cell: SectionCell): string | null {
  const matches = cell.matches ?? 0;
  return matches > 1 ? `matches ${matches}×, only the first is used` : null;
}

/** The sections a repeating section may take its key from: repeating, with a key, no keyFrom. */
export function keyFromOptions(
  sections: readonly { id: string; repeat?: boolean; key?: string; keyFrom?: string }[],
  self: string,
): string[] {
  return sections
    .filter((s) => s.id && s.id !== self && s.repeat && s.key && !s.keyFrom)
    .map((s) => s.id);
}

/** The grid's note for headings no anchor caught: the first 10 keys and how many more (null: none). */
export function missedKeysText(row: SegmentedSample): string | null {
  const missed = row.missedKeys ?? [];
  if (missed.length === 0) return null;
  const total = row.missedKeysTotal ?? missed.length;
  const keys = missed.slice(0, 10).map((m) => m.key);
  const more = total - keys.length;
  return `Missed headings: ${keys.join(', ')}${more > 0 ? ` (+${more})` : ''}`;
}

/** The grid's note for keys an anchor caught more than once: the first 10 and how many more. */
export function repeatedKeysText(row: SegmentedSample): string | null {
  const repeated = row.repeatedKeys ?? [];
  if (repeated.length === 0) return null;
  const total = row.repeatedKeysTotal ?? repeated.length;
  const keys = repeated.slice(0, 10).map((r) => r.key);
  const more = total - keys.length;
  return `Keys caught more than once: ${keys.join(', ')}${more > 0 ? ` (+${more})` : ''}`;
}

/** Where the first repeated key starts its occurrences (page and line, at most three), and why. */
export function repeatedKeyExample(row: SegmentedSample): string | null {
  const first = row.repeatedKeys?.[0];
  if (!first) return null;
  const cell = row.sections.find((c) => c.id === first.section);
  const quoted = first.occurrences
    .slice(0, 3)
    .map((n) => cell?.occurrences?.[n - 1])
    .filter((o) => o !== undefined)
    .map((o) => `p.${o.page} “${o.line ?? ''}”`);
  const where =
    quoted.length > 1 ? `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)}` : quoted.join('');
  return (
    `Key ${first.key} starts occurrences on ${where}: ` +
    'the anchor also catches lines that are not headings, such as contents entries.'
  );
}
