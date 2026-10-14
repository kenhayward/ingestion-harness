import {
  NEIGHBOURHOOD_LIMIT,
  type GraphEdge,
  type GraphNode,
  type Neighbourhood,
  type OntologyTerm,
} from '@ih/shared';

/** A term's neighbourhood for the graph view (ADR 0011, rollout step 2). */

const localName = (iri: string) =>
  iri
    .replace(/[/#]+$/, '')
    .split(/[#/:]/)
    .pop() || iri;

/** What a term points at, as graph edges from it. */
function relations(t: OntologyTerm): { target: string; kind: GraphEdge['kind'] }[] {
  if (t.kind === 'class') return t.parents.map((target) => ({ target, kind: 'subClassOf' }));
  if (t.kind === 'concept') {
    // A top concept's parent is its scheme (the tree's convention): that link is inScheme.
    return t.parents.map((target) => ({
      target,
      kind: target === t.scheme ? 'inScheme' : 'broader',
    }));
  }
  if (t.kind === 'shape') return t.domain.map((target) => ({ target, kind: 'targets' }));
  if (t.kind === 'scheme') return [];
  return [
    ...t.parents.map((target) => ({ target, kind: 'subPropertyOf' as const })),
    ...t.domain.map((target) => ({ target, kind: 'domain' as const })),
    ...t.range.map((target) => ({ target, kind: 'range' as const })),
  ];
}

/**
 * A term and what it is directly related to, up to `depth` hops, at most `cap` nodes. `load`
 * returns the rows for some IRIs and the rows naming them (parents, domains, ranges, scheme).
 */
export async function buildNeighbourhood(
  focus: string,
  depth: number,
  load: (iris: string[]) => Promise<OntologyTerm[]>,
  cap = NEIGHBOURHOOD_LIMIT,
): Promise<Neighbourhood> {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  const known = new Map<string, OntologyTerm>();
  let truncated = false;
  const add = (iri: string): boolean => {
    if (nodes.has(iri)) return true;
    if (nodes.size >= cap) {
      truncated = true;
      return false;
    }
    const term = known.get(iri);
    nodes.set(iri, {
      iri,
      label: term?.label ?? localName(iri),
      kind: term?.kind ?? 'external',
      focus: iri === focus,
    });
    return true;
  };

  let frontier = new Set([focus]);
  for (let hop = 0; hop < depth && frontier.size > 0 && !truncated; hop++) {
    const rows = await load([...frontier]);
    for (const r of rows) if (!known.has(r.iri)) known.set(r.iri, r);
    if (hop === 0) {
      if (!known.has(focus)) return { nodes: [], edges: [], truncated: false };
      add(focus);
    }
    const next = new Set<string>();
    for (const r of rows) {
      for (const rel of relations(r)) {
        if (!frontier.has(r.iri) && !frontier.has(rel.target)) continue;
        const fresh = [r.iri, rel.target].filter((i) => !nodes.has(i));
        if (!add(r.iri) || !add(rel.target)) continue;
        edges.set(`${r.iri}|${rel.kind}|${rel.target}`, {
          source: r.iri,
          target: rel.target,
          kind: rel.kind,
        });
        for (const f of fresh) next.add(f);
      }
    }
    // What the frontier points at (parents, domains, ranges, schemes) is not among the rows
    // naming the frontier: read those rows so such nodes get their own label and kind.
    const unnamed = [...nodes.values()].filter((n) => n.kind === 'external' && !known.has(n.iri));
    if (unnamed.length > 0) {
      const wanted = new Set(unnamed.map((n) => n.iri));
      for (const r of await load([...wanted])) {
        if (!wanted.has(r.iri) || known.has(r.iri)) continue;
        known.set(r.iri, r);
        nodes.set(r.iri, { ...nodes.get(r.iri)!, label: r.label, kind: r.kind });
      }
    }
    frontier = next;
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated };
}
