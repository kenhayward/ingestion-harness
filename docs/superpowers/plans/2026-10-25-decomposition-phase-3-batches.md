# Document decomposition phase 3: batches and the Conversion tab

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A person can upload one file, several files or a folder on a new **Conversion** tab and
choose a target that takes decomposed documents. Each document is decomposed and delivered as its
own job, and the tab shows one row per document with its outcome, its link in the target and its
decomposition report. It also offers force-load, redeliver, detach and accept-the-target's-state.

**Architecture:**
- **API:** a decomposition **batch** is a new API record. Each file in it is a **batch item** and
  one document-less job of a new task, `decompose`, on the existing Postgres queue.
- **Worker:** the worker's `decompose` handler runs phase 1's decomposer, then phase 2's
  `deliver_decomposition`. It records the item's outcome, and stores the report next to the
  source.
- **Bridge events:** these already settle the register (phase 2) and now also settle the item.
- **Register actions:** detach and accept-target-state act on the register entry and are
  recorded in a new acceptance log.
- **Web:** a new top-level page. It is built from the existing upload, folder-drop and
  live-progress pieces.

**Tech Stack:** Node 24, TypeScript ESM, Fastify 5, Zod, `pg`, Vitest, React 19 with Testing
Library, Python 3 (`mypy --strict`, ruff, pytest), and `@kenhayward/bridge-contract` 0.8.0.

**Spec:** `docs/superpowers/specs/2026-10-23-document-decomposition-design.md`, §3 (the flow and
the outcomes table), §8 (the register, the two checks, force-load, redeliver, the version check,
resolving a refused document, deliveries that don't finish cleanly), §10 (where it lives) and
§11 (phase 3: "A single file, and then a folder, go through to the fake sink with one row per
document").

## Global Constraints

- **No vendor names.** The public repository never names the first target system or its vendor:
  not in code, tests, fixtures, docs or release notes. The sink is "the target" or "the
  document sink".
- **TDD.** Red first, and never weaken a test. Unit tests run offline, against `MemoryRepo`,
  `MemoryObjectStore`, `FakeBridgeApi`, `fakeApi()` and `FakeQueue`.
- **Typing.** TypeScript is ESM with `.js` import suffixes, and Zod guards every boundary. Python
  passes `mypy --strict`.
- **Contracts change on both sides in the same PR.** Add rows to CLAUDE.md's cross-language table
  for the `decompose` task, its params and the item DTO.
- **Migrations.**
  - Name them `db/migrations/YYYYMMDDHHMM_desc.sql`, with the time in UTC.
  - They are forward-only: never edit an applied one.
  - A new job task redefines `jobs_task_check`, starting from the latest definition
    (`202610191642_plugin_preview_task.sql`).
- **Routes.**
  - Every new route has a Zod OpenAPI schema. Regenerate with `npm run openapi`, then
    `apps/api/test/openapi.test.ts` must pass.
  - New routes are closed to operators by default (`OPERATOR_CALLS`).
- **Every PR** updates `docs/release-notes/Release-Notes-YYYYMMDD.html` for its date, with a
  "Watch out for" item for the migrations and the new routes.
- **The gate:** `npm run check` (lint, typecheck, tests, worker lint and worker tests), plus
  `npm run format:check`. Stage files by name, never with `git add -A`.
- **Names in the UI.** The tab is named **Conversion** (the owner's choice, 2026-10-25), and the
  app is "CT Studio".

## Rulings made while planning

- **R1, who may convert.** Operators, designers and admins may all start batches and act on rows
  (owner, 2026-10-25). Every conversion route is added to `OPERATOR_CALLS`, and the page to
  `OPERATOR_PAGES`. Operators can't read `/api/publish-targets/choices`, so the tab gets its own
  target list, `GET /api/conversions/targets`, open to all three roles. It returns only targets
  that take documents (R2).
- **R2, a target that takes documents.** A target qualifies when its sink's catalog entry has
  `capabilities.decomposedDocuments` (`SinkCatalog.get(target.sinkId)`).
  `GET /api/conversions/targets` lists only those targets, as `{id, label, sinkName}`. The bridge's own
  `unsupported_part` refusal stays as the backstop.
- **R3, the item outcome.** The worker's `DeliveryOutcome` is the item's outcome. The register's
  state alone can't show `already_loaded`, `duplicate` or a failure before delivery. A
  delivering item is `delivering` until the bridge's event settles its register entry. Then it
  becomes `created`, `updated`, `changed_in_target`, `read_back_mismatch` (a delivered receipt
  with `readBack.ok: false`) or `failed`.

  The job is `succeeded` whenever an outcome was decided, even when the outcome is a refusal
  such as `duplicate` or `changed_in_target`. The job is `failed` only when no outcome could be
  reached. So `finishOf`'s `needs_user` → `awaiting_review` mapping never applies to
  `decompose` jobs.
- **R4, the report.** The worker writes the `DecomposedDocument.report` flags as JSON beside the
  source, at `decompositionReportKey(batchId, itemId)`, and the item stores that key. The tab
  fetches it through a route.
- **R5, accept-target-state uses the refusal's details.** The bridge and sink have no call that
  reads a document's current component versions. The `changed_in_target` refusal already
  carries `{changed: [{id, expected, actual}], more?}`. Accepting replaces each listed
  component's version with `actual`, and drops a component whose `actual` is null, because it
  is gone. The result is the entry's expected list for the next update.
  - **When `more` is present** (more than 40 components changed), accepting is refused with
    "too many changes to accept here; detach instead". The details don't list every component.
  - **"Who changed it"** isn't shown, because the target doesn't report it (spec §8 says "where
    the target reports that").
  - **Owner to confirm.** If this is wrong, a contract call to read current versions is a
    phase 4 addition.
- **R6, redeliver.** Redeliver starts a new single-item batch for the entry's source key and
  target, as an explicit update (force on), optionally with a replacement file. The version check
  still applies. A replacement file keeps the entry's source key, so it updates the same document
  (§8).
- **R7, one destination per batch.** A batch has one target, and its destination is the target's
  own (§3 **[call]**). The batch form has no destination overrides.
- **R8, the folder upload.** Files go up one per request, so a large folder doesn't hit nginx's
  210 MB limit. Each request is `POST /api/conversions/batches/:id/items` (multipart, one file,
  `sourceKey` field), and the batch closes with `POST …/:id/start`. Source keys are the browser's
  `webkitRelativePath` (folder) or the file name (§8). The API refuses two items with the same
  source key in one batch.

## Review Focus

1. **Two batches that deliver the same source key to the same target at once.** The second must
   report `in_flight` (the register's pending entry), never deliver a second create. Pinned in
   Task 3 (`a second batch for a pending entry reports in flight`).
2. **A folder with files the decomposer can't read** (`.doc`, a corrupt `.docx`, a password-
   protected file, `~$` lock files). Each fails on its own row with its reason, and the rest carry
   on. `~$` and hidden files are skipped at upload. Pinned in Task 2 (`refuses an unreadable file
   per item, not the batch`) and Task 6 (`skips lock and hidden files`).
3. **Accepting the target's state on an entry that changed again since the refusal.** The next
   update refuses again with the new versions, so nothing is overwritten that the person didn't
   see. Pinned in Task 4 (`an accept followed by a further edit refuses again`).
4. **A bridge event that arrives before the worker records the item's delivering state**, or a
   repeated event. The item's final outcome must come out the same in any order. Pinned in Task 3
   (`settles the item whatever the order of event and worker write`).
5. **A batch closed with no items, or a page reloaded mid-upload.** An unstarted batch has no
   jobs and can be discarded, and a started one carries on without the page. Pinned in Task 2
   (`a batch with no items cannot start`) and Task 6 (`resumes an open batch after reload`).

---

## File structure

| File | Responsibility |
|---|---|
| `db/migrations/202610251200_decomposition_batches.sql` | `decomposition_batches`, `decomposition_items`, `register_actions`; `jobs_task_check` gains `decompose`; `jobs_document_or_project` allows it |
| `packages/shared/src/conversions.ts` | Zod schemas: batch, item, outcome, the action requests; `decompositionSourceKey`/`decompositionReportKey` in `storage-keys.ts` |
| `apps/api/src/conversions/repo.ts` (+ `MemoryRepo`/`PgRepo` methods) | Batches, items, register reads, detach, accept, the action log |
| `apps/api/src/routes/conversions.ts` | The routes (Task 2 and Task 4) |
| `apps/api/src/bridge/register.ts` | (modify) settling a register entry also settles its item |
| `worker/src/ingest_worker/decompose/job.py` | The `decompose` task handler |
| `worker/src/ingest_worker/main.py`, `queue.py`, `storage.py` | (modify) register the task; the key helpers |
| `apps/web/src/conversion/*` | The Conversion page, its batch view, the row actions |
| `apps/web/src/router.ts`, `App.tsx`, `shell/AppShell.tsx`, `shell/derive.ts`, `help/index.ts` | (modify) the new tab |

---

### Task 1: Schema and shared types

**Files:**
- Create: `db/migrations/202610251200_decomposition_batches.sql`, `packages/shared/src/conversions.ts`, `packages/shared/test/conversions.test.ts`
- Modify: `packages/shared/src/storage-keys.ts`, `packages/shared/src/index.ts`, `worker/src/ingest_worker/storage.py`, `worker/tests/test_storage_keys.py`, `CLAUDE.md` (the cross-language table)

**Interfaces:**
- Produces, in SQL:
  - `decomposition_batches(id uuid pk, target_id text not null, created_by jsonb not null, state text check in ('open','started','discarded'), force boolean not null default false, created_at, started_at)`.
  - `decomposition_items(id uuid pk, batch_id uuid not null references decomposition_batches, source_key text not null, filename text not null, content_sha256 text not null, size_bytes bigint not null, object_key text not null, job_id uuid null references jobs, outcome text not null default 'queued', detail text null, register_entry_id uuid null, report_key text null, link text null, redeliver_of uuid null, unique (batch_id, source_key))`.
  - `register_actions(id uuid pk, entry_id uuid not null, action text check in ('detach','accept'), by jsonb not null, at timestamptz not null default now(), details jsonb not null)`.
  - `jobs_task_check` redefined from the latest version, plus `'decompose'`. `jobs_document_or_project` allows `task = 'decompose'` with neither.
- Produces, in TypeScript:
  - `ItemOutcome = 'queued' | 'decomposing' | 'delivering' | 'created' | 'updated' | 'already_loaded' | 'duplicate' | 'in_flight' | 'changed_in_target' | 'read_back_mismatch' | 'unresolved' | 'failed'`;
  - `BatchSchema`, `ItemSchema` and `DecomposeParamsSchema = { batchId, itemId, targetId, sourceKey, force }`;
  - `decompositionSourceKey(batchId, itemId, ext)` gives `decompositions/<batchId>/<itemId>.<ext>`;
  - `decompositionReportKey(batchId, itemId)` gives `decompositions/<batchId>/<itemId>.report.json`.

  The Python mirrors are in `storage.py`.

- [ ] **Step 1: Write the failing tests.**
  - `item outcomes are exactly the twelve`;
  - `params parse a decompose job`;
  - in TS and Python both: `source and report keys`. The keys must be equal in TS and Python, so assert the same strings in both.
- [ ] **Step 2: Run** `npx vitest run --project shared` and `npm run worker:test -- -k storage_keys`. Expected: FAIL.
- [ ] **Step 3: Implement**, including the migration. Then run `npm run test:integration -- decomposition` where `IH_TEST_DATABASE_URL` is set, and say so if it isn't.
- [ ] **Step 4: Run** `npm run check`. Expected: green.
- [ ] **Step 5: Commit**: `feat(decomposition): batch and item schema, shared types`.

### Task 2: Batch API — create, upload items, start

**Files:**
- Create: `apps/api/src/conversions/repo.ts`, `apps/api/src/routes/conversions.ts`, `apps/api/test/conversions.test.ts`, `apps/api/test/conversions-contract.ts` (shared by the memory and Pg repos)
- Modify: `apps/api/src/repositories/{types,memory,pg}.ts`, `apps/api/src/app.ts` (register the route, with a per-route multipart limit of one file), `apps/api/src/openapi/document.ts` (tag `Conversions`), the access allow-list `OPERATOR_CALLS` (R1), `docs/openapi.json`

**Interfaces:**
- Routes, all under `/api/conversions`, open to operators, designers and admins (R1):
  - `GET /targets` lists the targets that take documents (R2).
  - `POST /batches {targetId, force?}` returns `Batch`. The target must exist and `takesDocuments`, else 422 `target_takes_no_documents`.
  - `POST /batches/:id/items` takes multipart `file` plus `sourceKey` and returns `Item`.
    - The file is byte-checked with `checkSource`: only `.docx` in phase 3, since PDF is phase 5.
    - An unreadable file is 415 for that item, not for the batch.
    - A repeated `sourceKey` in the batch is 409.
    - The batch must be `open`.
  - `POST /batches/:id/start` queues one `decompose` job per item, at the same priority as uploads, and sets the batch to `started`. With no items it is 422 `empty_batch`.
  - `DELETE /batches/:id` discards an `open` batch and deletes its objects.
  - `GET /batches` lists the newest first, with counts per outcome.
  - `GET /batches/:id` returns the batch and its items.
  - `GET /items/:id/report` returns the stored report JSON, or 404.
- [ ] **Step 1: Write the failing tests** with `buildApp` and memory deps:
  - `creates a batch for a target that takes documents`;
  - `refuses a target whose sink takes no documents`;
  - `uploads an item under its source key`;
  - `refuses a repeated source key in one batch`;
  - `refuses an unreadable file per item, not the batch`;
  - `a batch with no items cannot start`;
  - `start queues one decompose job per item with its params`;
  - `operators may convert`;
  - `targets lists only those that take documents`;
  - `lists batches newest first with outcome counts`;
  - `serves an item's report`.

  The same repo contract runs on `MemoryRepo` and, in integration, on `PgRepo`.
- [ ] **Step 2: Run** `npx vitest run --project api conversions`. Expected: FAIL.
- [ ] **Step 3: Implement**, then run `npm run openapi`.
- [ ] **Step 4: Run** `npm run check`. Expected: green.
- [ ] **Step 5: Commit**: `feat(api): decomposition batches — create, upload, start`.

### Task 3: The worker's decompose job, and settling items

**Files:**
- Create: `worker/src/ingest_worker/decompose/job.py`, `worker/tests/test_decompose_job.py`, `apps/api/test/conversion-settle.test.ts`
- Modify: `worker/src/ingest_worker/main.py` (`TASKS['decompose']`), `worker/src/ingest_worker/queue.py` (the task name), `apps/api/src/bridge/register.ts` (settling an entry also settles its item), `apps/api/src/bridge/events.ts` (no `awaiting_review` for `decompose` jobs, R3)

**Interfaces:**
- Consumes: Task 1's params and keys, phase 1's `decompose` entry point (the function `scripts/decompose.py` calls), and phase 2's `deliver_decomposition(deps, *, data, source_key, target_id, started_by, batch_id, force)`.
- The handler `run_decompose(job: ClaimedJob, deps) -> Outcome`:
  1. set the item to `decomposing`;
  2. read the source;
  3. decompose it, so a fidelity failure gives `failed` with the failing check;
  4. write the report (R4);
  5. call `deliver_decomposition`;
  6. map its `DeliveryOutcome` onto the item. A delivering result is `delivering`, with the entry id and the delivery. The outcomes that end without a delivery (`already_loaded`, `duplicate`, `in_flight`, `changed_in_target`, `unresolved`, `failed`) are final at once. A `duplicate`'s detail names the document it duplicates.
  7. emit `job_events` for each stage, so the live view moves.
- Settlement: `applyRegisterEvent` also updates the item with this entry. A `delivered` receipt gives `created` or `updated` (from whether the entry had a persistent id before), with `link` taken from `receipt.written[].url`. `readBack.ok: false` gives `read_back_mismatch` with `readBack.at`. `changed` gives `changed_in_target`. `failed` gives `failed`. An update is applied only while the item is `delivering` or `queued`, and is idempotent.
- [ ] **Step 1: Write the failing tests.**
  - Python, with the memory register and a fake bridge:
    - `decomposes and delivers a new file as delivering`;
    - `a repeat is already loaded`;
    - `same bytes under another key is duplicate naming the first`;
    - `a fidelity failure fails the item with the check`;
    - `a second batch for a pending entry reports in flight`;
    - `writes the report beside the source`.
  - TS:
    - `settles the item created from a delivered event`;
    - `a read-back failure settles as read_back_mismatch`;
    - `changed_in_target settles the item and never awaits review`;
    - `settles the item whatever the order of event and worker write`.
- [ ] **Step 2: Run** `npm run worker:test -- -k decompose_job` and `npx vitest run --project api conversion-settle`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check`. Expected: green.
- [ ] **Step 5: Commit**: `feat(decomposition): the decompose job, and items settled from bridge events`.

### Task 4: Row actions — force-load, redeliver, detach, accept the target's state

**Files:**
- Modify: `apps/api/src/routes/conversions.ts`, `apps/api/src/conversions/repo.ts` and the repos, `docs/openapi.json`
- Test: `apps/api/test/conversion-actions.test.ts`, `worker/tests/test_decompose_job.py`

**Interfaces:**
- Every action is a route open to operators, designers and admins:
  - `POST /items/:id/force`: a new single-item batch with `force: true`, reusing the item's stored source (§8: an already-loaded item becomes an update, and a duplicate becomes a create).
  - `POST /items/:id/redeliver`: a new single-item batch with `force: true` for the entry's source key and target (R6). It takes an optional multipart `file`, the replacement, which keeps the source key.
  - `POST /items/:id/detach`: deletes the register entry and logs `register_actions{action:'detach', by, details:{persistentId, sourceKey}}`. The item's detail says it was detached. The next run of that source creates a new document.
  - `GET /items/:id/accept`: the preview, `{changed: [{id, expected, actual}], acceptable: boolean, reason?}`, read from the entry's `last_error.details` (R5).
  - `POST /items/:id/accept {confirm: true}`: rewrites the entry's `last_receipt.document.components` with the actual versions, sets its state to `delivered`, and logs `register_actions{action:'accept', by, details:{changed}}`. It refuses with 422 when `more` is present or when the entry isn't `changed`.
- [ ] **Step 1: Write the failing tests:**
  - `force-load turns already loaded into an update`;
  - `force-load turns a duplicate into a create`;
  - `redeliver with a replacement file keeps the source key`;
  - `detach forgets the entry and records who`;
  - `the next run after detach creates a new document`: in the worker test, against the memory register;
  - `accept preview lists each changed component`;
  - `accept needs confirm`;
  - `accept rewrites the expected versions and records who`;
  - `accept refuses when more components changed than the refusal lists`;
  - `an accept followed by a further edit refuses again`: the fake sink edits again, and the next update gives `changed_in_target`;
  - `operators may act on rows`.
- [ ] **Step 2: Run** `npx vitest run --project api conversion-actions` and `npm run worker:test -- -k decompose_job`. Expected: FAIL.
- [ ] **Step 3: Implement**, then run `npm run openapi`.
- [ ] **Step 4: Run** `npm run check`. Expected: green.
- [ ] **Step 5: Commit**: `feat(api): conversion row actions — force-load, redeliver, detach, accept`.

### Task 5: The Conversion tab — start a batch

**Files:**
- Create: `apps/web/src/conversion/ConversionPage.tsx`, `apps/web/src/conversion/NewBatch.tsx`, `apps/web/test/conversion-new-batch.test.tsx`
- Modify: `apps/web/src/router.ts` (route `conversion` and `conversion/<batchId>`), `apps/web/src/App.tsx`, `apps/web/src/shell/AppShell.tsx` (a nav link, shown to every role), `apps/web/src/shell/derive.ts`, `packages/shared/src/roles.ts` (added to `OPERATOR_PAGES`), `apps/web/src/api/client.ts` and `apps/web/test/fake-api.ts` (the new `Api` methods), `apps/web/src/help/index.ts` (topic `conversion`)

**Interfaces:**
- The `Api` gains `listConversionTargets`, `createConversionBatch`, `uploadConversionItem`, `startConversionBatch`, `discardConversionBatch`, `listConversionBatches`, `getConversionBatch`, `getConversionReport`, `forceConversionItem`, `redeliverConversionItem`, `detachConversionItem`, `previewAccept` and `acceptTargetState`.
- `NewBatch` works like this:
  - it has a target select fed by `listConversionTargets`;
  - it offers "Choose files", "Choose folder" (`webkitdirectory`) and a drop zone using `readDrop`;
  - it lists the chosen files with their source keys, skipping `~$*` files and dot files, and lets the person remove any;
  - it has a force-load checkbox and a Start button.

  Start creates the batch, uploads the items one at a time with a progress meter, then starts the batch and navigates to `#conversion/<batchId>`. A file refused on upload shows its reason, and the rest carry on.
- [ ] **Step 1: Write the failing tests:**
  - `offers only targets that take documents`;
  - `a single file becomes a batch of one`;
  - `a folder keeps each file's relative path as its source key`;
  - `skips lock and hidden files`;
  - `a refused file shows its reason and the others upload`;
  - `start opens the batch view`;
  - `operators see the tab`.
- [ ] **Step 2: Run** `npx vitest run --project web conversion`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use the existing UI pieces: `UploadStrip` patterns, `folder-drop.ts`, `Meter`, `Dialog`, `HelpButton`.
- [ ] **Step 4: Run** `npm run check`. Expected: green.
- [ ] **Step 5: Commit**: `feat(web): the Conversion tab — start a batch`.

### Task 6: The batch view — progress, outcomes, reports and actions

**Files:**
- Create: `apps/web/src/conversion/BatchView.tsx`, `apps/web/src/conversion/ItemActions.tsx`, `apps/web/src/conversion/AcceptDialog.tsx`, `apps/web/src/conversion/ReportPanel.tsx`, `apps/web/test/conversion-batch.test.tsx`
- Modify: `apps/web/src/conversion/ConversionPage.tsx` (earlier batches, newest first)

**Interfaces:**
- `BatchView` shows one row per item: the source key, the outcome as a `StatusPill` with the §3 wording, the detail, a link to the target when there is one, and "Report".
  - It refreshes from `getConversionBatch` while any item is unfinished, through the job's live events (`watchJob`) or every 3 s.
  - A filter offers All, Needs attention (`duplicate`, `changed_in_target`, `read_back_mismatch`, `unresolved`, `failed`) and Done.
- `ItemActions` offers each action only where it applies:
  - force-load on `already_loaded` and `duplicate`;
  - redeliver on any delivered or refused item, with an optional file;
  - detach and accept on `changed_in_target`.
- `AcceptDialog` warns, in so many words, that the edits made in the target will be overwritten. It lists each changed component with its version then and now, and enables Confirm only after a checkbox "I understand the edits in the target will be overwritten".
- [ ] **Step 1: Write the failing tests:**
  - `shows one row per document with its outcome`;
  - `rows update as items settle`;
  - `filters to needs attention`;
  - `links a delivered document to the target`;
  - `opens an item's report`;
  - `offers force-load on already loaded`;
  - `detach asks to confirm`;
  - `accept shows each changed component and needs the checkbox`;
  - `accept is unavailable when too many changed`;
  - `resumes an open batch after reload`: `#conversion/<id>` of a started batch shows its rows;
  - `earlier batches newest first`.
- [ ] **Step 2: Run** `npx vitest run --project web conversion`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run check`. Expected: green.
- [ ] **Step 5: Commit**: `feat(web): the batch view — outcomes, reports, actions`.

### Task 7: End to end through the fake document sink, and the docs

**Files:**
- Create: `apps/api/test/integration/conversion-e2e-pg.test.ts`, or the nearest existing end-to-end harness. Look at `apps/bridge/test/decomposed-e2e.test.ts` and the API's integration tests, and use whichever runs the API, the worker and the bridge's fake document sink (`FAKE_SINK_MODE=documents`) together.
- Modify:
  - the spec's §11, adding a phase 3 status line;
  - `docs/architecture.md`, with a short decomposition section;
  - `CLAUDE.md`, with a decomposition bullet;
  - `docs/release-notes/Release-Notes-<date>.html`.

- [ ] **Step 1: Write the failing test:**
  - `a single file, then a folder, go through to the fake sink with one row per document`: a 1-file batch is created; a 3-file folder batch gives created ×3; the same folder again gives already loaded ×3; one file changed gives updated; an edit in the fake sink (`/_edit`), then a run, gives changed in target; accept, then a run, gives updated.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement** any glue the test exposes, then write the docs and the release note.
- [ ] **Step 4: Run** `npm run check`, `npm run format:check` and `npm run test:integration`, where the database is set. Expected: green.
- [ ] **Step 5: Commit**: `test(decomposition): batches end to end; docs and release note`.

---

**Phase 3 is done when** (spec §11): a single file, and then a folder, go through to the fake sink
with one row per document. The owner then runs the sample report through the tab against the real
sink (phase D in the sink's design).
