# Architecture

## Components

| Service | Tech | Responsibility |
| --- | --- | --- |
| `app` | React 19 + Vite, served by nginx | Upload UI, job list, retry, output download. nginx proxies `/api`. |
| `api` | Fastify 5, Node 24, TypeScript | Validates uploads against specs, stores PDFs and Word documents (`.docx`), enqueues jobs, serves job/spec/model data. Public API reference at `/api/docs/` ([design](design/api-docs.md)). |
| `worker` | Python 3.14, uv | Claims jobs, segments PDFs, coordinates LLM extraction, writes draft outputs, and hands each publication to the bridge as one package. Horizontally scalable. |
| `bridge` | Fastify 5, Node 24, TypeScript, own schema `bridge` | The delivery bridge ([ADR 0017](adr/0017-delivery-bridge.md)): delivers packages to their targets' sinks (S3 and the triple store built in; S3 writes files at today's keys or, for an archive target, the whole package) with retries, reports each delivery's status to the API as signed events, keeps shared connections and each user's personal ones (credentials) encrypted under `BRIDGE_SECRETS_KEY` (their summaries show non-secret fields only, a personal one's none), holds the one target registry (`bridge.targets`, which CT Studio caches), and serves the connections page. No host port; nginx exposes only `/bridge/connections`. |
| `postgres` | Postgres 17 | `documents`, `jobs` (queue), `job_events`, `job_outputs`, `llm_models`. |
| `seaweedfs` | SeaweedFS (S3 gateway) | Buckets: `ingest-inbox`, `ingest-outputs`, `ingest-runs`, internal publishing targets' buckets, and the bridge's package staging bucket (`ingest-bridge`). |
| `fuseki` | Apache Jena Fuseki (TDB2), opt-in (`COMPOSE_PROFILES=rdf`) | The triple store: one named graph per delivered document and document type, and the pinned ontologies as TBox graphs; only the bridge writes, as the `rdf-default` target ([ADR 0011](adr/0011-rdf-publishing-and-ontologies.md), [ADR 0017](adr/0017-delivery-bridge.md)). |
| `converter` | Gotenberg (LibreOffice) | Converts Word (`.docx`) sources to PDF for the worker, on an internal network with no route out ([ADR 0009](adr/0009-word-documents.md)). |
| `layout` | Docling, pinned weights ([deploy/layout/README.md](../deploy/layout/README.md)) | PDF layout analysis for the worker's PDF reader (`LAYOUT_URL`), on an internal network shared only with the worker, with no route out. The deploy scripts start it with the stack ([PDF reader design](superpowers/specs/2026-10-26-pdf-reader-design.md) §14.7); the worker does not depend on it, and retries a PDF while it can't be reached. A worker without `LAYOUT_URL` fails a PDF item at once. |
| `layout-gpu` | The `layout` image built with CUDA torch, opt-in (`COMPOSE_PROFILES=gpu`) | The same analysis on the host's NVIDIA GPU, in full precision (about 7x faster on an RTX 5090), on the same internal network. With `LAYOUT_URL=http://layout-gpu:8000` and `LAYOUT_FALLBACK_URL=http://layout:8000` the worker reads a document on it and, if it is down or out of GPU memory, reads the whole document again on `layout` ([PDF reader design](superpowers/specs/2026-10-26-pdf-reader-design.md) §16). |

## Job lifecycle

```
upload ─► queued ─► running ─┬─► delivering ─┬─► succeeded ... every delivery succeeded (or skipped)
              ▲              │  (no review)   ├─► awaiting_review   a delivery needs a person
              │              │                └─► failed            a delivery failed after its retries
              │              ├─► awaiting_review ─┬─ approve ─► queued (task=publish) ─► delivering ─► …
              │              │    (data review)   └─ reject ──► rejected (final, with reason)
              │              ├─► needs_review      (processing problem; or the bridge refused the package)
              └── backoff ◄──┴─► failed            (transient errors incl. a bridge that is down, after max_attempts)

queued / running ─ operator Cancel ─► cancelled   (worker stops at the next safe point; Retry)
finished jobs ─ operator Delete ─► removed         (job, history, internal files; published copies withdrawn)
```

**Delivering** ([ADR 0017](adr/0017-delivery-bridge.md)): publishing goes through the `bridge`.
The worker renders the outputs as before, builds one package per document (the files, named by
the keys they have always had, plus the fields and tables as data) and submits it, signed with
`BRIDGE_CLIENT_KEY`; a refusal that needs a person sends the job to review, a bridge that cannot
take it now makes the job retry, and nothing is recorded as published until the bridge accepted
it. The job then waits in `delivering`, which cannot be cancelled. The bridge runs one delivery per
target (the S3 sink writes each file at the target's prefix + its name), retries what can be
retried, and posts every status change to `POST /api/bridge/events`; the API records each event
once and in order (`job_deliveries.last_sequence`) and finishes the job when every delivery is
final, exactly once (it holds the job's row); a final delivery takes no later event. An event
for a delivery the API still does not know after a day (its job deleted during the hand-off) is
dropped by the bridge with a warning. A reconcile asks the bridge about deliveries silent
for ten minutes, so a lost event cannot strand a job; a delivery the bridge has no record of (its
data lost or restored) is failed (`not_found`), which finishes the job. A package over
`BRIDGE_MAX_PACKAGE_MB` is refused with `content_rejected` (413) and the job goes to review. The
job detail shows each target's delivery.

Cancellation and deletion: [ADR 0005](adr/0005-job-cancellation-and-deletion.md).

Live progress: while a job runs, the worker writes advisory progress events (`prepare progress`:
the text layer, then each OCR page; `segmented`; `step progress`: one per model call, attempt
chunk and occurrence of a repeating section), for production and Workbench jobs alike. Triggers on `jobs`, `job_events` and
`step_runs` (migration 0031) `NOTIFY ih_job_changed` with the job id; the API holds one
`LISTEN` connection (`PgJobWatch`, reconnecting) and serves `GET /api/jobs/:id/events` as
Server-Sent Events: `{ job, progress }` at once and on every change, a comment every 15 s (when
it also re-reads the job, so a lost notification only delays an update), ending once the job
leaves `queued`/`running`. Home follows its latest job this way and polls `GET /api/jobs/:id`
(which carries the same `progress`) every second only if the stream is unavailable. nginx
passes the stream unbuffered (its own `location`; the API also sends `X-Accel-Buffering: no`,
which the app's nginx passes on with `proxy_pass_header` so an outer nginx such as NGINX Proxy
Manager does not buffer it either: nginx hides upstream `X-Accel-*` headers by default).

Review (documents read by a transformation recipe): the recipe's review policy (`always` / `on_warnings` / `never`) decides
whether a processed document waits in `awaiting_review`. Drafts stay in the outputs bucket.
Reviewers add edits (`POST /api/jobs/:id/edits`, recorded in `review_edits` with old/new value,
editor, reason) and approve or reject. Approval re-queues the job as a *publish* task: the
worker applies the edits to the draft `document.json` (re-normalised by type, issues for edited
values replaced, checks re-run), renders the outputs with a `review` block and delivers them
through the bridge to the recipe's publishing target (`delivery.publishTo`, default `default`: an
admin-managed S3 bucket/prefix, see below), acting as the reviewer. Drafts are never modified.

The **Results** page (`#/results`, `GET /api/results`, `GET /api/results/:jobId`, and
`GET /api/results/:jobId/archive` for every published output as one ZIP) reads published
outputs back, through the bridge, from the target each output was delivered to
(`job_outputs.target_id`; [ADR 0004](adr/0004-api-reads-publish-target.md)).

**Publishing targets** (migration 202610170019): published outputs go to a *publishing target*, an S3
destination an admin manages under Administration > Published outputs (`publish_targets`; internal
= the deployment's SeaweedFS, external = any S3 endpoint reached with a *connection* of the delivery
bridge). Credentials live only on the bridge (its connections page, *Manage connections*); an
upgrade moved each target's keys there once ([ADR 0017](adr/0017-delivery-bridge.md)). The
bridge's `bridge.targets` is the one target registry; CT Studio's `publish_targets` caches it (with
CT Studio's own facts), pulled at start and after restores, and every target write goes to the
bridge first. A recipe picks one with `delivery.publishTo`; absent means `default`, which the API
alone seeds once from `TARGET_S3_*` on first start (later `.env` changes only log a warning); a
worker that starts first waits (`TargetNotSynced`, keeping its attempts) until the API has synced
the target. Every delivered object,
graph version and withdrawal records or names its target, so older outputs are read (through the
bridge) and withdrawn where they were written even after the recipe moves on. S3 keys for the data
lake ([ADR 0008](adr/0008-s3-read-keys.md)) are granted per internal target.

**Sink administration** ([design](design/sink-administration.md)): a sink that declares
administration (contract version 3) is administered from its target row under Published outputs
(*Administer*: its instances, clients and audit log). The admin-only routes
`/api/publish-targets/sinks/{sinkId}/admin/…` (`apps/api/src/routes/sink-admin.ts`) set
`actingAdmin` from the session and relay each call to the bridge's `POST /v1/sinks/{sinkId}/admin`
(`apps/bridge/src/routes/sink-admin.ts`), which checks the call, signs it with the sink's key and
checks the answer. The sink's refusals keep their status and code; an issued client's token passes
straight through to the browser, once, and is never stored or logged.

1. **Upload** (`POST /api/documents`): PDF magic-byte check, spec resolved (latest version unless
   pinned), optional model override validated against discovered models. PDF stored at
   `inbox/{specId}/v{version}/{documentId}.pdf`; `documents` + `jobs` rows inserted in one
   transaction.
2. **Claim**: worker runs a `FOR UPDATE SKIP LOCKED` CTE, sets `running`, increments `attempts`,
   records `locked_by/locked_at`. Idle workers `LISTEN` on `ih_jobs` (a trigger `NOTIFY`s on insert/requeue, migration 0009) and wake immediately; the poll interval is only the fallback and drives retry backoff. Stale locks (crashed worker) are re-queued after `STALE_LOCK_S`.
3. **Extract text**: a Word (`.docx`) source is first converted to PDF by the `converter`
   service and cached at `runs/converted/{sourceSha256}/{converterFingerprint}.pdf` (ADR 0009);
   a rejected document goes to `needs_review`, a converter outage is retried. Then the `pypdf`
   text layer, one string per page. Symbol and Wingdings characters, which Word writes as
   private-use code points (U+F0B0 for a degree sign) and PDFs keep in the font's ToUnicode
   map, are translated to the characters they show (`symbol_fonts.py`), only for codes the
   page's fonts of one of those families produce. Page count checked against `spec.document.pages`.
   **OCR** (`document.ocr: auto` by default): pages with fewer than `ocr.minChars` non-space
   characters are rendered with pypdfium2 (longest side 1288px) and transcribed by the OCR
   vision model (default `local/olmocr-2-7b-1025`; on its own server/key when `OCR_BASE_URL`/`OCR_API_KEY` are set)
   using olmOCR's prompt. Its YAML front matter
   is parsed: if the page is reported rotated, it is re-rendered with the suggested clockwise
   correction and retried once. HTML tables are flattened to text rows. Raw output goes to
   `runs/{jobId}/ocr/page-N.md` and to a shared cache,
   `runs/ocr-cache/{sourceSha256}/{settingsFingerprint}/page-N.md` (the uploaded file's sha256; fingerprint = OCR model +
   longest side + max tokens + temperature). Later jobs of the same PDF (re-runs, regressions,
   new recipe versions) reuse it: OCR servers aren't deterministic even at temperature 0, so
   without it extraction would be compared on different text. Turn off with `ocr.cache: false`;
   changing any fingerprinted setting re-OCRs. Beside a page the client turned, `page-N.md.rotation`
   holds the clockwise degrees (none: upright). The loop is `pipeline.JobTranscriber`, which a
   conversion's PDF reader also uses for its scanned pages (PDF reader spec §15), so an
   extraction and a conversion of the same PDF share transcriptions.
4. **Segment**: each section starts at the first match of its multiline regex anchor and runs
   to the next matched anchor. Missing required sections → `needs_review`.
5. **Extract**: per spec extraction, render the Jinja2 prompt with the selected sections, call
   the resolved model with the JSON Schema as a structured-output constraint, validate with
   `jsonschema`. On invalid output, retry with the previous response + validation errors appended
   (up to `maxAttempts`). Every attempt is written to `runs/{jobId}/{extractionId}/attempt-N.json`.
6. **Outputs**: CSV (rows from `rowsPath`, columns by dotted path, `document_id` prepended) and
   JSON (envelope with document/job/spec metadata, models used, and data) written to
   `outputs/{specId}/v{version}/{outputId}/{documentId}.{csv|json}`; rows recorded in
   `job_outputs`.

## Workbench

The Workbench ([design](design/workbench.md), [ADR 0007](adr/0007-workbench.md)) is a per-document-type
workspace for developing its transformation recipe: one project per type (`workbench_projects.id` is the recipe's id in the `templates` table).
Samples are ordinary documents; uploading one queues a `prepare` job (text extraction and OCR only,
no LLM extraction) that writes `prepared/{sha256}/text.json|triage.json` to the runs bucket, and the
sample's state is derived from that job. Workbench jobs (prepare and test runs) run at `priority = -10` against production's 0.
Prepare jobs never appear on the Jobs page and are never bulk-deleted, dev test runs are ordinary test jobs, and a sample's
document is never deleted along with a job.

Repeating sections ([spec](superpowers/specs/2026-10-16-repeating-sections-design.md)): a recipe section with `repeat: true` starts an occurrence at every match of its anchor, and each occurrence runs to the next start of any section. Its `key` regex names an occurrence (the batch); with `keyFrom: <section>` an occurrence whose own key finds nothing takes the key of the nearest preceding occurrence of that repeating section, and `segment.key_issues` checks the section against that source (a batch with no occurrence, a key no batch has, an own key that differs from the heading above): key issues are job issues with step `segment` and review reasons (`n section key issue(s)`, then `section key issue: <message>` each); a heading whose key cannot be read passes on no key, so its blocks are flagged rather than given the previous batch's. A table step reading a repeating section runs one model call per occurrence (times chunks), told which occurrence it reads, and the worker fills its `keyColumn` with the occurrence's key (the column is left out of the schema and the column list the model sees). Recipes without `repeat` segment, prompt and cache exactly as before.

Anchor previews are `segment` jobs (`priority = -5`, migration 0009): project-scoped with no document, one per project, running the production `segment.section_spans` over the project's prepared samples in a child process capped at 10 s and writing a segmentation result to the runs bucket. They never appear on the Jobs page and are not retryable or cancellable there. Idle workers wake on `NOTIFY ih_jobs` rather than waiting for the poll; the UI polls the preview every 300 ms (30 s deadline).

Drafting (phase 3a) uses document-less `draft` jobs (migration 0011) that send the project's brief and
**dev** samples to the `draft` model alias (`DRAFT_MODEL`) and write the model's proposal to
`drafting/{project}/{job}.json` in the runs bucket; `workbench_proposals` holds its status, derived from the
job. The first stage is `survey`: questions about the document type, whose answers go back into the brief.
Each provider declares `location: local | external` (undeclared = external) and each project carries a data
policy (`params.dataPolicy`, missing = local). The worker refuses an external provider for a local-only
project before any call, in extraction, OCR and recipe step re-runs as well as drafting; only an admin can
allow external models. Every external drafting call is recorded as an `external model call` job event listing
the samples actually sent (at most 8).

Phase 3b adds the `outputs`, `sections` and `steps` stages after `survey` (order fixed by `STAGE_ORDER`). Each
proposes typed changes (add, set, remove on the recipe's fields, tables, sections and steps) rather than a
whole recipe. A proposal records `baseVersion` and `baseDefinition`, and the user accepts it change by change:
accepting applies the chosen changes to the open draft with `applyChanges`, and a change whose target was edited
since the proposal is refused (409). A stage is complete once accepted or skipped; a later stage is shown as
stale when an earlier stage was accepted or skipped after it, which is derived from the proposals and skips, never stored.
The sections stage runs the proposed anchors against every dev sample, gives the model one round of feedback on
misses, and stores the result as `anchorCheck`; a segmentation timeout in the final round sends the job to
`needs_review`. The worker drops empty strings and lists from drafted changes and checks removals against
the draft with the earlier changes in the same body applied; all other validation runs on the whole body applied.

Phase 4a adds the scored loop. Samples are linked to references by PDF sha256; a reference run is a dev test run
with `modelOverride: 'draft'` that the user verifies in Review and saves as a reference, and the `references` stage
is accepted once every ready dev sample is verified (starting it earlier is a 409). Evaluate runs the draft over the
dev samples as project jobs carrying `referenceId`, `modelOverride` and `params.dataPolicy`, and records a
`workbench_iterations` row (migration 0013) with a snapshot of the definition. The scorecard (per-column counts,
per-sample drill-down) is computed from the jobs against the references with `buildScorecard`; once every job has
finished the summary is cached in `scores`. Store outages are rethrown rather than cached, and a corrupt or missing
document yields a null comparison. Restoring an iteration writes its snapshot into the open draft. No worker code
changed: evaluation and reference runs are ordinary `process` jobs.

Phase 4b adds a step cache for workbench test runs (migration 0014, `step_cache.py`). Before an extract step calls its model, the worker hashes the step's full input: the rendered prompts, output schema, system prompt, page-image hashes, step id, resolved model ref, the provider's kind and `baseUrl` (unlike the OCR cache, moving the endpoint misses), output-affecting options (not `timeoutS`/`maxRetries`), `maxTokens` and `maxAttempts`. A stored output that still satisfies the step's schema under `step-cache/{key}.json` in the runs bucket is reused and recorded as a `step_runs` row with `cached = true`; a miss calls the model and stores the result. Models resolve and the data policy is checked first, so a hit never bypasses it. Only `process` jobs with a project and `test` use the cache; production, regression and re-run jobs do not. `params.uncached` (the Evaluate tab's "Fresh model calls") and reference runs (`params.forceReview`) skip the lookup but still write. Recipe metrics leave cached step runs out of per-step attempts, durations and run counts. Model comparison starts one evaluation per alias (`default`, `fast`, `draft`) sharing a group id, read back as a table from `GET /comparisons/:groupId`.

Phase 4c adds feedback and the `revise` stage (migration 0015, `workbench_feedback`). Users comment on a dev sample from the scorecard drill-down; feedback can only name ready dev samples. `revise` is a change stage outside the stage order and cannot be skipped. Its draft job carries the open feedback, the failing fields from the latest complete dev iteration (dev samples only, capped at `MAX_CONTEXT_SAMPLES`) and `feedbackIds`, and it may propose any outputs, sections or steps change. The model schema avoids union types (empty sentinels instead) to stay within Anthropic's structured-output limits. Accepting a revise proposal, fully or partly, resolves its feedback; revise skips the anchor round.

Phase 5a adds holdout evaluation and the publish gate (migration 0016: `workbench_projects.publish_threshold`, `workbench_publications`). Holdout samples are never shown to drafting or revise. Their references come from reference runs on the recipe's own models with forced review (`POST /api/workbench/projects/:id/holdout/reference-runs`), and Evaluate accepts `{ set: 'holdout' }`, recording a holdout iteration; each sample's holdout history is `SampleView.holdoutRuns`, a count of the holdout iterations that evaluated it, read from `workbench_iterations.sample_shas` (migration 0017) so it survives deleted jobs. A Workbench document type publishes only through `POST /api/workbench/projects/:id/publish`: `publishGate` takes the newest complete holdout iteration whose snapshot equals the open draft and that ran the recipe's own models (iterations with a model override never count). It passes only when that iteration covered every currently ready holdout sample, compared every sample it evaluated (a failed, needs-review, cancelled or deleted job fails the gate), and scored at or above the project's threshold (default 0.9). Holdout scores are computed from the raw draft output, never the reviewed document, so a review edit cannot raise them; they are cached per iteration under a fingerprint of its jobs and recomputed whenever one of those jobs changes. Below the gate, publishing without an override reason is a 409, and a reason shorter than 10 characters is a 400; a draft edited while publishing gets a 409. Every publication is logged in `workbench_publications` with the score, threshold and any override, after the recipe is published. The Document types publish route (`POST /api/templates/:id/versions/:version/publish`, and import with `publish: true`) refuses to publish these types with 409.

Phase 5b pins Workbench references to a recipe version (migration 0018: `template_version`, `copied_from`, `verified_outputs`, `superseded_at` on `template_references`). Opening the next draft copies the previous version's references forward (`carryReferencesForward`, on every reference read, idempotent); `outputChanges` (`packages/shared/src/references.ts`) marks a reference outdated when its verified outputs changed in type, enum values, fields, tables or columns, and an outdated reference counts as unverified in the references stage, evaluation, the holdout gate and regression (`versionReferences`) until it is re-verified. Every test run of a draft (reference runs, dev test runs, evaluations, comparisons, regression runs of a draft and test uploads on the Document types page) snapshots the draft's outputs in `params.outputs`, and retrying one refreshes the snapshot to the current draft's outputs (a step re-run keeps it); a saved reference is verified against that snapshot (else the published version's outputs, or the draft's when it has not changed since the run; otherwise 409). Re-verifying or deleting a pinned reference supersedes it rather than deleting it, so older iterations keep their comparisons and deleted copies are not carried back. References of other document types stay unpinned and apply to every version; pre-5b Workbench references stay unpinned too, with `verified_outputs` backfilled from their source job's version so outputs changes still mark them outdated.

Publishing to the triple store (ADR 0011 step 6, migration 0036): when an approved document's recipe delivers `rdf`, the publish task writes the CSV/JSON/Turtle to the target as before and then publishes the graph as the next version of its `(sha256, document type)` graph. Under `pg_advisory_xact_lock` on that graph it writes the versioned copy `graphs/{sha256}/{type}/v{n}.ttl` to the target, loads any pinned ontology version not yet in the store under the current base as `{base}graph/ontology/{id}/{version}`, sends a Graph Store Protocol `PUT` to Fuseki's `/ct/data` as `ct-writer`, and records the version (`published_graphs`, `published_graph_versions`) and the entities it minted (`published_entities`, `published_entity_sources`). A Fuseki outage is retried; a 4xx goes to review. Without `RDF_ENDPOINT` the copy and the version are still recorded. `python -m ingest_worker.rdf_rebuild` reloads, backfills and re-mints the store.

The ontology library (ADR 0011, migration 0032) adds the document-less `ontology` task: `POST /api/ontologies` stores an uploaded OWL/RDFS, SKOS or SHACL file in the runs bucket and queues it; the worker parses it with rdflib (`ontology.parse_ontology`), writes canonical N-Triples and indexes its terms into `ontology_terms`, which the Ontologies pages browse as a tree.

Phase 6 adds the drafting bundle (migration 0019 adds the `export` task). `POST /api/workbench/projects/:id/export` queues a document-less `export` job (one per project; the previous export and its zip are replaced). The worker's `bundle.run_export` refuses holdout samples, checks each PDF's sha256, assembles `context.md` with the drafting context builder and writes a deterministic zip to the runs bucket (`exports/{project}/{job}.zip`), served by `GET .../exports/:jobId/bundle` (admin token required for a local-only project). `POST /api/workbench/projects/import` unzips an uploaded bundle with a cap on the bytes actually inflated, validates the manifest, recipe (`template.yaml`), brief and every PDF before writing anything, and then creates a local project with draft v1, the brief and the dev samples, which are prepared again. The bundle also carries the accepted survey (`survey.json`) and the completed stages (`completedStages`); import recreates them as an accepted survey proposal and skips for the rest. Import streams the upload through temporary files: the zip is saved to disk, metadata entries are kept in memory, and each sample PDF is inflated to its own temp file, so a large bundle never sits in memory.

`DELETE /api/workbench/projects/:id` deletes a project whose type was never published (409 otherwise): one transaction locks the type's recipe rows (`templates`), then the project (the order publish uses, so the two cannot deadlock), and removes its jobs (queued and running ones too, an exception to ADR 0005; see its addendum) and the type's project-less test jobs, workbench rows, the type's references, its unused documents and the recipe's drafts; then, best-effort, the project's internal files go (ADR 0005's rules; the prepared text, the step cache and the OCR cache stay).

## Document decomposition

Decomposition rebuilds Word documents in a structured-authoring target, as sections, tables,
images and equations, rather than extracting data from them
([spec](superpowers/specs/2026-10-23-document-decomposition-design.md)). It has no recipe, model
or review step.

- **Batches.** The **Conversion** tab starts a batch for one target that takes documents (its
  sink has the `decomposedDocuments` capability, contract version 2). It uploads the files one
  per request, under their source keys (the path in the folder, or the file name), then starts
  the batch (`/api/conversions/*`, migration `202610251200_decomposition_batches`). Operators,
  designers and admins may all convert.
- **The worker job.** Starting a batch queues one document-less `decompose` job per file
  (`worker/src/ingest_worker/decompose/job.py`). The job decomposes the file and writes its report
  beside the source in the runs bucket. It then decides through the register what to deliver, and
  hands the package to the bridge. These jobs stay out of the Jobs page.
  - A PDF is held for review instead (`decompose/hold.py`). The worker asks the register what it
    would decide, without recording anything. Only when that would send something does it store
    the held decomposition beside the source: its images, a JPEG of every page and a manifest
    with the document and its page map, under `decompositions/{batchId}/{itemId}.held/`. The item
    is then `awaiting_review`, recording the manifest's sha256 and the register entry the hold
    was decided against, and the job succeeds with "held for review". Any other answer is the
    item's outcome at once, as for Word.
  - An approved hold comes back as a `decompose` job marked `approved`. The worker delivers the
    held decomposition as it was reviewed, without reading the PDF again: with the decomposer
    version it was read with, acting as whoever started the batch. It fails the item, sending
    nothing, when the held files or the source are not the reviewed ones (their sha256s), or when
    the register's entry for the source is no longer the one the hold recorded ("the target's
    document changed after this was reviewed; run it again"). The outcome is then any delivery's,
    never `awaiting_review` again, and the held files are deleted once it is recorded.
  - The API reviews a hold through routes under `/api/conversions/items/:id/` (any role that may
    convert), all refused (409 `NOT_AWAITING_REVIEW`) unless the item is `awaiting_review`: `review`
    (the held document, page count, page map and image types, read from the manifest), `pages/:n`
    and `images/:index` (the held JPEG and image; PNG or JPEG only, under a CSP that runs nothing,
    and only files under the item's `.held/` prefix), `approve` and `reject`. A manifest of more
    than 5000 pages is not readable (the page route's bound). Approving records the
    reviewer, time and note, sets the item `queued` and queues the approved `decompose` job, with
    the batch's `force`, in one transaction. Rejecting records the same and sets `rejected`
    (final, finished then), then deletes the held files the manifest names. An item's `held` is
    true only while it is `awaiting_review`. Uploads and redeliveries take a Word
    file or a PDF (415 `Word or PDF files only` otherwise); a PDF is stored as `.pdf`.
  - The web's review page (`#/conversion/items/:id/review`,
    `apps/web/src/conversion/review/`) shows the held pages in the extraction review's page
    viewer beside the decomposed document as it would be delivered: the heading outline, each
    section's blocks (tables with their merges, figures as their crops) and each flag beside
    the element it is on. A heading, block or flag shows its first page from the page map (a
    section without pages, its first placed block's). It is read-only: Approve, with an optional
    note, or Reject, with a required one; a 409 says someone else has already decided.
- **The register.** `decomposition_register` holds one entry per document, scoped to the
  target's sink and instance. Its two checks (content hash and source key) give *already loaded*,
  *duplicate*, *update* or *create*. An update carries the component versions the last receipt
  recorded, and the target refuses it as `changed_in_target` if any of them changed there.
  - An entry's states are `pending`, `delivered`, `incomplete`, `changed`, `failed`, `detached`
    and `accepted`.
  - Detach and accept (`register_actions`, migration `202610252220_register_detached_accepted`)
    act only on an entry refused as `changed`. Detach also takes an entry whose document's
    versions were never recorded (the item's `unversioned`, reported `unresolved`), and a create
    the target may have taken (the item's `unconfirmed`: `failed`, no document, and not refused
    before acceptance). The worker sends such a create again only under its stored key, so a
    sink that refuses that key as part-way would leave it stuck; after a detach the next run
    creates under a new key.
- **Items settled from bridge events.** An item handed to the bridge is `delivering`. The bridge's
  final event for that delivery settles the register entry and the item together
  (`apps/api/src/bridge/register.ts`), whichever comes first, the event or the worker's write.
  - The item then reads `created`, `updated`, `changed_in_target`, `read_back_mismatch` or
    `failed`.
  - Outcomes decided without a delivery (`already_loaded`, `duplicate`, `in_flight`,
    `unresolved`, an early `failed`) are written by the worker at once.
  - A `decompose` job succeeds whenever an outcome was decided, so it never goes to review.
  - A refused or failed item links what the bridge error's `details.links` name (the document,
    the component that blocked it): the first is its link when the receipt gives none, and all
    show in the document panel (`Item.links`, http(s) only).
- **The Conversion tab** (`apps/web/src/conversion/`) shows each batch with one row per document:
  its outcome, its link in the target and its report. Each row offers force-load, redeliver,
  detach or accept the target's state where they apply. Earlier batches are listed newest first.
  The view polls while anything is unfinished.
- **End to end.** `apps/api/test/integration/conversion-e2e-pg.test.ts` runs batches from the
  API's routes through the worker (`worker/tests/conversion_e2e_worker.py`, with a layout
  analyser answering the PDF fixtures with their saved Docling output) and the bridge to the fake
  document sink. A batch of two PDFs and a Word file holds both PDFs and creates the Word
  document; one PDF is then approved (created, decomposer version 1001, its held files gone) and
  the other rejected (its held files gone, nothing sent).

## Access

Every request to the API needs a session cookie, obtained by signing in with an email address and
a password. The admin from the log signs in as `admin` with the token the API prints on every
start; admins add users on the **Access** page, each with a one-time password they change at first
sign-in, and can disable, unlock or reissue them and read recent sign-ins. See
[ADR 0013](adr/0013-email-password-users.md), which replaced the access tokens of
[ADR 0006](adr/0006-token-access.md).

The same page issues **read-only S3 keys** for external consumers of the publish bucket (e.g. a data
lake), when the publish target is the local SeaweedFS ([ADR 0008](adr/0008-s3-read-keys.md)). Each
consumer is a SeaweedFS IAM user `lake-<id>` with one policy (get, list and bucket location on that
bucket), created through SeaweedFS's embedded IAM API with the admin identity
(`apps/api/src/s3keys/`). SeaweedFS holds the secrets; Postgres (`s3_consumers`, `s3_access_keys`,
migration 0010) holds metadata only. Revocation deletes the key immediately; a reconciler in the
API deletes expired keys and anything `lake-*` it has no record of, every minute. The proxy in
front of the S3 port allows only GET/HEAD on the bucket (`deploy/README.md`).

## Backup and restore

An admin makes a whole-deployment backup from Administration > Backup: one encrypted `.ctbak` file holding the Postgres dump, the objects of the inbox, outputs, runs and internal publishing-target buckets, and the Fuseki dataset, kept in a backups bucket (only the newest successful one). A restore checks the entire file first, pauses the job queue and turns on maintenance mode, restores the dump into a second database and swaps it in by renaming, either as the same deployment or as a copy that keeps the target server's own models, publishing targets and identity. The engine is in the API (`apps/api/src/backup/`); see [ADR 0015](adr/0015-backup-and-restore.md).

## LLM provider layer

`config/llm-providers.yaml` declares providers; each has a `kind`:

- `anthropic` — Messages API, `output_config.format` (JSON Schema) + `effort`; optional
  server-side refusal fallbacks (beta). Discovery via `GET /v1/models`.
- `openai-responses` — Responses API with `text.format` json_schema.
- `openai-chat` — Chat Completions with `response_format` (`json_schema` | `json_object` |
  `none`), for OpenAI and OpenAI-compatible local servers (vLLM, Ollama, LM Studio, LiteLLM).

Model selection precedence: job override (UI picker) → spec `extractions[].model` → alias
resolution (`default`, `fast`, …) → `provider/model-id`. Discovery runs at worker start and every
`DISCOVERY_INTERVAL_S`; static `models:` entries are always offered even if discovery fails.

Workbench drafting may also hold a conversation with tools (`converse`, `tool_loop.py`): the
sections stage tests anchors on the dev samples, revise also reads more pages of a dev sample,
and mapping searches the pinned ontologies, before each answers through a `submit` tool. An
admin turns it off per endpoint (*Tool calls*); production extraction never uses tools. Every
drafting run writes a model log (`{job}/draft-log.json`), shown as the proposal's *Model log*.
See [ADR 0016](adr/0016-tools-in-drafting.md).

## Worker nodes

The worker's work is split into **nodes**: functions that take and return typed values and never edit shared state (reading pages, selecting the copy, segmenting, one recipe step, normalising its reply, finalising the document). Each is described in `ingest_worker/nodes.py` (what it returns, whether it writes only caches or results, whether it reaches a model). `JobModels` is the only way to a model and checks the data policy; `run_nodes` gives every node a cancellation safe point; a task's handler returns an outcome that `apply_outcome` alone writes. Equivalence traces (`worker/tests/test_equivalence.py`) pin everything a job does to golden files. With `WORKER_STEP_GRAPH=langgraph` (a trial, off by default) a recipe's steps run as a LangGraph graph checkpointed in Postgres schema `langgraph`, so a job whose worker stopped resumes at its step. See [ADR 0018](adr/0018-capabilities-as-nodes.md).

## Failure handling

| Failure | Classification | Outcome |
| --- | --- | --- |
| Rate limit / 5xx / network | transient (`LLMError`, any unexpected exception) | re-queue with backoff 30s·n², then `failed` |
| Missing sections, page count, no text even after OCR | `DocumentError` | `needs_review` |
| Unresolvable extraction/OCR model (config) | `ModelResolutionError` → `DocumentError` | `needs_review`, before any LLM call |
| Schema never satisfied after `maxAttempts` | `DocumentError` | `needs_review` (audit trail in runs bucket) |
| Model refusal | `RefusalError` → `DocumentError` | `needs_review` |
| Worker crash mid-job | stale lock | re-queued by `reap_stale` |

## Known gaps / next steps

- The OCR cache is never pruned; delete `runs/ocr-cache/` to force fresh transcriptions.
- OCR'd text differs in layout from pypdf text; specs used for both should use whitespace-tolerant
  anchors. A spec-level eval set of real scans would catch drift.
- Integration tests for `PgRepo` / `PgJobQueue` against `dev-infra` (marked `integration`).
- AuthN/Z on the API (currently assumes a trusted network behind nginx).
- Downstream load: outputs are partitioned by spec/version/output for direct ingestion by
  Athena/Glue/Spark/DuckDB; add bucket notifications or a manifest if consumers need push.
