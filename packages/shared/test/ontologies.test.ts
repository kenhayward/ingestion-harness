import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  NeighbourhoodQuerySchema,
  OntologyFromUrlBodySchema,
  hostAllowed,
  ontologyFileNameFromUrl,
  ontologyUrlProblem,
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

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/ontology-url.json', import.meta.url), 'utf8'),
) as { hosts: { host: string; allow: string[]; allowed: boolean }[] };

describe('ontology URL rules (shared with the worker)', () => {
  it.each(fixture.hosts.map((c) => [c.host, c.allow, c.allowed] as const))(
    '%s against %j → %s',
    (host, allow, allowed) => {
      expect(hostAllowed(host, allow)).toBe(allowed);
    },
  );

  it.each([
    ['https://w3id.org/idmp/o', ['w3id.org'], null],
    ['https://w3id.org/idmp/o', [], 'URL imports are off: set ONTOLOGY_FETCH_ALLOW'],
    ['not a url', ['w3id.org'], 'not a URL'],
    ['http://w3id.org/x', ['w3id.org'], 'only https URLs can be imported'],
    ['https://evil.org/x', ['w3id.org'], 'evil.org is not on ONTOLOGY_FETCH_ALLOW'],
  ])('%s', (url, hosts, problem) => {
    expect(ontologyUrlProblem(url, hosts)).toBe(problem);
  });

  it('names a fetched file after its path', () => {
    expect(ontologyFileNameFromUrl('https://w3id.org/idmp/core.ttl?x=1')).toBe('core.ttl');
    expect(ontologyFileNameFromUrl('https://w3id.org/')).toBe('w3id.org');
  });

  it('parses the URL import body and the neighbourhood query', () => {
    expect(OntologyFromUrlBodySchema.safeParse({ id: 'pv', url: 'https://x.org/a' }).success).toBe(
      true,
    );
    expect(
      OntologyFromUrlBodySchema.safeParse({ id: 'pv', url: 'https://x.org/a', x: 1 }).success,
    ).toBe(false);
    expect(NeighbourhoodQuerySchema.parse({ iri: 'https://x.org/A' })).toEqual({
      iri: 'https://x.org/A',
      depth: 1,
    });
    expect(NeighbourhoodQuerySchema.safeParse({ iri: 'x', depth: '3' }).success).toBe(false);
  });
});
