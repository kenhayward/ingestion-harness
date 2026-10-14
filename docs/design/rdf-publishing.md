# RDF publishing: ontology library, recipe mapping and Apache Jena Fuseki

**Status:** proposed · 2026-10-14 · [ADR 0011](../adr/0011-rdf-publishing-and-ontologies.md)

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
| Opt-in | Per document type: only recipes with a published mapping produce RDF |
| Data policy | Mapping follows the project's data policy; a `localOnly` ontology also forces local models |
| TBox in Fuseki | Yes: one named graph per ontology version |
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
{base}doc/{document_id}               the document (uuid, opaque)
{base}job/{job_id}                    provenance activity
{base}graph/document/{document_id}    the document's named graph
{base}graph/ontology/{id}/{version}   an ontology version's graph (TBox)
{base}{entity}/{key}                  entities from recipe IRI templates (batch, substance, …)
{base}def/{typeId}/{term}             default vocabulary and recipe-local terms
```
A recipe may still give an absolute IRI template, for example when a customer mandates a
separate namespace for one kind of entity. Entity keys must be scoped (for example
`batch/{site|slug}/{batch_number|slug}`) so that values that repeat across sites or
manufacturers do not collide.

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
  - `imported_by`, `imported_at`.

  A `ready` version is immutable (trigger, as for published templates). Importing new content
  under an existing id creates the next version, and importing identical content (same
  `sha256`) is refused with a 409 that names the existing version.
- **`ontology_terms`:** one row per term of a ready version.
  - identity: `version_id`, `iri`, `kind` (`class`, `object_property`, `datatype_property`,
    `annotation_property`, `concept`, `scheme`, `shape`);
  - names: `label` (preferred `skos:prefLabel` or `rdfs:label`, English first), `alt_labels
    text[]`, `definition` (`skos:definition`, `rdfs:comment`, `IAO:0000115`);
  - structure: `parents text[]` (`rdfs:subClassOf`, `rdfs:subPropertyOf`, `skos:broader`),
    `domain text[]`, `range text[]`, `scheme` (for a concept), `deprecated`;
  - `defined_in` (the version that defines the term, when it was pulled in by an import).

  A trigram index on `label || alt_labels` and a full-text index on the definition serve search
  and mapping retrieval.
- **`ontology_usage`** is a view, not a table: the recipes, briefs and published versions that
  pin each ontology version. Deleting a version is refused while anything published uses it;
  an unused version can be deleted. Retiring an ontology (`retired_at`) hides it from brief
  pickers without breaking pinned uses.

Object keys (runs bucket; `ontologySourceKey`/`storage.ontology_source_key`):
- `ontologies/{id}/{version}/source.{ext}`: as received;
- `ontologies/{id}/{version}/normalized.nt`: canonical N-Triples, used for the Fuseki load and
  for rebuilds.

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
6. **Finish:** set `status = ready`, with the `stats`.

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
    iri: "doc/{document_id}"         # relative to the base IRI
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
  `ct:normalisationIssue` on a reified statement. It is never written as an invalid typed
  literal.
- **`object`.** The value becomes an entity. Its IRI is minted by the template from the value
  or the row's columns. Filters: `slug` (lowercase ASCII, `-`), `upper`, `sha1` (an opaque id).
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
  use `{document_id}`, `{type}`, `{version}`, `{value}` (fields), or column ids (rows).

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
   the selected vocabulary versions:
   - **matching:** trigram on labels and synonyms plus full text on definitions, using the
     output's name, description, id words and its top observed values;
   - **kinds:** properties ranked by datatype or object compatibility with the `ValueType`;
     classes for the document and each table;
   - **concept candidates** per enum value or frequent text value, from schemes whose concepts
     match.

   The shortlist holds k = 15 terms per output with their label, definition, domain and range,
   and parents. All candidates are recorded in the proposal so people can see the alternatives.
5. **Budget:** the context is capped at `drafting.MAX_MAPPING_TERMS` (300 terms in total). The
   worst-matching candidates are dropped first.

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
  The ontology graphs are passed as `ont_graph` so that `sh:class` checks see
  `rdfs:subClassOf`.

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

Graph IRIs: `{base}graph/document/{document_id}`. Re-uploading the same file creates a
new document, and so a new graph; `dcterms:source` lets consumers group them by sha256.

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
  5. Record the event `graph published` (`graph`, `triples`).
- **Test runs** (`deliver=False`) write the Turtle and report to the runs bucket only. They
  never touch Fuseki.

The publisher is a port (`publishers.py`): `Publisher.publish(rendered) -> list[Published]`,
with `S3Publisher` (today's `Target`) and `GraphStorePublisher`. Unit tests use
`FakeGraphStore`, which records the requests.

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
- **Consumers:** read-only SPARQL through the reverse proxy, like the lake S3 host. Phase 1
  uses one shared reader credential. Per-consumer credentials are an open question.
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
| Recipe `semantics` block, validation | `SemanticsSchema`, `semanticsIssues` in `packages/shared/src/template.ts` | `template.Semantics`, `Semantics.issues`; fixture `semantics-issues.json` |
| Brief ontologies | `BriefBodySchema.ontologies/ontologyGuidance`, `BRIEF_SECTIONS` | `drafting.DraftParams` (brief passed in params) |
| Mapping change ops | `DraftChangeSchema` (5 ops), `applyChanges` | `draft_changes.apply_changes`, `draft_stages.MAPPING`; fixture `draft-changes.json` |
| Job tasks `ontology`, `graph`; `publish → awaiting_review` | `packages/shared/src/jobs.ts` | migration CHECK list, `queue.py` |
| Object keys | `ontologySourceKey`, `graphPreviewKey`, `.ttl` in `outputKey` | `storage.ontology_source_key`, `graph_preview_key`, `output_key(…, "ttl")` |
| Ontology tables | `OntologyRepo` (`apps/api/src/ontologies/`) | `PgOntologyStore` (worker reads terms, writes parse results) |
| Linked data settings, base IRI | `LinkedDataSettingsSchema`, `effectiveBaseIri`, `FALLBACK_BASE_IRI` in `packages/shared/src/linked-data.ts`; `LinkedDataRepo` | `rdf.effective_base_iri`, `PgLinkedDataSettings` (reads `linked_data_settings`); shared fixture `packages/shared/test/fixtures/base-iri.json` |

## Rollout (each PR green and deployable)
1. **Library:** migration 0032, `ontology` jobs (file upload only), term index, routes, the
   Ontologies page (list, tree, detail). No Fuseki yet.
2. **URL import and graph view:** allowlisted fetch, `owl:imports`, hardening tests,
   neighbourhood route and Cytoscape view.
3. **Recipe `semantics` and rendering:** contract on both sides, validation, the recipe
   editor's Mapping sub-tab (hand mapping), Turtle in test runs, graph previews, sample graph
   view, and the Linked data admin panel (`linked_data_settings`, base IRI with fallback).
4. **Brief and the LLM mapping stage:** brief ontologies, `mapping` stage, shortlist
   retrieval, Mapping tab, overview stage, bundle changes.
5. **SHACL:** validation in process and publish, review reasons, the
   `publish → awaiting_review` transition, the Review screen's Graph tab.
6. **Fuseki:** compose service, config, `GraphStorePublisher`, TBox loads, job graph status,
   rebuild and backfill commands, backups and compaction docs, smoke test.
7. **Consumer access:** reader credentials through the proxy (and per-consumer credentials if
   decided), docs for consumers.

Steps 1–3 deliver value without Fuseki (browsing, mapping and Turtle in S3). Step 6 can be
pulled forward if consumers need SPARQL early with hand-written mappings.

## Open questions (for the chief architect)
1. **Entity IRI opacity:** should entity IRIs be readable (`batch/acme-site-1/pv-2301`) or
   opaque (a hash of the scoped key)? Readable IRIs leak values into identifiers. Either way
   they change when a value is corrected. The base IRI itself is decided (see *IRI policy*).
2. **Graph identity:** one graph per uploaded document (proposed), or per source file (sha256)
   so re-uploads replace earlier graphs?
3. **Consumer access:** one shared read-only SPARQL user, per-consumer credentials (as with
   lake S3 keys), or a SPARQL gateway that applies per-type visibility?
4. **Licensing:** may industry ontologies (for example IDMP-O, or licensed terminologies) be
   stored in the library and in Fuseki, and exposed to consumers in the TBox graphs?
5. **Retrieval quality:** is lexical shortlisting enough for the ontologies in scope, or should
   phase 4 include embedding search (pgvector) from the start?
6. **Deletion and retirement:** should deleting a job or retiring a type remove its graphs?
   Today published S3 copies are kept, and the proposal keeps graphs the same way.
7. **Corrections after publication:** if a published document is later re-reviewed, the graph
   is replaced. Do consumers need history (graph versions or a change feed)?
