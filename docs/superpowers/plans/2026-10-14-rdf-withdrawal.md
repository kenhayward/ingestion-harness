# Withdrawal and Consumer Access Implementation Plan (ADR 0011, step 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deleting a job, and retiring a document type, withdraw what was delivered: the published S3 objects and the graphs in Fuseki. Unretiring a type re-delivers them. Consumers get read access to Fuseki through one shared `ct-reader` user and documentation.

**Architecture:**
- **The API decides; the worker deletes.** The API works out what to withdraw and queues document-less `withdraw` and `republish` jobs. Only the worker reaches Fuseki and writes the target (ADR 0004).
- **Same transaction:** the API queues them in the same transaction as the deletion or the retirement, and removes the registry rows there.
- **Outputs of a retired type** are kept as `job_outputs` rows marked `withdrawn_at`, so unretiring can re-deliver them. Readers ignore withdrawn rows.
- **Worker:** `withdrawal.py` deletes the target objects, the versioned graph copies and the graphs. `republish` re-renders each withdrawn job from its reviewed (or draft) document, with that job's recipe version.

**Tech Stack:** Postgres 17, Fastify/Zod, React, Python 3.13 (rdflib, httpx), Fuseki 6.2.0.

**Spec:** `docs/design/rdf-publishing.md` (*Deletion and retirement remove what was delivered*, *Fuseki deployment* (consumers), *Entity IRIs* safeguard 4), ADR 0011, ADR 0005.

## Global Constraints
- `withdraw` and `republish` are new job tasks. Both are document- and project-less, never a `JobSummary`.
  - `withdraw`: priority 0, `max_attempts` 100 (retried until it succeeds).
  - `republish`: priority -10, `max_attempts` 10.
- **Deleting a job:**
  - its published target objects go;
  - its graph is dropped only when the job published the graph's current version;
  - its version rows and copies go;
  - the same file's graphs under other types are never touched;
  - there is no automatic restore.
- **Retiring a type** withdraws every graph of the type and every published output of its jobs. Jobs, reviewed documents and drafts stay.
- **Unretiring** queues one `republish`; re-delivery is the accepted cost.
- **Version numbers never go backwards** for a graph that still has version rows (`max(version) + 1`).
- **Consumers:**
  - `RDF_PUBLIC_URL` (the proxy's URL for `/ct/sparql` and `/ct/get`) is shown on the Linked data panel with the user name `ct-reader`, never a password.
  - IRIs are opaque (safeguard 4).
- **Chains:** none exist yet (follow-on types are a later phase). Nothing here is per-chain; the withdrawal is keyed by job and type, which chains will build on.

## Review Focus
1. **Deleting a job whose graph version is not the current one:** the graph stays, and only its version rows and copies go.
2. **Retiring twice:** the second retirement queues nothing new (nothing un-withdrawn is left).
3. **Unretiring a type that was never retired, or has nothing withdrawn:** no republish job.
4. **A withdrawal while Fuseki is down:** the job is retried; a graph already gone (404) is not an error.
5. **A deleted job that was never delivered** (test run, awaiting review): no withdraw job.

---

### Task 1: Migration 0037 and the contract
- `db/migrations/0037_withdrawal.sql`:
  - task CHECK gains `withdraw` and `republish`;
  - `jobs_document_or_project` allows them;
  - `job_outputs.withdrawn_at timestamptz`.
- `packages/shared/src/jobs.ts`: `WithdrawParamsSchema` (`{ objects: {bucket, key}[], graphs: {sha256, templateId, graphIri: string|null, versions: int[]}[] }`) and `RepublishParamsSchema` (`{ templateId }`). Python mirrors them in `withdrawal.py` (`extra="forbid"`), with a shared fixture `packages/shared/test/fixtures/withdraw-params.json`.

### Task 2: API: queueing withdrawals
- `IngestionRepo.deleteJob` (Pg and Memory):
  - in the same transaction, collect the job's published, not-withdrawn outputs and its graph versions;
  - drop the current graph when this job published it;
  - delete its `published_graph_versions` rows, and the `published_graphs` row with its entity sources and orphan entities when current;
  - insert one `withdraw` job when anything was delivered;
  - `DeleteJobResult` gains `withdrawJobId`.
- `WithdrawalRepo` (`apps/api/src/linked-data/withdrawal.ts`, Pg and Memory):
  - `withdrawType(typeId, by)`: marks the type's published outputs withdrawn, deletes its `published_graphs` rows (versions kept) and their entity sources, and queues a `withdraw` job when something was withdrawn;
  - `republishType(typeId, by)`: queues `republish` when withdrawn outputs exist;
  - `pending()`: queued, running and failed counts for the panel.
- Routes: `PUT /api/specs/:id/retirement` calls `withdrawType` (each time; idempotent), `DELETE …/retirement` calls `republishType` when it unretired something, and the route docs are updated.
- Readers ignore withdrawn outputs: `getJob` outputs, results, `rdfPublishedCount`, the target-object reads.

### Task 3: Worker: withdraw and republish
- `withdrawal.py`:
  - `run_withdraw(job, deps, queue)`: delete each target object, each version copy (`target.prefix + graph_version_key`) and each graph with an IRI (`store.delete`, where a 404 is fine); event `withdrawn {objects, graphs}`.
  - `run_republish(job, deps, queue, source)`: for each job of the type with withdrawn outputs:
    - render from the reviewed document, else the draft, with that job's recipe version;
    - `publish_outputs`, then `record_published` (clears `withdrawn_at`);
    - `publish_graph` when it delivers rdf;
    - event `republished {jobs}`.
- `main.run_once` branches.
- `PgGraphRegistry` and `MemoryGraphRegistry`: the next version is `max(published_graph_versions) + 1`.

### Task 4: Consumer access and web
- **Worker/API env:** `RDF_PUBLIC_URL` (API) feeds `LinkedDataView.endpoint` (`{ sparql, get, user: 'ct-reader' } | null`) and `LinkedDataView.withdrawals`.
- **Compose:** `fuseki` also on the default network, published at `${FUSEKI_BIND:-127.0.0.1}:${FUSEKI_PUBLIC_PORT:-3030}` for the reverse proxy (CI: port 0).
- **Web:**
  - Linked data panel: the endpoint, the user, the opaque-IRIs note, and the withdrawals line.
  - Delete-job confirm and Retire dialog: say that published outputs and graphs will be withdrawn.

### Task 5: Docs
- `docs/consumers/sparql.md` covers:
  - endpoint and authentication;
  - the union default graph and the graph names;
  - finding things by literal values, never by parsing IRIs;
  - provenance, evidence and versions;
  - example queries.
- `deploy/README.md`: the NPM host for `/ct/sparql` and `/ct/get` only.
- ADR 0005 amendment, the CLAUDE.md retirement and deletion rules, the design doc as-built notes.
