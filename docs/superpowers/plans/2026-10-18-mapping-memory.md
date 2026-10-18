# Mapping Memory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployment-wide memory of the ontology mappings designers accepted, kept in the database, used by the Workbench mapping stage (and the per-output matcher) before any model call, and maintained by designers on the Ontologies page.

**Architecture:** The API records one vote per recipe and output whenever a designer accepts a mapping (a decorator over `TemplateRepo`, so every counting write is covered), plus refusals and reviews. The worker reads the memory through a store port, embeds signatures lazily (the API stays free of model calls), and uses exact matches to pre-select, fuzzy matches to hint and to extend the short lists. A shared signature normaliser keeps both sides in step.

**Tech Stack:** Zod (`packages/shared`), Fastify + Postgres (`apps/api`), Pydantic + psycopg + pgvector (`worker`), React (`apps/web`).

**Spec:** [docs/design/mapping-memory.md](../../design/mapping-memory.md) (PR #248), decisions in its section 10.

## Global Constraints

- **One branch, one PR** for the whole feature (CI is slow); no side sessions. Never enable auto-merge: a merge redeploys staging and stops its workers. The user merges.
- TDD per CLAUDE.md: a failing test first for every behaviour, run and seen failing for the expected reason; never weaken a test. Unit tests stay offline (`MemoryRepo`, `MemoryOntologyStore`, a new `MemoryMappingMemoryStore`, `FakeProvider`).
- **Cross-language contracts** (signature normaliser, remembered answers, the mapping change's `remembered` meta) change on both sides in this PR, held in step by shared fixtures run in both suites.
- **An empty memory changes nothing:** with no entries, the mapping stage's prompt, its schema and its answer are byte-identical to today (Task 0's characterisation tests stay untouched).
- No union types in `MAPPING_SCHEMA`; the memory adds nothing to the model's answer schema (pre-selected outputs are merged by the worker, not answered by the model).
- New routes are documented (OpenAPI), open to designers and admins, closed to operators (not in `operatorMayCall`). The migration is `db/migrations/YYYYMMDDHHMM_mapping_memory.sql` (UTC time of writing).
- UI text says **recipe**, never template. The new help topic gets its `HELP_INDEX` entry under Ontologies.
- `npm run check`, `npm run worker:test` and `npm run worker:lint` green before declaring done.

## Corrections to the design found while planning

1. **The production stage does not use the per-output matcher.** `run_mapping` makes one model answer; `mapping_match.propose` is used by the evaluation harness only. The memory is wired into `run_mapping` itself (pre-selected outputs are taken out of the model's job and merged back as typed changes) and, separately, into `propose` for the harness.
2. **No model calls in the API.** Signature embeddings are computed by the worker, lazily, when a mapping run or the harness looks the memory up (same data-policy rule as the survey's suggestions), stored per embedding model like `ontology_term_embeddings`.
3. **Stale is derived on read**, never stored: an entry is stale when a term is missing from, or deprecated in, the newest ready version of its ontology (a join on `ontology_terms`).
4. **The "conflicting answers need the table" rule** uses the table name stored on every vote, not a second signature key: the key leaves the table out unless the name is generic; at lookup, conflicting answers are narrowed to those voted from a table of the same name.
5. **Imports are recognised by the change log.** A write whose `template_changes.source` is `import` (YAML, bundle, GitHub) records no vote; `hand`, `proposal`, `restore` and a publish do. `started` copies a published version and changes no vote.
6. **Recipes outside the Workbench have no data policy**; their votes count as local-only (the safe side).

## Review Focus

1. **Empty memory, same behaviour** → Task 0 tests pass untouched at the end.
2. **Local-only wording never reaches an external model** → Task 7 `external_prompt_uses_only_external_wording` and `local_only_entry_is_not_hinted_to_an_external_model`.
3. **One vote per recipe and output; imports do not vote** → Task 3 tests.
4. **Refusals feed back**: a deselected or overwritten pre-selection records a refusal, and an answer refused more than accepted is only hinted → Tasks 4 and 7.
5. **Operators are refused** every new route → the roles sweep (`apps/api/test/roles.test.ts`) and access sweeps pass with the routes listed.

---

## File structure

```
db/migrations/YYYYMMDDHHMM_mapping_memory.sql         NEW: mapping_memory, mapping_memory_votes, mapping_memory_refusals, mapping_memory_embeddings
packages/shared/src/mapping-memory.ts                 NEW: signatureOf, GENERIC_NAMES, unit extraction, RememberedAnswerSchema, MappingMemoryEntrySchema, answersOf(definition)
packages/shared/src/drafting.ts                       mapping meta `remembered` (optional)
packages/shared/test/fixtures/mapping-signature.json  NEW: output -> signature key (both suites)
packages/shared/test/fixtures/remembered-answers.json NEW: semantics -> answers; answer -> typed change
packages/shared/test/fixtures/draft-changes.json      a mapping change with `remembered`
apps/api/src/mapping-memory/repo.ts                   NEW: MappingMemoryRepo (Memory + Pg): votes, refusals, reviews, list, stale
apps/api/src/mapping-memory/capture.ts                NEW: rememberingTemplates(repo, memory), recordRecipe, reconcileAll
apps/api/src/routes/mapping-memory.ts                 NEW: GET/POST /api/ontologies/memory, GET/PATCH/DELETE /api/ontologies/memory/:id
apps/api/src/routes/workbench.ts                      decision route notes deselected remembered changes; reset/delete project reconcile
apps/api/src/app.ts, server.ts                        wiring; reconcileAll after listening (like warmListCache)
apps/api/test/mapping-memory-contract.ts              NEW: repo contract (memory always; Postgres with IH_TEST_DATABASE_URL)
apps/api/test/mapping-memory*.test.ts                 NEW: capture, refusals, routes
worker/src/ingest_worker/mapping_memory.py            NEW: signature_of, GENERIC_NAMES, RememberedAnswer, MappingMemoryStore port, PgMappingMemoryStore, lookup, answer -> change
worker/src/ingest_worker/mapping_stage.py             shortlists (third ranking), hints, pre-selection, merge, `remembered` meta
worker/src/ingest_worker/mapping_match.py             memory in propose (harness)
worker/src/ingest_worker/mapping_eval.py              --memory deployment|self-loo|none
worker/src/ingest_worker/pipeline.py                  PipelineDeps.mapping_memory
worker/tests/fakes.py                                 MemoryMappingMemoryStore
worker/tests/test_mapping_memory.py                   NEW
apps/web/src/ontologies/RememberedMappings.tsx        NEW: the view (list, filters, confirm, edit, reject, delete, add)
apps/web/src/ontologies/OntologiesPage.tsx            tab: Library | Remembered mappings
apps/web/src/ontologies/TermDetailPanel.tsx           "Remembered for" list
apps/web/src/workbench/ (mapping proposal card)       "Remembered · N recipes" badge
apps/web/src/help/                                    OntologyMemoryHelp, topics.tsx, index.ts
CLAUDE.md, docs/design/mapping-memory.md              contract row, status
```

---

### Task 0: Safety net (characterisation, before any change)

- [ ] `test_mapping_stage.py`: with an empty memory store (and with `PipelineDeps.mapping_memory=None`), `run_mapping` on the fixture project produces the same prompt, schema and body as today (snapshot the current values first, then add the store parameter).
- [ ] API: publishing, hand saves and proposal decisions return the same responses with the memory wired in (existing route tests run unchanged).

### Task 1: The contract (both sides)

- [ ] Shared fixture `mapping-signature.json`: outputs (name, description, type, kind, table name) → signature key and unit. Cases: snake, camel and spaced names; units in parentheses (`(%)`, `(mg/g)`, `(CFU/g)`) taken out, non-units kept (`(KF)`); generic names (`Mean`, `Result`, `Total`, `Notes`) keyed with their table's name; the same *Batch number* in three tables → one key.
- [ ] `signatureOf` (TS) and `signature_of` (Python) pass it; `GENERIC_NAMES` identical on both sides (the fixture lists it).
- [ ] `RememberedAnswerSchema` / `RememberedAnswer`: form `literal|entity|concept|node|unmapped`, full-IRI terms (property, class, unit, value property, unit property, scheme; a table's link and row class); canonical answer key (stable JSON).
- [ ] `answersOf(definition)` (TS): a recipe's semantics → one answer per output path (prefixes expanded, value-node defaults resolved through the existing resolver), document class, value-node defaults. Fixture `remembered-answers.json` (cases from `template-semantics.json` and a value-node recipe); the worker test parses every answer and turns each into the typed mapping change `convert_mapping` would produce.
- [ ] Mapping change meta `remembered: { entryId, votes, status }` (optional, TS `mappingMeta`, worker change dict); `draft-changes.json` case; never written to the draft (`applyChanges` ignores it, like `confidence`).

### Task 2: Storage

- [ ] Migration: `mapping_memory` (id, kind, signature key, name, description, type, unit, answer jsonb, answer key, ontology ids, status `learned|confirmed|rejected`, reviewed by/at, note, created/updated; unique on signature key + answer key); `mapping_memory_votes` (template id, output path, entry id, version, table name, project policy, origin entry id (the remembered entry it was pre-selected from, if any), at; primary key template id + output path); `mapping_memory_refusals` (entry id, template id, output path, by, at); `mapping_memory_embeddings` (entry id, model, vector; primary key entry id + model). Cascades from `mapping_memory`.
- [ ] `MappingMemoryRepo` contract (`mapping-memory-contract.ts`, run on Memory always and on Postgres with `IH_TEST_DATABASE_URL`): `replaceVotes(templateId, votes)` is idempotent and moves votes between entries; an entry with no votes and no review is deleted; reviews survive vote changes; `addRefusal` once per recipe and output; `list({ ontology, status, q, page })` returns votes, refusals, ontology ids and derived `stale` (missing or deprecated in the newest ready version, via `ontology_terms`); retired ontologies' entries are hidden.

### Task 3: Capture (one vote per recipe and output)

- [ ] `rememberingTemplates(repo, memory)` wraps `TemplateRepo`: after `create`/`updateDraft` whose change source is `hand`, `proposal` or `restore`, after `publish`, after `deleteDraft`, and after `retire`/`unretire`, it calls `recordRecipe(id)`, which reads the recipe's newest version (open draft, else latest published), builds its answers with `answersOf` and replaces the recipe's votes. Its errors are logged, never fail the write.
- [ ] Tests: a hand save adds votes; a YAML or bundle import adds none until a later hand save; publishing an imported draft adds them; saving the draft again moves the recipe's vote (still one per output); deleting the draft falls back to the published version's answers; retiring removes the recipe's votes and unretiring restores them; a Workbench reset (skeleton draft) and a project delete remove its votes (they write through `WorkbenchRepo`, so their routes call `recordRecipe`).
- [ ] Each vote records its project's data policy (`workbench_projects.data_policy`; no project = local).
- [ ] `reconcileAll` (every recipe) runs after the API starts listening, like `warmListCache`; it is the backfill and repairs drift.

### Task 4: Refusals

- [ ] Proposal decision route: a mapping change carrying `remembered` that the designer leaves unselected records a refusal for that entry, recipe and output; an applied one records the vote with `origin entry`.
- [ ] `recordRecipe`: when an output's previous vote had an origin entry and the new answer differs or is gone, record a refusal for the origin entry.
- [ ] Tests for both; an entry's `refusals` and `votes` counts in `list`.

### Task 5: Routes

- [ ] `GET /api/ontologies/memory` (filters, paging), `GET /api/ontologies/memory/:id` (votes with recipe names and links, refusals, review history), `POST /api/ontologies/memory` (add by hand: signature fields + answer; status confirmed), `PATCH /api/ontologies/memory/:id` (`status` confirm/reject, edited answer (confirmed), note), `DELETE /api/ontologies/memory/:id`. Every write records `req.auth` name and time. Answers' terms must exist in the library (`OntologyRepo.termKinds`), else 400 naming the term.
- [ ] OpenAPI (tag Ontologies, summaries, descriptions, responses), conformance passes; `roles.test.ts`: operators get 403 on all; `access.test.ts` sweeps pass; `npm run openapi`.

### Task 6: The worker's store

- [ ] `MappingMemoryStore` port: `lookup(versions, outputs, *, embedder, external)` → per output path: exact entries (same signature key, terms present in the pinned versions; conflicts narrowed by table name), fuzzy entries (trigram on name and description, embedding over signature text; thresholds as constants), each with votes, refusals, status, stale and its shareable wording.
- [ ] `PgMappingMemoryStore` (integration-marked test on Postgres) and `MemoryMappingMemoryStore` in `tests/fakes.py` (same contract test, parametrised).
- [ ] Lazy embedding: missing signature vectors for the embedding model are computed and stored before a fuzzy lookup, only with a local model unless the project allows external models (as `run_suggestions`), with the `external model call` event when external.
- [ ] Data policy: `external=True` drops entries whose votes are all local-only and uses wording from an external-policy vote (`external_prompt_uses_only_external_wording`).

### Task 7: The mapping stage

- [ ] Short lists: remembered terms join `stage_shortlists` as a third ranking (`retrieval.fuse`, source `remembered`); a class label search misses is offered (test with the degradation-product case).
- [ ] Hints: each output with fuzzy entries gets one line ("Accepted for … in N recipes (confirmed): …"); `local_only_entry_is_not_hinted_to_an_external_model`.
- [ ] Pre-selection (greedy): an exact, not stale, not rejected entry, refused in no more recipes than accepted, is taken out of the model's job and returned as a typed change with `remembered` meta: high confidence when confirmed or two or more votes agree, medium for one vote; conflicts: the confirmed answer wins, else the most net votes (medium), the others as `alternatives`. Rejected answers are removed from the outputs' short lists. Tables pre-select their link and row class the same way.
- [ ] Remembered defaults (document class, value-node defaults for the same pinned ontology set) pre-fill `setDocumentMapping` when the model leaves them out or the recipe has none.
- [ ] The model's answer and the pre-selected changes merge into one body; `convert_mapping` accepts remembered terms like short-listed ones (they are in the pinned versions); a model change for a pre-selected output is dropped with a note in the model log.
- [ ] Every outcome table-tested with `FakeProvider` and `MemoryMappingMemoryStore`; the model log records which outputs came from memory.

### Task 8: The per-output matcher (harness)

- [ ] `propose(..., memory=)`: exact entries answer the output without a model call (counted in the harness's calls saved), fuzzy entries join the options; same greedy and refusal rules as Task 7 (shared helper).

### Task 9: Evaluation

- [ ] `mapping_eval --memory none|deployment|self-loo`: `deployment` reads the database store, leaving out the gold's own recipe; `self-loo` seeds a `MemoryMappingMemoryStore` from the gold's answers for every other table and scores each table with its own answers left out (no database needed, runs on staging as today).
- [ ] Report adds memory hits, pre-selected and right, and model calls saved; tests on the synthetic gold.
- [ ] Run `self-loo` on the covalidation gold (27B model) and record it in `mapping-automation.md`.

### Task 10: The web

- [ ] Ontologies page: tabs *Library* and *Remembered mappings*; the view lists entries (wording, answer in words with term labels, ontology, used by N recipes with links, status, stale reason, last review), filters (ontology, needs review / confirmed / rejected, search), actions Confirm, Edit (the Mapping editor's term pickers), Reject, Delete, and *Add a mapping*. `fakeApi` methods; tests by role and label.
- [ ] Term detail panel: *Remembered for* list with links to entries.
- [ ] Workbench mapping proposal cards: a *Remembered · N recipes* badge (and *confirmed*), linking to the entry.
- [ ] Help: `OntologyMemoryHelp` topic in `HELP_TOPICS`, `HELP_INDEX` under Ontologies, the `?` on the view's header; the Mapping help mentions remembered answers and how refusing works.

### Task 11: Docs

- [ ] CLAUDE.md: a contract row *Mapping memory* (normaliser, answers, `remembered` meta, migration, store port, capture decorator, routes), the Ontologies and Workbench mapping lines.
- [ ] `docs/design/mapping-memory.md` status: implemented; corrections above folded in.

### Task 12: Verify and hand over

- [ ] `npm run check`, `npm run worker:test`, `npm run worker:lint`; the repo contract and `PgMappingMemoryStore` on a throwaway Postgres (`IH_TEST_DATABASE_URL`, `ih-postgres:pgvector`).
- [ ] Open the PR without auto-merge; after the user merges and staging deploys, a mapping run on a second project shows remembered answers from covalidation.
