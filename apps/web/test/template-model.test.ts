import { describe, expect, it } from 'vitest';
import {
  checkPathOptions,
  moveItem,
  removeAt,
  setIn,
  validateDefinition,
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
