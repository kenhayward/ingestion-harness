# 0011: Publish RDF to Apache Jena Fuseki, mapped to ontologies in the recipe

**Status:** proposed · 2026-10-14 · [design](../design/rdf-publishing.md)

## Context
Content Transformation Studio (CT Studio) publishes each approved document as CSV and JSON to
one S3 target (`TARGET_S3_*`, [ADR 0004](0004-api-reads-publish-target.md)). Consumers want the
same data as a knowledge graph, expressed in the customer and industry ontologies they already
use (for pharmaceutical documents that might be IDMP-O plus a customer extension). They want to
query it with SPARQL, joined with those ontologies. The chief architect recommends Apache Jena
Fuseki as the triple store.

The pipeline already produces data that fits RDF well:
- **Typed outputs.** Recipe fields and table columns have stable ids and a `ValueType`
  (`text|integer|decimal|date|boolean|enum|list`).
- **Provenance.** The reviewed document carries its source sha256, job, recipe version, the
  models used, the reviewer and the review edits.
- **Test runs are never delivered.** Workbench and reference runs cannot reach a consumer.

What is missing:
- a way to import, version and browse ontologies;
- a way to say, in a recipe, which ontology terms each output means;
- a target that is not S3.

Mapping a recipe by hand to an ontology of thousands of terms is slow and needs specialists. The
Workbench already drafts recipes with a model from the brief and the samples, and a person
accepts each change. Mapping should work the same way.

## Decision
- **Ontology library (deployment-wide, admin-managed).**
  - **Sources:** admins import OWL/RDFS (Turtle, RDF/XML, JSON-LD, N-Triples), SKOS vocabularies
    and SHACL shapes, from an uploaded file or from an allowed URL. `owl:imports` are resolved
    against the library first, then from allowed hosts.
  - **Versions:** each import is an immutable **ontology version**, stored as received in the
    runs bucket. The worker parses it (rdflib) and records its terms in Postgres, so the
    library can be searched and browsed.
  - **Tags and policy:** ontologies are tagged by customer and industry and may be marked
    `localOnly`.
  - **Viewing:** everyone can browse the library as a class/property tree with a term detail
    pane and an interactive neighbourhood graph.
- **The brief chooses the ontologies.** A Workbench brief gains an `ontologies` section: the
  pinned library versions that apply to the document type (role `vocabulary` or `shapes`), plus
  free-text guidance such as "products follow IDMP-O; batches use the customer extension".
- **The mapping is part of the recipe.** A recipe gains an optional `semantics` block with:
  - the pinned ontology versions;
  - a class and IRI template for the document;
  - per field and per table: a property, an optional object class and IRI template for entity
    values, a class and IRI template for each row, and the link from the document to each row;
  - for enum and text values, links to SKOS concepts;
  - the SHACL shapes to validate against.

  The block is versioned and immutable with the recipe, validated on both sides of the contract
  (TS and Python), and logged in `template_changes` like every other draft edit. Terms must
  exist in a pinned version, or be declared as recipe-local extension terms.
- **LLM-suggested mapping, accepted by a person.** A new optional Workbench drafting stage,
  `mapping`, proposes typed mapping changes as a `draft` job. Its inputs are:
  - the recipe outputs;
  - content analysis: the values the latest dev runs and references produced for each output,
    with short source snippets;
  - the brief's ontology guidance;
  - for each output, a shortlist of candidate terms retrieved from the selected ontologies.

  The model may choose only from the shortlist, or declare a local term with a label and a
  definition. A check feeds any other IRI back to the model as an error. Each change carries a
  confidence, a reason and the alternatives considered. People accept changes per item, as in
  other stages, and can map by hand in the recipe editor. The stage follows the project's data
  policy, and any `localOnly` ontology in the brief also forces local models.
- **Value linking, not entity resolution.** Enum and controlled values link to SKOS concepts.
  Entities such as a substance or a batch get deterministic IRIs from templates over the
  extracted values (for example `batch/{batch_number|slug}`). Resolving values against external
  reference data is out of scope.
- **Turtle is an output format; Fuseki is a sink.**
  - **Turtle in S3:** when its recipe has a published mapping and RDF publishing is configured,
    a published document is rendered once (rdflib, worker only). The Turtle goes to the S3
    target next to the CSV and JSON, so S3 stays the system of record and Fuseki can be rebuilt
    from it.
  - **Fuseki:** the same bytes are then loaded into Fuseki, one named graph per document, with
    a SPARQL Graph Store Protocol `PUT` that replaces the graph. Republishing and retries are
    idempotent; deleting a document is `DROP GRAPH`.
  - **Provenance:** PROV-O and Dublin Core terms for the job, recipe version, models, reviewer
    and source sha256 go in the same graph.
  - **Ontologies in Fuseki:** each ontology version is also loaded into its own named graph, so
    data and ontology can be queried together (union default graph).
- **SHACL decides delivery.**
  - **During extraction:** the graph is rendered and validated against the recipe's shapes.
    A `sh:Violation` is a review reason, so the job stops in `awaiting_review`, and the review
    screen lists the violations. Warnings and infos only annotate.
  - **At publish:** after the review edits are applied, the graph is validated again before
    anything is written. If it still violates the shapes, the job goes back to
    `awaiting_review` and nothing is delivered. This is a new transition.
- **Opt-in per document type.** Only recipes with a `semantics` block produce RDF. The Fuseki
  connection is deployment configuration (`RDF_ENDPOINT`, `RDF_DATASET`, `RDF_USER`,
  `RDF_PASSWORD`). Without it, Turtle still goes to S3 and nothing is loaded.
- **The customer owns the IRIs: one customer per deployment.**
  - **Customer domain:** the published data belongs to the customer, so its IRIs live under
    the customer's domain (for example `https://data.acme.example/ct/`).
  - **Fallback:** when no base is set, IRIs live under ours,
    `https://id.stocks-hayward.com/{customerSlug}/`. The slug keeps different customers'
    deployments from minting the same IRIs.
  - **No customer at all:** without a customer slug or a base, RDF publishing is skipped.
  - **Where it is set:** an admin sets the customer and base IRI in a new admin-only
    **Linked data** panel (`#/linked-data`, `GET|PUT /api/linked-data/settings`). The values
    are stored in `linked_data_settings`, with every change of base kept in an append-only
    history. `.env` only seeds the first value.
  - **Rules:** the base must be a stable `https` IRI ending in `/`. It must never be the
    address of CT Studio, Fuseki or the object store, and it must not use `localhost`.
  - **Changing it:** after graphs have been published, a change must be confirmed and
    applies to new publishes only. Re-minting the published graphs is an explicit operator
    rebuild.
  - **Layout under the base:** `doc/`, `job/`, `graph/document/`, `graph/ontology/`, entity
    paths from the recipe's IRI templates, and `def/{type}/` for the default vocabulary.
- **Fuseki deployment.**
  - **Service:** a pinned compose service on TDB2 with a persistent volume.
  - **Access:** only the worker holds write credentials, for Graph Store Protocol writes.
    Consumers get read-only SPARQL through a separate user and proxy, as with the lake S3 keys
    ([ADR 0008](0008-s3-read-keys.md)). The admin endpoints are never exposed.
  - **Recovery:** backups and compaction are scheduled. A rebuild command reloads every graph
    from S3.

## Consequences
- **New contracts, changed on both sides together:**
  - the recipe `semantics` block;
  - the brief's `ontologies` section, which also changes `brief.json` in bundles; older
    deployments refuse those bundles under their strict schemas, as with `completedStages`;
  - mapping change ops;
  - job tasks `ontology` (import and parse) and `graph` (preview renders);
  - object keys for ontology sources and graphs.
- **The worker gains rdflib and pySHACL.** The API stays free of RDF parsing and LLM logic: it
  stores uploads, queues jobs and serves the parsed term tables.
- **Fetching by URL is outbound network access from the worker.** It is restricted to an
  allowlist of hosts, to `https`, and by a size cap and a timeout. RDF/XML parsing disables
  external entities, and JSON-LD remote contexts are not fetched.
- **Recipe versions and outputs.** Changing a mapping needs a new recipe version, like any
  other change. A mapping never changes extraction prompts, so the step cache, regression and
  scores are unaffected.
- **IRI stability is the customer's to keep.** When a customer's base is set, the customer must
  keep that domain and path stable. Moving it means re-minting, which consumers see as every
  identifier changing. We commit to keeping `id.stocks-hayward.com` for identifiers only.
- **Backfill.** Documents published before a mapping existed can be backfilled from
  `reviewed-document.json` in the runs bucket, using the mapping of a later version of their
  type.
- **Operations.** Fuseki and TDB2 are a new stateful service, with backups, compaction and
  storage growth from graph replaces. Consumers must not treat Fuseki as the record: S3 is.
- **Retrieval.** Shortlists rely on lexical search over labels, synonyms and definitions
  (Postgres trigram and full text). Embedding search may be needed for large ontologies or
  ones with poor labels.
- **Out of scope:** resolving entities across documents or against reference data, reasoning
  (OWL inference in Fuseki), and very large terminologies such as SNOMED CT (the library caps
  the size of an import).
