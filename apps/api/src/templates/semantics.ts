import { CURIE_PREFIXES, IRI_UNSAFE, type OntologyTermKind, type Template } from '@ih/shared';
import type { OntologyRepo } from '../ontologies/repo.js';
import type { TemplateIssue } from './definitions.js';

/**
 * What a mapping position needs a term to be (ADR 0011). `link`: the object property reaching a
 * value node; `value`: the datatype property holding its value; `iri`: any IRI, never looked up
 * (a unit: units are individuals, which the library does not index).
 */
type Want =
  'class' | 'property' | 'concept' | 'scheme' | 'link' | 'value' | 'objectProperty' | 'iri';

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
  link: ['object_property'],
  value: ['datatype_property'],
  objectProperty: ['object_property'],
  iri: [],
};
const WANT_NAME: Record<Want, string> = {
  class: 'a class',
  property: 'a property',
  concept: 'a concept',
  scheme: 'a concept scheme',
  link: 'an object property: a value node is reached by an object property',
  value: 'a datatype property',
  objectProperty: 'an object property',
  iri: 'an IRI',
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

const XSD = 'http://www.w3.org/2001/XMLSchema#';
/** The XSD types each output type's values fit (a type not listed: any range will do). */
const XSD_FITS: Record<string, { name: string; types: string[] }> = {
  integer: {
    name: 'an integer',
    types: ['integer', 'int', 'long', 'short', 'decimal', 'nonNegativeInteger', 'positiveInteger'],
  },
  decimal: { name: 'a decimal', types: ['decimal', 'double', 'float'] },
  date: { name: 'a date', types: ['date', 'dateTime', 'dateTimeStamp'] },
  boolean: { name: 'a boolean', types: ['boolean'] },
};

/**
 * Why a value property cannot hold an output's values: every range it declares is an XSD type
 * the output type does not fit. Null when it fits, or declares no XSD range.
 */
function rangeProblem(
  term: string,
  ranges: string[],
  holds: { id: string; type: string },
): string | null {
  const fits = XSD_FITS[holds.type];
  if (!fits || ranges.length === 0 || !ranges.every((r) => r.startsWith(XSD))) return null;
  if (ranges.some((r) => fits.types.includes(r.slice(XSD.length)))) return null;
  const named = ranges.map((r) => `xsd:${r.slice(XSD.length)}`).join(' or ');
  return `${term} holds ${named} values: ${holds.id} is ${fits.name}`;
}

interface Use {
  path: string;
  term: string;
  want: Want;
  /** A value node's value property: the output whose values it holds (the range warning). */
  holds?: { id: string; type: string };
}

type OutputMapping = NonNullable<Template['semantics']>['fields'][string];

/** Every term the mapping names, with where it is and what it must be. */
function uses(semantics: NonNullable<Template['semantics']>, outputs: Template['outputs']): Use[] {
  const out: Use[] = [
    { path: 'semantics.document.class', term: semantics.document.class, want: 'class' },
  ];
  const output = (path: string, m: OutputMapping, holds?: { id: string; type: string }) => {
    if (m.property !== undefined) {
      out.push({ path: `${path}.property`, term: m.property, want: m.node ? 'link' : 'property' });
    }
    if (m.node) {
      out.push({ path: `${path}.node.class`, term: m.node.class, want: 'class' });
      if (m.node.value !== undefined) {
        out.push({ path: `${path}.node.value`, term: m.node.value, want: 'value', holds });
      } else if (semantics.valueNodes?.value !== undefined && holds) {
        // The default is kind-checked once, at semantics.valueNodes; only its range here.
        const term = semantics.valueNodes.value;
        out.push({ path: `${path}.node.value`, term, want: 'iri', holds });
      }
      if (m.node.unit !== undefined) {
        out.push({ path: `${path}.node.unit`, term: m.node.unit, want: 'iri' });
      }
      if (m.node.unitProperty !== undefined) {
        const term = m.node.unitProperty;
        out.push({ path: `${path}.node.unitProperty`, term, want: 'objectProperty' });
      }
    }
    if (m.object) out.push({ path: `${path}.object.class`, term: m.object.class, want: 'class' });
    if (m.concepts?.scheme) {
      out.push({ path: `${path}.concepts.scheme`, term: m.concepts.scheme, want: 'scheme' });
    }
    for (const [value, term] of Object.entries(m.concepts?.values ?? {})) {
      out.push({ path: `${path}.concepts.values.${value}`, term, want: 'concept' });
    }
  };
  const defaults = semantics.valueNodes;
  if (defaults?.link !== undefined) {
    out.push({ path: 'semantics.valueNodes.link', term: defaults.link, want: 'link' });
  }
  if (defaults?.value !== undefined) {
    out.push({ path: 'semantics.valueNodes.value', term: defaults.value, want: 'value' });
  }
  if (defaults?.unitProperty !== undefined) {
    const term = defaults.unitProperty;
    out.push({ path: 'semantics.valueNodes.unitProperty', term, want: 'objectProperty' });
  }
  const typed = (id: string, values: { id: string; type: string }[] | undefined) => {
    const def = values?.find((v) => v.id === id);
    return def ? { id, type: def.type } : undefined;
  };
  for (const [id, m] of Object.entries(semantics.fields)) {
    output(`semantics.fields.${id}`, m, typed(id, outputs.fields));
  }
  for (const [id, t] of Object.entries(semantics.tables)) {
    out.push({ path: `semantics.tables.${id}.link`, term: t.link, want: 'property' });
    out.push({ path: `semantics.tables.${id}.class`, term: t.class, want: 'class' });
    const columns = outputs.tables.find((x) => x.id === id)?.columns;
    for (const [col, m] of Object.entries(t.columns)) {
      output(`semantics.tables.${id}.columns.${col}`, m, typed(col, columns));
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

  const expanded = uses(semantics, template.outputs).map((u) => ({
    ...u,
    iri: expandTerm(u.term, prefixes),
  }));
  const lookup = [
    ...new Set(
      expanded.flatMap((u) =>
        u.iri &&
        u.want !== 'iri' &&
        !local.has(u.iri) &&
        !BUILT_IN.some((ns) => u.iri!.startsWith(ns))
          ? [u.iri]
          : [],
      ),
    ),
  ];
  const known = lookup.length ? await ontologies.termKinds(pins, lookup) : {};
  const held = [...new Set(expanded.flatMap((u) => (u.holds && u.iri ? [u.iri] : [])))];
  const ranges = held.length ? await ontologies.termRanges(pins, held) : {};
  for (const u of expanded) {
    if (u.iri === null) {
      issues.push({ path: u.path, message: `unknown prefix in ${u.term}` });
      continue;
    }
    if (IRI_UNSAFE.test(u.iri)) {
      issues.push({ path: u.path, message: `${u.term} is not a valid IRI` });
      continue;
    }
    if (u.holds) {
      const problem = rangeProblem(u.term, ranges[u.iri] ?? [], u.holds);
      if (problem) issues.push({ path: u.path, message: problem, severity: 'warning' });
    }
    if (u.want === 'iri' || BUILT_IN.some((ns) => u.iri!.startsWith(ns))) continue;
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
