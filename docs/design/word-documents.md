# Word documents: accept .docx by converting it to PDF

**Status:** proposed · 2026-10-13 · approach A approved in conversation (.docx only)

Content Transformation Studio (CT Studio) ingests only PDFs today. This design lets people upload
Word documents (`.docx`) wherever they upload a PDF now: the Jobs upload, Templates test runs, and
Workbench samples and bundles. A local converter turns each `.docx` into a PDF, and everything after
that point (text extraction, OCR, segmentation, page markers, page images, previews, review) runs
unchanged on the converted PDF.

## Goals and non-goals

**Goals**
- `.docx` is accepted everywhere a PDF is, with the same jobs, templates, review and results.
- The pipeline after conversion is untouched: page numbers, `[page N]` markers, `pageImages`,
  `chunkPages`, `document.pages` limits, copies and the review screen's page view all work on the
  converted PDF.
- Conversion is deterministic for a given file: a re-run, a retry or a regression run sees the same
  PDF, so scores measure the template, not the converter.
- Conversion stays local (no external service) and isolated from the rest of the stack, because
  it parses untrusted Office files.

**Non-goals**
- `.doc`, `.docm`, `.odt`, `.rtf` or other formats. The converter could read them, but they are
  refused until there is a need (see "Later").
- Reading Word's structure directly (headings, real tables). The text comes from the converted
  PDF. Native table text can be added later as an extra model input.
- Matching Word's own pagination exactly. Pages are laid out by LibreOffice (see "Pagination").
- A PDF download of the converted document. The review screen already shows its pages, and the
  original `.docx` can be downloaded.

## How it works

```
upload .docx ─▶ API: detect + validate ─▶ inbox: {id}.docx, documents.content_type
                                              │
worker claims job ─▶ load_source(job) ─┬─ PDF  ─▶ bytes as stored
                                       └─ DOCX ─▶ converted cache hit? ─▶ cached PDF
                                                         │ miss
                                                         ▼
                                       DocumentConverter (Gotenberg) ─▶ PDF ─▶ cache
                                              │
                         extract_text / OCR / segment / previews (unchanged, on the PDF)
```

### Identity: a document is its uploaded file

A document's `sha256` stays the hash of the **uploaded file**, which is what the API records today.
For a `.docx` that is the hash of the `.docx`, not of the converted PDF. LibreOffice writes a
creation date into every PDF, so converting the same file twice gives different bytes. Hashing the
upload keeps duplicate sample detection, references, regression and holdout coverage (all keyed by
`documents.sha256`) working.

The worker hashes the bytes it reads from the inbox, before conversion, wherever it hashes a
document today:
- `prepare_sample`: the `prepared/{sha256}/` keys, which the API reads by `sample.sha256`.
- `_ocr_cache_keyer`: `ocr-cache/{sha256}/…`.
- `bundle.run_export`: the sample check "PDF is missing or changed".

For PDFs nothing changes, because the uploaded file is the PDF.

### Conversion in the worker

- **Port:** `DocumentConverter` in `worker/src/ingest_worker/convert.py`:
  - `to_pdf(docx: bytes) -> bytes`.
  - `fingerprint() -> str`: the converter's version plus the options that change its output.
  - `GotenbergConverter` calls `POST /forms/libreoffice/convert` and reads `GET /version` for the
    fingerprint.
  - `FakeConverter` is used in tests; no test runs LibreOffice.
- **Loading:** `load_source(job, deps) -> Source(original: bytes, pdf: bytes, kind)` replaces the
  direct `deps.store.get(job.bucket, job.object_key)` calls in `prepare_document`,
  `prepare_sample`, `rerun` and `publish` (any path that reads the inbox object as a PDF).
  - The kind comes from the bytes: `%PDF-`, or a ZIP holding `word/document.xml`.
  - A `.docx` is converted at most once per file and converter: the PDF is cached in the runs
    bucket at `converted/{sha256}/{fingerprint}.pdf` (`storage.converted_key`), like the OCR
    cache.
  - A cache hit is checked to start with `%PDF-`; an invalid entry is a miss and is overwritten.
- **Events:** the job gets a `converted` event (pages, seconds, whether the cache was hit).
- **Errors** follow the worker's existing routing:
  - The converter rejects the file (a 4xx, or a 5xx naming the file) → `DocumentError` →
    `needs_review`, not retried: `could not convert the Word document: …`.
  - The converter is unreachable, or times out (60 s per document) → `fail()` → retried with
    backoff, then `failed`. A converter outage never sends a document to `needs_review`.
  - Conversion happens before any model call, so a conversion failure costs no LLM tokens.
- **Data policy:** the converter is local infrastructure, not an LLM provider, so the data policy
  does not apply. Nothing leaves the deployment.

### The converter service

- **Image:** Gotenberg (Apache-2.0, headless LibreOffice behind an HTTP API) as a compose service
  `converter`, pinned to an exact 8.x tag like SeaweedFS.
- **Network:** it joins a compose network with `internal: true`. The worker can reach it, but it
  has no route out, so a document that links remote images or templates cannot make it fetch
  anything. It publishes no ports.
- **Config:** Chromium routes are disabled (only LibreOffice is used), with a memory limit and
  `--api-timeout=60s`. `CONVERTER_URL` (default `http://converter:3000`) is set on the worker
  only; the API never calls it.
- **Fonts:** pagination depends on fonts metrically compatible with Word's defaults (Carlito for
  Calibri, Caladea for Cambria, Liberation for Arial, Times New Roman and Courier New). PR 1
  checks that the pinned image has them and adds a thin derived image only if not.
- **Where else it runs:** dev-infra (`deploy/docker-compose.dev.yml`) gets the same service for
  running the worker on the host (`CONVERTER_URL=http://localhost:3010`, bound to localhost).
  The CI compose smoke test uploads a small `.docx` fixture and waits for its job to reach
  review, which proves the wiring end to end.

### Upload validation (API)

`apps/api/src/uploads.ts` grows from `isPdf` to `sourceKind(bytes) -> 'pdf' | 'docx' | null`, plus
`checkDocx(bytes)`. A `.docx` is accepted only when all of these hold:
- It is a ZIP whose `[Content_Types].xml` declares the main part as
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml`. A
  macro-enabled document (`.docm`, `…document.macroEnabled.main+xml`) and other OOXML types
  (spreadsheets, presentations) are refused.
- It has **no tracked changes**: no `<w:ins>`, `<w:del>`, `<w:moveFrom>` or `<w:moveTo>` in
  `word/document.xml`, headers, footers, footnotes or endnotes.
  - Otherwise the upload is a 422: `the Word document has tracked changes: accept or reject them
    in Word, then upload again`.
  - Converting as saved would show deleted text as markup in the PDF, and the model would extract
    it. Comments are not exported to the PDF, so they are allowed.
- It is within the upload limit (`MAX_UPLOAD_MB`, unchanged). Only the parts above are inflated,
  with a cap of 64 MiB on inflated bytes and a limit on the entry count, so a ZIP bomb cannot
  exhaust memory. fflate is already an API dependency (bundle import).

Anything else is a 415, `file is not a PDF or Word document (.docx)`, on every upload route
(`POST /api/documents`, Templates test uploads, `POST …/samples`). The check reads the bytes;
the file name and the browser's content type are ignored, as for PDFs today.

### Storage and the database

- **Migration `0022_document_content_type.sql`:** `documents.content_type text NOT NULL DEFAULT
  'application/pdf'`, with a CHECK for the two accepted types.
- **`inboxKey`** takes the extension (`pdf` or `docx`): `{spec}/v{N}/{documentId}.docx`. The
  worker reads `jobs.object_key`, so no queue change is needed.
- **`GET /api/jobs/:id/document`** serves the stored file with its content type.
  - A PDF is inline, as now.
  - A `.docx` is an attachment with its original file name, since browsers cannot show it.
- **Results:** the archive name strips `.docx` as well as `.pdf`.
- **Deleting:** a job's or project's inbox file is removed whatever its extension. The converted
  cache is content-keyed and kept, like the OCR cache and prepared text.

### Workbench and bundles

- **Samples:** a sample can be a `.docx`. Its prepared text comes from the converted PDF, so the
  Samples tab shows its page count and pages as for a PDF, with no OCR pages unless the document
  embeds scanned images.
- **Bundle export:** `bundle.run_export` writes each sample as `samples/<sha256>.<pdf|docx>` (the
  stored file, never the converted PDF), and the manifest's `file` names it.
  `BundleManifestSchema` allows both extensions. It stays format version 1: older deployments
  refuse a bundle with a `.docx` sample, because the strict schema rejects the name, as with
  `completedStages`.
- **Bundle import:** accepts `samples/*.docx` entries and runs `checkDocx` on them, with the same
  per-sample limits and sha256 check.
- **Drafting prompts:** "PDF" becomes "source document" where the text describes the sample. The
  page rules stay, since pages come from the converted PDF.

### Web

- **Upload inputs:**
  - The Jobs upload strip, Templates test card, test rail and Workbench samples accept
    `application/pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document`.
  - The client-side filter accepts `.docx` by name or type.
  - Labels say "PDF or Word": "Upload document", "Drop PDF or Word files here".
- **Links:** jobs and results whose document is a `.docx` show "Download original (.docx)" instead
  of "Open PDF". `JobSummary` and `document` views carry `contentType` from the new column.
- **Review screen:** unchanged. Its page images are rendered from the converted PDF.

## Pagination

LibreOffice lays out pages, not Word, so a converted document can have a different page count and
different page breaks from what its author sees in Word. With the compatible fonts this is usually
small, and often zero for simple documents. Consequences:
- `document.pages {min,max}` limits on a template meant for Word documents should leave a margin.
- `[page N]` and each field's `page` refer to the converted PDF, which is also what the review
  screen shows, so they are consistent with each other.
- `copies` (several copies in one file) works on converted pages. It is unlikely in Word documents.

The Workbench docs and the template editor's hints say this where they mention pages.

## Testing

- **Worker (offline):**
  - `FakeConverter` covers `load_source` for both kinds, cache hit, miss and invalid entry, the
    fingerprint in the key, and that the source hash keys prepared text and the OCR cache.
  - Error routing: a rejection goes to `needs_review`, an outage or timeout is retried.
  - Bundle export with a `.docx` sample.
  - `GotenbergConverter` is tested against a stub HTTP client asserting the exact request (like
    `tests/test_providers.py`).
- **Integration:** `@pytest.mark.integration` converts a small fixture with a real Gotenberg
  (dev-infra).
- **API:**
  - Table-driven `sourceKind`/`checkDocx` tests over small fixtures built in the test with
    fflate: a valid `.docx`; `.docm`; `.xlsx`; tracked insertions and deletions in the body and
    in a footer; a comment (allowed); a ZIP bomb; a truncated ZIP; a PDF.
  - Route tests for 415/422 on every upload route, and the content type and extension of the
    stored file.
  - The conformance hook and the OpenAPI docs: upload descriptions and the 415/422 messages.
- **Web:** upload inputs accept `.docx`, and the "Download original" link appears for Word
  documents.
- **Smoke:** a `.docx` fixture through the compose stack.

## Contracts (both sides, same PR)

| Contract | TypeScript | Python |
| --- | --- | --- |
| Object keys | `inboxKey(…, ext)` | `storage.converted_key` (new; no TS reader) |
| Source kinds | `sourceKind` in `apps/api/src/uploads.ts` | `convert.source_kind` |
| Bundle | `BundleManifestSchema` file name (`.pdf` or `.docx`) | `bundle.run_export` |

`CLAUDE.md` gets a "Word documents" rule and the rows above.
[ADR 0009](../adr/0009-word-documents.md) records the decision: convert, don't parse; a local
converter on an internal network; identity by the uploaded file.

## Rollout (three PRs, each green and deployable)

1. **Converter and worker:**
   - The `converter` service: compose, dev-infra, internal network, pinned tag, fonts checked.
   - `DocumentConverter`, `load_source` and the converted cache.
   - Source hashing in prepare, the OCR cache and bundle export.
   - Error routing, ADR 0009 and the worker tests.
   - Nothing uploads a `.docx` yet, so this ships dormant.
2. **API and storage:**
   - `sourceKind`/`checkDocx`, migration 0022, `inboxKey` extension, and content types on the
     document route.
   - Workbench sample upload and bundle import/export, results names, OpenAPI docs and
     `CLAUDE.md`.
   - The smoke test uploads a `.docx`.
3. **Web:** upload inputs and labels, the "Download original" links, and the page-number hints.

## Later

- **More formats:** `.doc`, `.odt`, `.rtf` are a `sourceKind` entry and a validation rule each,
  since the converter already reads them. `.doc` has no XML to check for tracked changes, which
  is the main reason to wait.
- **Native table text:** add Word's own table text as an extra model input when converted tables
  read poorly.
