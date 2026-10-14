import { describe, expect, it } from 'vitest';
import type { SpecSummary } from '@ih/shared';
import { legacyTypes, versionsText, type LegacyType } from '../src/templates/legacy.js';

const spec = (
  id: string,
  version: number,
  title = id,
  kind: SpecSummary['kind'] = 'spec',
): SpecSummary => ({ id, version, title, kind });
const legacy = (id: string, title: string, versions: number[]): LegacyType => ({
  id,
  title,
  description: null,
  versions,
});
const retired = { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: null };

const cases: [string, SpecSummary[], string[], LegacyType[]][] = [
  ['no specs', [], [], []],
  [
    'one file-only type: versions oldest first, the newest title',
    [spec('demo', 2, 'Demo v2'), spec('demo', 1, 'Demo')],
    [],
    [legacy('demo', 'Demo v2', [1, 2])],
  ],
  [
    'a type with a database recipe is a recipe card only',
    [spec('pvp', 1), spec('pvp', 2), spec('pvp', 3, 'pvp', 'template')],
    ['pvp'],
    [],
  ],
  ['a template file is never legacy', [spec('tdemo', 1, 'Template demo', 'template')], [], []],
  ['a row without kind is left out', [{ id: 'old', version: 1, title: 'Old' }], [], []],
  ['a retired row is left out', [{ ...spec('gone', 1), retired }], [], []],
  [
    'sorted by title',
    [spec('b', 1, 'Beta'), spec('a', 1, 'Alpha')],
    [],
    [legacy('a', 'Alpha', [1]), legacy('b', 'Beta', [1])],
  ],
];

describe('legacyTypes (D16)', () => {
  it.each(cases)('%s', (_name, specs, recipeIds, expected) => {
    expect(legacyTypes(specs, new Set(recipeIds))).toEqual(expected);
  });

  it('keeps the newest description', () => {
    expect(
      legacyTypes(
        [
          { ...spec('demo', 1), description: 'Old' },
          { ...spec('demo', 2), description: 'New' },
        ],
        new Set(),
      ),
    ).toEqual([{ id: 'demo', title: 'demo', description: 'New', versions: [1, 2] }]);
  });
});

describe('versionsText', () => {
  it.each([
    [[1], 'Version v1'],
    [[1, 2], 'Versions v1, v2'],
  ])('%j reads %s', (versions, text) => {
    expect(versionsText(versions)).toBe(text);
  });
});
