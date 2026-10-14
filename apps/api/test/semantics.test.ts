import { describe, expect, it } from 'vitest';
import fixture from '../../../packages/shared/test/fixtures/template-semantics.json' with { type: 'json' };
import { MemoryOntologyRepo } from '../src/ontologies/repo.js';
import { templateIssues } from '../src/templates/definitions.js';
import { multipart, testApp } from './helpers.js';

const A = 'https://acme.example/def/';
const TTL = Buffer.from('@prefix owl: <http://www.w3.org/2002/07/owl#> .\n');

async function setup() {
  const ontologies = new MemoryOntologyRepo();
  const ctx = await testApp({ ontologies });
  for (const id of ['acme', 'draft']) {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/ontologies',
      ...multipart(
        { id, label: id },
        { filename: `${id}.ttl`, content: TTL, contentType: 'text/turtle' },
      ),
    });
    expect(res.statusCode).toBe(202);
  }
  ontologies.markReady('acme', 1);
  ontologies.seedTerms('acme', 1, [
    { iri: `${A}Letter`, kind: 'class', label: 'Letter' },
    { iri: `${A}Party`, kind: 'class', label: 'Party' },
    { iri: `${A}Line`, kind: 'class', label: 'Line' },
    { iri: `${A}sentBy`, kind: 'object_property', label: 'sent by' },
    { iri: `${A}kind`, kind: 'object_property', label: 'kind' },
    { iri: `${A}hasLine`, kind: 'object_property', label: 'has line' },
    { iri: `${A}sku`, kind: 'datatype_property', label: 'sku' },
    { iri: `${A}qty`, kind: 'datatype_property', label: 'qty' },
    { iri: `${A}Memo`, kind: 'concept', label: 'Memo' },
    { iri: `${A}Kinds`, kind: 'scheme', label: 'Kinds' },
  ]);
  return ctx;
}

type Semantics = Record<string, unknown>;

const FULL: Semantics = {
  ontologies: [{ id: 'acme', version: 1 }],
  prefixes: { acme: A },
  document: { class: 'acme:Letter' },
  fields: {
    sender: { property: 'acme:sentBy', object: { class: 'acme:Party', iri: 'party/{value|slug}' } },
    kind: {
      property: 'acme:kind',
      concepts: { scheme: 'acme:Kinds', values: { memo: 'acme:Memo' } },
    },
  },
  tables: {
    lines: {
      link: 'acme:hasLine',
      class: 'acme:Line',
      columns: { sku: { property: 'acme:sku' }, qty: { property: 'acme:qty' } },
    },
  },
};

const withSemantics = (patch: (s: Semantics) => Semantics) => ({
  ...fixture.base,
  semantics: patch(structuredClone(FULL)),
});

async function issuesOf(patch: (s: Semantics) => Semantics) {
  const { app } = await setup();
  return templateIssues(app.deps, withSemantics(patch), { draft: true });
}

describe('mapping validation', () => {
  it('a complete mapping to a ready ontology has no issues', async () => {
    expect(await issuesOf((s) => s)).toEqual([]);
  });

  it.each<[string, (s: Semantics) => Semantics, string, string]>([
    [
      'an unknown ontology',
      (s) => ({ ...s, ontologies: [{ id: 'nope', version: 1 }] }),
      'semantics.ontologies.0',
      'unknown ontology nope v1',
    ],
    [
      'a version that is not ready',
      (s) => ({ ...s, ontologies: [...(s.ontologies as unknown[]), { id: 'draft', version: 1 }] }),
      'semantics.ontologies.1',
      'ontology draft v1 is not ready (queued)',
    ],
    [
      'a prefix that is not declared',
      (s) => ({ ...s, document: { class: 'zzz:Letter' } }),
      'semantics.document.class',
      'unknown prefix in zzz:Letter',
    ],
    [
      'a term no pinned ontology has',
      (s) => ({ ...s, document: { class: 'acme:Invoice' } }),
      'semantics.document.class',
      'acme:Invoice is not in the pinned ontologies: declare it under local',
    ],
    [
      'a class where a property belongs',
      (s) => ({ ...s, tables: { lines: { ...(s.tables as any).lines, link: 'acme:Line' } } }), // eslint-disable-line @typescript-eslint/no-explicit-any -- a test patch
      'semantics.tables.lines.link',
      'acme:Line is a class, not a property',
    ],
    [
      'a property where a concept belongs',
      (s) => ({
        ...s,
        fields: {
          ...(s.fields as object),
          kind: { property: 'acme:kind', concepts: { values: { memo: 'acme:sku' } } },
        },
      }),
      'semantics.fields.kind.concepts.values.memo',
      'acme:sku is a datatype property, not a concept',
    ],
  ])('flags %s', async (_name, patch, path, message) => {
    expect(await issuesOf(patch)).toContainEqual({ path, message });
  });

  it('accepts recipe-local terms and the built-in vocabularies', async () => {
    const issues = await issuesOf((s) => ({
      ...s,
      local: [{ iri: 'acme:Invoice', kind: 'class', label: 'Invoice' }],
      document: { class: 'acme:Invoice' },
      fields: { ...(s.fields as object), sender: { property: 'rdfs:label' } },
    }));
    expect(issues).toEqual([]);
  });

  it('unmapped outputs are warnings, not errors', async () => {
    const issues = await issuesOf((s) => ({ ...s, fields: {}, tables: {} }));
    expect(issues).toEqual([
      {
        path: 'semantics.fields.sender',
        message: 'sender is not mapped: it uses the recipe default vocabulary',
        severity: 'warning',
      },
      {
        path: 'semantics.fields.kind',
        message: 'kind is not mapped: it uses the recipe default vocabulary',
        severity: 'warning',
      },
      {
        path: 'semantics.tables.lines',
        message: 'lines is not mapped: it uses the recipe default vocabulary',
        severity: 'warning',
      },
    ]);
  });

  it('a recipe without semantics is not checked', async () => {
    const { app } = await setup();
    expect(await templateIssues(app.deps, fixture.base, { draft: true })).toEqual([]);
  });
});

describe('publishing with mapping issues', () => {
  async function draftWith(semantics: Semantics) {
    const ctx = await setup();
    await ctx.templates.create('letter', 1, { ...fixture.base, semantics }, 'draft');
    return ctx;
  }

  it('warnings do not block publishing', async () => {
    const { app } = await draftWith({ ...FULL, fields: {} });
    const res = await app.inject({
      method: 'POST',
      url: '/api/templates/letter/versions/1/publish',
    });
    expect(res.statusCode).toBe(200);
  });

  it('errors do', async () => {
    const { app } = await draftWith({ ...FULL, document: { class: 'acme:Invoice' } });
    const res = await app.inject({
      method: 'POST',
      url: '/api/templates/letter/versions/1/publish',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues).toEqual([
      {
        path: 'semantics.document.class',
        message: 'acme:Invoice is not in the pinned ontologies: declare it under local',
      },
    ]);
  });
});
