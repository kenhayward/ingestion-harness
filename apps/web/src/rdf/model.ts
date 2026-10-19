import { Parser, type Quad, type Term } from 'n3';

/**
 * A published document graph (ADR 0011) read for people: the entities it describes, each with
 * its properties, the evidence behind them and who links to it. The worker's provenance
 * (`ct:Evidence`, `ct:Page`, `ct:Section`, the job's `prov:Activity`) is folded into the entities
 * instead of shown as entities, and value nodes (`ct:output`) into the property holding them.
 */

const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
const XSD = 'http://www.w3.org/2001/XMLSchema#';
const SKOS = 'http://www.w3.org/2004/02/skos/core#';
const PROV = 'http://www.w3.org/ns/prov#';
const DCTERMS = 'http://purl.org/dc/terms/';
/** `rdf.CT` in the worker. */
const CT = 'https://id.stocks-hayward.com/ns/ct#';

const TYPE = `${RDF}type`;
const LABELS = [`${RDFS}label`, `${SKOS}prefLabel`];
/** Subjects of these types are the worker's provenance, not things the document describes. */
const PROVENANCE_TYPES = new Set([`${CT}Evidence`, `${CT}Page`, `${CT}Section`, `${PROV}Activity`]);
/** Shown elsewhere (title, provenance line), never as a property row. */
const HIDDEN = new Set([TYPE, ...LABELS, `${PROV}wasGeneratedBy`, `${DCTERMS}source`]);
/** Datatypes that say nothing beyond "a string". */
const PLAIN = new Set([`${XSD}string`, `${RDF}langString`]);

export interface RdfLiteral {
  kind: 'literal';
  text: string;
  datatype: string | null;
  lang: string | null;
}
/** A value that is an entity of this graph (a card of its own). */
export interface RdfEntityRef {
  kind: 'entity';
  iri: string;
}
/** An IRI this graph does not describe: a concept, a class, a unit. */
export interface RdfTermRef {
  kind: 'term';
  iri: string;
}
/** A value node folded into its property: `12.5 kg`. */
export interface RdfNode {
  kind: 'node';
  iri: string;
  types: string[];
  value: RdfLiteral | RdfTermRef | null;
  unit: string | null;
  /** The recipe output it holds (`ct:output`). */
  output: string | null;
}
export type RdfValue = RdfLiteral | RdfEntityRef | RdfTermRef | RdfNode;

/** Where a value was read: the model's quote, its pages and section, and the step. */
export interface RdfEvidence {
  quote: string | null;
  pages: number[];
  section: string | null;
  step: string | null;
}

export interface RdfProperty {
  predicate: string;
  values: RdfValue[];
  evidence: RdfEvidence | null;
}

export interface RdfEntity {
  iri: string;
  types: string[];
  /** Its `rdfs:label` (or `skos:prefLabel`). */
  label: string | null;
  /** The last part of its IRI, to name it when it has no label. */
  key: string;
  root: boolean;
  properties: RdfProperty[];
  /** Evidence about the entity as a whole (a table row's section and step). */
  evidence: RdfEvidence | null;
  incoming: { from: string; predicate: string }[];
}

export interface RdfProvenance {
  recipe: string | null;
  recipeVersion: number | null;
  model: string | null;
  endedAt: string | null;
}

export interface RdfModel {
  entities: RdfEntity[];
  prefixes: Record<string, string>;
  triples: number;
  provenance: RdfProvenance | null;
  /** The source document (`dcterms:source` of the root). */
  source: string | null;
  /** The entity and property a node of this graph shows under (`predicate` null: an entity). */
  ownerOf(iri: string): { entity: string; predicate: string | null } | null;
}

const idOf = (t: Term) => (t.termType === 'BlankNode' ? `_:${t.value}` : t.value);

function literal(t: Term): RdfLiteral {
  const l = t as Term & { datatype?: Term; language?: string };
  const datatype = l.datatype?.value ?? null;
  return {
    kind: 'literal',
    text: t.value,
    datatype: datatype && !PLAIN.has(datatype) ? datatype : null,
    lang: l.language || null,
  };
}

const keyOf = (iri: string) => {
  const tail =
    iri
      .replace(/[/#]+$/, '')
      .split(/[/#:]/)
      .pop() ?? iri;
  try {
    return decodeURIComponent(tail) || iri;
  } catch {
    return tail || iri;
  }
};

/** Reads Turtle (or N-Triples) into the model; throws on a syntax error. */
export function parseGraph(turtle: string): RdfModel {
  const prefixes: Record<string, string> = {};
  const quads: Quad[] = new Parser().parse(turtle, null, (prefix, iri) => {
    prefixes[prefix] = iri.value;
  });

  const bySubject = new Map<string, Quad[]>();
  for (const q of quads) {
    const s = idOf(q.subject);
    const list = bySubject.get(s);
    if (list) list.push(q);
    else bySubject.set(s, [q]);
  }
  const objects = (s: string, p: string) =>
    (bySubject.get(s) ?? []).filter((q) => q.predicate.value === p).map((q) => q.object);
  const first = (s: string, p: string) => objects(s, p)[0]?.value ?? null;
  const typesOf = (s: string) => objects(s, TYPE).map((o) => o.value);

  const provenance = new Set<string>();
  const valueNodes = new Set<string>();
  for (const s of bySubject.keys()) {
    if (typesOf(s).some((t) => PROVENANCE_TYPES.has(t))) provenance.add(s);
    else if (objects(s, `${CT}output`).length) valueNodes.add(s);
  }
  const entityIds = [...bySubject.keys()].filter((s) => !provenance.has(s) && !valueNodes.has(s));
  const isEntity = new Set(entityIds);

  // Evidence: per subject and property, or per subject (a table row) when it names none.
  const evidence = new Map<string, RdfEvidence>();
  for (const s of provenance) {
    if (!typesOf(s).includes(`${CT}Evidence`)) continue;
    const subject = first(s, `${CT}subject`);
    if (!subject) continue;
    const section = first(s, `${CT}section`);
    const pages = objects(s, `${CT}page`)
      .map((p) => Number(first(idOf(p), `${CT}pageNumber`)))
      .filter((n) => Number.isInteger(n) && n > 0)
      .sort((a, b) => a - b);
    evidence.set(`${subject}|${first(s, `${CT}property`) ?? ''}`, {
      quote: first(s, `${CT}quote`),
      pages,
      section: section ? first(section, `${RDFS}label`) : null,
      step: first(s, `${CT}step`),
    });
  }

  const value = (o: Term): RdfValue => {
    if (o.termType === 'Literal') return literal(o);
    const id = idOf(o);
    if (valueNodes.has(id)) {
      let held: RdfLiteral | RdfTermRef | null = null;
      let unit: string | null = null;
      for (const q of bySubject.get(id) ?? []) {
        const p = q.predicate.value;
        if (p === TYPE || p === `${CT}output`) continue;
        if (q.object.termType === 'Literal') held ??= literal(q.object);
        else unit ??= q.object.value;
      }
      // A node holding a concept instead of a literal: the IRI is its value, not a unit.
      if (!held && unit) [held, unit] = [{ kind: 'term', iri: unit }, null];
      return {
        kind: 'node',
        iri: id,
        types: typesOf(id),
        value: held,
        unit,
        output: first(id, `${CT}output`),
      };
    }
    return isEntity.has(id) ? { kind: 'entity', iri: id } : { kind: 'term', iri: id };
  };

  const owners = new Map<string, { entity: string; predicate: string | null }>();
  const incoming = new Map<string, { from: string; predicate: string }[]>();
  const entities: RdfEntity[] = entityIds.map((s) => {
    const byPredicate = new Map<string, RdfValue[]>();
    for (const q of bySubject.get(s)!) {
      const p = q.predicate.value;
      if (HIDDEN.has(p)) continue;
      const v = value(q.object);
      if (v.kind === 'node') owners.set(v.iri, { entity: s, predicate: p });
      if (v.kind === 'entity') {
        const list = incoming.get(v.iri) ?? [];
        list.push({ from: s, predicate: p });
        incoming.set(v.iri, list);
      }
      byPredicate.set(p, [...(byPredicate.get(p) ?? []), v]);
    }
    owners.set(s, { entity: s, predicate: null });
    const label = LABELS.map((p) => first(s, p)).find((l) => l !== null) ?? null;
    return {
      iri: s,
      types: typesOf(s),
      label,
      key: keyOf(s),
      root: false,
      properties: [...byPredicate.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([predicate, values]) => ({
          predicate,
          values,
          evidence: evidence.get(`${s}|${predicate}`) ?? null,
        })),
      evidence: evidence.get(`${s}|`) ?? null,
      incoming: [],
    };
  });
  for (const e of entities) e.incoming = incoming.get(e.iri) ?? [];

  // The root: what the job generated, else the first entity nothing links to.
  const byIri = new Map(entities.map((e) => [e.iri, e]));
  const root =
    entities.find((e) => objects(e.iri, `${PROV}wasGeneratedBy`).length) ??
    [...entities].sort((a, b) => a.iri.localeCompare(b.iri)).find((e) => !e.incoming.length) ??
    null;
  if (root) root.root = true;

  // Root first, then what it links to in property order (breadth first), then the rest.
  const ordered: RdfEntity[] = [];
  const seen = new Set<string>();
  const queue = root ? [root] : [];
  while (queue.length) {
    const e = queue.shift()!;
    if (seen.has(e.iri)) continue;
    seen.add(e.iri);
    ordered.push(e);
    for (const p of e.properties)
      for (const v of [...p.values].sort((a, b) => valueSort(a).localeCompare(valueSort(b))))
        if (v.kind === 'entity' && !seen.has(v.iri)) queue.push(byIri.get(v.iri)!);
  }
  ordered.push(
    ...entities.filter((e) => !seen.has(e.iri)).sort((a, b) => a.iri.localeCompare(b.iri)),
  );

  const job = root ? first(root.iri, `${PROV}wasGeneratedBy`) : null;
  const version = job ? first(job, `${CT}recipeVersion`) : null;
  return {
    entities: ordered,
    prefixes,
    triples: quads.length,
    provenance: job
      ? {
          recipe: first(job, `${CT}recipe`),
          recipeVersion: version === null ? null : Number(version),
          model: first(job, `${CT}model`),
          endedAt: first(job, `${PROV}endedAtTime`),
        }
      : null,
    source: root ? first(root.iri, `${DCTERMS}source`) : null,
    ownerOf: (iri) => owners.get(iri) ?? null,
  };
}

const valueSort = (v: RdfValue) => (v.kind === 'literal' ? v.text : v.iri);

/**
 * Every IRI worth a readable name: the entities' types, the properties, the terms and units
 * values name. Entities themselves are named by their label or key.
 */
export function termsOf(model: RdfModel): string[] {
  const terms = new Set<string>();
  for (const e of model.entities) {
    e.types.forEach((t) => terms.add(t));
    for (const p of model.entities.length ? e.properties : []) {
      terms.add(p.predicate);
      for (const v of p.values) {
        if (v.kind === 'term') terms.add(v.iri);
        if (v.kind === 'node') {
          v.types.forEach((t) => terms.add(t));
          if (v.unit) terms.add(v.unit);
          if (v.value?.kind === 'term') terms.add(v.value.iri);
        }
      }
    }
  }
  return [...terms];
}

/** `acme:sentBy` for an IRI under a declared prefix, else the IRI. */
export function curieOf(iri: string, prefixes: Record<string, string>): string {
  let best: [string, string] | null = null;
  for (const [prefix, ns] of Object.entries(prefixes))
    if (iri.startsWith(ns) && iri.length > ns.length && (!best || ns.length > best[1].length))
      best = [prefix, ns];
  return best ? `${best[0]}:${iri.slice(best[1].length)}` : iri;
}

/** A term's name from its IRI when no ontology names it: `…/sentBy` reads "Sent by". */
export function humanise(iri: string): string {
  const local = iri.split(/[/#]/).pop() ?? '';
  if (!local) return iri;
  // A run of capitals stays together (`KiloGM`); a single capital after a lower-case letter
  // starts a word.
  const words = local
    .replace(/([a-z])([A-Z])(?=[a-z])/g, '$1 $2')
    .split(/[\s._-]+/)
    .filter(Boolean);
  const text = words.map((w, i) => (i === 0 || /[A-Z].*[A-Z]/.test(w) ? w : w.toLowerCase()));
  const joined = text.join(' ');
  return joined.charAt(0).toUpperCase() + joined.slice(1);
}

const DATE = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});
const DATE_TIME = new Intl.DateTimeFormat('en-GB', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
  timeZoneName: 'short',
});

/** A literal as people read it: dates spelled out, booleans as Yes/No, the rest as written. */
export function formatLiteral(l: RdfLiteral): string {
  if (l.datatype === `${XSD}boolean`) return l.text === 'true' || l.text === '1' ? 'Yes' : 'No';
  if (l.datatype === `${XSD}date` && /^\d{4}-\d{2}-\d{2}$/.test(l.text)) {
    const d = new Date(`${l.text}T00:00:00Z`);
    if (!Number.isNaN(d.getTime())) return DATE.format(d);
  }
  if (l.datatype === `${XSD}dateTime`) {
    const d = new Date(l.text);
    if (!Number.isNaN(d.getTime())) return DATE_TIME.format(d);
  }
  return l.text;
}
