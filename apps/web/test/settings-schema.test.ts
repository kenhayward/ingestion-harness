import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { PluginInfo } from '@ih/shared';
import { setSetting, settingsFields } from '../src/templates/settings-schema.js';

const catalogue = JSON.parse(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../packages/shared/test/fixtures/plugin-catalogue.json',
    ),
    'utf8',
  ),
) as { plugins: PluginInfo[] };
const pattern = catalogue.plugins.find((p) => p.ref === 'text.pattern@1')!;

describe('settingsFields', () => {
  it("reads text.pattern@1's settings as a map, a text and a switch", () => {
    expect(settingsFields(pattern.settingsSchema)).toEqual([
      {
        key: 'patterns',
        title: 'Patterns',
        description: expect.stringContaining('field id to regular expression'),
        kind: 'map',
      },
      {
        key: 'row',
        title: 'Row pattern',
        description: expect.stringContaining('one regular expression per row'),
        kind: 'text',
      },
      {
        key: 'ignoreCase',
        title: 'Ignore case',
        description: undefined,
        kind: 'boolean',
        fallback: false, // the schema's default, which the form leaves out of `with`
      },
    ]);
  });

  it.each<[string, Record<string, unknown>, unknown]>([
    ['an integer', { type: 'integer', title: 'Max' }, { kind: 'integer', title: 'Max' }],
    ['a number', { type: 'number' }, { kind: 'number', title: 'x' }],
    ['a choice', { enum: ['a', 'b'] }, { kind: 'enum', options: ['a', 'b'], title: 'x' }],
    [
      'an optional choice',
      { anyOf: [{ enum: ['a', 'b'], type: 'string' }, { type: 'null' }] },
      { kind: 'enum', options: ['a', 'b'], title: 'x' },
    ],
    ['a list of text', { type: 'array', items: { type: 'string' } }, { kind: 'list', title: 'x' }],
    ['anything else', { type: 'object', properties: { a: {} } }, { kind: 'json', title: 'x' }],
    ['a union', { anyOf: [{ type: 'string' }, { type: 'integer' }] }, { kind: 'json', title: 'x' }],
  ])('reads %s', (_, property, field) => {
    const [read] = settingsFields({ type: 'object', properties: { x: property } });
    expect(read).toMatchObject({ key: 'x', ...(field as object) });
  });

  it('reads a schema with no properties as no fields', () => {
    expect(settingsFields({ type: 'object' })).toEqual([]);
    expect(settingsFields({})).toEqual([]);
  });
});

describe('setSetting', () => {
  it('sets a value and leaves out what is empty, so the step stores only what is set', () => {
    expect(setSetting({}, 'row', 'x')).toEqual({ row: 'x' });
    expect(setSetting({ row: 'x', ignoreCase: true }, 'row', '')).toEqual({ ignoreCase: true });
    expect(setSetting({ ignoreCase: true }, 'ignoreCase', false)).toEqual({});
    expect(setSetting({ patterns: { a: 'x' } }, 'patterns', {})).toEqual({});
    expect(setSetting({ items: ['a'] }, 'items', [])).toEqual({});
    expect(setSetting({}, 'max', 0)).toEqual({ max: 0 });
  });
});
