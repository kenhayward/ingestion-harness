# Delivery bridge: design

Status: draft for review, 2026-10-19. Not yet planned. Replaces the worker's direct S3 and Fuseki
publishing (`worker/src/ingest_worker/pipeline.py` `publish_outputs`,
`template_pipeline.py` `publish_graph`) with delivery through a separate **bridge** service to
pluggable **sinks**. It builds on, and in part supersedes,
[publishing targets](2026-10-16-publishing-targets-design.md).

External sinks are designed and held privately, each in its own repository. This document must
not depend on any of them. Everything here works with no external sink registered.

Labels used below: **[decided]** means the owner said so. **[my call]** means it is the designer's
default and open to override.

## Intent

CT Studio publishes to one kind of place today: S3 buckets, plus a global Fuseki endpoint for RDF.
The owner needs it to deliver to other systems as well. The first is a private external sink, a
platform where data goes to a data store and narrative goes into a document repository. A CCMS
sink is expected later. CT Studio is public and those connectors aren't, so CT Studio must keep
working with **no knowledge of any of them**. **[decided]**

The shape is: **CT Studio → generic bridge → specific sinks.** **[decided]**

```
CT Studio API ─┐                ┌─ built-in sinks: S3 (first), RDF/Fuseki   (public)
CT Studio      ├──► Bridge ─────┼─ external sinks over HTTP, sink contract:
worker ────────┘   (public)     │     a private external sink (second)
CT Studio web ──► bridge's      │     a CCMS sink (later)
                  connections   └─ ...
                  page
```

- **CT Studio** knows *sinks*, *targets*, *connections* and *deliveries* as generic ideas, and
  nothing about any particular external system.
- **The bridge** owns the following:
  - the sink registry;
  - targets;
  - user and shared connections, with their credentials encrypted;
  - generic browsing;
  - delivery jobs, retries, idempotency and the delivery log.
- **S3 moves behind the bridge first.** Its job is to prove the contract with today's behaviour
  unchanged. RDF follows. **[decided]**
- **RDF passes through the bridge even though the first external sink doesn't use it.**
  **[decided]**
- **External sinks** implement a published, versioned **sink contract** over HTTP. They depend at
  most on the public contract package, never on CT Studio or bridge code.

## Goals

1. **S3 parity behind the bridge.** Every S3 behaviour that exists today keeps working, with the
   same object keys:
   - auto-publish;
   - approve-and-publish;
   - republish;
   - withdraw;
   - Results and zip read-back;
   - Test connection;
   - S3 read keys for internal targets;
   - the `default` target and its upgrade path.
2. **RDF behind the bridge.** Fuseki becomes the RDF sink and a target like any other.
3. **Connections.**
   - **Shared** connections are owned by admins. S3 and Fuseki use them. **[decided]**
   - **Personal** connections are owned by one user. The first external sink uses them, and so
     probably will the CCMS sink, through personal API tokens. **[decided]**
   - Each sink declares which kind it needs.
   - A user can hold many personal connections, one per named instance (for example, a tenant of
     the sink's platform). **[decided]**
4. **Secure connection management in one place.**
   - The bridge hosts one generic connections page, opened from CT Studio's Profile.
   - CT Studio's server and front-end never handle a plaintext secret.
   - Sinks never store secrets and never render UI. **[decided: recommended and accepted]**
5. **Publishing as the right identity.**
   - Personal-connection sinks deliver as a real person who took an action, because the creator
     recorded downstream must be a real person. **[decided]** The acting user is chosen in this
     order **[decided]**:
     1. **A reviewed job:** the approver.
     2. **An auto-published job:** the uploader (`jobs.created_by_user`).
     3. **Republish:** the person who pressed Republish.
     4. **System re-deliveries** (graph backfill, remint): whoever last delivered the job.
   - If the chosen person, or their connection to the target's instance, no longer exists, the
     job goes to review, and the approver becomes the acting user. A job with no recorded
     uploader goes to review before any delivery to a personal-connection target. There is never
     a fallback to a shared account.
   - At upload, CT Studio asks the bridge (`POST /deliveries:preflight`, with the recipe's targets
     and `actingUser`). If the uploader lacks a connection that the recipe's targets need, the
     upload screen warns them and links to the connections page. The upload still goes ahead.
6. **Composite targets with per-document names.**
   - A target can name several destinations, for example a data store's storage and folder for the
     CSV data, plus optionally a document repository with a document name.
     **[decided]**
   - Names are **patterns in the recipe**, resolved for each document. A reviewer can override them
     when approving. **[decided]**
7. **Several targets per recipe.** For example, a long-term S3 archive for replay or testing, plus
   the real output pipeline. **[decided]**
8. **One-way delivery for sinks that need it.**
   - Sinks declare which of these they support: withdraw, read-back and replace.
   - The first external sink and the CCMS sink are deliver-only. Once content has gone downstream, CT Studio
     doesn't offer Withdraw for it. **[decided]**
   - A re-delivery with the same idempotency key **replaces** rather than duplicates, where the sink
     supports replace.
9. **Target browsing.** Admins pick destinations by browsing a generic tree the sink serves, rather
   than typing ids. This works for S3 too: buckets, then prefixes.
10. **A sink contract that others can build to**, with a conformance suite they run in their own
    CI.

## Non-goals

- Any code, schema or name specific to an external sink, or to the system behind it, in this
  repository.
- Moving or copying content that has already been delivered between targets.
- Replaying archived packages to a new target. A later feature, but the package format must allow
  it (see Package).
- Arbitrary code running inside the bridge as a "plugin". External sinks are separate services; the
  only built-in sinks are the ones in this repository.
- Several producers other than CT Studio. The contract mustn't rule this out, but nothing here
  builds for it.
- Changing how CT Studio renders outputs, mints RDF entities, or keeps its graph registry
  (`published_graphs`). Those stay in CT Studio.

## Anti-goals

- CT Studio failing, or behaving differently, when the bridge has no external sinks.
- A plaintext credential in CT Studio's database, logs, API responses, front-end code or a recipe.
- A downstream write attributed to a shared account when the sink needs a personal one.
- A delivery whose outcome nobody can find: every attempt is logged and visible on the job.
- Duplicate content downstream after a retry or a republish.
- A published recipe version whose deliveries change destination without a new version. The rule
  from the publishing targets design still holds: target ids name recipients, not places.

## Concepts

| Term | Meaning |
|---|---|
| **Sink** | A kind of destination. Built-in sinks are `s3` and `rdf`. External sinks are registered by URL. A sink's `describe` declares the items below. |
| **Instance** | A named place within a sink that a connection is made to. For example, a tenant of a platform, or an environment of a CCMS. Built-in S3 instances are endpoints, and a shared S3 connection carries its own endpoint. |
| **Connection** | Credentials for one instance. A **shared** connection is owned by admins; a **personal** connection is owned by one CT Studio user and has a name the user chooses. |
| **Target** | A named recipient (`finance-lake`, `specs-archive`), defined per deployment. It records the sink, the instance (and the shared connection, for shared sinks), and a **destination**: sink-defined fields, some fixed (a bucket, a repository) and some **patterns** resolved for each document (a folder, a document name). |
| **Delivery** | One package delivered to one target for one job. It has its own id, status, attempts and receipt. |
| **Package** | The sink-neutral content of one document's publication (see Package). |
| **Receipt** | What the sink reports after a successful delivery: what it wrote, plus links where it can give them. |

What each sink's `describe` declares:

- its **connection kind** (shared or personal);
- its **instances**;
- its **credential fields** (marked secret or not; an OAuth-style "redirect" type is reserved for
  later);
- its **destination fields**: a list of `{ id, label, kind: fixed | pattern, required, overridable, browse }`
  (simpler to render than raw JSON Schema, and carrying the same information);
- its **capabilities**: `browse`, `replace`, `withdraw`, `readBack`, and the package parts it
  accepts (`files`, `data`, `rdf`, `narrative`, `images`).

## Decisions

### Where it lives and what it's built with [my call]

- **Location.** The bridge is `apps/bridge` in this repository. It is a separate container and
  process, with its own Postgres schema (`bridge`) and its own encryption key
  (`BRIDGE_SECRETS_KEY`).
- **Code boundaries.**
  - It shares no tables with CT Studio.
  - CT Studio code calls it only through the contract.
  - It doesn't import from `apps/api` or `worker`.
- **Stack.** The same as `apps/api`: Fastify, Zod, OpenAPI generated from the schemas, Kysely or
  `pg`, and vitest.
- **The contract package.** `packages/bridge-contract` holds the Zod schemas for the producer API
  (CT Studio ↔ bridge) and the sink API (bridge ↔ sink), plus the generated OpenAPI. It also holds
  a **conformance suite**: a runnable test pack that drives a sink URL through the contract.
- **How private sinks get it [my call, after builder check].** CI publishes two release assets on
  each calendar-version tag: the conformance suite as a container image on GHCR, and the OpenAPI
  document. Private sinks pin both, so no npm account or package name is needed now. Publishing to
  npm can come later.
- **The worker's client.** The worker gets a Python client: Pydantic models generated from the
  OpenAPI, with `extra="forbid"`. A shared fixture set in `packages/bridge-contract/test/fixtures/`
  keeps the TypeScript and Python sides in step, following CLAUDE.md's contracts rule.

### Talking to the bridge

- **The callers.** These are CT Studio's API (targets, choices, browse, connection summaries,
  delivery status, read-back), its worker (submitting deliveries), and its web front-end (only to
  open the connections page).
- **Service authentication.** CT Studio's API and worker sign every request to the bridge, using a
  shared key from env (`BRIDGE_CLIENT_KEY`) with HMAC over the method, path, timestamp and body
  hash. The bridge rejects requests that are stale or replayed.
- **Acting user on service calls [my call, after builder check].**
  - Signed calls from the API and the worker carry an `actingUser` field (CT Studio user id, name,
    email). The bridge trusts it because the call is signed by CT Studio's service key.
  - No user JWT is needed between servers, and the worker doesn't hold any user-signing key.
  - The bridge records the acting user on each delivery when it is accepted. It uses that same
    user for every retry and poll, however long they take.
- **Browser handoff.** Only the connections page involves the browser. There, the CT Studio API
  mints a one-time handoff code, valid for 60 seconds and bound to the user. The bridge redeems it
  with a signed server-to-server call.
- **The bridge calls sinks the same way.** It uses one HMAC key per registered sink. A personal
  connection's credential travels in the request envelope, over TLS on the private network. Sinks
  never persist it.

### Sink registry [my call]

- **Built-in sinks** are always present: `s3` and `rdf`.
- **External sinks** are registered in bridge config (`BRIDGE_SINKS`, a file or env). Each entry
  has an id, a URL and a signing key. Registration is not done through the UI; this keeps the
  bridge's attack surface small.
- At start the bridge calls each registered sink's `describe` and caches the answer. A sink that
  doesn't answer is shown as "unavailable", and its targets refuse new deliveries, which are
  queued as retryable. CT Studio carries on.
- CT Studio's Administration shows the sinks read-only: name, status, contract version and
  capabilities.

### Connections and the connections page

- **Shared connections** are created by admins on the bridge's connections page. S3 external
  targets keep their keys this way.
- **The migration.** Today's `publish_targets` secrets become shared connections. The migration is
  a one-off job that runs with both `LLM_SECRETS_KEY` and `BRIDGE_SECRETS_KEY` present and
  re-encrypts the secrets under the bridge key. After it, CT Studio no longer holds any target
  secret. The internal SeaweedFS uses the deployment's `S3_*` as today, through a seeded built-in
  shared connection that has no stored secret.
- **Personal connections** are created by users on the same page. Each one records:
  - the owner (the CT Studio user id);
  - the name;
  - the sink and instance;
  - the encrypted credential;
  - the status: `ok`, `needs attention` (with the reason) or `untested`;
  - `last_used_at`, `created_at` and `updated_at`.
- **Opening the page.** It is the bridge's own minimal web page. CT Studio opens it **in a new tab,
  not a frame**, which avoids the cookie partitioning that CT Studio works around when it is
  embedded in a host dashboard frame (ADR 0012). The page redeems the one-time handoff code described under
  "Talking to the bridge", then sets its own `HttpOnly` session cookie for its origin.
- **Origin [my call].** The page is served on its **own origin** (for example a
  `bridge.<host>` subdomain), so that script running on CT Studio's origin can't read it. A path
  under CT Studio's host (`/bridge/`) is allowed as a configured fallback for simple deployments.
  The deploy docs say it is weaker.
- **What a user can do on the page:**
  - add a connection: pick a sink, pick an instance, name it, enter the credentials the sink's
    `describe` asks for, then Test, then Save (Save is allowed only after a passing test, or with
    an explicit "save untested");
  - update credentials;
  - re-test;
  - rename;
  - delete.

  Admins also manage shared connections there.
- **What CT Studio shows.** Profile gets a generic **Connections** section with a secret-free
  summary per connection (name, sink, instance, status, last used) and a "Manage connections"
  button.
- **Health.** A delivery that fails because of credentials marks the connection `needs attention`.
  The review reason links to the page with that connection open.
- **Lifecycle.**
  - When a CT Studio user is removed, CT Studio calls the bridge to delete their personal
    connections.
  - The bridge also accepts a periodic reconcile from CT Studio (a list of live user ids) and
    deletes connections for unknown users.

### Targets

- **Who creates them.** Admins, as today, on Administration > Published outputs. This now lists
  bridge targets.
- **What a target records:**
  - an id (target ids still name recipients);
  - a label;
  - the sink;
  - the instance;
  - the shared connection, for shared sinks;
  - the destination values.
- **Browsing.** Fixed destination fields (bucket, storage, repository) are picked from the sink's
  browse tree. The tree is fetched by the CT Studio API from the bridge, with the admin as
  `actingUser`. For a personal-connection sink, the bridge browses with **the admin's own personal
  connection** for that instance, and an admin without one is prompted to add it. Pattern fields
  are typed in, with a preview against a sample document.
- **Locking.** The same rules as the publishing targets design. While a published recipe version
  names a target, or a delivery records it, the sink, instance and fixed destination fields can't
  change. Labels and shared credentials can.
- **Shapes of the S3 and RDF targets.**
  - The S3 target keeps today's columns as destination fields: bucket, prefix, encryption and
    storage class. Endpoint, region, path style and credentials sit in the shared connection. Its
    key layout pattern defaults to today's `{prefix}{spec}/v{ver}/{output}/{doc}.{fmt}`, so keys
    don't move.
  - The RDF target's destination is a Fuseki dataset URL plus the graph naming that
    `publish_graph` uses today. The global `RDF_ENDPOINT` becomes the seeded `rdf-default` target.

### Recipes

- **Several targets.** `delivery.publishTo` becomes a list of target ids. A single id stays valid
  and means a list of one. When it is absent, the list is `["default"]` for S3, plus `rdf-default`
  when the recipe's delivery formats include RDF, exactly as today. The recipe hash stays the same
  for recipes that don't change, in the same way as in the publishing targets design.
- **Per-target settings.** A recipe can set per-target values for pattern fields, such as the
  document name pattern. The variables available are extracted fields (`{field:<id>}`), the source
  (`{source.filename}`, `{source.stem}`, `{source.sha256}`), the recipe (`{recipe.id}`,
  `{recipe.version}`) and the job (`{job.id}`, `{date}`). A default can be given (`{field:title|source.stem}`).
- **Validation.** `templateIssues` checks that every named target exists, that pattern fields
  resolve against the recipe's fields, and that the target's sink accepts the parts the recipe
  produces. Each problem blocks publishing, like an unknown target does today.
- **The picker.** The General tab's *Publish to* picker becomes a multi-select of target choices:
  label, sink name and a destination summary. Selected targets show their pattern fields.

### Review and naming overrides

- On the review screen, each target with `overridable` pattern fields shows the resolved value,
  and the reviewer can edit it. Overrides are saved with the review decision and sent with the
  delivery.
- Auto-published jobs use only the recipe's patterns.
- **Name conflicts.** A sink can answer `name_conflict` (for example, a document name already
  used in the repository by a *different* source). The job then goes back to review, naming the
  target and the field, so the reviewer can choose another name. The same source re-delivered is
  not a conflict: the sink replaces it.

### The package [my call]

One package is built per document and publication, the same for every target. It contains:

- **`manifest`**:
  - the package id and the contract version;
  - the producer (`ct-studio` and its deployment id);
  - the idempotency key, which is `sha256(source sha256, recipe id, recipe version)`;
  - provenance: the source sha256 and filename, the job id, the recipe id and version, the
    approver (CT Studio user id and name), `extracted_at` and `published_at`;
  - naming inputs: the field values and source names that pattern resolution uses.
- **`files`**: the rendered outputs CT Studio produces today, each with its output id, format,
  content type and bytes. These are the fields CSV, one CSV per table, the check and issues CSVs,
  `document.json`, and the graph Turtle when present. File-oriented sinks write these. This is how
  S3 parity works.
- **`data`**: the same fields and tables in structured form (ids, titles, types, values, units,
  and table rows by column). Data-oriented sinks use this rather than parsing the CSVs.
- **`rdf`**: the Turtle graph and its graph name, when the recipe produces one.
- **`narrative`** and **`images`** are reserved for full decomposition: an ordered block sequence
  (paragraph, list, table, figure) and image blobs by reference. The schema is defined now, so
  sinks can plan for it, but CT Studio doesn't fill these sections yet.

How a package travels:

- **Transport.** The worker uploads the package to the bridge as one JSON request, with file and
  image bytes base64-encoded, so one HMAC signs the exact body (limit `BRIDGE_MAX_PACKAGE_MB`,
  default 50). The bridge keeps it in its own staging
  bucket for as long as any delivery of it is unfinished, plus a retention period
  (`BRIDGE_PACKAGE_RETENTION_DAYS`, default 30).
- **Archiving and replay.** The package can be written as-is (`package.json` plus its parts) by an
  S3 target configured with layout `package`. That makes an archive target a source for a later
  replay feature.

### Delivering

1. **Where it starts.** The worker's `publish_outputs` and `publish_graph` call sites become one
   step: build the package, then `POST /deliveries` with the package, the target ids, the acting
   user (`actingUser`) and any overrides. The bridge validates everything **before** accepting:
   - the targets exist;
   - each sink is available or can be queued;
   - personal connections exist for the acting user and each target's instance;
   - the patterns resolve.

   It then returns one delivery id per target.
2. **What the worker does with errors.** A validation failure that needs the user (a missing
   connection, a missing field for a pattern) is returned synchronously with a stable code. The
   worker raises it as a `DocumentError`, so the job goes to review with the reason, as
   `TargetMissing` does today. Any other failure in the call is a plain error and is retried by the
   job queue.
3. **Running deliveries.** The bridge runs deliveries from its own queue (Postgres `SKIP LOCKED`,
   as ADR 0001 does). A delivery to an external sink calls the sink's `deliver`. That may complete
   immediately or return a sink job id for the bridge to poll.
4. **How errors are classed.** Sinks return errors in two classes:
   - **`needs_user`**, such as `credential_rejected`, `name_conflict` or `content_rejected`. The
     delivery stops, and the connection is flagged when the error is about credentials.
   - **`retryable`**, such as `instance_unavailable`, a timeout or a 5xx. The bridge retries with
     backoff up to a limit, then marks the delivery `failed`.
5. **How CT Studio learns the outcome.** The bridge posts signed events to CT Studio's API
   (`POST /api/bridge/events`). Each event has a stable event id, the delivery id, a sequence
   number and the status, following common webhook practice. CT Studio also
   reconciles by polling any delivery not finished within a time limit, so a lost event can't
   strand a job.
6. **Job state.**
   - A job is **published** when all of its deliveries succeed.
   - While any delivery is running, it shows **delivering**.
   - If any delivery ends `needs_user`, the job goes **back to review**, with the target and the
     reason. Approving again re-delivers to every target. Deliveries that already succeeded and
     whose sink supports `replace` are replaced, which is safe because of the idempotency key.
     Deliveries to sinks without `replace` that already succeeded are skipped.
   - A delivery that ends `failed` after its retries marks the job **failed**, as an exhausted
     retry does today.
   - Each target's status is shown on the job.
7. **Delivery records.** `job_outputs` (published stage) records the delivery id and target id.
   For file sinks it also records the bucket and key as today, so Results and withdrawal keep
   their data. Receipts are kept by the bridge and fetched for display.

### Idempotency, replace and skip [my call, after builder check]

- **The idempotency key identifies *what* a delivery is about.** It is the same source under the
  same recipe version. It doesn't identify one attempt.
- **Every new delivery with an existing key is a new delivery record**, with its own id and its
  own job.
  - Sinks that declare `replace` overwrite what that key produced before. S3 overwrites the same
    keys, as today. A document-platform sink updates the document and data it created for that
    source.
  - Sinks that declare neither `replace` nor `withdraw` skip the delivery if an earlier delivery
    with that key succeeded, and record it as `skipped` with a pointer to the earlier delivery.
- **"Already succeeded" is judged per key**, not per job. So a second job on the same file and
  version replaces the first where it can, or is skipped where it can't.
- **Edits made at re-review still reach replace-capable sinks.** Deliver-only (no-withdraw) is not
  the same as no-replace: the first external sink is no-withdraw but replace-capable.
- **Withdrawal** deletes what the key's latest successful delivery wrote, at sinks with `withdraw`.

### RDF in detail [my call, after builder check]

- **CT Studio keeps the graph registry.** Graph versioning, entity minting and the
  `published_graphs` lock stay in CT Studio, unchanged. The version is assigned and committed
  under the lock *before* the delivery is submitted, as today. A failed delivery leaves a recorded
  version with an unfinished delivery, and the reconcile shows it.
- **The package carries graphs.** `rdf` holds the graph's Turtle, its graph name and its version.
  `files` also carries the versioned Turtle copy as output `graph-version`. The S3 sink writes it
  at today's `graph_version_key`, under the S3 target's prefix, so the versioned copies stay where
  they are now.
- **Package kinds.** Packages have a `kind`:
  - `document` is a normal publication.
  - `graph` is an ontology graph, or a rebuilt or reminted graph with no document.

  The RDF sink accepts both kinds. Loading pinned ontologies and `rdf_rebuild.py` submit `graph`
  packages. Dropping a graph on withdraw is the RDF sink's `withdraw`. No RDF-specific routes are
  added to the contract.
- **When `RDF_ENDPOINT` is unset.** `rdf-default` isn't seeded, and recipes producing RDF deliver
  only to their S3 targets. Graphs are still versioned and copied, exactly as today, so RDF recipes
  never go to review for a missing target.

### Deleting jobs and retiring types [my call, after builder check]

- Deleting a job, or retiring a document type, still withdraws at every target that can withdraw.
- For deliveries to targets that can't withdraw, CT Studio asks for confirmation, naming the
  target ("This content stays in *<target label>*"), then goes ahead. Nothing is blocked.

### Withdraw, republish and read-back

- **Withdraw.** Offered on a job only for its deliveries to sinks with `withdraw`. The bridge calls
  the sink, and the S3 sink deletes objects as `run_withdraw` does today. For deliveries to
  deliver-only sinks, CT Studio shows "Delivered to *<target label>*", with the receipt's links and
  no Withdraw.
- **Republish.** Re-delivers to the job's recipe version's targets. It replaces where the sink
  supports `replace` and skips deliver-only targets that already succeeded.
- **Read-back** (the Results page and the zip). Goes through the bridge for sinks with `readBack`
  (`GET /deliveries/{id}/files/{output}`). S3 has it; the others don't. Results shows receipts for
  sinks without it.
- **S3 read keys** (ADR 0008). Stay a CT Studio feature, with grants per internal target, because
  they are issued by the deployment's own SeaweedFS. The bridge exposes each internal S3 target's
  bucket and prefix to CT Studio for this.

### Sink contract (bridge ↔ sink), v1

These routes are relative to the sink's registered URL. Every request is signed. Personal
credentials, when needed, travel in the envelope.

| Route | Purpose |
|---|---|
| `GET /describe` | Name, contract version, connection kind, instances, credential fields, destination schema, capabilities |
| `POST /connections:test` | Test a credential for an instance. The answer says who the sink system thinks the user is, or a `needs_user` error |
| `POST /browse` | Return the children of a node in a destination field's tree. Each child has an id, label, kind, `hasChildren` and `selectable`. Paged by cursor |
| `POST /deliveries` | Deliver a package to a resolved destination, with the idempotency key. Returns either a receipt or a sink job id |
| `GET /deliveries/{sinkJobId}` | Job status, then the receipt or the error |
| `POST /deliveries:withdraw` | Only when the sink declares `withdraw` |
| `GET /files` | Only when the sink declares `readBack` |

All errors use one shape (`{ class, code, message, details? }`), and every response carries a
request id. The contract is versioned. The bridge supports the current version and the one before
it, and sinks report theirs in `describe`.

The built-in S3 and RDF sinks implement the same interface in-process, behind the same port, and
pass the same conformance suite.

## Constraints

- **Repository conventions.**
  - Forward-only migrations, with the bridge's migrations in its own schema.
  - Every route documented in OpenAPI, and every boundary in Zod.
  - Ports with in-memory fakes, and no network in unit tests.
  - A contract test for every repository, run against both its Memory and Pg implementations.
  - The bridge's checks are part of `npm run check`, which stays the one gate.
  - TDD, red first.
- **Cross-language contracts.** Add rows to CLAUDE.md's contracts table for the package, the
  delivery request and result, and the events. Add shared fixtures for each.
- **Tests stay offline.**
  - External sinks are replaced by an in-memory fake sink that implements the contract and can be
    scripted to succeed, fail `needs_user`, fail `retryable`, conflict on a name, or be slow.
  - The conformance suite runs against the built-in sinks and the fake sink in CI.
- **Deployment.** The bridge is a new compose service with a healthcheck and restart policy, and it
  isn't published on the host. nginx serves the connections page's origin. `.env.example` and the
  deploy docs list `BRIDGE_SECRETS_KEY`, `BRIDGE_CLIENT_KEY` (also used to sign events back to CT
  Studio), `BRIDGE_SINKS` and the page origin.
- **Backup and restore (ADR 0015) [my call, after builder check].** These now include the
  `bridge` schema (connections, targets, deliveries) and the staging bucket. The restore procedure
  and the round-trip test cover both schemas. The deploy docs say `BRIDGE_SECRETS_KEY` must be kept
  with `LLM_SECRETS_KEY`, because without it, restored connections can't be decrypted.
- **Upgrades change nothing visible.** Existing S3 targets, keys, read grants and recipe behaviour
  are carried over by the migration. A deployment with no external sinks looks exactly as it does
  today, apart from the Connections section.

## Phases

| Phase | Delivers | Done when |
|---|---|---|
| 1. Contract and bridge skeleton | `packages/bridge-contract` (Zod, OpenAPI, fixtures, conformance suite), `apps/bridge` with signed service auth, health, sink port, fake sink, delivery queue and events | The conformance suite passes against the fake sink; `npm run check` green |
| 2. S3 behind the bridge | S3 sink with files layout and today's keys; target and shared-connection migration with re-encryption; **the shared-connections slice of the connections page** (admins add, test and rotate S3 credentials there, because CT Studio no longer accepts target secrets); worker submits packages; events and job states; withdraw, republish, read-back through the bridge | Every existing publishing test, plus a compose smoke test, passes with S3 delivered through the bridge; keys unchanged; no target secret reaches CT Studio |
| 3. RDF behind the bridge | RDF sink; `rdf-default` seeded from `RDF_ENDPOINT` | Graph publishing behaves as today, delivered through the bridge |
| 4. Several targets per recipe | List `publishTo`, picker, per-target status on jobs, `package` layout for S3 archives | A recipe delivers to an archive target and another target; partial failure handled as above |
| 5. Personal connections | Personal connections on the connections page, Profile summary, health flags, user removal and reconcile | A user can add, test and delete personal connections for a sink; nothing secret reaches CT Studio |
| 6. External sinks | Sink registry, HTTP sink adapter, browse in the target editor, pattern fields, review overrides, name conflicts, delivering as the approver through `actingUser` | Fake external sink delivers end to end in a compose test; a private external sink can register and pass the conformance suite |

Phase 6 is where private external sinks plug in.

## Left to the builder

- Exact route, table, column and event names.
- The JWT library and key format, the HMAC header names and the replay window.
- How the connections page is built (server-rendered HTML is enough), and its styling.
- Retry limits, backoff, polling intervals and the reconcile cadence.
- The pattern syntax details beyond the variables listed, and the pattern preview UI.
- How pattern values are made safe for each sink (each sink validates its own destination values).
- Help topics and wording for Connections, the target editor and the review overrides.
- Whether the bridge's staging store is a bucket on the deployment's SeaweedFS (likely) or a
  separate store.
