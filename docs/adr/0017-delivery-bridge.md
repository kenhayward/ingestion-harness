# ADR 0017: Publishing goes through a delivery bridge

- Status: accepted (phase 2 of the [design](../superpowers/specs/2026-10-19-delivery-bridge-design.md))
- Date: 2026-10-20

## Context

CT Studio published to one kind of place: S3 buckets, written by the worker with credentials it
read from `publish_targets` (encrypted under `LLM_SECRETS_KEY`, or named `.env` variables). The
owner needs it to deliver to other systems too, including private ones CT Studio must know
nothing about. Holding every system's credentials in CT Studio, and teaching its worker every
system's API, would put secrets and private code in a public product.

## Decision

- **A separate service, the bridge** (`apps/bridge`), delivers every publication. CT Studio's
  worker builds one **package** per document (the files it already renders, plus the fields and
  tables as data) and submits it to the bridge (`POST /v1/deliveries`), signed with the shared
  `BRIDGE_CLIENT_KEY`. The bridge queues one **delivery** per target, runs it through the
  target's **sink**, retries what can be retried, and reports every status change back as a
  signed **event** (`POST /api/bridge/events`). A job waits in the new status `delivering` until
  every delivery is final; the API finishes it (succeeded, back to review for `needs_user`, or
  failed), and a reconcile reads deliveries whose event never came.
- **Sinks implement a published contract** (`packages/bridge-contract`, with a conformance suite).
  Phase 2 builds the **S3 sink** in: it writes each file at the target's prefix + the file's
  name, so published object keys did not move.
- **Credentials live on the bridge, as connections.** Admins add, test, rotate and delete shared
  connections on the bridge's own **connections page** (server-rendered, opened from Published
  outputs through a one-time handoff code; its own origin, or `/bridge` of the app). Secrets are
  encrypted under `BRIDGE_SECRETS_KEY`; keys named in `.env` are read in the bridge's container
  from the same allowlisted variables. An upgrade moves every target's keys onto the bridge once
  (`target-<id>`) and drops the ciphertext from CT Studio.
- **People keep their own connections there too (phase 5).** Every user, whatever their role,
  opens the same page from Profile and manages their **personal connections**: one per sink
  instance, reached by their owner only. A delivery to a personal sink uses the acting user's
  connection, looked up on each attempt. CT Studio sees summaries only (name, system, instance,
  status, last used). Disabling a user deletes theirs, and an hourly reconcile deletes those of
  anyone an admin has disabled.
- **External sinks register in config (phase 6).**
  - `BRIDGE_SINKS` lists each sink's id, URL and own signing key.
  - The bridge reaches each one through `HttpSink`, which is signed and checks every answer
    against the contract. It caches their describes, and a sink that doesn't answer is
    unavailable.
  - CT Studio creates targets of any registered sink from the fields the sink declares, and
    recipes may name them. The primary target stays an S3 files target.
  - External sinks are deliver-only until the contract specifies withdraw and read-back.
  - Name patterns resolve at accept: the reviewer's name wins over the recipe's pattern, and the
    recipe's over the target's. A sink's `name_conflict` comes back to review with the field
    marked.
  - Deliveries are made as the approver (by id), the uploader for an auto-published job, or the
    last deliverer for a rebuild. A refusal for a missing connection returns the job to review,
    and an upload warns beforehand.
- **The bridge's targets are the recipient registry** (sink, instance, connection, destination,
  label). CT Studio's `publish_targets` caches them beside what only CT Studio knows (usage,
  locking, read-key grants, backup rules), pulls them at start and after restores, and sends every
  write to the bridge first (phase 2 mirrored CT Studio's table to the bridge; the registries
  merged after phase 4). Read-back (Results, the zip), withdrawal and the
  graph's versioned copy go through the bridge's target object routes
  (`/v1/targets/{id}/objects:read|put|delete`), which keep to the target's bucket and prefix, so
  outputs delivered before the bridge read and withdraw the same way.

## Consequences

- CT Studio holds no target secret: its API accepts none (a body with `secretAccessKey` is a
  400), returns none, and its database keeps none once the move ran.
- One more service and two more keys: `BRIDGE_CLIENT_KEY` (signs both directions) and
  `BRIDGE_SECRETS_KEY` (keep it with `LLM_SECRETS_KEY`: a restore needs both). The API and the
  worker need the bridge to publish: a bridge that is down makes the worker retry the job, never
  record it as published.
- One target registry: the bridge's (`bridge.targets`, authoritative for sink, instance,
  connection, destination and label; it refuses destination fields its sink doesn't declare).
  CT Studio's `publish_targets` caches it beside facts that are CT Studio's own (kind, source,
  seeding, edits, inert, `on_bridge`, `synced_at`), so its foreign keys and locks keep a local
  row. The API pulls the bridge into the cache at start and after restores (`pullTargets`),
  writes to the bridge first and caches its answer, and alone seeds `default` and
  `rdf-default`; the worker reads the cache and waits (`TargetNotSynced`, keeping its attempts)
  for a target or triple store the API hasn't synced yet. A copy restore keeps this server's
  targets from its cache, so an edit made on the bridge but not yet pulled is overwritten;
  cached targets the bridge lacks are put back on it. Connection summaries carry their
  non-secret `fields`.
- **Phase 4** lets a recipe deliver to several targets (`publishTo` as a list; the first
  files-layout target is the primary one, read back from), adds the S3 `package` layout for
  archives (`{prefix}packages/{idempotencyKey}/`, `package.json` last), records published outputs
  per target (`job_outputs.is_primary`), and judges a job on each target's latest delivery.
- The graph's versioned copy was written synchronously in phase 2, and Fuseki by the worker.
  **Phase 3** moved both into the package: the version is committed first, then one package
  carries the graph (`rdf`) and its copy (`graph-version`) to the S3 target and the triple store
  target `rdf-default` (seeded from `RDF_ENDPOINT`), whose built-in `rdf` sink never replaces a
  newer version. Ontology loads, rebuilds and remints are `graph` packages; the worker holds no
  Fuseki credential.
