# Delivery bridge, phase 4: several targets per recipe — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A recipe delivers each approved document to several targets at once, an S3 archive
among them.

- An S3 archive keeps the whole package.
- The job shows each target's status.
- A partial failure ends the job as the spec's Delivering step 6 says.

**Architecture:**

- **Recipes.** `delivery.publishTo` takes one target id or a list of them. Everything reads it
  through one normaliser, `publishTargetsOf` in TypeScript and `publish_targets()` in Python,
  both pinned by one shared fixture. The editor writes a plain string while one target is
  picked, so recipes that don't change keep their `definitionSha256`.
- **The worker** already submits one package to a list of targets (`deliver_outputs`). It now
  passes the recipe's whole list. It records the published outputs **per target**, and marks one
  target **primary**: the first files-layout S3 target in the list. That target holds the graph's
  versioned copy and serves Results, the zip and read keys.
- **The bridge's S3 sink** gains a fixed destination field `layout`, `files` (today's keys) or
  `package`. A package-layout target writes the package as `package.json` plus its parts under
  one folder per idempotency key.
- **CT Studio still keeps `publish_targets`, mirrored** (phase 2). The row gains `layout`, and the
  mirror sends it. Merging the two registries is a separate plan, which runs straight after this
  one and before phase 6.
- **Job state** is judged on the **latest delivery per target**, so an earlier round's
  `needs_user` no longer sends a re-approved job back to review.

**Tech stack:** as in phase 3. No new dependency.

**Spec:** [docs/superpowers/specs/2026-10-19-delivery-bridge-design.md](../specs/2026-10-19-delivery-bridge-design.md):
the phase 4 row, "Recipes", "Targets" (locking), "The package" (archiving and replay),
"Delivering" (steps 6 and 7), "Idempotency, replace and skip", "Deleting jobs and retiring
types", and "Withdraw, republish and read-back".

**Builds on:**
- the [phase 3 plan](2026-10-19-delivery-bridge-3-rdf-behind-bridge.md) and the spec's "Phase 2
  as built" and "Phase 3 as built";
- [ADR 0017](../../adr/0017-delivery-bridge.md);
- the publishing targets design (locking, the recipe hash), and
  [ADR 0008](../../adr/0008-s3-read-keys.md) (read keys).

## Global constraints

- Everything in the earlier phases' global constraints still applies:
  - TDD, red first;
  - `npm run check` is the one gate;
  - tests stay offline;
  - the same contract on both sides, with shared fixtures;
  - no vendor names of private external sinks anywhere.
- **Nothing moves for a recipe that doesn't change.**
  - Its `definitionSha256` is the same, and so are its object keys, graph names and copy keys.
  - `publishTo` absent still means `["default"]`, plus `rdf-default` when the formats include
    `rdf`.
  - Equivalence goldens are not rewritten.
- **A files-layout target's keys don't move.** It writes `{prefix}{file.name}`, as today.
- **`rdf-default` stays implicit.** It is never listed in `publishTo` (phase 3), and validation
  refuses it there.
- **No CT Studio code knows a sink by name** beyond the built-in `s3` and `rdf`, as today.

## Decisions this plan makes (within "left to the builder"; recorded in the spec by Task 9)

- **The list's shape.**
  - `publishTo` is `TargetId | TargetId[]`.
  - A list holds 1 to 8 ids, with no duplicates.
  - A one-item list is valid, and means the same as the string. The editor still writes the
    string, so the hash doesn't move when a recipe is opened and saved.
  - Order is kept, and it matters only for choosing the primary target.
- **One primary target per job.**
  - It is the first target in the list whose layout is `files`.
  - Validation requires the list to hold at least one: Results, the zip, read keys and the
    graph's copy (`published_graphs.target_id`) all need one place to read from.
  - A list made only of archives is the issue "needs a target with the files layout".
- **`layout` is a column on `publish_targets`**, `text NOT NULL DEFAULT 'files'`, checked to be
  `files` or `package`.
  - It is a fixed field: it locks with the bucket and prefix.
  - Only S3 targets (`internal`, `external`) have one. RDF targets are always `files`, and the
    API refuses anything else.
  - The mirror sends it as the destination value `layout`.
- **The package layout's keys.** With `K` = the package's idempotency key:
  - `{prefix}packages/{K}/package.json` holds the package, with the bytes taken out. Each
    `files[i]` keeps its metadata, and its `content` becomes `path: "files/<name>"`. `data`
    becomes `{ path: "data.json" }`, and `rdf.turtle` becomes `path: "graph.ttl"`.
  - `{prefix}packages/{K}/files/<name>` holds each file's bytes.
  - `{prefix}packages/{K}/data.json` holds the `data` part, when there is one.
  - `{prefix}packages/{K}/graph.ttl` holds the `rdf` part's Turtle, when there is one.
  - The same key re-delivered overwrites the same objects, so S3 still declares `replace`.
  - `package.json` is written **last**, so a reader that finds it finds every part.
  - The contract gains `ArchivedPackageSchema` and `packageArchiveKeys(prefix, pkg)`.
    `packageArchiveKeys` is mirrored in Python as `package_archive_keys` and pinned by a shared
    fixture.
- **`job_outputs` records the published stage per target.**
  - The unique key becomes `(job_id, output_id, stage, target_id) NULLS NOT DISTINCT` (Postgres
    17), so review-stage rows keep their uniqueness.
  - A new column `is_primary boolean NOT NULL DEFAULT true` marks the primary target's rows.
    Results, the zip, read keys and backup read only `is_primary` rows.
  - A package-layout target's rows carry its archive keys, from `package_archive_keys`, with the
    output ids `package`, `data`, `graph` and each file's output id.
  - Withdraw deletes every target's rows, as today, by target.
- **Job status counts the latest delivery per target.**
  - It is the newest `job_deliveries` row for each `(job_id, target_id)`, by `created_at`, then
    `delivery_id`.
  - `deliveriesOf` returns only these. The job page lists one line per target. Older rounds stay
    in the table for the record.
- **Locking.** A target is in use when a recipe version's `publishTo` names it, as a string or
  in a list, or when a delivery or a published output records it. One SQL expression,
  `publish_to_ids(definition)`, gives the ids of either shape. It is a SQL function added by the
  migration, used by `pg.ts`, `copy-rules.ts`, `repo.ts` and the test helper.
- **Picker.** It shows the label, the sink, and a destination summary (`bucket/prefix`, plus
  `· archive` for the package layout). It is a checklist in list order, with Move up and Move
  down buttons; the first files-layout target is badged "Primary". There are no pattern fields
  yet (phase 6).

## Review focus

1. **A recipe saved without a change** after this lands. Its `definitionSha256` must not move,
   so nothing about its published history changes. *Test: Task 1, "a one-target recipe keeps its
   definitionSha256 through the editor's round trip".*
2. **Re-approving after a `needs_user`.** Target A succeeded and target B needed the user. After
   approval, both succeed this time. The job must end `succeeded`, not back in review because of
   B's first-round row. *Test: Task 5, "a later round's success replaces the earlier needs_user".*
3. **Results with two targets.** The outputs must show once each, read from the primary target,
   and the zip must hold each file once. *Test: Task 6, "Results lists each output once, from
   the primary target".*
4. **Deleting a job that delivered to an archive and to `default`.** Every object at both
   targets goes, including the archive's `package.json` and parts. *Test: Task 4, "withdraw
   deletes the archive's keys at every target".*
5. **Changing a target's layout while a recipe names it.** It must be refused like a bucket
   change, or old archives would no longer be found at their keys. *Test: Task 2, "layout is
   locked while a recipe names the target".*

---

### Task 1: Shared — `publishTo` as a list, and its normaliser on both sides

**Files:**
- Modify: `packages/shared/src/template.ts:470-476` (`DeliverySchema.publishTo`)
- Create: `packages/shared/src/publish-to.ts` (`publishTargetsOf`, `MAX_PUBLISH_TARGETS`)
- Create: `packages/shared/test/fixtures/publish-to.json` (cases: absent, string, one-item list,
  three-item list; with and without `rdf` in the formats)
- Modify: `worker/src/ingest_worker/template.py:414` (`publish_to()` → `publish_targets()`), and
  its callers in `pipeline.py`, `rdf_rebuild.py`, `withdrawal.py`
- Modify: `apps/web/src/templates/TemplateEditor.tsx` (`withPublishTo`, the writer used by Task 7)
- Test: `packages/shared/test/publish-to.test.ts`, `worker/tests/test_template.py`,
  `apps/web/test/template-model.test.ts`

**Interfaces:**
- Produces: `publishTargetsOf(delivery: Delivery | undefined): string[]`. It returns the listed
  ids in order, or `["default"]` when absent. It never adds `rdf-default`; the worker adds that,
  as today.
- Produces: `MAX_PUBLISH_TARGETS = 8`.
- Produces: `Template.publish_targets(self) -> list[str]` (Python), the same rule.
- Produces: `withPublishTo(delivery, ids: string[]): Delivery` (web). One id gives a string,
  two or more give a list, and `["default"]` alone removes the key.

- [ ] **Step 1: Write the failing tests.**
  - TS: "publishTargetsOf matches every case in publish-to.json".
  - TS: "DeliverySchema refuses an empty list, nine ids, and a duplicate".
  - Python: `test_publish_targets_matches_the_shared_fixture`.
  - Web: "withPublishTo writes a string for one target and a list for two".
  - Web: "a one-target recipe keeps its definitionSha256 through the editor's round trip" (Review
    focus 1). Load a stored definition with `publishTo: "archive"`, apply
    `withPublishTo(d, ["archive"])`, and expect the same `definitionSha256`.
- [ ] **Step 2: Run them.** `npm test -w packages/shared`, `npm test -w apps/web -- template-model`,
  `cd worker && uv run pytest tests/test_template.py`. Expected: FAIL (missing exports and
  fixture).
- [ ] **Step 3: Implement.** `publishTo: z.union([TargetIdSchema,
  z.array(TargetIdSchema).min(1).max(MAX_PUBLISH_TARGETS)]).optional()`, with a refinement for
  duplicates. Update the Python model to match. Callers of `publish_to()` move to
  `publish_targets()`; until Task 3, they use `[0]`, so behaviour is unchanged.
- [ ] **Step 4: Run them again,** and the whole worker suite. Expected: PASS; goldens unchanged.
- [ ] **Step 5: Commit.** `git commit -m "shared: publishTo takes a list of targets"`

### Task 2: API — the `layout` column, the mirror, validation and locking

**Files:**
- Create: `db/migrations/202610211000_several_targets.sql`. It adds:
  - `publish_targets.layout` (with its check);
  - the function `publish_to_ids(definition jsonb) RETURNS SETOF text`, `IMMUTABLE`. It reads
    `definition->'delivery'->'publishTo'` as a string or an array, and gives `default` when
    absent;
  - `job_outputs.is_primary` and the new unique key (see Decisions).
- Modify: `apps/api/src/publish-targets/{repo.ts,pg.ts}` (the `layout` field; in-use queries at
  `pg.ts:333-336` and `repo.ts:221-225` go through `publish_to_ids`)
- Modify: `apps/api/src/backup/copy-rules.ts:302-306`, `apps/api/test/helpers.ts:113`
- Modify: `apps/api/src/bridge/mirror.ts` (`destinationOf` adds `layout`)
- Modify: `apps/api/src/routes/publish-targets.ts` (accept `layout` on create, lock it on update,
  refuse it for `rdf`)
- Modify: `apps/api/src/templates/definitions.ts:124-145` (`templateIssues`)
- Modify: `apps/api/src/openapi/document.ts`, then `npm run openapi`
- Test: `apps/api/test/publish-targets-{repo,routes}.test.ts`, `apps/api/test/template-publish-target.test.ts`,
  `apps/api/test/bridge-mirror.test.ts`, and the opt-in Pg test for `publish_to_ids`

**Interfaces:**
- Consumes: `publishTargetsOf`, `MAX_PUBLISH_TARGETS` (Task 1).
- Produces: `TargetRecord.layout: 'files' | 'package'`, and the destination value `layout` on
  every S3 mirror.
- Produces: `primaryTargetOf(ids: string[], targets: TargetRecord[]): string | undefined`, in
  `publish-targets/repo.ts`.
- Produces: the issues `unknown target <id>`, `<id> is the triple store and is never listed`, and
  `needs a target with the files layout`.

- [ ] **Step 1: Write the failing tests.**
  - "a target is in use when a list names it" (memory repo, and the Pg test through
    `publish_to_ids`).
  - "layout is locked while a recipe names the target" (Review focus 5): a 409, as for the
    bucket.
  - "an rdf target refuses layout package".
  - "the mirror sends layout".
  - "templateIssues names each unknown id in a list, refuses rdf-default, and asks for a files
    target when every listed target is an archive".
  - "primaryTargetOf picks the first files-layout target in list order".
- [ ] **Step 2: Run them.** `npm test -w apps/api`. Expected: FAIL.
- [ ] **Step 3: Implement** as in the Interfaces. Existing rows default to `files`, so the mirror
  at start sends `layout: 'files'` for each one.
- [ ] **Step 4: Run them again,** plus `npm run openapi` and `git diff --exit-code` on the
  generated document after regenerating. Expected: PASS; the document diff is only `layout` and
  the `publishTo` union.
- [ ] **Step 5: Commit.** `git commit -m "api: target layout, list-aware locking and validation"`

### Task 3: Contract and bridge — the S3 package layout

**Files:**
- Modify: `packages/bridge-contract/src/package.ts` (`ArchivedPackageSchema`,
  `packageArchiveKeys`)
- Create: `packages/bridge-contract/test/fixtures/archive-keys.json`. It holds
  `package-document-rdf.json` under the prefix `archive/`, with every key it writes, in write
  order.
- Modify: `apps/bridge/src/sinks/s3.ts` (the `layout` field, and `deliver` per layout)
- Modify: `worker/src/ingest_worker/bridge/models.py` (`package_archive_keys`)
- Test: `packages/bridge-contract/test/package.test.ts`, `apps/bridge/test/s3-sink.test.ts`,
  `worker/tests/test_bridge_models.py`

**Interfaces:**
- Produces: `packageArchiveKeys(prefix: string, pkg: BridgePackage): { outputId: string; key:
  string }[]`, in write order, with `package.json` last.
- Produces: `package_archive_keys(prefix: str, package: BridgePackage) -> list[tuple[str, str]]`,
  the same.
- Produces: the S3 destination field `layout`: fixed, not required, blank meaning `files`.

- [ ] **Step 1: Write the failing tests.**
  - Contract: "archive keys match the fixture".
  - Contract: "the archived package parses, and it holds no bytes".
  - Python: `test_package_archive_keys_match_the_fixture`.
  - Bridge: "a package-layout target writes the parts, then package.json".
  - Bridge: "re-delivering the same key overwrites the same objects".
  - Bridge: "a files-layout target writes today's keys" (the existing test, unchanged).
  - Bridge: "an unknown layout is refused as destination_invalid".
- [ ] **Step 2: Run them.** `npx vitest run --root packages/bridge-contract`, `npm test -w
  apps/bridge`, and `cd worker && uv run pytest tests/test_bridge_models.py`. Expected: FAIL.
- [ ] **Step 3: Implement.** The sink's receipt lists every key it wrote. A failure part-way
  leaves no `package.json`, so the archive is incomplete and visibly so. The delivery is
  `retryable`, and a retry overwrites.
- [ ] **Step 4: Run them again,** and `npx vitest run --root apps/bridge conformance-fake`.
  Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "bridge: the S3 package layout for archives"`

### Task 4: Worker — deliver to every listed target; record per target

**Files:**
- Modify: `worker/src/ingest_worker/pipeline.py:480` (`target_for` → `targets_for`, returning
  the targets and the primary)
- Modify: `worker/src/ingest_worker/bridge/package.py:236-262` (`deliver_outputs`: the primary,
  not `targets[0]`; the archive keys for package-layout targets)
- Modify: `worker/src/ingest_worker/template_pipeline.py:347` (`deliver_publication`)
- Modify: `worker/src/ingest_worker/queue.py:91,240,279` (`record_published` writes rows per
  target with `is_primary`; `ON CONFLICT` on the new key)
- Modify: `worker/src/ingest_worker/withdrawal.py`, `rdf_rebuild.py` (withdraw by target from
  the recorded rows; rebuild reads the copy from the primary)
- Modify: the worker's `Target` model (`layout`)
- Test: `worker/tests/test_template_pipeline.py`, `test_withdrawal.py`, `test_queue_integration.py`
  (opt-in)

**Interfaces:**
- Consumes: `Template.publish_targets()` (Task 1); `package_archive_keys` (Task 3); the target
  mirror's `layout` (Task 2), read by the worker's target registry.
- Produces: `targets_for(deps, loaded) -> tuple[list[Target], Target | None]`: the recipe's
  targets in list order (each unknown id raises `TargetMissing`), plus `rdf-default` when the
  formats include `rdf`; and the primary.
- Produces: `Delivered.outputs_by_target: dict[str, list[RenderedOutput]]` and
  `Delivered.primary: str`.

- [ ] **Step 1: Write the failing tests.**
  - "a two-target recipe submits one package to both targets, in list order, and rdf-default
    last".
  - "the primary is the first files-layout target, even when an archive is listed first".
  - "published rows are recorded per target, with archive keys for the package layout and
    is_primary only on the primary".
  - "withdraw deletes the archive's keys at every target" (Review focus 4).
  - "an unknown id anywhere in the list sends the job to review naming it".
  - "the graph's copy is recorded on the primary target".
- [ ] **Step 2: Run them.** `cd worker && uv run pytest tests/test_template_pipeline.py
  tests/test_withdrawal.py`. Expected: FAIL.
- [ ] **Step 3: Implement** as in the Interfaces. A one-target recipe takes exactly today's path:
  the same rows, keys and requests.
- [ ] **Step 4: Run them again,** plus the whole worker suite with the equivalence goldens.
  Expected: PASS, goldens unchanged.
- [ ] **Step 5: Commit.** `git commit -m "worker: deliver to every listed target"`

### Task 5: API — job state on the latest delivery per target

**Files:**
- Modify: `apps/api/src/repositories/pg.ts:1581-1630` (`deliveriesIn`: `DISTINCT ON (target_id)
  … ORDER BY target_id, created_at DESC, delivery_id DESC`, then back into list order)
- Modify: `apps/api/src/repositories/memory.ts:1008-1035` (the same rule)
- Modify: `apps/api/src/bridge/events.ts` (no change to `finishOf`; its input is now the
  latest per target)
- Test: `apps/api/test/bridge-events.test.ts`, the opt-in Pg repository test

**Interfaces:**
- Produces: `deliveriesOf(jobId)` returns one `JobDelivery` per target: the latest.

- [ ] **Step 1: Write the failing tests.**
  - "a later round's success replaces the earlier needs_user" (Review focus 2), memory and Pg.
  - "one target failed and one succeeded: the job fails, naming the failed target" (the spec's
    partial failure).
  - "one target needs the user and one failed: the job goes back to review" (needs_user wins,
    per `finishOf`).
  - "a skipped delivery counts as done".
- [ ] **Step 2: Run them.** `npm test -w apps/api -- bridge-events`. Expected: the first FAILS;
  the others pass already and pin `finishOf`.
- [ ] **Step 3: Implement** the latest-per-target query in both repositories.
- [ ] **Step 4: Run them again.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "api: job state counts each target's latest delivery"`

### Task 6: API — Results, the zip and read keys from the primary target

**Files:**
- Modify: the nine API reads of `stage = 'published'` (`grep -rn "stage = 'published'"
  apps/api/src`). Each read for display or download adds `AND is_primary`. The withdraw and
  usage reads stay per target.
- Test: `apps/api/test/results.test.ts`, `apps/api/test/s3-keys.test.ts`

**Interfaces:**
- Consumes: `job_outputs.is_primary` (Task 2), written by Task 4.

- [ ] **Step 1: Write the failing tests.**
  - "Results lists each output once, from the primary target" (Review focus 3).
  - "the zip holds each file once".
  - "a target is in use while an archive row records it" (it can't be deleted).
- [ ] **Step 2: Run them.** `npm test -w apps/api -- results`. Expected: FAIL (duplicates).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again,** plus the whole API suite. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "api: read back from the primary target"`

### Task 7: Web — the picker, target layout, and per-target status

**Files:**
- Modify: `apps/web/src/templates/TemplateEditor.tsx:1570-1599` (`PublishToPicker` becomes a
  checklist with ordering; it writes through `withPublishTo`)
- Modify: the Published outputs target editor (a Layout select, *Files* or *Archive (whole
  package)*, disabled while locked)
- Modify: `apps/web/src/jobs/JobDetailPanel.tsx:196-210` (one line per target: the label, the
  status, and the error message when there is one)
- Modify: the help topics for Published outputs and the recipe General tab
- Test: `apps/web/test/TemplateEditor.test.tsx`, `apps/web/test/PublishedOutputsPage.test.tsx`, `apps/web/test/JobDetailPanel.test.tsx`

**Interfaces:**
- Consumes: `withPublishTo`, `publishTargetsOf` (Task 1); `TargetRecord.layout` (Task 2);
  `deliveriesOf`, now one per target (Task 5).

- [ ] **Step 1: Write the failing tests.**
  - "the picker shows label, sink and bucket/prefix, with · archive for the package layout".
  - "picking a second target writes a list; unpicking back to one writes a string".
  - "the first files-layout target is badged Primary; Move up changes it".
  - "an archives-only pick shows the issue from templateIssues".
  - "the job page shows each target's status once".
- [ ] **Step 2: Run them.** `npm test -w apps/web`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them again,** and look at it with the `run` skill against a dev stack, as
  before: pick two targets, save, reload.
- [ ] **Step 5: Commit.** `git commit -m "web: several targets per recipe"`

### Task 8: Deploy and smoke — an archive and another target

**Files:**
- Modify: `deploy/scripts/smoke-test.sh`. Add a section:
  - create an internal target `smoke-archive` with layout `package`;
  - seed a reviewed job of a one-field recipe with `publishTo: ["default", "smoke-archive"]`;
  - approve it and wait for `succeeded`;
  - check the default keys and `packages/<K>/package.json` through the bridge's
    `objects:read`;
  - delete the job, and check both are gone.

- [ ] **Step 1: Write the smoke section first, and run it against a stack at main's tip** (a
  separate project name, never the live stack). Expected: FAIL; the target create refuses
  `layout`.
- [ ] **Step 2: Deploy this branch fresh.** Expected: smoke all `ok`, including the new section.
- [ ] **Step 3: Upgrade check** (Review focus 1).
  1. Deploy main's tip and publish one job.
  2. Deploy this branch over the same volumes.
  3. Expected:
     - smoke `ok`;
     - every existing target has `layout = 'files'` on both sides;
     - the recipe's `definitionSha256` is unchanged;
     - Results for the old job is unchanged.
- [ ] **Step 4: Commit.** `git commit -m "deploy: smoke an archive target"`

### Task 9: Docs

**Files:**
- Modify: the spec. Add a "Phase 4 as built" section with this plan's decisions. Correct the
  phase 2 note "The bridge becomes the registry in phase 4" to say the registries merge in their
  own plan, after phase 4 and before phase 6.
- Modify: `docs/adr/0017-delivery-bridge.md`:
  - a phase 4 line;
  - the timing in Consequences: "Two target registries until a separate plan merges them, after
    phase 4 and before phase 6".
- Modify: `CLAUDE.md`, the contracts table rows:
  - Publishing targets (`layout`, the list, the primary);
  - Bridge delivery package (the archive layout and its keys);
  - the template format (`publishTo`).
- Modify: `docs/architecture.md`, the bridge row.
- Create: release notes in `docs/release-notes/`, in the format of
  `Release-Notes-20261020.html`.

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Check them.** Run `npm run format:check` and the vendor-name search of `docs
  CLAUDE.md apps packages worker deploy`. Expected: clean, no matches.
- [ ] **Step 3: Commit.** `git commit -m "docs: several targets per recipe"`

---

## Done when (spec phase 4 row)

- A recipe delivers to an archive target and another target:
  - the archive holds `package.json` and its parts under `packages/<K>/`;
  - the other target holds today's keys;
  - Results reads from the primary target.

  Shown by the worker suite (Task 4) and the smoke section (Task 8).
- Partial failure is handled as the spec says, judged on each target's latest delivery (Task 5):
  - all succeeded or skipped: `succeeded`;
  - any `needs_user`: back to review, and re-approval re-delivers;
  - otherwise, any `failed`: `failed`.
- Recipes that don't change keep their hash, keys and goldens.
- `npm run check` is green, and the opt-in Pg integration tests pass on a throwaway database.
- The compose smoke test passes on a fresh deploy and on an upgrade.
