import { describe, expect, it } from 'vitest';
import type { SectionCell, SegmentationResult, SegmentedSample } from '@ih/shared';
import {
  keyFromOptions,
  occurrenceSummary,
  repeatHint,
  cellFlag,
  cellShare,
  hitTone,
  initialSelection,
  landingText,
  missedKeysText,
  move,
  sectionHits,
  suggestionFor,
} from '../src/workbench/segmentation.js';

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

describe('anchor helpers', () => {
  const result: SegmentationResult = {
    anchorErrors: {},
    samples: [
      sample([cell({ id: 'header' }), cell({ id: 'supplier' })], { sampleId: 'acme' }),
      sample(
        [
          cell({ id: 'header' }),
          cell({ id: 'supplier', found: false, chars: 0, page: null, line: null }),
        ],
        { sampleId: 'globex', missingRequired: ['supplier'] },
      ),
    ],
    suggestions: [
      { section: 'supplier', sampleId: 'globex', anchor: '^(From|Vendor)\\b', reason: 'r' },
    ],
  };

  it('selects the first required miss, else the first cell', () => {
    expect(initialSelection(result)).toEqual({ sampleId: 'globex', sectionId: 'supplier' });
    expect(initialSelection({ ...result, samples: [result.samples[0]!] })).toEqual({
      sampleId: 'acme',
      sectionId: 'header',
    });
    expect(initialSelection({ ...result, samples: [] })).toBeNull();
  });

  it('finds the suggestion for a sample and section', () => {
    expect(suggestionFor(result, 'globex', 'supplier')?.anchor).toBe('^(From|Vendor)\\b');
    expect(suggestionFor(result, 'acme', 'supplier')).toBeNull();
  });

  it.each<[string, Parameters<typeof landingText>[1], boolean, string]>([
    [
      'found',
      cell({ id: 'h', page: 2, line: 'TAX INVOICE' }),
      true,
      'In a.pdf: p.2 · matches "TAX INVOICE"',
    ],
    [
      'missing, required',
      cell({ id: 'h', found: false, page: null, line: null }),
      true,
      'In a.pdf: no match — required',
    ],
    [
      'missing, optional',
      cell({ id: 'h', found: false, page: null, line: null }),
      false,
      'In a.pdf: no match — optional',
    ],
    ['not previewed', undefined, true, 'In a.pdf: not in the preview yet'],
  ])('landingText: %s', (_name, c, required, expected) => {
    expect(landingText('a.pdf', c, required)).toBe(expected);
  });

  it.each([
    [8, 8, true, 'ok'],
    [7, 8, true, 'danger'],
    [7, 8, false, 'neutral'],
    [0, 0, true, 'neutral'],
  ] as const)('hitTone(%i, %i, %s) = %s', (hits, of, required, tone) => {
    expect(hitTone(hits, of, required)).toBe(tone);
  });

  it('measures a cell against the sample and moves rows', () => {
    const big = cell({ id: 'a', chars: 800 });
    expect(cellShare(big, sample([big, cell({ id: 'b', chars: 200 })]))).toBeCloseTo(0.8);
    expect(cellShare(big, sample([]))).toBe(0);
    expect(move(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a']);
    expect(move(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'c', 'b']);
    expect(move(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
});

describe('repeating sections', () => {
  const occurrence = (key: string | null, keySource: 'own' | 'inherited' | null = 'own') => ({
    page: 2,
    line: 'Table 1',
    chars: 10,
    key,
    keySource,
  });
  const cellWith = (extra: Partial<SectionCell>): SectionCell => ({
    id: 'appearance',
    found: true,
    page: 2,
    line: 'Table 1',
    chars: 30,
    ...extra,
  });

  it.each([
    ['no occurrences', cellWith({}), null],
    ['an older grid', cellWith({ occurrences: [] }), null],
    [
      'three occurrences, one without a key',
      cellWith({
        occurrences: [occurrence('4586783'), occurrence('4586784'), occurrence(null, null)],
      }),
      '×3 · 4586783 · 4586784 · no key',
    ],
  ])('occurrenceSummary: %s', (_, cell, text) => {
    expect(occurrenceSummary(cell)).toBe(text);
  });

  it.each([
    [undefined, null],
    [0, null],
    [1, null],
    [3, 'matches 3×, only the first is used'],
  ])('repeatHint(matches %s)', (matches, text) => {
    expect(repeatHint(cellWith(matches === undefined ? {} : { matches }))).toBe(text);
  });

  it('offers repeating sections with their own key, never itself or one with keyFrom', () => {
    const sections = [
      { id: 'front' },
      { id: 'batch', repeat: true, key: 'BATCH (.+)' },
      { id: 'plain_repeat', repeat: true },
      { id: 'appearance', repeat: true, key: 'Batch (.+)', keyFrom: 'batch' },
    ];
    expect(keyFromOptions(sections, 'appearance')).toEqual(['batch']);
    expect(keyFromOptions(sections, 'batch')).toEqual([]);
  });

  describe('missedKeysText', () => {
    const row = (
      missedKeys?: { sections: string[]; key: string; line: string }[],
      total?: number,
    ) =>
      ({
        sampleId: 's1',
        firstPage: 1,
        pageCount: 1,
        error: null,
        missingRequired: [],
        sections: [],
        ...(missedKeys ? { missedKeys } : {}),
        ...(total ? { missedKeysTotal: total } : {}),
      }) as SegmentedSample;
    const miss = (key: string) => ({ sections: ['t'], key, line: `Table ${key}` });
    it.each([
      [undefined, undefined, null],
      [[], undefined, null],
      [['1', '2', '3', '9'].map(miss), undefined, 'Missed headings: 1, 2, 3, 9'],
      [
        Array.from({ length: 20 }, (_, i) => miss(String(i + 1))),
        30,
        'Missed headings: 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 (+20)',
      ],
    ])('missedKeysText(%j, total %s)', (missed, total, text) => {
      expect(missedKeysText(row(missed, total))).toBe(text);
    });
  });
});
