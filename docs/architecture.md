# Architecture

## Components

| Service | Tech | Responsibility |
| --- | --- | --- |
| `app` | React 19 + Vite, served by nginx | Upload UI, job list, retry, output download. nginx proxies `/api`. |
| `api` | Fastify 5, Node 24, TypeScript | Validates uploads against specs, stores PDFs, enqueues jobs, serves job/spec/model data. |
| `worker` | Python 3.13, uv | Claims jobs, segments PDFs, coordinates LLM extraction, writes outputs. Horizontally scalable. |
| `postgres` | Postgres 17 | `documents`, `jobs` (queue), `job_events`, `job_outputs`, `llm_models`. |
| `seaweedfs` | SeaweedFS (S3 gateway) | Buckets: `ingest-inbox`, `ingest-outputs`, `ingest-runs`. |

## Job lifecycle

```
upload ─► queued ─► running ─┬─► succeeded ......... published to the final target (no review needed)
              ▲              ├─► awaiting_review ─┬─ approve ─► queued (task=publish) ─► succeeded
              │              │    (data review)   └─ reject ──► rejected (final, with reason)
              │              ├─► needs_review      (processing problem: document/spec/config; Retry)
              └── backoff ◄──┴─► failed            (transient errors, after max_attempts)

queued / running ─ operator Cancel ─► cancelled   (worker stops at the next safe point; Retry)
finished jobs ─ operator Delete ─► removed         (job, history, internal files; published copies kept)
```

Cancellation and deletion: [ADR 0005](adr/0005-job-cancellation-and-deletion.md).

Review (template documents): the review policy (`always` / `on_warnings` / `never`) decides
whether a processed document waits in `awaiting_review`. Drafts stay in the outputs bucket.
Reviewers add edits (`POST /api/jobs/:id/edits`, recorded in `review_edits` with old/new value,
editor, reason) and approve or reject. Approval re-queues the job as a *publish* task: the
worker applies the edits to the draft `document.json` (re-normalised by type, issues for edited
values replaced, checks re-run), renders the outputs with a `review` block and writes them to
the final target (`TARGET_S3_*`: any S3 endpoint/bucket/prefix). Drafts are never modified.

The **Results** page (`#/results`, `GET /api/results`, `GET /api/results/:jobId`, and
`GET /api/results/:jobId/archive` for every published output as one ZIP) reads published
outputs back from the target. The API resolves `TARGET_S3_*` like the worker
([ADR 0004](adr/0004-api-reads-publish-target.md)).

1. **Upload** (`POST /api/documents`): PDF magic-byte check, spec resolved (latest version unless
   pinned), optional model override validated against discovered models. PDF stored at
   `inbox/{specId}/v{version}/{documentId}.pdf`; `documents` + `jobs` rows inserted in one
   transaction.
2. **Claim**: worker runs a `FOR UPDATE SKIP LOCKED` CTE, sets `running`, increments `attempts`,
   records `locked_by/locked_at`. Idle workers `LISTEN` on `ih_jobs` (a trigger `NOTIFY`s on insert/requeue, migration 0009) and wake immediately; the poll interval is only the fallback and drives retry backoff. Stale locks (crashed worker) are re-queued after `STALE_LOCK_S`.
3. **Extract text**: `pypdf` text layer, one string per page. Page count checked against
   `spec.document.pages`.
   **OCR** (`document.ocr: auto` by default): pages with fewer than `ocr.minChars` non-space
   characters are rendered with pypdfium2 (longest side 1288px) and transcribed by the OCR
   vision model (default `local/olmocr-2-7b-1025`; on its own server/key when `OCR_BASE_URL`/`OCR_API_KEY` are set)
   using olmOCR's prompt. Its YAML front matter
   is parsed: if the page is reported rotated, it is re-rendered with the suggested clockwise
   correction and retried once. HTML tables are flattened to text rows. Raw output goes to
   `runs/{jobId}/ocr/page-N.md` and to a shared cache,
   `runs/ocr-cache/{pdfSha256}/{settingsFingerprint}/page-N.md` (fingerprint = OCR model +
   longest side + max tokens + temperature). Later jobs of the same PDF (re-runs, regressions,
   new template versions) reuse it: OCR servers aren't deterministic even at temperature 0, so
   without it extraction would be compared on different text. Turn off with `ocr.cache: false`;
   changing any fingerprinted setting re-OCRs.
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
workspace for developing a template: one project per type (`workbench_projects.id` is the template id).
Samples are ordinary documents; uploading one queues a `prepare` job (text extraction and OCR only,
no LLM extraction) that writes `prepared/{sha256}/text.json|triage.json` to the runs bucket, and the
sample's state is derived from that job. Workbench jobs (prepare and test runs) run at `priority = -10` against production's 0.
Prepare jobs never appear on the Jobs page and are never bulk-deleted, dev test runs are ordinary test jobs, and a sample's
document is never deleted along with a job.

Anchor previews are `segment` jobs (`priority = -5`, migration 0009): project-scoped with no document, one per project, running the production `segment.section_spans` over the project's prepared samples in a child process capped at 10 s and writing a segmentation result to the runs bucket. They never appear on the Jobs page and are not retryable or cancellable there. Idle workers wake on `NOTIFY ih_jobs` rather than waiting for the poll; the UI polls the preview every 300 ms (30 s deadline).

Drafting (phase 3a) uses document-less `draft` jobs (migration 0011) that send the project's brief and
**dev** samples to the `draft` model alias (`DRAFT_MODEL`) and write the model's proposal to
`drafting/{project}/{job}.json` in the runs bucket; `workbench_proposals` holds its status, derived from the
job. The first stage is `survey`: questions about the document type, whose answers go back into the brief.
Each provider declares `location: local | external` (undeclared = external) and each project carries a data
policy (`params.dataPolicy`, missing = local). The worker refuses an external provider for a local-only
project before any call, in extraction, OCR and template step re-runs as well as drafting; only an admin can
allow external models. Every external drafting call is recorded as an `external model call` job event listing
the samples actually sent (at most 8).

## Access

Every request to the API needs a session cookie, obtained by signing in with an access token. The
admin token rotates on every API start and is printed in the log; admins issue user tokens on the
**Access** page. See [ADR 0006](adr/0006-token-access.md).

The same page issues **read-only S3 keys** for external consumers of the publish bucket (e.g. a data
lake), when the publish target is the local SeaweedFS ([ADR 0008](adr/0008-s3-read-keys.md)). Each
consumer is a SeaweedFS IAM user `lake-<id>` with one policy (get, list and bucket location on that
bucket), created through SeaweedFS's embedded IAM API with the admin identity
(`apps/api/src/s3keys/`). SeaweedFS holds the secrets; Postgres (`s3_consumers`, `s3_access_keys`,
migration 0010) holds metadata only. Revocation deletes the key immediately; a reconciler in the
API deletes expired keys and anything `lake-*` it has no record of, every minute. The proxy in
front of the S3 port allows only GET/HEAD on the bucket (`deploy/README.md`).

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
