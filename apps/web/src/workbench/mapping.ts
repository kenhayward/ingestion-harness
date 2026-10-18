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
