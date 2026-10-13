import { describe, expect, it } from 'vitest';
import {
  correctionKey,
  correctionOutput,
  correctionsFromEdits,
  outputProvenance,
  referenceCorrections,
  type Correction,
  type ReviewEdit,
} from '../src/index.js';

let seq = 0;
const edit = (o: Partial<ReviewEdit>): ReviewEdit => ({
  id: ++seq,
  at: '2026-10-13T09:00:00.000Z',
  field: null,
  table: null,
  row: null,
  column: null,
  oldValue: null,
  newValue: null,
  editor: null,
  reason: null,
  ...o,
});
const cell = (row: number, column: string, oldValue: unknown, newValue: unknown) =>
  edit({ table: 'line_items', row, column, oldValue, newValue });

describe('correctionKey / correctionOutput', () => {
  it.each<[string, Partial<ReviewEdit>, string, string]>([
    ['a field', { field: 'total' }, 'total', 'total'],
    [
      'a table cell',
      { table: 'line_items', row: 3, column: 'amount' },
      'line_items[3].amount',
      'line_items',
    ],
  ])('%s', (_name, e, key, output) => {
    expect(correctionKey(edit(e))).toBe(key);
    expect(correctionOutput(key)).toBe(output);
  });
});

describe('correctionsFromEdits', () => {
  it.each<[string, ReviewEdit[], Correction[]]>([
    ['no edits', [], []],
    [
      'a changed value is corrected',
      [edit({ field: 'total', oldValue: '3,912.00', newValue: '4,694.40' })],
      [{ key: 'total', kind: 'corrected', proposed: '3,912.00' }],
    ],
    [
      'a value the model left empty is entered',
      [edit({ field: 'due_date', oldValue: null, newValue: '2026-09-11' })],
      [{ key: 'due_date', kind: 'entered', proposed: null }],
    ],
    [
      'a blank string or empty list counts as empty',
      [
        edit({ field: 'po_number', oldValue: '  ', newValue: 'PO-1' }),
        edit({ field: 'tags', oldValue: [], newValue: ['x'] }),
      ],
      [
        { key: 'po_number', kind: 'entered', proposed: '  ' },
        { key: 'tags', kind: 'entered', proposed: [] },
      ],
    ],
    [
      'several edits of one key: first old value, last new value',
      [
        edit({ field: 'total', oldValue: '10', newValue: '11' }),
        edit({ field: 'total', oldValue: '11', newValue: '12' }),
      ],
      [{ key: 'total', kind: 'corrected', proposed: '10' }],
    ],
    [
      'edited back to what the model proposed: no correction',
      [
        edit({ field: 'vat', oldValue: '782.40', newValue: '0' }),
        edit({ field: 'vat', oldValue: '0', newValue: '782.40' }),
      ],
      [],
    ],
    ['empty to empty: no correction', [edit({ field: 'notes', oldValue: null, newValue: '' })], []],
    [
      'clearing a proposed value is a correction',
      [edit({ field: 'vat', oldValue: '1.00', newValue: null })],
      [{ key: 'vat', kind: 'corrected', proposed: '1.00' }],
    ],
    [
      'table cells are keyed per row and column',
      [cell(2, 'qty', '1', '2'), cell(3, 'qty', null, '5')],
      [
        { key: 'line_items[2].qty', kind: 'corrected', proposed: '1' },
        { key: 'line_items[3].qty', kind: 'entered', proposed: null },
      ],
    ],
    [
      'object values compare by content, not key order',
      [edit({ field: 'party', oldValue: { a: 1, b: 2 }, newValue: { b: 2, a: 1 } })],
      [],
    ],
  ])('%s', (_name, edits, expected) => {
    expect(correctionsFromEdits(edits)).toEqual(expected);
  });

  it('orders by edit id, whatever order the edits come in', () => {
    const first = edit({ field: 'total', oldValue: '1', newValue: '2' });
    const second = edit({ field: 'total', oldValue: '2', newValue: '1' });
    expect(correctionsFromEdits([second, first])).toEqual([]);
  });
});

describe('referenceCorrections', () => {
  const saved = '2026-10-13T10:00:00.000Z';
  const edits = [edit({ field: 'total', oldValue: '1', newValue: '2', editor: 'kim' })];
  const review = {
    status: 'succeeded' as const,
    reviewer: 'ken',
    reviewedAt: '2026-10-13T09:59:00.000Z',
    edits,
  };
  const total = [{ key: 'total', kind: 'corrected' as const, proposed: '1' }];
  const unknown = { corrections: null, verifiedBy: null };

  it.each<
    [string, Parameters<typeof referenceCorrections>[0], ReturnType<typeof referenceCorrections>]
  >([
    ['reviewed before the save', review, { corrections: total, verifiedBy: 'ken' }],
    [
      'reviewed at the save',
      { ...review, reviewedAt: saved },
      { corrections: total, verifiedBy: 'ken' },
    ],
    [
      'no reviewer: the last editor verified it',
      { ...review, reviewer: null },
      { corrections: total, verifiedBy: 'kim' },
    ],
    ['no source job', null, unknown],
    [
      're-run since (review cleared)',
      { ...review, status: 'queued', reviewedAt: null, edits: [] },
      unknown,
    ],
    [
      'reviewed again after the save',
      { ...review, reviewedAt: '2026-10-13T10:00:00.001Z' },
      unknown,
    ],
    ['not approved', { ...review, status: 'awaiting_review' }, unknown],
  ])('%s', (_name, input, expected) => {
    expect(referenceCorrections(input, saved)).toEqual(expected);
  });
});

describe('outputProvenance', () => {
  it.each<[string, Correction[], string]>([
    ['nothing changed', [], 'model'],
    ['entered only', [{ key: 'due_date', kind: 'entered', proposed: null }], 'entered'],
    [
      'any correction wins',
      [
        { key: 'line_items[1].qty', kind: 'entered', proposed: null },
        { key: 'line_items[2].qty', kind: 'corrected', proposed: '1' },
      ],
      'corrected',
    ],
  ])('%s', (_name, corrections, expected) => {
    expect(outputProvenance(corrections)).toBe(expected);
  });
});
