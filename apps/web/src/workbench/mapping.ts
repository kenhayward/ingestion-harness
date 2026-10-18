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

/**
 * "Suggested · high": the model's confidence in a mapping change; "Remembered · 3 recipes" for
 * one the mapping memory pre-selected (docs/design/mapping-memory.md); null for other changes.
 */
export function mappingBadge(c: DraftChange): string | null {
  if (!isMapping(c)) return null;
  if (c.remembered) {
    const n = c.remembered.votes;
    const confirmed = c.remembered.status === 'confirmed' ? ' · confirmed' : '';
    return `Remembered · ${n} recipe${n === 1 ? '' : 's'}${confirmed}`;
  }
  return c.confidence ? `Suggested · ${c.confidence}` : null;
}

/** The values behind a mapping change and the terms it was chosen over, in one line. */
export function mappingNote(c: DraftChange): string | null {
  if (!isMapping(c)) return null;
  const parts = [];
  const columns = Object.keys(c.rememberedColumns ?? {});
  if (columns.length) parts.push(`Remembered: ${columns.join(', ')}`);
  if (c.evidence?.length) parts.push(`Seen: ${c.evidence.join(', ')}`);
  if (c.alternatives?.length) {
    parts.push(`Alternatives: ${c.alternatives.map((a) => a.label).join(', ')}`);
  }
  return parts.length ? parts.join(' · ') : null;
}
