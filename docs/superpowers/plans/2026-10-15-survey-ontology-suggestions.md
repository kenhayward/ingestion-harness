# Survey ontology suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Workbench survey suggests which library ontologies to pin as vocabularies (with evidence), and ontology pinning moves from the Brief tab to the Survey tab.

**Architecture:** A worker function (`ontology_suggest.suggest_ontologies`) queries the term index once per survey candidate (one best hit per ontology version, lexical trigram + semantic), then picks a greedy set cover. It runs after the survey's model call (advisory) and in a new project-scoped `suggest` job (Refresh). Both write a `SuggestionRecord` to `ontology-suggestions/{project}/{job}.json`; the API serves the current one with staleness; the Survey tab shows cards with Pin, which writes `brief.ontologies` as today.

**Tech Stack:** Python 3.13 worker (pydantic, psycopg, pg_trgm, pgvector), Fastify/Zod API, React web (Testing Library), Vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-10-15-survey-ontology-suggestions-design.md`

## Global Constraints

- Thresholds and limits (worker, `ontology_suggest.py`): `MIN_LEXICAL = 0.45`, `MIN_SEMANTIC = 0.6`, `MIN_GAIN = 2`, `MAX_SUGGESTIONS = 5`, `MAX_EVIDENCE = 5`, `MAX_ALSO_MATCHED = 5`.
- `libraryKey` = `<embedding model ref or "lexical">|<sorted "id@version", comma-separated>`; identical in TS (`ontologyLibraryKey`) and Python (`library_key`), held by the shared fixture.
- Runs-bucket key: `ontology-suggestions/{project}/{job}.json` (`ontologySuggestionsKey` / `storage.ontology_suggestions_key`).
- Job task `suggest`: project-scoped, no document, `priority = SEGMENT_PRIORITY` (-5), `max_attempts` 3, one per project (new deletes old under `pg_advisory_xact_lock(hashtext(projectId))`), not skipped by `setDataPolicy`.
- Suggestions cover the **vocabulary** role only; nothing is pinned without a click.
- No change to `SurveyBodySchema`, `BriefBodySchema`, `vocabularyOf`, `ontologySelectionKey`, `ontologySelectionChangedAt`, bundles.
- A failure computing suggestions inside a survey job never fails the survey (job event `ontology suggestions failed`, level `warn`).
- Candidate text is embedded only when the embedding model is local or the project's `dataPolicy` is `external`; an external embedding call writes the `external model call` event (`purpose: 'embedding'`).
- UI copy says **recipe** for templates; model names never refs.
- New routes are documented (OpenAPI `tags`, `summary`, `description`, `operationId`, responses) and covered by the access sweep; `npm run openapi` regenerates `docs/openapi.json`.
- Migration `db/migrations/0039_ontology_suggestions.sql`, forward-only.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A survey candidate whose name is empty or only underscores/punctuation → skipped for lexical, still semantic if it has a description, else uncovered; never a crash or a pg error (Task 3 test `test_blank_candidate_names_are_uncovered_not_errors`).
2. An ontology whose newest version is importing or failed but has an older ready version → the library offers the older ready version (Task 6 test `offers the newest ready version when the latest is still importing`).
3. A pin whose version is no longer in the library (deleted) → listed under `pinned` with `covers: []`, suggestions still computed (Task 3 test `test_a_pin_missing_from_the_store_covers_nothing`).
4. A rejected survey proposal newer than the accepted one → not the current survey: no `stale: 'survey'`, POST uses the accepted one (Task 6 test `ignores a rejected survey proposal`).
5. Clicking Pin twice quickly, or Pin while another save runs → one save; buttons disabled while saving (Task 8 test `disables Pin while a pin is saving`).

---

## File structure

| File | Responsibility |
| --- | --- |
| `packages/shared/src/ontology-suggestions.ts` (create) | Zod schemas (`LibraryVersionSchema`, `SuggestParamsSchema`, `SuggestionRecordSchema`, `OntologySuggestionsViewSchema`), `ontologyLibraryKey` |
| `packages/shared/src/storage-keys.ts` | `ontologySuggestionsKey` |
| `packages/shared/test/fixtures/ontology-suggestions.json` (create) | record, params and libraryKey cases for both sides |
| `worker/src/ingest_worker/ontology.py` | `TermHit`, `trigram_similarity`, protocol + Pg `lexical_best`/`semantic_best` |
| `worker/tests/fakes.py` | `MemoryOntologyStore.lexical_best`/`semantic_best` |
| `worker/src/ingest_worker/ontology_suggest.py` (create) | models, `library_key`, `suggest_ontologies`, `run_suggestions`, `run_suggest` |
| `worker/src/ingest_worker/drafting.py` | `DraftParams.library/pinned`; survey hook |
| `worker/src/ingest_worker/main.py` | dispatch `suggest` |
| `worker/src/ingest_worker/storage.py` | `ontology_suggestions_key` |
| `db/migrations/0039_ontology_suggestions.sql` (create) | task check |
| `apps/api/src/repositories/{types,memory,pg}.ts` | `createSuggestJob`, `latestSuggestJob` |
| `apps/api/src/workbench/repo.ts` | memory delete includes suggest jobs |
| `apps/api/src/workbench/suggestions.ts` (create) | `ontologyLibrary`, `currentSurvey`, `suggestionsView` |
| `apps/api/src/routes/workbench-suggestions.ts` (create) | GET/POST routes |
| `apps/api/src/routes/workbench.ts` | survey params, delete prefix, mapping 409 wording |
| `packages/shared/src/overview.ts`, `apps/api/src/workbench/list.ts` | mapping "not used" wording, `LIST_CACHE_VERSION` 7 |
| `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts` | client methods |
| `apps/web/src/workbench/suggestions.ts` (create) | pure helpers (`pinState`, `withPin`, `staleText`) |
| `apps/web/src/workbench/SurveyOntologies.tsx` (create) | the Survey tab's Ontologies section |
| `apps/web/src/workbench/SurveyTab.tsx`, `BriefTab.tsx`, `MappingTab.tsx` | placement, Brief summary line, Mapping link |
| `CLAUDE.md`, `docs/design/rdf-publishing.md`, `docs/openapi.json` | contracts and as-built notes |

---

### Task 1: Shared contract (schemas, key, fixture)

**Files:**
- Create: `packages/shared/src/ontology-suggestions.ts`
- Modify: `packages/shared/src/index.ts`, `packages/shared/src/storage-keys.ts`
- Create: `packages/shared/test/fixtures/ontology-suggestions.json`
- Test: `packages/shared/test/ontology-suggestions.test.ts`

**Interfaces:**
- Produces: `LibraryVersionSchema` (`{id, version, label, terms}`), `SuggestPinSchema` (`{ontologyId, version}`), `SuggestCandidateSchema` (`{name, description, kind: 'field'|'table'}`), `SuggestParamsSchema` (`{surveyProposalId, candidates, library, pinned, dataPolicy}`, strict), `SuggestionRecordSchema`, `OntologySuggestionsViewSchema` (`{record: SuggestionRecord|null, running: boolean, failed: string|null, stale: 'library'|'survey'|null}`), types of each, `ontologyLibraryKey(versions: {id: string; version: number}[], embeddingModel: string | null): string`, `ontologySuggestionsKey(projectId, jobId)`.

- [ ] **Step 1: Write the fixture** `packages/shared/test/fixtures/ontology-suggestions.json`:

```json
{
  "libraryKeys": [
    { "name": "empty, lexical", "versions": [], "model": null, "key": "lexical|" },
    {
      "name": "sorted by id then version",
      "versions": [{ "id": "qudt", "version": 2 }, { "id": "afo", "version": 1 }, { "id": "afo", "version": 3 }],
      "model": "local/nomic",
      "key": "local/nomic|afo@1,afo@3,qudt@2"
    }
  ],
  "params": {
    "surveyProposalId": "11111111-1111-4111-8111-111111111111",
    "candidates": [{ "name": "active_substance", "description": "The substance", "kind": "field" }],
    "library": [{ "id": "idmp", "version": 2, "label": "IDMP-O", "terms": 1200 }],
    "pinned": [{ "ontologyId": "qudt", "version": 1 }],
    "dataPolicy": "local"
  },
  "record": {
    "surveyProposalId": "11111111-1111-4111-8111-111111111111",
    "createdAt": "2026-10-15T10:00:00Z",
    "candidates": 3,
    "libraryKey": "lexical|idmp@2,qudt@1",
    "suggestions": [
      {
        "ontologyId": "idmp",
        "version": 2,
        "label": "IDMP-O",
        "covers": ["active_substance", "strength"],
        "evidence": [
          {
            "candidate": "active_substance",
            "iri": "https://ex.example/idmp#Substance",
            "label": "Substance",
            "kind": "class",
            "via": "lexical",
            "similarity": 0.588
          }
        ]
      }
    ],
    "pinned": [{ "ontologyId": "qudt", "version": 1, "label": "QUDT", "covers": [] }],
    "alsoMatched": [],
    "uncovered": ["batch_number"],
    "notes": ["Retrieval was lexical only: no embedding model is set."]
  }
}
```

- [ ] **Step 2: Write the failing test** `packages/shared/test/ontology-suggestions.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  OntologySuggestionsViewSchema,
  SuggestParamsSchema,
  SuggestionRecordSchema,
  ontologyLibraryKey,
  ontologySuggestionsKey,
} from '../src/index.js';

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/ontology-suggestions.json', import.meta.url), 'utf8'),
) as {
  libraryKeys: { name: string; versions: { id: string; version: number }[]; model: string | null; key: string }[];
  params: unknown;
  record: unknown;
};

describe('ontology suggestions contract', () => {
  it.each(fixture.libraryKeys)('libraryKey: $name', ({ versions, model, key }) => {
    expect(ontologyLibraryKey(versions, model)).toBe(key);
  });

  it('parses the shared params and record', () => {
    expect(SuggestParamsSchema.parse(fixture.params)).toEqual(fixture.params);
    expect(SuggestionRecordSchema.parse(fixture.record)).toEqual(fixture.record);
  });

  it('refuses unknown keys in params', () => {
    expect(SuggestParamsSchema.safeParse({ ...(fixture.params as object), extra: 1 }).success).toBe(false);
  });

  it('has a view with no record', () => {
    expect(
      OntologySuggestionsViewSchema.parse({ record: null, running: false, failed: null, stale: null }),
    ).toEqual({ record: null, running: false, failed: null, stale: null });
  });

  it('keys records per project and job', () => {
    expect(ontologySuggestionsKey('letter', 'job-1')).toBe('ontology-suggestions/letter/job-1.json');
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run packages/shared/test/ontology-suggestions.test.ts`
Expected: FAIL (the exports do not exist).

- [ ] **Step 4: Implement** `packages/shared/src/ontology-suggestions.ts`:

```ts
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
  alsoMatched: z.array(CoverSchema),
  uncovered: z.array(z.string()),
  notes: z.array(z.string()),
});
export type SuggestionRecord = z.infer<typeof SuggestionRecordSchema>;
export type OntologySuggestion = SuggestionRecord['suggestions'][number];

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
```

Add `export * from './ontology-suggestions.js';` to `packages/shared/src/index.ts`, and to `storage-keys.ts` after `graphPreviewKey`:

```ts
/** A survey's or refresh's ontology suggestions (runs bucket, worker draft/suggest tasks). */
export function ontologySuggestionsKey(projectId: string, jobId: string): string {
  return `ontology-suggestions/${projectId}/${jobId}.json`;
}
```

Note: sort by code unit (`<`), not `localeCompare`, so Python's `sorted()` agrees.

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run packages/shared/test/ontology-suggestions.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/shared
git commit -m "Shared: ontology suggestion schemas, library key and storage key"
```

---

### Task 2: Store hits with absolute similarity

**Files:**
- Modify: `worker/src/ingest_worker/ontology.py` (Term area ~line 104, protocol ~line 457, Pg store after `semantic` ~line 960)
- Modify: `worker/tests/fakes.py` (`MemoryOntologyStore`, after `semantic` ~line 446)
- Test: `worker/tests/test_ontology_suggest.py` (create), `worker/tests/test_retrieval.py` (integration test added)

**Interfaces:**
- Produces: `TermHit(ontology_id: str, version: int, term: Term, similarity: float)` (frozen dataclass); `trigram_similarity(a: str, b: str) -> float`; `OntologyStore.lexical_best(versions: list[tuple[str, int]], text: str, kinds: list[str], min_similarity: float) -> list[TermHit]` and `OntologyStore.semantic_best(versions, model_ref: str, vector: list[float], kinds: list[str], min_similarity: float) -> list[TermHit]`: at most one hit per version (its best term), best first; lexical compares the lowercased label and each synonym, whole string, against `text.lower()`.

- [ ] **Step 1: Write the failing tests** in `worker/tests/test_ontology_suggest.py`:

```python
"""Ontology suggestions for the survey (ADR 0011 follow-up)."""

from __future__ import annotations

from pathlib import Path

import pytest

from ingest_worker.ontology import parse_ontology, trigram_similarity

from .fakes import MemoryOntologyStore, fake_vector

RECALL = Path(__file__).parent / "fixtures" / "mapping-recall" / "ontology.ttl"


@pytest.mark.parametrize(
    ("a", "b", "expected"),
    [
        ("substance", "active substance", 10 / 17),
        ("date", "expiry date", 5 / 12),
        ("expiry date", "expiry date", 1.0),
        ("", "anything", 0.0),
        ("Batch", "batch", 1.0),
    ],
)
def test_trigram_similarity_follows_pg_trgm(a: str, b: str, expected: float) -> None:
    assert trigram_similarity(a, b) == pytest.approx(expected, abs=1e-6)


def recall_store() -> MemoryOntologyStore:
    s = MemoryOntologyStore()
    s.saved[("pharma", 1)] = parse_ontology(RECALL.read_bytes(), "text/turtle", "o.ttl")
    return s


def test_lexical_best_gives_one_hit_per_version_above_the_threshold() -> None:
    s = recall_store()
    s.saved[("copy", 1)] = s.saved[("pharma", 1)]
    hits = s.lexical_best([("pharma", 1), ("copy", 1)], "expiry date", ["datatype_property"], 0.45)
    assert {(h.ontology_id, h.version) for h in hits} == {("pharma", 1), ("copy", 1)}
    assert all(h.term.iri == "https://ex.example/pharma#expiryDate" for h in hits)
    assert all(h.similarity >= 0.45 for h in hits)
    assert s.lexical_best([("pharma", 1)], "zzz qqq", ["datatype_property"], 0.45) == []


def test_semantic_best_uses_cosine_similarity() -> None:
    from ingest_worker.embeddings import term_text

    s = recall_store()
    s.store_embeddings(
        "pharma",
        1,
        "emb/fake",
        [
            (t.kind, t.iri, "sha", fake_vector(term_text(t.label, t.alt_labels, t.definition, t.parents)))
            for t in s.embedding_terms("pharma", 1)
        ],
    )
    target = next(t for t in s.embedding_terms("pharma", 1) if t.iri.endswith("#expiryDate"))
    vector = fake_vector(term_text(target.label, target.alt_labels, target.definition, target.parents))
    hits = s.semantic_best([("pharma", 1)], "emb/fake", vector, ["datatype_property"], 0.6)
    assert hits[0].term.iri.endswith("#expiryDate")
    assert hits[0].similarity == pytest.approx(1.0)
```

Note: if `expiryDate` is not a `datatype_property` in `mapping-recall/ontology.ttl`, read the fixture and use its actual kind (the integration test in `test_retrieval.py` already queries it as `datatype_property`).

- [ ] **Step 2: Run them to verify they fail**

Run: `cd worker && uv run pytest tests/test_ontology_suggest.py -q`
Expected: FAIL (`ImportError: cannot import name 'trigram_similarity'`).

- [ ] **Step 3: Implement** in `ontology.py`, after the `Term` dataclass:

```python
@dataclass(frozen=True)
class TermHit:
    """A version's best term for a query, with an absolute similarity (0-1)."""

    ontology_id: str
    version: int
    term: Term
    similarity: float


def _trigrams(text: str) -> set[str]:
    out: set[str] = set()
    for word in re.findall(r"[a-z0-9]+", text.lower()):
        padded = f"  {word} "
        out.update(padded[i : i + 3] for i in range(len(padded) - 2))
    return out


def trigram_similarity(a: str, b: str) -> float:
    """pg_trgm's `similarity`: shared trigrams over all trigrams of the two strings' words
    (each word padded with two spaces before and one after)."""
    x, y = _trigrams(a), _trigrams(b)
    union = x | y
    return len(x & y) / len(union) if union else 0.0
```

(`re` is already imported in `ontology.py`; add `import re` if it is not.)

Add to the `OntologyStore` protocol, after `has_embeddings`:

```python
    def lexical_best(
        self, versions: list[tuple[str, int]], text: str, kinds: list[str], min_similarity: float
    ) -> list[TermHit]:
        """Each version's term of `kinds` whose label or a synonym is most similar to `text`
        (pg_trgm similarity, whole strings), when at least `min_similarity`; best first."""
        ...

    def semantic_best(
        self,
        versions: list[tuple[str, int]],
        model_ref: str,
        vector: list[float],
        kinds: list[str],
        min_similarity: float,
    ) -> list[TermHit]:
        """Each version's term of `kinds` nearest `vector` (1 - cosine distance), when at
        least `min_similarity`; best first."""
        ...
```

`PgOntologyStore`, after `semantic`:

```python
    def lexical_best(
        self, versions: list[tuple[str, int]], text: str, kinds: list[str], min_similarity: float
    ) -> list[TermHit]:
        if not versions or not text.strip():
            return []
        rows = self._conn.execute(
            f"""WITH q AS (SELECT lower(%(q)s) AS text),
                scored AS (
                  SELECT t.ontology_id, t.version, {_READ_COLUMNS},
                         greatest(similarity(lower(t.label), q.text),
                                  coalesce((SELECT max(similarity(lower(a), q.text))
                                              FROM unnest(t.alt_labels) a), 0)) AS sim
                    FROM ontology_terms t
                    JOIN unnest(%(ids)s::text[], %(vs)s::int[]) AS p(id, v)
                      ON t.ontology_id = p.id AND t.version = p.v
                   CROSS JOIN q
                   WHERE t.kind = ANY(%(kinds)s::text[]))
                SELECT DISTINCT ON (ontology_id, version) * FROM scored
                 WHERE sim >= %(min)s
                 ORDER BY ontology_id, version, sim DESC, label, iri""",
            {
                "q": text,
                "ids": [v[0] for v in versions],
                "vs": [v[1] for v in versions],
                "kinds": kinds,
                "min": min_similarity,
            },
        ).fetchall()
        hits = [TermHit(r[0], r[1], _read_term(r[2:]), float(r[-1])) for r in rows]
        return sorted(hits, key=lambda h: (-h.similarity, h.ontology_id, h.version))

    def semantic_best(
        self,
        versions: list[tuple[str, int]],
        model_ref: str,
        vector: list[float],
        kinds: list[str],
        min_similarity: float,
    ) -> list[TermHit]:
        from psycopg import sql

        if not versions or not vector:
            return []
        query = sql.SQL(
            """WITH c AS MATERIALIZED (
                 SELECT t.ontology_id, t.version, {cols},
                        1 - (e.embedding <=> %(vec)s::vector) AS sim
                   FROM ontology_term_embeddings e
                   JOIN ontology_terms t USING (ontology_id, version, kind, iri)
                   JOIN unnest(%(ids)s::text[], %(vs)s::int[]) AS p(id, v)
                     ON e.ontology_id = p.id AND e.version = p.v
                  WHERE e.model_ref = {ref} AND e.dims = {dims}
                    AND e.kind = ANY(%(kinds)s::text[]))
               SELECT DISTINCT ON (ontology_id, version) * FROM c
                WHERE sim >= %(min)s
                ORDER BY ontology_id, version, sim DESC, label, iri"""
        ).format(
            cols=sql.SQL(_READ_COLUMNS),
            ref=sql.Literal(model_ref),
            dims=sql.Literal(len(vector)),
        )
        rows = self._conn.execute(
            query,
            {
                "ids": [v[0] for v in versions],
                "vs": [v[1] for v in versions],
                "kinds": kinds,
                "vec": vector_literal(vector),
                "min": min_similarity,
            },
        ).fetchall()
        hits = [TermHit(r[0], r[1], _read_term(r[2:]), float(r[-1])) for r in rows]
        return sorted(hits, key=lambda h: (-h.similarity, h.ontology_id, h.version))
```

`MemoryOntologyStore` in `fakes.py`, after `semantic` (import `TermHit`, `trigram_similarity` from `ingest_worker.ontology`):

```python
    def lexical_best(
        self, versions: list[tuple[str, int]], text: str, kinds: list[str], min_similarity: float
    ) -> list[TermHit]:
        hits: list[TermHit] = []
        for version in versions:
            scored = [
                (max(trigram_similarity(n, text) for n in [t.label, *t.alt_labels]), t)
                for t in self._terms([version], kinds)
            ]
            scored = [(s, t) for s, t in scored if s >= min_similarity]
            if scored:
                s, t = sorted(scored, key=lambda st: (-st[0], st[1].label, st[1].iri))[0]
                hits.append(TermHit(version[0], version[1], t, s))
        return sorted(hits, key=lambda h: (-h.similarity, h.ontology_id, h.version))

    def semantic_best(
        self,
        versions: list[tuple[str, int]],
        model_ref: str,
        vector: list[float],
        kinds: list[str],
        min_similarity: float,
    ) -> list[TermHit]:
        hits: list[TermHit] = []
        for version in versions:
            best = [
                h for h in self.semantic([version], model_ref, vector, kinds, 1)
            ]
            if not best:
                continue
            stored = self.embeddings[(*version, model_ref)][(best[0].kind, best[0].iri)][1]
            dot = sum(x * y for x, y in zip(vector, stored, strict=True))
            norm = math.sqrt(sum(x * x for x in vector)) * math.sqrt(sum(y * y for y in stored))
            similarity = dot / norm if norm else 0.0
            if similarity >= min_similarity:
                hits.append(TermHit(version[0], version[1], best[0], similarity))
        return sorted(hits, key=lambda h: (-h.similarity, h.ontology_id, h.version))
```

- [ ] **Step 4: Run them to verify they pass**

Run: `cd worker && uv run pytest tests/test_ontology_suggest.py -q`
Expected: PASS.

- [ ] **Step 5: Add the Pg integration test** to `worker/tests/test_retrieval.py` (same setup as `test_pg_lexical_and_semantic_retrieval`):

```python
@pytest.mark.integration
def test_pg_best_hits_carry_similarities() -> None:
    url = os.environ.get("IH_TEST_DATABASE_URL")
    if not url:
        pytest.skip("IH_TEST_DATABASE_URL not set")
    import psycopg

    from ingest_worker.ontology import PgOntologyStore, trigram_similarity

    conn = psycopg.connect(url, autocommit=True)
    conn.execute("DELETE FROM ontologies WHERE id = 'pharma-best'")
    conn.execute("INSERT INTO ontologies (id, label) VALUES ('pharma-best', 'P')")
    conn.execute(
        """INSERT INTO ontology_versions (ontology_id, version, file_name, media_type, sha256, bytes)
           VALUES ('pharma-best', 1, 'p.ttl', 'text/turtle', 'abc', 10)"""
    )
    pg = PgOntologyStore(conn)
    pg.save("pharma-best", 1, parse_ontology((FIXTURE / "ontology.ttl").read_bytes(), "text/turtle", "o.ttl"))
    hits = pg.lexical_best([("pharma-best", 1)], "expiry date", ["datatype_property"], 0.45)
    assert [h.term.iri for h in hits] == ["https://ex.example/pharma#expiryDate"]
    # pg_trgm and the Python twin agree (the memory store relies on it).
    assert hits[0].similarity == pytest.approx(
        max(trigram_similarity(n, "expiry date") for n in [hits[0].term.label, *hits[0].term.alt_labels]),
        abs=1e-3,
    )
    assert pg.lexical_best([("pharma-best", 1)], "zzz", ["datatype_property"], 0.45) == []
```

Run: `cd worker && uv run pytest tests/test_retrieval.py -q -m integration` (with `IH_TEST_DATABASE_URL` set to a throwaway pgvector database; otherwise it skips).
Expected: PASS (or SKIP without the variable; run it against `ih-test-pg` per CLAUDE.md before the final review).

- [ ] **Step 6: Lint, types, commit**

Run: `npm run worker:lint`
Expected: clean.

```bash
git add worker
git commit -m "Worker: one best term per ontology version, with an absolute similarity"
```

---

### Task 3: `suggest_ontologies` (set cover) and its models

**Files:**
- Create: `worker/src/ingest_worker/ontology_suggest.py`
- Modify: `worker/src/ingest_worker/storage.py` (`ontology_suggestions_key`)
- Test: `worker/tests/test_ontology_suggest.py` (extend), `worker/tests/fixtures/ontology-suggest/` (create: three small Turtle ontologies)

**Interfaces:**
- Consumes: `TermHit`, `OntologyStore.lexical_best/semantic_best` (Task 2); `CLASS_KINDS`, `PROPERTY_KINDS` from `mapping_stage`.
- Produces:
  - Pydantic models (camelCase aliases, `extra="forbid"`): `LibraryVersion(id, version, label, terms)`, `SuggestPin(ontology_id 'ontologyId', version)`, `SuggestCandidate(name, description, kind)` (`extra="ignore"`: survey candidates also carry `where`, `seenIn`), `SuggestParams(survey_proposal_id, candidates, library, pinned, data_policy)`, `SuggestionRecord` (mirrors `SuggestionRecordSchema`).
  - `library_key(versions: list[tuple[str, int]], model_ref: str | None) -> str`.
  - `suggest_ontologies(store, candidates: list[SuggestCandidate], library: list[LibraryVersion], pinned: list[SuggestPin], *, vectors: list[list[float]] | None, model_ref: str | None) -> dict[str, Any]` returning the record's `candidates`, `suggestions`, `pinned`, `alsoMatched`, `uncovered` (the caller adds `surveyProposalId`, `createdAt`, `libraryKey`, `notes`).
  - `storage.ontology_suggestions_key(project_id, job_id) -> str`.

- [ ] **Step 1: Create the fixture ontologies** in `worker/tests/fixtures/ontology-suggest/`:

`domain.ttl` (a domain ontology covering three candidates):

```turtle
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix d: <https://ex.example/domain#> .
<https://ex.example/domain> a owl:Ontology .
d:ActiveSubstance a owl:Class ; rdfs:label "Active substance" .
d:batchNumber a owl:DatatypeProperty ; rdfs:label "batch number" .
d:expiryDate a owl:DatatypeProperty ; rdfs:label "expiry date" .
```

`merged.ttl` (the same terms plus one more: a merged copy is bigger):

```turtle
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix d: <https://ex.example/merged#> .
<https://ex.example/merged> a owl:Ontology .
d:ActiveSubstance a owl:Class ; rdfs:label "Active substance" .
d:batchNumber a owl:DatatypeProperty ; rdfs:label "batch number" .
d:expiryDate a owl:DatatypeProperty ; rdfs:label "expiry date" .
d:Organisation a owl:Class ; rdfs:label "Organisation" .
```

`units.ttl` (covers two unit candidates):

```turtle
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix u: <https://ex.example/units#> .
<https://ex.example/units> a owl:Ontology .
u:unitOfMeasure a owl:DatatypeProperty ; rdfs:label "unit of measure" .
u:strength a owl:DatatypeProperty ; rdfs:label "strength" .
u:date a owl:DatatypeProperty ; rdfs:label "date" .
```

- [ ] **Step 2: Write the failing tests** (append to `worker/tests/test_ontology_suggest.py`):

```python
import json
from typing import Any

from ingest_worker.config import REPO_ROOT
from ingest_worker.ontology_suggest import (
    LibraryVersion,
    SuggestCandidate,
    SuggestionRecord,
    SuggestParams,
    SuggestPin,
    library_key,
    suggest_ontologies,
)

SUGGEST = Path(__file__).parent / "fixtures" / "ontology-suggest"
SHARED = json.loads(
    (REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "ontology-suggestions.json").read_text(
        encoding="utf-8"
    )
)


def library_store() -> tuple[MemoryOntologyStore, list[LibraryVersion]]:
    s = MemoryOntologyStore()
    library = []
    for name, terms in [("domain", 3), ("merged", 4), ("units", 3)]:
        s.saved[(name, 1)] = parse_ontology((SUGGEST / f"{name}.ttl").read_bytes(), "text/turtle", f"{name}.ttl")
        library.append(LibraryVersion(id=name, version=1, label=name.title(), terms=terms))
    return s, library


def cand(name: str, kind: str = "field", description: str = "") -> SuggestCandidate:
    return SuggestCandidate(name=name, description=description, kind=kind)  # type: ignore[arg-type]


CANDIDATES = [
    cand("active_substance", "table"),
    cand("batch_number"),
    cand("expiry_date"),
    cand("unit_of_measure"),
    cand("strength"),
    cand("signatory_name"),
]


@pytest.mark.parametrize("case", SHARED["libraryKeys"], ids=[c["name"] for c in SHARED["libraryKeys"]])
def test_library_key_matches_the_shared_fixture(case: dict[str, Any]) -> None:
    versions = [(v["id"], v["version"]) for v in case["versions"]]
    assert library_key(versions, case["model"]) == case["key"]


def test_shared_params_and_record_parse() -> None:
    assert SuggestParams.model_validate(SHARED["params"]).model_dump(by_alias=True) == SHARED["params"]
    assert SuggestionRecord.model_validate(SHARED["record"]).model_dump(by_alias=True) == SHARED["record"]


def test_set_cover_picks_the_module_then_units_and_lists_the_merged_copy() -> None:
    s, library = library_store()
    out = suggest_ontologies(s, CANDIDATES, library, [], vectors=None, model_ref=None)
    assert [x["ontologyId"] for x in out["suggestions"]] == ["domain", "units"]
    assert out["suggestions"][0]["covers"] == ["active_substance", "batch_number", "expiry_date"]
    assert [x["ontologyId"] for x in out["alsoMatched"]] == ["merged"]
    assert out["uncovered"] == ["signatory_name"]
    ev = out["suggestions"][0]["evidence"][0]
    assert ev == {
        "candidate": "active_substance",
        "iri": "https://ex.example/domain#ActiveSubstance",
        "label": "Active substance",
        "kind": "class",
        "via": "lexical",
        "similarity": 1.0,
    }


def test_a_generic_label_does_not_cover_a_longer_name() -> None:
    s, library = library_store()
    out = suggest_ontologies(s, [cand("expiry_date")], library[2:], [], vectors=None, model_ref=None)
    # units' "date" vs "expiry date" is 5/12 < MIN_LEXICAL.
    assert out["suggestions"] == [] and out["uncovered"] == ["expiry_date"]


def test_pins_count_first_and_are_never_suggested() -> None:
    s, library = library_store()
    out = suggest_ontologies(
        s, CANDIDATES, library, [SuggestPin(ontology_id="domain", version=1)], vectors=None, model_ref=None
    )
    assert out["pinned"] == [
        {"ontologyId": "domain", "version": 1, "label": "Domain", "covers": ["active_substance", "batch_number", "expiry_date"]}
    ]
    assert [x["ontologyId"] for x in out["suggestions"]] == ["units"]
    # merged adds nothing beyond the pin: not even "also matched" (it covers only pinned ground).
    assert out["alsoMatched"] == []


def test_a_pin_missing_from_the_store_covers_nothing() -> None:
    s, library = library_store()
    out = suggest_ontologies(
        s, CANDIDATES, library, [SuggestPin(ontology_id="gone", version=4)], vectors=None, model_ref=None
    )
    assert out["pinned"] == [{"ontologyId": "gone", "version": 4, "label": "gone", "covers": []}]
    assert [x["ontologyId"] for x in out["suggestions"]] == ["domain", "units"]


def test_min_gain_stops_a_single_candidate_ontology() -> None:
    s, library = library_store()
    out = suggest_ontologies(s, [cand("strength")], library, [], vectors=None, model_ref=None)
    assert out["suggestions"] == [] and out["uncovered"] == ["strength"]


def test_blank_candidate_names_are_uncovered_not_errors() -> None:
    s, library = library_store()
    out = suggest_ontologies(s, [cand(""), cand("___"), *CANDIDATES[:3]], library, [], vectors=None, model_ref=None)
    assert out["candidates"] == 5
    assert "" in out["uncovered"] and "___" in out["uncovered"]


def test_semantic_hits_count_and_say_how_they_were_found() -> None:
    from ingest_worker.embeddings import term_text

    s, library = library_store()
    for name in ("domain", "units"):
        s.store_embeddings(
            name, 1, "emb/fake",
            [(t.kind, t.iri, "sha", fake_vector(term_text(t.label, t.alt_labels, t.definition, t.parents)))
             for t in s.embedding_terms(name, 1)],
        )  # fmt: skip
    # "signatory" shares no trigram-similar label, but its vector equals the strength term's.
    candidates = [cand("signatory", description="strength"), cand("strength"), cand("unit_of_measure")]
    vectors = [fake_vector("strength"), fake_vector("strength"), fake_vector("unit of measure")]
    out = suggest_ontologies(s, candidates, library[:1] + library[2:], [], vectors=vectors, model_ref="emb/fake")
    units = next(x for x in out["suggestions"] if x["ontologyId"] == "units")
    assert "signatory" in units["covers"]
    vias = {e["candidate"]: e["via"] for e in units["evidence"]}
    assert vias["signatory"] == "semantic" and vias["strength"] == "both"
```

Note on the last test: `fake_vector("strength")` must be close to the stored vector of `u:strength` (whose `term_text` is "strength" plus nothing else). If `term_text` adds words that lower the cosine under 0.6, compute the candidate vectors with `term_text(...)` of that term instead, keeping the test's intent: a semantic-only hit covers a candidate and an IRI found both ways reads `both`.

- [ ] **Step 3: Run them to verify they fail**

Run: `cd worker && uv run pytest tests/test_ontology_suggest.py -q`
Expected: FAIL (`ModuleNotFoundError: ingest_worker.ontology_suggest`).

- [ ] **Step 4: Implement** `worker/src/ingest_worker/ontology_suggest.py`:

```python
"""Ontology suggestions for the Workbench survey (ADR 0011 follow-up; spec
docs/superpowers/specs/2026-10-15-survey-ontology-suggestions-design.md).

Each survey candidate is looked up in the term index of every library version: lexically (its
name, pg_trgm similarity against labels and synonyms) and, when allowed, semantically (its name
and description, cosine against the term embeddings). A candidate is covered by an ontology when
one of its terms clears an absolute threshold. A greedy set cover then picks the few ontologies
that cover most candidates, starting from the brief's pins. Mirrors
packages/shared/src/ontology-suggestions.ts.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from .mapping_stage import CLASS_KINDS, PROPERTY_KINDS

if TYPE_CHECKING:
    from .ontology import OntologyStore, TermHit

MIN_LEXICAL = 0.45
MIN_SEMANTIC = 0.6
MIN_GAIN = 2
MAX_SUGGESTIONS = 5
MAX_EVIDENCE = 5
MAX_ALSO_MATCHED = 5

_MODEL = ConfigDict(extra="forbid", populate_by_name=True)


class LibraryVersion(BaseModel):
    model_config = _MODEL

    id: str = Field(min_length=1)
    version: int = Field(gt=0)
    label: str
    terms: int = Field(ge=0)


class SuggestPin(BaseModel):
    model_config = _MODEL

    ontology_id: str = Field(alias="ontologyId", min_length=1)
    version: int = Field(gt=0)


class SuggestCandidate(BaseModel):
    #: Survey candidates also carry `where` and `seenIn`; only these three are read.
    model_config = ConfigDict(extra="ignore")

    name: str
    description: str
    kind: Literal["field", "table"]


class SuggestParams(BaseModel):
    """jobs.params of a `suggest` job (TS SuggestParamsSchema)."""

    model_config = _MODEL

    survey_proposal_id: str = Field(alias="surveyProposalId", min_length=1)
    candidates: list[SuggestCandidate]
    library: list[LibraryVersion]
    pinned: list[SuggestPin]
    data_policy: Literal["local", "external"] = Field(alias="dataPolicy")


class Evidence(BaseModel):
    model_config = _MODEL

    candidate: str
    iri: str
    label: str
    kind: str
    via: Literal["lexical", "semantic", "both"]
    similarity: float


class Cover(BaseModel):
    model_config = _MODEL

    ontology_id: str = Field(alias="ontologyId")
    version: int
    label: str
    covers: list[str]


class Suggestion(Cover):
    evidence: list[Evidence]


class SuggestionRecord(BaseModel):
    """What a survey or refresh writes (TS SuggestionRecordSchema)."""

    model_config = _MODEL

    survey_proposal_id: str = Field(alias="surveyProposalId")
    created_at: str = Field(alias="createdAt")
    candidates: int
    library_key: str = Field(alias="libraryKey")
    suggestions: list[Suggestion]
    pinned: list[Cover]
    also_matched: list[Cover] = Field(alias="alsoMatched")
    uncovered: list[str]
    notes: list[str]


def library_key(versions: list[tuple[str, int]], model_ref: str | None) -> str:
    """TS ontologyLibraryKey: the embedding model, then the sorted id@version list."""
    ids = ",".join(f"{i}@{v}" for i, v in sorted(versions))
    return f"{model_ref or 'lexical'}|{ids}"


def lexical_query(name: str) -> str:
    """`active_substance` -> `active substance`; blank when the name has no letters or digits."""
    return " ".join(re.findall(r"[A-Za-z0-9]+", name.replace("_", " ")))


def semantic_query(c: SuggestCandidate) -> str:
    return f"{lexical_query(c.name)}: {c.description}".strip(" :")


@dataclass
class _Hit:
    term_iri: str
    label: str
    kind: str
    similarity: float
    via: set[str] = field(default_factory=set)


def _kinds(c: SuggestCandidate) -> list[str]:
    return list(CLASS_KINDS) if c.kind == "table" else [*PROPERTY_KINDS, *CLASS_KINDS]


def _merge(into: dict[tuple[str, int], _Hit], hits: list[TermHit], via: str) -> None:
    for h in hits:
        key = (h.ontology_id, h.version)
        old = into.get(key)
        if old is not None and old.term_iri == h.term.iri:
            old.via.add(via)
            old.similarity = max(old.similarity, h.similarity)
        elif old is None or h.similarity > old.similarity:
            into[key] = _Hit(h.term.iri, h.term.label, h.term.kind, h.similarity, {via})


def suggest_ontologies(
    store: OntologyStore,
    candidates: list[SuggestCandidate],
    library: list[LibraryVersion],
    pinned: list[SuggestPin],
    *,
    vectors: list[list[float]] | None,
    model_ref: str | None,
) -> dict[str, Any]:
    pins = [(p.ontology_id, p.version) for p in pinned]
    queried = list(dict.fromkeys([(v.id, v.version) for v in library] + pins))
    labels = {(v.id, v.version): v.label for v in library}
    sizes = {(v.id, v.version): v.terms for v in library}

    # hits[i][version] = candidate i's best term in that version.
    hits: list[dict[tuple[str, int], _Hit]] = []
    for i, c in enumerate(candidates):
        found: dict[tuple[str, int], _Hit] = {}
        text = lexical_query(c.name)
        if text:
            _merge(found, store.lexical_best(queried, text, _kinds(c), MIN_LEXICAL), "lexical")
        if vectors is not None and model_ref is not None and vectors[i]:
            _merge(
                found,
                store.semantic_best(queried, model_ref, vectors[i], _kinds(c), MIN_SEMANTIC),
                "semantic",
            )
        hits.append(found)

    cover = {v: {i for i, h in enumerate(hits) if v in h} for v in queried}
    covered: set[int] = set().union(*(cover[p] for p in pins)) if pins else set()
    chosen: list[tuple[str, int]] = []
    pool = sorted(v for v in queried if v not in pins)
    while len(chosen) < MAX_SUGGESTIONS:

        def rank(v: tuple[str, int]) -> tuple[int, float, int]:
            gain = cover[v] - covered
            return (len(gain), sum(hits[i][v].similarity for i in gain), -sizes.get(v, 0))

        best = max((v for v in pool if v not in chosen), key=rank, default=None)
        if best is None or len(cover[best] - covered) < MIN_GAIN:
            break
        chosen.append(best)
        covered |= cover[best]

    names = [c.name for c in candidates]

    def entry(v: tuple[str, int]) -> dict[str, Any]:
        return {
            "ontologyId": v[0],
            "version": v[1],
            "label": labels.get(v, v[0]),
            "covers": [names[i] for i in sorted(cover[v])],
        }

    def evidence(v: tuple[str, int]) -> list[dict[str, Any]]:
        out = []
        for i in sorted(cover[v])[:MAX_EVIDENCE]:
            h = hits[i][v]
            via = "both" if len(h.via) == 2 else next(iter(h.via))
            out.append(
                {
                    "candidate": names[i],
                    "iri": h.term_iri,
                    "label": h.label,
                    "kind": h.kind,
                    "via": via,
                    "similarity": round(h.similarity, 3),
                }
            )
        return out

    pinned_cover: set[int] = set().union(*(cover[p] for p in pins)) if pins else set()
    also = sorted(
        (
            v
            for v in pool
            if v not in chosen and len(cover[v] - pinned_cover) >= MIN_GAIN
        ),
        key=lambda v: (-len(cover[v]), v),
    )[:MAX_ALSO_MATCHED]
    return {
        "candidates": len(candidates),
        "suggestions": [{**entry(v), "evidence": evidence(v)} for v in chosen],
        "pinned": [entry(p) for p in pins],
        "alsoMatched": [entry(v) for v in also],
        "uncovered": [names[i] for i in range(len(candidates)) if i not in covered],
    }
```

Add to `storage.py` after `graph_preview_key`:

```python
def ontology_suggestions_key(project_id: str, job_id: str) -> str:
    """A survey's or refresh's ontology suggestions (runs bucket; TS ontologySuggestionsKey)."""
    return f"ontology-suggestions/{project_id}/{job_id}.json"
```

Check the `alsoMatched` rule against the tests: with no pins, `merged` covers 3 (all already covered by `domain`, but `cover[v] - pinned_cover` = 3 ≥ 2) so it is listed; with `domain` pinned, `merged`'s coverage minus the pins is empty, so it is not listed — as the tests expect.

- [ ] **Step 5: Run them to verify they pass**

Run: `cd worker && uv run pytest tests/test_ontology_suggest.py -q`
Expected: PASS. If the module/merged tie-break picks `merged` (equal gain and similarity), check `rank`'s `-sizes` term: `domain` has 3 terms, `merged` 4.

- [ ] **Step 6: Lint, types, commit**

Run: `npm run worker:lint`
Expected: clean.

```bash
git add worker
git commit -m "Worker: suggest ontologies from survey candidates by greedy set cover"
```

---

### Task 4: Run suggestions in survey jobs and `suggest` jobs; migration 0039

**Files:**
- Modify: `worker/src/ingest_worker/ontology_suggest.py` (add `run_suggestions`, `run_suggest`)
- Modify: `worker/src/ingest_worker/drafting.py` (`DraftParams` ~line 240; survey hook ~line 378)
- Modify: `worker/src/ingest_worker/main.py` (dispatch, next to `graph`)
- Create: `db/migrations/0039_ontology_suggestions.sql`
- Test: `worker/tests/test_ontology_suggest.py` (job tests), `worker/tests/test_drafting.py` (survey hook)

**Interfaces:**
- Consumes: `suggest_ontologies`, `library_key`, models (Task 3); `storage.ontology_suggestions_key`.
- Produces:
  - `run_suggestions(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, *, survey_proposal_id: str, candidates: list[SuggestCandidate], library: list[LibraryVersion], pinned: list[SuggestPin], data_policy: str, stage: str) -> dict[str, Any]` — embeds when allowed, computes, writes and returns the record.
  - `run_suggest(job, deps, queue) -> dict[str, Any]` — the `suggest` task.
  - `DraftParams.library: list[LibraryVersion] = []`, `DraftParams.pinned: list[SuggestPin] = []`.
  - Event names: `ontology suggestions failed` (warn, `{"error": str}`), `external model call` (`{"stage", "purpose": "embedding", "model", "candidates": n}`).

- [ ] **Step 1: Write the failing tests** (append to `worker/tests/test_ontology_suggest.py`):

```python
from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.storage import MemoryObjectStore, ontology_suggestions_key

from .fakes import FakeProvider, FakeQueue

LIBRARY = [
    {"id": "domain", "version": 1, "label": "Domain", "terms": 3},
    {"id": "units", "version": 1, "label": "Units", "terms": 3},
]
JOB_CANDIDATES = [
    {"name": "active_substance", "description": "", "kind": "table"},
    {"name": "batch_number", "description": "", "kind": "field"},
    {"name": "expiry_date", "description": "", "kind": "field"},
]


def suggest_deps(embedder: str | None = None) -> tuple[FakeProvider, MemoryObjectStore, PipelineDeps]:
    s, _ = library_store()
    emb = FakeProvider("emb")
    store = MemoryObjectStore()
    configs = {"emb": ProviderConfig(name="emb", kind="openai-chat", location=embedder or "local")}  # type: ignore[arg-type]
    deps = PipelineDeps(
        store=store,
        specs={},  # type: ignore[arg-type]
        models=ModelRegistry({"emb": emb}, configs, {}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        ontologies=s,
        embedding_model="emb/nomic" if embedder else None,
    )
    if embedder:
        from ingest_worker.embeddings import term_text

        s.store_embeddings(
            "domain", 1, "emb/nomic",
            [(t.kind, t.iri, "sha", fake_vector(term_text(t.label, t.alt_labels, t.definition, t.parents)))
             for t in s.embedding_terms("domain", 1)],
        )  # fmt: skip
    return emb, store, deps


def suggest_job(**params: Any) -> ClaimedJob:
    base = {
        "surveyProposalId": "survey-1",
        "candidates": JOB_CANDIDATES,
        "library": LIBRARY,
        "pinned": [],
        "dataPolicy": "local",
    }
    return ClaimedJob(
        id="job-s", document_id="", spec_id="letter", spec_version=0, bucket="", object_key="",
        model_override=None, attempts=1, max_attempts=3, task="suggest", test=True,
        project_id="letter", params={**base, **params},
    )  # fmt: skip


def test_suggest_job_writes_the_record() -> None:
    _, store, deps = suggest_deps()
    queue = FakeQueue(jobs=[suggest_job()])
    run_once(queue, deps, "w1")
    assert queue.completed
    record = SuggestionRecord.model_validate(
        json.loads(store.get("runs", ontology_suggestions_key("letter", "job-s")))
    )
    assert record.survey_proposal_id == "survey-1"
    assert record.library_key == "lexical|domain@1,units@1"
    assert [s.ontology_id for s in record.suggestions] == ["domain"]
    assert record.notes == ["Retrieval was lexical only: no embedding model is set."]


def test_a_local_project_never_embeds_with_an_external_model() -> None:
    emb, store, deps = suggest_deps(embedder="external")
    queue = FakeQueue(jobs=[suggest_job()])
    run_once(queue, deps, "w1")
    assert emb.embed_calls == []
    record = json.loads(store.get("runs", ontology_suggestions_key("letter", "job-s")))
    assert any("may only use local models" in n for n in record["notes"])


def test_an_external_project_embeds_and_logs_the_call() -> None:
    emb, _, deps = suggest_deps(embedder="external")
    queue = FakeQueue(jobs=[suggest_job(dataPolicy="external")])
    run_once(queue, deps, "w1")
    assert emb.embed_calls
    assert any(e[2] == "external model call" and e[3]["purpose"] == "embedding" for e in queue.events)


def test_invalid_suggest_params_need_review() -> None:
    _, _, deps = suggest_deps()
    queue = FakeQueue(jobs=[suggest_job(extra=1)])
    run_once(queue, deps, "w1")
    assert queue.needs_review
```

Note: `FakeQueue`'s attribute names (`completed`, `needs_review`, `events` and the event tuple layout) and `PipelineDeps`' required fields must match `worker/tests/fakes.py` / `pipeline.py`; read them first and adjust the assertions' access, not their meaning.

Append to `worker/tests/test_drafting.py`:

```python
def test_survey_job_also_writes_ontology_suggestions(fixture_specs_dir: Path) -> None:
    from ingest_worker.storage import ontology_suggestions_key

    from .fakes import MemoryOntologyStore
    from .test_ontology_suggest import library_store

    provider, store, deps = make(fixture_specs_dir)
    ontologies, _ = library_store()
    deps = dataclasses.replace(deps, ontologies=ontologies)
    body = {**SURVEY_BODY, "candidates": [
        {"name": "active_substance", "description": "", "where": "", "kind": "table", "seenIn": {"n": 1, "of": 1}},
        {"name": "batch_number", "description": "", "where": "", "kind": "field", "seenIn": {"n": 1, "of": 1}},
    ]}  # fmt: skip
    provider.responses = [body]
    library = [{"id": "domain", "version": 1, "label": "Domain", "terms": 3}]
    queue = FakeQueue(jobs=[draft_job(library=library, pinned=[])])
    run_once(queue, deps, "w1")
    assert queue.completed
    record = json.loads(store.get("runs", ontology_suggestions_key("letter", "job-d")))
    assert record["surveyProposalId"] == "job-d"
    assert [s["ontologyId"] for s in record["suggestions"]] == ["domain"]
    assert isinstance(ontologies, MemoryOntologyStore)


def test_failed_suggestions_never_fail_the_survey(fixture_specs_dir: Path) -> None:
    from .test_ontology_suggest import library_store

    provider, store, deps = make(fixture_specs_dir)
    ontologies, _ = library_store()
    ontologies.lexical_best = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("index down"))  # type: ignore[method-assign]
    deps = dataclasses.replace(deps, ontologies=ontologies)
    provider.responses = [SURVEY_BODY]
    library = [{"id": "domain", "version": 1, "label": "Domain", "terms": 3}]
    queue = FakeQueue(jobs=[draft_job(library=library)])
    run_once(queue, deps, "w1")
    assert queue.completed
    assert store.get("runs", drafting_key("letter", "job-d"))
    assert any(e[2] == "ontology suggestions failed" for e in queue.events)


def test_survey_without_a_library_writes_no_suggestions(fixture_specs_dir: Path) -> None:
    from ingest_worker.storage import ontology_suggestions_key

    provider, store, deps = make(fixture_specs_dir)
    provider.responses = [SURVEY_BODY]
    queue = FakeQueue(jobs=[draft_job()])
    run_once(queue, deps, "w1")
    assert store.get_optional("runs", ontology_suggestions_key("letter", "job-d")) is None
```

(Add `import dataclasses` at the top of `test_drafting.py` if missing; if `PipelineDeps` is not a dataclass, build it with `ontologies=` the way `test_mapping_stage.make` does.)

- [ ] **Step 2: Run them to verify they fail**

Run: `cd worker && uv run pytest tests/test_ontology_suggest.py tests/test_drafting.py -q -k "suggest or library"`
Expected: FAIL (`suggest` task unknown; `DraftParams` refuses `library`).

- [ ] **Step 3: Implement.** Append to `ontology_suggest.py`:

```python
def _vectors(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    candidates: list[SuggestCandidate],
    library: list[tuple[str, int]],
    data_policy: str,
    stage: str,
    notes: list[str],
) -> tuple[list[list[float]] | None, str | None]:
    """The candidates' embeddings and the model, or (None, None) with a note: lexical only."""
    ref = deps.embedding_model
    if ref is None:
        notes.append("Retrieval was lexical only: no embedding model is set.")
        return None, None
    try:
        provider, model_id = deps.models.resolve_embedding(ref)
    except ModelResolutionError as exc:
        notes.append(f"Retrieval was lexical only: {exc}.")
        return None, None
    external = deps.models.location(provider.name) == "external"
    if external and data_policy == "local":
        notes.append(
            f"Retrieval was lexical only: the embedding model {ref} is external and this "
            "project may only use local models."
        )
        return None, None
    store = deps.ontologies
    if store is None or not store.has_embeddings(library, ref):
        notes.append(f"Retrieval was lexical only: no ontology is embedded for {ref} yet.")
        return None, None
    try:
        vectors = provider.embed(model_id, [semantic_query(c) for c in candidates])
    except Exception as exc:  # an outage costs the semantic half, never the suggestions
        notes.append(f"Retrieval was lexical only: the embedding model failed: {exc}.")
        return None, None
    if external:
        queue.event(
            job.id,
            "info",
            "external model call",
            {"stage": stage, "purpose": "embedding", "model": ref, "candidates": len(candidates)},
        )
    return vectors, ref


def run_suggestions(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    *,
    survey_proposal_id: str,
    candidates: list[SuggestCandidate],
    library: list[LibraryVersion],
    pinned: list[SuggestPin],
    data_policy: str,
    stage: str,
) -> dict[str, Any]:
    """Compute and write a suggestion record (runs bucket) for this job; returns it."""
    store = deps.ontologies
    if store is None:
        raise DocumentError("ontology suggestions need the ontology library")
    if job.project_id is None:
        raise DocumentError("ontology suggestions without a project")
    versions = [(v.id, v.version) for v in library]
    notes: list[str] = []
    vectors, ref = _vectors(job, deps, queue, candidates, versions, data_policy, stage, notes)
    body = suggest_ontologies(store, candidates, library, pinned, vectors=vectors, model_ref=ref)
    record = SuggestionRecord.model_validate(
        {
            "surveyProposalId": survey_proposal_id,
            "createdAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "libraryKey": library_key(versions, deps.embedding_model),
            "notes": notes,
            **body,
        }
    ).model_dump(by_alias=True)
    check_cancelled(job, queue)
    deps.store.put(
        deps.buckets.runs,
        ontology_suggestions_key(job.project_id, job.id),
        json.dumps(record).encode(),
        "application/json",
    )
    return record


def run_suggest(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> dict[str, Any]:
    """The `suggest` task: Refresh suggestions on the Survey tab."""
    try:
        params = SuggestParams.model_validate(job.params or {})
    except ValidationError as exc:
        raise DocumentError(f"invalid suggestion parameters: {exc}") from exc
    return run_suggestions(
        job,
        deps,
        queue,
        survey_proposal_id=params.survey_proposal_id,
        candidates=params.candidates,
        library=params.library,
        pinned=params.pinned,
        data_policy=params.data_policy,
        stage="suggest",
    )
```

Imports for `ontology_suggest.py` (top level; `pipeline`, `queue`, `storage` do not import `drafting`): `json`, `from datetime import UTC, datetime`, `from pydantic import ValidationError`, `from .llm.registry import ModelResolutionError` (use the module `mapping_stage.py` imports it from), `from .pipeline import DocumentError, PipelineDeps, check_cancelled`, `from .queue import ClaimedJob, JobQueue`, `from .storage import ontology_suggestions_key`.

Note on `library_key`: the key uses the configured `deps.embedding_model` (as the API does), not whether this run could embed, so a policy-forced lexical run is not shown as stale.

In `drafting.py`, `DraftParams` gains:

```python
    #: Survey (ontology suggestions): the library's newest ready versions and the brief's
    #: vocabulary pins; empty: no suggestions.
    library: list[LibraryVersion] = Field(default_factory=list)
    pinned: list[SuggestPin] = Field(default_factory=list)
```

and after `body = clamp_seen_in(body, len(samples))`:

```python
    if stage.id == "survey" and params.library:
        try:
            run_suggestions(
                job,
                deps,
                queue,
                survey_proposal_id=job.id,
                candidates=[SuggestCandidate.model_validate(c) for c in body["candidates"]],
                library=params.library,
                pinned=params.pinned,
                data_policy=params.data_policy,
                stage="survey",
            )
        except JobCancelled:
            raise
        except Exception as exc:  # advisory: the survey stands without suggestions
            log.warning("job %s: ontology suggestions failed: %s", job.id, exc)
            queue.event(job.id, "warn", "ontology suggestions failed", {"error": str(exc)})
```

(Import `LibraryVersion`, `SuggestCandidate`, `SuggestPin`, `run_suggestions` from `.ontology_suggest`, and `JobCancelled` from `.pipeline` if not imported; use the module's existing logger name.)

In `main.py`, after the `graph` branch:

```python
        if job.task == "suggest":
            record = run_suggest(job, deps, queue)
            queue.complete(job, [], deps.buckets.outputs)
            log.info("job %s suggested %d ontologies", job.id, len(record["suggestions"]))
            return True
```

with `from .ontology_suggest import run_suggest`.

`db/migrations/0039_ontology_suggestions.sql`:

```sql
-- Ontology suggestions (ADR 0011 follow-up): the Survey tab's Refresh queues a project-scoped
-- `suggest` job (no document, like segment and graph previews) that writes
-- ontology-suggestions/{project}/{job}.json to the runs bucket.
ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check
  CHECK (task IN ('process', 'publish', 'rerun', 'prepare', 'segment', 'draft', 'export',
                  'ontology', 'graph', 'embed', 'withdraw', 'republish', 'suggest'));
```

Also add `'suggest'` wherever the worker or `queue.py` enumerates tasks (grep `"republish"` in `worker/src` and `apps/api/src` for task lists, e.g. a `JobTask` type or a claim filter) so a `suggest` row is claimable.

- [ ] **Step 4: Run them to verify they pass**

Run: `cd worker && uv run pytest tests/test_ontology_suggest.py tests/test_drafting.py -q`
Expected: PASS (the whole of both files: earlier survey tests are unaffected because `library` defaults to `[]`).

- [ ] **Step 5: Full worker suite, lint, commit**

Run: `npm run worker:test` then `npm run worker:lint`
Expected: all pass, clean.

```bash
git add worker db/migrations/0039_ontology_suggestions.sql
git commit -m "Worker: ontology suggestions after the survey and as a suggest job (migration 0039)"
```

---

### Task 5: API repository: suggest jobs

**Files:**
- Modify: `apps/api/src/repositories/types.ts` (after `getGraphJob`, ~line 221)
- Modify: `apps/api/src/repositories/memory.ts` (after `getGraphJob`, ~line 282)
- Modify: `apps/api/src/repositories/pg.ts` (after `getGraphJob`, ~line 470)
- Modify: `apps/api/src/workbench/repo.ts` (memory delete lists, ~lines 605 and 695)
- Test: `apps/api/test/workbench-suggestions.test.ts` (create; repo part)

**Interfaces:**
- Produces: `IngestionRepo.createSuggestJob(projectId: string, params: SuggestParams): Promise<{ job: ProjectJob; removed: string[] }>`; `IngestionRepo.latestSuggestJob(projectId: string): Promise<(ProjectJob & { params: SuggestParams }) | null>`; `MemoryRepo.suggestJobs: Map<string, ProjectJob & { params: Record<string, unknown> }>`.

- [ ] **Step 1: Write the failing test** `apps/api/test/workbench-suggestions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { SuggestParams } from '@ih/shared';
import { MemoryRepo } from '../src/repositories/memory.js';
import { SEGMENT_PRIORITY } from '../src/repositories/types.js';

const params: SuggestParams = {
  surveyProposalId: 'p1',
  candidates: [{ name: 'batch_number', description: '', kind: 'field' }],
  library: [{ id: 'domain', version: 1, label: 'Domain', terms: 3 }],
  pinned: [],
  dataPolicy: 'local',
};

describe('suggest jobs (repository)', () => {
  it('keeps one per project and returns the replaced ids', async () => {
    const repo = new MemoryRepo();
    const first = await repo.createSuggestJob('letter', params);
    const second = await repo.createSuggestJob('letter', params);
    expect(second.removed).toEqual([first.job.id]);
    expect(repo.priorities.get(second.job.id)).toBe(SEGMENT_PRIORITY);
    expect((await repo.latestSuggestJob('letter'))?.id).toBe(second.job.id);
    expect((await repo.latestSuggestJob('letter'))?.params).toEqual(params);
    expect(await repo.latestSuggestJob('other')).toBeNull();
  });
});
```

(If `MemoryRepo`'s `priorities` map is private, assert the priority the way `workbench-graph.test.ts` does.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/api/test/workbench-suggestions.test.ts`
Expected: FAIL (`createSuggestJob is not a function`).

- [ ] **Step 3: Implement.** `types.ts` (import `SuggestParams` from `@ih/shared`):

```ts
  /**
   * Queue an ontology suggestion refresh (task 'suggest', no document, priority
   * SEGMENT_PRIORITY). One per project: earlier suggest jobs are deleted and returned in `removed`.
   */
  createSuggestJob(
    projectId: string,
    params: SuggestParams,
  ): Promise<{ job: ProjectJob; removed: string[] }>;
  /** The project's suggest job (there is at most one), with its params. */
  latestSuggestJob(projectId: string): Promise<(ProjectJob & { params: SuggestParams }) | null>;
```

`memory.ts`:

```ts
  /** Ontology suggestion refreshes (document-less, one per project). */
  readonly suggestJobs = new Map<string, ProjectJob & { params: Record<string, unknown> }>();

  async createSuggestJob(projectId: string, params: SuggestParams) {
    const removed = [...this.suggestJobs.values()]
      .filter((j) => j.projectId === projectId)
      .map((j) => j.id);
    for (const id of removed) this.suggestJobs.delete(id);
    const now = new Date().toISOString();
    const job: ProjectJob = {
      id: randomUUID(),
      projectId,
      status: 'queued',
      error: null,
      createdAt: now,
      updatedAt: now,
    };
    this.suggestJobs.set(job.id, { ...job, params });
    this.priorities.set(job.id, SEGMENT_PRIORITY);
    return { job, removed };
  }

  async latestSuggestJob(projectId: string) {
    const stored = [...this.suggestJobs.values()].find((j) => j.projectId === projectId);
    if (!stored) return null;
    const { id, status, error, createdAt, updatedAt, params } = stored;
    return { id, projectId, status, error, createdAt, updatedAt, params: params as SuggestParams };
  }
```

`pg.ts`:

```ts
  async createSuggestJob(projectId: string, params: SuggestParams) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialized with the project's segment and graph previews: one lock per project.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId]);
      const removed = await client.query<{ id: string }>(
        `DELETE FROM jobs WHERE project_id = $1 AND task = 'suggest' RETURNING id`,
        [projectId],
      );
      const { rows } = await client.query<SegmentRow>(
        `INSERT INTO jobs (project_id, task, test, priority, max_attempts, params)
         VALUES ($1, 'suggest', true, $2, 3, $3)
         RETURNING id, project_id, status, error, created_at, updated_at`,
        [projectId, SEGMENT_PRIORITY, JSON.stringify(params)],
      );
      await client.query('COMMIT');
      return { job: toSegmentJob(rows[0]!), removed: removed.rows.map((r) => r.id) };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async latestSuggestJob(projectId: string) {
    const { rows } = await this.pool.query<SegmentRow & { params: SuggestParams }>(
      `SELECT id, project_id, status, error, created_at, updated_at, params FROM jobs
        WHERE project_id = $1 AND task = 'suggest' ORDER BY created_at DESC LIMIT 1`,
      [projectId],
    );
    return rows[0] ? { ...toSegmentJob(rows[0]), params: rows[0].params } : null;
  }
```

`workbench/repo.ts`: add `repo.suggestJobs` to the two memory lists next to `repo.graphJobs` (the delete loop and the jobs gathered for removal). If the shared `JobTask` type in `packages/shared/src/jobs.ts` enumerates tasks, add `'suggest'`.

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run apps/api/test/workbench-suggestions.test.ts apps/api/test/workbench-delete.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api packages/shared
git commit -m "API: suggest jobs in the repositories"
```

---

### Task 6: API routes, library, survey params, project delete

**Files:**
- Create: `apps/api/src/workbench/suggestions.ts`
- Create: `apps/api/src/routes/workbench-suggestions.ts`
- Modify: `apps/api/src/app.ts` (register), `apps/api/src/routes/workbench.ts` (survey params ~line 2615; delete prefixes ~line 1382)
- Test: `apps/api/test/workbench-suggestions.test.ts` (extend), `apps/api/test/workbench-drafting.test.ts` (survey params), `apps/api/test/workbench-delete.test.ts` (prefix)

**Interfaces:**
- Consumes: `createSuggestJob`, `latestSuggestJob` (Task 5); shared schemas (Task 1).
- Produces:
  - `ontologyLibrary(app: FastifyInstance): Promise<LibraryVersion[]>` — the newest ready version of every non-retired ontology, sorted by id.
  - `currentSurvey(app, projectId): Promise<{ id: string; candidates: SuggestCandidate[] } | null>` — newest accepted survey proposal, else newest whose job succeeded and is not rejected; candidates read from its drafting result.
  - `suggestionsView(app, projectId): Promise<OntologySuggestionsView>`.
  - Routes `GET|POST /api/workbench/projects/:id/ontology-suggestions` (`operationId` `getOntologySuggestions`, `refreshOntologySuggestions`).

- [ ] **Step 1: Write the failing tests** (append to `apps/api/test/workbench-suggestions.test.ts`):

```ts
import {
  draftingKey,
  ontologySuggestionsKey,
  type SuggestionRecord,
} from '@ih/shared';
import { testApp } from './helpers.js';

const SURVEY = {
  summary: 's',
  structure: [],
  variants: [],
  candidates: [
    { name: 'batch_number', description: 'Batch', where: 'top', kind: 'field', seenIn: { n: 1, of: 1 } },
  ],
  questions: [],
};

/** A project with one ready ontology, and a finished survey proposal (status ready). */
async function setup() {
  const ctx = await testApp();
  await ctx.app.inject({ method: 'POST', url: '/api/workbench/projects', payload: { id: 'letter', name: 'Letter' } });
  await ctx.ontologies.seedReady({ id: 'domain', label: 'Domain', version: 1, terms: 3 });
  const survey = async (decision: 'accepted' | 'rejected' | null = null) => {
    const job = await ctx.repo.createDraftJob('letter', { stage: 'survey' });
    ctx.repo.draftJobs.set(job.id, { ...ctx.repo.draftJobs.get(job.id)!, status: 'succeeded' });
    await ctx.app.deps.workbench.createProposal({
      id: job.id, projectId: 'letter', stage: 'survey', briefVersion: null,
      baseVersion: null, baseDefinition: null, feedbackIds: null,
    });
    await ctx.store.put('runs', draftingKey('letter', job.id),
      Buffer.from(JSON.stringify({ stage: 'survey', model: 'm', body: SURVEY, usage: { inputTokens: 1, outputTokens: 1 } })),
      'application/json');
    if (decision) await ctx.app.deps.workbench.decideProposal(job.id, { decision });
    return job.id;
  };
  const record = (surveyProposalId: string, libraryKey = 'lexical|domain@1'): SuggestionRecord => ({
    surveyProposalId, createdAt: '2026-10-15T10:00:00Z', candidates: 1, libraryKey,
    suggestions: [], pinned: [], alsoMatched: [], uncovered: ['batch_number'], notes: [],
  });
  const put = (jobId: string, r: SuggestionRecord) =>
    ctx.store.put('runs', ontologySuggestionsKey('letter', jobId), Buffer.from(JSON.stringify(r)), 'application/json');
  const get = async () =>
    (await ctx.app.inject({ method: 'GET', url: '/api/workbench/projects/letter/ontology-suggestions' })).json();
  const refresh = () =>
    ctx.app.inject({ method: 'POST', url: '/api/workbench/projects/letter/ontology-suggestions' });
  return { ...ctx, survey, record, put, get, refresh };
}

describe('ontology suggestion routes', () => {
  it('has no record before a survey', async () => {
    const t = await setup();
    expect(await t.get()).toEqual({ record: null, running: false, failed: null, stale: null });
    expect((await t.refresh()).json()).toEqual({ error: 'run the survey first' });
  });

  it("serves the survey job's own record, then a refresh of it", async () => {
    const t = await setup();
    const id = await t.survey();
    await t.put(id, t.record(id));
    expect((await t.get()).record.surveyProposalId).toBe(id);
    const res = await t.refresh();
    expect(res.statusCode).toBe(202);
    expect(res.json().running).toBe(true);
    const job = (await t.repo.latestSuggestJob('letter'))!;
    expect(job.params).toEqual({
      surveyProposalId: id,
      candidates: [{ name: 'batch_number', description: 'Batch', kind: 'field' }],
      library: [{ id: 'domain', version: 1, label: 'Domain', terms: 3 }],
      pinned: [],
      dataPolicy: 'local',
    });
    t.repo.suggestJobs.set(job.id, { ...t.repo.suggestJobs.get(job.id)!, status: 'succeeded' });
    await t.put(job.id, { ...t.record(id), uncovered: [] });
    const view = await t.get();
    expect(view).toMatchObject({ running: false, failed: null, stale: null });
    expect(view.record.uncovered).toEqual([]);
  });

  it('says when the library changed', async () => {
    const t = await setup();
    const id = await t.survey();
    await t.put(id, t.record(id, 'lexical|domain@1,qudt@1'));
    expect((await t.get()).stale).toBe('library');
  });

  it('says when the record is from an earlier survey', async () => {
    const t = await setup();
    const first = await t.survey();
    await t.put(first, t.record(first));
    const job = (await t.repo.createSuggestJob('letter', {
      surveyProposalId: first, candidates: [], library: [], pinned: [], dataPolicy: 'local',
    })).job;
    t.repo.suggestJobs.set(job.id, { ...t.repo.suggestJobs.get(job.id)!, status: 'succeeded' });
    await t.put(job.id, t.record(first));
    await t.survey(); // a newer survey without its own record (empty library at the time)
    expect((await t.get()).stale).toBe('survey');
  });

  it('ignores a rejected survey proposal', async () => {
    const t = await setup();
    const accepted = await t.survey('accepted');
    await t.put(accepted, t.record(accepted));
    await t.survey('rejected');
    expect((await t.get()).stale).toBeNull();
    await t.refresh();
    expect((await t.repo.latestSuggestJob('letter'))!.params.surveyProposalId).toBe(accepted);
  });

  it('shows a failed refresh', async () => {
    const t = await setup();
    const id = await t.survey();
    await t.refresh();
    const job = (await t.repo.latestSuggestJob('letter'))!;
    t.repo.suggestJobs.set(job.id, { ...t.repo.suggestJobs.get(job.id)!, status: 'needs_review', error: 'index down' });
    expect((await t.get()).failed).toBe('index down');
    void id;
  });

  it('refuses a refresh with no ready ontology', async () => {
    const t = await setup();
    await t.survey();
    await t.ontologies.retire('domain');
    expect((await t.refresh()).json()).toEqual({ error: 'the ontology library has no ready versions' });
  });

  it('offers the newest ready version when the latest is still importing', async () => {
    const t = await setup();
    await t.ontologies.seedVersion({ id: 'domain', version: 2, status: 'importing' });
    await t.survey();
    await t.refresh();
    expect((await t.repo.latestSuggestJob('letter'))!.params.library).toEqual([
      { id: 'domain', version: 1, label: 'Domain', terms: 3 },
    ]);
  });

  it('404s an unknown project and refuses a retired type', async () => {
    const t = await setup();
    expect(
      (await t.app.inject({ method: 'GET', url: '/api/workbench/projects/nope/ontology-suggestions' })).statusCode,
    ).toBe(404);
    await t.app.inject({ method: 'PUT', url: '/api/specs/letter/retirement' });
    const res = await t.refresh();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/is retired/);
  });
});
```

The helpers `ctx.ontologies.seedReady`, `seedVersion` and `retire` stand for whatever the memory ontology repo offers to create ready versions in tests; read `apps/api/test/workbench-mapping.test.ts` (it seeds ready ontologies for the mapping stage) and use the same calls. Likewise `workbench.decideProposal`: use the proposal-decision call the drafting tests use.

Append to `apps/api/test/workbench-drafting.test.ts`:

```ts
  it('sends the ontology library and the vocabulary pins with a survey', async () => {
    // Set up as the existing "survey" start test does, with one ready ontology `domain` v1
    // (seeded as in workbench-mapping.test.ts) and a brief pinning `qudt` v1 as vocabulary.
    // POST /stages/survey, then:
    expect(repo.draftJobs.get(view.id)!.params).toMatchObject({
      library: [{ id: 'domain', version: 1, label: 'Domain', terms: 3 }],
      pinned: [{ ontologyId: 'qudt', version: 1 }],
    });
  });
```

and in `workbench-delete.test.ts`, extend the files-removed assertion with the `ontology-suggestions/letter/` prefix.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run apps/api/test/workbench-suggestions.test.ts apps/api/test/workbench-drafting.test.ts apps/api/test/workbench-delete.test.ts`
Expected: FAIL (404s on the routes; no `library` in params).

- [ ] **Step 3: Implement** `apps/api/src/workbench/suggestions.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import {
  DraftResultSchema,
  draftingKey,
  ontologyLibraryKey,
  ontologySuggestionsKey,
  SuggestionRecordSchema,
  SurveyBodySchema,
  type LibraryVersion,
  type OntologySuggestionsView,
  type OntologyVersionView,
  type SuggestCandidate,
  type SuggestionRecord,
} from '@ih/shared';
import { readJsonSafe } from '../routes/workbench.js';

const termCount = (v: OntologyVersionView): number =>
  v.stats ? v.stats.classes + v.stats.properties + v.stats.concepts + v.stats.imported : 0;

/** The newest ready version of every ontology that is not retired, by id. */
export async function ontologyLibrary(app: FastifyInstance): Promise<LibraryVersion[]> {
  const out: LibraryVersion[] = [];
  for (const o of await app.deps.ontologies.list({ retired: false })) {
    let ready = o.latest?.status === 'ready' ? o.latest : null;
    if (!ready && o.latest) {
      const detail = await app.deps.ontologies.get(o.id);
      ready =
        detail?.versions
          .filter((v) => v.status === 'ready')
          .sort((a, b) => b.version - a.version)[0] ?? null;
    }
    if (ready) out.push({ id: o.id, version: ready.version, label: o.label, terms: termCount(ready) });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** The survey suggestions follow: the newest accepted one, else the newest finished, unrejected. */
export async function currentSurvey(
  app: FastifyInstance,
  projectId: string,
): Promise<{ id: string; candidates: SuggestCandidate[] } | null> {
  const [proposals, jobs] = await Promise.all([
    app.deps.workbench.listProposals(projectId),
    app.deps.repo.listDraftJobs(projectId),
  ]);
  const succeeded = new Set(jobs.filter((j) => j.status === 'succeeded').map((j) => j.id));
  const surveys = proposals
    .filter((p) => p.stage === 'survey' && succeeded.has(p.id) && p.decision !== 'rejected')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pick = surveys.find((p) => p.decision === 'accepted') ?? surveys[0];
  if (!pick) return null;
  const raw = await readJsonSafe(app, draftingKey(projectId, pick.id));
  const result = raw == null ? null : DraftResultSchema.safeParse(raw);
  const body = result?.success ? SurveyBodySchema.safeParse(result.data.body) : null;
  if (!body?.success) return null;
  return {
    id: pick.id,
    candidates: body.data.candidates.map(({ name, description, kind }) => ({ name, description, kind })),
  };
}

async function readRecord(
  app: FastifyInstance,
  projectId: string,
  jobId: string,
): Promise<SuggestionRecord | null> {
  const raw = await readJsonSafe(app, ontologySuggestionsKey(projectId, jobId));
  const parsed = raw == null ? null : SuggestionRecordSchema.safeParse(raw);
  return parsed?.success ? parsed.data : null;
}

/**
 * The record to show: a finished refresh of the current survey, else the current survey job's own
 * record, else an older refresh (stale `survey`); `library` when the library moved since.
 */
export async function suggestionsView(
  app: FastifyInstance,
  projectId: string,
): Promise<OntologySuggestionsView> {
  const [survey, refresh] = await Promise.all([
    currentSurvey(app, projectId),
    app.deps.repo.latestSuggestJob(projectId),
  ]);
  const refreshed =
    refresh?.status === 'succeeded' ? await readRecord(app, projectId, refresh.id) : null;
  const own = survey ? await readRecord(app, projectId, survey.id) : null;
  const record =
    refreshed && refreshed.surveyProposalId === survey?.id ? refreshed : (own ?? refreshed);
  let stale: OntologySuggestionsView['stale'] = null;
  if (record) {
    if (record.surveyProposalId !== survey?.id) stale = 'survey';
    else {
      const { embeddingModel } = await app.deps.llm.getSettings();
      const key = ontologyLibraryKey(await ontologyLibrary(app), embeddingModel ?? null);
      if (key !== record.libraryKey) stale = 'library';
    }
  }
  const failed =
    refresh && (refresh.status === 'failed' || refresh.status === 'needs_review')
      ? (refresh.error ?? 'the refresh failed')
      : null;
  return {
    record,
    running: refresh?.status === 'queued' || refresh?.status === 'running',
    failed,
    stale,
  };
}
```

(If `readJsonSafe` importing from `routes/workbench.js` creates an import cycle that breaks at load, move `readJsonSafe` into `workbench/suggestions.ts`'s own small helper reading `app.deps.store.get(app.deps.buckets.runs, key)` and parsing JSON, null on a missing object.)

`apps/api/src/routes/workbench-suggestions.ts`:

```ts
import type { FastifyPluginAsync } from 'fastify';
import { OntologySuggestionsViewSchema, ontologySuggestionsKey, vocabularyOf, EMPTY_BRIEF } from '@ih/shared';
import { error, md, res } from '../openapi/zod.js';
import { refuseRetired, RETIRED_DOC } from '../templates/retirement.js';
import { currentSurvey, ontologyLibrary, suggestionsView } from '../workbench/suggestions.js';
import { PROJECT_NOT_FOUND, ProjectIdParams } from './workbench.js';

/** Ontology suggestions (survey, ADR 0011 follow-up). */
export const workbenchSuggestionRoutes: FastifyPluginAsync = async (app) => {
  const { workbench } = app.deps;

  app.get<{ Params: { id: string } }>(
    '/workbench/projects/:id/ontology-suggestions',
    {
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'getOntologySuggestions',
        summary: 'Get the ontology suggestions',
        description: md`
          The library ontologies suggested as vocabularies for this document type, from the
          survey's candidate data: each with the candidates it covers and the matching terms.
          The record is the current survey's (the newest accepted survey, else the newest
          finished one), refreshed or not. \`stale\` is \`survey\` when it comes from an earlier
          survey and \`library\` when the ready library or the embedding model changed since;
          \`running\` while a refresh is queued or running; \`failed\` holds a refresh's error.
        `,
        params: ProjectIdParams,
        response: {
          200: res('The suggestions.', OntologySuggestionsViewSchema),
          404: PROJECT_NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      if (!(await workbench.getProject(req.params.id))) {
        return reply.code(404).send({ error: 'project not found' });
      }
      return suggestionsView(app, req.params.id);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/workbench/projects/:id/ontology-suggestions',
    {
      preHandler: refuseRetired(app),
      schema: {
        tags: ['Drafting stages & proposals'],
        operationId: 'refreshOntologySuggestions',
        summary: 'Refresh the ontology suggestions',
        description: md`
          Queues a refresh of the ontology suggestions from the current survey's candidates
          against the library as it is now (no model call; the candidates are embedded only by a
          local embedding model or when the project allows external models). A project has one
          refresh at a time: a new one replaces the old. Poll \`GET\`.
        `,
        params: ProjectIdParams,
        response: {
          202: res('The suggestions, with the refresh running.', OntologySuggestionsViewSchema),
          404: PROJECT_NOT_FOUND,
          409: error(`\`run the survey first\`, \`the ontology library has no ready versions\`, or ${RETIRED_DOC}`),
        },
      },
    },
    async (req, reply) => {
      const projectId = req.params.id;
      const project = await workbench.getProject(projectId);
      if (!project) return reply.code(404).send({ error: 'project not found' });
      const survey = await currentSurvey(app, projectId);
      if (!survey?.candidates.length) {
        return reply.code(409).send({ error: 'run the survey first' });
      }
      const library = await ontologyLibrary(app);
      if (!library.length) {
        return reply.code(409).send({ error: 'the ontology library has no ready versions' });
      }
      const brief = await workbench.latestBrief(projectId);
      const { removed } = await app.deps.repo.createSuggestJob(projectId, {
        surveyProposalId: survey.id,
        candidates: survey.candidates,
        library,
        pinned: vocabularyOf(brief?.body ?? EMPTY_BRIEF).map((v) => ({
          ontologyId: v.ontologyId,
          version: v.version,
        })),
        dataPolicy: project.dataPolicy,
      });
      await Promise.all(
        removed.map((id) =>
          app.deps.store
            .delete(app.deps.buckets.runs, ontologySuggestionsKey(projectId, id))
            .catch((err: unknown) => req.log.warn({ err, id }, 'old suggestions not deleted')),
        ),
      );
      return reply.code(202).send(await suggestionsView(app, projectId));
    },
  );
};
```

(Match `RETIRED_DOC`'s actual shape: it may be a string fragment or a response object; follow how `routes/workbench.ts` uses it in a 409 `error(...)`.)

Register in `app.ts` next to `workbenchGraphRoutes`: `await app.register(workbenchSuggestionRoutes, { prefix: '/api' });`.

In `routes/workbench.ts` stage start (before `createDraftJob`):

```ts
      // Survey: the library to suggest ontologies from, and what the brief already pins.
      const library = stage === 'survey' ? await ontologyLibrary(app) : [];
```

and in the `createDraftJob` params object:

```ts
        ...(library.length
          ? {
              library,
              pinned: vocabularyOf(brief?.body ?? EMPTY_BRIEF).map((v) => ({
                ontologyId: v.ontologyId,
                version: v.version,
              })),
            }
          : {}),
```

In the project delete route, add `'ontology-suggestions'` to the prefix list `['drafting', 'segmentation', 'exports', 'graphs']`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run apps/api/test/workbench-suggestions.test.ts apps/api/test/workbench-drafting.test.ts apps/api/test/workbench-delete.test.ts apps/api/test/openapi.test.ts apps/api/test/access.test.ts`
Expected: PASS (OpenAPI and access sweeps include the two new routes).

- [ ] **Step 5: Regenerate the OpenAPI document and commit**

Run: `npm run openapi`
Expected: `docs/openapi.json` gains `getOntologySuggestions` and `refreshOntologySuggestions`.

```bash
git add apps/api docs/openapi.json
git commit -m "API: ontology suggestion routes; surveys carry the library and pins"
```

---

### Task 7: Mapping wording points to Survey

**Files:**
- Modify: `packages/shared/src/overview.ts:517`, `packages/shared/test/overview.test.ts:1000-1006`
- Modify: `apps/api/src/routes/workbench.ts:2545,2593`, `apps/api/test/workbench-mapping.test.ts:110,201`
- Modify: `apps/api/src/workbench/list.ts:18` (`LIST_CACHE_VERSION = 7`)
- Modify: `apps/web/src/workbench/MappingTab.tsx:54-58`, `apps/web/test/MappingTab.test.tsx:89`

**Interfaces:** none new.

- [ ] **Step 1: Change the tests first** (deliberately: the wording moves with the picker):
  - `overview.test.ts`: `'Not used: no vocabulary is pinned on Survey'` (both places).
  - `workbench-mapping.test.ts:110`: `{ error: 'pin a vocabulary ontology on the Survey tab first' }`; `:201`: status `'Not used: no vocabulary is pinned on Survey'`.
  - `MappingTab.test.tsx:89`: `/Not used: no vocabulary is pinned on Survey/`, and add:

```tsx
    await userEvent.click(screen.getByRole('button', { name: 'Choose ontologies on Survey' }));
    expect(onNavigate).toHaveBeenCalledWith('#/workbench/letter/survey');
```

(use the test's existing render helper and its `onNavigate` mock; add one if the test renders without it).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run packages/shared/test/overview.test.ts apps/api/test/workbench-mapping.test.ts apps/web/test/MappingTab.test.tsx`
Expected: FAIL on the old wording.

- [ ] **Step 3: Implement**
  - `overview.ts:517`: `return 'Not used: no vocabulary is pinned on Survey';`
  - `routes/workbench.ts`: the 409 (line 2593) and the documented list (line 2545) read `pin a vocabulary ontology on the Survey tab first`; `workbench/mapping.ts:122` `mappingInputs` returns the same text.
  - `list.ts`: `export const LIST_CACHE_VERSION = 7;`
  - `MappingTab.tsx`: the paragraph reads `Not used: no vocabulary is pinned on Survey. Pin the customer or industry ontologies this document type maps to on the Survey tab.` (keep the rest of the sentence's intent), and the button `Choose ontologies on Survey` navigating to `#/workbench/${projectId}/survey`.

- [ ] **Step 4: Run them to verify they pass**

Run: same as Step 2.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared apps/api apps/web
git commit -m "Mapping: point to the Survey tab for vocabulary pins"
```

---

### Task 8: Web: the Survey tab's Ontologies section; Brief summary line

**Files:**
- Modify: `apps/web/src/api/client.ts` (Api interface ~line 359, impl ~line 796), `apps/web/test/fake-api.ts` (~line 280)
- Create: `apps/web/src/workbench/suggestions.ts`, `apps/web/src/workbench/SurveyOntologies.tsx`
- Modify: `apps/web/src/workbench/SurveyTab.tsx` (render the section after the proposal block, also when there is no survey), `apps/web/src/workbench/BriefTab.tsx` (~line 389), `apps/web/src/styles.css`
- Test: `apps/web/test/survey-suggestions.test.ts` (create), `apps/web/test/SurveyOntologies.test.tsx` (create), `apps/web/test/BriefTab.test.tsx`, `apps/web/test/client.test.ts`

**Interfaces:**
- Consumes: `OntologySuggestionsView`, `OntologySuggestion`, `BriefBody` from `@ih/shared`; routes from Task 6.
- Produces:
  - `Api.getOntologySuggestions(projectId: string): Promise<OntologySuggestionsView>`; `Api.refreshOntologySuggestions(projectId: string): Promise<OntologySuggestionsView>`.
  - `pinState(s: {ontologyId: string; version: number}, body: BriefBody): { kind: 'pinned' } | { kind: 'older'; pinned: number } | { kind: 'none' }`.
  - `withPin(body: BriefBody, ontologyId: string, version: number): BriefBody` — replaces that ontology's vocabulary pin (any version) or appends `{ontologyId, version, role: 'vocabulary'}`.
  - `staleText(stale: 'library' | 'survey'): string`.
  - `SurveyOntologies` props `{ api, projectId, dataPolicy, brief, onBriefSaved, pollMs, retired, hasSurvey }`.

- [ ] **Step 1: Write the failing helper tests** `apps/web/test/survey-suggestions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EMPTY_BRIEF } from '@ih/shared';
import { pinState, staleText, withPin } from '../src/workbench/suggestions.js';

const body = {
  ...EMPTY_BRIEF,
  ontologies: [
    { ontologyId: 'idmp', version: 2, role: 'vocabulary' as const },
    { ontologyId: 'shapes', version: 1, role: 'shapes' as const },
  ],
};

describe('suggestion helpers', () => {
  it.each([
    [{ ontologyId: 'idmp', version: 2 }, { kind: 'pinned' }],
    [{ ontologyId: 'idmp', version: 3 }, { kind: 'older', pinned: 2 }],
    [{ ontologyId: 'shapes', version: 1 }, { kind: 'none' }],
    [{ ontologyId: 'qudt', version: 1 }, { kind: 'none' }],
  ])('pinState %j', (s, expected) => {
    expect(pinState(s, body)).toEqual(expected);
  });

  it('pins a new vocabulary, or moves a pin to the suggested version', () => {
    expect(withPin(body, 'qudt', 1).ontologies).toEqual([
      ...body.ontologies,
      { ontologyId: 'qudt', version: 1, role: 'vocabulary' },
    ]);
    expect(withPin(body, 'idmp', 3).ontologies).toEqual([
      { ontologyId: 'idmp', version: 3, role: 'vocabulary' },
      { ontologyId: 'shapes', version: 1, role: 'shapes' },
    ]);
  });

  it('explains staleness', () => {
    expect(staleText('library')).toBe('The ontology library changed since these suggestions.');
    expect(staleText('survey')).toBe('These suggestions are from an earlier survey.');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run apps/web/test/survey-suggestions.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `apps/web/src/workbench/suggestions.ts`:

```ts
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
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run apps/web/test/survey-suggestions.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing component tests** `apps/web/test/SurveyOntologies.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EMPTY_BRIEF, type OntologySuggestionsView } from '@ih/shared';
import { SurveyOntologies } from '../src/workbench/SurveyOntologies.js';
import { fakeApi } from './fake-api.js';

const brief = { projectId: 'letter', version: 2, body: { ...EMPTY_BRIEF }, createdAt: '' };

const view = (over: Partial<OntologySuggestionsView> = {}): OntologySuggestionsView => ({
  record: {
    surveyProposalId: 'p1',
    createdAt: '2026-10-15T10:00:00Z',
    candidates: 3,
    libraryKey: 'lexical|idmp@2',
    suggestions: [
      {
        ontologyId: 'idmp',
        version: 2,
        label: 'IDMP-O',
        covers: ['active_substance', 'strength'],
        evidence: [
          { candidate: 'active_substance', iri: 'https://ex.example/idmp#Substance', label: 'Substance', kind: 'class', via: 'lexical', similarity: 0.59 },
        ],
      },
    ],
    pinned: [],
    alsoMatched: [{ ontologyId: 'afo', version: 1, label: 'AFO merged', covers: ['strength', 'batch'] }],
    uncovered: ['batch_number'],
    notes: ['Retrieval was lexical only: no embedding model is set.'],
  },
  running: false,
  failed: null,
  stale: null,
  ...over,
});

function show(overrides = {}, props: Partial<Parameters<typeof SurveyOntologies>[0]> = {}) {
  const api = fakeApi({ getOntologySuggestions: vi.fn(async () => view()), ...overrides });
  const onBriefSaved = vi.fn();
  render(
    <SurveyOntologies
      api={api}
      projectId="letter"
      dataPolicy="local"
      brief={brief}
      onBriefSaved={onBriefSaved}
      pollMs={1}
      retired={null}
      hasSurvey
      {...props}
    />,
  );
  return { api, onBriefSaved };
}

describe('SurveyOntologies', () => {
  it('shows each suggestion with what it covers and its evidence', async () => {
    show();
    const card = await screen.findByRole('article', { name: 'IDMP-O v2' });
    expect(within(card).getByText('covers 2 of 3 candidates')).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Evidence' }));
    expect(within(card).getByText(/active_substance → Substance/)).toBeInTheDocument();
    expect(screen.getByText(/Not covered: batch_number/)).toBeInTheDocument();
    expect(screen.getByText(/lexical only/)).toBeInTheDocument();
  });

  it('pins a suggestion into the brief', async () => {
    const saved = { ...brief, version: 3 };
    const { api, onBriefSaved } = show({ saveBrief: vi.fn(async () => saved) });
    await userEvent.click(await screen.findByRole('button', { name: 'Pin IDMP-O v2' }));
    expect(api.saveBrief).toHaveBeenCalledWith('letter', {
      ...brief.body,
      ontologies: [{ ontologyId: 'idmp', version: 2, role: 'vocabulary' }],
    });
    await waitFor(() => expect(onBriefSaved).toHaveBeenCalledWith(saved));
  });

  it('disables Pin while a pin is saving', async () => {
    let resolve: (b: typeof brief) => void = () => {};
    const { api } = show({ saveBrief: vi.fn(() => new Promise<typeof brief>((r) => (resolve = r))) });
    const pin = await screen.findByRole('button', { name: 'Pin IDMP-O v2' });
    await userEvent.click(pin);
    expect(pin).toBeDisabled();
    await userEvent.click(pin);
    expect(api.saveBrief).toHaveBeenCalledTimes(1);
    resolve(brief);
  });

  it('shows a pinned suggestion as pinned', async () => {
    show({}, {
      brief: { ...brief, body: { ...EMPTY_BRIEF, ontologies: [{ ontologyId: 'idmp', version: 2, role: 'vocabulary' }] } },
    });
    expect(await screen.findByText('Pinned')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pin IDMP-O v2' })).toBeNull();
  });

  it('offers a stale refresh and polls while it runs', async () => {
    const getOntologySuggestions = vi
      .fn()
      .mockResolvedValueOnce(view({ stale: 'library' }))
      .mockResolvedValueOnce(view({ running: true }))
      .mockResolvedValue(view());
    const { api } = show({
      getOntologySuggestions,
      refreshOntologySuggestions: vi.fn(async () => view({ running: true })),
    });
    expect(await screen.findByText(/library changed since these suggestions/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh suggestions' }));
    expect(api.refreshOntologySuggestions).toHaveBeenCalledWith('letter');
    await waitFor(() => expect(getOntologySuggestions.mock.calls.length).toBeGreaterThanOrEqual(3));
  });

  it('shows a failed refresh', async () => {
    show({ getOntologySuggestions: vi.fn(async () => view({ failed: 'index down' })) });
    expect(await screen.findByRole('alert')).toHaveTextContent('index down');
  });

  it('asks for a survey when there is none', async () => {
    show({ getOntologySuggestions: vi.fn(async () => view({ record: null })) }, { hasSurvey: false });
    expect(await screen.findByText('Run the survey to get suggestions.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh suggestions' })).toBeNull();
  });

  it('disables Pin and Refresh for a retired type', async () => {
    show({ getOntologySuggestions: vi.fn(async () => view({ stale: 'library' })) }, { retired: 'Letter is retired' });
    expect(await screen.findByRole('button', { name: 'Pin IDMP-O v2' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Refresh suggestions' })).toBeDisabled();
  });

  it('keeps the manual picker, saving a removal straight away', async () => {
    const pinned = { ...brief, body: { ...EMPTY_BRIEF, ontologies: [{ ontologyId: 'qudt', version: 1, role: 'vocabulary' as const }] } };
    const { api } = show({ saveBrief: vi.fn(async () => pinned) }, { brief: pinned });
    await userEvent.click(await screen.findByRole('button', { name: 'Remove qudt v1' }));
    expect(api.saveBrief).toHaveBeenCalledWith('letter', { ...pinned.body, ontologies: [] });
  });

  it('saves mapping guidance with its own button', async () => {
    const { api } = show({ saveBrief: vi.fn(async () => brief) });
    await userEvent.type(await screen.findByLabelText('Guidance for the mapping'), 'Prefer IDMP-O');
    await userEvent.click(screen.getByRole('button', { name: 'Save guidance' }));
    expect(api.saveBrief).toHaveBeenCalledWith('letter', { ...brief.body, ontologyGuidance: 'Prefer IDMP-O' });
  });
});
```

Add to `BriefTab.test.tsx`:

```tsx
  it('summarises the pinned ontologies and links to Survey', async () => {
    // Render with a brief pinning idmp v2 (vocabulary) and listOntologies returning its label,
    // using the file's existing render helper and onNavigate mock.
    expect(await screen.findByText(/1 ontology pinned/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add ontology' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Change on Survey' }));
    expect(onNavigate).toHaveBeenCalledWith('#/workbench/letter/survey');
  });
```

Add to `client.test.ts` a test that `getOntologySuggestions('letter')` GETs and `refreshOntologySuggestions('letter')` POSTs `/api/workbench/projects/letter/ontology-suggestions`, following the file's fetch-mock pattern.

- [ ] **Step 6: Run them to verify they fail**

Run: `npx vitest run apps/web/test/SurveyOntologies.test.tsx apps/web/test/BriefTab.test.tsx apps/web/test/client.test.ts`
Expected: FAIL (component and client methods missing; the Brief still has the picker).

- [ ] **Step 7: Implement.** `client.ts`: in `Api`:

```ts
  getOntologySuggestions(projectId: string): Promise<OntologySuggestionsView>;
  refreshOntologySuggestions(projectId: string): Promise<OntologySuggestionsView>;
```

and in the implementation (next to `getGraphPreview`):

```ts
    getOntologySuggestions: (id) =>
      get<OntologySuggestionsView>(`${base}/workbench/projects/${id}/ontology-suggestions`),
    refreshOntologySuggestions: (id) =>
      post<OntologySuggestionsView>(`${base}/workbench/projects/${id}/ontology-suggestions`, {}),
```

(use the file's actual `get`/`post` helpers and the way it encodes ids). `fake-api.ts` defaults:

```ts
    getOntologySuggestions: vi.fn(async () => ({ record: null, running: false, failed: null, stale: null })),
    refreshOntologySuggestions: vi.fn(async () => {
      throw new Error('refreshOntologySuggestions not faked');
    }),
```

`apps/web/src/workbench/SurveyOntologies.tsx`:

```tsx
import { useCallback, useEffect, useId, useState } from 'react';
import type { Brief, DataPolicy, OntologySuggestion, OntologySuggestionsView } from '@ih/shared';
import type { Api } from '../api/client.js';
import { Icon } from '../ui/Icon.js';
import { BriefOntologies } from './BriefOntologies.js';
import { pinState, staleText, withPin } from './suggestions.js';

/**
 * The Survey tab's Ontologies section: the survey's suggestions (pin a vocabulary with one click,
 * evidence on demand, Refresh when stale) and the manual picker moved from the Brief. Both save
 * straight into the brief (`brief.ontologies`), as survey answers do.
 */
export function SurveyOntologies({
  api,
  projectId,
  dataPolicy,
  brief,
  onBriefSaved,
  pollMs,
  retired,
  hasSurvey,
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  brief: Brief | null;
  onBriefSaved: (brief: Brief) => void;
  pollMs: number;
  retired: string | null;
  hasSurvey: boolean;
}) {
  const titleId = useId();
  const [view, setView] = useState<OntologySuggestionsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const body = brief?.body ?? null;
  const savedGuidance = body?.ontologyGuidance ?? '';
  const [guidance, setGuidance] = useState(savedGuidance);
  useEffect(() => setGuidance(savedGuidance), [savedGuidance]);

  const load = useCallback(
    () => api.getOntologySuggestions(projectId).then(setView, (e: Error) => setError(e.message)),
    [api, projectId],
  );
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (!view?.running) return;
    const t = setTimeout(() => void load(), pollMs);
    return () => clearTimeout(t);
  }, [view, load, pollMs]);

  const save = async (next: NonNullable<typeof body>) => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      onBriefSaved(await api.saveBrief(projectId, next));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  const refresh = async () => {
    setError(null);
    try {
      setView(await api.refreshOntologySuggestions(projectId));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const record = view?.record ?? null;
  const base = body ?? { ...emptyBody() };
  return (
    <section id="survey-ontologies" className="card survey-ontologies" aria-labelledby={titleId}>
      <h3 id={titleId}>Ontologies</h3>
      <p className="muted">
        Vocabularies the Mapping stage draws its terms from. Suggestions come from the survey&apos;s
        candidate data and the ontology library; nothing is pinned until you pin it.
      </p>
      {error && <p role="alert">{error}</p>}
      {view?.failed && (
        <p role="alert">The refresh failed: {view.failed}</p>
      )}
      {view?.running && <p className="muted">Refreshing the suggestions…</p>}
      {view?.stale && !view.running && (
        <div className="banner tone-warn">
          <span>{staleText(view.stale)}</span>
        </div>
      )}
      {!hasSurvey && !record ? (
        <p className="muted">Run the survey to get suggestions.</p>
      ) : (
        hasSurvey && (
          <button
            type="button"
            disabled={retired !== null || view?.running === true}
            title={retired ?? undefined}
            onClick={() => void refresh()}
          >
            <Icon name="refresh" /> Refresh suggestions
          </button>
        )
      )}
      {record && (
        <>
          {record.suggestions.length === 0 && (
            <p className="muted">No library ontology covers enough of the candidates.</p>
          )}
          <div className="suggestion-grid">
            {record.suggestions.map((s) => (
              <SuggestionCard
                key={`${s.ontologyId}@${s.version}`}
                s={s}
                of={record.candidates}
                state={pinState(s, base)}
                disabled={saving || retired !== null}
                reason={retired}
                onPin={() => void save(withPin(base, s.ontologyId, s.version))}
              />
            ))}
          </div>
          {record.alsoMatched.length > 0 && (
            <details>
              <summary>Also matched ({record.alsoMatched.length})</summary>
              <ul>
                {record.alsoMatched.map((m) => (
                  <li key={`${m.ontologyId}@${m.version}`}>
                    {m.label} v{m.version} · covers {m.covers.length}: {m.covers.join(', ')}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {record.uncovered.length > 0 && (
            <p className="muted">Not covered: {record.uncovered.join(', ')}</p>
          )}
          {record.notes.map((n) => (
            <p key={n} className="muted">
              {n}
            </p>
          ))}
        </>
      )}
      <BriefOntologies
        api={api}
        ontologies={base.ontologies ?? []}
        guidance={guidance}
        dataPolicy={dataPolicy}
        onChange={(next) => {
          if (JSON.stringify(next.ontologies) !== JSON.stringify(base.ontologies ?? [])) {
            void save({ ...base, ontologies: next.ontologies });
          }
          setGuidance(next.ontologyGuidance);
        }}
      />
      {guidance !== savedGuidance && (
        <button
          type="button"
          className="primary"
          disabled={saving}
          onClick={() => void save({ ...base, ontologyGuidance: guidance })}
        >
          Save guidance
        </button>
      )}
    </section>
  );
}

function SuggestionCard({
  s,
  of,
  state,
  disabled,
  reason,
  onPin,
}: {
  s: OntologySuggestion;
  of: number;
  state: ReturnType<typeof pinState>;
  disabled: boolean;
  reason: string | null;
  onPin: () => void;
}) {
  const [open, setOpen] = useState(false);
  const name = `${s.label} v${s.version}`;
  return (
    <article className="suggestion-card" aria-label={name}>
      <h4>
        <a href={`#/ontologies/${encodeURIComponent(s.ontologyId)}`}>{s.label}</a>{' '}
        <span className="version-tag">v{s.version}</span>
      </h4>
      <p>{`covers ${s.covers.length} of ${of} candidates`}</p>
      <ul className="chip-list" aria-label={`Candidates ${name} covers`}>
        {s.covers.map((c) => (
          <li key={c} className="chip">
            {c}
          </li>
        ))}
      </ul>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        Evidence
      </button>
      {open && (
        <ul className="suggestion-evidence">
          {s.evidence.map((e) => (
            <li key={`${e.candidate}:${e.iri}`}>
              {e.candidate} → {e.label} <span className="muted">({e.kind}, {e.via})</span>
            </li>
          ))}
        </ul>
      )}
      <div className="actions">
        {state.kind === 'pinned' ? (
          <span className="tone-ok">
            <Icon name="check" /> Pinned
          </span>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={disabled}
            title={reason ?? undefined}
            aria-label={state.kind === 'older' ? `Use v${s.version} of ${s.label}` : `Pin ${name}`}
            onClick={onPin}
          >
            {state.kind === 'older' ? `v${state.pinned} pinned · use v${s.version}` : 'Pin'}
          </button>
        )}
      </div>
    </article>
  );
}

function emptyBody() {
  return {
    purpose: '',
    outputs: '',
    exampleOutput: '',
    glossary: '',
    variants: '',
    rules: '',
    answers: [],
    ontologies: [],
    ontologyGuidance: '',
  };
}
```

(Use `EMPTY_BRIEF` from `@ih/shared` instead of `emptyBody()` if the types line up; check that `Icon` has `refresh` and `check` glyphs, else use existing ones.)

In `SurveyTab.tsx`, render after the proposal block (inside the final `<div className="survey-tab">`, after `{proposal && …}`, so it shows with or without a survey):

```tsx
      <SurveyOntologies
        api={api}
        projectId={projectId}
        dataPolicy={dataPolicy}
        brief={brief}
        onBriefSaved={onBriefSaved}
        pollMs={pollMs}
        retired={retired}
        hasSurvey={proposal !== null && proposal?.status !== 'failed' && proposal?.status !== 'running'}
      />
```

In `BriefTab.tsx`, replace the `<BriefOntologies … />` element with:

```tsx
          <section className="card brief-ontology-summary" aria-label="Ontologies">
            <h3>Ontologies</h3>
            <p className="muted">
              {body.ontologies.length === 0
                ? 'No ontologies pinned.'
                : `${body.ontologies.length} ${body.ontologies.length === 1 ? 'ontology' : 'ontologies'} pinned: ${body.ontologies
                    .map((o) => `${o.ontologyId} v${o.version}${o.role === 'shapes' ? ' (shapes)' : ''}`)
                    .join(' · ')}`}
            </p>
            <button type="button" onClick={() => onNavigate(`#/workbench/${projectId}/survey`)}>
              {body.ontologies.length === 0 ? 'Choose on Survey' : 'Change on Survey'}
            </button>
          </section>
```

Then make sure the Brief's kept draft never restores ontology picks: in the code that builds or restores `ih.briefDraft.<project>` (Brief helpers in `workbench/brief.ts`), drop the `ontologies` section from what is kept and restored; add to `BriefTab.test.tsx`:

```tsx
  it('never restores ontology picks from a kept brief draft', async () => {
    // Put a kept draft into localStorage under ih.briefDraft.letter whose edited sections
    // include `ontologies` (as an older build kept them), render, and check the summary shows
    // the saved brief's pins, not the kept ones; Save sends the saved pins.
  });
```

Write that test concretely against the kept-draft format `workbench/brief.ts` uses (read it first). Styles: add `.survey-ontologies`, `.suggestion-grid` (auto-fill, min 260px), `.suggestion-card`, `.suggestion-evidence`, `.brief-ontology-summary` to `styles.css` with existing tokens.

- [ ] **Step 8: Run them to verify they pass**

Run: `npx vitest run --project web`
Expected: PASS (all web tests, incl. the existing SurveyTab and BriefTab suites).

- [ ] **Step 9: Commit**

```bash
git add apps/web
git commit -m "Web: ontology suggestions and pinning on the Survey tab; Brief shows a summary"
```

---

### Task 9: Docs and contracts, full check

**Files:**
- Modify: `CLAUDE.md` (contract table, job statuses row, Workbench rules), `docs/design/rdf-publishing.md` (as-built note), `docs/superpowers/specs/2026-10-15-survey-ontology-suggestions-design.md` (status: implemented)

**Interfaces:** none.

- [ ] **Step 1: Update `CLAUDE.md`.**
  - New contract row after "Brief ontologies and the mapping stage": **Ontology suggestions (survey, migration 0039)** | `packages/shared/src/ontology-suggestions.ts` (`LibraryVersionSchema`, `SuggestParamsSchema`, `SuggestionRecordSchema`, `OntologySuggestionsViewSchema`, `ontologyLibraryKey`; fixture `packages/shared/test/fixtures/ontology-suggestions.json`), `ontologySuggestionsKey`; `apps/api/src/workbench/suggestions.ts` (`ontologyLibrary`, `currentSurvey`, `suggestionsView`), routes `apps/api/src/routes/workbench-suggestions.ts`; `createSuggestJob`/`latestSuggestJob`; survey draft params carry `library`/`pinned` | `ontology_suggest` (`suggest_ontologies`: greedy set cover from the pins, `MIN_LEXICAL` 0.45, `MIN_SEMANTIC` 0.6, `MIN_GAIN` 2, `MAX_SUGGESTIONS` 5; `run_suggestions` (survey hook, advisory: `ontology suggestions failed`), `run_suggest`, `library_key`, `SuggestParams` `extra="forbid"`), `OntologyStore.lexical_best`/`semantic_best` (`TermHit`, `trigram_similarity`), `DraftParams.library/pinned`, `storage.ontology_suggestions_key`.
  - Job statuses row: add `suggest` (migration 0039: project-scoped, no document, one per project like `graph`; `setDataPolicy` updates its params).
  - Workbench rules paragraph: one sentence: ontology pinning lives on the Survey tab (`SurveyOntologies`: suggestions with Pin, Refresh when stale, the moved picker and guidance, saved straight into the brief); the Brief tab shows a summary with *Change on Survey*; the mapping stage's empty state points to Survey.

- [ ] **Step 2: Update `docs/design/rdf-publishing.md`** with an as-built note under the brief ontologies / mapping section: suggestions from the survey, the set cover, the thresholds, and the consequence for the limits (vocabularies only through the term index; only shapes pins load whole graphs). Mark the spec's status `implemented`.

- [ ] **Step 3: Run everything CI checks**

Run: `npm run check`
Expected: green (typecheck, lint, format, TS tests, worker tests and lint).

Run the Pg integration test (Task 2 Step 5) against a throwaway pgvector container per CLAUDE.md:
`IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres` and `cd worker && uv run pytest tests/test_retrieval.py -m integration -q` (the database needs `db/migrations` applied, as the existing integration tests expect).
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs
git commit -m "Docs: ontology suggestions contracts and as-built notes"
```
