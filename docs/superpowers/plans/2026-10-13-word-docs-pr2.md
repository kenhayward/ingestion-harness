# Word documents PR 2: upload checks, storage and Workbench bundles

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The API accepts `.docx` everywhere it accepts a PDF (`POST /api/documents`, including
Templates test runs; Workbench sample upload; bundle import), stores it with its own extension
and content type, and serves it back as the original file. Bundles carry Word samples. After this
PR the feature works end to end through the API; the web follows in PR 3.

**Architecture:**
- **One check for every upload path:** `checkSource(body)` in `apps/api/src/uploads.ts` decides
  the kind (`pdf` | `docx`) or the refusal (415, or 422 for tracked changes and oversize). It
  inflates only the parts it reads, under a cap.
- **The content type is stored on the document:** migration 0022, `documents.content_type`.
  `JobSummary` and `ResultSummary` carry it as `contentType`.
- **`inboxKey`** takes the extension.

**Tech Stack:** TypeScript, Fastify 5, fflate (already an API dependency), Zod, Postgres; the
worker's `bundle.py`.

**Spec:** [docs/design/word-documents.md](../../design/word-documents.md) (PR 1 merged:
`convert.is_docx`, `load_source`, converter service).

## Global Constraints

- **Accepted `.docx`:** a ZIP whose `[Content_Types].xml` has the Override
  `PartName="/word/document.xml"` with
  `ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"`.
  This is the same rule as the worker's `is_docx`.
- **Not a PDF or `.docx`:** a 415 `file is not a PDF or Word document (.docx)`. This covers
  `.docm`, `.dotx`, other OOXML types, corrupt ZIPs and anything else.
- **Tracked changes:** a 422 `the Word document has tracked changes: accept or reject them in
  Word, then upload again`. That means any `<w:ins`, `<w:del`, `<w:moveFrom` or `<w:moveTo`
  followed by whitespace, `>` or `/`, in `word/document.xml`, `word/header*.xml`,
  `word/footer*.xml`, `word/footnotes.xml` or `word/endnotes.xml`. Comments are allowed.
- **Limits:**
  - Inflated bytes across the inspected parts are capped at 64 MiB; past that, a 422 `the Word
    document is too large to check (over 64 MiB unpacked)`.
  - More than 10 000 entries is a 415.
  - Inflated sizes are counted as they are produced, never taken from the headers.
- **Content types:** `application/pdf`, and
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document`. The column
  defaults to `application/pdf` with a CHECK for the two.
- **`GET /api/jobs/:id/document`:** a PDF is served inline as now; a `.docx` as an
  `attachment` with its content type.
- **Bundles:** `samples/<sha256>.pdf` or `samples/<sha256>.docx`; the manifest's `file` must be
  one of those for its sha256. The format stays version 1.
- **Unchanged:** the error messages of every existing refusal except the 415 text, which now
  names Word.

## Review Focus

1. A `.docx` renamed `.pdf` is a `.docx` (the bytes decide), and a PDF renamed `.docx` is a PDF.
2. A tracked change in a footer, not only in the body, is refused.
3. A ZIP bomb in `word/document.xml` is refused without inflating more than the cap.
4. A bundle whose manifest says `.docx` but holds a PDF (or the reverse) is refused, as is a
   `.docx` sample with tracked changes, before anything is written.
5. Duplicate detection for Word samples works on the `.docx` bytes (the same file twice is a
   409).

---

### Task 1: `checkSource`

**Files:**
- Modify: `apps/api/src/uploads.ts`. Add `SourceKind`, `CONTENT_TYPES`, `checkSource`, and
  keep `isPdf`.
- Test: `apps/api/test/uploads.test.ts`, table-driven, with fixtures built by
  `test/docx-fixtures.ts` (`docx({ body?, footer?, mainType?, extra? })` using fflate
  `zipSync`).

**Produces:**
```ts
export type SourceKind = 'pdf' | 'docx';
export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const CONTENT_TYPES: Record<SourceKind, string>;
export type SourceCheck =
  | { ok: true; kind: SourceKind; contentType: string; ext: SourceKind }
  | { ok: false; code: 415 | 422; error: string };
export function checkSource(body: Uint8Array): SourceCheck;
```
- [ ] **Step 1:** Write the table cases:
  - PDF → pdf; minimal `.docx` → docx; a `.docx` with a comment → docx.
  - `.docm` / `.dotx` / an xlsx-like package / a ZIP without content types / a truncated ZIP /
    random bytes / empty → 415.
  - `<w:ins>` in the body, `<w:del>` in the body, `<w:moveFrom>` in a footer and `<w:ins>` in
    footnotes → 422 (tracked changes). `<w:insideH>` (a table border) and
    `<w:moveFromRangeStart>` alone → allowed.
  - A body that inflates past the cap (highly compressible) → 422 (too large), checked with a
    small cap passed through an optional second argument `{ maxInflated }`.
- [ ] **Step 2:** Run the tests and expect them to fail.
- [ ] **Step 3:** Implement with fflate's `Unzip` and `UnzipInflate`. Only the inspected entries
  get an `ondata` that counts and collects, and a running total above `maxInflated` stops.
  Feed `body` in 16 KiB chunks.
- [ ] **Step 4:** Run the tests and expect them to pass, then commit.

### Task 2: storage, routes and views

**Files:**
- Create: `db/migrations/0022_document_content_type.sql`.
- Modify:
  - `packages/shared/src/storage-keys.ts` (`inboxKey(…, ext = 'pdf')`).
  - `packages/shared/src/jobs.ts` (`JobSummarySchema.contentType`) and
    `packages/shared/src/results.ts` (`ResultSummarySchema.contentType`).
  - `apps/api/src/repositories/{types,memory,pg}.ts` (`NewDocument.contentType`, inserts,
    `JOB_SELECT`, results query, `getDocumentObject` returns `contentType`).
  - `apps/api/src/routes/documents.ts`, `apps/api/src/routes/workbench.ts` (`addSampleFile`),
    `apps/api/src/routes/jobs.ts` (document download), `apps/api/src/routes/results.ts` (zip
    name).
  - OpenAPI descriptions, `docs/openapi.json`.
- Tests: `apps/api/test/{documents,jobs,workbench-samples,results}.test.ts` (whichever hold
  those routes), `packages/shared/test/models.test.ts` (inboxKey), and the Pg integration test
  (`workbench-pg`) for the column.

- [ ] **Step 1:** Write the failing tests:
  - Uploading a `.docx` gives a 201 with `contentType` DOCX, stored at `….docx` with that
    content type, and `sha256` of the `.docx`.
  - A `.docx` with tracked changes gives a 422 on `/api/documents` and on Workbench samples.
  - A `.txt` gives a 415 with the new text.
  - `GET /jobs/:id/document` on a `.docx` gives `attachment` and the DOCX content type.
  - The results zip of `report.docx` is named `report.zip`.
  - The same `.docx` added twice as a sample gives a 409 `this file is already a sample of the
    project`.
- [ ] **Step 2:** Implement, run `npm run openapi`, and expect green. Commit.

### Task 3: bundles

**Files:**
- Modify:
  - `packages/shared/src/bundle.ts` (the manifest `file`).
  - `worker/src/ingest_worker/bundle.py` (`build_bundle(files=…)` keyed by entry name; the
    export names each sample by `is_docx`).
  - `apps/api/src/workbench/bundle-import.ts` (`SAMPLE` accepts `.docx`; `sampleFiles` becomes
    async and runs `checkSource` on each file, checking the kind matches the manifest's
    extension).
  - `apps/api/src/routes/workbench-bundle.ts` (await).
- Tests:
  - `packages/shared/test` manifest cases.
  - `worker/tests/test_bundle.py`: a `.docx` sample is exported as `samples/<sha>.docx`.
  - `apps/api/test/workbench-bundle.test.ts`: importing a bundle with a `.docx` sample, a
    mismatched extension, and tracked changes.
- [ ] Red, then green, then commit.

### Task 4: wording, smoke, docs

- Drafting prompt wording: `drafting.py` RULES and context say "source document" (or "PDF or
  Word document") where they mean the sample file. Page wording stays.
- `deploy/scripts/smoke-test.sh` uploads `deploy/scripts/fixtures/smoke.docx` (a two-page
  `.docx` generated once, committed as binary) to a seeded document type, then waits up to 120
  s for the job's `converted` event. The model call afterwards fails in CI without an LLM;
  only the conversion is asserted.
- `CLAUDE.md`: the contracts row (Source kinds: `checkSource` ↔ `convert.is_docx`; bundle file
  names) and the upload rule. Design status. `npm run check`; push, open the PR, turn on
  auto-fix and auto-merge.
