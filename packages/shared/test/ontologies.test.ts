import { describe, expect, it } from 'vitest';
import {
  ONTOLOGY_ID_RE,
  OntologyPatchSchema,
  TERM_GROUPS,
  ontologyFormat,
  ontologyNormalizedKey,
  ontologySourceKey,
} from '../src/index.js';

describe('ontologyFormat', () => {
  it.each([
    ['idmp.ttl', { ext: 'ttl', mediaType: 'text/turtle' }],
    ['IDMP.OWL', { ext: 'owl', mediaType: 'application/rdf+xml' }],
    ['x.rdf', { ext: 'rdf', mediaType: 'application/rdf+xml' }],
    ['ctx.jsonld', { ext: 'jsonld', mediaType: 'application/ld+json' }],
    ['dump.nt', { ext: 'nt', mediaType: 'application/n-triples' }],
    ['old.n3', { ext: 'n3', mediaType: 'text/n3' }],
    ['notes.pdf', null],
    ['noext', null],
  ])('%s', (name, expected) => {
    expect(ontologyFormat(name)).toEqual(expected);
  });
});

describe('ontology ids', () => {
  it.each([
    ['idmp-o', true],
    ['a1', true],
    ['x', false],
    ['-idmp', false],
    ['IDMP', false],
    ['idmp_o', false],
  ])('%s → %s', (id, ok) => {
    expect(ONTOLOGY_ID_RE.test(id)).toBe(ok);
  });
});

describe('OntologyPatchSchema', () => {
  it('accepts known fields and refuses others', () => {
    expect(OntologyPatchSchema.safeParse({ label: 'IDMP-O', retired: true }).success).toBe(true);
    expect(OntologyPatchSchema.safeParse({ version: 2 }).success).toBe(false);
    expect(OntologyPatchSchema.safeParse({ tags: ['Industry Pharma'] }).success).toBe(false);
  });
});

describe('ontology keys and groups', () => {
  it('names sources by their bytes and normalized files by version', () => {
    expect(ontologySourceKey('idmp-o', 'ab12', 'ttl')).toBe('ontologies/idmp-o/sources/ab12.ttl');
    expect(ontologyNormalizedKey('idmp-o', 3)).toBe('ontologies/idmp-o/v3/normalized.nt');
  });

  it('puts every kind in exactly one group', () => {
    const kinds = Object.values(TERM_GROUPS).flat();
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toHaveLength(7);
  });
});
