# Delivery bridge: one target registry (merge before phase 6) — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bridge's targets are the one registry: what a target is (sink, instance,
connection, destination, label) lives on the bridge, and CT Studio keeps only a cache of it beside
the facts that are CT Studio's own. Phase 6 can then add sinks whose destinations CT Studio has
never heard of.

**Architecture:**

- **The bridge is the registry of record.** `bridge.targets` holds every target as it does
  today. It now refuses destination fields its sink doesn't declare.
- **CT Studio's `publish_targets` becomes a cache with the bridge's shape**:
  - `sink_id`, `instance_id`, `connection_id`, a `destination` jsonb and the label, as the bridge
    last answered;
  - plus the facts only CT Studio has: `kind`, `source`, `seeded_at`, `edited_at`, `updated_by`,
    `created_at`, `inert_at`, and the new `on_bridge` and `synced_at`;
  - the S3-shaped columns go. Readers that need an S3 place get it from `s3PlaceOf(target)`.
- **The sync runs the other way.** The API used to mirror CT Studio to the bridge; now it *pulls*
  the bridge into the cache:
  - at start and after a restore (`pullTargets`, `GET /v1/targets`);
  - on every write, by caching the bridge's own answer to the `PUT`.
- **CT Studio stays the gatekeeper for writes.** Admins still edit on Published outputs. The API
  still checks usage and locking against CT Studio's tables, because only they know recipes,
  outputs and read-key grants. It then writes to the bridge, and caches only what the bridge
  accepted.
- **The worker reads the cache**, as today. It stops seeding targets, and it refuses to deliver to
  a target the cache hasn't synced yet.

**Tech stack:** as in phase 4. No new dependency.

**Spec:** [docs/superpowers/specs/2026-10-19-delivery-bridge-design.md](../specs/2026-10-19-delivery-bridge-design.md):
- the Intent ("the bridge owns … targets");
- "Targets" ("This now lists bridge targets", locking);
- "Sink registry";
- the phase 6 row;
- "Phase 2 as built" and "Phase 4 as built" (the registries merge in their own plan, after
  phase 4, before phase 6).

**Builds on:** [ADR 0017](../../adr/0017-delivery-bridge.md) (its "Two target registries" note);
the [phase 4 plan](2026-10-21-delivery-bridge-4-several-targets.md); ADR 0008 (read keys);
ADR 0015 (backup and restore).

## Global constraints

- Everything in phase 4's global constraints still applies:
  - TDD, red first;
  - `npm run check` is the one gate;
  - tests stay offline;
  - one contract on both sides, with shared fixtures;
  - no vendor names of private external sinks.
- **Nothing moves for a deployment that upgrades.**
  - Target ids, labels, buckets, prefixes, layouts, connections and object keys stay the same.
  - Every recorded output, delivery and read-key grant stays valid.
  - Results, downloads and withdrawal behave the same.
- **No secret reaches CT Studio**, as today.
- **The five foreign keys to `publish_targets(id)` stay**, so a recorded id always names a cached
  target:
  - `job_outputs`;
  - `job_deliveries`;
  - `published_graphs`;
  - `published_graph_versions`;
  - `s3_consumer_targets`.
- **Upgrading from before phase 2 still works.** An old row's keys still move to a bridge
  connection once, and so do the keys in a restored backup from before phase 2.

## Decisions this plan makes (recorded in the spec and ADR 0017 by Task 8)

- **CT Studio keeps a cache table, not none.** The FKs and the in-use guard (`23503` in `remove`)
  need a local row. The table keeps its name, so no FK, query or backup rule is renamed.
- **The cache's shape** (migration `202610220900_targets_on_bridge.sql`):
  - **Added:** `sink_id text NOT NULL`, `instance_id text`, `destination jsonb NOT NULL DEFAULT '{}'`,
    `on_bridge boolean NOT NULL DEFAULT true` and `synced_at timestamptz`.
  - **Backfilled** from today's columns, exactly as `destinationOf`/`mirrorOf` sent them:
    - S3 rows: `{bucket, prefix, sse, kmsKeyId, storageClass, layout}`, blanks as `''`;
    - rdf rows: `{dataset: bucket}`.
    - `synced_at` is set to now, because the bridge already holds what the mirror sent.
  - **Dropped:** `bucket`, `prefix`, `sse`, `kms_key_id`, `storage_class`, `layout`, `endpoint`,
    `region`, the key columns, `force_path_style` and `moved_to_bridge_at`, after the legacy keys
    move out (next point).
  - **`kind` stays** as CT Studio's own classification, set by the cache writer: `rdf` for sink
    `rdf`; `internal` for sink `s3` on connection `internal`; `external` for other `s3` targets;
    and a new `sink` for any other sink (phase 6).
- **Legacy keys get a side table, `publish_target_legacy_keys`.** It holds `id`, `endpoint`,
  `region`, `access_key_id`, `secret_key_enc`, `access_key_env`, `secret_key_env`,
  `force_path_style` and `moved_to_bridge_at`.
  - The migration fills it from the rows `moveTargetsToBridge` had not moved yet, plus the env-keyed
    `default`.
  - `moveTargetsToBridge` reads it, and deletes a row once moved.
  - An old backup restored here runs the migrations, so its keys land there too.
- **The triple store's endpoint and writer user** were `publish_targets.endpoint` and
  `access_key_id`. They now live in the bridge connection `rdf-default` (the bridge has held them
  since phase 3). The Published outputs row shows the endpoint from that connection's summary.
  `rdfSeedDiffers` compares the seed with the connection.
- **Writes go to the bridge first.**
  - Create and patch: the API checks the body and the locks, then `PUT /v1/targets/:id`, then
    caches the `TargetView` the bridge answered. A refusal stores nothing.
  - Delete: the usage check, then `DELETE` on the bridge, then the cache row (as today).
  - If the cache write fails after the bridge accepted, the next pull heals it. The response says
    so (`500 saved on the bridge; refresh`). This replaces today's roll-back of the row.
- **`pullTargets(deps): Promise<{ cached: number; missing: string[] }>`** replaces `mirrorTargets`
  and `syncTargetsWithBridge`. It runs at start, retrying until the bridge answers, and after every
  restore.
  - It upserts every bridge target into the cache and sets `on_bridge = true` and `synced_at`.
  - It never touches `inert_at`, `source`, `seeded_at`, `edited_at` or `updated_by`.
  - A live cached row the bridge no longer lists gets `on_bridge = false` and is logged. It is never
    deleted (the FKs). Published outputs tags it "Not on the bridge", and a delivery to it fails
    `target_missing` on the bridge as today.
- **Seeding moves to the API alone.**
  - `seedDefault` and `seedRdf` write to the bridge only when the bridge has no such target, or
    CT Studio's `seeded_at` is null. They then cache it.
  - The worker no longer seeds: `seed_default_target` and `seed_rdf_target` go, as does the seeding
    in `admin.py`.
  - `LiveTargets.get` raises `TargetNotSynced` (retryable, not a `DocumentError`) for a row whose
    `synced_at` is null. A worker that starts before the API never records keys under an unseeded
    prefix.
- **The bridge refuses destination fields its sink doesn't declare**: 422 `content_rejected`,
  "`<field>` is not a destination field of `<sink>`". Overrides stay unchecked; they are phase 6.
- **Locking stays in CT Studio.** Only CT Studio's signed client writes the bridge's target routes.
  The bridge needs no usage model.
- **The copy restore writes the bridge's rows too.**
  - `replaceTargets` upserts this server's kept targets into `bridge.targets` (sink, instance,
    connection, destination, label) as well as into the cache.
  - A dropped external target keeps its bridge row (the bridge's deliveries reference it) and its
    CT row is marked inert, as today.
  - Then `pullTargets` runs.

## Review focus

1. **Upgrading a deployment** that has S3, archive and triple-store targets. Every cached
   destination must equal what the mirror last sent, the next publish must land at the same keys,
   and the upgrade must PUT nothing to the bridge. *Test: Task 2, "the backfilled destination is
   what destinationOf sent", for each kind and layout.*
2. **A fresh deploy where the worker starts before the API has seeded `default`.** The job must
   wait and retry, never record keys under the migration's placeholder prefix. *Test: Task 5, "a
   target not synced yet is retried, not delivered".*
3. **The bridge is down when the API starts.** Published outputs still lists the cached targets
   with their labels. Every target write answers 502 and changes nothing. *Test: Task 4, "with
   the bridge down, the list is the cache and writes change nothing".*
4. **Restoring a backup from before this migration**, including one from before phase 2. The
   targets must come back with their destinations, and the old keys must move to connections
   once. *Test: Task 6, "a restored pre-merge backup's targets come back and its keys move once"
   (opt-in Pg).*
5. **Changing a locked field of a target in use.** The answer must still be 409, and nothing may
   reach the bridge. *Test: Task 4, "a locked change is refused before the bridge is asked".*

---

### Task 1: Bridge — refuse undeclared destination fields; the API can list targets

**Files:**
- Modify: `apps/bridge/src/routes/targets.ts:52-75` (`checkTarget`)
- Modify: `apps/api/src/bridge/client.ts` (`BridgeApi.listTargets`, `HttpBridgeApi`, the CT-local
  `TargetMirror` type → the contract's `TargetView` and `TargetPutRequest`)
- Modify: `apps/api/test/fake-bridge.ts` (`listTargets`, refusing undeclared fields as the bridge
  does)
- Test: `apps/bridge/test/targets-routes.test.ts`; Create: `apps/api/test/bridge-client.test.ts`
  (`HttpBridgeApi` over a recording `fetch`)

**Interfaces:**
- Produces: `BridgeApi.listTargets(): Promise<TargetView[]>` (`GET /v1/targets`, signed);
  `putTarget(id, TargetPutRequest): Promise<TargetView>`, which now returns the bridge's answer.

- [ ] **Step 1: Write the failing tests.**
  - Bridge: "an undeclared destination field is refused, naming it". `destination: { bucket: 'b',
    colour: 'red' }` gives 422 `content_rejected` with "colour is not a destination field of s3".
  - Bridge: "every declared field is accepted" (the S3 six, the RDF `dataset`).
  - API: "listTargets reads GET /v1/targets, signed".
  - API: "putTarget returns the bridge's view".
- [ ] **Step 2: Run them.** `npm test -w apps/bridge -- targets-routes` and `npm test -w apps/api
  -- bridge-client`. Expected: FAIL.
- [ ] **Step 3: Implement.** `checkTarget` compares `Object.keys(t.destination)` with
  `described.destinationFields` ids.
- [ ] **Step 4: Run them again,** plus `npx vitest run --root apps/bridge conformance-fake`.
  Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "bridge: refuse undeclared destination fields; api lists targets"`

### Task 2: Migration — the cache's shape, the backfill, the legacy keys table

**Files:**
- Create: `db/migrations/202610220900_targets_on_bridge.sql`
- Create: `packages/shared/test/fixtures/target-destinations.json`. Cases are target rows in
  today's columns (internal, external with KMS and a storage class, archive, rdf), each with the
  destination it backfills to.
- Test: `apps/api/test/integration/targets-on-bridge-pg.test.ts` (opt-in), and
  `apps/api/test/bridge-mirror.test.ts` (fixture equality with today's `destinationOf`, run before
  that function is deleted in Task 3)

**Interfaces:**
- Produces: the columns and side table in Decisions. `kind` gains `sink`. A SQL function
  `target_s3_place(destination jsonb, sink_id text) RETURNS TABLE(bucket text, prefix text, layout
  text)` gives SQL readers one place to read an S3 target from.

- [ ] **Step 1: Write the failing tests.**
  - "the backfilled destination is what destinationOf sent" (Review focus 1). For each fixture
    case, today's `destinationOf`/`mirrorOf` equals the fixture's destination (TS), and the
    migrated row equals it (Pg).
  - Pg: "an unmoved external row's keys land in publish_target_legacy_keys, and the S3 columns are
    gone".
  - Pg: "the five foreign keys still hold after the migration".
- [ ] **Step 2: Run them.** `npm test -w apps/api -- bridge-mirror`, and the opt-in Pg test on a
  throwaway database. Expected: the Pg test FAILS (no migration yet); the TS fixture test PASSES,
  pinning today's mapping.
- [ ] **Step 3: Write the migration.** In one transaction:
  1. add the new columns;
  2. backfill;
  3. fill the legacy table;
  4. create `target_s3_place`;
  5. drop the old columns;
  6. replace `publish_targets_layout_check` with a check on `destination->>'layout'`.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "db: publish_targets becomes the bridge registry's cache"`

### Task 3: API — the cache repo and `s3PlaceOf`; pull, not mirror; seeding through the bridge

**Files:**
- Modify: `packages/shared/src/publish-targets.ts`. `PublishTargetViewSchema` gains `sinkId`,
  `destination` and `onBridge`. Its `bucket`, `prefix`, `sse`, `kmsKeyId`, `storageClass` and
  `layout` stay, derived for S3 targets (null for others), so the web changes little.
- Create: `apps/api/src/publish-targets/place.ts` (`s3PlaceOf`, `kindOf`)
- Modify: `apps/api/src/publish-targets/{repo.ts,pg.ts,seed.ts}`
- Modify: `apps/api/src/bridge/mirror.ts`. It becomes `sync.ts`: `pullTargets`,
  `moveTargetsToBridge` over the legacy table, and `ensureRdfConnection`. `mirrorTargets`,
  `syncTargetsWithBridge`, `destinationOf` and `mirrorOf` are deleted.
- Modify: `apps/api/src/server.ts:85-91,243,272,304`
- Test: `apps/api/test/publish-targets-contract.ts` (and its memory and Pg runs),
  `apps/api/test/bridge-sync.test.ts` (renamed from `bridge-mirror.test.ts`),
  `apps/api/test/publish-targets-seed.test.ts`

**Interfaces:**
- Consumes: `BridgeApi.listTargets`/`putTarget` (Task 1); the cache's columns (Task 2).
- Produces:
  - `s3PlaceOf(t: Pick<TargetRecord, 'sinkId' | 'destination'>): { bucket: string; prefix: string; layout: TargetLayout } | null`;
  - `kindOf(view: TargetView): PublishTargetKind`;
  - `PublishTargetRepo.cache(view: TargetView, facts: { source?, seededAt?, by? }): Promise<TargetRecord>`;
  - `markMissing(ids: string[])`;
  - `pullTargets(deps: { targets: PublishTargetRepo; bridge: BridgeApi; log }): Promise<{ cached: number; missing: string[] }>`.

- [ ] **Step 1: Write the failing tests.**
  - "pull caches every bridge target and derives its kind" (internal, external, rdf, and an
    unknown sink as `sink`).
  - "pull never touches inert_at, source, seeded_at or edited_at".
  - "a cached target the bridge no longer lists is marked not on the bridge, never deleted".
  - "seedDefault writes to the bridge only when the bridge has no default or it was never
    seeded, then caches it".
  - "seedRdf compares the seed with the rdf-default connection".
  - "moveTargetsToBridge reads the legacy table and empties a moved row".
  - "s3PlaceOf is null for a non-S3 sink".
- [ ] **Step 2: Run them.** `npm test -w apps/api -- publish-targets bridge-sync`. Expected: FAIL.
- [ ] **Step 3: Implement.** Every reader of `bucket`, `prefix` or `layout` takes `s3PlaceOf`:
  - `stores.ensureBucket`;
  - `ownBucketProblem`;
  - `primaryTargetOf`;
  - `s3keys/service.ts:209-216`;
  - `backup/create.ts:30-43`;
  - `routes/results.ts:165-171`.

  SQL readers use `target_s3_place`: `restore-pg.ts:125` and `copy-rules.ts:64,304`.
- [ ] **Step 4: Run them again,** plus `npm test -w apps/api`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "api: the target registry is the bridge's; publish_targets caches it"`

### Task 4: API — target routes write to the bridge first

**Files:**
- Modify: `apps/api/src/routes/publish-targets.ts` (create `:304-386`, patch `:410-502`, the
  triple store `:389-408`, delete `:504-564`, list `:240-263`)
- Modify: `apps/api/src/openapi/document.ts`, then `npm run openapi`
- Test: `apps/api/test/publish-targets-routes.test.ts`

**Interfaces:**
- Consumes: `cache`, `s3PlaceOf` (Task 3).

- [ ] **Step 1: Write the failing tests.**
  - "create PUTs to the bridge, then caches its answer; a refusal stores nothing".
  - "a locked change is refused before the bridge is asked" (Review focus 5): a 409, and no
    `putTarget` call on the fake.
  - "with the bridge down, the list is the cache and writes change nothing" (Review focus 3):
    list 200 from the cache, create and patch 502, the cache unchanged.
  - "a cache write that fails after the bridge accepted answers 500 saved on the bridge; refresh,
    and the next pull heals it".
  - "a target not on the bridge is listed with onBridge false".
- [ ] **Step 2: Run them.** `npm test -w apps/api -- publish-targets-routes`. Expected: FAIL.
- [ ] **Step 3: Implement.** The roll-back paths (`:372-382`, `:486-498`) go.
- [ ] **Step 4: Run them again,** plus `npm run openapi` and its document diff. Expected: PASS;
  the diff is the view's new fields.
- [ ] **Step 5: Commit.** `git commit -m "api: target writes go to the bridge first"`

### Task 5: Worker — read the cache's destination; stop seeding; wait for a sync

**Files:**
- Modify: `worker/src/ingest_worker/publish_targets.py` (`TargetRow`, `_COLUMNS`, `LiveTargets.get`
  and `rdf`; `PgPublishTargetStore` loses `seed_default`/`seed_rdf`; add `TargetNotSynced`)
- Modify: `worker/src/ingest_worker/main.py:384-387`, `worker/src/ingest_worker/admin.py:40-79`
- Modify: `worker/tests/fakes.py:762-830` (`MemoryPublishTargetStore` rows in the new shape)
- Test: `worker/tests/test_publish_targets.py`, `worker/tests/test_template_pipeline.py`,
  `worker/tests/test_admin.py`

**Interfaces:**
- Produces: `TargetRow(id, label, kind, sink_id, destination: dict[str, str], inert, synced_at)`;
  `Target` is unchanged (`id, bucket, prefix, layout`). `LiveTargets.get` builds it from the S3
  place, and raises `TargetMissing` for a non-S3 sink (phase 6 records receipts, not keys).
  `TargetNotSynced(Exception)`, retried by the job queue like `BridgeUnavailable`.

- [ ] **Step 1: Write the failing tests.**
  - "a target not synced yet is retried, not delivered" (Review focus 2): the job is retried, no
    package is submitted, and no output is recorded.
  - "get builds the S3 place from the destination; rdf() reads the dataset".
  - "the worker seeds nothing" (`main` builds `LiveTargets` without a seed call).
  - "init-buckets lists internal targets' buckets from their destinations".
- [ ] **Step 2: Run them.** `cd worker && uv run pytest tests/test_publish_targets.py
  tests/test_template_pipeline.py tests/test_admin.py`. Expected: FAIL.
- [ ] **Step 3: Implement.** The shared fixture `publish-targets.json` loses its seed cases on
  the worker side; the API keeps them.
- [ ] **Step 4: Run them again,** plus the whole worker suite and the equivalence goldens.
  Expected: PASS, goldens unchanged.
- [ ] **Step 5: Commit.** `git commit -m "worker: targets from the bridge registry's cache"`

### Task 6: Backup and restore — the bridge's rows are restored too

**Files:**
- Modify: `apps/api/src/backup/copy-rules.ts:56-70,154-260,300-308`
- Modify: `apps/api/src/backup/restore-pg.ts:120-129`
- Modify: `apps/api/src/bridge/sync.ts` (`resyncAfterRestore` → `pullTargets`)
- Test: `apps/api/test/integration/backup-copy-rules.test.ts`,
  `apps/api/test/integration/backup-roundtrip.test.ts`

**Interfaces:**
- Consumes: `pullTargets` (Task 3), `target_s3_place` (Task 2).

- [ ] **Step 1: Write the failing tests** (opt-in Pg).
  - "a copy restore writes the kept targets into bridge.targets and the cache".
  - "a dropped external target keeps its bridge row and is inert here".
  - "a restored pre-merge backup's targets come back and its keys move once" (Review focus 4).
    Restore a dump made at the previous migration, holding an external row not moved yet. Expect
    the targets on the bridge with their destinations, one connection `target-<id>`, and the
    legacy row gone.
- [ ] **Step 2: Run them.** `cd apps/api && IH_TEST_DATABASE_URL=<throwaway> npx vitest run --config
  vitest.integration.config.ts --no-file-parallelism test/integration/backup-copy-rules.test.ts
  test/integration/backup-roundtrip.test.ts`. One file at a time: the integration files share
  one database. Expected: FAIL.
- [ ] **Step 3: Implement.** `replaceTargets` reads its column list from information_schema as
  today; the bridge upsert names its columns.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "backup: restore the bridge's targets with CT Studio's"`

### Task 7: Web — Published outputs shows the bridge's targets

**Files:**
- Modify: `apps/web/src/access/TargetRow.tsx`, `apps/web/src/access/PublishedOutputsPage.tsx`
- Modify: `apps/web/src/help/PublishedOutputsHelp.tsx`
- Test: `apps/web/test/PublishedOutputsPage.test.tsx`

**Interfaces:**
- Consumes: the view's `sinkId`, `destination` and `onBridge` (Task 3).

- [ ] **Step 1: Write the failing tests.**
  - "a target not on the bridge is tagged and its fields are read-only".
  - "a target of a sink this page doesn't edit shows its destination read-only" (`kind: 'sink'`,
    ready for phase 6).
  - "the triple store's endpoint comes from its connection".
- [ ] **Step 2: Run them.** `npm test -w apps/web -- PublishedOutputsPage`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "web: Published outputs lists the bridge's targets"`

### Task 8: Deploy, smoke and docs

**Files:**
- Modify: `deploy/scripts/smoke-test.sh` (the bridge section: after the publish, check that
  `GET /api/publish-targets` lists `default` with `onBridge: true` and the destination the bridge
  holds)
- Modify: the spec: a "Target registry as built" section with this plan's decisions; the
  Targets section's "This now lists bridge targets" is now true.
- Modify: `docs/adr/0017-delivery-bridge.md`. The "Two target registries" consequence is replaced:
  the bridge is the registry, and CT Studio caches it with its own facts.
- Modify: `CLAUDE.md` (the Publishing targets contract row and bullet), `docs/architecture.md`
  (the bridge row), `deploy/README.md` (the worker no longer seeds targets)
- Create: release notes in `docs/release-notes/`

- [ ] **Step 1: Write the smoke check first, and run it against a stack at main's tip.** Use a
  separate project, never the live stack. Expected: FAIL (the view has no `onBridge`).
- [ ] **Step 2: Upgrade check** (Review focus 1).
  1. Deploy main's tip, with `SMOKE_ARCHIVE=1` and the `rdf` profile.
  2. Publish one job.
  3. Deploy this branch over the same volumes.
  4. Expected:
     - smoke all ok;
     - every target's destination unchanged on the bridge (compare `bridge.targets` before and
       after);
     - the job's Results unchanged;
     - no `PUT /v1/targets` in the bridge's log during the upgrade start.
- [ ] **Step 3: Fresh deploy.** Start the worker before the API (`compose up -d worker`, then the
  rest) and run the smoke. Expected: all ok; the worker's log shows one retried job at most.
- [ ] **Step 4: Write the docs,** then run `npm run format:check` and the vendor-name search.
  Expected: clean.
- [ ] **Step 5: Commit.** `git commit -m "docs and smoke: one target registry"`

---

## Done when

- The bridge is the target registry, as the spec's Intent and Targets say:
  - every target CT Studio lists is the bridge's, cached;
  - a target PUT on the bridge alone appears in CT Studio after the next pull (Task 3's test);
  - CT Studio's table holds no sink-specific column.
- Upgrades, restores (including from before phase 2) and fresh deploys keep every key,
  destination, recorded output and grant (Tasks 2, 6, 8).
- `npm run check` is green, the opt-in Pg tests pass on a throwaway database, and the compose
  smoke passes on an upgrade and on a fresh deploy.
- The spec and ADR 0017 no longer speak of two registries.
