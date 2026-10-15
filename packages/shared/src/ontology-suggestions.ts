import { z } from 'zod';

/**
 * Ontology suggestions (survey, ADR 0011 follow-up): which library ontologies to pin as
 * vocabularies, from the survey's candidates. Mirrors worker/src/ingest_worker/ontology_suggest.py;
 * shared fixture packages/shared/test/fixtures/ontology-suggestions.json.
 */

/** A library version offered to the suggestion (the newest ready version of an ontology). */
export const LibraryVersionSchema = z
  .object({
    id: z.string().min(1),
    version: z.number().int().positive(),
    label: z.string(),
    /** Indexed terms (classes, properties, concepts, imported): the tie-break favours fewer. */
    terms: z.number().int().nonnegative(),
  })
  .strict();
export type LibraryVersion = z.infer<typeof LibraryVersionSchema>;

export const SuggestPinSchema = z
  .object({ ontologyId: z.string().min(1), version: z.number().int().positive() })
  .strict();
export type SuggestPin = z.infer<typeof SuggestPinSchema>;

export const SuggestCandidateSchema = z
  .object({ name: z.string(), description: z.string(), kind: z.enum(['field', 'table']) })
  .strict();
export type SuggestCandidate = z.infer<typeof SuggestCandidateSchema>;

/** jobs.params of a `suggest` job (worker: ontology_suggest.SuggestParams). */
export const SuggestParamsSchema = z
  .object({
    surveyProposalId: z.string().min(1),
    candidates: z.array(SuggestCandidateSchema),
    library: z.array(LibraryVersionSchema),
    pinned: z.array(SuggestPinSchema),
    dataPolicy: z.enum(['local', 'external']),
  })
  .strict();
export type SuggestParams = z.infer<typeof SuggestParamsSchema>;

const EvidenceSchema = z.object({
  candidate: z.string(),
  iri: z.string(),
  label: z.string(),
  kind: z.string(),
  via: z.enum(['lexical', 'semantic', 'both']),
  similarity: z.number(),
});

const CoverSchema = z.object({
  ontologyId: z.string(),
  version: z.number().int(),
  label: z.string(),
  covers: z.array(z.string()),
});

export const SuggestionRecordSchema = z.object({
  surveyProposalId: z.string(),
  createdAt: z.string(),
  /** How many candidates were queried. */
  candidates: z.number().int(),
  libraryKey: z.string(),
  /** In pick order (greedy set cover). */
  suggestions: z.array(CoverSchema.extend({ evidence: z.array(EvidenceSchema) })),
  pinned: z.array(CoverSchema),
  /**
   * Ontologies left out that would still add candidates beyond the pins and the suggestions,
   * most added first: `adds` and the `evidence` behind it (both empty in older records).
   */
  alsoMatched: z.array(
    CoverSchema.extend({
      adds: z.array(z.string()).default([]),
      evidence: z.array(EvidenceSchema).default([]),
    }),
  ),
  uncovered: z.array(z.string()),
  notes: z.array(z.string()),
});
export type SuggestionRecord = z.infer<typeof SuggestionRecordSchema>;
export type OntologySuggestion = SuggestionRecord['suggestions'][number];
export type AlsoMatchedOntology = SuggestionRecord['alsoMatched'][number];

export const OntologySuggestionsViewSchema = z.object({
  record: SuggestionRecordSchema.nullable(),
  /** A refresh is queued or running. */
  running: z.boolean(),
  /** The newest refresh failed: its error. */
  failed: z.string().nullable(),
  /** `survey`: from another survey than the current one; `library`: the library changed. */
  stale: z.enum(['library', 'survey']).nullable(),
});
export type OntologySuggestionsView = z.infer<typeof OntologySuggestionsViewSchema>;

/** The library a record was computed against: worker `library_key`, compared to see staleness. */
export function ontologyLibraryKey(
  versions: readonly { id: string; version: number }[],
  embeddingModel: string | null,
): string {
  const ids = [...versions]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.version - b.version))
    .map((v) => `${v.id}@${v.version}`);
  return `${embeddingModel ?? 'lexical'}|${ids.join(',')}`;
}
