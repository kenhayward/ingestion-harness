import { describe, expect, it } from 'vitest';
import { outputCoverage, TemplateSchema, type OutputCoverage } from '../src/template.js';

const outputs = {
  fields: [{ id: 'a' }, { id: 'b' }],
  tables: [{ id: 't', columns: [{ id: 'c' }] }],
};
const def = (pipeline: unknown[], outs: unknown = outputs) => ({ outputs: outs, pipeline });
const extract = (id: string, more: Record<string, unknown>) => ({
  type: 'extract',
  id,
  sections: ['x'],
  ...more,
});

describe('outputCoverage', () => {
  it.each<[string, unknown, OutputCoverage]>([
    [
      'every output filled once',
      def([extract('s1', { fields: ['a', 'b'] }), extract('s2', { table: 't' })]),
      {
        outputs: [
          { id: 'a', kind: 'field', steps: ['s1'] },
          { id: 'b', kind: 'field', steps: ['s1'] },
          { id: 't', kind: 'table', steps: ['s2'] },
        ],
        uncovered: [],
        multiple: [],
      },
    ],
    [
      'an unfilled field and table',
      def([extract('s1', { fields: ['a'] })]),
      {
        outputs: [
          { id: 'a', kind: 'field', steps: ['s1'] },
          { id: 'b', kind: 'field', steps: [] },
          { id: 't', kind: 'table', steps: [] },
        ],
        uncovered: ['b', 't'],
        multiple: [],
      },
    ],
    [
      'a field filled by two steps',
      def([
        extract('s1', { fields: ['a', 'b'] }),
        extract('s2', { fields: ['a'] }),
        extract('s3', { table: 't' }),
      ]),
      {
        outputs: [
          { id: 'a', kind: 'field', steps: ['s1', 's2'] },
          { id: 'b', kind: 'field', steps: ['s1'] },
          { id: 't', kind: 'table', steps: ['s3'] },
        ],
        uncovered: [],
        multiple: ['a'],
      },
    ],
    [
      'a step listing a field twice counts twice',
      def([extract('s1', { fields: ['a', 'a', 'b'] }), extract('s2', { table: 't' })]),
      {
        outputs: [
          { id: 'a', kind: 'field', steps: ['s1', 's1'] },
          { id: 'b', kind: 'field', steps: ['s1'] },
          { id: 't', kind: 'table', steps: ['s2'] },
        ],
        uncovered: [],
        multiple: ['a'],
      },
    ],
    [
      'check steps and unknown fields fill nothing',
      def([
        extract('s1', { fields: ['a', 'b', 'zzz'] }),
        extract('s2', { table: 't' }),
        { type: 'check', id: 'k', values: 'a', reference: 'b' },
      ]),
      {
        outputs: [
          { id: 'a', kind: 'field', steps: ['s1'] },
          { id: 'b', kind: 'field', steps: ['s1'] },
          { id: 't', kind: 'table', steps: ['s2'] },
        ],
        uncovered: [],
        multiple: [],
      },
    ],
    [
      'duplicate tables collapse, a table sharing a field id reads as a field',
      def([extract('s1', { fields: ['a'] })], {
        fields: [{ id: 'a' }],
        tables: [
          { id: 'a', columns: [] },
          { id: 'u', columns: [] },
          { id: 'u', columns: [] },
        ],
      }),
      {
        outputs: [
          { id: 'a', kind: 'field', steps: ['s1'] },
          { id: 'a', kind: 'field', steps: ['s1'] },
          { id: 'u', kind: 'table', steps: [] },
        ],
        uncovered: ['u'],
        multiple: [],
      },
    ],
    ['a raw draft with missing parts', {}, { outputs: [], uncovered: [], multiple: [] }],
    [
      'malformed parts are ignored',
      {
        outputs: { fields: [{ id: 1 }, 'x', { id: 'a' }], tables: 'nope' },
        pipeline: [null, { type: 'extract', id: 's', fields: 'a' }],
      },
      {
        outputs: [{ id: 'a', kind: 'field', steps: [] }],
        uncovered: ['a'],
        multiple: [],
      },
    ],
    ['not an object', null, { outputs: [], uncovered: [], multiple: [] }],
  ])('%s', (_name, definition, expected) => {
    expect(outputCoverage(definition)).toEqual(expected);
  });

  it('gives the template validation messages (unchanged)', () => {
    const result = TemplateSchema.safeParse({
      id: 'demo',
      version: 1,
      name: 'Demo',
      document: { sections: [{ id: 'x', anchor: 'X' }] },
      outputs: { fields: [{ id: 'a' }, { id: 'b' }], tables: [] },
      pipeline: [extract('s1', { fields: ['a'] }), extract('s2', { fields: ['a'] })],
    });
    expect(result.success).toBe(false);
    expect(result.error!.issues.map((i) => i.message)).toEqual([
      'field "a" is filled by more than one step',
      'field "b" is not filled by any step',
    ]);
  });
});

describe('outputCoverage with plugin steps', () => {
  it('counts a plugin step as filling its outputs', () => {
    const plugin = { type: 'plugin', id: 'p1', uses: 'text.pattern@1', fields: ['a', 'b'] };
    const covered = outputCoverage(def([plugin, extract('s2', { table: 't' })]));
    expect(covered.uncovered).toEqual([]);
    expect(covered.outputs[0]).toEqual({ id: 'a', kind: 'field', steps: ['p1'] });
  });

  it('counts an output filled by an extract and a plugin step twice', () => {
    const plugin = { type: 'plugin', id: 'p1', uses: 'text.pattern@1', table: 't' };
    const covered = outputCoverage(
      def([extract('s1', { fields: ['a', 'b'] }), extract('s2', { table: 't' }), plugin]),
    );
    expect(covered.multiple).toEqual(['t']);
  });

  it('never counts a check step', () => {
    const check = { type: 'check', id: 'c1', values: 'a', reference: 'a', fields: ['b'] };
    expect(outputCoverage(def([extract('s1', { fields: ['a'] }), check])).uncovered).toEqual([
      'b',
      't',
    ]);
  });
});
