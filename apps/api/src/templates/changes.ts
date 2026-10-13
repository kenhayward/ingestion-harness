import {
  describeDefinitionChange,
  type TemplateChange,
  type TemplateChangeInput,
} from '@ih/shared';
import type { TemplateRecord } from './repo.js';

/** Who and what wrote a change, without the words (which come from the definitions). */
export type ChangeOrigin = Pick<TemplateChangeInput, 'source' | 'stage' | 'proposalId' | 'by'>;

export const byHand = (by: string | null): ChangeOrigin => ({
  source: 'hand',
  stage: null,
  proposalId: null,
  by,
});

/**
 * The change log entry for a write from `before` to `after` (TP1); undefined when nothing
 * changed, so an unchanged save or a re-applied proposal logs nothing.
 */
export function draftChange(
  before: unknown,
  after: unknown,
  origin: ChangeOrigin,
  suffix = '',
): TemplateChangeInput | undefined {
  const text = describeDefinitionChange(before, after);
  if (text.count === 0) return undefined;
  return { ...origin, summary: `${text.summary}${suffix}`, diff: text.diff };
}

/** A draft's first entry: started (a new type, the next version) or imported. */
export function startedChange(
  summary: string,
  by: string | null,
  source: 'started' | 'import' = 'started',
): TemplateChangeInput {
  return { source, stage: null, proposalId: null, summary, diff: [], by };
}

/**
 * The overview's "Hand edit" time: the newest hand change of the version. A version with no
 * log at all predates migration 0029, so its last write stands in.
 */
export function handEditedAt(
  changes: readonly TemplateChange[],
  record: Pick<TemplateRecord, 'updatedAt' | 'createdAt'> | null,
): string | null {
  if (changes.length === 0) return record?.updatedAt ?? record?.createdAt ?? null;
  return changes.find((c) => c.source === 'hand')?.at ?? null;
}
