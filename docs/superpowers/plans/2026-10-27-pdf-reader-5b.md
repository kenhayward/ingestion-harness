# PDFs in CT Studio, with review (step 5b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Conversion tab takes PDFs beside Word files; a PDF's decomposition is held until a
person approves it on a review page, then delivered through the register and bridge as Word's is.

**Architecture:** The `decompose` job picks the reader by the file's magic bytes. For a PDF it
asks the register what it would decide (recording nothing); if that would deliver, it stores the
decomposition, page images and a page map in the runs bucket and parks the item as
`awaiting_review`. Approve re-queues the job with `approved: true`, which delivers the stored
decomposition (never re-reading the PDF); reject is final. The web app gets a read-only review
page that reuses the extraction review's page viewer.

**Tech Stack:** Python 3.14 worker (uv, pytest, mypy --strict), Fastify + zod API (vitest),
React + Vite web (vitest, Testing Library), Postgres migrations, docker compose.

**Spec:** `docs/superpowers/specs/2026-10-26-pdf-reader-design.md` §14 (the 5b design), with §8
(the owner's decision) and §10. The decomposition spec
`docs/superpowers/specs/2026-10-23-document-decomposition-design.md` §7-8 governs the register.

## Global Constraints

- TDD as in `CLAUDE.md`: a failing test first for every behaviour change; never weaken a test.
- `npm run check` and `npm run worker:test` / `npm run worker:lint` pass before a task is done.
- Stage files by name; never `git add -A` or `git add .`.
- The owner's private sample documents, their text and their Docling output are never committed.
- Migrations are forward-only, new files in `db/migrations/` named `202610271200_…` and later.
- Word documents keep going straight through: no Word behaviour changes except the row's flag
  count (§14.6).
- The contract (`packages/bridge-contract`) does not change; `decomposerVersion` stays an int.
- PDF decomposer version = `DECOMPOSER_VERSION * 1000 + PDF_READER_VERSION` (§14.8).
- Held files live under `decompositions/{batchId}/{itemId}.held/` in the runs bucket.
- User-facing copy: "Word or PDF", "Awaiting review", "Rejected", "Review", "Approve", "Reject",
  layout error "this CT Studio has no layout service (LAYOUT_URL)", stale-hold error "the
  target's document changed after this was reviewed; run it again".
- Docs in the same commit as the change they describe (`docs/architecture.md`, `docs/openapi.json`
  regenerated, help copy).

## Review Focus

- **The reader changes while an item waits.** Approval must deliver the held reading byte for
  byte (sha256 checked), with the decomposer version recorded at hold time, not the current one.
- **Two reviewers approve at once** (two tabs). Exactly one approval wins; the other gets 409 and
  only one `decompose` job is queued. Pin with a contract test that calls approve twice.
- **Page images can't be rendered** (a PDF pdfium chokes on mid-way). Unlike extraction previews
  they are required here: the failure raises (retried), and the item fails on the last attempt
  rather than being held with a page viewer that shows nothing. Pin in Task 3.
- **A held item whose batch row is re-run or detached.** `awaiting_review` counts as running, so
  rerun/redeliver/detach answer as they do for `delivering`. Pin in Task 1's repo contract tests.
- **Rejecting cleans up.** Reject deletes every held object the manifest names (images, pages,
  manifest); a missing object is not an error. Pin in Task 5.

---

### Task 1: The new outcomes and item columns, end to end

**Files:**
- Create: `db/migrations/202610271200_decomposition_review.sql`
- Modify: `packages/shared/src/conversions.ts`, `packages/shared/src/storage-keys.ts`
- Modify: `apps/api/src/conversions/repo.ts` (`RUNNING_OUTCOMES`, `retryItems` filter), `apps/api/src/repositories/pg.ts` and the memory repo (row mapping)
- Modify: `apps/web/src/conversion/outcomes.ts` (`OUTCOME`, `OUTCOME_ICON`, `OUTCOME_NOTE`, `batchState`, `needsAttention`)
- Modify: `worker/src/ingest_worker/decompose/items.py`, `worker/src/ingest_worker/decompose/job.py` (`OUTCOME_LABELS`), `worker/src/ingest_worker/storage.py`
- Test: `packages/shared/test/conversions.test.ts`, `apps/api/test/conversions-contract.ts`, `apps/web/test/conversion-batch.test.tsx`, `worker/tests/decompose/test_items_pg.py`, `worker/tests/test_storage.py` (or wherever key helpers are tested)

**Interfaces:**
- Produces (SQL): `decomposition_items.outcome` CHECK gains `awaiting_review`, `rejected`; new
  nullable columns `flag_count int`, `held_sha256 text`, `held_entry jsonb`, `reviewed_by jsonb`,
  `reviewed_at timestamptz`, `review_note text`.
- Produces (TS): `ITEM_OUTCOMES` gains `'awaiting_review'`, `'rejected'`; `ItemSchema` gains
  `flagCount: number|null`, `held: boolean` (true when `held_sha256` is set), `reviewedBy:
  BatchCreator|null`, `reviewedAt: string|null`, `reviewNote: string|null`;
  `DecomposeParamsSchema` gains `approved: z.boolean().optional()`;
  `ReviewDecisionSchema = { note?: string }` and `RejectDecisionSchema = { note: string (min 1) }`.
- Produces (keys, TS and Python mirror): `decompositionHeldManifestKey(batchId, itemId)` →
  `decompositions/{b}/{i}.held/manifest.json`; `decompositionHeldImageKey(b, i, index)` →
  `…held/images/{index}`; `decompositionHeldPageKey(b, i, page)` → `…held/pages/{page}.jpg`
  (Python: `decomposition_held_manifest_key`, `decomposition_held_image_key`,
  `decomposition_held_page_key`).
- Produces (Python): `ItemOutcome` gains both; `ItemStore.set_report(item_id, report_key,
  flag_count: int)`; `ItemStore.hold(item_id, held_sha256: str, held_entry: dict | None) -> bool`
  (writes `awaiting_review` only from an undecided outcome); `ConversionItem` gains `held_sha256`,
  `held_entry`.

- [ ] **Step 1: Failing tests.** Shared: `ItemOutcomeSchema.parse('awaiting_review')` and
  `'rejected'` succeed; key helpers return the exact paths above. API contract (memory and Pg):
  an item set to `awaiting_review` makes `rerunItem` answer as for `delivering` ("an earlier rerun
  is unfinished") and `detachRegisterEntry` refuse likewise; `retryItems` over a `rejected` and a
  `failed` item re-runs only the failed one; `batchState` of a batch with an `awaiting_review`
  item is not finished. Web: a row with outcome `awaiting_review` shows "Awaiting review" and is
  listed under "Needs attention"; `rejected` shows "Rejected" under "Failed". Worker:
  `PgItemStore.hold` moves `decomposing` → `awaiting_review` and records the sha and entry;
  `hold` on a `created` item returns False; `set_report` stores the flag count.
- [ ] **Step 2: Run them; they fail** (`npx vitest run --project shared --project api --project web`, `cd worker && uv run pytest tests/decompose -k "items or storage"`).
- [ ] **Step 3: Implement** the migration, the schema/type/map changes and the store methods. The
  memory item store mirrors Pg. `RUNNING_OUTCOMES` includes `awaiting_review`.
- [ ] **Step 4: Run them; they pass,** then `npm run check` and `npm run worker:lint`.
- [ ] **Step 5: Commit** `feat(conversions): awaiting_review and rejected outcomes, held and review columns`.

### Task 2: PDFs in the worker's job path (no hold yet)

**Files:**
- Modify: `worker/src/ingest_worker/pipeline.py` (`PipelineDeps.layout: LayoutAnalyser | None = None`), `worker/src/ingest_worker/main.py` (build `HttpLayoutAnalyser(cfg.layout_url)` when set; startup log names it)
- Modify: `worker/src/ingest_worker/decompose/__init__.py`, `decompose/job.py`, `decompose/deliver.py`
- Test: `worker/tests/test_decompose_job.py`, `worker/tests/decompose/test_deliver.py`

**Interfaces:**
- Consumes: `decompose_pdf(data, *, layout, cropper=None, chunk=20)`, `LayoutUnavailable`, `PDF_READER_VERSION` (`decompose/pdf/__init__.py`); `set_report(…, flag_count)` from Task 1.
- Produces: `decompose/__init__.py`: `source_kind(data: bytes) -> Literal["docx", "pdf"]`
  (`%PDF-` within the first 1024 bytes → pdf, else docx) and `decomposer_version(kind) -> int`
  (docx → `DECOMPOSER_VERSION`; pdf → `DECOMPOSER_VERSION * 1000 + PDF_READER_VERSION`).
  `DecomposeDeps.layout: LayoutAnalyser | None` and `DecomposeDeps.render_preview` (from
  `PipelineDeps.render_preview`). `deliver_decomposition(…, decomposer_version: int)` uses it for
  the provenance and the idempotency key; its `decomposed is None` fallback reads by kind.
  `job.decompose_source(deps, data) -> Decomposition` dispatches by kind.

- [ ] **Step 1: Failing tests** (fake `LayoutAnalyser` returning the saved
  `tests/decompose/pdf/fixtures/two-pages.docling.json`, PDF `two-pages.pdf`):
  - `test_pdf_item_is_decomposed_with_the_pdf_reader`: the delivered package's
    `decomposerVersion == 1001` and its document has the fixture's sections.
  - `test_pdf_without_layout_fails_the_item`: `layout=None` → outcome `failed`, detail contains
    "this CT Studio has no layout service (LAYOUT_URL)".
  - `test_layout_unavailable_is_retried_then_fails`: the fake raises `LayoutUnavailable`; on an
    attempt below max the job raises; on the last the item is `failed` with a detail naming the
    layout service.
  - `test_word_version_unchanged`: a docx still delivers with `decomposerVersion == 1`.
  - `test_report_records_flag_count`: the item's flag count equals the report's length.
- [ ] **Step 2: Run** `cd worker && uv run pytest tests/test_decompose_job.py tests/decompose/test_deliver.py`; the new tests fail.
- [ ] **Step 3: Implement.** On the last attempt a `LayoutUnavailable` is recorded as "the layout
  service could not be reached: …".
- [ ] **Step 4: Run; pass;** `npm run worker:test`, `npm run worker:lint`.
- [ ] **Step 5: Commit** `feat(worker): decompose PDFs in the decompose job`.

### Task 3: Hold a PDF for review

**Files:**
- Create: `worker/src/ingest_worker/decompose/hold.py`
- Modify: `worker/src/ingest_worker/decompose/job.py`, `decompose/deliver.py` (a read-only decision), `decompose/pdf/__init__.py` (return the page map)
- Test: `worker/tests/decompose/test_hold.py`, `worker/tests/test_decompose_job.py`

**Interfaces:**
- Consumes: `decide(...)`, `RegisterStore.transaction()` → `by_key` / `by_hash` (`deliver.py`, `register.py`); `Provenance.pages` from `pdf/build.py`; `ItemStore.hold` (Task 1); `render_preview(pdf, index) -> bytes`.
- Produces:
  - `deliver.preview_decision(deps: DeliverDeps, *, data: bytes, source_key: str, target_id: str, force: bool) -> Decision` — the same reads and `decide` as `deliver_decomposition`, writing nothing.
  - `Decomposition` gains `page_map: dict[str, list[int]]` (default empty; 1-based pages; keys are section and block ids), filled by `decompose_pdf` from its provenance.
  - `hold.HeldManifest` (pydantic, camelCase JSON): `version: 1`, `sourceSha256`,
    `decomposerVersion`, `startedBy` (ActingUser), `entry: {id, contentSha256} | None`,
    `document` (DecomposedDocument), `images: list[{id, key, sha256, contentType}]`,
    `pageCount`, `pageMap`.
  - `hold.write_held(store, bucket, item, result, *, data, decomposer_version, started_by, entry, render_preview) -> str` — writes images, page JPEGs, then the manifest last; returns the manifest's sha256 (of its exact bytes).
  - `hold.read_held(store, bucket, item) -> tuple[HeldManifest, Decomposition]` — raises `HeldMismatch` when the manifest's sha256 isn't the item's `held_sha256` or an image's sha256 differs.
  - `hold.delete_held(store, bucket, item) -> None` — deletes what the manifest names, then the manifest; missing objects are ignored.

- [ ] **Step 1: Failing tests.**
  - `test_pdf_that_would_create_is_held`: outcome `awaiting_review`, `held_sha256` set, nothing
    sent to the fake bridge, the job's outcome is `Complete` with note "held for review", the
    manifest's `pageCount == 2` and both page JPEGs exist.
  - `test_pdf_already_loaded_is_not_held`: register already has the same content under the key →
    `already_loaded` at once, no held files.
  - `test_forced_pdf_is_held`: force with the same content → held.
  - `test_hold_records_the_register_entry`: an update hold records `{id, contentSha256}` of the entry.
  - `test_page_render_failure_is_not_held`: `render_preview` raises → the job raises; on the last
    attempt the item is `failed`; no manifest written.
  - `test_held_round_trip`: `read_held(write_held(...))` gives an equal document and image bytes;
    flipping a byte of an image raises `HeldMismatch`.
  - `test_word_is_never_held`.
- [ ] **Step 2: Run** `cd worker && uv run pytest tests/decompose/test_hold.py tests/test_decompose_job.py`; they fail.
- [ ] **Step 3: Implement.** The hold decision is `preview_decision(...).outcome is None`;
  otherwise `_decided` records the previewed outcome as today.
- [ ] **Step 4: Run; pass;** full worker suite and lint.
- [ ] **Step 5: Commit** `feat(worker): hold PDF decompositions for review`.

### Task 4: Deliver an approved hold

**Files:**
- Modify: `worker/src/ingest_worker/decompose/job.py`, `decompose/deliver.py` (accept an explicit `started_by` and `decomposer_version`)
- Test: `worker/tests/test_decompose_job.py`

**Interfaces:**
- Consumes: `DecomposeParams.approved` (add `approved: bool = False` to the Python model), `hold.read_held` / `delete_held` (Task 3).
- Produces: an approved run reads the held decomposition, compares `manifest.entry` with the
  register's current entry for the source (`by_key`): a different id or content sha256 fails the
  item with the stale-hold error from Global Constraints; otherwise it calls
  `deliver_decomposition(decomposed=…, decomposer_version=manifest.decomposerVersion,
  started_by=manifest.startedBy, data=<source bytes>)`. After any outcome is recorded (final or
  `delivering`) it calls `delete_held`.

- [ ] **Step 1: Failing tests.**
  - `test_approved_hold_is_delivered_as_held`: hold, then bump the fake reader (patch
    `PDF_READER_VERSION` to 2 / make the fake layout return something else), approve-run →
    the package's document equals the held one and `decomposerVersion == 1001`; held files gone.
  - `test_approved_delivery_acts_as_batch_starter`: the package's acting user is the manifest's
    `startedBy`, not the approving job's uploader.
  - `test_stale_hold_fails`: after the hold, another delivery of the same source settles → the
    approved run fails with the stale-hold error; nothing sent; held files gone.
  - `test_tampered_hold_fails`: `HeldMismatch` → item `failed`, nothing sent.
  - `test_approved_run_bridge_unreachable_is_final`: the outcome is what Word's would be; the item
    never returns to `awaiting_review`.
- [ ] **Step 2: Run; fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; pass;** full worker suite and lint.
- [ ] **Step 5: Commit** `feat(worker): deliver approved PDF holds`.

### Task 5: The API takes PDFs and reviews

**Files:**
- Modify: `apps/api/src/routes/conversions.ts`, `apps/api/src/conversions/repo.ts`, `apps/api/src/repositories/pg.ts`, the memory repo, `docs/openapi.json` (regenerate with the repo's script)
- Test: `apps/api/test/conversions.test.ts`, `apps/api/test/conversion-actions.test.ts`, `apps/api/test/conversions-contract.ts`

**Interfaces:**
- Consumes: Task 1's schemas and keys; `checkSource` (`apps/api/src/uploads.ts`) kinds `docx`/`pdf`.
- Produces:
  - Uploads and redeliver replacements accept `docx` or `pdf`; stored with the kind's extension
    and content type (`application/pdf`); `GET /conversions/items/:id/source` sends the stored
    object's type. The 415 code becomes `NOT_WORD_OR_PDF` ("Word or PDF files only").
  - `repo.approveItem({id, by, note}) -> {kind:'approved', jobId} | {kind:'not_awaiting'} | {kind:'not_found'}`
    — in one transaction: guard `outcome = 'awaiting_review'`, record `reviewed_by/at/note`, set
    outcome `queued`, queue a `decompose` job with the item's params and `approved: true`.
  - `repo.rejectItem({id, by, note}) -> {kind:'rejected', item} | {kind:'not_awaiting'} | {kind:'not_found'}`.
  - `POST /conversions/items/:id/approve` (body `ReviewDecisionSchema`) → 202 `{jobId}`; 409 `NOT_AWAITING_REVIEW`; 404.
  - `POST /conversions/items/:id/reject` (body `RejectDecisionSchema`) → 200 item; then deletes the held files through the manifest (the TS mirror of `delete_held`); 409; 404; 400 without a note.
  - `GET /conversions/items/:id/review` → `ConversionReviewSchema` (add to shared): `{ item, document, pageCount, pageMap, images: {id, contentType}[] }`, read from the manifest; 409 unless `awaiting_review`.
  - `GET /conversions/items/:id/pages/:n` → `image/jpeg`; `GET /conversions/items/:id/images/:index` → the held image with its type.
  - All under the same roles as the other conversion routes (`OPERATOR_CALLS`).
- [ ] **Step 1: Failing tests:** a PDF upload is stored as `.pdf` with `application/pdf`; a text
  file gets 415 `NOT_WORD_OR_PDF`; approve on `awaiting_review` returns 202 and queues one job
  with `approved: true`; approving twice → second is 409 and still one job (contract test, both
  repos); reject without note → 400; reject deletes manifest, images and pages (missing ones
  ignored); review on a `created` item → 409; page route returns the stored JPEG.
- [ ] **Step 2: Run** `npx vitest run --project api`; fail.
- [ ] **Step 3: Implement;** regenerate `docs/openapi.json`.
- [ ] **Step 4: Run; pass;** `npm run check`.
- [ ] **Step 5: Commit** `feat(api): PDFs in conversions, approve and reject held items`.

### Task 6: The Conversion tab takes PDFs

**Files:**
- Modify: `apps/web/src/conversion/NewBatch.tsx`, `ItemActions.tsx`, `BatchView.tsx`, `ConversionPage.tsx`, `apps/web/src/help/ConversionHelp.tsx`, the web `Api` port and `apps/web/test/fake-api.ts`
- Test: `apps/web/test/conversion-new-batch.test.tsx`, `apps/web/test/conversion-batch.test.tsx`

**Interfaces:**
- Consumes: `SOURCE_ACCEPT` (`apps/web/src/documents.ts`); Task 5's routes.
- Produces: `Api.conversionReview(itemId)`, `Api.approveConversionItem(itemId, note?)`,
  `Api.rejectConversionItem(itemId, note)`, `conversionPageUrl(itemId, n)`,
  `conversionImageUrl(itemId, index)`; route `/conversion/items/:itemId/review` (page in Task 7).
- [ ] **Step 1: Failing tests:** dropping a `.pdf` and a `.docx` uploads both; a `.txt` is left
  out with "not Word or PDF"; copy says "Word or PDF"; the replacement input accepts both; a row
  shows its flag count ("12 flags"); an `awaiting_review` row has a **Review** link to the review
  route.
- [ ] **Step 2: Run** `npx vitest run --project web`; fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run; pass;** `npm run check`.
- [ ] **Step 5: Commit** `feat(web): Word or PDF in the Conversion tab`.

### Task 7: The review page

**Files:**
- Create: `apps/web/src/conversion/review/ConversionReviewPage.tsx`, `OutlineTree.tsx`, `BlockView.tsx` (tables with merges, figures, paragraphs, lists), `ReviewDecision.tsx`
- Modify: the app's router; `apps/web/package.json` (add `"@ih/bridge-contract": "*"` for the `DecomposedDocument` types)
- Test: `apps/web/test/conversion-review.test.tsx`

**Interfaces:**
- Consumes: `PageViewer` (`apps/web/src/review/PageViewer.tsx`, props `src`, `thumbSrc`, `page`, `pageCount`, `flaggedPages`); Task 6's `Api` methods; `DecomposedDocument` from `@ih/bridge-contract`.
- Produces: the page of spec §14.5.
- [ ] **Step 1: Failing tests** (fixture: a two-section document with a table that has a
  `rowSpan`, a figure, two flags on page 2):
  - the outline tree lists both headings; the table renders a cell spanning two rows;
  - page 2 is marked as flagged in the viewer; clicking the flag shows page 2;
  - clicking a heading shows its first page from `pageMap`;
  - the header shows the file name and the flag counts by code;
  - Approve calls `approveConversionItem` and returns to the batch; Reject is disabled until a
    note is typed, then calls `rejectConversionItem(id, note)`;
  - a 409 from either shows "Someone else has already decided this document" and a link back.
- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/conversion-review.test.tsx`; fail.
- [ ] **Step 3: Implement.** Read-only; no editing controls.
- [ ] **Step 4: Run; pass;** `npm run check`.
- [ ] **Step 5: Commit** `feat(web): review page for held PDF decompositions`.

### Task 8: Stack, end to end and docs

**Files:**
- Modify: `deploy/docker-compose.yml` (the `layout` service leaves the `pdf` profile; the worker's `depends_on` it), `deploy/layout/README.md`, `deploy/scripts/smoke-test.sh` (if it asserts Word-only)
- Modify: `worker/tests/conversion_e2e_worker.py` (a fake layout analyser serving the saved fixture), `apps/api/test/integration/conversion-e2e-pg.test.ts`
- Modify: `docs/architecture.md`, the PDF spec's status line and §11, the decomposition spec's phase 5 status
- Create: `docs/release-notes/Release-Notes-20261027-5b.html` (follow the existing release notes' form)
- Test: `apps/api/test/integration/conversion-e2e-pg.test.ts`

- [ ] **Step 1: Failing e2e** (opt-in Pg): one batch with the fixture PDF, a second PDF and a
  docx → the docx reaches the fake sink as `created`; both PDFs are `awaiting_review`; approve
  one → `created` in the fake sink with `decomposerVersion 1001`; reject the other → `rejected`,
  held objects gone, nothing in the sink.
- [ ] **Step 2: Run** `npm run test:integration -- conversion-e2e` against dev-infra; fail.
- [ ] **Step 3: Implement** the e2e worker's fake layout and the compose change; update the docs.
- [ ] **Step 4: Run;** e2e passes; `npm run check`, `npm run worker:test`, `npm run worker:lint`.
- [ ] **Step 5: Commit** `feat(deploy): layout service in the stack; PDF review end to end`.
