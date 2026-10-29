# Watched folders 2: tenant lanes and decomposing while delivering — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Conversions to one tenant (sink + instance) never have more than that tenant's `lanes` deliveries in progress, documents are decomposed while others deliver, and waiting documents take turns across batches.

**Architecture:** A conversion item *claims a lane* (`lane_claimed_at`) before it is handed to the bridge, under a per-tenant advisory lock in the worker. Without a free lane, or when others are already waiting, it stores its decomposition the way a held PDF does and becomes `waiting_to_deliver`. A worker-side dispatcher, run every few seconds, gives free lanes to waiting items round-robin across batches and queues a `decompose` job with `waited: true`, which delivers from the stored copy (the register decides afresh). An approved PDF goes through the same gate. The tenant's lane count comes from the sink catalog, cached on `publish_targets.lanes` by the API's target sync.

**Tech Stack:** Python 3.14 worker (psycopg, Pydantic), TypeScript API/web (Fastify, Zod, React), Postgres.

**Spec:** `docs/superpowers/specs/2026-10-29-watched-folders-design.md` (§6 lanes and taking turns, §11)

**Depends on:** plan 1 (`lanesOf`, `SinkInfo.instances[].lanes`).

## Global Constraints

- A lane is held only while an item is being handed to the bridge or is `delivering`; decomposition and `awaiting_review` hold none. (spec §6, §11)
- The limit is counted from item states in one place (`decompose/lanes.py`), never from job claims. (spec §6)
- Lanes: the target's instance `lanes`, else 1. Tenants do not block each other. (spec §4, §6)
- Turns: a freed lane goes to the next batch in turn among batches with waiting items (round-robin by the batch's `last_lane_at`), then that batch's oldest waiting item. A newly decomposed item never jumps ahead of a waiting one. (spec §6)
- New outcome `waiting_to_deliver`, label *Waiting to deliver*, counted as running/unfinished on both sides and in the web. (spec §11)
- The stored copy is the held layout (`decompositions/{batch}/{item}.held/`); page images only for a PDF held for review, never for a waiting Word file. Deleted once the item has an outcome. (spec §11)
- Delivering from the wait re-decides through the register (`deliver_decomposition`), never reusing a decision made at decomposition time. (spec §11)
- Migration name `db/migrations/202610291300_decomposition_lanes.sql`. Release note and CLAUDE.md updated.

## Review Focus

- A worker crashes after claiming a lane but before the bridge accepts: the lane must not leak for ever. → Task 2 test `a lane claimed by a job that failed is released`.
- The bridge refuses at hand-off (`BridgeRefused`) or is down (`BridgeUnavailable`): the item ends `failed` (or retries) and its lane frees. → Task 3 test `a refused hand-off frees the lane`.
- A batch deleted (or all its items finished) while it still has waiting items is impossible: delete refuses while any item is `waiting_to_deliver`. → Task 5 test `a batch with waiting documents cannot be deleted`.
- Lanes reduced on the sink (10 → 1) while 10 are delivering: no new hand-off until fewer than 1 remain; nothing is cancelled. → Task 2 test `fewer lanes than in flight waits`.
- Two workers running the dispatcher at once never give out more lanes than free. → Task 4 Pg test `two dispatchers never over-claim`.

---

### Task 1: Schema, outcome and lane count on both sides

**Files:**
- Create: `db/migrations/202610291300_decomposition_lanes.sql`
- Modify: `packages/shared/src/conversions.ts:9-24` (`ITEM_OUTCOMES` + `waiting_to_deliver`), `DecomposeParamsSchema` (`:215-228`, `waited: z.boolean().optional()`)
- Modify: `apps/api/src/conversions/repo.ts:286-291` (`RUNNING_OUTCOMES`), `apps/api/src/bridge/register.ts:60-75` (`OUTCOME_LABELS`)
- Modify: `worker/src/ingest_worker/decompose/items.py:36-60` (`ItemOutcome`, `_writable`), `worker/src/ingest_worker/decompose/job.py:84-97,240-258` (`DecomposeParams.waited`, `RUNNABLE`, `OUTCOME_LABELS`)
- Modify: `worker/src/ingest_worker/publish_targets.py` (`Target.lanes: int | None`, read from the cache)
- Modify: `apps/api/src/publish-targets/repo.ts` (`lanes` column in `cache`), `apps/api/src/bridge/sync.ts` (`pullTargets` stamps `lanes` from `listSinks()` by `(sinkId, instanceId)`, null when the sink or instance is not described), `apps/api/src/server.ts` (re-pull every 10 minutes beside the reconcile intervals)
- Test: `packages/shared/test/conversions.test.ts`, `apps/api/test/integration/conversions-pg.test.ts:245`, `apps/api/test/bridge-sync.test.ts` (or the existing `pullTargets` test file), `worker/tests/test_decompose_items.py`

Migration contents: drop and re-add `decomposition_items_outcome_check` with the fifteen outcomes; `ALTER TABLE decomposition_items ADD COLUMN lane_claimed_at timestamptz`; `ALTER TABLE decomposition_batches ADD COLUMN last_lane_at timestamptz`; `ALTER TABLE publish_targets ADD COLUMN lanes integer CHECK (lanes BETWEEN 1 AND 64)`; index `decomposition_items (outcome) WHERE outcome IN ('waiting_to_deliver','delivering')`.

**Interfaces:**
- Produces: TS `ItemOutcome` includes `'waiting_to_deliver'`; `DecomposeParams.waited?: boolean`; Python `ItemOutcome` literal includes it; `DecomposeParams.waited: bool = False`; `Target.lanes: int | None`.

- [ ] **Step 1: Write failing tests**: shared `ITEM_OUTCOMES` has fifteen entries incl. `waiting_to_deliver`; Pg test renamed to *refuses an item outcome outside the fifteen* and accepts `waiting_to_deliver`; `pullTargets` writes `lanes: 10` for a target whose sink instance declares 10 and null for one without; worker `MemoryItemStore` allows `decomposing → waiting_to_deliver → delivering` and refuses `created → waiting_to_deliver`; `DecomposeParams(waited=True)` parses and an unknown key still fails.
- [ ] **Step 2: Run** `npx vitest run packages/shared/test/conversions.test.ts` and `cd worker && uv run pytest tests/test_decompose_items.py` — FAIL.
- [ ] **Step 3: Implement** the migration and the lists above.
- [ ] **Step 4: Run** `npm test`, `npm run worker:test`, and the Pg contract with `IH_TEST_DATABASE_URL` — PASS.
- [ ] **Step 5: Commit** `feat(conversion): waiting_to_deliver and cached tenant lanes`

### Task 2: The lane gate

**Files:**
- Create: `worker/src/ingest_worker/decompose/lanes.py`
- Modify: `worker/tests/fakes.py` (`MemoryLaneStore`)
- Test: `worker/tests/test_lanes.py` (memory + Pg cases with `IH_TEST_DATABASE_URL`)

**Interfaces:**
- Produces:
  - `Tenant = tuple[str, str | None]` (sink id, instance id).
  - `class LaneStore(Protocol)`: `try_claim(item_id: str, tenant: Tenant, lanes: int) -> bool` (claims only when `in_flight(tenant) < lanes` **and** no other item of the tenant is `waiting_to_deliver` without a lane; sets `lane_claimed_at = now()`, `decomposition_batches.last_lane_at = now()`); `in_flight(tenant: Tenant) -> int`; `dispatch(tenant: Tenant, lanes: int) -> list[str]` (claims free lanes for waiting items in turn, returns their ids); `waiting_tenants() -> list[Tenant]`.
  - `in_flight` counts items of the tenant with `lane_claimed_at IS NOT NULL AND outcome IN ('decomposing','waiting_to_deliver','delivering')`, plus items whose decompose job is `running` with a lane claimed. A lane is released by the outcome leaving those states; nothing clears it explicitly.
  - `PgLaneStore(conn)`: every method in one transaction holding `pg_advisory_xact_lock(hashtext('lanes:' || sink || ':' || coalesce(instance,'')))`; tenant from `decomposition_items → decomposition_batches.target_id → publish_targets (sink_id, instance_id)`.
  - `lanes_for(target: Target) -> int` = `target.lanes or 1`.

- [ ] **Step 1: Write failing tests** (table-driven over memory and Pg):
  - `try_claim` with lanes 1: first item True, second False until the first item's outcome is `created`.
  - `fewer lanes than in flight waits`: 3 delivering, lanes 1 → False.
  - `a waiting item blocks a newcomer`: lanes 2, 0 in flight, one waiting without a lane → `try_claim` for a new item False.
  - `dispatch` round-robin: batches A (3 waiting) and B (1 waiting), lanes 1, repeatedly dispatch then finish → order A1, B1, A2, A3.
  - `a lane claimed by a job that failed is released`: item with `lane_claimed_at` set and outcome `failed` → `in_flight == 0`.
  - tenants do not block each other.
- [ ] **Step 2: Run** `cd worker && uv run pytest tests/test_lanes.py` — FAIL.
- [ ] **Step 3: Implement** `lanes.py` and `MemoryLaneStore`.
- [ ] **Step 4: Run** — PASS (Pg cases with `IH_TEST_DATABASE_URL`).
- [ ] **Step 5: Commit** `feat(worker): per-tenant lane gate for conversions`

### Task 3: Decompose waits for a lane

**Files:**
- Modify: `worker/src/ingest_worker/decompose/job.py` (`_convert`, `_approved`, new `_wait` and `_from_wait`; `decompose_deps` gains `lanes: LaneStore`)
- Modify: `worker/src/ingest_worker/decompose/hold.py` (`write_held(..., pages: bool)`; manifest field `reason: Literal['review','lane']`)
- Modify: `worker/src/ingest_worker/decompose/items.py` (`wait(item_id, held_sha256, entry) -> bool`, guard `outcome IN ('decomposing','queued')`)
- Test: `worker/tests/test_decompose_job.py` (extend `World` with `MemoryLaneStore`, `lanes=1` by default)

**Interfaces:**
- Consumes: Task 2 `LaneStore`, `lanes_for`.
- Produces: the job's flow:
  1. `_convert` → after the report, if a PDF without auto-approve → `_hold` (unchanged).
  2. Else `lanes.try_claim(item, tenant, lanes_for(target))` → True: `_deliver` as today; False: `_wait` (`write_held(pages=False)`, `items.wait`, event `waiting for a lane`, `Complete("waiting to deliver")`).
  3. `_approved` → `try_claim` → True: `_deliver_held` as today; False: item `waiting_to_deliver` keeping its held files, `Complete`.
  4. `params.waited` → `_from_wait`: `read_held`, check the source sha, `_deliver(... started_by=manifest.started_by)` (no `_hold_is_current` check: the register decides again), `delete_held` once an outcome exists (as `_approved:436`).

- [ ] **Step 1: Write failing tests**:
  - `a Word file with a free lane is delivered at once` (unchanged behaviour, lane claimed).
  - `a second Word file waits while the first delivers`: two uploads, lanes 1 → first `delivering`, second `waiting_to_deliver` with a held manifest and no page images.
  - `a waited run delivers the stored copy`: run the second with `waited=True` after the first settles → `delivering`, the decomposer is not called again, held files deleted after the outcome.
  - `a waited run re-decides through the register`: between wait and delivery the register entry becomes `delivered` for the same content → outcome `already_loaded`.
  - `an approved PDF waits when no lane is free`.
  - `a refused hand-off frees the lane`: `FakeBridge` raises `BridgeRefused` → item `failed`, `in_flight == 0`.
  - `a cancelled waited run fails the item and deletes the stored copy`.
- [ ] **Step 2: Run** `cd worker && uv run pytest tests/test_decompose_job.py -k "lane or wait"` — FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** `npm run worker:test`, `npm run worker:lint`; `IH_UPDATE_GOLDEN` is not needed (the equivalence goldens do not cover decompose; confirm with `uv run pytest tests/test_equivalence.py`) — PASS.
- [ ] **Step 5: Commit** `feat(worker): decompose while another document delivers`

### Task 4: The dispatcher

**Files:**
- Create: `worker/src/ingest_worker/decompose/dispatch.py`
- Modify: `worker/src/ingest_worker/main.py:527-550` (`tick()`: `next_lane_dispatch`, every `LANE_DISPATCH_S = 5`), `worker/src/ingest_worker/queue.py` (`queue_decompose_waited(item: ConversionItem, params: DecomposeParams) -> str`, an `INSERT INTO jobs (task, priority, max_attempts, params)` with the decompose job's priority and attempts used by `startBatch`, and `decomposition_items.job_id` set in the same transaction)
- Test: `worker/tests/test_lane_dispatch.py`

**Interfaces:**
- Consumes: `LaneStore.waiting_tenants`, `dispatch`; `LiveTargets` for lanes.
- Produces: `dispatch_lanes(lanes: LaneStore, targets: LiveTargets, queue: JobQueue) -> int` (jobs queued). Each dispatched item gets a job with params copied from its batch (`batchId, itemId, targetId, sourceKey, force`) plus `waited: true`.

- [ ] **Step 1: Write failing tests**: one waiting item, lane free → one job with `waited: True`, item keeps `waiting_to_deliver` with a lane claimed; no free lane → none; a target that is missing (`TargetMissing`) → its items fail with the target's message; Pg `two dispatchers never over-claim` (two threads, lanes 1, five waiting → exactly one job).
- [ ] **Step 2: Run** `cd worker && uv run pytest tests/test_lane_dispatch.py` — FAIL.
- [ ] **Step 3: Implement**; wire into `tick()`, and also run it right after a decompose job ends (so a freed lane is reused without waiting 5 s when the worker itself settled the item).
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(worker): give free lanes to waiting documents in turn`

### Task 5: API and web show the new state

**Files:**
- Modify: `apps/api/src/repositories/pg.ts` and `memory.ts` (`deleteBatch` counts `waiting_to_deliver` as running through `RUNNING_OUTCOMES`; `approveItem` unchanged — the worker gates it)
- Modify: `apps/web/src/conversion/outcomes.ts:5-32,103-128` (`OUTCOME`, `UNFINISHED`, `OUTCOME_ICON` — a clock glyph via `StatusGlyph`, `batchState`), `BatchView.tsx:48-51` (counts under *Running*), `ConversionPage.tsx:79`
- Modify: `apps/web/src/help/` Conversion topic body (one paragraph: *Waiting to deliver* means the target takes a limited number of documents at once)
- Test: `apps/api/test/conversion-actions.test.ts`, `apps/web/test/conversion/*.test.tsx` (the existing BatchView test)

- [ ] **Step 1: Write failing tests**: `a batch with waiting documents cannot be deleted` (409 `running`); BatchView shows *Waiting to deliver* with its icon and counts it under the running filter; the batch's state is running while one item waits.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/conversion-actions.test.ts` and `npx vitest run --project web` — FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(conversion): show documents waiting to deliver`

### Task 6: End to end, docs and check

**Files:**
- Modify: `apps/api/test/integration/conversion-e2e-pg.test.ts` (a batch of three Word files on a fake document sink instance with `lanes: 1`: the bridge never has two deliveries of that tenant `running` at once, all three end `created`, at least one passed through `waiting_to_deliver`)
- Modify: `CLAUDE.md` (Job statuses / Decomposition rows: `waiting_to_deliver`, `lane_claimed_at`, `last_lane_at`, `publish_targets.lanes`, `lanes.py`, `dispatch.py`, `waited` param), `docs/architecture.md` (conversion section), today's release note (Major change: documents to one target take turns; *Watch out for*: migration `202610291300`)

- [ ] **Step 1: Write the e2e test** and run it with the Pg/worker setup in its header — FAIL before Tasks 1-5 are merged into the branch, PASS after.
- [ ] **Step 2:** Docs.
- [ ] **Step 3: Run** `npm run check` and `npm run worker:lint` — PASS.
- [ ] **Step 4: Commit** `test(conversion): lanes end to end; docs`
