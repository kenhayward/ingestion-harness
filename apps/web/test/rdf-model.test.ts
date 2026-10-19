import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  curieOf,
  formatLiteral,
  humanise,
  parseGraph,
  termsOf,
  type RdfModel,
} from '../src/rdf/model.js';

/** The worker's golden graph (`worker/tests/fixtures/rdf/letter-graph.ttl`): what a job publishes. */
const LETTER = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../../worker/tests/fixtures/rdf/letter-graph.ttl',
  ),
  'utf8',
);
const DOC = 'https://data.acme.example/ct/doc/ab12';
const ACME = 'https://acme.example/def/';

const entity = (m: RdfModel, iri: string) => {
  const e = m.entities.find((x) => x.iri === iri);
  if (!e) throw new Error(`no entity ${iri}`);
  return e;
};
const prop = (m: RdfModel, iri: string, predicate: string) =>
  entity(m, iri).properties.find((p) => p.predicate === predicate);

describe('parseGraph on the golden letter graph', () => {
  const m = parseGraph(LETTER);

  it('counts every triple and keeps the prefixes', () => {
    // One object per line ends in ` ;`, ` .` or `,` (the prefixes end in ` .` too).
    const objects = LETTER.split('\n').filter((l) => !l.startsWith('@') && /( ;| \.|,)$/.test(l));
    expect(m.triples).toBe(objects.length);
    expect(m.prefixes.acme).toBe(ACME);
  });

  it('puts the document first and leaves provenance (evidence, pages, sections, the job) out', () => {
    expect(m.entities[0]!.iri).toBe(DOC);
    expect(m.entities[0]!.root).toBe(true);
    expect(m.entities.map((e) => e.iri)).toEqual([
      DOC,
      'https://data.acme.example/ct/doc/ab12/letter/lines/2',
      'https://data.acme.example/ct/line/AB-1',
      'https://data.acme.example/ct/party/unicorn-labs-ltd',
    ]);
  });

  it('reads the job as provenance and the source, not as properties', () => {
    expect(m.provenance).toEqual({
      recipe: 'letter',
      recipeVersion: 3,
      model: 'local/qwen',
      endedAt: '2026-10-14T10:00:00+00:00',
    });
    expect(m.source).toBe('urn:sha256:ab12');
    const shown = entity(m, DOC).properties.map((p) => p.predicate);
    expect(shown).not.toContain('http://www.w3.org/ns/prov#wasGeneratedBy');
    expect(shown).not.toContain('http://purl.org/dc/terms/source');
    expect(shown).not.toContain('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
  });

  it('tells entities in the graph from terms outside it, and keeps literals typed', () => {
    expect(prop(m, DOC, `${ACME}sentBy`)!.values).toEqual([
      { kind: 'entity', iri: 'https://data.acme.example/ct/party/unicorn-labs-ltd' },
    ]);
    expect(prop(m, DOC, `${ACME}kind`)!.values).toEqual([{ kind: 'term', iri: `${ACME}Memo` }]);
    expect(prop(m, DOC, `${ACME}sent`)!.values).toEqual([
      {
        kind: 'literal',
        text: '2023-02-11',
        datatype: 'http://www.w3.org/2001/XMLSchema#date',
        lang: null,
      },
    ]);
    expect(prop(m, DOC, `${ACME}tag`)!.values.map((v) => v.kind === 'literal' && v.text)).toEqual([
      'a',
      'b',
    ]);
    expect(prop(m, DOC, `${ACME}hasLine`)!.values).toHaveLength(2);
  });

  it('attaches the evidence of each value: quote, page and section', () => {
    expect(prop(m, DOC, `${ACME}sentBy`)!.evidence).toEqual({
      quote: 'From: Ünïcorn Labs Ltd',
      pages: [1],
      section: 'head',
      step: 'head',
    });
    expect(entity(m, 'https://data.acme.example/ct/line/AB-1').evidence).toEqual({
      quote: null,
      pages: [],
      section: 'body',
      step: 'rows',
    });
  });

  it('names an entity by its label, else by the last part of its IRI', () => {
    expect(entity(m, 'https://data.acme.example/ct/party/unicorn-labs-ltd').label).toBe(
      'Ünïcorn Labs Ltd',
    );
    expect(entity(m, 'https://data.acme.example/ct/line/AB-1')).toMatchObject({
      label: null,
      key: 'AB-1',
      types: [`${ACME}Line`],
    });
  });

  it('knows who links to an entity', () => {
    expect(entity(m, 'https://data.acme.example/ct/line/AB-1').incoming).toEqual([
      { from: DOC, predicate: `${ACME}hasLine` },
    ]);
  });

  it('lists the terms to look labels up for: types, properties, terms', () => {
    const terms = termsOf(m);
    expect(terms).toEqual(
      expect.arrayContaining([`${ACME}Letter`, `${ACME}sentBy`, `${ACME}Memo`, `${ACME}Line`]),
    );
    expect(terms).not.toContain(DOC);
    expect(new Set(terms).size).toBe(terms.length);
  });
});

describe('value nodes', () => {
  const ttl = `@prefix acme: <https://acme.example/def/> .
@prefix ct: <https://id.stocks-hayward.com/ns/ct#> .
@prefix prov: <http://www.w3.org/ns/prov#> .
@prefix qudt: <http://qudt.org/schema/qudt/> .
@prefix unit: <http://qudt.org/vocab/unit/> .
<https://d/doc/x> a acme:Batch ; prov:wasGeneratedBy <https://d/job/1> ;
  acme:mass <https://d/doc/x/batch/value/mass> .
<https://d/doc/x/batch/value/mass> a qudt:QuantityValue ; qudt:numericValue 12.5 ;
  qudt:unit unit:KiloGM ; ct:output "mass" .
<https://d/job/1> a prov:Activity .`;
  const m = parseGraph(ttl);

  it('folds a value node into its property: value, unit, class and output', () => {
    expect(m.entities.map((e) => e.iri)).toEqual(['https://d/doc/x']);
    expect(prop(m, 'https://d/doc/x', `${ACME}mass`)!.values).toEqual([
      {
        kind: 'node',
        iri: 'https://d/doc/x/batch/value/mass',
        types: ['http://qudt.org/schema/qudt/QuantityValue'],
        value: {
          kind: 'literal',
          text: '12.5',
          datatype: 'http://www.w3.org/2001/XMLSchema#decimal',
          lang: null,
        },
        unit: 'http://qudt.org/vocab/unit/KiloGM',
        output: 'mass',
      },
    ]);
  });

  it('finds the entity and property a value node belongs to', () => {
    expect(m.ownerOf('https://d/doc/x/batch/value/mass')).toEqual({
      entity: 'https://d/doc/x',
      predicate: `${ACME}mass`,
    });
    expect(m.ownerOf('https://d/doc/x')).toEqual({ entity: 'https://d/doc/x', predicate: null });
    expect(m.ownerOf('https://elsewhere')).toBeNull();
  });
});

describe('graphs without a job', () => {
  it('takes the entity nothing links to as the root', () => {
    const m = parseGraph(
      '<https://d/b> <https://p/q> "1" . <https://d/a> <https://p/has> <https://d/b> .',
    );
    expect(m.entities.map((e) => [e.iri, e.root])).toEqual([
      ['https://d/a', true],
      ['https://d/b', false],
    ]);
    expect(m.provenance).toBeNull();
  });

  it('is empty for an empty graph and throws on broken Turtle', () => {
    expect(parseGraph('').entities).toEqual([]);
    expect(() => parseGraph('<a> <b> .')).toThrow();
  });
});

describe('naming terms', () => {
  it.each([
    ['https://acme.example/def/sentBy', 'Sent by'],
    ['https://acme.example/def/Letter', 'Letter'],
    ['https://data.acme.example/ct/def/letter/lines.qty', 'Lines qty'],
    ['http://qudt.org/vocab/unit/KiloGM', 'KiloGM'],
    ['http://example.org/ns#has_part', 'Has part'],
    ['https://example.org/ns#', 'https://example.org/ns#'],
  ])('humanise(%s) = %s', (iri, name) => {
    expect(humanise(iri)).toBe(name);
  });

  it.each([
    ['https://acme.example/def/sentBy', 'acme:sentBy'],
    ['https://other.example/x', 'https://other.example/x'],
  ])('curieOf(%s) = %s', (iri, curie) => {
    expect(curieOf(iri, { acme: 'https://acme.example/def/' })).toBe(curie);
  });
});

describe('formatLiteral', () => {
  const XSD = 'http://www.w3.org/2001/XMLSchema#';
  it.each([
    ['2023-02-11', `${XSD}date`, '11 February 2023'],
    ['true', `${XSD}boolean`, 'Yes'],
    ['false', `${XSD}boolean`, 'No'],
    ['12.5', `${XSD}decimal`, '12.5'],
    ['not a date', `${XSD}date`, 'not a date'],
    ['hello', null, 'hello'],
  ])('%s as %s reads %s', (text, datatype, shown) => {
    expect(formatLiteral({ kind: 'literal', text, datatype, lang: null })).toBe(shown);
  });
});
