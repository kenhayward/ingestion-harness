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
- **CT Studio keeps `publish_targets` as its recipient registry** (id, label, kind, bucket,
  prefix, encryption; usage, locking, read-key grants, backup rules) and mirrors it to the
  bridge's targets on every write and at start. Read-back (Results, the zip), withdrawal and the
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
- Two target registries until phase 4 merges them: CT Studio's (`publish_targets`, mirrored) and
  the bridge's (authoritative for sink, destination and connection).
- The graph's versioned copy is written synchronously in phase 2 (inside the graph registry's
  lock, as before), and Fuseki is still written by the worker directly; phase 3 moves RDF into
  the package and the RDF sink.
