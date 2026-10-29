# Watched folders 3: watches in CT Studio — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Admins set up watched folders. The worker picks up settled PDF and Word files from each folder's root, converts and delivers them through the watch's long-lived batch, and moves them to `delivered/` or `failed/` with an optional reason file. Admins monitor and control watches from a new *Watched folders* page.

**Architecture:** Watches live in Postgres (`watched_folders` and three side tables). The worker runs a *watch cycle* for each due watch from its `tick()`, holding a per-watch session advisory lock so only one process polls a watch. A cycle finishes items that reached an outcome (the final move), resumes half-done pickups, lists the root through the bridge (plan 1's client), and admits settled files: store in the runs bucket, move to `processing/`, add a conversion item to the watch's batch and queue its `decompose` job. Plan 2's lanes then govern delivery. The API serves admin-only CRUD and control routes and a test listing. The web adds an admin-only nav page, and the Conversion page tags watch batches and hides re-processing actions.

**Tech Stack:** Python 3.14 worker (psycopg, Pydantic), TypeScript API (Fastify, Zod), React web, Postgres.

**Spec:** `docs/superpowers/specs/2026-10-29-watched-folders-design.md` (§3, §5-§8)

**Depends on:** plan 1 (bridge source operations, `watchedFoldersOf`, browse `scope`) and plan 2 (lanes, `waiting_to_deliver`).

## Global Constraints

- Candidates: name ends `.pdf` or `.docx` (any case), in the root only; settled = same size and modified time on two looks at least 10 s apart; other files untouched. (spec §3)
- Looks: again at once after admitting a file or finishing a document; otherwise after the watch's `sleep` (default 30 s, 10 s to 3600 s); a file first seen is looked at again after 10 s. (spec §3)
- Working name: the original, else the first free `stem_N.ext` (N from 1) not taken in `processing/`, `delivered/` or `failed/`. (spec §3)
- Order: store a copy in the runs bucket, then move root → `processing/<working name>`. (spec §3)
- Source key (register identity) = the watch's folder path + `/` + the original name; folder path = the `sourceFields` values in the sink's field order joined by `/` (`watchSourcePath`). (spec §3)
- `delivered/` for `created`, `updated`, `already_loaded`; `failed/` for `duplicate`, `changed_in_target`, `read_back_mismatch`, `unresolved`, `failed`, `rejected`. `awaiting_review` and `waiting_to_deliver` stay in `processing/`. (spec §3)
- A root file whose original name has an unfinished item in the same watch is not admitted. At most `admit` (default 10, 1 to 100) of a watch's items unfinished at once. (spec §3, §6)
- A watch acts as its run-as user (`ActingUser`) for every bridge call and as the batch's creator. (spec §5)
- Reason file `failed/<working name>.md`, on by default; a failure to write it is a watch event, never blocking. (spec §7)
- Admin only: every `/api/watches*` route (`'x-admin': true`, 403 `admins only`), the nav item and page; operators get 403 (not in `OPERATOR_CALLS`). (spec §8)
- Watch batches: Re-run, Re-run N failed, Force-load, Redeliver and *Load as a new document* hidden and refused by the API (409 `watched documents are re-processed by uploading them again`); Detach, Accept and review stay. (spec §6)
- Counters (24 h and total, delivered/failed) survive deleting the watch's batch. (spec §6, §8)
- Migration `db/migrations/202610291400_watched_folders.sql`. New routes documented; help topic `watchedFolders` in `HELP_TOPICS` and `HELP_INDEX`; release note; CLAUDE.md.
- Never name a particular platform in code, docs, help or messages.

## Review Focus

- The same file name dropped twice quickly, before the first finishes: the second waits in the root, then becomes `name_1.ext` and updates the same document. → Task 3 test `a second upload of a name in progress waits, then updates`.
- The worker dies between storing the copy and moving the file, or between moving and queueing: the next cycle completes that pickup, never converting the file twice. → Task 3 test `a pickup interrupted at each step resumes once`.
- A file still being uploaded (size changing between looks) is never taken. → Task 3 test `a growing file is not admitted`.
- The run-as user is disabled (connection gone): the watch shows *Problem: no connection for <user>* and recovers when another admin takes it over. → Task 3 test `a missing connection makes the watch a problem` and Task 4 test `another admin takes over a stopped watch`.
- The watch's batch deleted while documents are in flight: finished rows go, unfinished ones stay, counters keep counting, the next pickup reuses or recreates the batch. → Task 4 test `deleting a watch batch keeps unfinished rows and the counters`.

---

### Task 1: Tables and the watch repository (API side)

**Files:**
- Create: `db/migrations/202610291400_watched_folders.sql`
- Create: `packages/shared/src/watches.ts` (schemas)
- Create: `apps/api/src/watches/repo.ts` (`WatchRepo`, `MemoryWatchRepo`), `apps/api/src/watches/pg.ts` (`PgWatchRepo`)
- Test: `apps/api/test/watch-contract.ts`, `apps/api/test/watch-repo.test.ts`, `apps/api/test/integration/watch-pg.test.ts` (copy `github-sync-contract.ts` / `github-sync-repo.test.ts` / `integration/github-sync-pg.test.ts`)

Migration:
- `watched_folders`: `id uuid pk`, `name text unique (1-80)`, `target_id text → publish_targets`, `source jsonb`, `source_path text`, `run_as jsonb {id,name,email}`, `force bool default false`, `auto_approve bool default true`, `reason_files bool default true`, `sleep_seconds int default 30 check 10..3600`, `admit int default 10 check 1..100`, `state text check in ('running','draining','stopped') default 'stopped'`, `batch_id uuid → decomposition_batches on delete set null`, `problem text`, `root_waiting int default 0`, `next_look_at timestamptz default now()`, `last_look_at`, `last_pickup_at`, `total_delivered bigint default 0`, `total_failed bigint default 0`, `created_by jsonb`, `created_at`, `updated_at`.
- `watch_pickups`: `id uuid pk`, `watch_id → watched_folders on delete cascade`, `original_name`, `size bigint`, `modified_at timestamptz`, `etag text`, `first_seen_at`, `step text check in ('seen','stored','moved','queued','finished','abandoned')`, `working_name text`, `item_id uuid`, `object_key text`, `updated_at`; unique `(watch_id, original_name, size, modified_at)`.
- `watch_finishes`: `watch_id → watched_folders on delete cascade`, `finished_at`, `delivered bool`; index `(watch_id, finished_at)`.
- `watch_events`: `id bigserial`, `watch_id → … cascade`, `at`, `level text check in ('info','warn','error')`, `message text`, `details jsonb`.
- `decomposition_batches.watch_id uuid → watched_folders on delete set null`.
- `decomposition_items.watched bool not null default false`; drop the `UNIQUE (batch_id, source_key)` constraint (look up its name from `pg_constraint` in the migration) and create `UNIQUE INDEX … (batch_id, source_key) WHERE NOT watched` (keeps `addItem`'s `ON CONFLICT` target: change it to `ON CONFLICT (batch_id, source_key) WHERE NOT watched`).
- `decomposition_items.object_key` nullable (a refused watched file never stored).

**Interfaces:**
- Produces (`packages/shared/src/watches.ts`): `WatchSettingsSchema` (`name`, `targetId`, `source: Record<string,string>`, `force`, `autoApprove`, `reasonFiles`, `sleepSeconds`, `admit`), `WatchStateSchema = z.enum(['running','draining','stopped'])`, `WatchHealth = 'running'|'draining'|'stopped'|'problem'`, `WatchViewSchema` (settings + `id`, `state`, `health`, `problem`, `sourcePath`, `runAs`, `queue: {waiting: number, inProgress: number}`, `throughput: {day: {delivered, failed}, total: {delivered, failed}}`, `lastPickupAt`, `batchId`, `createdAt`), `WatchEventSchema`, `WatchCreateBodySchema`, `WatchPatchBodySchema`, `StopBodySchema = {mode: 'now'|'drain'}`, `watchSourcePath(fields: DestinationField[], source: Record<string,string>): string`, `healthOf(w): WatchHealth` (problem wins over running/draining; stopped is never a problem).
- Produces (`WatchRepo`): `list(): Promise<WatchView[]>`, `get(id)`, `create(settings, runAs, sourcePath, createdBy)`, `update(id, patch, expectState?)` (folder, target and `runAs` only while `stopped`: result `{ok:false, reason:'running'}`), `setState(id, state)`, `remove(id)` (refused unless stopped), `events(id, limit=100)`, `unfinishedItems(id): Promise<{itemId, jobId, outcome}[]>`, `problemCount(): Promise<number>`.

- [ ] **Step 1: Write the contract tests** (memory now, Pg with `IH_TEST_DATABASE_URL`): create/list/get round-trip with defaults (`autoApprove` true, `reasonFiles` true, `sleepSeconds` 30, `admit` 10, `state` stopped); names unique; `update` of `targetId` while running → `running`; `remove` while running refused; `throughput.day` counts only `watch_finishes` from the last 24 h; `healthOf` table (state × problem); `watchSourcePath` joins in field order and ignores fields not declared.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/watch-repo.test.ts` — FAIL.
- [ ] **Step 3: Implement** the migration, schemas and both repos.
- [ ] **Step 4: Run** memory and Pg runs — PASS.
- [ ] **Step 5: Commit** `feat(watches): watched folder tables and repository`

### Task 2: Source check and reason file (worker, pure)

**Files:**
- Create: `worker/src/ingest_worker/watch/__init__.py`, `watch/naming.py`, `watch/reason.py`, `watch/sources.py`
- Create: `packages/shared/test/fixtures/watch-naming.json` (cases for `working_name` and `watch_source_path`, read by both sides; the TS `watchSourcePath` test reads it too)
- Test: `worker/tests/test_watch_pure.py`

**Interfaces:**
- Produces:
  - `is_candidate(name: str) -> bool`; `working_name(original: str, taken: set[str]) -> str`; `watch_source_path(field_ids: list[str], source: dict[str,str]) -> str` (same rule as TS); `source_key(path: str, original: str) -> str` = `f"{path}/{original}"`.
  - `source_problem(data: bytes, filename: str, max_bytes: int) -> str | None`: a port of `checkSource` (`apps/api/src/uploads.ts:8,68`) with the same messages: `file is not a PDF or Word document (.docx)`, the tracked-changes message, the size message. Uses `convert.is_docx` and `decompose.source_kind`.
  - `reason_markdown(r: ReasonFacts) -> str` with `ReasonFacts(original_name, working_name, uploaded_at, picked_up_at, finished_at, outcome_label, detail: str | None, advice: str, link: str | None)`; `advice_for(outcome: str) -> str` ("Correct the document and upload it to the folder again." / for `changed_in_target`: "An administrator must detach or accept it in CT Studio before it can be loaded again.").
  - Settings: `APP_PUBLIC_URL` (optional, worker `config.py`): the link is `{APP_PUBLIC_URL}/#/conversion/{batchId}` when set, else omitted. `MAX_UPLOAD_MB` read by the worker too (default 50, as the API).

- [ ] **Step 1: Write failing tests**: `is_candidate` table (`a.PDF` yes, `a.docx` yes, `a.doc`/`a.pdf.tmp`/`.hidden.pdf` no — dotfiles are skipped); the shared fixture's naming cases (`report.docx` with `{report.docx}` taken → `report_1.docx`; with `report_1.docx` also taken → `report_2.docx`; `archive.tar.pdf` → `archive.tar_1.pdf`); `source_problem` on a tiny PDF (None), random bytes, a `.docx` with `<w:ins` in the body, an oversized blob; `reason_markdown` snapshot with and without a link.
- [ ] **Step 2: Run** `cd worker && uv run pytest tests/test_watch_pure.py` — FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — PASS; also the TS `watchSourcePath` test against the fixture.
- [ ] **Step 5: Commit** `feat(worker): watched file naming, checks and reason files`

### Task 3: The watch cycle (worker)

**Files:**
- Create: `worker/src/ingest_worker/watch/store.py` (`WatchStore` protocol, `PgWatchStore`, its SQL), `watch/cycle.py`, `watch/runner.py`
- Modify: `worker/src/ingest_worker/main.py:398-549` (build `WatchRunner` in `_Worker.__init__`, call `runner.tick()` from `tick()` every second; close it in `close()`)
- Modify: `worker/tests/fakes.py` (`MemoryWatchStore`)
- Test: `worker/tests/test_watch_cycle.py` (memory), `worker/tests/test_watch_store_pg.py` (`IH_TEST_DATABASE_URL`)

**Interfaces:**
- Consumes: plan 1 `BridgeClient.list_source/read_source/move_source/put_source_text`; plan 2 outcomes; Task 2 helpers; `decomposition_source_key` (`storage.py`).
- Produces:
  - `WatchStore`: `due(now) -> list[Watch]`, `pickups(watch_id) -> list[Pickup]`, `see(watch_id, f: SourceFile, now)`, `advance(pickup_id, step, **fields)`, `admit(watch, pickup, item_id, object_key, working_name) -> str` (one transaction: ensure the watch's batch (create `started`, `watch_id`, `created_by = run_as`, `force`, `auto_approve` when `batch_id` is null), insert the item with `watched = true`, `source_key`, `filename = working_name`, insert the `decompose` job (`DECOMPOSE_JOB` priority 0, max attempts 3, params `{batchId, itemId, targetId, sourceKey, force, autoApprove}`), set `job_id`, step `queued`; returns the item id), `refuse(watch, pickup, working_name, reason)` (an item with outcome `failed`, `object_key` null, plus a finish), `item_outcome(item_id) -> str | None`, `finish(watch_id, delivered: bool, at)` (row in `watch_finishes`, total incremented), `set_health(watch_id, problem: str | None, root_waiting: int | None, now)`, `schedule(watch_id, next_look_at)`, `event(watch_id, level, message, details)`, `set_state(watch_id, state)`.
  - `run_cycle(w: Watch, deps: WatchDeps, now: datetime) -> CycleResult(admitted: int, finished: int, next_look_at: datetime)`; `WatchDeps(store, bridge, objects: ObjectStore, runs_bucket, max_bytes, app_url)`.
  - `WatchRunner.tick()`: for each due watch, `pg_try_advisory_lock(slot_key('watch:'+id))` on its own autocommit connection (pattern of `call_slots.PgCallSlots`), run the cycle, unlock.

Cycle order (one place, `run_cycle`):
1. **Finish:** for each `queued` pickup whose item outcome is final: move `processing/<working>` → `delivered/` or `failed/` (mapping in Global Constraints); with reason files on and `failed/`, `put_source_text(failed, <working>.md, reason_markdown(...))`; `finish(...)`; step `finished`.
2. **Resume:** `stored` → move to `processing/` then `admit`; `moved` → `admit`.
3. **Draining:** if state `draining` and no unfinished item → `set_state('stopped')`; stopped or draining watches skip steps 4-5.
4. **Look:** `list_source(root)`; on `BridgeRefused`/`BridgeUnavailable` → `set_health(problem=<message>)`, event, schedule `now + sleep`, return. Success clears the problem and records `root_waiting` (candidates seen). New candidates → `see`; a candidate whose size and modified time match its `seen` row and whose `first_seen_at <= now - 10 s` is settled.
5. **Admit:** settled candidates, oldest modified first, skipping names with an unfinished item in this watch, up to `admit - unfinished`: list the three subfolders once; `working_name`; over `max_bytes` (from the listing) → move to `failed/`, reason file, `refuse`; else `read_source` → `source_problem` → refuse as above, or store in runs at `decomposition_source_key(batch, item, ext)` (`stored`), move to `processing/` (`moved`), `admit` (`queued`).
6. **Schedule:** `now` if anything was admitted or finished; `now + 10 s` if a candidate is unsettled; else `now + sleep`.

- [ ] **Step 1: Write failing tests** (memory store, `FakeBridge` sources, `MemoryObjectStore`, frozen clock):
  - `a settled file is picked up`: drop `a.pdf`; cycle 1 sees it (nothing moved), cycle at +10 s admits it: root empty, `processing/a.pdf` present, item queued with `source_key == "<path>/a.pdf"`, job params carry `autoApprove: True`.
  - `a growing file is not admitted`: size changes between looks → not admitted until two equal looks.
  - `delivered and failed moves`: item `created` → file in `delivered/`; item `duplicate` → `failed/a.pdf` and `failed/a.pdf.md` containing the outcome label; reason files off → no `.md`.
  - `a second upload of a name in progress waits, then updates`: `report.docx` in progress, a new `report.docx` waits in the root; after the first is `created`, the second is admitted as `report_1.docx` with the same `source_key`.
  - `a pickup interrupted at each step resumes once`: inject a failure after `stored`, after `moved`; next cycle completes; exactly one item and one job.
  - `admit caps unfinished items`: 15 files, `admit` 10 → 10 admitted; after 3 finish, 3 more.
  - `an invalid file goes straight to failed`: random bytes named `x.pdf` → `failed/x.pdf` + reason, item `failed`, no job.
  - `a missing connection makes the watch a problem`: `list_source` raises `BridgeRefused(connection_missing)` → problem set, next look after `sleep`; a later successful list clears it.
  - `draining stops once the last item finishes`.
  - `a stopped watch is never looked at`.
  - Pg: `two runners never run one watch at once` (two threads, one admits).
- [ ] **Step 2: Run** `cd worker && uv run pytest tests/test_watch_cycle.py` — FAIL.
- [ ] **Step 3: Implement** store, cycle and runner; wire into `main.py`.
- [ ] **Step 4: Run** `npm run worker:test`, `npm run worker:lint` — PASS.
- [ ] **Step 5: Commit** `feat(worker): watch cycle picks up, converts and files documents`

### Task 4: API routes

**Files:**
- Create: `apps/api/src/routes/watches.ts`; register in `apps/api/src/app.ts:197-227`; `AppDeps.watches: WatchRepo` (wired in `server.ts` with `PgWatchRepo(makePool(2))`)
- Modify: `apps/api/src/bridge/client.ts` (`sourceList(targetId, body)`, `browse` passes `scope`)
- Modify: `apps/api/src/routes/conversions.ts` and repos: `BatchSchema.watch: {id, name} | null` (join `watched_folders`); refuse retry (`POST …/batches/:id/retry`), rerun, force, redeliver and reload for items of a watch batch with 409 `watched documents are re-processed by uploading them again` (`code: 'watched'`); `deleteBatch` of a watch batch: delete its finished items and their files, keep unfinished ones (the batch stays while any remain; with none left the batch is deleted and `watched_folders.batch_id` set null)
- Test: `apps/api/test/watches.test.ts`, extend `apps/api/test/conversion-actions.test.ts`, `apps/api/test/access.test.ts` sweeps (automatic), `apps/api/test/roles.test.ts` (automatic)

**Interfaces:**
- Consumes: Task 1 repo and schemas; plan 1 `watchedFoldersOf`.
- Produces routes (tag *Watched folders*, all `'x-admin': true`):
  - `GET /api/watches` → `WatchView[]`; `GET /api/watches/problems` → `{count}` (for the nav badge); `GET /api/watches/:id` → `{watch, events}`.
  - `GET /api/watches/sources` → targets offered for a watch: `{targetId, label, sinkId, instanceId, sourceFields}[]` (targets whose sink has `watchedFolders` and `decomposedDocuments`).
  - `POST /api/watches/browse` → the bridge browse with `scope: 'source'` as the session's user.
  - `POST /api/watches/test` `{targetId, source}` → lists the root as the session's user: `{ok: true, files: number}` or `{ok: false, problem}`.
  - `POST /api/watches` (201): runs the test first (422 with the problem if it fails); `runAs` = the session's user; `state` `running`.
  - `PATCH /api/watches/:id` (body may include `runAsMe: true`; folder, target and `runAsMe` only while stopped → 409 `stop the watch first`).
  - `POST /api/watches/:id/stop` `{mode}`: state `stopped` (now) or `draining`; *now* also cancels the watch's unfinished items that have not reached the bridge (`queued`, `decomposing`, `waiting_to_deliver`, `awaiting_review`): their jobs `cancelled`, items `failed` with detail `Cancelled: the watch was stopped`, held copies deleted, pickups `abandoned`. Items `delivering` finish on their own and are not moved.
  - `POST /api/watches/:id/start`: `running`, problem cleared, `next_look_at = now()`.
  - `DELETE /api/watches/:id` (204; 409 `stop the watch first` unless stopped).

- [ ] **Step 1: Write failing tests** (`buildApp` with memory repos and a fake `BridgeApi`): designer and operator get 403 on every route; create runs the test and 422s on a failed listing; create stores `runAs` = session user; `another admin takes over a stopped watch` (`runAsMe`); patching the target while running → 409; stop `now` fails queued items and abandons pickups, `drain` only changes state; delete refused while running; `deleting a watch batch keeps unfinished rows and the counters`; a watch batch's retry/rerun/force/redeliver/reload → 409 `watched`; detach still works; `BatchSchema.watch` set for a watch batch; the OpenAPI test passes.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/watches.test.ts` — FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npx vitest run --project api` and `npm run openapi` — PASS.
- [ ] **Step 5: Commit** `feat(api): watched folder routes`

### Task 5: Watched folders page and Conversion changes (web)

**Files:**
- Create: `apps/web/src/watches/WatchedFoldersPage.tsx`, `WatchDialog.tsx` (new and reconfigure), `StopWatchDialog.tsx`, `WatchDetail.tsx`, `derive.ts`
- Modify: `apps/web/src/router.ts:21-126` (route `watches`, hash `#/watched-folders`), `apps/web/src/shell/derive.ts:5-86` (`SECTION`, `PAGE`: title *Watched folders*), `apps/web/src/shell/AppShell.tsx:414-449` (admin-only `NavLink` with badge, prop `watchProblems: number`), `apps/web/src/App.tsx:327-442` (route branch; admins only, others get the *Not available* card; poll `getWatchProblems` every 30 s for admins)
- Modify: `apps/web/src/api/client.ts:424` (`Api` methods `listWatches`, `getWatch`, `getWatchProblems`, `listWatchSources`, `browseWatchSource`, `testWatch`, `createWatch`, `updateWatch`, `stopWatch`, `startWatch`, `removeWatch`), `apps/web/test/fake-api.ts:314`
- Modify: `apps/web/src/conversion/BatchView.tsx:82-83,322-323,701-745`, `ItemActions.tsx` (prop `watched: boolean` hides Force-load, Redeliver, Load as a new document; Re-run and *Re-run N failed* hidden), `ConversionPage.tsx:178-179` (a *Watched: <name>* tag)
- Create: `apps/web/src/help/WatchedFoldersHelp.tsx`; modify `help/topics.tsx` (`watchedFolders`), `help/index.ts` (entry after Conversion, label *Watched folders*)
- Test: `apps/web/test/watches/WatchedFoldersPage.test.tsx`, `apps/web/test/watches/WatchDialog.test.tsx`, extend the BatchView and AppShell tests, `apps/web/test/HelpCenter.test.tsx` (automatic)

Page: header *Watched folders* with *New watch* and the `?` (help `watchedFolders`); a ledger table (name, folder, target, runs as, health chip — Running/Draining/Stopped/Problem with reason, queue `n waiting · n in progress`, *Last 24 h* `n delivered · n failed`, *Total* likewise, last pickup as relative time, a link *Batch* to `#/conversion/<batchId>`) and a `⋯` menu (Reconfigure, Stop…, Start, Remove…); a row opens `WatchDetail` (settings and the newest 100 events). `StopWatchDialog` offers *Stop now* (explains files stay where they are) and *Drain* (default). `WatchDialog`: name; target (from `listWatchSources`); the target's `sourceFields` with *Browse…* where `browse`; force-load (off); auto-approve (on); reason files (on); sleep when idle (seconds, 30); admit (10); *Test folder* (calls `testWatch`); Save disabled until the test passed for the current folder. Folder, target and *Run as me* are disabled while the watch is not stopped, with the reason.

- [ ] **Step 1: Write failing tests** (Testing Library, by role and label): the nav item shows only for admins and carries the problem badge; the ledger renders the health chip, queue and throughput figures from `fakeApi`; *Stop…* → choosing *Drain* calls `stopWatch(id, {mode: 'drain'})`; `WatchDialog` keeps Save disabled until *Test folder* passes; reconfiguring a running watch disables folder and target; a watch batch hides Re-run, Force-load, Redeliver and Load as a new document but shows Detach; the batch list shows *Watched: Inbox*; the help topic opens from the page's `?`.
- [ ] **Step 2: Run** `npx vitest run --project web` — FAIL.
- [ ] **Step 3: Implement** following the Results/Jobs page layout tokens and existing primitives (`Dialog`, `usePopover`, `StatusGlyph`).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(web): watched folders page`

### Task 6: End to end, docs and check

**Files:**
- Create: `apps/api/test/integration/watch-e2e-pg.test.ts` (API on Pg, the worker's `run_once` and a watch cycle in a `uv` process via an extended `worker/tests/conversion_e2e_worker.py`, the bridge and the fake document sink from `apps/bridge/test/conversion-bridge.ts` with `lanes: 1`): create a watch through the API; `/_drop` `good.docx` and `bad.pdf` (random bytes) and a second `good.docx` after the first is delivered; assert `delivered/good.docx`, `delivered/good_1.docx` updating the same register entry, `failed/bad.pdf` and `failed/bad.pdf.md`; the watch view's totals `2 delivered · 1 failed`.
- Modify: `CLAUDE.md` (a *Watched folders* rule and cross-language row: `watches.ts`, `watch/` modules, `watch-naming.json`, `source_problem` ↔ `checkSource`, `APP_PUBLIC_URL`), `docs/architecture.md`, `deploy/.env.example` (`APP_PUBLIC_URL`), today's release note (Major change *Watched folders*; *Watch out for*: migration `202610291400`, `APP_PUBLIC_URL`, the new admin page).

- [ ] **Step 1: Write the e2e test**; run it per its header — PASS.
- [ ] **Step 2:** Docs.
- [ ] **Step 3: Run** `npm run check`, `npm run worker:lint` — PASS.
- [ ] **Step 4: Commit** `test(watches): end to end; docs`
