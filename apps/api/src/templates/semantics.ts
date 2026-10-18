import { CURIE_PREFIXES, IRI_UNSAFE, type OntologyTermKind, type Template } from '@ih/shared';
import type { OntologyRepo } from '../ontologies/repo.js';
import type { TemplateIssue } from './definitions.js';

/** What a mapping position needs a term to be (ADR 0011). */
type Want = 'class' | 'property' | 'concept' | 'scheme';

const PROPERTY_KINDS: OntologyTermKind[] = [
  'object_property',
  'datatype_property',
  'annotation_property',
];
const ACCEPTS: Record<Want, OntologyTermKind[]> = {
  class: ['class'],
  property: PROPERTY_KINDS,
  concept: ['concept'],
  scheme: ['scheme'],
};
const WANT_NAME: Record<Want, string> = {
  class: 'a class',
  property: 'a property',
  concept: 'a concept',
  scheme: 'a concept scheme',
};
const KIND_NAME: Record<OntologyTermKind, string> = {
  class: 'a class',
  object_property: 'an object property',
  datatype_property: 'a datatype property',
  annotation_property: 'an annotation property',
  concept: 'a concept',
  scheme: 'a concept scheme',
  shape: 'a shape',
};

const ABSOLUTE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const BUILT_IN = Object.values(CURIE_PREFIXES);

/** A CURIE or IRI as an IRI; null for an undeclared prefix (`rdf.expand` in the worker). */
export function expandTerm(term: string, prefixes: Record<string, string>): string | null {
  const colon = term.indexOf(':');
  if (colon > 0) {
    const prefix = term.slice(0, colon);
    const local = term.slice(colon + 1);
    const ns = prefixes[prefix];
    if (ns !== undefined && !local.startsWith('//')) return ns + local;
    if (ABSOLUTE.test(term) && (local.startsWith('//') || prefix === 'urn')) return term;
  }
  return null;
}

const PLACEHOLDER = /\{(\w+)(?:\|(\w+))?\}/g;
const FILTERS = ['slug', 'upper'];

/** An IRI template's problems: names it cannot use, filters that do not exist, bad characters. */
function iriTemplateIssues(path: string, template: string, allowed: string[]): TemplateIssue[] {
  const issues: TemplateIssue[] = [];
  for (const [, name, filter] of template.matchAll(PLACEHOLDER)) {
    if (!allowed.includes(name!)) {
      issues.push({
        path,
        message: `${name} is not available in this IRI template (use ${allowed.join(', ')})`,
      });
    }
    if (filter !== undefined && !FILTERS.includes(filter)) {
      issues.push({ path, message: `${filter} is not an IRI filter (use slug or upper)` });
    }
  }
  if (IRI_UNSAFE.test(template.replace(PLACEHOLDER, ''))) {
    issues.push({ path, message: `${template} has characters an IRI cannot carry` });
  }
  return issues;
}

/** Every IRI template the mapping holds, with the values each one may name. */
function templateChecks(template: Template): TemplateIssue[] {
  const semantics = template.semantics!;
  const issues = iriTemplateIssues('semantics.document.iri', semantics.document.iri, [
    'source',
    'type',
    'version',
  ]);
  const output = (
    path: string,
    m: NonNullable<Template['semantics']>['fields'][string],
    allowed: string[],
  ) => {
    if (m.object) issues.push(...iriTemplateIssues(`${path}.object.iri`, m.object.iri, allowed));
    if (m.concepts?.match === 'label' && !m.concepts.scheme) {
      issues.push({
        path: `${path}.concepts.scheme`,
        message: 'matching by label needs a concept scheme',
      });
    }
  };
  for (const [id, m] of Object.entries(semantics.fields))
    output(`semantics.fields.${id}`, m, ['value']);
  for (const [id, t] of Object.entries(semantics.tables)) {
    const columns =
      template.outputs.tables.find((x) => x.id === id)?.columns.map((c) => c.id) ?? [];
    if (t.iri) issues.push(...iriTemplateIssues(`semantics.tables.${id}.iri`, t.iri, columns));
    for (const [col, m] of Object.entries(t.columns)) {
      output(`semantics.tables.${id}.columns.${col}`, m, ['value', ...columns]);
    }
  }
  return issues;
}

/** Why a pinned version cannot be used: unknown, or not ready; null when it is. */
async function pinProblem(
  ontologies: OntologyRepo,
  pin: { id: string; version: number },
): Promise<string | null> {
  const detail = await ontologies.get(pin.id);
  const version = detail?.versions.find((v) => v.version === pin.version);
  if (!version) return `unknown ontology ${pin.id} v${pin.version}`;
  if (version.status !== 'ready') {
    return `ontology ${pin.id} v${pin.version} is not ready (${version.status})`;
  }
  return null;
}

interface Use {
  path: string;
  term: string;
  want: Want;
}

/** Every term the mapping names, with where it is and what it must be. */
function uses(semantics: NonNullable<Template['semantics']>): Use[] {
  const out: Use[] = [
    { path: 'semantics.document.class', term: semantics.document.class, want: 'class' },
  ];
  const output = (path: string, m: NonNullable<Template['semantics']>['fields'][string]) => {
    if (m.property !== undefined) {
      out.push({ path: `${path}.property`, term: m.property, want: 'property' });
    }
    if (m.object) out.push({ path: `${path}.object.class`, term: m.object.class, want: 'class' });
    if (m.concepts?.scheme) {
      out.push({ path: `${path}.concepts.scheme`, term: m.concepts.scheme, want: 'scheme' });
    }
    for (const [value, term] of Object.entries(m.concepts?.values ?? {})) {
      out.push({ path: `${path}.concepts.values.${value}`, term, want: 'concept' });
    }
  };
  for (const [id, m] of Object.entries(semantics.fields)) output(`semantics.fields.${id}`, m);
  for (const [id, t] of Object.entries(semantics.tables)) {
    out.push({ path: `semantics.tables.${id}.link`, term: t.link, want: 'property' });
    out.push({ path: `semantics.tables.${id}.class`, term: t.class, want: 'class' });
    for (const [col, m] of Object.entries(t.columns)) {
      output(`semantics.tables.${id}.columns.${col}`, m);
    }
  }
  return out;
}

/**
 * A recipe's ontology mapping checked against the library: pinned versions exist and are ready,
 * every CURIE expands, and every term is in a pinned version (its imports included) or declared
 * `local`, with a kind that fits where it is used. Unmapped outputs are warnings: they publish
 * under the recipe's default vocabulary.
 */
export async function semanticsIssues(
  ontologies: OntologyRepo,
  template: Template,
): Promise<TemplateIssue[]> {
  const semantics = template.semantics;
  if (!semantics) return [];
  const issues: TemplateIssue[] = [];
  const prefixes = { ...CURIE_PREFIXES, ...semantics.prefixes };

  for (const [prefix, ns] of Object.entries(semantics.prefixes)) {
    if (IRI_UNSAFE.test(ns)) {
      issues.push({ path: `semantics.prefixes.${prefix}`, message: `${ns} is not a valid IRI` });
    }
  }
  issues.push(...templateChecks(template));

  for (const [i, pin] of semantics.shapes.entries()) {
    const problem = await pinProblem(ontologies, pin);
    if (problem) issues.push({ path: `semantics.shapes.${i}`, message: problem });
  }

  const pins: { id: string; version: number }[] = [];
  for (const [i, pin] of semantics.ontologies.entries()) {
    const detail = await ontologies.get(pin.id);
    const version = detail?.versions.find((v) => v.version === pin.version);
    if (!version) {
      issues.push({
        path: `semantics.ontologies.${i}`,
        message: `unknown ontology ${pin.id} v${pin.version}`,
      });
    } else if (version.status !== 'ready') {
      issues.push({
        path: `semantics.ontologies.${i}`,
        message: `ontology ${pin.id} v${pin.version} is not ready (${version.status})`,
      });
    } else {
      pins.push(pin);
    }
  }

  const local = new Map<string, OntologyTermKind[]>();
  for (const [i, term] of semantics.local.entries()) {
    const iri = expandTerm(term.iri, prefixes);
    if (iri === null) {
      issues.push({ path: `semantics.local.${i}.iri`, message: `unknown prefix in ${term.iri}` });
    } else if (IRI_UNSAFE.test(iri)) {
      issues.push({ path: `semantics.local.${i}.iri`, message: `${term.iri} is not a valid IRI` });
    } else {
      local.set(iri, [...(local.get(iri) ?? []), term.kind]);
    }
  }

  const expanded = uses(semantics).map((u) => ({ ...u, iri: expandTerm(u.term, prefixes) }));
  const lookup = [
    ...new Set(
      expanded.flatMap((u) =>
        u.iri && !local.has(u.iri) && !BUILT_IN.some((ns) => u.iri!.startsWith(ns)) ? [u.iri] : [],
      ),
    ),
  ];
  const known = lookup.length ? await ontologies.termKinds(pins, lookup) : {};
  for (const u of expanded) {
    if (u.iri === null) {
      issues.push({ path: u.path, message: `unknown prefix in ${u.term}` });
      continue;
    }
    if (IRI_UNSAFE.test(u.iri)) {
      issues.push({ path: u.path, message: `${u.term} is not a valid IRI` });
      continue;
    }
    if (BUILT_IN.some((ns) => u.iri!.startsWith(ns))) continue;
    const kinds = local.get(u.iri) ?? known[u.iri] ?? [];
    if (kinds.length === 0) {
      issues.push({
        path: u.path,
        message: `${u.term} is not in the pinned ontologies: declare it under local`,
      });
    } else if (!kinds.some((k) => ACCEPTS[u.want].includes(k))) {
      issues.push({
        path: u.path,
        message: `${u.term} is ${KIND_NAME[kinds[0]!]}, not ${WANT_NAME[u.want]}`,
      });
    }
  }

  const unmapped = (path: string, id: string): TemplateIssue => ({
    path,
    message: `${id} is not mapped: it uses the recipe default vocabulary`,
    severity: 'warning',
  });
  for (const field of template.outputs.fields) {
    if (!semantics.fields[field.id])
      issues.push(unmapped(`semantics.fields.${field.id}`, field.id));
  }
  for (const table of template.outputs.tables) {
    const mapping = semantics.tables[table.id];
    if (!mapping) {
      issues.push(unmapped(`semantics.tables.${table.id}`, table.id));
      continue;
    }
    for (const column of table.columns) {
      if (!mapping.columns[column.id]) {
        issues.push(
          unmapped(`semantics.tables.${table.id}.columns.${column.id}`, `${table.id}.${column.id}`),
        );
      }
    }
  }
  return issues;
}
