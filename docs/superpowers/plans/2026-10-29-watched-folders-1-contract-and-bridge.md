# Watched folders 1: sink contract and bridge — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sinks can declare per-instance `lanes` and a `watchedFolders` capability (list, read, move, put on a source folder). The bridge enforces lanes on every delivery and relays the folder operations. The worker's bridge client can call them.

**Architecture:** The contract (`packages/bridge-contract`) gains `lanes` on describe instances (version-independent) and contract version 4 with `watchedFolders`. The bridge's delivery claim skips a delivery whose tenant (sink, instance) is at its lane limit, and several runner loops run at once. New sink routes `/sources::{list,read,move,put}` are relayed under a target (`/v1/targets/:id/sources::…`), so the target supplies sink, instance and shared connection, or the acting user supplies a personal one. The fake document sink implements the folder operations in memory.

**Tech Stack:** TypeScript (Zod, Fastify, Vitest), Postgres (`bridge` schema), Python 3.14 (Pydantic, httpx) for the worker client.

**Spec:** `docs/superpowers/specs/2026-10-29-watched-folders-design.md` (§4, §6 lanes, §12 order step 1-2)

## Global Constraints

- `lanes` is an optional integer per describe instance, 1 to 64, independent of `contractVersion`; an instance without it is treated as 1 (`lanesOf`). Built-in sinks (`s3`, `rdf`) are never lane-limited. (spec §4)
- `watchedFolders` needs `contractVersion: 4`; version 4 sinks are sent version 2 packages (`packageVersionFor`). (spec §4)
- Folders are exactly `''` (root), `processing`, `delivered`, `failed`; a file name is one path segment, 1-255 characters, no `/`, `\`, NUL, and not `.` or `..`.
- A move is idempotent: a retried move whose source is gone and whose destination exists with the same size succeeds; the sink creates the destination folder as needed. (spec §4)
- `put` takes UTF-8 text of at most 65,536 characters (the reason file).
- `read` answers raw bytes (`application/octet-stream`), capped by `BRIDGE_MAX_SOURCE_MB` (default 100) at the bridge.
- A missing folder is `not_found` with `details.reason: 'folder_missing'`.
- Never name a particular platform in CT Studio code, docs or fixtures; use neutral names (`storage`, `folder`).
- Contract package version `0.11.0`; CLAUDE.md cross-language table, `docs/openapi.json`/`apps/bridge/openapi.json` (`npm run openapi`) and today's release note updated.

## Review Focus

- A sink that declares no `lanes` on an instance: deliveries to it go one at a time, not unlimited. → Task 4 test `an instance without lanes takes one delivery at a time`.
- A delivery left `waiting` (polling its sink job) still occupies its lane, but claiming it to poll is never blocked by the lane. → Task 4 test `a waiting delivery holds its lane and can always be polled`.
- File names with path tricks (`../x.pdf`, `a/b.pdf`, empty) are refused before any sink call. → Task 2 test `refuses names that are not one path segment`.
- A read of a file larger than the cap is refused with `content_rejected` (`details.reason: 'too_large'`) without buffering it all. → Task 5 test `a read over the cap is refused while streaming`.
- A personal sink called without `actingUser`, or for a user with no connection, answers `connection_missing`, never another user's connection. → Task 5 test `a personal sink needs the acting user's own connection`.

---

### Task 1: `lanes` on describe instances

**Files:**
- Modify: `packages/bridge-contract/src/sink-api.ts` (instances schema, new `lanesOf`)
- Modify: `packages/bridge-contract/src/producer-api.ts:100-114` (`SinkViewSchema.instances`)
- Modify: `packages/shared/src/publish-targets.ts:312-359` (`SinkInfoSchema.instances`)
- Modify: `apps/bridge/src/routes/catalog.ts` (copies `lanes`; verify only)
- Test: `packages/bridge-contract/test/sink-api.test.ts` (create if absent; else the existing describe test file)

**Interfaces:**
- Produces: `InstanceSchema = z.strictObject({ id: z.string(), label: z.string(), lanes: z.number().int().min(1).max(64).optional() })`; `lanesOf(d: Pick<SinkDescribe,'instances'>, instanceId: string): number` (1 when absent or instance unknown); `MAX_LANES = 64`.

- [ ] **Step 1: Write failing tests**: `describe-v2.json` with `instances: [{id:'t1',label:'T',lanes:10}]` parses; `lanes: 0` and `lanes: 65` fail; `lanesOf(d,'t1') === 10`, `lanesOf(d,'other') === 1`, `lanesOf` of an instance without lanes `=== 1`; `SinkViewSchema` and `SinkInfoSchema` keep `lanes`.
- [ ] **Step 2: Run** `npx vitest run packages/bridge-contract/test/sink-api.test.ts` — FAIL (`lanes` unknown key / `lanesOf` not exported).
- [ ] **Step 3: Implement** `InstanceSchema`, use it in `SinkDescribeSchema` and `SinkViewSchema`, add `lanes` to `SinkInfoSchema` instances, export `lanesOf`/`MAX_LANES` from `src/index.ts`.
- [ ] **Step 4: Run** the test and `npx vitest run --project bridge-contract` — PASS.
- [ ] **Step 5: Commit** `feat(bridge-contract): sinks declare lanes per instance`

### Task 2: Contract version 4 and the `watchedFolders` capability

**Files:**
- Create: `packages/bridge-contract/src/sources.ts`
- Modify: `packages/bridge-contract/src/sink-api.ts` (`DescribeContractVersion` adds 4, `CapabilitiesSchema.watchedFolders`, superRefine gate, `watchedFoldersOf`)
- Modify: `packages/bridge-contract/src/index.ts`, `package.json` (`0.11.0`)
- Create fixtures: `packages/bridge-contract/test/fixtures/describe-v4.json`, `source-list.json`, `source-move.json`, `source-put.json`
- Test: `packages/bridge-contract/test/sources.test.ts`

**Interfaces:**
- Produces (`sources.ts`):
  - `SOURCE_FOLDERS = ['', 'processing', 'delivered', 'failed'] as const`; `SourceFolder`.
  - `SourceNameSchema` (one segment per Global Constraints); `sourceNameProblem(name: string): string | null`.
  - `WatchedFoldersSchema = z.strictObject({ sourceFields: z.array(DestinationFieldSchema).min(1) })`.
  - `SourceFileSchema = z.strictObject({ name: SourceNameSchema, size: z.number().int().nonnegative(), modifiedAt: z.string().datetime(), etag: z.string().nullable() })`.
  - Sink-side request bodies (all strict, all carry `instanceId: string`, `credential: CredentialSchema` as deliveries do, `source: z.record(z.string(), z.string())`, `actingUser: ActingUserSchema.nullable()`): `SourceListRequestSchema` (+ `folder`), `SourceReadRequestSchema` (+ `folder`, `name`), `SourceMoveRequestSchema` (+ `from: {folder,name}`, `to: {folder,name}`), `SourcePutRequestSchema` (+ `folder`, `name`, `content: z.string().max(65536)`).
  - `SourceListAnswerSchema = z.strictObject({ files: z.array(SourceFileSchema) })`.
  - `SOURCE_PATHS = { list: '/sources::list', read: '/sources::read', move: '/sources::move', put: '/sources::put' } as const`.
  - Producer-side bodies (bridge `/v1/targets/:id/sources::…`): the same without `instanceId`/`credential` (the bridge fills them), e.g. `ProducerSourceListSchema`.
- Produces (`sink-api.ts`): `watchedFoldersOf(d): WatchedFolders | null` (only when `contractVersion >= 4`); `packageVersionFor(4) === 2`; `BrowseRequestSchema` (`sink-api.ts:117`) and `TargetBrowseRequestSchema` (`producer-api.ts:160`) gain `scope: z.enum(['destination','source']).optional()` (absent = `destination`), so a source field with `browse: true` is browsed like a destination field. The bridge's `/v1/targets::browse` passes `scope` through, and the fake document sink (Task 5) browses its `folder` source field.

- [ ] **Step 1: Write failing tests**:
  - `describe-v4.json` (fake document sink shape, `contractVersion: 4`, `watchedFolders.sourceFields` = one `folder` field with `browse: true`) parses; the same capability with `contractVersion: 3` fails with `watchedFolders needs contractVersion 4`.
  - `watchedFoldersOf` returns the capability for v4, null for v3.
  - `packageVersionFor(4) === 2`.
  - `test('refuses names that are not one path segment')`: `sourceNameProblem` is non-null for `''`, `'.'`, `'..'`, `'a/b.pdf'`, `'a\\b.pdf'`, `'x\u0000.pdf'`, a 256-char name; null for `'Report 1.docx'`.
  - Each `source-*.json` fixture parses with its schema and re-serialises unchanged.
- [ ] **Step 2: Run** `npx vitest run packages/bridge-contract/test/sources.test.ts` — FAIL.
- [ ] **Step 3: Implement** `sources.ts` and the `sink-api.ts` changes; bump `package.json` to `0.11.0`.
- [ ] **Step 4: Run** `npx vitest run --project bridge-contract` — PASS.
- [ ] **Step 5: Commit** `feat(bridge-contract): contract version 4 with watched folders`

### Task 3: Conformance suite for watched folders

**Files:**
- Create: `packages/bridge-contract/src/conformance/watched-folders.ts`
- Modify: `packages/bridge-contract/src/conformance/suite.ts:311-324` (wire in like administration), `cli.ts:20-24` (env `SINK_SOURCE_FIELDS`, JSON object)
- Create: `packages/bridge-contract/test/sources-fake.ts` (a `fetch` fake like `admin-fake.ts`, with `faults`)
- Test: `packages/bridge-contract/test/watched-folders-suite.test.ts`

**Interfaces:**
- Produces: `WATCH_CHECKS` (const map: `list root`, `put text`, `move into processing`, `move is idempotent`, `read moved file`, `list after move`, `missing folder`), `watchedFoldersSuite(opts: { url: string; key: string; instanceId: string; credential: Credential; source: Record<string,string>; fetchImpl?: typeof fetch }): Promise<Array<{name: string; ok: boolean; detail?: string}>>`. Without the capability every check is `ok: true, detail: 'skipped: …'` (as `skipAll`). The suite puts a file named `ct-conformance-<uuid>.txt` in the root, moves it to `processing`, repeats the move, reads it, and moves it back out to `failed` (it never deletes).

- [ ] **Step 1: Write failing tests**: against `sources-fake.ts`, all checks pass; with fault `move-not-idempotent` the `move is idempotent` check fails naming the error; with fault `missing-folder-wrong-code` `missing folder` fails; a v3 describe skips all.
- [ ] **Step 2: Run** `npx vitest run packages/bridge-contract/test/watched-folders-suite.test.ts` — FAIL.
- [ ] **Step 3: Implement** the suite (same `attempt`/`call` structure as `administration.ts:55-104`), wire into `conformanceSuite` via `opts.watchedFolders`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(bridge-contract): conformance checks for watched folders`

### Task 4: The bridge enforces lanes

**Files:**
- Modify: `apps/bridge/src/deliveries/repo.ts:74-82` (`claim` signature), `MemoryDeliveryRepo` (`repo.ts:162`)
- Modify: `apps/bridge/src/deliveries/pg.ts:134-151`
- Modify: `apps/bridge/src/deliveries/runner.ts` (`runOnce` passes lane limits), `apps/bridge/src/server.ts:65-69` (N loops), config (`BRIDGE_DELIVERY_RUNNERS`, default 4, 1-32)
- Test: `apps/bridge/test/lanes.test.ts` (memory repo), `apps/bridge/test/integration/lanes-pg.test.ts` (skips without `IH_TEST_DATABASE_URL`)

**Interfaces:**
- Consumes: `lanesOf` (Task 1).
- Produces: `type LaneLimits = (sinkId: string, instanceId: string | null) => number | null` (null = unlimited); `DeliveryRepo.claim(now: Date, leaseSeconds: number, lanes: LaneLimits): Promise<ClaimedRow | null>`; `laneLimitsOf(registry: SinkRegistry): LaneLimits` in `runner.ts` (built-in sinks → null, an external sink not described yet → 1, else `lanesOf`).

Pg claim: inside one transaction, `pg_advisory_xact_lock(hashtext('bridge:lanes'))`, then pick the oldest due row as today, joined to `bridge.targets` for `(sink_id, instance_id)`, skipping a `queued` row whose tenant already has `>= limit` deliveries in `running` or `waiting` (another row than itself). `waiting` rows and expired `running` leases are claimable regardless. The limits are passed as one `jsonb` parameter `{"<sink>\u0000<instance>": n}` for the tenants that have due rows (read with a first query), unlimited sinks omitted. The memory repo applies the same rule.

- [ ] **Step 1: Write failing tests** (memory repo, then the Pg twin with the same table):
  - `an instance without lanes takes one delivery at a time`: two queued deliveries to one tenant, limit 1: first claim returns one, second returns null until the first transitions to `succeeded`.
  - `lanes 10 lets ten run`: twelve queued, limit 10 → ten claims, then null.
  - `tenants do not block each other`: tenant A full, a due row for tenant B is claimed.
  - `a waiting delivery holds its lane and can always be polled`: limit 1, one `waiting` with `run_after <= now`, one `queued`: claim returns the waiting one; the queued one is not claimed while the waiting one is `running` or `waiting`.
  - `built-in sinks are never limited`: three queued `s3` deliveries to one tenant all claimable.
  - Pg only: `two runners never exceed the lane`: 20 parallel `claim` calls on limit 2 claim exactly 2.
- [ ] **Step 2: Run** `npx vitest run apps/bridge/test/lanes.test.ts` — FAIL.
- [ ] **Step 3: Implement** the claim, `laneLimitsOf`, and start `BRIDGE_DELIVERY_RUNNERS` runner loops in `server.ts`; update `runner.test.ts` call sites.
- [ ] **Step 4: Run** `npx vitest run --project bridge` and the Pg test with `IH_TEST_DATABASE_URL` — PASS.
- [ ] **Step 5: Commit** `feat(bridge): deliveries respect each tenant's lanes`

### Task 5: Sinks and the bridge relay for watched folders

**Files:**
- Modify: `apps/bridge/src/sinks/port.ts:28` (optional `sources?: SourcePort`)
- Modify: `apps/bridge/src/sinks/http.ts` (`HttpSink.sources`; a byte-reading call for `read`)
- Modify: `apps/bridge/src/sinks/fake-documents.ts` (in-memory folders, v4 describe with `lanes`), `apps/bridge/src/sinks/serve.ts:49-59` (serve the four routes), `apps/bridge/src/sinks/fake-server.ts` (unsigned `/_drop` `{name, content(base64)}` and `/_folder?f=` for tests)
- Create: `apps/bridge/src/routes/sources.ts`; register beside `routes/targets.ts`
- Modify: config (`BRIDGE_MAX_SOURCE_MB`, default 100)
- Test: `apps/bridge/test/sources.test.ts`, extend `apps/bridge/test/conformance-fake.test.ts`

**Interfaces:**
- Consumes: Task 2 schemas.
- Produces:
  - `interface SourcePort { list(r: SourceListRequest): Promise<SourceFile[]>; read(r: SourceReadRequest, maxBytes: number): Promise<Buffer>; move(r: SourceMoveRequest): Promise<void>; put(r: SourcePutRequest): Promise<void> }`.
  - Bridge routes (signed by the producer, as `objects::read`): `POST /v1/targets/:id/sources::list` → `200 {files}`; `::read` → `200 application/octet-stream`; `::move` → `204`; `::put` → `204`. Body = Task 2 producer schemas. The route resolves the target's sink and instance; credential from the target's shared connection, or, for a personal sink, `connections.findPersonal(actingUser.id, sinkId, instanceId)` then `credentials.resolve` (as `runner.ts:83-105`); refuses `405 unsupported_part` when `watchedFoldersOf(describe)` is null; maps `SinkError` with the same status table as `objects::read`.
  - `effectiveDescribe` keeps `watchedFolders` as the sink declared it.

- [ ] **Step 1: Write failing tests** (bridge app with the fake document sink over HTTP, as `test/conversion-bridge.ts` does):
  - list an empty root → `[]`; `/_drop` two files → list shows both with sizes.
  - move root → `processing`, list both folders; repeat the move → 204.
  - read a moved file → its bytes.
  - put `failed/x.pdf.md` → listed in `failed` with the text's size.
  - `a read over the cap is refused while streaming`: `BRIDGE_MAX_SOURCE_MB` set to 1 MB for the test, a 2 MB file → 422 `content_rejected` with `details.reason: 'too_large'`.
  - `a personal sink needs the acting user's own connection`: personal fake, no `actingUser` → 409 `connection_missing`; user B's request never uses user A's connection.
  - a v3 sink → 405 `unsupported_part`.
  - a missing source folder → 404 `not_found` with `folder_missing`.
  - `conformance-fake.test.ts`: `watchedFoldersSuite` all ok against the fake document sink.
- [ ] **Step 2: Run** `npx vitest run apps/bridge/test/sources.test.ts` — FAIL.
- [ ] **Step 3: Implement** the port, `HttpSink.sources` (JSON for list; bytes for read, counting streamed bytes against `maxBytes` like `read()` at `http.ts:171-192`), the fake's folders, `serveSink` routes, and `routes/sources.ts` with OpenAPI `schema` blocks.
- [ ] **Step 4: Run** `npx vitest run --project bridge` and `npm run openapi` — PASS, OpenAPI regenerated.
- [ ] **Step 5: Commit** `feat(bridge): relay watched-folder operations to sinks`

### Task 6: The worker's bridge client

**Files:**
- Modify: `worker/src/ingest_worker/bridge/models.py` (`SourceFile`, `SourceListAnswer`, producer bodies)
- Modify: `worker/src/ingest_worker/bridge/client.py` (`BridgeClient` protocol + `HttpBridgeClient`)
- Modify: `worker/tests/fakes.py` (`FakeBridge` gains an in-memory source store)
- Test: `worker/tests/test_bridge_models.py` (add `source-list.json`, `source-move.json`, `source-put.json` to the reserialise parametrisation), `worker/tests/test_bridge_client.py`

**Interfaces:**
- Produces:
  - `list_source(target_id: str, source: dict[str, str], folder: str, acting_user: ActingUser | None) -> list[SourceFile]`
  - `read_source(target_id: str, source: dict[str, str], folder: str, name: str, acting_user: ActingUser | None) -> bytes`
  - `move_source(target_id: str, source: dict[str, str], src: tuple[str, str], dst: tuple[str, str], acting_user: ActingUser | None) -> None`
  - `put_source_text(target_id: str, source: dict[str, str], folder: str, name: str, content: str, acting_user: ActingUser | None) -> None`
  - Errors as today (`_raise_for`): 4xx `needs_user` → `BridgeRefused` (incl. `folder_missing`, `connection_missing`, `too_large`), anything else → `BridgeUnavailable`.
  - `FakeBridge.sources: dict[tuple[str, str], bytes]` keyed `(folder, name)`, with `fail_next: dict[str, Exception]` per operation.

- [ ] **Step 1: Write failing tests**: the three fixtures re-serialise unchanged; with an httpx `MockTransport`, each method sends the signed path `/v1/targets/<id>/sources::<op>` and body (assert exact JSON), `read_source` returns the bytes, a 404 `folder_missing` raises `BridgeRefused`, a 503 raises `BridgeUnavailable`.
- [ ] **Step 2: Run** `cd worker && uv run pytest tests/test_bridge_client.py tests/test_bridge_models.py -k source` — FAIL.
- [ ] **Step 3: Implement** models, client methods (bytes for `read_source`) and the fake.
- [ ] **Step 4: Run** `npm run worker:test` and `npm run worker:lint` — PASS.
- [ ] **Step 5: Commit** `feat(worker): bridge client for watched folders`

### Task 7: Docs and check

**Files:**
- Modify: `CLAUDE.md` (cross-language table: a row *Watched folders (contract 0.11.0)* naming `sources.ts`, `watchedFoldersOf`, `lanesOf`, the bridge routes, the worker client methods; Delivery bridge rule: lanes in the claim and `BRIDGE_DELIVERY_RUNNERS`)
- Modify/Create: `docs/release-notes/Release-Notes-20261029.html` (Other updates entry; *Watch out for*: contract 0.11.0, `BRIDGE_DELIVERY_RUNNERS`, `BRIDGE_MAX_SOURCE_MB`, external sinks without `lanes` now get one delivery at a time per instance)
- Modify: `deploy/.env.example` (the two new variables)

- [ ] **Step 1:** Make the edits.
- [ ] **Step 2: Run** `npm run check` — PASS.
- [ ] **Step 3: Commit** `docs: watched folders contract and bridge lanes`
