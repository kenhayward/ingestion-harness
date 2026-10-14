# RDF publishing: ontology library, recipe mapping and Apache Jena Fuseki

**Status:** accepted · 2026-10-14 · [ADR 0011](../adr/0011-rdf-publishing-and-ontologies.md)

Content Transformation Studio (CT Studio) publishes approved documents as CSV and JSON to an S3
target. This design adds a second, semantic endpoint, built from these parts:
- **Ontology library:** admins import customer and industry ontologies into a library that
  everyone can browse.
- **Brief:** a Workbench brief names the ontologies that apply to its document type.
- **Mapping:** a model suggests how the recipe's outputs map onto those ontologies, based on
  what the samples actually contain, and a person accepts or edits each suggestion.
- **Publishing:** every approved document of a mapped type is published as RDF to the S3
  target and to an Apache Jena Fuseki triple store, after it passes the customer's SHACL
  shapes.

## Scope decisions (agreed 2026-10-14)

| Question | Decision |
| --- | --- |
| Ontology artefacts | OWL/RDFS (Turtle, RDF/XML, JSON-LD, N-Triples), SKOS, SHACL; upload **and** fetch by URL (with `owl:imports`) |
| Mapping depth | Schema mapping plus value linking: classes and properties for outputs, SKOS concepts for controlled values, IRI templates for entities. No cross-document entity resolution |
| Library | Shared, deployment-wide, admin-managed, tagged by customer or industry; a project's brief picks pinned versions |
| Visualisation | Class/property browser, interactive neighbourhood graph, mapping view, sample document graph |
| SHACL failures | Violations are review reasons; invalid graphs are never delivered |
| Opt-in | Per recipe: delivered formats are chosen per recipe (`delivery.formats`, any of CSV, JSON, RDF; default CSV and JSON, as today). RDF needs a mapping |
| Chaining types | Direction chosen, not built this phase: follow-on types (`then`), chains of any length (A → B → C) and branches; each link reads upstream reviewed values and is reviewed on its own; a chain is withdrawn as one atomic unit |
| Fact provenance | Every published fact links to its page, quote, section and step (`ct:Evidence`); structural links publish their sections, and all types share the page nodes |
| Data policy | Mapping follows the project's data policy; a `localOnly` ontology also forces local models |
| TBox in Fuseki | Yes: one named graph per ontology version |
| Graph identity | One graph per original document (the uploaded file's sha256) **and document type**, however often it is processed; the newest publish replaces it, a version number is kept from day one, and the document node `doc/{sha256}` is shared across types |
| Entity IRIs | Readable (`batch/site-1/pv-2301`), with five safeguards that keep a later move to registered surrogate IDs non-breaking |
| Consumer access | One shared read-only SPARQL user for now |
| Ontology licensing | Library ontologies (IDMP-O etc.) are exposed to customers as ontology graphs |
| Retrieval | Hybrid lexical and embedding search, shipped in the mapping-stage PR |
| Deletion and retirement | Deleting a job or retiring a type withdraws its graphs **and** its published S3 outputs |
| Corrections | Replace the graph for now; record a version for future history |
| Base IRI | The published data belongs to the customer: one customer per deployment, under the customer's own domain, set by an admin in a new Linked data panel; when none is set, `https://id.stocks-hayward.com/{customer}/` |

## Goals and non-goals

**Goals**
- Import, version, search and view ontologies (OWL/RDFS, SKOS, SHACL), from a file or a URL.
- Let a brief say which ontologies apply, with guidance in plain words.
- Have a model propose a mapping from the recipe's outputs, the real extracted values and
  retrieved ontology terms. A person accepts each change, as in the other drafting stages.
- Keep the mapping in the recipe: versioned, immutable once published, validated in TS and in
  Python, logged in the change log, included in YAML export and bundles.
- Render a sample's graph before publishing, and validate it with SHACL.
- Publish each approved document as Turtle to S3 and as a named graph to Fuseki, with
  provenance. Retries must be safe.

**Non-goals (for now)**
- Resolving entities across documents or against reference data (for example matching
  "Paracetamol" to a substance registry IRI). IRIs come from deterministic templates only.
- OWL reasoning or inference in Fuseki.
- Very large terminologies such as SNOMED CT or full MeSH (capped, see *Limits*).
- Changing extraction prompts from the ontology, for example deriving enums from SKOS schemes.
  The mapping stage may suggest such output changes as notes only.
- Legacy `spec.yaml` types.

## How it works

```
 admin ──import (file|URL)──▶ API ──stores source──▶ runs bucket ontologies/{id}/{v}/source.*
                                │  queues `ontology` job
                                ▼
                         worker: parse (rdflib), resolve owl:imports, index terms
                                │  ontology_terms (Postgres), TBox graph → Fuseki
                                ▼
 Workbench brief ──selects pinned versions + guidance
                                │
 mapping stage (draft job) ── outputs + dev values + shortlisted terms ──▶ LLM
                                │  proposal: typed mapping changes (confidence, alternatives)
                                ▼
 person accepts ──▶ recipe draft `semantics` block ──▶ graph previews (sample graph + SHACL)
                                │
 publish recipe vN ──▶ production jobs: extract → render graph → SHACL ──▶ review if violations
                                │
 approve ──▶ publish task: edits → render → SHACL → S3 (csv/json/ttl) → Fuseki GSP PUT
```

## IRI policy and the base IRI

**Decided (2026-10-14):** the published data belongs to the customer, so its IRIs live under
the customer's domain. Each deployment serves one customer. An admin sets the customer and their
base IRI in a new **Linked data** panel. When no base is set, the deployment falls back to our
identifier domain, `https://id.stocks-hayward.com/`.

### The effective base
- **Customer base** (preferred): the admin's `baseIri`, for example
  `https://data.acme.example/ct/`. The customer owns the domain and decides whether and how its
  IRIs resolve.
- **Fallback:** `https://id.stocks-hayward.com/{customerSlug}/`.
  - **Why a slug:** each deployment has its own database, so without a per-customer path,
    entity IRIs from two customers' deployments (`batch/pv-2301`) would be identical and merge
    when anyone combines the data.
  - **What we commit to:** we reserve `id.stocks-hayward.com` for identifiers only and keep its
    paths stable. Resolving them (303 redirects to a description) can come later.
- **No customer slug and no base:** RDF publishing is off for the deployment. A publish skips
  the graph with the event `graph skipped: set the customer on the Linked data page`, so CSV
  and JSON are still delivered. Graph previews still render, using the placeholder
  `https://id.stocks-hayward.com/unset/` and saying so.

`effectiveBaseIri(settings)` (`packages/shared/src/linked-data.ts`) and
`rdf.effective_base_iri` (worker) compute the same answer, held in step by the shared fixture
`base-iri.json`.

### Layout under the base
```
{base}doc/{sha256}                    the original document (its uploaded file's sha256)
{base}job/{job_id}                    provenance activity
{base}graph/source/{sha256}/{typeId}  the named graph of one original document under one document type
{base}graph/ontology/{id}/{version}   an ontology version's graph (TBox)
{base}{entity}/{key}                  entities from recipe IRI templates (batch, substance, …)
{base}def/{typeId}/{term}             default vocabulary and recipe-local terms
```
A recipe may still give an absolute IRI template, for example when a customer mandates a
separate namespace for one kind of entity. Entity keys must be scoped (for example
`batch/{site|slug}/{batch_number|slug}`) so that values that repeat across sites or
manufacturers do not collide.

### Entity IRIs: readable, with five safeguards

**Decided (2026-10-14):** entity IRIs are readable (`batch/site-1/pv-2301`), built from the
scoped key with the `slug` filter. That choice exposes the values in identifiers, which is
accepted. A later move to a **registry of surrogate IDs** (a stored, minted IRI per scoped key,
which survives corrections and allows merges) must stay non-breaking. The registry would adopt
every readable IRI already published as the registered IRI for its key, so existing entities
keep their IRIs. Five safeguards keep that move cheap:

1. **Identifying values are always published as literals.** Every minted entity also carries
   the values its key was built from (the mapped properties, for example `acme:batchNumber
   "PV-2301"`) and an `rdfs:label`. `semanticsIssues` refuses an entity mapping whose IRI
   template uses a value that no mapped property publishes. So the registry can always be
   rebuilt from the graphs, and consumers never need the IRI to know what an entity is.
2. **Every entity's scoped key is recorded when it is published.**
   - **Where:** `published_entities` (`iri` primary key, `kind`, `scoped_key` as the ordered
     key values in JSON, `first_published_at`) and `published_entity_sources` (`iri`,
     `sha256`, `template_id`, `job_id`). Both are written in the publish transaction and
     removed with a withdrawal when no other source still mentions the entity.
   - **Why:** this is the registry's seed. Without it, building the registry later would mean
     re-deriving keys from old IRI templates.
3. **One minting function.** Every entity IRI comes from `rdf.mint_entity_iri(kind,
   scoped_key, template)`, used by the renderer, graph previews, the rebuild and backfill
   alike. Moving to a registry swaps its implementation (look up, else mint and record) behind
   the same call. Recipes, templates and the publish path do not change.
4. **Consumers are told that IRIs are opaque.** The consumer documentation (rollout step 7)
   says to find entities by their literal values and never to parse meaning out of an IRI,
   whatever it looks like. The Linked data panel repeats this next to the endpoint.
5. **Correction history is kept.** Review edits already record old value → new value per
   field and cell, and graph versions keep each published Turtle (see *Graph identity and
   versions*). A future registry uses both to recognise that `PV-23O1` became `PV-2301` and
   re-point the key instead of minting a second entity.

What readable IRIs rule out is only this: making *existing* IRIs non-revealing later. That would
mean re-minting them, the same operator rebuild as a base change, and a breaking change for
consumers.

### Rules for a base IRI
`LinkedDataSettingsSchema` checks these; the API refuses anything else with a 400 naming the rule:
- an absolute `https` IRI that ends in `/`, with no query, fragment or user info, at most 200
  characters;
- a host name, never an IP address, `localhost` or a `.local`/`.test`/`.internal` name;
- not a CT Studio, Fuseki or SeaweedFS address of this deployment (the API compares it with
  its own public origin and `RDF_ENDPOINT`), because identity must not depend on where the data
  is hosted;
- the panel also warns, without refusing, when the path contains an environment or product
  word (`staging`, `test`, `dev`, `fuseki`, `sparql`, `ct-studio`, a version number).

Staging is its own deployment with its own setting. Use a separate base (for example
`https://data-staging.acme.example/ct/`) or a separate fallback slug (`acme-staging`), so test
graphs can never pass for production data.

### Storage (migration `linked_data_settings`)
- **`linked_data_settings`:** a single row (`id boolean PRIMARY KEY DEFAULT true CHECK (id)`)
  with `customer_name`, `customer_slug` (`^[a-z0-9][a-z0-9-]{1,62}$`), `base_iri` (null = the
  fallback), `updated_by` (token label) and `updated_at`.
- **`linked_data_base_history`:** append-only, one row per change of the effective base:
  `from_base`, `to_base`, `changed_by`, `changed_at`, and `graphs_published` (the number
  published under `from_base`).
- **Seeding:** `LINKED_DATA_CUSTOMER` (`slug=Name`) and `LINKED_DATA_BASE_IRI` in `.env` seed
  the row on API start only when there is none, so a deployment can come up preconfigured.
  After that the panel wins, as for LLM endpoints (ADR 0010).

### How the base is used
- **Read once per job:** the worker reads the effective base when a process or publish task
  starts, so one document never mixes two bases.
- **Recorded:** the base appears in the provenance (`ct:baseIri`) and in the
  `graph published` event.
- **Ontology graphs:** TBox graph IRIs use the base too.

### Changing the base after publishing
IRIs are identities, so changing the base re-mints every IRI for consumers.
- **Before any graph is published:** the base can be changed freely.
- **After that:**
  - **Confirm:** `PUT` needs `confirm` equal to the new effective base. Without it the answer
    is a 409:
    `<n> graphs were published under <old base>: confirm the new base to change it`.
  - **Effect:** the change applies to new publishes only, and the panel says so.
  - **Re-minting:** published graphs keep their old IRIs until an operator runs
    `python -m ingest_worker.rdf_rebuild --remint`. That re-renders every published document
    from its `reviewed-document.json` under the new base, overwrites the `.ttl` in S3, drops
    the old graphs and reloads the ontology graphs.
  - **No `owl:sameAs` links** from old to new IRIs. Consumers are told through the history.
- Every change is logged as `linked data base changed` and recorded in the history.

### Admin panel: Linked data
- **Web:** `apps/web/src/linked-data/LinkedDataPage.tsx`, route `#/linked-data`.
  - **Who sees it:** admins only. It sits in the Admin nav and the admin `AccountMenu` (Models,
    Linked data, Access, Sign out). Users never see the entry, and the route shows the usual
    admin-only notice.
  - **Customer:** name and slug. The slug is filled in from the name until it is edited.
  - **Base IRI:** an input whose placeholder shows the fallback for the current slug. The rule
    warnings appear inline.
  - **Effective base preview:** example IRIs for a document, an entity
    (`batch/site-1/pv-2301`), a graph and a vocabulary term. The preview updates as you type.
  - **Status:** graphs published under the current base (count, last publish), and whether the
    worker has a Fuseki endpoint (from the newest `graph published` or `graph skipped` event).
  - **History:** past bases, who changed them and when, and how many graphs each had.
  - **Save:** when graphs exist, Save opens a confirm `Dialog`. You type the new base to
    confirm, and the dialog explains that re-minting is a separate operator step.
- **API** (tag `Linked data`):

  | Route | Access | Purpose |
  | --- | --- | --- |
  | `GET /api/linked-data/settings` | admin | Settings, effective base, history, published counts |
  | `PUT /api/linked-data/settings` | admin | Save the customer and base (rules above; `confirm` after publishing) |
  | `GET /api/linked-data/base` | any signed-in user | The effective base only, so the Mapping tab and graph previews can show real example IRIs |

  The access sweep and the OpenAPI conformance tests cover all three routes (`x-admin` on the
  first two).

## Ontology library

### Model (migration `0032_ontologies.sql`)

- **`ontologies`:** `id` (slug), `label`, `description`, `tags text[]` (for example
  `industry:pharma`, `customer:acme`), `local_only boolean`, `created_by`, `created_at`.
- **`ontology_versions`:**
  - identity: `ontology_id`, `version int`, `ontology_iri`, `version_iri`;
  - source: `source_kind upload|url`, `source_url`, `media_type`, `sha256`, `bytes`;
  - parse: `status queued|parsing|ready|failed`, `error`, `stats jsonb` (triples, classes,
    properties, concepts, shapes), `imports jsonb` (each `owl:imports` IRI and what resolved it:
    a library version, a fetched URL, or unresolved);
  - `kinds text[]` (`owl`, `skos`, `shacl`, detected from content);
  - `license` (`dcterms:license` or `cc:license` from the source, else entered at import),
    shown in the browser: library ontologies are exposed to customers as ontology graphs
    (decided), and the importing admin is responsible for the licence allowing it;
  - `imported_by`, `imported_at`.

  A `ready` version is immutable (trigger, as for published templates). Importing new content
  under an existing id creates the next version, and importing identical content (same
  `sha256`) is refused with a 409 that names the existing version.
- **`ontology_terms`:** one row per term of a ready version.
  - identity: `ontology_id`, `version`, `iri`, `kind` (`class`, `object_property`,
    `datatype_property`, `annotation_property`, `concept`, `scheme`, `shape`);
  - names: `label` (preferred `skos:prefLabel` or `rdfs:label`, English first), `alt_labels
    text[]`, `definition` (`skos:definition`, `rdfs:comment`, `IAO:0000115`);
  - structure: `parents text[]` (`rdfs:subClassOf`, `rdfs:subPropertyOf`, `skos:broader`),
    `domains text[]`, `ranges text[]`, `scheme` (for a concept), `deprecated`;
  - tree: `root` (no parent in its group, or unreachable from one, so cycles stay findable)
    and `child_count`, both computed by the worker at import;
  - `defined_in` (the version that defines the term, when it was pulled in by an import;
    rollout step 2).

  A trigram index on `lower(label)` serves search (labels, synonyms and IRIs match, exact and
  prefix first); a full-text index on the definition comes with mapping retrieval.
- **`ontology_usage`** is a view, not a table: the recipes, briefs and published versions that
  pin each ontology version. Deleting a version is refused while anything published uses it;
  an unused version can be deleted. Retiring an ontology (`retired_at`) hides it from brief
  pickers without breaking pinned uses.

Object keys (runs bucket; `ontologySourceKey`, `ontologyNormalizedKey` /
`storage.ontology_normalized_key`):
- `ontologies/{id}/sources/{sha256}.{ext}`: the file as received, named by its bytes, so the
  API stores it before the transaction that creates the version and its job;
- `ontologies/{id}/v{version}/normalized.nt`: canonical N-Triples, used for the Fuseki load and
  for rebuilds.

Implemented in rollout step 1 (file upload): migration 0032, the `ontology` job (document- and
project-less: `jobs_document_or_project` allows it), `PgOntologyStore`, `OntologyRepo`, the
routes below and the Ontologies pages. Deleting a version is allowed whenever it is not being
imported; the usage check arrives with recipe mappings.

Implemented in rollout step 2 (migration 0033):
- **URL imports:** `POST /api/ontologies/from-url` (admin, JSON `{ id, url, label?, … }`)
  creates a version with no bytes (`source_kind = 'url'`); the worker fetches it. The import
  dialog reads the allowed hosts from `GET /api/ontology-settings`.
- **Fetching** is `ontology_fetch.fetch_rdf`: https only, a host on `ONTOLOGY_FETCH_ALLOW`
  (exact, or `.example.org` for a domain and its subdomains), every resolved address public,
  each redirect (at most 5) checked again, `ONTOLOGY_MAX_BYTES` and a 60 s timeout. The vetted
  address is not pinned for the request, so DNS rebinding remains possible for an allowlisted
  host: the allowlist is what bounds it.
- **Imports:** each `owl:imports` is resolved once per job, at most 3 levels down, never back
  up the import path: a ready library version (by ontology or version IRI), else a fetch that
  creates a library ontology (`source_kind = 'import'`, tag `imported-by:<root>`, id from the
  IRI). An import that cannot be resolved is listed with its reason and never fails the job.
- **Indexing:** a version's terms are indexed with its import closure's; imported terms carry
  `defined_in` (`"<id>@<version>"`), and `stats.imported` counts them. A version created for an
  import is indexed with its own closure too.
- **Graph view:** `GET …/neighbourhood?iri=&depth=1|2` returns at most 150 nodes; the web draws
  it with Cytoscape.js (loaded on first use) and lists the same links as text.

Implemented in rollout step 3 (migration 0034):
- **Recipe contract:** `semantics` (`SemanticsSchema` / `template.Semantics`) and `delivery`
  (`formats`, default CSV and JSON) on both sides, held in step by
  `packages/shared/test/fixtures/template-semantics.json`. The output id `graph` is reserved.
- **Validation** (`apps/api/src/templates/semantics.ts`, inside `templateIssues`): pinned
  versions exist and are ready, every CURIE expands, every term is in a pinned version (imports
  included, one `termKinds` query) or declared `local`, with a kind that fits its position.
  Terms of the built-in vocabularies (rdf, rdfs, owl, xsd, skos, dcterms, prov) need no pin.
  Unmapped outputs are warnings (`severity: 'warning'`), which never block publishing. IRI
  templates may name only the values in scope (document: `source`, `type`, `version`; a field's
  entity: `value`; a row: its columns; a column's entity: `value` and the columns) with the
  filters `slug` and `upper`; base IRIs, namespaces, terms and template text cannot carry
  characters an IRI cannot (`IRI_UNSAFE`); matching concepts by label needs a scheme.
- **Linked data settings:** `GET|PUT /api/linked-data/settings` (admin) and
  `GET /api/linked-data/base`; `.env` `LINKED_DATA_CUSTOMER=slug=Name` and
  `LINKED_DATA_BASE_IRI` seed them once. Changing the effective base after RDF was published
  needs `confirm` and is recorded in `linked_data_base_history`.
- **Rendering** (`worker/src/ingest_worker/rdf.py`): one graph per (source sha256, type).
  Entity IRIs come from `mint_entity_iri` (filters `slug`, `upper`; an empty key value gives no
  triple). Rows without an IRI template, or with an empty key, are named
  `doc/{sha256}/{type}/{table}/{n}` (stable across publishes, unlike blank nodes). Each fact has
  a `ct:Evidence` (page, quote, section, step) and a value that failed normalisation, or that no
  concept or IRI matched, is published as written with `ct:normalisationIssue`. Models are
  recorded as `ct:model` literals until model IRIs exist.
- **Outputs:** a mapped recipe drafts `graph` (`.ttl`, `text/turtle`, format `rdf`) once a base
  is set; without one the job logs `graph skipped: set the customer on the Linked data page` and
  delivers the rest. Publishing (approval and the no-review path) delivers only
  `delivery.formats`. The graph never costs the other outputs: when RDF is not delivered, a
  graph that cannot be rendered or serialised is a `graph failed` event and no graph; when it is
  delivered, that failure goes to review, and so does a recipe delivering only RDF while no base
  is set.
- **Graph previews:** `POST /api/workbench/projects/:id/graph-previews` queues a `graph` job
  (project-scoped, `priority = -5`, one per project) over each dev sample's newest finished
  test run; the worker writes `graphs/{project}/{job}.json`. Like segment previews, these jobs
  are skipped when a project is switched to local-only, and deleting the project removes
  `graphs/<id>/`.
- **Web:** the recipe editor's Mapping sub-tab (pins, prefixes, document class and IRI, each
  output as a literal, entity or concept, local terms, the term picker, and the preview in the
  Workbench), Delivered formats on General, and the Linked data page (`#/linked-data`, admins).

Implemented in rollout step 4 (migration 0035):
- **Brief:** `ontologies` (vocabulary or shapes picks, pinned versions) and `ontologyGuidance`;
  the Brief tab's Ontologies section (ready versions only, *update available*, a note when a
  local-only ontology keeps mapping on local models). Bundles name the brief's versions with
  their sha256; import refuses a bundle whose versions the library lacks.
- **Embeddings:** pgvector in our Alpine Postgres image (`deploy/docker/postgres.Dockerfile`,
  no collation change for existing volumes); `ontology_term_embeddings`, searched exactly over
  the brief's versions (no HNSW: see *Embeddings*); terms embedded at the end of an import (never failing it) and by `embed` jobs queued
  when the `embedding_model` setting changes (the job names the model) or a mapping run finds a
  version without vectors; unchanged text is not embedded again. No default
  embedding model: unset, retrieval is lexical.
- **Retrieval:** `retrieval.shortlist`: `word_similarity` on labels and synonyms plus full text
  on definitions, cosine on embeddings, fused by RRF (`k = 60`); a recall fixture guards it.
- **Stage:** `mapping` (optional, outside `STAGE_ORDER`, keepable) runs after the outputs stage
  with the brief's ready vocabulary versions; the API sends the values each dev sample's newest
  finished run produced (20 per output, with the field's quote). The worker shortlists per
  output, the model answers a flat schema, and conversion refuses IRIs outside the shortlist
  and local terms, and IRI templates naming values out of scope. Local-only ontologies or
  projects never reach an external model (drafting refused, embedding lexical).
- **Web:** the Workbench Mapping tab (confidence, values seen, alternatives, keep, the current
  mapping, a sample graph preview) and an 11th box on the overview map.

### Import

`POST /api/ontologies` (admin, multipart `file`, or JSON `{ url }`, with `id`, `label`, `tags`,
`localOnly`) stores the source (an upload), or records the URL, and queues an `ontology` job.
This is a document-less job with `priority = -10` and its own task (added to the jobs task
CHECK list, `JobSummary` excludes it like `segment`).

The worker (`worker/src/ingest_worker/ontology.py`):
1. **Fetch** (URL imports only). Only `https` is allowed, and the host must be on
   `ONTOLOGY_FETCH_ALLOW` (comma-separated hosts; empty = no URL imports). Every redirect is
   re-checked against the allowlist, and private or loopback addresses are refused after DNS
   resolution. The size cap is `ONTOLOGY_MAX_BYTES` (default 100 MiB) and the timeout 60 s.
   The fetched bytes are stored as the source.
2. **Parse** with rdflib, choosing the format from the media type, then the extension, then
   sniffing.
   - **Hardening:** RDF/XML is parsed with external general and parameter entities disabled.
     JSON-LD runs with a document loader that refuses remote contexts, except contexts already
     in the library.
3. **Resolve `owl:imports`.** An import IRI that is the `ontology_iri` or `version_iri` of a
   ready library version uses that version. Otherwise it is fetched under the same allowlist
   rules, up to `ONTOLOGY_MAX_IMPORT_DEPTH` (3), and stored as its own library ontology tagged
   `imported-by:{id}`. Anything left unresolved is listed in `imports` and does not fail the
   job, because many ontologies import things that are not needed for mapping. The browser
   shows a warning.
4. **Index** the terms into `ontology_terms` across the version and its resolved imports, and
   write `normalized.nt`.
5. **Load the TBox into Fuseki** (when configured): a Graph Store Protocol `PUT` of
   `normalized.nt` to `{base}graph/ontology/{id}/{version}`.
6. **Embed** the terms with the `embedding_model` (see *Embeddings*). When no embedding model
   is set or the data policy refuses it, this step is skipped, the version stays lexical only,
   and the browser says so.
7. **Finish:** set `status = ready`, with the `stats`.

Parse errors become `status = failed` with the message, and the job goes to `needs_review` (a
`DocumentError`). Transport errors on a URL fetch are retried like any transient error.

### Limits

`ONTOLOGY_MAX_TRIPLES` (default 2,000,000) is checked after parsing. Over the limit, the import
fails with `ontology too large (N triples, limit M)`. This covers IDMP-O, schema.org and most
customer ontologies; SNOMED-scale terminologies are out of scope.

### Browsing (API)

All signed-in users can read; only admins can write (tag `Ontologies`).

| Route | Purpose |
| --- | --- |
| `GET /api/ontologies` | Library: label, tags, latest version, status, stats, usage count; `?tag=`, `?q=` |
| `GET /api/ontologies/:id` | Versions, imports, usage |
| `POST /api/ontologies` (admin) | Import (file or URL); 202 with the version |
| `PATCH /api/ontologies/:id` (admin) | Label, description, tags, `localOnly`, retire |
| `DELETE /api/ontologies/:id/versions/:v` (admin) | Unused versions only (409 otherwise, naming the users) |
| `GET /api/ontologies/:id/versions/:v/terms` | Paged search: `q`, `kind`, `parent` (children of a term, for the tree), `root=1` |
| `GET /api/ontologies/:id/versions/:v/term?iri=` | Detail: labels, definition, parents, children, domain and range, properties whose domain or range is the class, concepts of a scheme, shapes targeting it |
| `GET /api/ontologies/:id/versions/:v/neighbourhood?iri=&depth=1` | Nodes and edges for the graph view (capped at 150 nodes; `truncated: true` past that) |
| `GET /api/ontologies/:id/versions/:v/source` | Download the source as imported |

### Browsing (web)

Ontologies page (`#/ontologies`, in the main nav for everyone; Import… for admins only):
- **Library list:** cards with tags, version, kinds (OWL/SKOS/SHACL chips), size, which types
  use it, and a *Local only* tag.
- **Ontology view**, three panes:
  - a **class/property tree**, lazily loaded through `parent=`, with tabs Classes, Properties,
    Concept schemes and Shapes, and a search box;
  - the **term detail**;
  - a **graph** tab: an interactive neighbourhood of the selected term (Cytoscape.js with the
    fcose layout, pinned). It shows subclass edges, properties as labelled edges from domain to
    range, and concepts under their scheme. Click a node to refocus, expand one hop at a time.
- **Imports panel:** what resolved and what did not.
- **Import dialog:** file or URL, id, label, tags, *Local only*. It shows the job's progress and
  its failure reason.

## The brief chooses ontologies

`BriefBodySchema` gains:

```ts
ontologies: z.array(z.object({
  ontologyId: z.string(),
  version: z.number().int(),
  role: z.enum(['vocabulary', 'shapes']),   // shapes: SHACL validation only
}).strict()).default([]),
ontologyGuidance: z.string().default(''),   // free text sent to the mapping stage
```

`BRIEF_SECTIONS` gains `ontologies` and `briefDiff` covers it. The Brief tab gets an
**Ontologies** section with:
- a picker from the library, filtered by tag (customer, industry);
- each pick pinned to a version, with an *update available* hint when a newer ready version
  exists;
- a role per pick;
- the guidance text box.

Picking a `localOnly` ontology on an external-policy project shows a note that mapping will use
local models.

Bundles carry the new brief fields in `brief.json`. A bundle names the ontology versions it
needs (id, version, `version_iri`, sha256) but does not carry the ontologies themselves.
Import accepts the bundle when the library has those versions (matched by sha256). Otherwise it
lists the missing ones as a 400 `bundle needs ontologies not in the library: …`.

## The mapping in the recipe

A recipe gains an optional top-level `semantics` block: `SemanticsSchema` in
`packages/shared/src/template.ts` (Zod `.strict()`) and `Semantics` in
`worker/src/ingest_worker/template.py` (Pydantic, `extra="forbid"`). Example for
`process-validation-protocol`:

```yaml
semantics:
  ontologies:                       # pinned; terms must come from these (or `local`)
    - { id: idmp-o, version: 4 }
    - { id: acme-pv, version: 2 }
  shapes:
    - { id: acme-pv-shapes, version: 1 }
  prefixes:                          # CURIEs used below; ontology prefixes are offered by default
    idmp: https://spec.pistoiaalliance.org/idmp/ontology/
    acme: https://data.acme.example/def/pv/
  document:
    class: acme:ProcessValidationProtocol
    iri: "doc/{source}"              # relative to the base IRI; {source} = the file's sha256
  fields:
    protocol_number: { property: acme:protocolNumber }        # datatype from the field type
    execution_date:  { property: acme:executionDate }
    compound:
      property: acme:validatesSubstance
      object:                                                  # the value becomes an entity
        class: idmp:Substance
        iri: "substance/{value|slug}"
        label: true                                            # rdfs:label = the extracted value
    validation_type:                                           # enum → SKOS concepts
      property: acme:validationApproach
      concepts:
        scheme: acme:ValidationApproachScheme
        values:
          prospective:   acme:Prospective
          concurrent:    acme:Concurrent
          retrospective: acme:Retrospective
  tables:
    batches:
      link: acme:hasBatch                                      # document → row
      class: acme:ValidationBatch
      iri: "batch/{batch_number|slug}"                         # row IRI; blank node when absent
      columns:
        batch_number: { property: acme:batchNumber }
        batch_size:   { property: acme:batchSize }
        stage:        { property: acme:processStage, concepts: { scheme: acme:StageScheme, match: label } }
  local:                                                       # recipe-local extension terms
    - { iri: "def/{type}/lineSpeed", kind: datatype_property, label: Line speed,
        definition: Conveyor speed during compression, as written in the protocol. }
```

**Semantics of the block**
- **Literals.** A field or column without `object` or `concepts` becomes a literal typed from
  its `ValueType`:

  | `ValueType` | Literal |
  | --- | --- |
  | `text`, `enum` | `xsd:string` |
  | `integer` | `xsd:integer` |
  | `decimal` | `xsd:decimal` |
  | `date` | `xsd:date` |
  | `boolean` | `xsd:boolean` |
  | `list` | one triple per item |

  A value that failed normalisation (an issue was recorded) is written as a plain string with
  `ct:normalisationIssue` on its `ct:Evidence` node (see *Fact provenance*). It is never written as an invalid typed
  literal.
- **`object`.** The value becomes an entity. Its IRI is minted by the template from the value
  or the row's columns. Filters: `slug` (lowercase ASCII, `-`) and `upper` (readable IRIs, see
  *Entity IRIs*); minting always goes through `mint_entity_iri`.
  An empty value means no triple.
- **`concepts`.**
  - **Explicit:** `values` maps enum values or exact strings to concept IRIs.
  - **By label:** `match: label` matches `prefLabel` or `altLabel` in the scheme,
    case-insensitively.
  - **No match:** an unmatched value becomes a literal plus an issue. The SHACL shapes can make
    it a violation.
- **Unmapped outputs** use the recipe's default vocabulary, `{base}def/{typeId}/{id}`,
  so nothing is silently dropped. The recipe checks list them (warn), and a shape can require
  them.
- **IRIs** are relative to the deployment's base IRI (see *IRI policy*) unless absolute. Templates may
  use `{source}` (the original file's sha256), `{type}`, `{version}`, `{value}` (fields), or
  column ids (rows). `{document_id}` is deliberately not offered: a document row is one upload,
  not the original document.

**Validation** (`semanticsIssues` in TS inside `templateIssues`; `Semantics.issues` in Python;
shared fixture `packages/shared/test/fixtures/semantics-issues.json`):
- every CURIE expands with a declared prefix;
- every term exists in a pinned version (or its imports) with a compatible kind, or in `local`;
- a field or column id names an output that exists;
- an IRI template uses only variables in scope;
- `concepts.values` keys are enum values of that field;
- a concept exists in its scheme;
- datatype compatibility: a literal-mapped output whose property has an `rdfs:range` that is
  incompatible with the `ValueType` is an issue (a warning when the range is a class);
- a domain mismatch (property domain against the document or row class) is a warning, not an
  error. Ontologies are often loose about domains.

Errors block publishing (Workbench and Templates routes). Warnings show in `ChecksPanel`.
Because terms are checked against the library, TS validation reads `ontology_terms` through a
`TermLookup` port (`MemoryTermLookup` in tests). The Python side receives the pinned versions'
term sets from `PgOntologyStore`.

**Change log and editor.**
- **Logging:** semantics edits are ordinary draft writes and logged in `template_changes`.
  `describeDefinitionChange` gains `mapping` subjects (*Mapped compound → idmp:Substance*).
- **Editor:** the recipe editor gains a **Mapping** sub-tab for hand edits (described under
  *Web*).
- **Versioning and caches:** changing the mapping of a published recipe needs a new version.
  A mapping never enters prompts, so it does not change the step cache key or extraction
  results.

## Delivery formats per recipe

**Decided (2026-10-14):** RDF is optional for each recipe, like every other delivered format. A
recipe focused on document structure may want only JSON in S3; a recipe feeding intelligence
systems may want CSV, JSON and RDF.

A recipe gains an optional `delivery` block (`DeliverySchema` in
`packages/shared/src/template.ts`, `Delivery` in `worker/src/ingest_worker/template.py`, shared
fixture `delivery-formats.json`):

```yaml
delivery:
  formats: [json, rdf]      # any non-empty subset of csv, json, rdf
```

- **Default.** Absent means `[csv, json]`, exactly what is delivered today, so every existing
  recipe and published version behaves as before.
- **What it controls.** It controls what is **delivered** to the target (and, for `rdf`, loaded
  into Fuseki), and what the Results page lists. Internal files are unaffected: the draft
  document JSON in the outputs bucket (which review reads), `reviewed-document.json` in the
  runs bucket, and test-run outputs are always written.
- **`csv`:** the per-output CSVs (fields, tables, checks, issues).
- **`json`:** the document JSON.
- **`rdf`:** the Turtle in S3 and the graph in Fuseki. It requires a `semantics` block
  (`semanticsIssues`: `delivery.formats includes rdf but the recipe has no ontology mapping`,
  which blocks publishing). SHACL validation, the `published_graphs` versions and the
  `published_entities` keys apply only when `rdf` is delivered.
- **Mapping without RDF.** A `semantics` block without `rdf` in `formats` is allowed: the
  mapping is kept and previewed, but nothing is delivered as RDF. A warning in `ChecksPanel`
  says so, so a mapping can be drafted before RDF is switched on.
- **Versioning.** The block is part of the recipe, so changing formats needs a new version, like
  any other change. Each published document records the formats it was delivered in through its
  `job_outputs` rows.
- **Withdrawal** removes whatever was delivered. It reads the `job_outputs` rows and
  `published_graphs`, not the current recipe.
- **Web.** The recipe editor's General tab gets *Delivered formats* (CSV, JSON, RDF tick boxes;
  RDF disabled with a reason until there is a mapping). The Workbench `mapping` stage shows as
  *not used* when the brief selects no ontologies; when ontologies are selected but `rdf` is not
  delivered, its banner says the mapping will not be delivered yet.

## LLM-suggested mapping (Workbench stage `mapping`)

### Where it sits
- **Overview:** `mapping` is a new drafting stage, placed after `steps` in `OVERVIEW_STAGES`. It
  is in `OPTIONAL_STAGES`, like References, Evaluate and Revise, so it is never the required
  next step and never blocks Publish.
- **When it shows:** it shows as *not used* when the brief selects no ontologies.
- **Staleness:** it is outside `STAGE_ORDER`, so it does not make later stages stale. Its own
  rule: it is stale when the outputs stage completed after it, or when the brief's ontology
  selection or guidance changed after it.
- **Running and keeping:** like the other change stages it runs as a `draft` job, gives a
  proposal, and can be kept when stale (`KEEPABLE_STAGES` gains `mapping`).

### Inputs (content analysis)
`drafting.build_mapping_context` (worker):
1. **Outputs:** the open draft's outputs (ids, names, descriptions, types, enum values) and the
   current `semantics`, if any.
2. **Observed values:** per output, up to 20 distinct values with counts. They come from the
   project's verified dev references first, then the latest dev test runs. Each value carries a
   short source snippet (±120 characters around the evidence, from prepared text). Holdout
   samples are never read, the same rule as revise.
3. **Brief:** purpose, glossary and `ontologyGuidance`.
4. **Candidate shortlist** per output and per document. `PgOntologyStore.candidates` searches
   the selected vocabulary versions with **hybrid retrieval** (decided: embeddings ship in this
   stage's PR):
   - **lexical:** trigram on labels and synonyms plus full text on definitions, using the
     output's name, description, id words and its top observed values;
   - **semantic:** cosine similarity between an embedding of the output (name, description,
     type and up to 5 observed values) and the term embeddings (see *Embeddings*);
   - **fusion:** the two rankings merge by reciprocal rank fusion (`k = 60`). When a version
     has no embeddings for the current model yet, retrieval is lexical only and the proposal
     says so;
   - **kinds:** properties ranked by datatype or object compatibility with the `ValueType`;
     classes for the document and each table;
   - **concept candidates** per enum value or frequent text value, from schemes whose concepts
     match.

   The shortlist holds k = 15 terms per output with their label, definition, domain and range,
   and parents. All candidates are recorded in the proposal so people can see the alternatives.
5. **Budget:** the context is capped at `drafting.MAX_MAPPING_TERMS` (300 terms in total). The
   worst-matching candidates are dropped first.

### Embeddings
- **Model.** A new pipeline model setting, `embedding_model` in `llm_settings` (migration; like
  `ocr_model`, never a model choice). It must be an offered model on an endpoint whose kind
  supports embeddings.
- **Providers.** `LLMProvider` gains an optional `embed(texts) -> list[list[float]]`, with the
  `openai-chat` and `openai-responses` kinds calling `/v1/embeddings`. That covers LM Studio,
  vLLM and OpenAI. Anthropic has no embeddings endpoint, so an `anthropic` endpoint cannot be
  the embedding model. Provider tests use stub SDK clients that assert the exact request
  shape, as for completions.
- **Default.** A local embedding model, so the default is local-only. The Models page shows the
  setting under Pipeline models.
- **Storage (pgvector).** Postgres needs the `vector` extension: the database image is
  `postgres:17-alpine` with pgvector 0.8.0 compiled in (`deploy/docker/postgres.Dockerfile`), so
  existing volumes keep their collations (dev-infra, compose and the throwaway test databases).
  - **Table:** `ontology_term_embeddings` (the term's key, `model_ref`, `dims`, `embedding vector`,
    `text_sha256`).
  - **Search:** exact (no HNSW index): the brief's versions are filtered first, then ordered by
    cosine distance. An approximate index filtered afterwards lets other ontologies' closer
    terms crowd them out, and HNSW cannot index over 2000 dimensions.
- **When terms are embedded.**
  - **At import:** step 6 of the import job, *Embed*, which runs after indexing. The text
    is the label, synonyms, definition and parent labels, in batches of 64.
  - **When the model changes:** changing `embedding_model` queues an `embed` job per ready
    version, and retrieval stays lexical until each finishes.
  - **Unchanged terms are reused:** a term whose `text_sha256` and model already have a vector
    is not embedded again.
- **Data policy.** Embedding the outputs sends observed values to the embedding model, so the
  project's data policy and `localOnly` ontologies apply to the embedding endpoint as to the
  chat model. An external embedding model is refused for a local-only project, and retrieval
  falls back to lexical. Embedding the terms of a `localOnly` ontology on an external endpoint
  is refused at import, which then stays lexical only.
- **Measuring it.** `worker/tests/fixtures/mapping-recall/` holds a small hand-labelled set:
  outputs, a fixture ontology, the expected terms. A table-driven test checks recall@15 of
  lexical, semantic and hybrid retrieval with a deterministic fake embedder, so changes to the
  ranking are visible. Real-model recall is measured offline and never in CI.

### Model output
A flat schema (no union types, the same constraint as revise). Each change has an op, a target
output id, an IRI chosen from the candidates or a local term, a `confidence` (`high`, `medium`
or `low`), a `reason` and `evidence` (the observed values that support it). Ops (`DraftChange`,
`draft_changes.apply_changes`, shared fixture `draft-changes.json`):
- `setDocumentMapping` (class, IRI template);
- `putFieldMapping`, `putTableMapping`;
- `removeMapping`;
- `putLocalTerm`.

`run_extraction(check=…)` refuses an IRI that is neither in the shortlist nor declared as a
local term, and an IRI template naming unknown variables. Both are fed back to the model. Free
notes ("`stage` would map better as an enum of acme:StageScheme") come back as `notes` on the
proposal and are never applied.

### Data policy
- **Local only:** the project's data policy applies, and a `localOnly` ontology in the brief
  also forces local models. An external model is refused before any call.
- **Logging:** external calls log `external model call` with the samples whose values or
  snippets were sent, and the ontology versions whose terms were sent.

### Review in the Mapping tab
`MappingTab` (`apps/web/src/workbench/MappingTab.tsx`):
- **Mapping view:** a table of the recipe's outputs (document, fields, tables and their
  columns). For each output it shows the mapped term (label and CURIE, with the definition on
  hover) and a source tag (*Suggested · high*, *By hand*, *Default vocabulary*, *Unmapped*).
  For enums it shows the concept links, and for entities the IRI template with an example IRI
  built from a real value.
- **Proposal card** (`ProposalCard`): one row per change with confidence, reason, evidence
  values and *Alternatives* (the shortlist with scores). The person accepts per change,
  through the usual *Apply N selected changes*.
- **Term picker** for hand edits: a library search over the pinned versions, filtered by
  compatible kind, using the same `terms` route.
- **Sample graph:** pick a dev sample, then *Render graph*. This runs a graph preview (next
  section) and shows the document's graph:
  - a node-link view (Cytoscape) of the document, rows, entities, concepts and literals;
  - the Turtle, with a copy button;
  - the SHACL report (each violation linked to its output).

## Rendering and SHACL (worker)

`worker/src/ingest_worker/rdf.py`, pure and deterministic:
- `render_graph(template, document, base_iri, published_at) -> rdflib.Dataset` renders one
  document into one named graph: the data plus PROV-O provenance.
- `to_turtle(graph) -> bytes` uses sorted, canonical prefixes, so output is stable byte for
  byte for the same input (tests compare with `rdflib.compare.isomorphic` and also check
  stability).
- `validate(graph, shapes, ontologies) -> ShaclReport` runs pySHACL with `inference="none"`.
  The ontology graphs are merged into a copy of the data graph so that `sh:class` checks see
  `rdfs:subClassOf` and the ontologies' own typing (pySHACL's `ont_graph` misses the latter).

Provenance in each graph:

```turtle
<doc/9f2…> a acme:ProcessValidationProtocol ;
    prov:wasGeneratedBy <job/41c…> ;
    dcterms:source <urn:sha256:ab12…> .
<job/41c…> a prov:Activity ;
    ct:recipe <def/process-validation-protocol> ; ct:recipeVersion 4 ;
    prov:wasAssociatedWith <model/main> ;          # model choice ids, never refs
    ct:reviewedBy "jane (token label)" ; prov:endedAtTime "2026-10-14T…"^^xsd:dateTime .
```

### Graph identity and versions

**Decided:** one graph per original document **and document type**, however many times it is
processed. A file may be extracted through two types for different purposes: for example one
type pulls the tabular data for intelligence systems, and another pulls the structure and
narrative to rebuild the document in a structured content system. Neither should replace the
other.
- **What "the same document" means.** The original document is the uploaded file, identified
  by its sha256 (`documents.sha256`, which is the `.docx` itself for Word, see ADR 0009).
- **One graph per type, one shared document node.** The graph is
  `{base}graph/source/{sha256}/{typeId}`. The document node is `{base}doc/{sha256}` in every
  type's graph. With the union default graph, consumers see one document described by both
  types, and each graph keeps its own replace, version and withdraw lifecycle.
- **What replaces a type's graph.** These all publish into the same `(sha256, typeId)` graph:
  - a retry, a re-process or a step re-run that is then approved;
  - a re-upload of the same file;
  - a newer recipe version of the same type.

  The newest publish replaces the graph. The provenance records the job, the recipe version and
  the document row that produced the current version.
- **Entities are shared too.** A batch minted with the same scoped key by both types is the same
  IRI, and both graphs add triples to it.
- **Overlaps are visible, not resolved.** When two types state the same property of the
  document or an entity with different values, the union shows both, and each value's graph
  (`GRAPH ?g`) and its provenance tell them apart. The Mapping tab warns when another published
  type of the same files maps the document node to a property this mapping also uses, so the
  overlap is a choice.
- **Serialised per graph.** A publish takes `pg_advisory_xact_lock(hashtext('graph:' ||
  sha256 || ':' || typeId))` around reading and incrementing the version and the Graph Store
  Protocol `PUT`, so two jobs of the same file and type can never interleave. A job whose reviewed document is older than
  the graph's current version (approved earlier, published later after a retry) still
  publishes: the newest *publish* wins, which is what a person approving last expects.
- **A version from day one** (for corrections later). The table `published_graphs`
  (primary key `(sha256, template_id)`, `graph_iri`, `version`, `job_id`, `document_id`,
  `template_version`, `base_iri`, `triples`, `published_at`) holds the current version. The
  append-only `published_graph_versions` holds one row per publish. Each publish increments
  `version`, and the graph says so:

  ```turtle
  <graph/source/ab12…/process-validation-protocol> ct:graphVersion 3 ;
      dcterms:modified "2026-10-14T…"^^xsd:dateTime ;
      prov:wasRevisionOf <graph/source/ab12…/process-validation-protocol/v2> .  # not stored yet
  ```

  Each version's Turtle is also kept in the S3 target at `graphs/{sha256}/{typeId}/v{n}.ttl`,
  beside the
  job's own outputs. So a later phase can offer history (versioned graphs, a change feed)
  without re-rendering anything. In this phase only the current version is in Fuseki.
- **Counts and status:** the Linked data panel reads `published_graphs`.

### Fact provenance
**Decided (2026-10-14):** every published fact says where it came from, in plain RDF so that
rdflib, pySHACL and every SPARQL client handle it. RDF-star is avoided because rdflib's support
is incomplete.

```turtle
<doc/ab12…/fact/execution_date> a ct:Evidence ;
    ct:subject <doc/ab12…> ; ct:property acme:executionDate ;
    ct:value "2023-02-11"^^xsd:date ;
    ct:page <doc/ab12…/page/4> ;
    ct:quote "Execution date: 11/02/2023" ;
    ct:section <doc/ab12…/process-validation-protocol/section/approvals> ;
    ct:step "identification" ;
    prov:wasGeneratedBy <job/41c…> .
<doc/ab12…/page/4> a ct:Page ; ct:pageNumber 4 ; ct:of <doc/ab12…> .
```

- **Fields:** each mapped field value gets one `ct:Evidence` node with its page, quote (the
  extraction's `evidence`), section and extract step.
- **Table rows:** each row node gets one `ct:Evidence` with the step and the sections it read.
  There is no page or quote, because extraction does not record one per cell.
- **Shared page nodes.** `doc/{sha256}/page/{n}` are shared by every type and chain link of the
  same file. Pages agree across types because every type runs on the same PDF; for Word files
  that is the cached conversion, ADR 0009. So facts from a semantic link and sections from a
  structural link meet at the same pages.
- **Sections** are `doc/{sha256}/{typeId}/section/{sectionId}`, per type, because each recipe
  segments the file its own way.
- **Normalisation issues and corrections.** A value that failed normalisation carries
  `ct:normalisationIssue` on its `ct:Evidence` node; this replaces the earlier reified
  statement. A value a reviewer corrected carries `ct:correctedFrom` with the model's value, so
  the correction history (safeguard 5) is in the graph too.
- **Size.** Evidence roughly doubles a graph's triple count. It is on for every recipe that
  delivers `rdf`, with no switch, until size becomes a problem.

### Graph previews
A `graph` job (document-less, `priority = -5`, one per project; a new preview deletes the old,
like segment previews) renders and validates the selected samples' latest outputs. It uses the
reviewed document when one exists, else the draft, and always the **open draft's** mapping. It
writes `graphs/{project}/{job}/{sha256}.ttl` and `…/report.json` to the runs bucket. It runs in
a child process capped at `GRAPH_TIMEOUT_S` (30 s), because SHACL over a large ontology can be
slow. The UI polls as it does for segment previews. Previews never call a model.

## Production: process, review and publish

- **Process** (`template_pipeline.run_template`): when the recipe has `semantics` and RDF
  publishing is configured, the graph is rendered after extraction and checks and validated
  against the shapes. Each `sh:Violation` adds a review reason
  (`SHACL: <shape> on <output>: <message>`). The report is stored as
  `runs/{job}/shacl-report.json` and the draft Turtle as `outputs/…/document/{id}.ttl` (stage
  draft). Warnings and infos are added to `issues`.
- **Review screen:** a *Graph* tab shows the Turtle and the SHACL report, and links each
  violation to the field or cell to fix.
- **Publish** (`publish_template_job`, `deliver=True`):
  1. Apply edits and build the reviewed document (unchanged).
  2. Render and validate **before any write**. A violation moves the job back to
     `awaiting_review`, with the violations as reasons and an event
     `publish refused: graph violates shapes`. This is a new transition
     (`publish → awaiting_review`) in `PgJobQueue` and in the job status contract. Nothing is
     delivered.
  3. Write the CSV, JSON and Turtle to the S3 target (`job_outputs` rows; `format` CHECK gains
     `ttl`).
  4. `GraphStorePublisher.put(graph_iri, turtle)` sends a Graph Store Protocol `PUT` to
     `{RDF_ENDPOINT}/{RDF_DATASET}/data?graph=…` with basic auth.
     - **Transient failures:** a 5xx or a transport error raises, and the publish task is
       retried with backoff. The S3 writes and the `PUT` are both idempotent.
     - **Permanent failures:** a 4xx goes to `needs_review` with the response.
  5. Record the new version in `published_graphs`/`published_graph_versions` (same
     transaction as the lock) and the event `graph published` (`graph`, `version`, `triples`).
- **Test runs** (`deliver=False`) write the Turtle and report to the runs bucket only. They
  never touch Fuseki.

The publisher is a port (`publishers.py`): `Publisher.publish(rendered) -> list[Published]`,
with `S3Publisher` (today's `Target`) and `GraphStorePublisher`. Unit tests use
`FakeGraphStore`, which records the requests.

### Deletion and retirement remove what was delivered

**Decided:** deleting removes the graph, and with it the job's published S3 outputs. This
changes today's rule that published target copies are kept (ADR 0005, migration 0030). The
change applies to CSV and JSON as well as RDF, and it needs its own short ADR amendment.

- **Withdrawals are worker jobs.** Only the worker can reach Fuseki, and only the worker has
  write access to the target (ADR 0004), so the API never deletes from them itself. It queues a
  document-less `withdraw` job (new task, `priority = 0`) in the same transaction as the
  deletion. Its params name what to remove: the graph's `sha256`, and the target keys from the
  job's published `job_outputs` rows. A withdrawal is retried until it succeeds, like any
  transient failure. Its job is kept and visible to admins on the Jobs page (task filter), so a
  stuck withdrawal is noticed.
- **Deleting a job** (`DELETE /api/jobs/:id`, and the bulk delete):
  - **Its own outputs:** its published target objects are removed.
  - **The graph:** the job's `(sha256, typeId)` graph is dropped (`DROP GRAPH`, a Graph Store
    Protocol `DELETE`) only if that job published the graph's **current** version. Its rows in
    `published_graphs` and `published_graph_versions` are removed, and so are its
    `graphs/{sha256}/{typeId}/v{n}.ttl` copies. The same file's graphs under other types are
    never touched.
  - **Another job's graph is untouched:** if another job published the current version, the
    graph stays. Only the deleted job's version rows and copies go.
  - **No automatic restore:** deleting the current version's job does not bring back an earlier
    version. An operator re-publishes if wanted.
- **Deleting a Workbench project** needs nothing new: only never-published types can be deleted,
  and test runs never publish.
- **Retiring a document type** withdraws everything the type delivered: every
  `graph/source/*/{typeId}` graph, and its jobs' published target objects. Graphs of the same
  files under other types stay. The type and
  its jobs stay readable, as retirement promises. The reviewed documents stay in the runs bucket.
- **Unretiring** is expected to be a very unusual exception; re-delivery is the accepted cost.
  It queues one `republish` job (document-less, `priority = -10`). For each
  withdrawn job it re-renders the CSV, JSON and Turtle from `{job}/reviewed-document.json` with
  that job's recipe version, writes them back to the target and re-publishes the graphs as new
  versions. Retirement can therefore be undone, at the cost of re-delivery. `rdf_rebuild` uses
  the same code.
- **Contract and docs:** the retirement rules in CLAUDE.md ("Nothing is deleted") and ADR 0005
  must be amended in the same PR that implements this. The web's delete and retire dialogs
  say that published outputs and graphs will be withdrawn.

## Fuseki deployment

- **Service:** a compose service `fuseki` on a pinned image tag, with TDB2 on the volume
  `fuseki-data`. It is on an internal network shared with the worker; the API does not need it
  (see *Results*).
- **Configuration:** `deploy/fuseki/config.ttl`:
  - one dataset `ct`, with `tdb2:unionDefaultGraph true` so that queries see every named graph;
  - services: `/ct/sparql` (query), `/ct/get` (Graph Store Protocol read), `/ct/data`
    (Graph Store Protocol read/write).
  - SPARQL Update is not exposed.
  - Shiro: the user `ct-writer` (worker) may use `/ct/data`; the user `ct-reader` may use
    `/ct/sparql` and `/ct/get`; `/$/*` admin is localhost only.
- **Worker env:** `RDF_ENDPOINT`, `RDF_DATASET`, `RDF_USER`, `RDF_PASSWORD`. When
  `RDF_ENDPOINT` is unset, no Fuseki writes happen, and the Turtle still goes to S3. The base
  IRI is not an environment variable: it is the admin's Linked data setting (see
  *IRI policy*).
- **Consumers (decided):** one shared read-only user, `ct-reader`, reaches `/ct/sparql` and
  `/ct/get` through the reverse proxy, like the lake S3 host.
  - **Credentials:** its password is `RDF_READER_PASSWORD` in the deploy host's env file,
    written into the Shiro config at start. Changing it means a restart.
  - **The panel:** shows the endpoint URL and the user name, never the password.
  - **Later:** per-consumer credentials are possible but not planned.
  - **What consumers see:** the reader sees every graph, document data and ontology graphs
    alike. Exposing IDMP-O and the other library ontologies to the customer is agreed.
- **Operations:**
  - **Backups:** a nightly `/$/backup/ct` (via the deploy host's cron) to the backups volume.
  - **Compaction:** a weekly `/$/compact/ct?deleteOld=true`, because graph replaces leave
    garbage in TDB2.
  - **Rebuild:** `docker exec ingestion-worker-1 python -m ingest_worker.rdf_rebuild` reloads
    every ontology `normalized.nt` and every published `.ttl` from S3 into an empty dataset.
  - **Backfill:** `--backfill <type>` renders documents published before a mapping existed
    from `reviewed-document.json` with the type's newest published mapping (the provenance
    records the mapping version).

## Results and job detail
- **Results:** `.ttl` objects show next to CSV and JSON on the Results page, read from the S3
  target as today (ADR 0004).
- **Job detail:** `JobDetail.graph` = `{ iri, triples, publishedAt } | null`, from the event,
  with a *Graph* panel that renders the published Turtle (read from S3, not Fuseki).

## Web summary
| Where | What |
| --- | --- |
| `#/linked-data` (new admin page) | Customer, base IRI with fallback preview, published counts, history, confirm on change |
| `#/ontologies` (new page) | Library cards, ontology view (tree, detail, neighbourhood graph), imports panel; Import… (admins) |
| Brief tab | Ontologies section (pinned picks, roles, guidance) |
| Overview map, `ProjectRail` | `mapping` stage box (optional); metrics: outputs mapped n/m, SHACL violations on the last preview |
| Mapping tab (new) | Mapping view, proposal card with alternatives, term picker, sample graph with SHACL |
| Recipe editor | Mapping sub-tab (hand edits; read-only when published or retired); checks list semantics issues |
| Review screen | Graph tab (Turtle, SHACL report linked to fields) |
| Job detail, Results | `.ttl` output, Graph panel |

Words: users see *ontology*, *mapping* and *graph*. The recipe key stays `semantics`.

## Testing
- **Worker (pytest, offline):**
  - `test_rdf.py`: table-driven `(template, document) → expected Turtle`, checked with
    `isomorphic` plus a byte-stability check. Cases: every `ValueType`, lists, entities, IRI
    filters, concepts by value and by label, unmatched values, default vocabulary, normalisation
    issues, provenance.
  - `test_shacl.py`: small shapes fixtures (violation, warning, `sh:class` through
    `subClassOf`).
  - `test_ontology.py`: tiny OWL, SKOS, SHACL, RDF/XML and JSON-LD fixtures; term indexing;
    `owl:imports` resolution against `MemoryOntologyStore`; an allowlist and SSRF table; an XXE
    fixture that must not expand; JSON-LD remote context refused; the triple cap.
  - `test_mapping_stage.py`: `FakeProvider`, shortlist building, the check refusing IRIs
    outside the shortlist, the data policy (`localOnly` ontology on an external project),
    holdout never read.
  - Publish: `FakeGraphStore` asserts the exact request (method, graph IRI, content type) and
    covers the ordering (no write when SHACL fails, retry safety).
- **Integration (`@pytest.mark.integration`):** a Fuseki container in dev-infra:
  `GraphStorePublisher` `PUT`/`DROP`, the union default graph, TBox load, rebuild.
- **API (vitest):** library routes with `MemoryOntologyRepo` and `MemoryObjectStore`;
  `semanticsIssues` (shared fixture with Python); brief schema and diff; bundle import with
  missing ontologies; the OpenAPI sweep covers every new route; the access sweep covers admin
  writes.
- **Web:** `fakeApi()` gains the ontology methods; Testing Library tests for the tree's lazy
  loading, term detail, picker filtering, Mapping tab accept and partial accept, and the
  sample-graph SHACL list.
- **Contracts:** `test_specs.py` and `spec-registry.test.ts` load a `semantics` example once the
  `process-validation-protocol` v4 template gains one (it pins tiny fixture ontologies seeded
  in tests only).

## Contracts (both sides, same PR)
| Contract | TypeScript | Python |
| --- | --- | --- |
| Recipe `delivery.formats` (default `[csv, json]`) | `DeliverySchema`, `deliveryFormats` in `packages/shared/src/template.ts` | `template.Delivery`, `render_document` honours it; fixture `delivery-formats.json` |
| Recipe `semantics` block, validation | `SemanticsSchema`, `semanticsIssues` in `packages/shared/src/template.ts` | `template.Semantics`, `Semantics.issues`; fixture `semantics-issues.json` |
| Brief ontologies | `BriefBodySchema.ontologies/ontologyGuidance`, `BRIEF_SECTIONS` | `drafting.DraftParams` (brief passed in params) |
| Mapping change ops | `DraftChangeSchema` (5 ops), `applyChanges` | `draft_changes.apply_changes`, `draft_stages.MAPPING`; fixture `draft-changes.json` |
| Job tasks `ontology`, `graph`, `embed`, `withdraw`, `republish`; `publish → awaiting_review` | `packages/shared/src/jobs.ts` | migration CHECK list, `queue.py` |
| Object keys | `ontologySourceKey`, `graphPreviewKey`, `.ttl` in `outputKey` | `storage.ontology_source_key`, `graph_preview_key`, `output_key(…, "ttl")` |
| Ontology tables | `OntologyRepo` (`apps/api/src/ontologies/`) | `PgOntologyStore` (worker reads terms, writes parse results) |
| Linked data settings, base IRI | `LinkedDataSettingsSchema`, `effectiveBaseIri`, `FALLBACK_BASE_IRI` in `packages/shared/src/linked-data.ts`; `LinkedDataRepo` | `rdf.effective_base_iri`, `PgLinkedDataSettings` (reads `linked_data_settings`); shared fixture `packages/shared/test/fixtures/base-iri.json` |

## Rollout (each PR green and deployable)
1. **Library:** migration 0032, `ontology` jobs (file upload only), term index, routes, the
   Ontologies page (list, tree, detail). No Fuseki yet.
2. **URL import and graph view:** allowlisted fetch, `owl:imports`, hardening tests,
   neighbourhood route and Cytoscape view.
3. **Recipe `semantics` and rendering:** contract on both sides, validation, the recipe
   editor's Mapping sub-tab (hand mapping), `delivery.formats` (General tab), Turtle in test
   runs, graph previews, sample graph view, and the Linked data admin panel (`linked_data_settings`, base IRI with fallback).
4. **Brief and the LLM mapping stage:** brief ontologies, `mapping` stage, hybrid shortlist
   retrieval with embeddings (`embed` on providers, `embedding_model` setting, pgvector image,
   term embeddings, recall fixture), Mapping tab, overview stage, bundle changes.
5. **SHACL:** validation in process and publish, review reasons, the
   `publish → awaiting_review` transition, the Review screen's Graph tab.
   *As built:* pySHACL's `ont_graph` does not see instance typing in the ontologies (an
   `acme:Memo a acme:Note` triple), so the ontologies are merged into a copy of the data graph
   instead. Step re-runs validate too. A refused publish reuses `await_review` (the drafts stay
   in the outputs bucket), and only a publish that delivers `rdf` is refused: a recipe that
   renders a graph without delivering it publishes its CSV/JSON with the violations already
   reviewed. The Mapping editor pins shapes like vocabularies; graph previews carry each
   sample's report.
   Results whose focus node only the ontologies describe are dropped (no edit could fix
   them). Previews validate in a child process capped at `GRAPH_TIMEOUT_S`; rendering is
   not capped.
6. **Fuseki:** compose service, config, `GraphStorePublisher`, graph identity per source with
   `published_graphs` versions and versioned Turtle copies, `published_entities` and
   `mint_entity_iri`, TBox loads, job graph status,
   rebuild and backfill commands, backups and compaction docs, smoke test.
   *As built:*
   - **Opt-in.** Fuseki 6.2.0 is built from the Maven Central jar (sha512 pinned) and is
     opt-in through the compose profile `rdf`. The passwords come from the env file, and an
     env file without them deploys as before, publishing graphs to S3 only.
   - **No Shiro.** Fuseki main's own `--passwd` and the per-endpoint `fuseki:allowedUsers`
     replace the Shiro file. The admin endpoints answer localhost only, through
     `/opt/fuseki/admin.sh`.
   - **The port is `GraphStore`**, not a `Publisher`. S3 delivery is unchanged, and the graph
     is published after it, as the next version.
   - **Versions without Fuseki.** The version and the target copy are recorded even without
     `RDF_ENDPOINT`. That way the counts and a later rebuild see every delivered graph.
   - **Entity keys** hold the raw key values, before filters.
   - **TBox loads** run inside the graph's publish: under its lock, and before its PUT.
   - **Re-mint** publishes the graph under the new base first, then drops the old one.
7. **Withdrawal and consumer access:** `withdraw`/`republish` jobs on job deletion,
   retirement and unretirement (with the ADR 0005 and retirement amendments), the shared
   `ct-reader` user through the proxy, docs for consumers.

Steps 1–3 deliver value without Fuseki (browsing, mapping and Turtle in S3). Step 6 can be
pulled forward if consumers need SPARQL early with hand-written mappings.

## Later: chained document types (follow-on types)

A file may need several kinds of meaning: semantic facts (tables, entities, ontology terms)
from one type, and structure and narrative from another, possibly refined by a third. **Chosen
direction (2026-10-14): follow-on types**, which allow chains of any length (A → B → C). This
is not built in this phase. It gets its own design doc before implementation. The rules below
fix the direction so that nothing built now works against it.

### What these choices already provide
- **Shared identity.** Every link's graph describes the same `doc/{sha256}` node and shares
  entities by scoped key, so a chain's outputs link up without new IRIs.
- **Independent graphs.** One graph per file and type means a link never overwrites another,
  and each can be withdrawn on its own.
- **Shared preparation.** Prepared text and the OCR cache are keyed by the file's sha256, so
  later links do not OCR again.
- **Per-recipe delivery.** A structural link can deliver JSON only, while a semantic link
  delivers RDF.

### The direction
- **Declared in the recipe.** A recipe gains an optional `then` list of document type ids, for
  example `then: [pv-structure]`. Publishing a job of A queues one job per listed type for the
  **same document** (same `document_id`, so the same sha256), with `params.chain`: the ordered
  list of `{typeId, version, jobId}` links so far. A list allows branching (A → [B, C]) as well
  as chains (A → B → C).
- **Each link runs its type's current published version.** That is the newest published version
  when the link is queued, not one pinned by the upstream recipe. So a downstream type can be
  improved without republishing its upstream. `params.chain` records the versions actually used.
- **Downstream links read upstream values.** A link's extract steps can read any upstream
  link's reviewed values as `context`, namespaced by type (`context: { batches:
  "@pv-tables.batches.batch_number" }`), the same mechanism steps use within one recipe today.
  - **What is read:** the values come from each upstream job's `reviewed-document.json`, as
    published.
  - **Missing upstream:** a step naming a type that is not upstream in this chain is a recipe
    issue at publish time when it can be checked, else `(none)` at run time.
- **Each link is reviewed on its own.** Each link follows its own recipe's review rules. A
  link is queued only when its upstream job is **published**, so it never reads unapproved
  values.
- **No cycles, bounded depth.**
  - **At publish:** publishing a recipe whose `then` would create a cycle through the
    published versions of the types involved is refused with a 409 naming the cycle.
  - **At run time:** a link whose type already appears in `params.chain` is not queued (event
    `chain stopped: cycle at <type>`). Neither is a link past `MAX_CHAIN_DEPTH` (5).
- **No duplicate runs.** When a link's type already has a queued or running job for the same
  document from the same chain root, no second one is queued.
- **Re-processing re-runs the chain.** Every publish of an upstream link queues its downstream
  links again, so corrections flow down and each link's graph is replaced (versioned) as usual.
- **Failures stay local.** A failed or rejected link stops only its own branch. Upstream outputs
  stay delivered.
- **Rules carry down.** The project's data policy (`params.dataPolicy`) and the uploader
  (`created_by`) are carried to every link. A retired type in `then` is skipped with an event.
- **Provenance.** Each link's activity says `prov:wasInformedBy` the upstream job's activity,
  so consumers can follow the chain in the graph.

### Chain decisions (2026-10-14)
- **A chain is an atomic unit of work.** A chain is the root job and every link queued from it
  (`jobs.chain_root_id`, the root's job id; migration with the chain design). It is withdrawn as
  a whole:
  - **Deleting any job in a chain** withdraws every link of that chain, upstream and
    downstream: graphs, published S3 outputs, `published_entities` sources. Downstream values
    were built from upstream ones, and upstream outputs belong to the same unit of work.
  - **Retiring a type that appears in a chain** withdraws every chain that contains it.
    Unretiring re-delivers them, using the same `republish` path as for single jobs.
  - **What the user sees:** the delete and retire dialogs list the other links that will be
    withdrawn with it.
  - **Delivery is not atomic:** each link still delivers as soon as its own job is published,
    so upstream data is not held back while a long chain runs. Only withdrawal treats the
    chain as one.
- **Testing in the Workbench.** A downstream type's test runs read upstream values from the
  newest published job of the upstream type for the same file. When there is none, the test run
  dialog offers *Run upstream first*: it queues the upstream type on the same sample, and the
  downstream run follows once that job is reviewed. A test chain never delivers anything,
  however many links it has.
- **UI: one link each way.**
  - **Job detail:** the job detail panel gains *Previous in chain* (a link to the upstream job)
    and *Next in chain* (a link per downstream job; branches give several). Nothing else in job
    details changes.
  - **Home:** Home's live progress follows the chain. When one link finishes and the next
    starts, the panel switches to the next job and its step progress starts again from the
    beginning.
  - **Refinement:** the UI will be refined in Claude Design once it is built.
- **Structural links publish where facts came from.** A structural link that delivers `rdf`
  publishes a thin layer: its sections as nodes, with heading, order and page range. Facts from
  any link point at the same shared page nodes (see *Fact provenance*), so a consumer can go
  from a fact to the section and narrative it came from.

## Decision log

There are no open questions. These decisions were taken with the product owner on 2026-10-14
(details in the sections above):
- **Base IRI:** the customer's domain, one customer per deployment, set in the Linked data
  panel; when none is set, `id.stocks-hayward.com/{customer}/`.
- **Graph identity:** one graph per original file and document type, with the document node
  shared across types.
- **Entity IRIs:** readable, with five safeguards that keep a move to registered IDs open.
- **Consumer access:** one shared read-only SPARQL user.
- **Ontology licensing:** library ontologies (IDMP-O etc.) are exposed to customers.
- **Retrieval:** hybrid lexical and embedding search, in the mapping-stage PR.
- **Deletion:** deleting a job withdraws its graphs and published S3 outputs.
- **Corrections:** a correction replaces the graph; versions are kept for future history.
- **Retirement:** retiring withdraws what the type delivered, and unretiring re-delivers it from
  the kept reviewed documents. Re-delivery is acceptable; unretiring is expected to be a very
  unusual exception.
- **Delivered formats:** chosen per recipe (CSV, JSON, RDF); RDF needs a mapping.
- **Chained types:** follow-on types (A → B → C). A chain is withdrawn as one atomic unit, while
  delivery stays per link. Retiring a type in a chain withdraws every chain containing it.
- **Fact provenance:** every published fact links to its page, quote, section and step.
