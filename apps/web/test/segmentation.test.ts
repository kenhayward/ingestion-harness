import { describe, expect, it } from 'vitest';
import type { SectionCell, SegmentedSample } from '@ih/shared';
import { cellFlag, sectionHits } from '../src/workbench/segmentation.js';

const cell = (o: Partial<SectionCell> = {}): SectionCell => ({
  id: 'a',
  found: true,
  page: 1,
  line: 'A',
  chars: 100,
  ...o,
});
const sample = (sections: SectionCell[], o: Partial<SegmentedSample> = {}): SegmentedSample => ({
  sampleId: 's',
  firstPage: 1,
  pageCount: 1,
  error: null,
  missingRequired: [],
  sections,
  ...o,
});

describe('cellFlag', () => {
  it.each([
    [
      'required and not found',
      cell({ found: false, chars: 0, page: null, line: null }),
      true,
      'missing-required',
    ],
    [
      'optional and not found',
      cell({ found: false, chars: 0, page: null, line: null }),
      false,
      'missing',
    ],
    ['found but empty', cell({ chars: 0 }), true, 'empty'],
    ['normal size', cell({ chars: 100 }), true, null],
  ])('%s', (_name, c, required, flag) => {
    const s = sample([c, cell({ id: 'b', chars: 100 })]);
    expect(cellFlag(c, required, s, 2)).toBe(flag);
  });

  it('flags a section holding most of the document when there are several sections', () => {
    const big = cell({ id: 'a', chars: 700 });
    const s = sample([big, cell({ id: 'b', chars: 300 })]);
    expect(cellFlag(big, true, s, 2)).toBe('large');
    expect(cellFlag(big, true, sample([big]), 1)).toBeNull(); // a single catch-all is fine
  });
});

describe('sectionHits', () => {
  it('counts samples where the anchor matched, ignoring unprepared samples', () => {
    const result = {
      anchorErrors: {},
      suggestions: [],
      samples: [
        sample([cell({ id: 'a' })], { sampleId: '1' }),
        sample([cell({ id: 'a', found: false, chars: 0, page: null, line: null })], {
          sampleId: '2',
        }),
        sample([], { sampleId: '3', error: 'not prepared' }),
      ],
    };
    expect(sectionHits(result, 'a')).toEqual({ hits: 1, of: 2 });
  });
});
