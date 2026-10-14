import { describe, expect, it } from 'vitest';
import type { OntologyTerm } from '@ih/shared';
import { buildNeighbourhood } from '../src/ontologies/neighbourhood.js';

const C = 'https://x.org/#';
const t = (
  iri: string,
  kind: OntologyTerm['kind'],
  extra: Partial<OntologyTerm> = {},
): OntologyTerm => ({
  iri: C + iri,
  kind,
  label: iri,
  altLabels: [],
  definition: '',
  parents: [],
  domain: [],
  range: [],
  scheme: null,
  deprecated: false,
  childCount: 0,
  definedIn: null,
  ...extra,
});
const ALL = [
  t('Thing', 'class'),
  t('Batch', 'class', { parents: [C + 'Thing'] }),
  t('Protocol', 'class', { parents: [C + 'Thing'] }),
  t('hasBatch', 'object_property', { domain: [C + 'Protocol'], range: [C + 'Batch'] }),
  t('BatchShape', 'shape', { domain: [C + 'Batch'] }),
  t('Lot', 'class', { parents: [C + 'Batch', 'https://other.org/Item'] }),
  t('Stages', 'scheme'),
  t('Mixing', 'concept', { parents: [C + 'Stages'], scheme: C + 'Stages' }),
  t('WetMixing', 'concept', { parents: [C + 'Mixing'], scheme: C + 'Stages' }),
];
const related = (rows: OntologyTerm[], iris: string[]) =>
  rows.filter(
    (r) =>
      iris.includes(r.iri) ||
      [...r.parents, ...r.domain, ...r.range].some((x) => iris.includes(x)) ||
      (r.scheme !== null && iris.includes(r.scheme)),
  );
const load = async (iris: string[]) => related(ALL, iris);

describe('buildNeighbourhood', () => {
  it('collects a class, its parents, children, properties and shapes', async () => {
    const n = await buildNeighbourhood(C + 'Batch', 1, load);
    expect(n.nodes.find((x) => x.focus)).toMatchObject({ iri: C + 'Batch', label: 'Batch' });
    expect(n.nodes.map((x) => x.label).sort()).toEqual([
      'Batch',
      'BatchShape',
      'Lot',
      'Thing',
      'hasBatch',
    ]);
    expect(n.edges).toContainEqual({
      source: C + 'Batch',
      target: C + 'Thing',
      kind: 'subClassOf',
    });
    expect(n.edges).toContainEqual({ source: C + 'Lot', target: C + 'Batch', kind: 'subClassOf' });
    expect(n.edges).toContainEqual({ source: C + 'hasBatch', target: C + 'Batch', kind: 'range' });
    expect(n.edges).toContainEqual({
      source: C + 'BatchShape',
      target: C + 'Batch',
      kind: 'targets',
    });
    expect(n.truncated).toBe(false);
  });

  it('goes a second hop and shows IRIs outside the version as external', async () => {
    const n = await buildNeighbourhood(C + 'Batch', 2, load);
    expect(n.nodes.find((x) => x.iri === 'https://other.org/Item')).toMatchObject({
      kind: 'external',
      label: 'Item',
    });
    expect(n.nodes.some((x) => x.iri === C + 'Protocol')).toBe(true);
  });

  it('links concepts to their scheme and broader concepts', async () => {
    const n = await buildNeighbourhood(C + 'Mixing', 1, load);
    expect(n.edges).toContainEqual({
      source: C + 'Mixing',
      target: C + 'Stages',
      kind: 'inScheme',
    });
    expect(n.edges).toContainEqual({
      source: C + 'WetMixing',
      target: C + 'Mixing',
      kind: 'broader',
    });
  });

  it('stops at the cap', async () => {
    const hub = [
      t('Hub', 'class'),
      ...Array.from({ length: 300 }, (_, i) => t(`K${i}`, 'class', { parents: [C + 'Hub'] })),
    ];
    const n = await buildNeighbourhood(C + 'Hub', 1, async (iris) => related(hub, iris), 150);
    expect(n.nodes).toHaveLength(150);
    expect(n.truncated).toBe(true);
    const iris = new Set(n.nodes.map((x) => x.iri));
    expect(n.edges.every((e) => iris.has(e.source) && iris.has(e.target))).toBe(true);
  });

  it('is empty for an unknown term', async () => {
    expect(await buildNeighbourhood(C + 'Nope', 1, load)).toEqual({
      nodes: [],
      edges: [],
      truncated: false,
    });
  });

  it("names a term's own parents, domains and scheme from their rows", async () => {
    const rows = [
      t('Thing', 'class', { label: 'Anything at all' }),
      t('Batch', 'class', { parents: [C + 'Thing'] }),
      t('hasBatch', 'object_property', { domain: [C + 'Protocol'], range: [C + 'Batch'] }),
      t('Protocol', 'class', { label: 'Validation protocol' }),
    ];
    const batch = await buildNeighbourhood(C + 'Batch', 1, async (iris) => related(rows, iris));
    expect(batch.nodes.find((n) => n.iri === C + 'Thing')).toMatchObject({
      kind: 'class',
      label: 'Anything at all',
    });
    const prop = await buildNeighbourhood(C + 'hasBatch', 1, async (iris) => related(rows, iris));
    expect(prop.nodes.find((n) => n.iri === C + 'Protocol')).toMatchObject({
      kind: 'class',
      label: 'Validation protocol',
    });
  });
});
