import { describe, expect, it } from 'vitest';
import {
  changeAtText,
  changeTag,
  publishBlocker,
  recentTestRuns,
  rowTableMinWidth,
  stepListSummary,
  stepSummary,
  tabCounts,
  tryOnBlockedReason,
  unsavedText,
} from '../src/templates/editor-derive.js';
import { repeatNote } from '../src/templates/editor-derive.js';
import { RETIRED_REASON } from '../src/ui/retired.js';
import { job } from './fake-api.js';

describe('publishBlocker', () => {
  it.each<[boolean, number, string | null]>([
    [true, 2, 'Save the draft before publishing'],
    [true, 0, 'Save the draft before publishing'],
    [false, 1, 'Fix 1 validation issue'],
    [false, 3, 'Fix 3 validation issues'],
    [false, 0, null],
  ])('dirty %s, %i issues', (dirty, issues, reason) =>
    expect(publishBlocker(dirty, issues)).toBe(reason),
  );
});

describe('tabCounts', () => {
  it('counts what is there and 0 for what is missing', () => {
    expect(
      tabCounts({
        document: { sections: [{}, {}] },
        outputs: { fields: [{}], tables: 'oops' },
        pipeline: [{}, {}, {}],
      }),
    ).toEqual({ sections: 2, fields: 1, tables: 0, steps: 3 });
    expect(tabCounts({})).toEqual({ sections: 0, fields: 0, tables: 0, steps: 0 });
  });
});

describe('stepSummary', () => {
  it.each<[Record<string, unknown>, string]>([
    [
      { type: 'extract', fields: ['a', 'b'], sections: ['header', 'supplier'] },
      '2 fields · reads header, supplier · default model',
    ],
    [
      { type: 'extract', fields: ['a'], sections: ['header'], model: 'local/x' },
      '1 field · reads header · local/x',
    ],
    [{ type: 'extract', fields: [], sections: [] }, '0 fields · default model'],
    [
      { type: 'extract', table: 'lines', chunkPages: 2, model: 'm', sections: ['all'] },
      'Table lines · 2 pages per call · m',
    ],
    [{ type: 'extract', table: 'lines', fields: [] }, 'Table lines · default model'],
    [
      { type: 'check', values: 'lines.batch', reference: 'header.batches' },
      'lines.batch vs header.batches',
    ],
    [{ type: 'check', values: '', reference: '' }, 'not set up yet'],
    [{ type: 'other' }, ''],
  ])('%j', (step, text) => expect(stepSummary(step)).toBe(text));
});

describe('recentTestRuns', () => {
  const at = (minute: number) => `2026-10-12T10:${String(minute).padStart(2, '0')}:00Z`;
  it('lists the newest test runs of this type, without regression runs', () => {
    const jobs = [
      job({ id: 'a', specId: 'letter', test: true, createdAt: at(1) }),
      job({ id: 'b', specId: 'letter', test: true, createdAt: at(3) }),
      job({ id: 'c', specId: 'other', test: true, createdAt: at(4) }),
      job({ id: 'd', specId: 'letter', test: false, createdAt: at(5) }),
      job({ id: 'e', specId: 'letter', test: true, referenceId: 'r', createdAt: at(6) }),
    ];
    expect(recentTestRuns(jobs, 'letter').map((j) => j.id)).toEqual(['b', 'a']);
  });

  it('keeps at most n', () => {
    const jobs = Array.from({ length: 8 }, (_, i) =>
      job({ id: `j${i}`, specId: 'letter', test: true, createdAt: at(i) }),
    );
    expect(recentTestRuns(jobs, 'letter').map((j) => j.id)).toEqual(['j7', 'j6', 'j5', 'j4', 'j3']);
  });
});

describe('stepListSummary', () => {
  it.each<[Record<string, unknown>, string]>([
    [
      { type: 'extract', id: 'h', fields: ['a', 'b'], sections: ['header', 'supplier'] },
      'Fills 2 · reads header, supplier',
    ],
    [
      { type: 'extract', id: 'l', table: 'line_items', sections: ['line_items'] },
      'Fills 1 · reads line_items',
    ],
    [{ type: 'extract', id: 'x', fields: [], sections: [] }, 'Fills 0 · reads no sections'],
    [
      { type: 'check', id: 'c', values: 'total', reference: 'subtotal' },
      'Checks total against subtotal',
    ],
    [{ type: 'check', id: 'c' }, 'Check not set up yet'],
  ])('%j', (step, text) => expect(stepListSummary(step)).toBe(text));
});

describe('unsavedText', () => {
  it.each<[string[], string]>([
    [['step totals'], 'Unsaved change to step totals'],
    [['step totals', 'field a', 'the name'], 'Unsaved changes to step totals and 2 more'],
    [[], 'Unsaved changes'],
  ])('%j', (subjects, text) => expect(unsavedText(subjects)).toBe(text));
});

describe('changeTag', () => {
  it.each<[Parameters<typeof changeTag>[0], string]>([
    [{ source: 'hand', stage: null }, 'BY HAND'],
    [{ source: 'proposal', stage: 'outputs' }, 'OUTPUTS PROPOSAL'],
    [{ source: 'proposal', stage: 'revise' }, 'REVISE PROPOSAL'],
    [{ source: 'restore', stage: null }, 'RESTORED'],
    [{ source: 'started', stage: null }, 'STARTED'],
    [{ source: 'import', stage: null }, 'IMPORTED'],
  ])('%j', (c, tag) => expect(changeTag(c)).toBe(tag));
});

describe('tryOnBlockedReason', () => {
  it.each<[boolean, number | null, number, string | null]>([
    [false, null, 0, 'Loading the dev samples…'],
    [true, 3, 0, 'Save the draft first: a test run uses the saved draft'],
    [false, 0, 0, 'No prepared dev samples: add or prepare some on the Samples tab'],
    [false, 2, 0, null],
    [false, 2, 1, 'Fix 1 validation issue first'],
    [false, 2, 3, 'Fix 3 validation issues first'],
  ])('dirty %s, %s ready, %s issues', (dirty, n, issues, reason) =>
    expect(tryOnBlockedReason(dirty, n, issues)).toBe(reason),
  );
});

describe('changeAtText', () => {
  it('shows the day, month and time', () => {
    expect(changeAtText('2026-10-12T08:40:00.000Z')).toMatch(/^\d{1,2} Oct,? \d{2}:\d{2}$/);
  });
});

describe('rowTableMinWidth', () => {
  it.each([
    [[['ID', '14rem']], 'calc(2.5rem + 14rem + 9rem)'],
    [
      [
        ['ID', '14rem'],
        ['Description', undefined],
      ],
      'calc(2.5rem + 14rem + 10rem + 9rem)',
    ],
    [[], 'calc(2.5rem + 9rem)'],
  ] as [[string, string | undefined][], string][])(
    'adds the index, every column (10rem when flexible) and the actions',
    (columns, expected) => {
      expect(rowTableMinWidth(columns)).toBe(expected);
    },
  );
});

describe('publishBlocker for a retired type', () => {
  it('names the retirement before any other reason', () => {
    expect(publishBlocker(true, 3, true)).toBe(RETIRED_REASON);
    expect(publishBlocker(false, 0, false)).toBeNull();
  });
});

const REPEAT_SECTIONS = [
  { id: 'front', anchor: '\\A' },
  { id: 'batch', anchor: '^\\d+\\. STUDY', repeat: true, key: 'BATCH (.+)' },
  { id: 'appearance', anchor: '^Table', repeat: true, key: 'Batch (.+)', keyFrom: 'batch' },
  { id: 'plain_repeat', anchor: '^Annex', repeat: true },
];

describe('repeatNote', () => {
  const fieldReason = "a field step can't read a repeating section";
  it.each([
    [
      'a table step on a repeating section with a key',
      { table: 'appearance_results', sections: ['appearance'] },
      { note: 'Runs once per occurrence of appearance', disabled: {}, keyColumnReason: null },
    ],
    [
      'a field step',
      { fields: ['study'], sections: ['front'] },
      {
        note: null,
        disabled: { batch: fieldReason, appearance: fieldReason, plain_repeat: fieldReason },
        keyColumnReason: 'reads no repeating section',
      },
    ],
    [
      'a repeating section with neither key nor keyFrom',
      { table: 't', sections: ['plain_repeat'] },
      {
        note: 'Runs once per occurrence of plain_repeat',
        disabled: {},
        keyColumnReason: 'plain_repeat has no key',
      },
    ],
    [
      'a table step on plain sections',
      { table: 't', sections: ['front'] },
      { note: null, disabled: {}, keyColumnReason: 'reads no repeating section' },
    ],
  ])('%s', (_, step, expected) => expect(repeatNote(step, REPEAT_SECTIONS)).toEqual(expected));
});
