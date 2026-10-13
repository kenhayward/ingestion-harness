import { describe, expect, it } from 'vitest';
import { changedRows, outputRows, outputSummary } from '../src/workbench/outputRows.js';

const LIVE = {
  outputs: {
    fields: [
      { id: 'supplier_name', name: 'Supplier', type: 'text' },
      { id: 'currency', type: 'enum', enum: ['GBP', 'EUR'] },
      { id: 'supplier_address', type: 'text' },
    ],
    tables: [
      {
        id: 'line_items',
        name: 'Line items',
        columns: [{ id: 'description' }, { id: 'amount', type: 'decimal' }],
      },
    ],
  },
};
const DRAFT = {
  outputs: {
    fields: [
      { id: 'supplier_name', name: 'Supplier', type: 'text' },
      { id: 'due_date', name: 'Due date', type: 'date', description: 'Payment due date' },
      { id: 'currency', type: 'enum', enum: ['GBP', 'EUR', 'USD'] },
    ],
    tables: [
      {
        id: 'line_items',
        name: 'Line items',
        columns: [
          { id: 'description' },
          { id: 'amount', type: 'decimal', description: 'Line total as printed' },
        ],
      },
    ],
  },
};
const brief = (rows: ReturnType<typeof outputRows>) => rows.map((r) => [r.kind, r.id, r.vsLive]);

describe('outputRows', () => {
  it('lists the draft beside the live version, removed outputs included', () => {
    const rows = outputRows(DRAFT, LIVE);
    expect(brief(rows)).toEqual([
      ['field', 'supplier_name', null],
      ['field', 'due_date', 'added'],
      ['field', 'currency', 'changed'],
      ['field', 'supplier_address', 'removed'],
      ['table', 'line_items', null],
      ['column', 'description', null],
      ['column', 'amount', 'changed'],
    ]);
    expect(rows[1]).toEqual({
      kind: 'field',
      id: 'due_date',
      table: null,
      name: 'Due date',
      type: 'date',
      values: '—',
      description: 'Payment due date',
      vsLive: 'added',
    });
    expect(rows[2]).toMatchObject({ name: '—', values: 'GBP, EUR, USD' });
    expect(rows[4]).toMatchObject({ type: 'table', values: '2 columns', name: 'Line items' });
    expect(rows[5]).toMatchObject({ table: 'line_items', type: 'text' });
  });

  it('summarises counts and changes', () => {
    expect(outputSummary(outputRows(DRAFT, LIVE))).toEqual({
      fields: 3,
      tables: 1,
      columns: 2,
      added: 1,
      changed: 2,
      removed: 1,
    });
  });

  it('keeps only changes, with their table for context', () => {
    expect(changedRows(outputRows(DRAFT, LIVE)).map((r) => r.id)).toEqual([
      'due_date',
      'currency',
      'supplier_address',
      'line_items',
      'amount',
    ]);
  });

  it('tags the columns of an added table without counting them twice', () => {
    const draft = {
      outputs: {
        ...DRAFT.outputs,
        tables: [...DRAFT.outputs.tables, { id: 'taxes', columns: [{ id: 'rate' }] }],
      },
    };
    const rows = outputRows(draft, LIVE);
    expect(brief(rows).slice(-2)).toEqual([
      ['table', 'taxes', 'added'],
      ['column', 'rate', 'added'],
    ]);
    expect(outputSummary(rows)).toMatchObject({ tables: 2, columns: 3, added: 2 });
  });

  it('has no tags with nothing published', () => {
    const rows = outputRows(DRAFT, null);
    expect(rows.every((r) => r.vsLive === null)).toBe(true);
    expect(outputSummary(rows)).toMatchObject({ added: 0, changed: 0, removed: 0 });
  });

  it('reads a draft with no outputs', () => {
    expect(outputRows({}, null)).toEqual([]);
  });

  it.each([
    [1, '1 column'],
    [2, '2 columns'],
  ])('pluralises the column count of a table (%i)', (n, values) => {
    const columns = Array.from({ length: n }, (_, i) => ({ id: `c${i}` }));
    const rows = outputRows({ outputs: { tables: [{ id: 't', columns }] } }, null);
    expect(rows[0]).toMatchObject({ kind: 'table', values });
  });

  it('does not mark a reordered enum as changed', () => {
    const live = { outputs: { fields: [{ id: 'c', type: 'enum', enum: ['GBP', 'EUR'] }] } };
    const draft = { outputs: { fields: [{ id: 'c', type: 'enum', enum: ['EUR', 'GBP'] }] } };
    expect(outputRows(draft, live)[0]?.vsLive).toBeNull();
  });
});
