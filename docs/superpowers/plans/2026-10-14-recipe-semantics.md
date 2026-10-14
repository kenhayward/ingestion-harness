# Recipe Semantics, RDF Rendering and Linked Data Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rollout step 3 of ADR 0011. A recipe can map its outputs to ontology terms and choose
its delivered formats. The worker renders each document to Turtle using readable entity IRIs,
fact provenance and the deployment's base IRI, delivers it when the recipe asks, and previews it
on Workbench samples. Admins set the customer and base IRI in a Linked data panel.

**Architecture:**
- **Recipe contract:** a `semantics` block and a `delivery` block, defined on both sides and held
  in step by a shared fixture.
- **Validation:** `templateIssues` checks the mapping against the pinned ontology versions
  through `OntologyRepo`.
- **Rendering:** the worker renders with rdflib in a pure `rdf.py` (`render_graph`,
  `mint_entity_iri`, `to_turtle`). The base IRI comes from a `LinkedDataSettings` port.
  `render_document` adds a `graph` output (format `rdf`, key `.ttl`), and publishing filters
  outputs by `delivery.formats`.
- **Settings:** `linked_data_settings` and its history live in Postgres, behind an admin API and
  the `#/linked-data` page.
- **Previews:** graph previews are project `graph` jobs, like segment previews.

**Tech Stack:** Postgres 17, Python 3.13 (rdflib, pydantic), Fastify/TS (Zod), React.

**Spec:** `docs/design/rdf-publishing.md`, in particular these sections: *IRI policy and the base
IRI*, *Entity IRIs*, *The mapping in the recipe*, *Delivery formats per recipe*, *Rendering and
SHACL* (rendering part only), *Fact provenance*, *Graph previews*.

## Global Constraints

- **Effective base IRI:** the admin's `baseIri` if set, else
  `https://id.stocks-hayward.com/{customerSlug}/`. If neither is set, RDF is skipped with the
  event `graph skipped: set the customer on the Linked data page`, and CSV/JSON are still
  delivered.
- **Base IRI rules:**
  - https only, ending in `/`;
  - no query, fragment or userinfo;
  - at most 200 characters;
  - the host is not an IP literal, `localhost`, or a `.local`/`.test`/`.internal` name.
  - Warn on path words (`staging`, `test`, `dev`, `fuseki`, `sparql`, `ct-studio`, version
    numbers).
- **Changing the base after publishing:** once RDF has been published (any `job_outputs` row with
  `format = 'rdf'` and `stage = 'published'`), changing the effective base needs `confirm` equal
  to the new base. Otherwise the response is a 409.
- **IRI layout under the base:**

  | IRI | What it names |
  | --- | --- |
  | `doc/{sha256}` | the document |
  | `job/{job_id}` | the extraction job |
  | `graph/source/{sha256}/{typeId}` | the document's named graph |
  | `doc/{sha256}/page/{n}` | a page |
  | `doc/{sha256}/{typeId}/section/{sectionId}` | a recipe section |
  | `doc/{sha256}/fact/{typeId}/{outputPath}` | a fact's evidence |
  | `def/{typeId}/{id}` | default vocabulary |

- **Entity IRIs are readable** and minted only through `mint_entity_iri`. The filters are `slug`
  and `upper`. An empty key value means no triple.
- **CT Studio's own vocabulary:** `https://id.stocks-hayward.com/ns/ct#` (prefix `ct:`), fixed and
  independent of the customer base.
- **Literals:**

  | Recipe type | Literal |
  | --- | --- |
  | `text`, `enum` | `xsd:string` |
  | `integer` | `xsd:integer` |
  | `decimal` | `xsd:decimal` |
  | `date` | `xsd:date` |
  | `boolean` | `xsd:boolean` |
  | `list` | one triple per item |

  A value whose step recorded a normalisation issue is a plain literal, and its Evidence carries
  `ct:normalisationIssue`.
- **`delivery`:** absent means `[csv, json]`. `rdf` requires `semantics`. Drafts in the outputs
  bucket always get every format, because review reads `document.json`.
- **Term existence is checked by the API only** (`templateIssues`). The worker validates
  structure (Pydantic) and the shared fixture.
- **Out of scope:**
  - SHACL (step 5);
  - Fuseki (step 6);
  - `published_entities` and graph versions (step 6);
  - the LLM mapping stage (step 4).
- **Same rules as earlier steps:** TDD, OpenAPI for every route, admin routes reply `403 admins
  only` first, and every commit carries the attribution.

## Review Focus

1. **Recipe without semantics:** it must render and deliver exactly as before, with no graph
   output and no behaviour change.
2. **Recipe with RDF but no customer configured:** CSV and JSON are delivered, RDF is skipped with
   an event, and nothing fails.
3. **Corrected value:** a correction changes a readable entity IRI. This is accepted by design.
   The literal values must still be published.
4. **Unmapped outputs:** they fall back to the default vocabulary, so nothing is dropped
   silently. The API lists them as warnings, not errors.
5. **Base IRI change after RDF was published:** it needs `confirm`, and the history records the
   change.

---

### Task 1: Recipe contract: `semantics` and `delivery`

**Files:**
- `packages/shared/src/template.ts`: `SemanticsSchema`, `DeliverySchema`, `deliveryFormats`,
  `CURIE_PREFIXES`.
- `worker/src/ingest_worker/template.py`: `Semantics`, `Delivery`,
  `Template.delivery_formats()`.
- `packages/shared/src/definition-diff.ts`: subjects "the ontology mapping" and "the delivered
  formats".
- Fixture: `packages/shared/test/fixtures/template-semantics.json`, shaped as
  `[{name, definition, valid}]`.
- Tests:
  - `packages/shared/test/template.test.ts` and `worker/tests/test_template.py`: the fixture
    plus `deliveryFormats`;
  - `definition-diff.test.ts`: the subjects.

**Shape (both sides; strict / forbid):**
```yaml
semantics:
  ontologies: [{ id, version }]          # pinned library versions
  shapes: [{ id, version }]              # optional, step 5
  prefixes: { acme: "https://…/" }       # optional; rdf rdfs owl xsd skos dcterms prov built in
  document: { class: "acme:Protocol", iri: "doc/{source}" }   # iri optional, default doc/{source}
  fields:  { <fieldId>: Mapping }
  tables:  { <tableId>: { link: CURIE, class: CURIE, iri?: template, columns: { <colId>: Mapping } } }
  local: [{ iri, kind, label, definition? }]   # recipe-local terms
Mapping: { property: CURIE, object?: { class: CURIE, iri: template, label?: bool },
           concepts?: { scheme?: CURIE, values?: { <value>: CURIE }, match?: "label" } }
delivery: { formats: [csv|json|rdf] }        # non-empty, unique
```

**Superrefine (both sides):**
- field ids, table ids and column ids name existing outputs;
- `concepts.values` keys are the field's or column's enum values when its type is `enum`;
- `delivery.formats` includes `rdf` only with `semantics`;
- `object` and `concepts` are mutually exclusive.

**Fixture cases (about 10):**
- minimal valid; full valid; unknown field; unknown column; rdf without semantics;
- an enum key that is not a value; object plus concepts; empty formats; duplicate formats;
- an unknown key under `semantics`.

- [ ] Write the fixture and the tests; run both suites; expect FAIL.
- [ ] Implement both schemas, `deliveryFormats(t)` (TS) and `Template.delivery_formats()` (Py),
  each returning `['csv', 'json']` by default. Add the diff subjects.
- [ ] Run `npx vitest run --project shared`, `uv run pytest tests/test_template.py` and the lint.
  Expected: PASS.
- [ ] Commit: `Recipe contract: semantics (ontology mapping) and delivery formats`.

### Task 2: Linked data settings (migration, shared, API)

**Files:**
- `db/migrations/0034_linked_data.sql` creates:
  - `linked_data_settings`: a single row (`id boolean PK DEFAULT true CHECK (id)`) with
    `customer_name`, `customer_slug`, `base_iri` (nullable), `updated_by` and `updated_at`;
  - `linked_data_base_history` with `from_base`, `to_base`, `changed_by`, `changed_at` and
    `graphs_published`;
  - `job_outputs.format` CHECK widened to `('csv','json','rdf')`;
  - `jobs_task_check` widened to include `graph`.
- `packages/shared/src/linked-data.ts`:
  - `LinkedDataSettingsSchema`, `LinkedDataViewSchema` (settings, `effectiveBase`, `history`,
    `rdfPublished`) and `LinkedDataBodySchema` (`customerName`, `customerSlug`, `baseIri|null`,
    `confirm?`);
  - `FALLBACK_BASE_IRI = 'https://id.stocks-hayward.com/'`;
  - `effectiveBaseIri(s): string | null`;
  - `baseIriProblem(iri): string | null` and `baseIriWarnings(iri): string[]`;
  - `CUSTOMER_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/`.
- Fixture `packages/shared/test/fixtures/base-iri.json`: effective-base cases plus problem
  cases, shared with Python.
- `apps/api/src/linked-data/repo.ts`: `LinkedDataRepo` with Memory and Pg versions:
  - `get()`;
  - `save(next, by)`, which records history when the effective base changes;
  - `rdfPublishedCount()`;
  - `seed(fromEnv)`.
- `apps/api/src/routes/linked-data.ts` (tag `Linked data`, group Administration):
  - `GET /api/linked-data/settings` (admin);
  - `PUT /api/linked-data/settings` (admin): 400 for a bad slug or base, 409
    `<n> RDF outputs were published under <old base>: confirm the new base to change it`;
  - `GET /api/linked-data/base` (any user): `{ effectiveBase }`.
- `server.ts` seeds from `LINKED_DATA_CUSTOMER` (`slug=Name`) and `LINKED_DATA_BASE_IRI` when
  there is no row. Wire `AppDeps.linkedData` into the test helpers.
- Tests:
  - shared `linked-data.test.ts` (fixture);
  - API `linked-data.test.ts`: admin-only, validation, confirm flow, history, user base;
  - `integration/linked-data-pg.test.ts`.

- [ ] Write the tests; expect FAIL.
- [ ] Implement.
- [ ] Run the API project, `npm run openapi` and the Pg integration test (fresh database).
- [ ] Commit: `Linked data settings: customer and base IRI (admin)`.

### Task 3: Worker rendering (`rdf.py`)

**Files:** `worker/src/ingest_worker/rdf.py`, `worker/tests/test_rdf.py`, and `linked_data.py`
(`effective_base_iri`; the fixture test lives in `test_rdf.py`).

**Interfaces:**
- `mint_entity_iri(base, template_str, values) -> str | None` (`None` when a key value is empty)
  and `slug(value)`.
- `GraphContext(base: str, concepts: Callable[[str, str], str | None])`: the scheme and label
  give a concept IRI, for `match: label`.
- `render_graph(template, document, ctx) -> rdflib.Graph`. The document dict must carry
  `source_sha256`, `job_id`, `template`, `fields`, `tables`, `issues`, `models`, and optionally
  `review` and `published_at`.
- `to_turtle(graph) -> bytes`: deterministic, using the prefixes from `semantics.prefixes` plus
  the built-ins.
- Literal mapping by `ValueType`, entity objects with `rdfs:label`, concepts by value or label,
  and the default vocabulary for unmapped outputs.
- Evidence: one per field (page, quote, section, step) and one per table row (step, sections).
- Shared pages and sections, and provenance (`prov:wasGeneratedBy` job,
  `ct:recipe`/`ct:recipeVersion`, `prov:wasAssociatedWith` model choices, `ct:reviewedBy`,
  `prov:endedAtTime`, `dcterms:source <urn:sha256:…>`, `ct:baseIri`).

**Tests** (table-driven where possible; isomorphic comparison for a full small example):
- every `ValueType`, lists and empty values;
- entity IRIs with `slug` and `upper`, and an empty key giving no triple;
- concepts by value and by label, and an unmatched value (plain literal plus issue);
- the default vocabulary for unmapped outputs;
- a normalisation issue on Evidence;
- provenance;
- `to_turtle` stability across runs;
- the base-iri fixture.

- [ ] Write the tests; expect FAIL.
- [ ] Implement.
- [ ] Run the tests and lint.
- [ ] Commit: `Worker: render recipe outputs to RDF (readable IRIs, fact provenance)`.

### Task 4: Worker wiring: graph output, delivery, settings port

**Files:**
- `outputs.py`: `RenderedOutput.format` gains `"rdf"`; `content_type("rdf") = "text/turtle"`.
- `storage.py`: `output_key(..., "ttl")` for rdf.
- `template_pipeline.py`:
  - `render_document(template, document, graph=None)` adds `RenderedOutput("graph","rdf",…)`
    when `graph` is given and the template has semantics;
  - `process_template_job`, `rerun_template_job` and `publish_template_job` build the graph
    context and put `source_sha256` into the document (from `Source`; `Prepared` gains
    `sha256`);
  - the publish path filters by `delivery_formats`.
- `linked_data.py`:
  - `LinkedDataSettings` port with `PgLinkedDataSettings(conn)` and `effective_base()`;
  - `OntologyStore.concept_by_label(versions, scheme, label)` (Memory and Pg).
- `pipeline.PipelineDeps`: `linked_data: LinkedDataSettings | None = None`.
- `main.py` wiring.

**Tests:**
- `test_template_pipeline.py` additions:
  - a recipe with semantics plus a base gives a graph draft output (`.ttl`, `text/turtle`);
  - without a base, no graph output and a `graph skipped` event;
  - `delivery: [json, rdf]` publishes no CSVs;
  - a recipe without semantics behaves exactly as before.
- Pg test: `PgLinkedDataSettings`.

- [ ] Write the tests; expect FAIL.
- [ ] Implement.
- [ ] Run the full worker suite, lint and the Pg test.
- [ ] Commit: `Worker: graph output for mapped recipes; delivered formats`.

### Task 5: API: semantics validation, rdf outputs, graph previews

**Files:**
- `apps/api/src/templates/definitions.ts`: `templateIssues` adds `semanticsIssues`, with deps
  widened to include `ontologies`.
  - Pinned versions must exist and be ready.
  - Every CURIE must expand.
  - Each term must exist in a pinned version (or its imports, via `term()`), or be declared
    `local`, with a compatible kind (property kinds for `property` and `link`, class for
    `class`, concept for `values`, scheme for `scheme`).
  - Unmapped outputs are a warning: issues gain `severity?: 'warning'` and only errors block.
  - Steps 1–2 terms are found through `OntologyRepo.term(id, version, iri)`.
- `packages/shared/src/jobs.ts` and `results.ts`: output `format` gains `rdf`.
- Results and download routes: the content type for rdf is `text/turtle`.
- Graph previews:
  - `POST /api/workbench/projects/:id/graph-previews` with `{ sampleIds }` creates a `graph`
    job (project-scoped, priority -5, replacing the previous one under an advisory lock). Its
    params carry `{ samples: [{ sampleId, jobId }], definition }`, where each `jobId` is the
    sample's newest succeeded or awaiting-review dev test run, and `definition` is the open
    draft.
  - `GET …/graph-previews/:jobId` returns `{ jobId, status, error, result }`, where `result` is
    `{ samples: [{ sampleId, fileName, turtle, triples }] }` (`GraphPreviewViewSchema`).
- Worker `run_graph_preview`:
  - reads each run's `reviewed-document.json`, else its draft `document.json`;
  - renders with the definition's semantics and the effective base;
  - writes `graphs/{project}/{job}.json` (`graphPreviewKey`);
  - a missing base gives a `DocumentError`: `set the customer on the Linked data page`.
- Tests: the API (issues table, previews route), worker `test_graph_preview.py`, and the
  OpenAPI.

- [ ] Write the tests; expect FAIL.
- [ ] Implement.
- [ ] Run the API project, the worker tests and `npm run openapi`.
- [ ] Commit: `API: validate recipe mappings; graph previews; RDF outputs`.

### Task 6: Web: Mapping sub-tab, delivered formats, Linked data page

**Files:**
- `TemplateEditor.tsx` gains a Mapping sub-tab (`MappingEditor.tsx`):
  - pinned ontologies (pickers from `listOntologies`, ready versions only);
  - prefixes;
  - document class and IRI;
  - a table of fields, and of each table's columns, with property, entity and concepts editors,
    plus a *Find term* dialog (`TermPickerDialog`, searching `listOntologyTerms` across the
    pinned versions, filtered by kind);
  - local terms;
  - in embedded mode, *Preview on a dev sample*, which polls the graph preview and shows the
    Turtle.
- General tab: *Delivered formats* tick boxes. RDF is disabled with a reason until there is a
  mapping.
- `checks.ts`: `semantics.*` issues route to `mapping`, and `delivery` to `general`.
- `apps/web/src/linked-data/LinkedDataPage.tsx` at `#/linked-data`, admin only:
  - customer name and slug, the latter filled in from the name;
  - base IRI, with warnings and an effective-base preview of example IRIs;
  - RDF published count and history;
  - a confirm dialog when the change needs it.

  The page appears in the Admin nav and the `AccountMenu`, via the router, `derive.ts` and
  `App.tsx`.
- Client methods: `getLinkedData`, `saveLinkedData`, `getEffectiveBase`, `startGraphPreview`,
  `getGraphPreview`, plus fakes.
- Tests:
  - `MappingEditor.test.tsx`: map a field via the term picker, entity and concepts, warning
    routing;
  - `LinkedDataPage.test.tsx`: admin only, save, confirm flow, preview IRIs;
  - `TemplateEditor` delivered formats;
  - router.

- [ ] Write the tests; expect FAIL.
- [ ] Implement.
- [ ] Run the web project and typecheck.
- [ ] Commit: `Web: recipe Mapping tab, delivered formats, Linked data page`.

### Task 7: Docs, contracts and full check

- `CLAUDE.md` contracts rows:
  - recipe `semantics`/`delivery`;
  - linked data settings;
  - RDF rendering and outputs;
  - the `graph` task;
  - graph previews.
- The design doc gets step 3 implementation notes.
- `.env.example` and compose gain `LINKED_DATA_CUSTOMER` and `LINKED_DATA_BASE_IRI` (api).
- Run `npm run check`, the worker suite and lint, and both Pg suites.
- Final whole-branch review, then the fix pass, then a PR with Auto-fix and auto-merge on.
