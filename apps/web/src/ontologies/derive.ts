import type {
  OntologyStats,
  OntologyStatus,
  OntologyTerm,
  OntologyTermKind,
  OntologyVersionView,
  TermGroup,
} from '@ih/shared';

/** Pure helpers for the ontology library pages (ADR 0011). */

export const KIND_LABEL = { owl: 'OWL', skos: 'SKOS', shacl: 'SHACL' } as const;

export const GROUP_LABEL: Record<TermGroup, string> = {
  classes: 'Classes',
  properties: 'Properties',
  concepts: 'Concept schemes',
  shapes: 'Shapes',
};

export const TERM_KIND_LABEL: Record<OntologyTermKind, string> = {
  class: 'Class',
  object_property: 'Object property',
  datatype_property: 'Datatype property',
  annotation_property: 'Annotation property',
  concept: 'Concept',
  scheme: 'Concept scheme',
  shape: 'Shape',
};

export const isImporting = (status: OntologyStatus) => status === 'queued' || status === 'parsing';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function statsLine(stats: OntologyStats | null): string {
  if (!stats) return '';
  const parts = [
    stats.classes && plural(stats.classes, 'class', 'classes'),
    stats.properties && plural(stats.properties, 'property', 'properties'),
    stats.concepts && plural(stats.concepts, 'concept', 'concepts'),
    stats.schemes && plural(stats.schemes, 'scheme', 'schemes'),
    stats.shapes && plural(stats.shapes, 'shape', 'shapes'),
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : 'No terms';
}

export function versionStatusText(v: OntologyVersionView): string {
  if (v.status === 'queued') return 'Queued for import';
  if (v.status === 'parsing') return 'Importing…';
  if (v.status === 'failed') return `Import failed: ${v.error ?? 'unknown error'}`;
  return statsLine(v.stats);
}

export function groupCount(stats: OntologyStats | null, group: TermGroup): number {
  if (!stats) return 0;
  if (group === 'classes') return stats.classes;
  if (group === 'properties') return stats.properties;
  if (group === 'concepts') return stats.concepts + stats.schemes;
  return stats.shapes;
}

/** An ontology id from its name (ONTOLOGY_ID_RE): lowercase ASCII words joined by dashes. */
export function slugify(label: string): string {
  return label
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[_\s]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 63);
}

export const splitTags = (text: string) =>
  text
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);

export interface LoadedChildren {
  items: OntologyTerm[];
  total: number;
}

export type TreeRow =
  | { kind: 'term'; term: OntologyTerm; level: number; path: string; cycle: boolean }
  | { kind: 'more'; level: number; path: string; hidden: number };

/**
 * The tree's visible rows: children loaded per parent IRI ('' = the roots), open nodes keyed by
 * path (the same term can appear under several parents). A term already among its ancestors
 * is shown once more, marked `cycle`, and never expanded.
 */
export function visibleRows(
  kids: ReadonlyMap<string, LoadedChildren>,
  open: ReadonlySet<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (parent: string, level: number, path: string, ancestors: readonly string[]) => {
    const page = kids.get(parent);
    if (!page) return;
    for (const term of page.items) {
      const p = `${path}/${term.iri}`;
      const cycle = ancestors.includes(term.iri);
      rows.push({ kind: 'term', term, level, path: p, cycle });
      if (!cycle && open.has(p)) walk(term.iri, level + 1, p, [...ancestors, term.iri]);
    }
    if (page.total > page.items.length) {
      rows.push({ kind: 'more', level, path: `${path}/…`, hidden: page.total - page.items.length });
    }
  };
  walk('', 1, '', []);
  return rows;
}
