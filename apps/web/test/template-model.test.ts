import { describe, expect, it } from 'vitest';
import {
  checkPathOptions,
  moveItem,
  removeAt,
  setIn,
  validateDefinition,
  withPublishTo,
} from '../src/templates/model.js';
import { validDefinition } from './template-fixture.js';

describe('template model helpers', () => {
  it('sets nested values immutably', () => {
    const def = validDefinition();
    const next = setIn(def, ['outputs', 'fields', 0, 'name'], 'Sender');
    expect(next.outputs.fields[0]).toEqual({ id: 'sender', type: 'text', name: 'Sender' });
    expect(def.outputs.fields[0]).toEqual({ id: 'sender', type: 'text' });
    expect(next.pipeline).toBe(def.pipeline); // untouched branches are shared
  });

  it('moves and removes list items', () => {
    expect(moveItem(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveItem(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
    expect(removeAt(['a', 'b', 'c'], 1)).toEqual(['a', 'c']);
  });

  it('offers fields and table columns as check paths', () => {
    expect(checkPathOptions(validDefinition())).toEqual(['sender', 'lines.item', 'lines.qty']);
  });

  it('validates like the API: schema plus no custom prompt files', () => {
    expect(validateDefinition(validDefinition())).toEqual([]);
    expect(validateDefinition({ ...validDefinition(), pipeline: [] }).join()).toContain('pipeline');
    const withPrompt = setIn(validDefinition(), ['pipeline', 0, 'prompt'], 'p.j2');
    expect(validateDefinition(withPrompt).join()).toContain('custom prompt files');
  });
});

describe('withPublishTo (a recipe delivers to one target or a list)', () => {
  it('writes a string for one target and a list for two', () => {
    expect(withPublishTo({ formats: ['csv'] }, ['lake'])).toEqual({
      formats: ['csv'],
      publishTo: 'lake',
    });
    expect(withPublishTo(undefined, ['archive', 'default'])).toEqual({
      publishTo: ['archive', 'default'],
    });
  });

  it('removes the key for the default target alone, and no delivery is left when nothing is', () => {
    expect(withPublishTo({ formats: ['json'], publishTo: 'lake' }, ['default'])).toEqual({
      formats: ['json'],
    });
    expect(withPublishTo({ publishTo: ['a', 'b'] }, [])).toBeUndefined();
  });

  it("a one-target recipe keeps its definitionSha256 through the editor's round trip", () => {
    // The hash is of the stored JSON: the same string in, the same bytes out.
    const stored = { formats: ['csv', 'json', 'rdf'], publishTo: 'archive' };
    const next = withPublishTo(stored, ['archive']);
    expect(JSON.stringify(next)).toBe(JSON.stringify(stored));
  });
});
