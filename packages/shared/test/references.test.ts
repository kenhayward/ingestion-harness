import { describe, expect, it } from 'vitest';
import { outputChanges } from '../src/references.js';

const base = {
  fields: [
    { id: 'sender', type: 'text', description: 'who wrote it' },
    { id: 'kind', type: 'enum', enum: ['a', 'b'] },
  ],
  tables: [{ id: 'lines', columns: [{ id: 'item' }, { id: 'qty', type: 'number' }] }],
};
const clone = () => JSON.parse(JSON.stringify(base)) as typeof base & Record<string, unknown>;

describe('outputChanges', () => {
  const cases: [string, unknown, unknown, string[]][] = [
    ['identical', base, base, []],
    ['legacy reference (no verified outputs) is trusted', null, base, []],
    [
      'names and descriptions do not count',
      base,
      (() => {
        const c = clone();
        c.fields[0]!.description = 'changed';
        (c.tables[0] as Record<string, unknown>).name = 'Lines';
        return c;
      })(),
      [],
    ],
    [
      'missing type is text',
      base,
      (() => {
        const c = clone();
        delete (c.fields[0] as Record<string, unknown>).type;
        return c;
      })(),
      [],
    ],
    [
      'enum order does not count',
      base,
      (() => {
        const c = clone();
        c.fields[1]!.enum = ['b', 'a'];
        return c;
      })(),
      [],
    ],
    [
      'enum value changed',
      base,
      (() => {
        const c = clone();
        c.fields[1]!.enum = ['a', 'c'];
        return c;
      })(),
      ['field:kind'],
    ],
    [
      'field added and field type changed',
      base,
      (() => {
        const c = clone();
        c.fields[0]!.type = 'date';
        c.fields.push({ id: 'total', type: 'number' } as (typeof c.fields)[number]);
        return c;
      })(),
      ['field:sender', 'field:total'],
    ],
    ['field removed', base, { ...clone(), fields: [base.fields[0]] }, ['field:kind']],
    ['table removed', base, { ...clone(), tables: [] }, ['table:lines']],
    [
      'column added and column type changed',
      base,
      (() => {
        const c = clone();
        c.tables[0]!.columns[1]!.type = 'text';
        c.tables[0]!.columns.push({ id: 'unit' } as (typeof c.tables)[0]['columns'][number]);
        return c;
      })(),
      ['table:lines.qty', 'table:lines.unit'],
    ],
    ['current outputs unreadable', base, null, ['field:kind', 'field:sender', 'table:lines']],
  ];
  it.each(cases)('%s', (_name, verified, current, expected) => {
    expect(outputChanges(verified, current)).toEqual(expected);
  });
});
