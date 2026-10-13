import { z } from 'zod';
import { stableJson } from './drafting.js';
import type { ReferenceRow } from './evaluation.js';
import type { JobStatus, ReviewEdit } from './jobs.js';
import { outputCoverage } from './template.js';

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

/**
 * A scalar in its comparable form. Review's editor sends every non-list, non-boolean value as a
 * trimmed string and the route stores it raw, so `1234` becomes `"1234"` without a change:
 * strings are trimmed, numeric strings compare as numbers, "true"/"false" as booleans.
 */
const comparable = (v: unknown): unknown => {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (t === 'true') return true;
  if (t === 'false') return false;
  if (t !== '' && /^[+-]?(\d+\.?\d*|\.\d+)$/.test(t) && !/^[+-]?0\d/.test(t)) return Number(t);
  return t;
};

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
    if (stableJson(comparable(proposed)) === stableJson(comparable(final))) return [];
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
 * A run saved as a reference without ever being reviewed (`reviewedAt` null, no edits) is also
 * unknown, although its values are the model's: conservative on purpose, since treating it as
 * "no corrections" is only safe if a retry after the save could be detected.
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

/** References that count in figures: verified for the current outputs, corrections known. */
const knownReferences = (rows: readonly ReferenceRow[]) =>
  rows.flatMap((r) =>
    r.reference !== null && r.reference.outdated.length === 0 && r.reference.corrections !== null
      ? [r.reference.corrections]
      : [],
  );

/**
 * Right first time (handoff §7): of the values in verified references, those the model proposed
 * correctly. One value per output per reference (a table is one value: right when no cell
 * changed); outputs no step fills are `excluded` (nothing proposed them).
 */
export function rightFirstTime(rows: readonly ReferenceRow[], definition: unknown) {
  const coverage = outputCoverage(definition);
  const counted = coverage.outputs.filter((o) => o.steps.length > 0).map((o) => o.id);
  const references = knownReferences(rows);
  const right = references.reduce(
    (sum, corrections) =>
      sum + counted.filter((id) => !corrections.some((c) => correctionOutput(c.key) === id)).length,
    0,
  );
  return {
    right,
    total: references.length * counted.length,
    references: references.length,
    excluded: coverage.uncovered,
  };
}

export interface OutputNeed {
  id: string;
  kind: 'field' | 'table';
  /** References where a value the model proposed was changed. */
  corrected: number;
  /** References where the model proposed nothing and every change was typed in. */
  entered: number;
  /** Some extract step fills it (else the strip links to Steps). */
  hasStep: boolean;
}

/** "Where the draft model needed you": per output, how many references changed it, and how. */
export function outputNeeds(rows: readonly ReferenceRow[], definition: unknown): OutputNeed[] {
  const references = knownReferences(rows);
  return outputCoverage(definition).outputs.map((o) => {
    const kinds = references.map((cs) =>
      outputProvenance(cs.filter((c) => correctionOutput(c.key) === o.id)),
    );
    return {
      id: o.id,
      kind: o.kind,
      corrected: kinds.filter((k) => k === 'corrected').length,
      entered: kinds.filter((k) => k === 'entered').length,
      hasStep: o.steps.length > 0,
    };
  });
}
