import type { DraftChange } from '@ih/shared';

/** The mapping stage's change ops (ADR 0011). */
const MAPPING_OPS = new Set([
  'setDocumentMapping',
  'putFieldMapping',
  'putTableMapping',
  'removeMapping',
  'putLocalTerm',
]);

type MappingChange = Extract<
  DraftChange,
  {
    op:
      | 'setDocumentMapping'
      | 'putFieldMapping'
      | 'putTableMapping'
      | 'removeMapping'
      | 'putLocalTerm';
  }
>;
const isMapping = (c: DraftChange): c is MappingChange => MAPPING_OPS.has(c.op);

/** "Suggested · high": the model's confidence in a mapping change; null for other changes. */
export function mappingBadge(c: DraftChange): string | null {
  return isMapping(c) && c.confidence ? `Suggested · ${c.confidence}` : null;
}

/** The values behind a mapping change and the terms it was chosen over, in one line. */
export function mappingNote(c: DraftChange): string | null {
  if (!isMapping(c)) return null;
  const parts = [];
  if (c.evidence?.length) parts.push(`Seen: ${c.evidence.join(', ')}`);
  if (c.alternatives?.length) {
    parts.push(`Alternatives: ${c.alternatives.map((a) => a.label).join(', ')}`);
  }
  return parts.length ? parts.join(' · ') : null;
}

type Def = Record<string, unknown>;
interface Mapped {
  property: string;
  object?: { class: string };
  concepts?: unknown;
}

/** Every output of a definition and what it maps to; null: the recipe's default vocabulary. */
export function mappingRows(definition: Def | null): { path: string; term: string | null }[] {
  if (!definition) return [];
  const outputs = (definition.outputs ?? {}) as {
    fields?: { id: string }[];
    tables?: { id: string; columns?: { id: string }[] }[];
  };
  const semantics = (definition.semantics ?? null) as {
    document?: { class?: string };
    fields?: Record<string, Mapped>;
    tables?: Record<string, { link: string; class: string; columns?: Record<string, Mapped> }>;
  } | null;
  const describe = (m: Mapped | undefined) =>
    m ? (m.object ? `${m.property} → ${m.object.class}` : m.property) : null;
  const rows: { path: string; term: string | null }[] = [
    { path: 'document', term: semantics?.document?.class || null },
  ];
  for (const f of outputs.fields ?? []) {
    rows.push({ path: f.id, term: describe(semantics?.fields?.[f.id]) });
  }
  for (const t of outputs.tables ?? []) {
    const table = semantics?.tables?.[t.id];
    rows.push({ path: t.id, term: table ? `${table.link} → ${table.class}` : null });
    for (const c of t.columns ?? []) {
      rows.push({ path: `${t.id}.${c.id}`, term: describe(table?.columns?.[c.id]) });
    }
  }
  return rows;
}
