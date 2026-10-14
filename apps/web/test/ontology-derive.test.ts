import { describe, expect, it } from 'vitest';
import {
  slugify,
  splitTags,
  statsLine,
  versionStatusText,
  visibleRows,
} from '../src/ontologies/derive.js';
import { ontologyTerm, ontologyVersion } from './fake-api.js';

describe('ontology helpers', () => {
  it.each([
    [
      { triples: 9, classes: 1, properties: 2, concepts: 0, schemes: 0, shapes: 0 },
      '1 class · 2 properties',
    ],
    [
      { triples: 9, classes: 0, properties: 0, concepts: 5, schemes: 1, shapes: 3 },
      '5 concepts · 1 scheme · 3 shapes',
    ],
    [{ triples: 0, classes: 0, properties: 0, concepts: 0, schemes: 0, shapes: 0 }, 'No terms'],
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
