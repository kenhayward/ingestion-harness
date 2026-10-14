# Fuseki Publishing Implementation Plan (ADR 0011, step 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Approved documents whose recipe delivers `rdf` are published as one versioned named graph per (file sha256, document type) into an Apache Jena Fuseki dataset, with their entities recorded, the pinned ontologies loaded as TBox graphs, and operator commands to rebuild, backfill and re-mint.

**Architecture:**
- **Worker:** a `GraphStore` port speaks the SPARQL 1.1 Graph Store Protocol: `HttpGraphStore` over httpx, and `FakeGraphStore` in tests. A `GraphRegistry` port keeps the version tables: `PgGraphRegistry` serialises each `(sha256, type)` graph with an advisory lock, and `MemoryGraphRegistry` stands in for tests.
- **Publish:** `publish_template_job` publishes the graph after the S3 writes. It writes the versioned Turtle copy to the target, PUTs it to Fuseki, then records the version and its entities in one transaction.
- **Rebuild:** `rdf_rebuild` reuses the same publish function.
- **Deploy:** a `fuseki` compose service is built from the Apache jar, pinned by sha512.

**Tech Stack:** Python 3.13 (rdflib, httpx, psycopg), Postgres 17, Fastify/Zod, React, Apache Jena Fuseki 6.2.0 on `eclipse-temurin:21-jre`.

**Spec:** `docs/design/rdf-publishing.md` (*Graph identity and versions*, *Entity IRIs* safeguards 2–3, *Production: process, review and publish*, *Fuseki deployment*, *Results and job detail*), ADR `docs/adr/0011-rdf-publishing-and-ontologies.md`.

## Global Constraints
- **Graph IRI:** `{base}graph/source/{sha256}/{typeId}`. **Ontology graph IRI:** `{base}graph/ontology/{id}/{version}`.
- **Version copy:** each publish writes `graphs/{sha256}/{typeId}/v{n}.ttl` to the S3 target (under the target prefix).
- **Lock:** `pg_advisory_xact_lock(hashtext('graph:' || sha256 || ':' || typeId))` is held around reading and incrementing the version and the Graph Store Protocol `PUT`.
- **Transient vs permanent failures:** a GSP 5xx or a transport error is transient (the job is retried); a 4xx is permanent (`needs_review` with the response).
- **No Fuseki configured:** when `RDF_ENDPOINT` is unset, nothing is written to Fuseki, but the Turtle still goes to S3 and the version is still recorded.
- **Test runs** (`deliver=False`) never touch Fuseki or the registry.
- **Worker env:** `RDF_ENDPOINT`, `RDF_DATASET` (default `ct`), `RDF_USER`, `RDF_PASSWORD`.
- **Fuseki service:**
  - dataset `ct`, with `tdb2:unionDefaultGraph true`;
  - endpoints `/ct/sparql` (query), `/ct/get` (gsp-r) and `/ct/data` (gsp-rw, `ct-writer` only);
  - no SPARQL Update;
  - admin (`/$/backup`, `/$/compact`) from localhost only.
- **Migrations are forward-only:** the new one is `0036_published_graphs.sql`.
- **Never call real LLMs or a real Fuseki from unit tests.**

## Review Focus
1. **Two publishes of the same file and type at once:** versions are 1 then 2, never 1 twice; the PUT of the later one wins.
2. **A Fuseki outage mid-publish:** the S3 writes are repeated safely on retry, and no version row is recorded until the PUT succeeds.
3. **A 4xx from Fuseki** (for example a body Fuseki cannot parse): the job goes to `needs_review` with the status and body, and is never retried forever.
4. **A recipe that delivers `rdf` while no base is set:** the existing `DocumentError` path; a recipe without `rdf` delivered never touches the registry.
5. **The same entity minted by two types:** a single `published_entities` row with two `published_entity_sources` rows.

---

### Task 1: Migration and the graph registry

**Files:**
- Create: `db/migrations/0036_published_graphs.sql`, `worker/src/ingest_worker/graph_registry.py`
- Test: `worker/tests/test_graph_registry.py` (store contract on Memory, and on Pg with `IH_TEST_DATABASE_URL`)

**Interfaces (Produces):**
```python
@dataclass(frozen=True)
class EntityRecord: iri: str; kind: str; scoped_key: list[str]
@dataclass(frozen=True)
class GraphPublish:
    sha256: str; template_id: str; graph_iri: str; job_id: str; document_id: str
    template_version: int; base_iri: str; triples: int; entities: list[EntityRecord]
class GraphRegistry(Protocol):
    def publish(self, record: GraphPublish, write: Callable[[int], None]) -> int: ...
        # lock, next = current + 1, write(next) (raises -> nothing recorded), record, return next
    def current(self, sha256: str, template_id: str) -> PublishedGraph | None: ...
    def ontology_loaded(self, ontology_id: str, version: int, base_iri: str) -> bool: ...
    def record_ontology(self, ontology_id: str, version: int, base_iri: str, graph_iri: str) -> None: ...
    def all_current(self) -> list[PublishedGraph]: ...
    def all_ontologies(self) -> list[tuple[str, int, str, str]]: ...
```

**Migration tables:**
- `published_graphs`: PK `(sha256, template_id)`, plus `graph_iri`, `version`, `job_id`, `document_id`, `template_version`, `base_iri`, `triples` and `published_at`.
- `published_graph_versions`: append-only, PK `(sha256, template_id, version)`.
- `published_entities`: `iri` PK, `kind`, `scoped_key jsonb`, `first_published_at`.
- `published_entity_sources`: PK `(iri, sha256, template_id)`, plus `job_id`.
- `published_ontology_graphs`: PK `(ontology_id, version, base_iri)`, plus `graph_iri` and `loaded_at`.

A publish replaces the type's entity sources for that sha256: it deletes them, then inserts the new ones.

**Tests:**
- versions increment;
- a failing `write` records nothing;
- entity sources are replaced;
- an entity shared by two types has one row;
- `current` is None before any publish;
- ontology rows.
- **Pg only:** two threads publishing the same key get versions {1, 2}.

### Task 2: Entities from rendering, and the graph metadata

**Files:** `worker/src/ingest_worker/rdf.py`; Test: `worker/tests/test_rdf.py`

**Produces:**
- `entity_key(template_str, values) -> list[str]`: the filled placeholder texts, in order.
- `render(template, document, ctx) -> Rendering(graph: Graph, entities: list[EntityRecord])`. `render_graph` stays a wrapper around it.
- `with_version(graph, version, published_at) -> Graph`: a copy that adds `<graph_iri> ct:graphVersion n ; dcterms:modified t`.
- **Entities:** values mapped with `object` (`kind` = the object class's expanded IRI) and table rows with an `iri` template (`kind` = the row class's expanded IRI). The document node is not an entity.

**Tests:**
- an object-mapped field yields its entity with its key;
- a row IRI yields one entity per row;
- an unminted value yields none;
- `with_version` adds the two triples and leaves the original untouched.

### Task 3: The Graph Store port

**Files:** Create `worker/src/ingest_worker/graph_store.py`; modify `worker/tests/fakes.py`; Test: `worker/tests/test_graph_store.py` (httpx `MockTransport`), `worker/tests/test_graph_store_integration.py` (`@pytest.mark.integration`, needs `RDF_ENDPOINT`).

**Produces:**
- `GraphStore` Protocol: `put(graph_iri, body: bytes, content_type) -> None` and `delete(graph_iri) -> bool` (False when the graph was absent: a 404).
- `HttpGraphStore(endpoint, dataset, user, password, transport=None)` sends PUT and DELETE to `{endpoint}/{dataset}/data?graph=<iri>` with basic auth.
- **Errors:** `GraphStoreUnavailable` (5xx or transport; retried) and `GraphStoreRejected(DocumentError)` (other 4xx; carries the status and the first 500 characters of the body).
- `graph_store_from_env(env) -> HttpGraphStore | None`.
- `FakeGraphStore` (records `requests`, can be told to fail).

**Tests:**
- the exact request: method, URL with the encoded graph, `Content-Type`, `Authorization`;
- 201/204 succeed;
- a DELETE answering 404 returns False;
- a 500 or a transport error is `Unavailable`;
- a 400 is `Rejected`, with its body.

### Task 4: Publishing the graph (and the TBox)

**Files:**
- Modify `worker/src/ingest_worker/pipeline.py` (`PipelineDeps.graph_store`, `graph_registry`), `template_pipeline.py` (`RenderedGraph.base`, `.entities`; `publish_graph`), `main.py` (wiring, routing `GraphStoreUnavailable` to `fail`).
- Test: `worker/tests/test_template_pipeline.py`.

**Produces:**
- `publish_graph(job, deps, queue, template, document, rendered) -> int | None`.
- `GRAPH_PUBLISHED = "graph published"`, event data `{graph, version, triples, endpoint: bool}`.

**Order inside `registry.publish`'s write callback:**
1. write the target copy `graphs/{sha}/{type}/v{n}.ttl`;
2. `graph_store.put` (when configured);
3. load the pinned ontologies and shapes versions not yet loaded under this base: PUT their normalised N-Triples to `{base}graph/ontology/{id}/{v}`, then `record_ontology`.

Only for `deliver=True` and `"rdf" in formats`, after `publish_outputs`.

**Tests:**
- a publish records version 1 and PUTs the versioned Turtle;
- a second publish of the same file and type is version 2, with the same graph IRI;
- without a graph store, the version and the copy are recorded with `endpoint: false`;
- a test-run approval touches nothing;
- a recipe without `rdf` never publishes a graph;
- a 503 fails the job (retry) with no version recorded;
- a 400 sends it to review;
- the TBox loads once per (version, base);
- entities are recorded.

### Task 5: API and web

**Files:**
- `packages/shared/src/jobs.ts` (`JobGraphSchema`, `JobDetail.graph`), `packages/shared/src/linked-data.ts` (`LinkedDataView.graphStore`).
- API: `apps/api/src/routes/jobs.ts` (the detail from the newest `graph published` event), `apps/api/src/linked-data/repo.ts` (`rdfPublishedCount(base)` over `published_graphs`, `graphStoreStatus()` from the newest event), `docs/openapi.json`.
- Web: `JobDetailPanel` (Graph line), `LinkedDataPage` (Fuseki status).
- Tests: `apps/api/test/jobs.test.ts`, `linked-data.test.ts`, `apps/web/test/*`.

**Behaviour:**
- `JobDetail.graph` is `{iri, version, triples, publishedAt, endpoint} | null`.
- The Linked data panel shows "Graphs published to Fuseki" or "Fuseki not configured: graphs go to S3 only", from the newest event.

### Task 6: Operator commands

**Files:** Create `worker/src/ingest_worker/rdf_rebuild.py`; Test: `worker/tests/test_rdf_rebuild.py`.

**Commands:**
- `python -m ingest_worker.rdf_rebuild` reloads every `published_ontology_graphs` row (normalised N-Triples from the runs bucket) and every current graph's `graphs/{sha}/{type}/v{n}.ttl` from the target, PUT to Fuseki.
- `--backfill TYPE` takes each delivered (succeeded publish) job of TYPE with no current graph for its (sha256, type). It renders `{job}/reviewed-document.json` with the type's newest published recipe that has `semantics`, and publishes through `publish_graph` (the provenance records that recipe version).
- `--remint` re-renders every current graph's job under the current base. A graph whose IRI changed has its old graph deleted first.
- Each command prints one line per graph and a summary.

**Testing:** the functions over ports, with a `RebuildSource` Protocol (`delivered_jobs(type)`, `job(job_id)`); Pg implementation in the module.

### Task 7: Deployment

**Files:**
- Create `deploy/docker/fuseki.Dockerfile`, `deploy/fuseki/config.ttl`, `deploy/fuseki/entrypoint.sh`.
- Modify `deploy/docker-compose.yml` (service `fuseki`, volume `fuseki-data`, internal network `rdf` shared with the worker, worker env), `deploy/docker-compose.dev.yml` (Fuseki on `localhost:3030`), `deploy/.env.example`, `deploy/README.md` (backups, compaction, rebuild), and the CI smoke test (Fuseki answers `/$/ping`).

**Behaviour:** the entrypoint writes the `passwd` file from `RDF_WRITER_PASSWORD` and `RDF_READER_PASSWORD`, and refuses to start without them.

### Task 8: Docs and contracts
- CLAUDE.md contracts: the published graphs tables, `GraphStore`, the event, `JobDetail.graph`, `rdf_rebuild`.
- Design doc as-built notes; `docs/architecture.md` mentions Fuseki.
- Run `npm run check`, the worker suites and the Pg suites.
