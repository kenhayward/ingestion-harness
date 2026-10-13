import { z } from 'zod';
import { stableJson } from './drafting.js';
import type { JobStatus, ReviewEdit } from './jobs.js';

/**
 * What the reviewer changed in a reference run (handoff RF1), derived from the run's
 * `review_edits` when references are read; nothing is stored. Keys are a field id, or
 * `table[row].column` for a table cell (1-based row, as in review_edits): the output id is the
 * text before `[` (template ids never contain one), so grouping per output needs no lookup.
 */
export const CORRECTION_KINDS = ['corrected', 'entered'] as const;
export const CorrectionSchema = z.object({
  key: z.string(),
  /** corrected: the model proposed a value the reviewer changed; entered: it proposed nothing. */
  kind: z.enum(CORRECTION_KINDS),
  /** The model's value (the first edit's old value). */
  proposed: z.unknown(),
});
export type Correction = z.infer<typeof CorrectionSchema>;

type EditTarget = Pick<ReviewEdit, 'field' | 'table' | 'row' | 'column'>;

export const correctionKey = (e: EditTarget): string =>
  e.field ?? `${e.table ?? ''}[${e.row ?? 0}].${e.column ?? ''}`;

export const correctionOutput = (key: string): string => key.split('[')[0]!;

/** No value: null, undefined, a blank string or an empty list. */
export const emptyValue = (v: unknown): boolean =>
  v === null ||
  v === undefined ||
  (typeof v === 'string' && v.trim() === '') ||
  (Array.isArray(v) && v.length === 0);

/** One correction per key edited: the first edit's old value against the last edit's new one. */
export function correctionsFromEdits(edits: readonly ReviewEdit[]): Correction[] {
  const byKey = new Map<string, { proposed: unknown; final: unknown }>();
  for (const e of [...edits].sort((a, b) => a.id - b.id)) {
    const key = correctionKey(e);
    const seen = byKey.get(key);
    byKey.set(key, { proposed: seen ? seen.proposed : e.oldValue, final: e.newValue });
  }
  return [...byKey].flatMap(([key, { proposed, final }]): Correction[] => {
    if (emptyValue(proposed) && emptyValue(final)) return [];
    if (stableJson(proposed) === stableJson(final)) return [];
    return [
      { key, kind: emptyValue(proposed) ? 'entered' : 'corrected', proposed: proposed ?? null },
    ];
  });
}

/** The review of a reference's source job (`IngestionRepo.listJobReviews`). */
export interface ReviewRecord {
  status: JobStatus;
  reviewer: string | null;
  reviewedAt: string | null;
  edits: readonly ReviewEdit[];
}

/**
 * A saved reference's corrections and who verified it. Null corrections mean unknown: no source
 * job, or the job was re-run (its edits are deleted) or reviewed again after the save, so its
 * edits no longer describe the saved values. `verifiedBy`: the approver, else the last editor.
 */
export function referenceCorrections(
  review: ReviewRecord | null,
  savedAt: string,
): { corrections: Correction[] | null; verifiedBy: string | null } {
  if (
    review === null ||
    review.status !== 'succeeded' ||
    review.reviewedAt === null ||
    review.reviewedAt > savedAt
  ) {
    return { corrections: null, verifiedBy: null };
  }
  const lastEditor = [...review.edits].sort((a, b) => a.id - b.id).at(-1)?.editor ?? null;
  return {
    corrections: correctionsFromEdits(review.edits),
    verifiedBy: review.reviewer ?? lastEditor,
  };
}

export const PROVENANCES = ['model', 'corrected', 'entered'] as const;
export type Provenance = (typeof PROVENANCES)[number];

/** An output's provenance from its own corrections: MODEL ✓, CORRECTED or BY HAND. */
export function outputProvenance(corrections: readonly Correction[]): Provenance {
  if (corrections.length === 0) return 'model';
  return corrections.some((c) => c.kind === 'corrected') ? 'corrected' : 'entered';
}
