# Delivery bridge, phase 3: RDF behind the bridge — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Graph publishing behaves as it does today, but it is delivered through the bridge.

- A published document's graph is loaded into Fuseki.
- Its versioned Turtle copy lands at today's key.
- The pinned ontologies are loaded once per base.
- Withdraw, republish, rebuild, backfill and remint keep working.

The worker no longer talks to Fuseki and no longer holds its write credentials.

**Architecture:**

- **The bridge** gains a built-in `rdf` sink: an HTTP Graph Store Protocol client behind a port.
  It delivers a package's `rdf` part with a PUT that replaces the graph, and it refuses to replace
  a newer version. Its target object routes drop a graph, for withdraw and remint.
- **CT Studio** gains one target, `rdf-default`, seeded from `RDF_ENDPOINT`, as a
  `publish_targets` row of the new kind `rdf`. It is mirrored to the bridge like the S3 targets.
- **The worker** keeps the graph registry. It assigns and commits the version under the
  registry's lock *before* the hand-off. It then submits **one package**: the outputs, the
  versioned copy as the file `graph-version`, and the graph as the `rdf` part. The package goes to
  the recipe's S3 target and, when the recipe delivers `rdf`, to `rdf-default`.
- **Ontology graphs** (TBox), rebuilds and remints are `graph` packages.

**Tech stack:** as in phase 2. The bridge's Graph Store client uses Node's `fetch`; no new
dependency.

**Spec:** [docs/superpowers/specs/2026-10-19-delivery-bridge-design.md](../specs/2026-10-19-delivery-bridge-design.md):
the phase 3 row, "RDF in detail", "Targets" (shapes of the RDF target) and "Phase 2 as built".

**Builds on:**
- [phase 2 plan](2026-10-19-delivery-bridge-2-s3-behind-bridge.md) and its as-built record in
  the spec;
- [ADR 0011](../../adr/0011-rdf-publishing-and-ontologies.md) (RDF publishing);
- [ADR 0017](../../adr/0017-delivery-bridge.md);
- [ADR 0018](../../adr/0018-capabilities-as-nodes.md) (outcomes, equivalence traces).

## Global constraints

- Everything in phase 1's and phase 2's global constraints still applies: TDD, red first;
  `npm run check` is the one gate; tests stay offline; the same contract on both sides with
  shared fixtures; no vendor names of private external sinks anywhere.
- **Keys and graph names don't move.**
  - The versioned copy stays at `{prefix}graphs/{sha256}/{template}/v{n}.ttl` on the target that
    holds it (`published_graphs.target_id`).
  - Graph names stay `{base}graph/source/{sha256}/{typeId}`, and ontology graphs stay
    `{base}graph/ontology/{id}/{version}`.
  - The bytes loaded into Fuseki equal the bytes of the copy, as today (`to_turtle(with_version(...))`).
- **CT Studio keeps the graph registry** (spec, non-goals). This covers `published_graphs`,
  `published_graph_versions`, entities, the advisory lock and version numbering, unchanged. The
  version is committed under the lock before the package is submitted.
- **The worker never reaches Fuseki** once Task 8 lands. Only the bridge writes graphs. The API
  keeps its direct Fuseki access **for backup and restore only** (`backup/fuseki.ts`), unchanged.
- **When `RDF_ENDPOINT` is unset**, nothing changes for the user. `rdf-default` isn't seeded, and
  graphs are still versioned and copied to the S3 target. The `graph published` event says
  `endpoint: false`, and RDF recipes never go to review for a missing target (spec).
- **Upgrades change nothing visible.**
  - A deployment with `RDF_ENDPOINT` set gets `rdf-default` on first start (API and worker both
    seed it).
  - Its first publish loads into the same dataset.
  - Ontologies already loaded are not loaded again.
- **Equivalence goldens are rewritten only on purpose**, in Task 8. The rewrite moves Fuseki
  requests out of `graph_store` and into the bridge's deliveries. Every object and every Turtle
  graph stays byte-for-byte the same, and the task checks that against the old golden.

## Decisions this plan makes (within "left to the builder"; recorded in the spec by Task 11)

- **`rdf-default` is a `publish_targets` row, kind `rdf`.**
  - Its dataset goes in `bucket` (default `ct`) and its Fuseki URL in `endpoint`; `prefix` is `''`.
  - This keeps phase 2's one registry, and `job_deliveries.target_id`'s foreign key, intact.
  - RDF targets are **seeded only**. The API refuses to create one, and allows only its label to
    be edited. They aren't S3 targets: no read keys, no bucket creation, and never a recipe's
    `publishTo`.
- **Phase 3 has one triple store.** A recipe whose formats include `rdf` delivers to its S3
  target, plus `rdf-default` when that exists. Graph withdraw and remint drop graphs from
  `rdf-default`.
- **The Fuseki endpoint and user live in the shared connection, as S3's endpoint does.** The
  target's destination is `{ dataset }`. This differs from the spec's wording ("a dataset URL")
  so that the connections page can test the connection on its own.
- **The connection is `rdf-default`, env-keyed.**
  - `fields: { endpoint, user }` come from the API's `RDF_ENDPOINT` and `RDF_USER`.
  - The password comes from `secretEnv: 'RDF_PASSWORD'` in the bridge's container, added to
    `CREDENTIAL_ENV_NAMES`.
  - An admin can later replace it with a stored secret on the connections page.
- **The RDF sink declares**:
  - `accepts: ['files', 'data', 'rdf']`;
  - `replace: true`, `withdraw: true`, `readBack: false`, `browse: false`;
  - connection kind `shared`.

  The S3 sink adds `rdf` to its `accepts`. One package goes to every target, and a sink "accepts"
  a part it may ignore, as phase 2 ruled for S3 and `data`.
- **A newer version is never replaced.** Before a PUT, the RDF sink reads the graph's
  `ct:graphVersion` (`https://id.stocks-hayward.com/ns/ct#graphVersion`) with SPARQL. If the
  store already holds this version or a newer one, the delivery succeeds without writing; its
  receipt says it was superseded. This keeps Fuseki at the newest version when retries arrive out
  of order.
- **An ontology graph counts as loaded once its delivery hasn't failed.**
  - `published_ontology_graphs` gains `delivery_id uuid NULL`.
  - `ontology_loaded` is true when a row exists, and either it has no delivery (loaded before the
    bridge) or that delivery is not `failed` or `needs_user` in `job_deliveries`.
  - A failed TBox load is therefore retried by the next publish.
- **Graph packages' idempotency key** is `sha256("graph\n" + graphName + "\n" + version)` (lower
  hex), the same in TypeScript and Python, pinned by the shared fixture.
- **Graph drops use the target object route** `POST /v1/targets/rdf-default/objects:delete`
  with `{ bucket: <dataset>, key: <graph IRI> }`. The RDF sink confines `bucket` to its dataset
  and requires `key` to be an absolute `http(s)` IRI. No RDF-specific producer route is added.

## Review focus

1. **Two versions of one graph delivered out of order.** For example, v1 fails over, v2 succeeds,
   then v1's retry succeeds. Fuseki must end holding v2. *Test: Task 3, "an older version never
   replaces a newer one".*
2. **A failed ontology load.** The data graph is delivered, but its TBox graph's delivery fails.
   The next publish under that base must load the ontology again. *Test: Task 7, "a TBox whose
   delivery failed is loaded again".*
3. **Upgrade with graphs and ontologies already loaded.** The first publish after the upgrade must
   load nothing that was loaded before (rows without a `delivery_id`), and must land the same
   graph name and copy key. *Tests: Task 7, "ontologies loaded before the bridge count as
   loaded"; Task 10, the upgrade smoke check.*
4. **Withdraw while the bridge doesn't know `rdf-default` yet** (the mirror is lagging after an
   upgrade or a restore). The copies must be deleted and the graph drop retried, never skipped.
   *Test: Task 9, "a graph drop the bridge can't take yet is retried".*
5. **An ontology too large for one package** (over `BRIDGE_MAX_PACKAGE_MB`). The job must go to
   review naming the ontology, and must not retry until it fails. *Test: Task 7, "a refused TBox
   package sends the job to review naming the ontology".*

---

### Task 1: Contract — graph packages, the `rdf` part and the graph idempotency key

**Files:**
- Modify: `packages/bridge-contract/src/idempotency.ts` (add `graphIdempotencyKey`)
- Modify: `packages/bridge-contract/src/conformance/suite.ts`. A sink whose `describe` accepts
  `rdf` must also deliver `package-graph.json`.
- Create: `packages/bridge-contract/test/fixtures/package-document-rdf.json`. This is a document
  package with `files` including `graph-version` (name `graphs/<sha>/<type>/v2.ttl`), and `rdf`
  `{ graphName, version: 2, turtle }`.
- Modify: `packages/bridge-contract/test/fixtures/idempotency.json`. Add `graph` cases.
- Modify: `worker/src/ingest_worker/bridge/models.py` (add `graph_idempotency_key`)
- Test: `packages/bridge-contract/test/{package,fixtures}.test.ts`, `worker/tests/test_bridge_models.py`

**Interfaces:**
- Produces: `graphIdempotencyKey(graphName: string, version: number): string` (TS);
  `graph_idempotency_key(graph_name: str, version: int) -> str` (Python).
- Produces: fixture `package-document-rdf.json`, read by Tasks 3, 4 and 6.

- [ ] **Step 1: Write the failing tests.**
  - TS: "graph keys match the fixture" (every `graph` case in `idempotency.json`).
  - TS: "a document package with an rdf part parses and lists the parts files, data, rdf".
  - Python: `test_graph_idempotency_key_matches_the_fixture`.
  - Python: `test_the_document_rdf_package_round_trips` (re-serialises unchanged).
- [ ] **Step 2: Run them.** Run `npx vitest run --root packages/bridge-contract` and
  `cd worker && uv run pytest tests/test_bridge_models.py`. Expected: FAIL (missing function and
  missing fixture).
- [ ] **Step 3: Implement** both key functions and the fixture. Extend the conformance suite with
  the check "delivers a graph package", run only when `describe.capabilities.accepts` includes
  `rdf`.
- [ ] **Step 4: Run them again.** Expected: PASS. `npx vitest run --root apps/bridge
  conformance-fake` still passes, since the fake sink doesn't accept `rdf`.
- [ ] **Step 5: Commit.** `git commit -m "contract: graph packages and the graph idempotency key"`

### Task 2: Bridge Graph Store port and HTTP client

**Files:**
- Create: `apps/bridge/src/rdf/store.ts`
- Test: `apps/bridge/test/rdf-store.test.ts`, `apps/bridge/test/integration/fuseki.test.ts`
  (opt-in, skipped unless `IH_TEST_FUSEKI_URL` is set; ported from
  `worker/tests/test_graph_store_integration.py`)

**Interfaces:**

```ts
export interface GraphStorePort {
  put(graphIri: string, body: string, contentType: 'text/turtle'): Promise<void>;
  delete(graphIri: string): Promise<boolean>;          // false: there was no such graph
  version(graphIri: string): Promise<number | null>;   // its ct:graphVersion, null when absent
  ping(): Promise<void>;                               // SPARQL ASK {} — Test connection
}
export class HttpGraphStore implements GraphStorePort {
  constructor(opts: { endpoint: string; dataset: string; user: string | null; password: string | null; fetch?: typeof fetch; timeoutMs?: number });
}
export class MemoryGraphStore implements GraphStorePort { readonly graphs: Map<string, string>; }
```

- URLs:
  - Graph Store: `{endpoint without trailing /}/{dataset}/data?graph=<iri>`.
  - SPARQL: `{endpoint}/{dataset}/sparql`, as in `worker/src/ingest_worker/graph_store.py`.
- Basic auth when `user` is set; timeout 120 s; the PUT content type is
  `text/turtle; charset=utf-8`.
- `version` runs `SELECT ?v WHERE { GRAPH <g> { <g> <https://id.stocks-hayward.com/ns/ct#graphVersion> ?v } }`
  and returns the greatest integer, or null.
- Errors are `SinkError`s:
  - transport errors, timeouts and 5xx → `instance_unavailable` (retryable);
  - 401 and 403 → `credential_rejected`;
  - any other 4xx → `content_rejected`;
  - the message never echoes the response body.
- `MemoryGraphStore.version` parses `ct:graphVersion` from the stored Turtle with a regex. That's
  enough for its own fixtures, and no RDF library is needed.

- [ ] **Step 1: Write the failing tests** (a stubbed `fetch`):
  - "put sends the body to the graph's data URL with basic auth";
  - "delete answers false on 404";
  - "version reads ct:graphVersion and is null for an absent graph";
  - "5xx and a refused connection are instance_unavailable";
  - "401 is credential_rejected";
  - "400 is content_rejected without the response body";
  - "MemoryGraphStore keeps graphs and their versions".
- [ ] **Step 2: Run them.** Run `npx vitest run --root apps/bridge rdf-store`. Expected: FAIL.
- [ ] **Step 3: Implement** `store.ts`.
- [ ] **Step 4: Run them again.** Expected: PASS. With a throwaway Fuseki
  (`IH_TEST_FUSEKI_URL=http://127.0.0.1:<port>`), the integration test passes too.
- [ ] **Step 5: Commit.** `git commit -m "bridge: Graph Store client"`

### Task 3: The built-in `rdf` sink

**Files:**
- Create: `apps/bridge/src/sinks/rdf.ts`
- Test: `apps/bridge/test/rdf-sink.test.ts`. Add the `rdf` sink to the conformance run in
  `apps/bridge/test/conformance-fake.test.ts`, served with `serveSink` over a `MemoryGraphStore`.

**Interfaces:**
- Consumes: `GraphStorePort` (Task 2); `SinkPort`, `TargetObjects`, `SinkError` (`sinks/port.ts`);
  `PackageSchema` and the Task 1 fixtures.
- Produces: `RDF_SINK_ID = 'rdf'`;
  `class RdfSink implements SinkPort, TargetObjects { constructor(opts: { store: (credential: RdfCredential, dataset: string) => GraphStorePort }) }`;
  `type RdfCredential = { endpoint: string; user: string | null; password: string | null }`.
- `describe`:
  - connection kind `shared`;
  - credential fields `endpoint` (not secret), `user` (not secret) and `password` (secret);
  - destination fields `[{ id: 'dataset', kind: 'fixed', required: true }]`;
  - capabilities as in "Decisions".
- `deliver`:
  - **No `rdf` part:** `content_rejected` ("a triple store takes a package with a graph").
  - **Otherwise:** read `version(rdf.graphName)`. If it is `>= rdf.version`, succeed with
    receipt `{ written: [{ kind: 'graph', id: graphName, label: 'superseded by v<n>', url: null }] }`.
    Else `put(graphName, rdf.turtle)` and succeed with receipt `{ written: [{ kind: 'graph', id: graphName, label: 'v<version>', url: null }] }`.
  - **Both `document` and `graph` packages** take the same path. Ontology graphs carry no
    `ct:graphVersion`, so they are always put.
- `TargetObjects`:
  - `deleteObject(place, { bucket, key })` drops graph `key`, after checking that `bucket`
    equals `destination.dataset` and that `key` is an absolute `http(s)` IRI.
  - `putObject` is `put`, with the same checks.
  - `readObject` is unsupported (405 through the route's `readBack` gate).
  - `probeTarget` is `ping`, then "Connected to dataset `<dataset>`", with failing steps named
    `connect` and `credentials`.
- `testConnection(credential)` is `ping` against the dataset `ct`, the default dataset; the
  connections page tests the endpoint and the credentials. A target's own Test connection
  (`probeTarget`) uses the target's dataset.

- [ ] **Step 1: Write the failing tests:**
  - "delivers the rdf part with a PUT and a receipt";
  - **"an older version never replaces a newer one"** (Review focus 1). Deliver v2, then v1:
    the store keeps v2's Turtle, and v1's receipt says superseded.
  - "the same version again is superseded, not rewritten";
  - "a graph package (ontology) is put whatever is stored";
  - "a package without rdf is content_rejected";
  - "objects:delete drops the graph, refusing another dataset or a relative key";
  - "readObject is unsupported".
  - The conformance suite passes against `RdfSink`.
- [ ] **Step 2: Run them.** Run `npx vitest run --root apps/bridge rdf-sink conformance`.
  Expected: FAIL.
- [ ] **Step 3: Implement** `sinks/rdf.ts`.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "bridge: built-in rdf sink"`

### Task 4: Bridge wiring — register `rdf`, S3 accepts `rdf`, `RDF_PASSWORD` allowlisted

**Files:**
- Modify: `apps/bridge/src/wiring.ts`. Register
  `[RDF_SINK_ID]: new RdfSink({ store: (c, dataset) => new HttpGraphStore({ ...c, dataset }) })`
  next to `S3_SINK_ID`.
- Modify: `apps/bridge/src/sinks/s3.ts` `capabilities.accepts` to `['files', 'data', 'rdf']`. It
  writes `files` (which include `graph-version`) and ignores `rdf`.
- Modify: `apps/bridge/src/connections/repo.ts` `CREDENTIAL_ENV_NAMES` (add `RDF_PASSWORD`), and
  `connections/credential.ts`. A connection of sink `rdf` resolves to `RdfCredential`
  (`fields.endpoint`, `fields.user`, the secret as `password`).
- Test: `apps/bridge/test/{server-wiring,s3-sink,credentials}.test.ts`

- [ ] **Step 1: Write the failing tests:**
  - "the registry has s3 and rdf";
  - "the s3 sink accepts a package with an rdf part and writes graph-version at prefix + its
    name", using `package-document-rdf.json`;
  - "an env-keyed rdf connection reads RDF_PASSWORD, and an unlisted variable is refused".
- [ ] **Step 2: Run them.** Run `npx vitest run --root apps/bridge`. Expected: the three FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS (the whole bridge suite).
- [ ] **Step 5: Commit.** `git commit -m "bridge: wire the rdf sink"`

### Task 5: CT Studio registry — the `rdf` kind, seeding and mirroring `rdf-default`

**Files:**
- Create: `db/migrations/YYYYMMDDHHMM_rdf_targets.sql` (named per the repo's convention):
  - `publish_targets.kind` CHECK becomes `('internal', 'external', 'rdf')`;
  - `published_ontology_graphs` gains `delivery_id uuid`.
- Modify: `packages/shared/src/publish-targets.ts`:
  - `TARGET_KINDS` gains `'rdf'`;
  - `TargetCreateBodySchema` keeps only `internal | external`;
  - the view of an `rdf` target shows `endpoint` (non-secret) and `bucket` as the dataset.
- Modify: `apps/api/src/publish-targets/{repo,pg,seed}.ts`. Add
  `rdfSeed(env): RdfSeed | null` (from `RDF_ENDPOINT`, `RDF_DATASET` default `ct`, `RDF_USER`
  default `ct-writer`) and `seedRdfTarget(repo, env, log)`:
  - it inserts `rdf-default` (label `Triple store`, kind `rdf`, `source: 'env'`) once;
  - a later change in `.env` logs a warning, like `default`;
  - with `RDF_ENDPOINT` blank it seeds nothing.
- Modify: `apps/api/src/routes/publish-targets.ts`:
  - create with kind `rdf` → 400 `triple store targets come from RDF_ENDPOINT`;
  - patch of an `rdf` target accepts `label` only;
  - delete of an `rdf` target → 409 `<label> comes from RDF_ENDPOINT`;
  - `TargetStores.ensureBucket` and read-key grants skip `rdf`.
- Modify: `apps/api/src/bridge/mirror.ts`. An `rdf` row is mirrored as connection `rdf-default`
  (`PUT /v1/connections/rdf-default`:
  `{ name: 'Triple store', sinkId: 'rdf', fields: { endpoint, user }, secret: null, secretEnv: 'RDF_PASSWORD' }`).
  The target is then `PUT /v1/targets/rdf-default`:
  `{ label, sinkId: 'rdf', instanceId: null, connectionId: 'rdf-default', destination: { dataset } }`.
  The connection is written only when the bridge lacks it, so an admin's stored secret is kept.
- Modify: `apps/api/src/server.ts` (seed after the `default` seed, before the sync).
- Modify: `apps/api/src/templates/definitions.ts` `templateIssues`. A `delivery.publishTo`
  naming an `rdf` target is an issue: `<id> is a triple store: name an S3 target`.
- Test: `apps/api/test/publish-targets-{routes,seed}.test.ts`, `apps/api/test/bridge-mirror.test.ts`,
  `apps/api/test/integration/publish-targets-pg.test.ts` (memory and Pg contract), and the
  existing `templateIssues` tests in `apps/api/test/`

- [ ] **Step 1: Write the failing tests:**
  - "RDF_ENDPOINT seeds rdf-default once, and a changed .env only warns";
  - "no RDF_ENDPOINT, no rdf-default";
  - "creating an rdf target is refused; its label can change; it can't be deleted";
  - "an rdf target is mirrored as the rdf-default env connection and a target with destination
    { dataset }";
  - "an rdf-default connection the bridge already has is not overwritten";
  - "publishTo naming an rdf target is an issue";
  - "an rdf target gets no bucket and no read keys".
- [ ] **Step 2: Run them.** Run `npx vitest run --root apps/api publish-targets bridge-mirror templates`.
  Expected: FAIL.
- [ ] **Step 3: Implement**, including the migration. Run the Pg contract with
  `IH_TEST_DATABASE_URL=<throwaway> npx vitest run --config apps/api/vitest.integration.config.ts publish-targets-pg`.
- [ ] **Step 4: Run them again.** Expected: PASS. Run `npm run check`. Regenerate the OpenAPI
  snapshot if the view schema changed it.
- [ ] **Step 5: Commit.** `git commit -m "api: the rdf-default target, seeded and mirrored"`

### Task 6: Worker — seed and resolve `rdf-default`; the package carries the graph

**Files:**
- Modify: `worker/src/ingest_worker/publish_targets.py`:
  - `rdf_seed(env)` and `seed_rdf_target(store, env) -> list[str]` mirror the API's (Task 5);
  - `LiveTargets.rdf() -> Target | None` returns `rdf-default` when the registry has it, as
    `Target("rdf-default", <dataset>, "")`. The `Targets` protocol (`pipeline.py`) gains
    `rdf()`, and `FakeTargets` (`tests/fakes.py`) gains an `rdf` argument.
- Modify: `worker/src/ingest_worker/main.py`. Call `seed_rdf_target` beside `seed_default_target`.
- Modify: `worker/src/ingest_worker/bridge/package.py`:
  - `build_package(..., graph: GraphVersion | None = None)` adds the file `graph-version`
    (name `graph_version_key(sha, template, version)`, `text/turtle`) and
    `rdf = PackageRdf(graph_name, version, turtle)`.
  - `deliver_document(..., targets: list[Target], graph: GraphVersion | None = None) -> Delivered`
    replaces `target: Target` and submits one request for every target.
  - `build_graph_package(graph_name: str, version: int, turtle: str, *, deployment: str) -> BridgePackage`
    (kind `graph`, `provenance` null, no files, key `graph_idempotency_key`).
  - `deliver_graph_package(deps, job, package: BridgePackage, target: Target, acting: ActingUser | None) -> str`
    returns the delivery id. TBox loads and rebuilds use it.
  - `@dataclass(frozen=True) class GraphVersion: graph_name: str; version: int; turtle: bytes; copy_key: str`.
    It lives here, not in `template_pipeline.py`, which imports this module.
- Test: `worker/tests/test_bridge_package.py`, `worker/tests/test_publish_targets.py`

**Interfaces:**
- Produces:

```python
@dataclass(frozen=True)
class Delivered:
    outputs: list[RenderedOutput]          # the files target recorded: today's outputs, re-keyed with its prefix (never graph-version)
    s3: tuple[str, str]                    # (target id, delivery id) of the files target
    deliveries: list[tuple[str, str]]      # every (target id, delivery id), files target first
```

- The first target is the one whose files are recorded (`record_published`). Any further
  target is `rdf-default`.

- [ ] **Step 1: Write the failing tests:**
  - "a package with a graph carries graph-version at today's key and the rdf part";
  - "the graph-version file is never among the recorded outputs";
  - "one request names every target, and the deliveries come back per target";
  - "a graph package has kind graph, no provenance and the graph key";
  - "rdf-default is seeded from RDF_ENDPOINT and resolved by LiveTargets.rdf()";
  - "without RDF_ENDPOINT, rdf() is None".
- [ ] **Step 2: Run them.** Run
  `cd worker && uv run pytest tests/test_bridge_package.py tests/test_publish_targets.py`.
  Expected: FAIL.
- [ ] **Step 3: Implement.** Existing callers pass `targets=[target]`, so behaviour stays as it is
  until Task 7.
- [ ] **Step 4: Run them again,** and the worker suite (`uv run pytest`). Expected: PASS, and
  the equivalence goldens unchanged.
- [ ] **Step 5: Commit.** `git commit -m "worker: the package carries the graph"`

### Task 7: Worker — publish a graph through the bridge (versions first, then one hand-off)

**Files:**
- Modify: `worker/src/ingest_worker/template_pipeline.py`. Replace `publish_graph` with
  `prepare_graph(job, deps, queue, template, document, rendered, target: Target) -> GraphVersion | None`:
  - under `registry.publish(record, write)`, `write(version)` only builds the versioned Turtle (no I/O);
  - the rows are committed, and `GRAPH_PUBLISHED` is emitted with `endpoint: deps.targets.rdf() is not None`;
  - it returns the version, or None without a registry.

  Replace `load_tbox` with `tbox_packages(deps, registry, template, base) -> list[TboxLoad]`
  (`TboxLoad(ontology_id, version, graph_iri, package)`), covering every pin
  `registry.ontology_loaded` says isn't loaded.

  `GraphDelivery.deliver` becomes `GraphDelivery.prepare(job, deps, queue, target) -> GraphVersion | None`.
- Modify: `worker/src/ingest_worker/graph_registry.py`:
  - `record_ontology(..., delivery_id: str | None)`;
  - `ontology_loaded` follows "Decisions" (Pg: a `LEFT JOIN job_deliveries`; memory: a status
    callback).
- Modify the callers to prepare the graph first, then hand off once:
  - `outcomes.apply_outcome` (`Deliver`);
  - `template_pipeline.publish_template_job`;
  - `withdrawal.run_republish`.

  Each one does the following:
  1. Prepare the graph, then build the TBox loads.
  2. `deliver_document(targets=[s3] + ([rdf] if graph and rdf else []), graph=...)`.
  3. Deliver each TBox package to `rdf` alone (`deliver_graph_package`), then
     `record_ontology(..., delivery_id)`.
  4. `record_published(job, delivered.outputs, s3_target, delivered.s3[1])`.
  5. `queue.delivering(job, outputs, bucket, delivered.deliveries + tbox deliveries)`.

  Nothing goes to `rdf-default` when it is absent, so the copy still goes to the S3 target.
- Test: `worker/tests/test_template_pipeline.py`, `worker/tests/test_graph_registry.py`,
  `worker/tests/test_outcomes.py`, `worker/tests/test_withdrawal.py`

- [ ] **Step 1: Write the failing tests** (FakeBridge with targets `default` and `rdf-default`).
  - Rewrite `test_a_publish_puts_the_versioned_graph_into_the_store` as "a publish hands the
    graph to rdf-default and its copy to the S3 target in one package". The package's
    `rdf.turtle` equals the copy's bytes, and the graph name and copy key are unchanged.
  - "the version is recorded before the hand-off" (a refused hand-off leaves the version row).
  - "without rdf-default the graph is still versioned and copied, endpoint false".
  - "the pinned ontologies are delivered once per base as graph packages".
  - **"a TBox whose delivery failed is loaded again"** (Review focus 2).
  - **"ontologies loaded before the bridge count as loaded"** (Review focus 3; a row with no
    `delivery_id`).
  - **"a refused TBox package sends the job to review naming the ontology"** (Review focus 5:
    a `content_rejected` refusal surfaces as `<ontology id> v<version>: <message>`).
  - "the job is delivering on every delivery, TBox included".
- [ ] **Step 2: Run them.** Run `cd worker && uv run pytest -k "graph or tbox or ontolog"`.
  Expected: FAIL.
- [ ] **Step 3: Implement.** Pg: the `ontology_loaded` join is
  `NOT EXISTS (SELECT 1 FROM job_deliveries d WHERE d.delivery_id = o.delivery_id AND d.status IN ('failed', 'needs_user'))`.
- [ ] **Step 4: Run them again,** and the worker suite. Expected: PASS, except the equivalence
  goldens, which Task 8 rewrites.
- [ ] **Step 5: Commit.** `git commit -m "worker: graphs and ontologies delivered through the bridge"`

### Task 8: Worker — rebuild, remint and graph withdraw through the bridge; drop the Graph Store client

**Files:**
- Modify: `worker/src/ingest_worker/withdrawal.py`. In `_withdraw_graph`, the drop is
  `deps.bridge.delete_objects("rdf-default", [(dataset, graph_iri)])` when `deps.targets.rdf()`
  is set. When it isn't set, nothing is dropped (as with no store today).
- Modify: `worker/src/ingest_worker/rdf_rebuild.py`:
  - `rebuild` submits a `graph` package per ontology (from the runs bucket) and per current graph
    (the copy read with `bridge.read_object`, as today), all to `rdf-default`;
  - `remint` drops the old graph through `delete_objects`, then `_publish` uses Task 7's path;
  - `run_rebuild_job` returns its deliveries, and the `rebuild` task handler returns `Delivering`
    when there are any (`main.TASKS`);
  - `rebuild` refuses to run without `rdf-default`, as it refuses without a store today.
- Delete: `worker/src/ingest_worker/graph_store.py`, `worker/tests/test_graph_store.py`,
  `worker/tests/test_graph_store_integration.py` (ported in Task 2), and `PipelineDeps.graph_store`
  and its wiring (`main.py`, `rdf_rebuild.main`). Delete `FakeGraphStore` once unused.
- Modify: `worker/tests/test_equivalence.py`. The trace's `graph_store` key becomes `deliveries`:
  one entry per bridge request, `{targets, kind, files: [names], rdf: {graphName, version, triples: <canonical>}}`.
  Rewrite `template-review-rerun-publish` and `template-delivered` with `IH_UPDATE_GOLDEN=1`.
- Test: `worker/tests/test_withdrawal.py`, `worker/tests/test_rdf_rebuild.py`, `worker/tests/test_main.py`

- [ ] **Step 1: Write the failing tests:**
  - "withdrawing a current graph drops it through rdf-default and deletes its copies";
  - **"a graph drop the bridge can't take yet is retried"** (Review focus 4: `target_missing`
    raises `BridgeUnavailable`, so the job retries, and the copies already deleted are not an
    error the second time);
  - "rebuild re-delivers every ontology and current graph as graph packages, read from their
    recorded targets";
  - "remint drops the old graph, then publishes the new one";
  - "rebuild without rdf-default refuses".
- [ ] **Step 2: Run them.** Run
  `cd worker && uv run pytest tests/test_withdrawal.py tests/test_rdf_rebuild.py tests/test_main.py`.
  Expected: FAIL.
- [ ] **Step 3: Implement,** then delete the Graph Store client and its tests.
- [ ] **Step 4: Rewrite the two goldens, and check them against the old ones.**
  - Store objects, target objects, events and queue calls must be unchanged.
  - Each old golden `graph_store` PUT (graph name and canonical triples) must equal a new
    `deliveries` entry's `rdf`.
  - The diff script lives in the task's notes; any other difference is a bug, not a golden
    update.

  Then run `cd worker && uv run pytest` and `npm run worker:lint`. Expected: PASS, mypy clean.
- [ ] **Step 5: Commit.** `git commit -m "worker: rebuild, remint and withdraw through the bridge; the worker no longer reaches Fuseki"`

### Task 9: Web — the triple store target on Published outputs

**Files:**
- Modify: `apps/web/src/access/TargetRow.tsx`, `PublishedOutputsPage.tsx`. An `rdf` target shows
  "Triple store", its endpoint and dataset, and its connection status. Only Rename and Test
  connection are offered.
- Modify: `apps/web/src/templates/TemplateEditor.tsx` (the General tab's *Publish to* picker,
  near its `Publish to` label). `rdf` targets are never offered.
- Modify: the help topic for Published outputs. One paragraph: the triple store comes from
  `RDF_ENDPOINT`, and recipes delivering RDF load into it automatically.
- Test: `apps/web/src/access/*.test.tsx`, the picker's test

- [ ] **Step 1: Write the failing tests:**
  - "an rdf target shows its endpoint and dataset, with Rename and Test connection only";
  - "the Publish to picker never lists an rdf target".
- [ ] **Step 2: Run them.** Run `npx vitest run --root apps/web PublishedOutputs TargetRow Publish`.
  Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Published outputs: the triple store target"`

### Task 10: Deploy — the bridge reaches Fuseki; the worker doesn't

**Files:**
- Modify: `deploy/docker-compose.yml`:
  - the `bridge` service gains `RDF_PASSWORD: ${RDF_WRITER_PASSWORD:-}`, joins the `rdf`
    network, and gets `depends_on: fuseki (required: false)`;
  - the `worker` keeps `RDF_ENDPOINT` and `RDF_DATASET` (seeding only), and loses `RDF_USER`,
    `RDF_PASSWORD` and the `rdf` network;
  - the `api` is unchanged (backup and seeding).
- Modify: `deploy/scripts/smoke-test.sh`. When `RDF_ENDPOINT` is set:
  - seed a reviewed job of a one-field recipe with a `semantics` mapping and `delivery.formats`
    including `rdf`, through SQL, as the phase 2 bridge section does (the mapping is copied from
    `worker/tests/test_template_pipeline.py` `mapped`), with a linked-data base set through the API;
  - approve it and wait for `succeeded`;
  - check the copy's key `graphs/<sha>/<type>/v1.ttl` on the S3 target through the bridge;
  - check the graph exists in Fuseki (`ASK { GRAPH <graph> { ?s ?p ?o } }` as `ct-reader`
    through `127.0.0.1:${FUSEKI_PUBLIC_PORT}`);
  - delete the job and check the graph is gone.
- Modify: `deploy/.env.example` (a comment: the bridge holds the Fuseki write password).

- [ ] **Step 1: Write the smoke section first, and run it against a stack at main's tip**
  (profile `rdf`, a separate project name, never the live stack). Expected: FAIL. The bridge has
  no `rdf` sink there; on that tip, the check that `rdf-default` exists fails first.
- [ ] **Step 2: Implement the compose changes.** Deploy fresh with `COMPOSE_PROFILES=rdf`.
  Expected: smoke all `ok`, including the RDF section.
- [ ] **Step 3: Upgrade check** (Review focus 3).
  1. Deploy main's tip with `COMPOSE_PROFILES=rdf` and publish one RDF job.
  2. Deploy this branch over the same volumes.
  3. Expected:
     - smoke `ok`;
     - `rdf-default` exists on both sides;
     - publishing the same file again makes v2 at the same graph name;
     - `published_ontology_graphs` has no new rows for ontologies loaded before.
- [ ] **Step 4: Commit.** `git commit -m "deploy: the bridge writes to Fuseki"`

### Task 11: Docs

**Files:**
- Modify: `docs/adr/0011-rdf-publishing-and-ontologies.md`. Add an addendum: only the bridge
  writes to Fuseki (the `rdf` sink), and the worker submits graphs in packages.
- Modify: `docs/adr/0017-delivery-bridge.md`. Add a phase 3 line.
- Modify: the spec. Add a "Phase 3 as built" section with this plan's decisions.
- Modify: `CLAUDE.md`:
  - the contracts table rows for published graphs, the package (graph packages, `graph-version`,
    the graph key), and publishing targets (kind `rdf`);
  - the Delivery bridge bullet (the `rdf` sink).
- Modify: `docs/architecture.md`, the `fuseki` and `bridge` rows.
- Modify: `deploy/README.md`, the Triple store section. The bridge holds `RDF_WRITER_PASSWORD`;
  `rdf-default` and its connection appear under Published outputs and Manage connections.
- Create: release notes in `docs/release-notes/`, in the newest file's format.

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Check them.** Run `npm run format:check` and a vendor-name search of
  `docs CLAUDE.md apps packages worker deploy` (names kept outside this repo). Expected: clean,
  no matches.
- [ ] **Step 3: Commit.** `git commit -m "docs: RDF behind the bridge"`

---

## Done when (spec phase 3 row)

- Graph publishing behaves as today, delivered through the bridge:
  - the same graph names, copy keys and Turtle bytes;
  - ontologies loaded once per base;
  - withdraw, republish, rebuild, backfill and remint working.

  Shown by the rewritten equivalence goldens (only the transport changed) and the worker suite.
- `npm run check` is green, and the opt-in Pg integration tests pass on a throwaway database.
  So does the opt-in Fuseki test (Task 2).
- The compose smoke test, with profile `rdf`, passes on a fresh deploy and on an upgrade.
- The worker holds no Fuseki credential and has no route to Fuseki.
