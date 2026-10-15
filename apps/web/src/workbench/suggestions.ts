import type { BriefBody } from '@ih/shared';

/** Whether the brief already pins a suggested ontology as a vocabulary, and at which version. */
export function pinState(
  s: { ontologyId: string; version: number },
  body: BriefBody,
): { kind: 'pinned' } | { kind: 'older'; pinned: number } | { kind: 'none' } {
  const pin = (body.ontologies ?? []).find(
    (o) => o.ontologyId === s.ontologyId && o.role === 'vocabulary',
  );
  if (!pin) return { kind: 'none' };
  return pin.version === s.version ? { kind: 'pinned' } : { kind: 'older', pinned: pin.version };
}

/** The brief with the ontology pinned as a vocabulary at `version` (an earlier pin is moved). */
export function withPin(body: BriefBody, ontologyId: string, version: number): BriefBody {
  const list = body.ontologies ?? [];
  const i = list.findIndex((o) => o.ontologyId === ontologyId && o.role === 'vocabulary');
  const pin = { ontologyId, version, role: 'vocabulary' as const };
  return {
    ...body,
    ontologies: i < 0 ? [...list, pin] : list.map((o, j) => (j === i ? pin : o)),
  };
}

export function staleText(stale: 'library' | 'survey'): string {
  return stale === 'library'
    ? 'The ontology library changed since these suggestions.'
    : 'These suggestions are from an earlier survey.';
}
