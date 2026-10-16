import { describe, expect, it } from 'vitest';
import type { Neighbourhood } from '@ih/shared';
import { graphElements } from '../src/ontologies/graphRenderer.js';

const data: Neighbourhood = {
  nodes: [
    { iri: 'ex:a', label: 'process', kind: 'class', focus: true },
    { iri: 'ex:b', label: 'entity', kind: 'external', focus: false },
  ],
  edges: [{ source: 'ex:a', target: 'ex:b', kind: 'subClassOf' }],
  truncated: false,
};

describe('graphElements', () => {
  // Cytoscape hides every bezier edge between nodes sized `width: 'label'`, and lays them out
  // before their labels are measured: nodes carry a measured width instead.
  it('gives every node the measured width of its label', () => {
    const elements = graphElements(data, (text) => text.length * 6);
    expect(elements.slice(0, 2).map((e) => e.data)).toEqual([
      { id: 'ex:a', label: 'process', kind: 'class', focus: 1, w: 42 },
      { id: 'ex:b', label: 'entity', kind: 'external', focus: 0, w: 36 },
    ]);
  });

  it('labels each edge by its kind', () => {
    expect(graphElements(data, () => 0)[2]!.data).toEqual({
      id: 'ex:a|subClassOf|ex:b',
      source: 'ex:a',
      target: 'ex:b',
      label: 'subclass of',
    });
  });

  it('rounds widths up and never sizes a node below the minimum', () => {
    const [a, b] = graphElements(data, (text) => (text === 'process' ? 40.2 : 1));
    expect(a!.data).toMatchObject({ w: 41 });
    expect(b!.data).toMatchObject({ w: 12 });
  });
});
