# Ontology suggestions in the survey, and pinning on the Survey tab

Date: 2026-10-15 · ADR 0011 follow-up · Status: approved design

## Goal

Choosing ontologies is the last detailed piece of configuration a configurator does in the
Workbench brief. Move it to the Survey tab and make it a confirmation instead of a search: the
survey suggests which library ontologies to pin as vocabularies, says why, and the configurator
pins them with one click.

Success: a configurator with a populated library (dozens to ~100 ontologies, e.g. IDMP-O
modules, AFO, QUDT, sometimes ChEBI) pins the right vocabularies from the survey without
browsing the library, and every suggestion shows the evidence behind it.

Decided with the user:

- Suggestions are computed from retrieval evidence (approach 1), with no extra model call; a
  model judgement on top (approach 2) is a possible later add-on.
- Suggestions are computed inside the survey job and can be refreshed on their own when the
  library changes.
- Nothing is pinned without a click. Suggestions cover the **vocabulary** role only; shapes stay a
  manual pin.
- The ontology picker moves from the Brief tab to the Survey tab; the selection is still stored in
  the brief (`brief.ontologies`, `ontologyGuidance`).

## Non-goals

- No change to the survey's model prompt or `SurveyBodySchema`, so bundles (`survey.json`) and
  older deployments are unaffected.
- No change to `BriefBodySchema`, `vocabularyOf`, `ontologySelectionKey`,
  `ontologySelectionChangedAt` or the mapping stage's staleness rules.
- No suggestions for shapes, and no automatic pinning.
- Suggestions are not exported in bundles.

## 1. Computing suggestions (worker)

New module `worker/src/ingest_worker/ontology_suggest.py`:

```python
def suggest_ontologies(
    store: OntologyStore,
    candidates: list[SurveyCandidate],       # name, description, kind (field|table)
    library: list[LibraryVersion],           # id, version, label, localOnly, terms (count)
    pinned: list[tuple[str, int]],           # the brief's vocabulary pins
    *,
    embed: Callable[[list[str]], list[list[float]]] | None,
    model_ref: str | None,
) -> SuggestionRecord
```

### Queries

One query per survey candidate: its `name` with underscores read as spaces, then its
`description`. A `table` candidate looks for classes; a `field` candidate for properties and
classes. Retrieval runs over every ready library version at once (`retrieval.shortlist`-style
lexical + semantic), so a survey of ~20 candidates is ~20 lexical queries plus one batched
embedding call, whatever the library size.

### Absolute similarity

Rank fusion scores are relative, so "covered" needs an absolute signal. `OntologyStore.lexical`
and `OntologyStore.semantic` return each term's similarity (`Term.similarity`, 0-1: the trigram
similarity of the best label or synonym, or `1 - cosine distance`). Both `PgOntologyStore` and
`MemoryOntologyStore` implement it; the mapping stage ignores it.

A candidate is **covered** by ontology O when one of O's terms (by `definedIn`, so terms an
ontology imports count for the version that indexes them) has lexical similarity ≥
`MIN_LEXICAL` or semantic similarity ≥ `MIN_SEMANTIC`. Both constants are tuned against a small
recall fixture (`worker/tests/fixtures/ontology-suggest/`, like `mapping-recall/`); the starting
values are `MIN_LEXICAL = 0.45` and `MIN_SEMANTIC = 0.6`.

### Greedy set cover

1. Start with the brief's vocabulary pins as already chosen; the candidates they cover are
   covered.
2. Repeatedly add the library ontology that covers the most still-uncovered candidates.
   Ties: higher summed best similarity over those candidates, then fewer terms (a module beats a
   merged copy that covers the same candidates), then id.
3. Stop when the best gain is below `MIN_GAIN` (2 candidates) or `MAX_SUGGESTIONS` (5) are
   chosen.

### The record (`SuggestionRecord`, JSON)

- `surveyProposalId`, `createdAt`, `candidates` (how many were queried), `libraryKey`
  (sha256 of the sorted ready `id@version` list plus the embedding model ref, or `lexical`).
- `suggestions`: in pick order, each `{ontologyId, version, label, covers: [candidate names],
  evidence: [{candidate, iri, label, kind, via: lexical|semantic|both, similarity}] (≤ 5)}`.
- `pinned`: the brief's vocabulary pins with the candidates each covers.
- `alsoMatched`: up to 5 unpicked ontologies covering ≥ `MIN_GAIN` candidates (typically
  redundant with a pick: AFO merged beside its modules), each `{ontologyId, version, label,
  covers}`.
- `uncovered`: candidate names no chosen ontology covers.
- `notes`: e.g. `Retrieval was lexical only: …` (same wording as the mapping stage).

### Data policy

No model sees ontology terms, so local-only ontologies are always eligible. The candidate texts
(derived from dev samples) are embedded only when the embedding model is local or the project's
data policy is `external`; otherwise retrieval is lexical only, with a note. Versions without
embeddings for the model are lexical only (note per version, as in mapping). An external
embedding call writes the `external model call` job event (`stage: 'survey'` or `'suggest'`,
`purpose: 'embedding'`).

### Where it runs

- **Survey jobs.** The API adds `params.library` (ready versions: id, version, label,
  localOnly, terms) and `params.pinned` to every survey draft job (`DraftParams` gains both,
  optional). After the survey's model call and `clamp_seen_in`, `run_draft` calls
  `suggest_ontologies` and writes the record to `ontology-suggestions/{project}/{job}.json` in
  the runs bucket (`storage.ontology_suggestions_key` / `ontologySuggestionsKey`). Advisory: any
  exception is logged as a job event `ontology suggestions failed` and the survey still
  succeeds. An empty library writes nothing.
- **`suggest` jobs (Refresh).** A new job task, document-less and project-scoped like `segment`
  and `graph` previews, `priority = -5`, one per project (a new one deletes the old under
  `pg_advisory_xact_lock(hashtext('suggest:' || project))`). Params (`SuggestParams`,
  `extra="forbid"`): `surveyProposalId`, `candidates`, `library`, `pinned`, `dataPolicy`. No model
  call except the embedding. A failure goes to `needs_review` with the error.

## 2. API and contracts

### Routes (`apps/api/src/routes/workbench-suggestions.ts`, tag Workbench)

- `GET /api/workbench/projects/:id/ontology-suggestions` → `OntologySuggestionsView`:
  `{record: SuggestionRecord | null, running: boolean, failed: string | null, stale: 'library' |
  'survey' | null}`. The record is the newest one among the project's succeeded survey draft jobs
  and `suggest` jobs. `stale` is `survey` when a newer survey proposal (ready or accepted) exists
  than `record.surveyProposalId`, else `library` when the current `libraryKey` differs. 404 for an
  unknown project.
- `POST /api/workbench/projects/:id/ontology-suggestions` → 202 `OntologySuggestionsView`. Uses
  the newest accepted survey proposal, else the newest ready one; 409 `run the survey first` when
  none has candidates; 409 `the ontology library has no ready versions`; refused for a retired
  type (`refuseRetired`); `created_by` set like other jobs.

Both documented (OpenAPI, conformance) and covered by the access sweep.

### Migration 0039 `ontology_suggestions`

- `job_task` gains `suggest`; `jobs_document_or_project` allows a project-only `suggest` row.
- Like `segment`, `suggest` jobs never appear as `JobSummary` (no document), are never retried or
  cancelled through the jobs routes, are skipped by `setDataPolicy`, and are removed by
  `deleteProject` (with `ontology-suggestions/<id>/` in the runs bucket).

### Contracts (both sides, one PR)

- `packages/shared/src/ontology-suggestions.ts`: `SuggestionRecordSchema`,
  `OntologySuggestionsViewSchema`, `SuggestParamsSchema`, `LibraryVersionSchema`,
  `ontologyLibraryKey`, the constants' TS twins where the API needs them.
- `worker/src/ingest_worker/ontology_suggest.py`: Pydantic `SuggestionRecord`,
  `SuggestParams`, `LibraryVersion`, `library_key`.
- Shared fixture `packages/shared/test/fixtures/ontology-suggestions.json`: a record and params
  parsed by both sides, and `libraryKey` cases computed identically.
- `storage-keys.ts` `ontologySuggestionsKey` / `storage.ontology_suggestions_key`.
- `DraftParams` (`drafting.py`) gains optional `library` and `pinned`; the API's survey params
  builder supplies them.
- CLAUDE.md: a contract row for ontology suggestions; the job-tasks row gains `suggest`
  (migration 0039).

## 3. UI

### Survey tab (`SurveyTab`, new `SurveyOntologies.tsx`, helpers in `workbench/suggestions.ts`)

An **Ontologies** section below the candidates (`id="survey-ontologies"`):

- Suggestion cards in pick order: label (links to the ontology page), `v<N>`, *covers n of N
  candidates*, the covered candidates as chips, an expandable *Evidence* list (candidate → term
  label, kind, lexical/semantic), and **Pin** (*Pinned ✓* once in the brief; an older pinned
  version reads *v2 pinned · suggestion is v3* with *Use v3*).
- *Also matched* (collapsed) and *Not covered: a, b, c*.
- Notes (lexical only, …) as muted lines.
- A stale banner (`library`: "The ontology library changed since these suggestions";
  `survey`: "These suggestions are from an earlier survey") with **Refresh suggestions**; a
  running strip while a refresh runs (the tab polls `GET` every `pollMs` while `running`); a
  failed refresh shows its error with Refresh.
- No survey yet, or skipped: "Run the survey to get suggestions", the picker below still works.
- The existing `BriefOntologies` card (manual add, role, shapes, *Update available*, guidance),
  moved here unchanged in behaviour.

Pin appends `{ontologyId, version, role: 'vocabulary'}` to the brief and saves it (`saveBrief`,
new brief version), exactly as the moved card does; a local-only ontology pinned in an external
project shows the card's existing local-only notice. Retired types: Pin and Refresh are disabled
with `RETIRED_REASON` (editing the brief stays allowed, so manual edits in the card follow the
existing rule).

### Brief tab

The ontology card is removed. In its place, a read-only line: *3 ontologies pinned: IDMP-O v2 ·
QUDT v1 · … · Change on Survey* (link to the Survey tab's `#survey-ontologies`), or *No
ontologies pinned · Choose on Survey*. The brief version history and comparison still show
changes to the `ontologies` section; the Brief kept-draft no longer holds ontology edits (the
Survey card saves directly, as today).

### Overview

The mapping stage's "not used" status text points to Survey ("pin a vocabulary on Survey"),
`LIST_CACHE_VERSION` bumped if a list row's text changes.

## 4. Testing

- **Worker (unit, `tests/test_ontology_suggest.py`, table-driven):** merged copy vs modules
  (module picked, merged in `alsoMatched`); generic vs domain ontology; thresholds (a hit just
  below does not cover); pinned-first coverage; `MIN_GAIN` and `MAX_SUGGESTIONS` stops;
  tie-breaks; lexical only under a local policy with an external embedding model (no embed call,
  note); versions without embeddings; `library_key` against the shared fixture.
- **Worker (jobs):** a survey job writes the record; a raising suggestion step leaves a
  succeeded survey and the `ontology suggestions failed` event; a `suggest` job writes the
  record; invalid params → `needs_review`.
- **Worker (integration, Pg):** `lexical`/`semantic` return similarities.
- **Recall fixture:** a small library and survey whose expected suggestions pin the thresholds.
- **API:** GET (none, newest record, `stale` both ways, running, failed), POST (202, 409s,
  retired, one per project), survey params carry `library`/`pinned`, `deleteProject` removes
  suggest jobs, OpenAPI conformance, access sweep.
- **Shared:** schemas against the fixture; `ontologyLibraryKey` cases.
- **Web:** cards, evidence, Pin (brief saved with the pin), *Pinned ✓*, newer version, stale
  banner and Refresh, running poll, failure, no survey; the moved card on Survey; the Brief
  summary line and link.

## Consequences for the large-ontology limits (deferred decision)

Suggestions and the mapping stage both use vocabularies only through the term index
(`ontology_terms`, embeddings): a large vocabulary such as ChEBI costs index rows and per-query
work, never a whole-graph load. The only per-job whole-graph loads are SHACL shapes pins
(`shacl.load_graphs`). This supports raising the import limits for vocabularies
(`ONTOLOGY_MAX_TRIPLES`, upload size) while keeping shapes ontologies small, decided separately.
