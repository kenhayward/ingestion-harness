import { describe, expect, it } from 'vitest';
import {
  embeddingText,
  slugify,
  splitTags,
  statsLine,
  versionStatusText,
  visibleRows,
} from '../src/ontologies/derive.js';
import { ontologyTerm, ontologyVersion } from './fake-api.js';

describe('ontology helpers', () => {
  const progress = (embedded: number, terms: number) => ({
    model: 'm',
    version: 1,
    embedded,
    terms,
  });
  it.each([
    [null, null],
    [progress(0, 0), null], // nothing to embed
    [progress(0, 12), 'Embedded 0 of 12 terms (0%)'],
    [progress(125568, 238190), 'Embedded 125,568 of 238,190 terms (52%)'],
    [progress(999, 1000), 'Embedded 999 of 1,000 terms (99%)'], // never rounds up to 100%
    [progress(5427, 5427), 'All 5,427 terms embedded'],
    [progress(1, 1), 'All 1 term embedded'],
  ])('embeddingText(%j) = %j', (e, text) => {
    expect(embeddingText(e)).toBe(text);
  });

  it.each([
    [
      { triples: 9, classes: 1, properties: 2, concepts: 0, schemes: 0, shapes: 0, imported: 0 },
      '1 class · 2 properties',
    ],
    [
      { triples: 9, classes: 0, properties: 0, concepts: 5, schemes: 1, shapes: 3, imported: 0 },
      '5 concepts · 1 scheme · 3 shapes',
    ],
    [
      { triples: 0, classes: 0, properties: 0, concepts: 0, schemes: 0, shapes: 0, imported: 0 },
      'No terms',
    ],
  ])('statsLine %j', (stats, text) => {
    expect(statsLine(stats)).toBe(text);
  });

  it('describes each version status', () => {
    expect(versionStatusText(ontologyVersion({ status: 'queued' }))).toBe('Queued for import');
    expect(versionStatusText(ontologyVersion({ status: 'parsing' }))).toBe('Importing…');
    expect(versionStatusText(ontologyVersion({ status: 'failed', error: 'cannot read' }))).toBe(
      'Import failed: cannot read',
    );
    expect(versionStatusText(ontologyVersion())).toBe('3 classes · 2 properties');
  });

  it.each([
    ['IDMP-O Ontology', 'idmp-o-ontology'],
    ['  Acme  PV v2.1 ', 'acme-pv-v21'],
    ['Café_Ontologie', 'cafe-ontologie'],
  ])('slugify %s', (label, id) => {
    expect(slugify(label)).toBe(id);
  });

  it('splits tags', () => {
    expect(splitTags(' a, b ,,c')).toEqual(['a', 'b', 'c']);
  });

  it('flattens open nodes, stops at cycles and notes hidden children', () => {
    const a = ontologyTerm({ iri: 'A', label: 'A', childCount: 1 });
    const b = ontologyTerm({ iri: 'B', label: 'B', childCount: 1, parents: ['A'] });
    const kids = new Map([
      ['', { items: [a], total: 3 }],
      ['A', { items: [b], total: 1 }],
      ['B', { items: [a], total: 1 }], // A ⊂ B ⊂ A
    ]);
    const rows = visibleRows(kids, new Set(['/A', '/A/B', '/A/B/A']));
    expect(
      rows.map((r) =>
        r.kind === 'term' ? `${r.level}:${r.term.label}${r.cycle ? '↺' : ''}` : `more ${r.hidden}`,
      ),
    ).toEqual(['1:A', '2:B', '3:A↺', 'more 2']);
  });
});
