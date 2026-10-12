import { describe, expect, it } from 'vitest';
import { compareToReference, expectedFromDocument } from '../src/regression/compare.js';
import { diffDefinitions } from '../src/regression/diff.js';

const document = {
  fields: {
    product: { value: 'Richfer capsules', evidence: 'x', page: 1 },
    executed_on: { value: '2023-02', evidence: null, page: 34 },
    compound: { value: ['Folic Acid', 'Carbonyl Iron'], evidence: null, page: 36 },
  },
  tables: {
    batches: [
      { batch: 'G17230211', size: '13.5 L' },
      { batch: 'G17230212', size: '13.5 L' },
    ],
  },
};

describe('expectedFromDocument', () => {
  it('keeps only values (no evidence/pages) as the expected result', () => {
    expect(expectedFromDocument(document)).toEqual({
      fields: {
        product: 'Richfer capsules',
        executed_on: '2023-02',
        compound: ['Folic Acid', 'Carbonyl Iron'],
      },
      tables: document.tables,
    });
  });
});

describe('compareToReference', () => {
  const expected = expectedFromDocument(document);

  it('scores a perfect run 1.0, ignoring case, spacing and list order', () => {
    const actual = {
      fields: {
        product: { value: 'RICHFER  capsules' },
        executed_on: { value: '2023-02' },
        compound: { value: ['Carbonyl Iron', 'Folic Acid'] },
      },
      tables: { batches: [...document.tables.batches].reverse() },
    };
    const result = compareToReference(expected, actual);
    expect(result.score).toBe(1);
    expect(result.fields.every((f) => f.match)).toBe(true);
    expect(result.tables[0]).toMatchObject({
      id: 'batches',
      expected: 2,
      actual: 2,
      matched: 2,
      cells: 4,
      cellsTotal: 4,
    });
  });

  it('counts table cells per column, so one wrong cell charges one column', () => {
    const [table] = compareToReference(
      {
        fields: {},
        tables: {
          items: [
            { name: 'Bolt', qty: '2' },
            { name: 'Nut', qty: '5' },
          ],
        },
      },
      {
        fields: {},
        tables: {
          items: [
            { name: 'Nut', qty: '5' },
            { name: 'Bolt', qty: '3' },
          ],
        },
      },
    ).tables;
    expect(table!.columns).toEqual({
      name: { matched: 2, total: 2 },
      qty: { matched: 1, total: 2 },
    });
  });

  it('charges every column of missing and extra rows', () => {
    const [table] = compareToReference(
      { fields: {}, tables: { items: [{ name: 'Bolt', qty: '2' }] } },
      { fields: {}, tables: { items: [{ name: 'Washer', qty: '9' }] } },
    ).tables;
    expect(table!.columns).toEqual({
      name: { matched: 0, total: 2 },
      qty: { matched: 0, total: 2 },
    });
  });

  it('counts columns whose names are Object.prototype keys', () => {
    const [table] = compareToReference(
      { fields: {}, tables: { items: [{ constructor: 'a', toString: 'b', __proto__x: 'c' }] } },
      { fields: {}, tables: { items: [{ constructor: 'a', toString: 'x', __proto__x: 'c' }] } },
    ).tables;
    expect(table!.columns).toEqual({
      constructor: { matched: 1, total: 1 },
      toString: { matched: 0, total: 1 },
      __proto__x: { matched: 1, total: 1 },
    });
  });

  it.each([
    {
      name: 'same keys',
      expected: [{ a: '1', b: '2' }],
      actual: [{ a: '1', b: '3' }],
    },
    {
      name: 'differing key sets, missing and extra rows',
      expected: [{ a: '1', b: '2' }, { a: '9', c: 'only expected' }, { z: 'never matched' }],
      actual: [
        { a: '1', d: 'only actual' },
        { a: '9', c: 'only expected' },
        { q: 'extra' },
        { r: 'extra', s: 'row' },
      ],
    },
  ])('column counts sum to the table cell counts ($name)', ({ expected, actual }) => {
    const [table] = compareToReference(
      { fields: {}, tables: { items: expected } },
      { fields: {}, tables: { items: actual } },
    ).tables;
    const columns = Object.values(table!.columns);
    expect(columns.reduce((n, c) => n + c.total, 0)).toBe(table!.cellsTotal);
    expect(columns.reduce((n, c) => n + c.matched, 0)).toBe(table!.cells);
  });

  it('aligns rows and gives partial credit per cell', () => {
    const actual = {
      fields: {
        product: { value: 'Richfer capsules' },
        executed_on: { value: '2023-01' },
        compound: { value: ['Folic Acid'] },
      },
      tables: {
        batches: [
          { batch: 'G17230211', size: '13.5 L' },
          { batch: 'G1Y230212', size: '13.5 L' },
        ],
      },
    };
    const result = compareToReference(expected, actual);
    expect(result.fields.filter((f) => !f.match).map((f) => f.id)).toEqual([
      'executed_on',
      'compound',
    ]);
    const [batches] = result.tables;
    expect(batches).toMatchObject({ matched: 1, missing: [], extra: [], cells: 3, cellsTotal: 4 });
    expect(batches!.changed).toEqual([
      {
        expected: { batch: 'G17230212', size: '13.5 L' },
        actual: { batch: 'G1Y230212', size: '13.5 L' },
        columns: ['batch'],
      },
    ]);
    // 1 of 3 fields + 3 of 4 cells
    expect(result.score).toBeCloseTo(4 / 7);
  });

  it('counts extra rows against the score and lists rows with nothing in common', () => {
    const result = compareToReference(
      { fields: {}, tables: { rows: [{ a: '1', b: '2' }] } },
      {
        fields: {},
        tables: {
          rows: [
            { a: '1', b: '2' },
            { a: '9', b: '9' },
            { a: 'x', b: 'y' },
          ],
        },
      },
    );
    const [rows] = result.tables;
    expect(rows).toMatchObject({ matched: 1, cells: 2, cellsTotal: 6 });
    expect(rows!.extra).toHaveLength(2);
    expect(result.score).toBeCloseTo(2 / 6);

    const disjoint = compareToReference(
      { fields: {}, tables: { rows: [{ a: '1' }] } },
      { fields: {}, tables: { rows: [{ a: '2' }] } },
    );
    expect(disjoint.tables[0]).toMatchObject({ missing: [{ a: '1' }], extra: [{ a: '2' }] });
  });

  it('reads middle-dot decimals as numbers (137·8 = 137.8)', () => {
    const result = compareToReference(
      { fields: { v: '137.8' }, tables: {} },
      { fields: { v: { value: '137·8' } }, tables: {} },
    );
    expect(result.score).toBe(1);
  });

  it('treats numbers and their string forms as equal', () => {
    const result = compareToReference(
      { fields: { n: 120.1 }, tables: {} },
      { fields: { n: { value: '120.10' } }, tables: {} },
    );
    expect(result.score).toBe(1);
  });
});

describe('diffDefinitions', () => {
  const v1 = {
    id: 't',
    version: 1,
    name: 'T',
    preamble: 'old rules',
    document: { sections: [{ id: 'all', anchor: '\\A' }] },
    outputs: {
      fields: [
        { id: 'a', type: 'text' },
        { id: 'b', type: 'text' },
      ],
      tables: [{ id: 'rows', columns: [{ id: 'x', type: 'text' }] }],
    },
    pipeline: [
      { type: 'extract', id: 's1', fields: ['a', 'b'], sections: ['all'], instructions: 'one' },
      { type: 'extract', id: 's2', table: 'rows', sections: ['all'] },
    ],
  };
  const v2 = {
    ...v1,
    version: 2,
    preamble: 'new rules',
    outputs: {
      fields: [
        { id: 'a', type: 'date' },
        { id: 'c', type: 'text' },
      ],
      tables: [
        {
          id: 'rows',
          columns: [
            { id: 'x', type: 'text' },
            { id: 'y', type: 'decimal' },
          ],
        },
      ],
    },
    pipeline: [
      { type: 'extract', id: 's2', table: 'rows', sections: ['all'], context: { k: 'a' } },
      { type: 'extract', id: 's1', fields: ['a', 'c'], sections: ['all'], instructions: 'two' },
    ],
  };

  it('describes changes by id rather than array position', () => {
    const changes = diffDefinitions(v1, v2).map((c) => `${c.kind} ${c.path}`);
    expect(changes).toEqual(
      expect.arrayContaining([
        'changed preamble',
        'changed outputs.fields[a].type',
        'removed outputs.fields[b]',
        'added outputs.fields[c]',
        'added outputs.tables[rows].columns[y]',
        'changed pipeline[s1].fields',
        'changed pipeline[s1].instructions',
        'added pipeline[s2].context',
        'changed pipeline order',
      ]),
    );
    expect(changes).not.toContain('changed version');
  });

  it('reports nothing for identical definitions', () => {
    expect(diffDefinitions(v1, { ...v1, version: 9 })).toEqual([]);
  });
});
