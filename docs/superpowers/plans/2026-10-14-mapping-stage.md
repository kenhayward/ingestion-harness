# Brief Ontologies, Mapping Stage and Embeddings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** People choose a document type's ontologies in the Workbench brief, and a new optional drafting stage, `mapping`, asks the drafting model to propose the recipe's ontology mapping. The model chooses only from a shortlist that hybrid lexical and embedding retrieval draws from the chosen ontologies. People then accept the mapping change by change in a Mapping tab.

**Architecture:**
- **Brief and mapping changes:** the brief gains `ontologies` and `ontologyGuidance`. Mapping changes are new typed draft-change ops, applied identically in TypeScript and Python, held in step by the shared fixture.
- **Embeddings:**
  - Term embeddings live in Postgres (pgvector, built into our Alpine Postgres image).
  - The worker writes them at ontology import and in `embed` jobs, through a new provider method `embed` and a new pipeline setting, `embedding_model`.
- **Running the stage:** the API builds the stage's params (the brief's vocabulary versions, guidance, and the values observed in dev references and test runs). The worker shortlists candidate terms per output, asks the drafting model through a flat structured-output schema, and checks every IRI against the shortlist.

**Tech Stack:** TypeScript (Zod, Fastify, React), Python 3.13 (Pydantic, rdflib, psycopg, openai SDK), Postgres 17 with pgvector 0.8.0.

**Spec:** `docs/adr/0011-rdf-publishing-and-ontologies.md` and `docs/design/rdf-publishing.md`. The relevant sections are *The brief chooses ontologies*, *LLM-suggested mapping*, *Embeddings*, *Model output*, *Data policy*, *Review in the Mapping tab* and *Rollout* step 4.

## Global Constraints

- **Optional stage:** `mapping` is in `OVERVIEW_STAGES` after `steps` and in `OPTIONAL_STAGES`. It never blocks Publish and is never the required next step.
- **Not used:** with no vocabulary ontologies in the brief, the stage shows as not used.
- **Staleness:**
  - `mapping` is outside `STAGE_ORDER` and never makes other stages stale.
  - It is stale when the outputs stage completed after the mapping's completion (or keep), or when the brief's ontology selection or guidance changed after it.
  - It can be kept when stale (`KEEPABLE_STAGES` gains `mapping`).
- **Starting:** it cannot start before the outputs stage is complete (409 `complete the outputs stage first`), nor with no vocabulary ontology in the brief (409 `choose ontologies in the brief first`).
- **Brief:** `ontologies: [{ ontologyId, version, role: 'vocabulary' | 'shapes' }]` and `ontologyGuidance: string`, both defaulting to empty. `BRIEF_SECTIONS` gains `ontologies`, and `briefDiff` covers the list and the guidance.
- **Retrieval:**
  - Hybrid: lexical (trigram on labels and alt labels, full text on definitions) and semantic (cosine on embeddings), fused by reciprocal rank fusion with `k = 60`. 15 candidates per output.
  - The context is capped at `MAX_MAPPING_TERMS = 300`, dropping the worst-ranked candidates first.
  - A version with no embeddings for the current model is lexical only, and the proposal notes say so.
- **Embedding provider and setting:**
  - Embeddings come from `LLMProvider.embed(model, texts)`. Only the `openai-chat` and `openai-responses` kinds have it, calling `/v1/embeddings`; an `anthropic` endpoint cannot be the embedding model.
  - `embedding_model` is a pipeline setting in `llm_settings`, never a model choice.
- **Embedding terms:**
  - The term text is the label, alt labels, definition and parent labels, embedded in batches of 64.
  - Unchanged text is not embedded again (`text_sha256`).
  - Embedding never fails an import: a failure is a warn event.
  - Changing the `embedding_model` queues one `embed` job per ready version.
- **Data policy:**
  - A local-only project, or any vocabulary ontology that is `localOnly`, forces local models for drafting and embedding. An external drafting model is refused before any call. An external embedding model falls back to lexical retrieval.
  - Terms of a `localOnly` ontology are never embedded on an external endpoint.
  - External calls log `external model call` with the samples and the ontology versions whose terms were sent.
- **Model output:** a flat schema with no union types. Each change has an op, its target, a `confidence` (`high`/`medium`/`low`), a `reason`, and `evidence` (observed values).
  - Ops: `setDocumentMapping`, `putFieldMapping`, `putTableMapping`, `removeMapping`, `putLocalTerm`.
  - Every IRI must come from the candidates, or be a local term the same proposal declares. IRI templates name only values in scope. Both rules are fed back to the model.
  - `notes` come back with the proposal and are never applied.
- **Holdout:** holdout samples are never read for observed values.
- **Bundles:** the manifest gains optional `ontologies: [{ id, version, sha256 }]`. Import refuses a bundle whose ontologies are not in the library (matched by sha256) with 400 `bundle needs ontologies not in the library: …`.
- **Postgres image:** `deploy/docker/postgres.Dockerfile` (postgres:17-alpine with pgvector 0.8.0, built `with_llvm=no`) replaces `postgres:17-alpine` in compose and in the throwaway test databases.

## Review Focus

1. **A brief whose ontology version was later deleted or failed:** the mapping stage refuses to start with a clear 409. It must not shortlist from nothing or crash.
2. **An ontology with no embeddings for the current model (or no embedding model set):** retrieval is lexical only, the run still succeeds, and the proposal notes say so.
3. **A local-only project with an external embedding or drafting model:** no external call is made. Drafting is refused before any call, and embedding falls back to lexical.
4. **The model proposes an IRI outside the shortlist or the local terms, or a template naming an unknown variable:** the change is refused through `check`, fed back to the model, and never stored.
5. **The mapping stage kept, then outputs completed again:** it reads as stale again, the same rule as `stageStates`' `upTo`.

---

### Task 1: Brief ontologies (shared, API, web Brief tab, bundle)

**Files:**
- Modify: `packages/shared/src/workbench.ts` (`BriefBodySchema`, `EMPTY_BRIEF`), `packages/shared/src/brief.ts` (`BRIEF_SECTIONS`, `briefSectionText`, `same`), `packages/shared/src/bundle.ts` (manifest `ontologies`)
- Modify: `apps/api/src/routes/workbench-bundle.ts` (export: names the brief's ontology versions with sha256; import: refuses missing ones)
- Modify: `apps/web/src/workbench/BriefTab.tsx` (+ `brief.ts` helpers): an Ontologies section
- Test: `packages/shared/test/brief.test.ts`, `apps/api/test/workbench-bundle.test.ts`, `apps/web/test/BriefTab.test.tsx`

**Interfaces:**
- Produces:
  - `BriefOntologySchema = { ontologyId: string; version: int>0; role: 'vocabulary' | 'shapes' }`
  - `BriefBody.ontologies: BriefOntology[]` and `BriefBody.ontologyGuidance: string`
  - `vocabularyOf(brief: BriefBody): { ontologyId; version }[]`
  - `ontologySelectionKey(brief): string`: a stable JSON of the vocabulary picks and guidance, used by Task 7's staleness
  - `BundleManifest.ontologies?: { id; version; sha256 }[]`

- [ ] **Step 1: Write the failing tests.**
  - `brief.test.ts`:
    - `BriefBodySchema.parse({})` has `ontologies: []` and `ontologyGuidance: ''`;
    - `briefDiff` reports an `ontologies` section when a pick or the guidance changes. `briefSectionText(body, 'ontologies')` is `acme v1 (vocabulary)` per pick, one per line, then `Guidance: …` when set;
    - `ontologySelectionKey` ignores `shapes` picks and their order.
  - `workbench-bundle.test.ts`:
    - export records `ontologies` for every brief pick, with the version's sha256;
    - import with a manifest naming `{ id: 'acme', version: 1, sha256: 'x' }` and no such version is a 400 `bundle needs ontologies not in the library: acme v1`;
    - import succeeds when the library has that sha256.
  - `BriefTab.test.tsx`:
    - add an ontology (library select, ready versions only, role), and the saved brief contains it;
    - a newer ready version shows *update available*;
    - a `localOnly` ontology on an external project shows the note `mapping will use local models`.
- [ ] **Step 2: Run them.** Expected: FAIL. The keys are missing (Zod strict).
- [ ] **Step 3: Implement.** Add the schema fields with defaults. `same()` compares `ontologies` with `JSON.stringify` of the picks plus the guidance.
  - **Export:** the export job params need nothing new. The manifest is written by the worker, so the API passes `ontologies` in the export params and `bundle.ExportParams` gains `ontologies: list[{id, version, sha256}]` (default `[]`), written into `manifest.json`.
  - **Import:** check each entry against `OntologyRepo.get(id)` versions by sha256 before writing anything.
- [ ] **Step 4: Run them.** Expected: PASS. Also run `uv run pytest tests/test_bundle.py` (manifest key).
- [ ] **Step 5: Commit** `Brief: ontologies and guidance; bundles name the ontology versions they need`.

### Task 2: Postgres image, migration 0035

**Files:**
- Create: `deploy/docker/postgres.Dockerfile` (exists from setup), `db/migrations/0035_mapping_stage.sql`
- Modify: `deploy/docker-compose.yml` (postgres `build:` the Dockerfile, image `ingestion-postgres`), `CLAUDE.md` (throwaway test DB command: build `ih-postgres:pgvector`), `docs/design/rdf-publishing.md`
- Test: `apps/api/test/integration/workbench-pg.test.ts` (a `mapping` proposal, skip and confirm insert), `worker/tests/test_ontology_job.py` (Pg embedding row)

**Migration 0035:**
- `CREATE EXTENSION IF NOT EXISTS vector;`
- `ontology_term_embeddings`:
  - columns: `ontology_id text`, `version int`, `kind text`, `iri text`, `model_ref text NOT NULL`, `dims int NOT NULL`, `text_sha256 text NOT NULL`, `embedding vector NOT NULL`, `created_at timestamptz DEFAULT now()`;
  - primary key `(ontology_id, version, kind, iri, model_ref)`;
  - FK to `ontology_terms (ontology_id, version, kind, iri) ON DELETE CASCADE`.
- `llm_settings` name CHECK gains `'embedding_model'`.
- `jobs_task_check` gains `'embed'`. `jobs_document_or_project` allows `task = 'embed'` (document- and project-less, like `ontology`).
- Stage CHECKs gain `'mapping'`: `workbench_proposals_stage_check`, `workbench_stage_skips_stage_check`, `workbench_stage_confirms_stage_check`, `template_changes_stage_check`.

- [ ] **Step 1: Write the failing Pg test.** Insert a `mapping` proposal, skip and confirm. Run it on a fresh `ih-postgres:pgvector` container (port 55445). Expected: FAIL (CHECK violation).
- [ ] **Step 2: Write the migration.** Expected: PASS. Also check that `CREATE EXTENSION vector` succeeds in the image.
- [ ] **Step 3: Change compose and CLAUDE.md** (the throwaway DB command: `docker build -f deploy/docker/postgres.Dockerfile -t ih-postgres:pgvector deploy/docker`, then `docker run … ih-postgres:pgvector`).
- [ ] **Step 4: Commit** `Postgres with pgvector; migration 0035 (term embeddings, embed task, mapping stage)`.

### Task 3: Embedding provider and the `embedding_model` setting

**Files:**
- Modify:
  - worker: `worker/src/ingest_worker/llm/base.py` (protocol: optional `embed`), `llm/openai_providers.py` (`embed` on `_OpenAIBase`), `llm/endpoints.py` (`SETTINGS` gains `embedding_model`; `LiveModels.embedding_model`; `.env` `EMBEDDING_MODEL` seeds it);
  - shared and API: `packages/shared/src/llm.ts` (`LlmSettingsView.embeddingModel`, body), `apps/api/src/llm/repo.ts`, `apps/api/src/routes/llm.ts` (validation: offered, endpoint kind not `anthropic` → 409 `the embedding model needs an OpenAI-compatible endpoint`; a change queues `embed` jobs, Task 4);
  - web: `apps/web/src/models/ChoicesSection.tsx` (Pipeline models: *Embedding model*);
  - tests: `worker/tests/fakes.py` (`FakeProvider.embed`: deterministic vectors from text).
- Test: `worker/tests/test_providers.py`, `worker/tests/test_llm_endpoints.py`, `apps/api/test/llm.test.ts`, `apps/web/test/ModelsPage.test.tsx`

**Interfaces:**
- `LLMProvider.embed(model: str, texts: list[str]) -> list[list[float]]`. It is not on `AnthropicProvider`; callers check `hasattr`/`kind`.
- `LiveModels.embedding_model: str | None`
- `ModelRegistry.resolve_embedding(ref) -> tuple[LLMProvider, str, ProviderConfig]`: raises `ModelResolutionError` for a kind without `embed`.

- [ ] **Step 1: Write the failing tests.**
  - The stub OpenAI client asserts `embeddings.create(model=…, input=[…])` and returns vectors in input order.
  - The settings route accepts an offered ref on an `openai-chat` endpoint and refuses an `anthropic` one.
  - `seed_from_config` seeds `embedding_model` from `EMBEDDING_MODEL`.
  - The Models page shows and saves *Embedding model*.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Expected: PASS.
- [ ] **Step 4: Commit** `Models: embedding model setting and embed() on OpenAI-compatible providers`.

### Task 4: Term embeddings at import and in `embed` jobs

**Files:**
- Modify:
  - `worker/src/ingest_worker/ontology.py` (`embed_terms(store, version, provider, model, *, local_only, provider_location)`; called after `save` in `run_ontology_import`; `run_embed(job, deps, queue)`; `PgOntologyStore.terms_for_embedding`/`store_embeddings`/`embedding_model_index`);
  - `worker/src/ingest_worker/main.py` (task `embed`);
  - `apps/api/src/ontologies/repo.ts` (`createEmbedJobs(model): number`, one per ready version; `MemoryOntologyRepo` records them);
  - `apps/api/src/routes/llm.ts` (settings change → `createEmbedJobs`);
  - `worker/tests/fakes.py` (`MemoryOntologyStore` embeddings).
- Test: `worker/tests/test_ontology_embed.py`, `apps/api/test/llm.test.ts`

**Interfaces:**
- `term_text(term) -> str`: the label, then `Also: <alt labels>`, the definition, then `Parents: <labels>`.
- `OntologyStore.terms_for_embedding(id, version, model_ref) -> list[tuple[kind, iri, text_sha256 | None, text]]`
- `OntologyStore.store_embeddings(id, version, model_ref, rows: list[tuple[kind, iri, text_sha256, vector]])`
- `EMBED_BATCH = 64`. Job params: `{ ontologyId, version }`. The model is read from `LiveModels.embedding_model`.

- [ ] **Step 1: Write the failing tests.**
  - **Basic import:** an import with a fake embedding model stores a vector per term, in batches of 64. A second run embeds nothing (same sha).
  - **Changed term:** a changed definition re-embeds only that term.
  - **Failure:** an embedding failure is a warn event `embedding skipped` and the version is still `ready`.
  - **Policy:** a `localOnly` ontology with an external embedding endpoint embeds nothing and logs the reason.
  - **No model:** nothing happens.
  - **`embed` task:** embeds a ready version.
  - **API:** changing `embeddingModel` queues one `embed` job per ready version; unchanged queues none.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `PgOntologyStore.store_embeddings` upserts with `embedding = %s::vector` (a text literal `[…]`).
  - It then creates `ontology_term_embeddings_<sha8(model_ref)>` as an HNSW index on `((embedding::vector(dims)) vector_cosine_ops) WHERE model_ref = '<ref>'` if missing.
  - The index name and the ref are SQL-quoted with `psycopg.sql`.
- [ ] **Step 4: Run them.** Expected: PASS, plus the Pg test of `store_embeddings` on the pgvector container.
- [ ] **Step 5: Commit** `Worker: embed ontology terms at import and in embed jobs`.

### Task 5: Hybrid retrieval

**Files:**
- Create: `worker/src/ingest_worker/retrieval.py` (`fuse`, `Candidate`, `shortlist`)
- Modify: `worker/src/ingest_worker/ontology.py` (`PgOntologyStore.lexical(versions, query, kinds, limit)`, `.semantic(versions, model_ref, vector, kinds, limit)`, `.has_embeddings(versions, model_ref)`), `worker/tests/fakes.py` (Memory versions: token overlap, cosine)
- Create: `worker/tests/fixtures/mapping-recall/` (`ontology.ttl`, `cases.json`: output text, expected IRIs)
- Test: `worker/tests/test_retrieval.py`

**Interfaces:**
- `Candidate(iri, kind, label, definition, parents, domain, range, score, sources: frozenset[str])`
- `fuse(rankings: list[list[str]], k=60) -> list[tuple[str, float]]`
- `shortlist(store, versions, query_text, kinds, *, vector: list[float] | None, model_ref: str | None, k=15) -> tuple[list[Candidate], bool]`: the second value is `semantic_used`.

- [ ] **Step 1: Write the failing tests.**
  - `fuse` table: ties, a single ranking, empty input.
  - `shortlist` filters by kinds.
  - Recall@15 over the fixture with the fake embedder: lexical ≥ 0.6, hybrid ≥ lexical, semantic used only when embeddings exist.
  - Pg `lexical`/`semantic` against the pgvector container.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **Lexical SQL:** `greatest(similarity(lower(label), q), max similarity over alt_labels)` plus `ts_rank(to_tsvector('simple', definition), plainto_tsquery('simple', q))`, filtered by kinds and versions, `ORDER BY` the score.
  - **Semantic:** `ORDER BY embedding::vector(dims) <=> %s::vector(dims)` over `model_ref`.
  - `pg_trgm` exists (0032 uses `gin_trgm_ops`).
- [ ] **Step 4: Run them.** Expected: PASS.
- [ ] **Step 5: Commit** `Worker: hybrid term retrieval (trigram + full text + embeddings, RRF)`.

### Task 6: Mapping change ops (both sides)

**Files:**
- Modify: `packages/shared/src/drafting.ts` (ops, `STAGE_OPS.mapping`, `CHANGE_STAGES`, `changeTarget`, `applyChanges`), `packages/shared/src/workbench.ts` (`DRAFT_STAGES`, `AVAILABLE_STAGES`), `worker/src/ingest_worker/draft_changes.py`, `packages/shared/test/fixtures/draft-changes.json`
- Test: `packages/shared/test/drafting.test.ts`, `worker/tests/test_draft_changes.py`

**Ops:** each carries `reason`, `answers` (refused outside revise), and on mapping ops optional `confidence: 'high' | 'medium' | 'low'`, `evidence: string[]` and `alternatives: { iri; label; score }[]`.
- `setDocumentMapping { document: { class; iri }, ontologies: pins[], prefixes: Record }`. This creates `semantics` when absent (`EMPTY_SEMANTICS` shape) and sets the document, pins and prefixes.
- `putFieldMapping { field: id, mapping: OutputMapping }`
- `putTableMapping { table: id, mapping: TableMapping }`
- `removeMapping { id }`: a field id, a table id or `table.column`.
- `putLocalTerm { term: LocalTerm }`: replaces a term with the same IRI.

A field, table or local-term op on a recipe with no `semantics` creates one with an empty document class (validation then asks for it).

`changeTarget` keys:
- `semantics.document`;
- `semantics.fields.<id>`;
- `semantics.tables.<id>`;
- `semantics.local.<iri>`.

- [ ] **Step 1:** Add 8 fixture cases (each op; create semantics; remove a column; replace a local term) and the TS/Python tests. Expected: FAIL.
- [ ] **Step 2:** Implement both sides. Expected: PASS (`toStrictEqual` both ways).
- [ ] **Step 3: Commit** `Drafting: mapping change ops on both sides`.

### Task 7: Mapping stage state (shared) and migration-backed API routes

**Files:**
- Modify: `packages/shared/src/drafting.ts` (`mappingStage(...)`, `KEEPABLE_STAGES`), `packages/shared/src/overview.ts` (11 stages, `mapping` box, metrics, status text, `OPTIONAL_STAGES`, list `.length(11)`), `apps/api/src/routes/workbench.ts` (start: refusals and params; keep: mapping's `upTo`; overview inputs), `apps/api/src/routes/workbench-overview.ts`, `apps/api/src/workbench/list.ts` (`LIST_CACHE_VERSION` 6), `apps/api/src/workbench/mapping.ts` (new: `mappingInputs`)
- Test: `packages/shared/test/drafting.test.ts`, `overview.test.ts`, `overview-list.test.ts`, `apps/api/test/workbench-mapping.test.ts`, `workbench-stages.test.ts`, `workbench-overview.test.ts`, `workbench-retired.test.ts`

**Interfaces:**
- `mappingStage({ proposals, confirms, outputsCompletedAt, briefKeyAt }) -> StageView | null` (null = never run).
  - It is stale when `outputsCompletedAt` or `briefKeyAt` (when the brief's `ontologySelectionKey` last changed) is later than `max(completedAt, upTo)`.
  - A keep's `upTo` is `max(outputsCompletedAt, briefKeyAt)` as read.
- `mappingInputs(app, projectId) -> { versions: { id; version; localOnly; label }[]; guidance; observed: Record<outputPath, { value; count; snippet: string | null; sample: string }[]> }`.
  - Observed values come from verified dev references first, then the newest finished dev test runs (reviewed document, else draft), up to 20 distinct values per output.
  - A field's snippet is its `evidence`; table cells have none.
  - Holdout samples are never read.
- Start-route params add `mapping: mappingInputs(...)`. Refusals:
  - 409 `choose ontologies in the brief first`;
  - 409 `complete the outputs stage first`;
  - 409 `ontology X vN is not ready`.
- Overview: a `mapping` box with metrics (mapped outputs of total; last run). `not_used` when there are no vocabulary picks.

- [ ] **Step 1: Write the failing tests.** Cover:
  - `mappingStage` table: not run; accepted; stale after outputs; stale after a brief selection change; kept, then stale again;
  - the overview with 11 stages;
  - the start refusals and params (observed values: dev only, verified references first, a 20-value cap);
  - keep 201/409;
  - a retired refusal.

  Expected: FAIL.
- [ ] **Step 2: Implement.** Expected: PASS.
- [ ] **Step 3: Commit** `Workbench: the mapping stage (state, overview, start and keep)`.

### Task 8: Worker mapping stage

**Files:**
- Modify: `worker/src/ingest_worker/draft_stages.py` (`MAPPING_SCHEMA`, `convert_mapping`, `check_mapping`, `MAPPING`), `worker/src/ingest_worker/drafting.py` (`DraftParams.mapping`, `build_mapping_context`, `run_draft` mapping branch: retrieval, data policy, logging, notes)
- Test: `worker/tests/test_draft_stages.py` (union guard `(MAPPING.schema, 0)`, converter, check), `worker/tests/test_drafting.py` (mapping runs)

**Interfaces:**
- `MappingParams { versions: list[{id, version, localOnly, label}], guidance: str, observed: dict[str, list[{value, count, snippet, sample}]] }`
- `build_mapping_context(draft, brief, params, shortlists) -> str`, capped at `MAX_MAPPING_TERMS = 300` terms.
- `check_mapping(shortlist_iris: set[str]) -> Callable[[dict], list[str]]`
- The proposal body gains `notes: string[]` (TS `ChangeBodySchema` optional `notes`).

- [ ] **Step 1: Write the failing tests.**
  - **Schema:** zero union types.
  - **Conversion:** the flat changes map to ops with confidence, evidence and alternatives.
  - **Rejected changes:**
    - an IRI not in the shortlist or the local terms → a check message;
    - a template naming `{name}` on a field → a check message.
  - **Data policy and logging:**
    - a local project with an external drafting model → `DocumentError` before any call;
    - an external embedding model on a local project → lexical only, and the notes say so;
    - an external call event lists the samples and `ontologies`.
  - **No embeddings:** the note `retrieval was lexical only: …`.
  - **Holdout:** a sample filename not in the params is dropped from observed values.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.** Expected: PASS.
- [ ] **Step 4: Commit** `Worker: mapping stage (shortlists, flat schema, checks, data policy)`.

### Task 9: Web Mapping tab

**Files:**
- Create: `apps/web/src/workbench/MappingTab.tsx`, `apps/web/src/workbench/mapping.ts`
- Modify: `apps/web/src/router.ts` (`PROJECT_TABS`), `ProjectRail.tsx`, `ProjectPage.tsx`, `OverviewMap.tsx` (11th box in the free grid cell), `StagePanel.tsx` maps (`KEEP`, `DESCRIPTION`, `PROPOSE`, `NEXT`), `apps/web/test/fake-api.ts`
- Test: `apps/web/test/MappingTab.test.tsx`, `router.test.ts`, `ProjectRail.test.tsx`, `ProjectPage.test.tsx`, `OverviewMap.test.tsx`, `stage-ui.test.tsx`

The tab shows:
- a not-used banner linking to the Brief when there are no picks;
- **Ask the model** (`startStage('mapping')`);
- the proposal card: per change, a `Suggested · high` tag, reason, evidence values, *Alternatives* (the shortlist with scores), Apply N selected, and `notes`;
- **Keep** when stale;
- the current mapping (`MappingEditor` reused, read-only summary plus a link to the Recipe tab's Mapping sub-tab);
- **Sample graph** (the graph preview from `MappingEditor`).

- [ ] **Step 1: Write the failing tests.** Expected: FAIL.
- [ ] **Step 2: Implement.** Expected: PASS.
- [ ] **Step 3: Commit** `Web: Workbench Mapping tab`.

### Task 10: Docs, contracts, full check

- `CLAUDE.md`:
  - contract rows: brief ontologies, mapping ops (Drafting changes row), embeddings (Models row), the `embed` task (Job statuses row);
  - the Postgres image and the test DB command.
- Design doc: step 4 notes.
- `.env.example`: `EMBEDDING_MODEL`.
- Run `npm run check`, the worker suite and lint, and the Pg suites on the pgvector container. Then the final review, the fix pass, and a PR with Auto-fix and auto-merge.
