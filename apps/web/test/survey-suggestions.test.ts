import { describe, expect, it } from 'vitest';
import { EMPTY_BRIEF } from '@ih/shared';
import { pinState, staleText, withPin } from '../src/workbench/suggestions.js';

const body = {
  ...EMPTY_BRIEF,
  ontologies: [
    { ontologyId: 'idmp', version: 2, role: 'vocabulary' as const },
    { ontologyId: 'shapes', version: 1, role: 'shapes' as const },
  ],
};

describe('suggestion helpers', () => {
  it.each([
    [{ ontologyId: 'idmp', version: 2 }, { kind: 'pinned' }],
    [
      { ontologyId: 'idmp', version: 3 },
      { kind: 'older', pinned: 2 },
    ],
    [{ ontologyId: 'shapes', version: 1 }, { kind: 'none' }],
    [{ ontologyId: 'qudt', version: 1 }, { kind: 'none' }],
  ])('pinState %j', (s, expected) => {
    expect(pinState(s, body)).toEqual(expected);
  });

  it('pins a new vocabulary, or moves a pin to the suggested version', () => {
    expect(withPin(body, 'qudt', 1).ontologies).toEqual([
      ...body.ontologies,
      { ontologyId: 'qudt', version: 1, role: 'vocabulary' },
    ]);
    expect(withPin(body, 'idmp', 3).ontologies).toEqual([
      { ontologyId: 'idmp', version: 3, role: 'vocabulary' },
      { ontologyId: 'shapes', version: 1, role: 'shapes' },
    ]);
  });

  it('explains staleness', () => {
    expect(staleText('library')).toBe('The ontology library changed since these suggestions.');
    expect(staleText('survey')).toBe('These suggestions are from an earlier survey.');
  });
});
