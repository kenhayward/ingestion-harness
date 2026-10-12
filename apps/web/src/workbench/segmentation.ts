import type { SectionCell, SegmentationResult, SegmentedSample } from '@ih/shared';

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
