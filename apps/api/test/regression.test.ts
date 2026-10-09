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
    expect(result.tables[0]).toMatchObject({ id: 'batches', expected: 2, actual: 2, matched: 2 });
  });

  it('reports changed fields and missing/extra rows', () => {
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
    expect(result.fields.find((f) => f.id === 'executed_on')).toMatchObject({
      expected: '2023-02',
      actual: '2023-01',
    });
    const [batches] = result.tables;
    expect(batches).toMatchObject({ matched: 1 });
    expect(batches!.missing).toEqual([{ batch: 'G17230212', size: '13.5 L' }]);
    expect(batches!.extra).toEqual([{ batch: 'G1Y230212', size: '13.5 L' }]);
    // 1 of 3 fields + 1 of 2 rows matched
    expect(result.score).toBeCloseTo(2 / 5);
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
