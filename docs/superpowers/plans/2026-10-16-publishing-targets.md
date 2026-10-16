# Publishing targets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single `.env` publish target with admin-managed publishing targets stored in the database, chosen per recipe version (`delivery.publishTo`), respected by the worker's publishing, the API's reads, withdrawal, republish, rebuilds and the data lake S3 keys.

**Architecture:** A `publish_targets` table (migration 0050) holds internal (SeaweedFS bucket) and external (S3) targets; secrets are AES-GCM under `LLM_SECRETS_KEY` as for LLM endpoints, or env-variable names for the seeded `default`. The worker resolves a job's target from its recipe version at publish time through a live, version-counted store (the `LiveModels` pattern) and records the target id on every delivered output and graph version; the API reads each output through the client of its recorded target. A new Administration tab manages targets; the General tab picks one.

**Tech Stack:** TypeScript (Fastify, Zod, React, Vitest, @aws-sdk/client-s3), Python 3.14 (Pydantic, psycopg, boto3, pytest), Postgres.

**Spec:** `docs/superpowers/specs/2026-10-16-publishing-targets-design.md`

## Global Constraints

- TDD as in CLAUDE.md: red first, never weaken a test; unit tests offline (Memory repos, `MemoryObjectStore`, `MemoryS3KeyIssuer`, fakes); `npm run check` and `npm run worker:test` / `npm run worker:lint` green before a task is done.
- Forward-only migration `db/migrations/0050_publish_targets.sql` (the next free number; re-check `ls db/migrations` before writing it and take the next free one if main moved).
- Recipe field name: **`delivery.publishTo`** (a target id). Never reuse the word "target" for it in code names: `DELIVERY_TARGETS` / `deliveryTargets` / `setDeliveryTarget` already mean the S3/RDF switches.
- Target id rule: `TARGET_ID = /^[a-z0-9][a-z0-9_-]{0,39}$/`; `default` is reserved for the seeded target; ids made from a label with `publishTargetIdFrom(label)` (slug like `choiceIdFrom`, fallback `target`), deduplicated with `-2`, `-3`… by the route.
- Absent `publishTo` = `default`. Legacy `spec.yaml` types always deliver to `default`. A recipe naming no target hashes exactly as today (`definitionCanonical` untouched).
- Secrets: never returned (`secretSet: boolean`), never logged, never echoed by Test connection. Without `LLM_SECRETS_KEY`, storing a secret is 409 `LLM_SECRETS_KEY is not set: the API cannot store keys`.
- Every new route documented (tags, summary, description, responses, `x-admin` on admin routes); new tag `Published outputs` in `TAGS`. Operators reach none of them (`OPERATOR_CALLS` unchanged).
- Users see "recipe", "publishing target", "Published outputs"; code keeps `template`.
- Locked fields of a target in use: `kind`, `endpoint`, `region`, `bucket`, `prefix` (409 `<label> is used by <what>: add a new target instead`). Editable always: `label`, credentials, `forcePathStyle`, `sse`, `kmsKeyId`, `storageClass`.
- "In use" = a published version naming it (absent = `default`, so `default` is always in use), a `job_outputs` row or `published_graph_versions` row recording it, or an S3 key consumer granted it.

## Review Focus

1. **A publish whose target was removed or never seeded** (worker starts before the API on first boot, or a draft published naming an id since deleted): the worker must seed `default` itself and treat an unknown target as `needs_review` with `no publishing target <id>`, never a silent fallback to `default`. Test in Task 6 and Task 7.
2. **Reading old outputs after credentials rotate**: Results and downloads use the target's *current* credentials with the *recorded* bucket and key; a rotated secret takes effect without a restart on both sides (version counter). Tests in Task 4 and Task 6.
3. **Withdrawal of outputs delivered to a target other than the type's current one** (v1 → `default`, v2 → `finance-lake`, then retire): every object is deleted through its own recorded target. Test in Task 7 (worker) and Task 4 (API builds params with target ids).
4. **External target unreachable on read**: Results/download answer 502 `publishing target <label> unavailable`, not 500, and the page still lists other outputs. Test in Task 4.
5. **Prefix forms** (`''`, `ingest`, `ingest/`): the stored prefix is normalised to end in `/` when non-empty (`normalisePrefix`), identically in TS and Python (shared fixture), so keys never become `ingestfoo.csv`. Test in Tasks 1 and 6.

---

### Task 1: Shared schemas, the recipe field and fixtures

**Files:**
- Create: `packages/shared/src/publish-targets.ts`, `packages/shared/test/publish-targets.test.ts`, `packages/shared/test/fixtures/publish-targets.json`
- Modify: `packages/shared/src/template.ts` (`DeliverySchema`, `validateTemplate`, `setDeliveryTarget`), `packages/shared/src/index.ts`, `packages/shared/src/jobs.ts` (`JobOutput`, `WithdrawParamsSchema`), `packages/shared/test/fixtures/withdraw-params.json`
- Test: `packages/shared/test/template.test.ts`, `packages/shared/test/jobs.test.ts`

**Interfaces:**
- Produces (exported from `@ih/shared`):
  - `DEFAULT_TARGET_ID = 'default'`, `TARGET_ID` regex, `TargetIdSchema`, `publishTargetIdFrom(label: string): string`
  - `TARGET_KINDS = ['internal','external']`, `SSE_MODES = ['none','AES256','aws:kms']`, `STORAGE_CLASSES = ['STANDARD','STANDARD_IA','ONEZONE_IA','INTELLIGENT_TIERING','GLACIER_IR']`
  - `normalisePrefix(p: string): string` (trim, strip leading `/`, add trailing `/` when non-empty)
  - `PublishTargetViewSchema` `{ id, label, kind, bucket, prefix, endpoint: string|null, region: string|null, accessKeyId: string|null, secretSet: boolean, keysFromEnv: {accessKey: string, secretKey: string}|null, forcePathStyle: boolean, sse, kmsKeyId: string|null, storageClass: string|null, source: 'env'|'ui', editedAt: string|null, updatedBy: string|null, createdAt: string, usage: TargetUsageSchema }`
  - `TargetUsageSchema` `{ publishedVersions: number, documentTypes: string[], deliveredOutputs: number, consumers: number }` and `targetInUse(u): boolean`
  - `TargetCreateBodySchema` (strict; `id?`, `label` 1-80, `kind`, `bucket` (S3 bucket rule 3-63 `^[a-z0-9][a-z0-9.-]+[a-z0-9]$`), `prefix` default `''`; for `external`: `region` required, `endpoint?` url, `accessKeyId`, `secretAccessKey` required, `forcePathStyle` default false, `sse` default `none`, `kmsKeyId?` only with `aws:kms`, `storageClass?`; `internal` refuses every external field (refine messages `internal targets take only a bucket and prefix`))
  - `TargetPatchBodySchema` (strict, every field optional, `secretAccessKey: string|null` not allowed (a target always has one) — just optional string; refine `nothing to change`)
  - `TargetTestBodySchema` = `{ id?: TargetId } & Partial<create body>` (an existing id tests stored settings overlaid with the body; no id = the body must be a full create body)
  - `TargetTestResultSchema` `{ ok: boolean, step: 'connect'|'write'|'read'|'delete'|null, message: string }`
  - `TargetChoiceSchema` `{ id, label, kind, bucket }`
  - `deliveryPublishTo(definition: { delivery?: { publishTo?: string } }): string` (absent → `default`)
- `DeliverySchema` becomes `{ formats?: DeliveryFormat[] (min 1 when present), publishTo?: TargetId }` strict; `deliveryFormats` unchanged in meaning (absent formats = csv,json). `setDeliveryTarget` keeps `publishTo` (writes `delivery: { publishTo }` when formats are the default).
- `JobOutput` gains `targetId: string | null` (null for drafts).
- `WithdrawParamsSchema`: each object gains `target: TargetId`; each graph gains `target: TargetId`.

- [ ] **Step 1: Write failing tests**
  - `publish-targets.test.ts`: `publishTargetIdFrom('Finance lake')` → `finance-lake`; `publishTargetIdFrom('Default')` → `target`; `normalisePrefix` table from the fixture's `prefixes` cases (`''→''`, `'ingest'→'ingest/'`, `'/ingest/'→'ingest/'`, `' a/b '→'a/b/'`); create body: internal with `region` refused, external without `region` refused, `kmsKeyId` with `sse: 'AES256'` refused, bucket `My_Bucket` refused; patch `{}` refused `nothing to change`.
  - `template.test.ts`: a definition with `delivery: { publishTo: 'finance-lake' }` (no formats) validates; `deliveryFormats` of it is `['csv','json']`; `deliveryPublishTo` of none is `default`; `setDeliveryTarget(def with publishTo, 'rdf', true)` keeps `publishTo`; `setDeliveryTarget` back to default formats leaves `{ delivery: { publishTo } }`; `publishTo: 'Bad Id'` is an issue.
  - Fixture `publish-targets.json` holds `prefixes` cases, `delivery` cases (definition → expected formats and publishTo) used by both test suites, and `seed` cases (Task 2/6: env → expected default row).
  - `jobs.test.ts`: `withdraw-params.json` cases carry `target`.
- [ ] **Step 2: Run `npx vitest run --project shared` — expect FAIL**
- [ ] **Step 3: Implement** the module and schema changes; export from `index.ts`.
- [ ] **Step 4: Run `npx vitest run --project shared` — expect PASS; `npm run typecheck` (fix compile fallout of `JobOutput.targetId` by adding `targetId: null`/real values where API code builds `JobOutput`; real reads come in Task 4).**
- [ ] **Step 5: Commit** `shared: publishing target schemas and delivery.publishTo`

### Task 2: Migration and the API target repository

**Files:**
- Create: `db/migrations/0050_publish_targets.sql`, `apps/api/src/publish-targets/repo.ts`, `apps/api/src/publish-targets/pg.ts`, `apps/api/src/publish-targets/seed.ts`, `apps/api/test/publish-targets-contract.ts`, `apps/api/test/publish-targets-repo.test.ts`, `apps/api/test/integration/publish-targets-pg.test.ts`, `apps/api/test/publish-targets-seed.test.ts`
- Modify: `apps/api/src/config.ts` (keep `targetConfig` as the seed input; export `TargetConfig`)

**Interfaces:**
- Migration 0050:
  - `publish_targets(id text PK CHECK (id ~ '^[a-z0-9][a-z0-9_-]{0,39}$'), label text NOT NULL, kind text NOT NULL CHECK (kind IN ('internal','external')), bucket text NOT NULL, prefix text NOT NULL DEFAULT '', endpoint text, region text, access_key_id text, secret_key_enc text, access_key_env text, secret_key_env text, force_path_style boolean NOT NULL DEFAULT false, sse text NOT NULL DEFAULT 'none' CHECK (sse IN ('none','AES256','aws:kms')), kms_key_id text, storage_class text, source text NOT NULL DEFAULT 'ui' CHECK (source IN ('env','ui')), seeded_at timestamptz, edited_at timestamptz, updated_by text, created_at timestamptz NOT NULL DEFAULT now())`
  - inserts the row `('default','Default','internal','ingest-published', source 'env', seeded_at NULL)` so foreign keys hold before the first start; the first start seeds it (below).
  - `publish_targets_state(version bigint NOT NULL)` with one row, bumped by a statement trigger on `publish_targets` that also `NOTIFY ih_publish_targets`.
  - `job_outputs.target_id text REFERENCES publish_targets(id)`; backfill `'default'` where `stage = 'published'`; CHECK `(stage = 'published') = (target_id IS NOT NULL)` added `NOT VALID` then validated after the backfill.
  - `published_graph_versions.target_id text NOT NULL DEFAULT 'default' REFERENCES publish_targets(id)` and the same on `published_graphs` (the current one's copy).
  - `s3_consumer_targets(consumer_id uuid REFERENCES s3_consumers ON DELETE CASCADE, target_id text REFERENCES publish_targets(id), PRIMARY KEY (consumer_id, target_id))`; every existing consumer granted `default`.
- `repo.ts`:
  - `interface TargetRecord` = view fields + `secretKeyEnc: string|null`, `accessKeyEnv`, `secretKeyEnv`, `seededAt`.
  - `interface PublishTargetRepo { list(): Promise<PublishTargetView[]>; get(id): Promise<TargetRecord|null>; create(input: NewTarget, by: string|null): Promise<PublishTargetView|'exists'>; update(id, patch: TargetPatch, by): Promise<PublishTargetView|null>; remove(id): Promise<'deleted'|'missing'|'default'|'in_use'>; usage(id): Promise<TargetUsage>; choices(): Promise<TargetChoice[]>; version(): Promise<number>; seedDefault(seed: DefaultSeed): Promise<'seeded'|'kept'|'differs'> }`
  - `usage` counts published `templates` whose `definition->'delivery'->>'publishTo'` equals the id (or is null for `default`), `job_outputs`/`published_graph_versions` rows, and `s3_consumer_targets` rows. Memory repo takes the needed facts through constructor callbacks (`{ publishedDefinitions(): Promise<{id, version, definition}[]>, deliveredCount(id), consumerCount(id) }`) so tests can stage them.
  - `MemoryPublishTargetRepo` and `PgPublishTargetRepo(pool)` share `publish-targets-contract.ts`.
- `seed.ts`: `defaultSeed(config: Config): DefaultSeed` — internal (bucket, prefix) when `TARGET_S3_ENDPOINT` blank or equal to `S3_ENDPOINT` **and** `TARGET_S3_ACCESS_KEY`/`SECRET_KEY` blank or equal to `S3_*`; else external with endpoint, region, bucket, prefix, `accessKeyEnv: 'TARGET_S3_ACCESS_KEY'`, `secretKeyEnv: 'TARGET_S3_SECRET_KEY'`, `forcePathStyle: true` (today's client is path style). `seedDefault` writes only when `seeded_at IS NULL` (`'seeded'`), else returns `'differs'` when the stored row's kind/endpoint/bucket/prefix differ from the seed (caller logs a warning naming the fields) or `'kept'`.

- [ ] **Step 1: Write failing tests** — contract: create/list/get, duplicate id `'exists'`, update keeps unspecified fields and stamps `editedAt`/`updatedBy`, `secretSet` true without exposing the secret, `remove('default')` → `'default'`, remove of a target named by a published version → `'in_use'`, usage counts each source, `choices()` sorted default first then by label, `version()` increases on every write, `seedDefault` seeds once then `'kept'`, and `'differs'` when the env moved. Seed table test over the fixture's `seed` cases.
- [ ] **Step 2: Run `npx vitest run apps/api/test/publish-targets-repo.test.ts apps/api/test/publish-targets-seed.test.ts` — FAIL**
- [ ] **Step 3: Implement** migration, repos, seed.
- [ ] **Step 4: Run them — PASS; run the Pg contract with `IH_TEST_DATABASE_URL` (CLAUDE.md recipe) — PASS**
- [ ] **Step 5: Commit** `api: publish_targets table and repository`

### Task 3: Target stores, bucket creation and the connection probe (API)

**Files:**
- Create: `apps/api/src/publish-targets/stores.ts`, `apps/api/src/publish-targets/probe.ts`, `apps/api/test/publish-targets-stores.test.ts`
- Modify: `apps/api/src/storage/s3.ts` (`S3Options` gains `forcePathStyle?: boolean` (default true, today's behaviour), `sse?`, `kmsKeyId?`, `storageClass?` applied on `PutObject`; `ensureBucket(bucket)`), `apps/api/src/storage/object-store.ts` (`MemoryObjectStore.ensureBucket` no-op recording calls)

**Interfaces:**
- `class TargetStores { constructor(opts: { repo: PublishTargetRepo; internal: S3Options; secrets: SecretsKeys|null; env: NodeJS.ProcessEnv; make?: (o: S3Options) => ObjectStore }) ; storeFor(targetId: string): Promise<{ store: ObjectStore; target: TargetRecord }>; ensureBucket(target: TargetRecord): Promise<void> }` — caches one store per target, rebuilt when `repo.version()` moved (checked at most once a second); internal targets use `opts.internal`; external ones use their endpoint (blank → `https://s3.<region>.amazonaws.com`), region, `accessKeyId` or `env[accessKeyEnv]`, decrypted secret or `env[secretKeyEnv]`. Unknown id → `TargetMissingError`; undecryptable secret → `TargetUnavailableError('cannot decrypt the secret of <label>')`.
- `probeTarget(store: ObjectStore, bucket: string, prefix: string): Promise<TargetTestResult>` — puts `<prefix>.ct-studio-check-<uuid>`, gets it back (bytes equal), deletes it; the first failing step and a plain message: `could not reach the endpoint`, `access denied`, `no such bucket`, `wrong region for this bucket`, else the error's name. Never includes credentials.

- [ ] **Step 1: Failing tests** — stores: internal and external targets resolve to stores built with the right options (`make` spy); a credentials PATCH rebuilds the store on next call; an env-key default reads `env`; missing id throws `TargetMissingError`. Probe: success, and each step failing via a `MemoryObjectStore` subclass that throws S3-shaped errors (`AccessDenied`, `NoSuchBucket`, `PermanentRedirect`, network) → the right `step` and message.
- [ ] **Step 2: Run — FAIL**  **Step 3: Implement**  **Step 4: Run — PASS**
- [ ] **Step 5: Commit** `api: per-target object stores and connection probe`

### Task 4: API routes, reads by recorded target, publishing check

**Files:**
- Create: `apps/api/src/routes/publish-targets.ts`, `apps/api/test/publish-targets-routes.test.ts`
- Modify: `apps/api/src/app.ts` (`AppDeps`: remove `targetStore` and `target`; add `targets: PublishTargetRepo`, `targetStores: TargetStores`), `apps/api/src/server.ts` (build both, `seedDefault` on start and log `publishing target default differs from .env (fields): .env is ignored now`), `apps/api/src/storage/stage.ts` (`storeFor` → `outputStore(deps, output: { stage, targetId })`), `routes/jobs.ts`, `routes/results.ts` (`ResultDetail.target` becomes `{ id, label, bucket, prefix }`, `packages/shared/src/results.ts`), `apps/api/src/repositories/pg.ts` + memory repo (select `target_id` into `JobOutput.targetId`; `withdrawType`/`deleteJob` put each object's and graph's `target` in the withdraw params), `apps/api/src/templates/definitions.ts` (`templateIssues` Pick adds `targets`; issue `{ path: 'delivery.publishTo', message: 'no publishing target <id> on this deployment' }`), `apps/api/src/openapi/document.ts` (tag `Published outputs`), `apps/api/test/helpers.ts` (targets: Memory repo seeded with an internal `default` over a `MemoryObjectStore` exposed as `ctx.target` as today), affected tests (`results.test.ts`, `jobs.test.ts`, `delete-jobs.test.ts`, `config.test.ts`)

**Interfaces:**
- Routes (admin-only preHandler as `routes/llm.ts`, 403 `admins only`):
  - `GET /api/publish-targets` → `{ targets: PublishTargetView[] }`
  - `POST /api/publish-targets` → 201 view; id from body or `publishTargetIdFrom(label)` deduplicated; `id: 'default'` 400 `default is reserved`; internal → `targetStores.ensureBucket` (502 `could not create bucket <bucket>: <message>` and nothing stored); external secret encrypted (409 without `LLM_SECRETS_KEY`).
  - `PATCH /api/publish-targets/:id` → view; locked fields while `targetInUse` → 409 per Global Constraints; 404 `publishing target not found`.
  - `DELETE /api/publish-targets/:id` → 204; 409 `default cannot be removed` / `<label> is used by …` (names up to 3 document types, then `and n more`, else outputs/consumers counts).
  - `POST /api/publish-targets/test` → 200 `TargetTestResult` (always 200; failure is `ok: false`).
  - `GET /api/publish-targets/choices` (any designer or admin, not operators) → `{ choices: TargetChoice[] }`.
- `outputStore` failures: `TargetMissingError`/`TargetUnavailableError`/S3 transport → 502 `publishing target <label|id> unavailable`.
- Publishing refused by the existing `blockingIssues` path for Templates publish, import with `publish: true` and Workbench publish (no new code beyond the issue).

- [ ] **Step 1: Failing tests** — routes: each status above; admin-only (designer 403) except choices; secret never in any response body (assert JSON lacks the value); locked-field 409 only when in use; label/credential edit allowed in use. Reads: an output recorded under `finance-lake` is served from that target's store, one under `default` from default's; credential rotation then read works; external store throwing → 502 with the label. Issues: a draft naming `nope` gets the `delivery.publishTo` issue and publish is 409; naming an existing target, none; a YAML import (and a GitHub *Use as draft*) of a recipe naming `finance-lake` on a deployment without it keeps `publishTo` unchanged in the draft and shows the issue. The web Results page still compiles and shows the target's label with the new `ResultDetail.target` shape. Withdraw params from `withdrawType` carry each object's `target`.
- [ ] **Step 2: Run the touched test files — FAIL**  **Step 3: Implement**  **Step 4: `npm run check` — PASS (`npm run openapi` regenerated)**
- [ ] **Step 5: Commit** `api: publishing target routes; read outputs from their recorded target`

### Task 5: Data lake S3 keys per target (API)

**Files:**
- Modify: `apps/api/src/s3keys/{service,issuer,seaweed-iam,repo,pg}.ts`, `apps/api/src/routes/s3-keys.ts`, `apps/api/src/config.ts` (`s3KeysConfig` → `{ endpoint: S3_PUBLIC_URL ?? null }` always; availability decided by targets), `apps/api/src/server.ts`, `apps/api/test/s3-keys*.test.ts`

**Interfaces:**
- `S3KeyIssuer.createUser(userName, grants: { bucket: string; prefix: string }[])` and new `setGrants(userName, grants)` (PutUserPolicy: `s3:ListBucket`/`GetBucketLocation` on each bucket (with `s3:prefix` condition when prefix non-empty), `s3:GetObject` on `bucket/prefix*`). `MemoryS3KeyIssuer` records grants.
- `S3KeyRepo` gains `grants(consumerId): Promise<string[]>`, `setGrants(consumerId, targetIds: string[])`; `S3Consumer` view gains `targets: string[]`.
- `S3KeyService` opts drop `bucket`, add `targets: PublishTargetRepo`; `issue(label, expiresInDays, targetIds)`; `setTargets(consumerId, targetIds): 'ok'|'not_found'|'bad_target'`; `list()` returns `{ endpoint, internalTargets: TargetChoice[], consumers }` (no single `bucket`); every grant must be an existing internal target (400 `<id> is not an internal publishing target`), at least one (400 `grant at least one publishing target`). `reconcile()` additionally rewrites each consumer's policy from its grants (once per run).
- Routes: POST issue body gains `targets: TargetId[]` (min 1); new `PUT /api/access/s3-keys/:id/targets` `{ targets }` → consumer view. When no internal target exists, GET answers `internalTargets: []` and issue is 409 `add an internal publishing target first`.

- [ ] **Step 1: Failing tests** — issue with two targets writes a policy over both buckets/prefixes; changing grants rewrites it; external id refused; reconcile restores a policy changed behind its back; existing consumers (migration grant) list `targets: ['default']`.
- [ ] **Step 2: FAIL**  **Step 3: Implement**  **Step 4: `npm run check` PASS**
- [ ] **Step 5: Commit** `api: grant data lake S3 keys per internal publishing target`

### Task 6: Worker target store and live targets

**Files:**
- Create: `worker/src/ingest_worker/publish_targets.py`, `worker/tests/test_publish_targets.py`
- Modify: `worker/src/ingest_worker/storage.py` (`S3ObjectStore(endpoint, region, access_key, secret_key, *, path_style: bool = True, sse: str = "none", kms_key_id: str | None = None, storage_class: str | None = None)`), `worker/tests/fakes.py` (`MemoryPublishTargetStore`), `worker/src/ingest_worker/template.py` (`Delivery.formats` optional, `publish_to: str | None = Field(None, alias="publishTo")`; `Template.publish_to() -> str`), `worker/tests/test_template.py` (reads the shared fixture's `delivery` cases), `worker/src/ingest_worker/admin.py` (create buckets of internal targets)

**Interfaces:**
- `@dataclass(frozen=True) class TargetRow(id, label, kind, bucket, prefix, endpoint, region, access_key_id, secret_key_enc, access_key_env, secret_key_env, path_style, sse, kms_key_id, storage_class, seeded_at)`
- `class PublishTargetStore(Protocol): def load(self) -> list[TargetRow]; def version(self) -> int; def seed_default(self, seed: DefaultSeed) -> Literal["seeded","kept","differs"]`; `PgPublishTargetStore(conn)`.
- `default_seed(env: Mapping[str, str]) -> DefaultSeed` — same rule as the API's `defaultSeed` (shared fixture `seed` cases); `normalise_prefix(p) -> str` (fixture `prefixes`).
- `@dataclass class Target: id: str; store: ObjectStore; bucket: str; prefix: str` (moved here from `pipeline.py`, re-exported there for existing imports).
- `class LiveTargets: __init__(store, internal: S3Settings, env=os.environ, make=S3ObjectStore)`; `refresh() -> bool` (version check as `LiveModels.refresh`); `get(target_id: str) -> Target` raising `TargetMissing(DocumentError)` `no publishing target <id>`; secrets via `llm.secrets.decrypt_secret` (failure → `DocumentError` `cannot decrypt the secret of <label>`).
- Fake: `MemoryPublishTargetStore(rows)` with `_version` bump on change; `FakeTargets(dict[id, Target])` helper exposing `get`.

- [ ] **Step 1: Failing tests** — fixture-driven `default_seed` and `normalise_prefix`; `LiveTargets` builds internal/external stores with the right args (`make` spy), refreshes on version change only, env keys for the seeded default, missing id raises `TargetMissing`; `Template.publish_to()` defaults to `default`; delivery fixture cases parse.
- [ ] **Step 2: `cd worker && uv run pytest tests/test_publish_targets.py tests/test_template.py` FAIL**  **Step 3: Implement**  **Step 4: PASS + `npm run worker:lint`**
- [ ] **Step 5: Commit** `worker: publishing targets from the database`

### Task 7: Worker publishing, records, withdrawal and rebuilds by target

**Files:**
- Modify: `worker/src/ingest_worker/pipeline.py` (`PipelineDeps.target` → `targets: Targets | None` where `Targets` is a Protocol with `get(id) -> Target`; `publish_outputs(deps, outputs, target: Target)`; `target_for(deps, loaded) -> Target` = `deps.targets.get(template.publish_to())`, legacy spec → `default`), `template_pipeline.py` (`publish_template_job`, `publish_graph(…, target)`), `main.py` (resolve target once per publish/process; `queue.record_published(job, outputs, target)`; build `LiveTargets`, seed default on start (log the `differs` warning), refresh with the LLM config check every `CONFIG_CHECK_S`), `queue.py` (`record_published(job, outputs, target: Target)` writes `target_id`, bucket = `target.bucket`), `graph_registry.py` (`GraphPublish.target_id`, `PublishedGraph.target_id`; Pg writes/reads the column), `withdrawal.py` (`TargetObject.target`, `WithdrawnGraph.target`; delete through `deps.targets.get(o.target)`; graph copies via their recorded target's prefix; republish delivers to the target of the withdrawn job's version), `rdf_rebuild.py` (`rebuild` reads each current graph's copy through its recorded target; backfill/remint publish to the job version's target; CLI `main` builds `LiveTargets`), `tests/fakes.py` (`FakeQueue.record_published` stores `(job.id, outputs, target.id)`), tests constructing `Target` (`test_rdf_rebuild.py`, `test_review.py`, `test_template_db.py`, `test_template_pipeline.py`, `test_withdrawal.py`, `test_main.py`/`test_queue.py`)

**Interfaces:**
- Consumes Task 6's `Target`, `LiveTargets`, `TargetMissing`; Task 1's withdraw params `target`.
- A job whose target is missing goes to `needs_review` with `no publishing target <id>` before anything is written (it is a `DocumentError`). Test runs (`deliver=False`) never resolve a target.

- [ ] **Step 1: Failing tests** — a v2 recipe with `publishTo: finance-lake` delivers outputs and its graph copy to finance-lake's store and records `finance-lake`; v1 (none) to `default`; a missing target → needs_review, nothing written; withdrawal of outputs from two targets deletes each from its own store; graph copy withdrawal uses the recorded target's prefix; rebuild reads copies from recorded targets; republish goes to the job version's target; a draft test run touches no target.
- [ ] **Step 2: `npm run worker:test` FAIL**  **Step 3: Implement**  **Step 4: `npm run worker:test` and `npm run worker:lint` PASS; run the worker Pg-marked tests touched with `IH_TEST_DATABASE_URL`**
- [ ] **Step 5: Commit** `worker: deliver to, record and withdraw from each recipe's publishing target`

### Task 8: Web — Published outputs tab

**Files:**
- Create: `apps/web/src/access/PublishedOutputsPage.tsx`, `apps/web/src/access/TargetRow.tsx`, `apps/web/src/access/AddTargetDialog.tsx`, `apps/web/src/help/PublishedOutputsHelp.tsx`, `apps/web/test/PublishedOutputsPage.test.tsx`
- Modify: `apps/web/src/access/AdminDialog.tsx` (`AdminTab` + `{ id: 'published-outputs', label: 'Published outputs', icon: <an existing upload/bucket-like IconName> }` after Linked data), `apps/web/src/api/client.ts` (`listPublishTargets`, `createPublishTarget`, `updatePublishTarget`, `deletePublishTarget`, `testPublishTarget`, `listPublishTargetChoices`), `apps/web/test/fake-api.ts` (defaults: lists `[]`, writes throw `… not stubbed`), `apps/web/src/help/topics.tsx` (`'published-outputs': { title: 'How publishing targets work', … }`), `apps/web/test/AdminDialog.test.tsx` (tab list), `apps/web/test/Help.test.tsx`, styles

**Interfaces:**
- `PublishedOutputsPage({ api, me, actions })`: admin guard; lead text; `<HelpButton topic="published-outputs" />` by the heading; *Add target* in the header via `InSlot`; rows (`TargetRow`, region `Target <label>`): collapsed — label, mono id, tag Internal/External, `bucket/prefix`, `used by n document types`, where from (`from .env` / `edited by X` / `added here by X`); opened — settings form (external fields only for External; locked fields read-only with `In use: add a new target to move` when `targetInUse`), secret as `Secret stored (encrypted)` / `Keys from .env (TARGET_S3_ACCESS_KEY, TARGET_S3_SECRET_KEY)` with *Set secret*, *Save*, *Test connection* (shows `ok` / step + message in `role="status"`/`alert`), *Remove* with confirm (hidden for `default`, disabled with the reason while in use).
- `AddTargetDialog`: Kind `Segmented` (Internal/External), Label, Id (pre-filled from label, hint `Use the same id on every deployment for the same recipient`), Bucket, Prefix, external fields, *Test connection* before Add, *Add*.
- Help body covers: internal vs external; `default` and `.env` (seeded once); a recipe names its target on General, so it changes only with a new version; ids name recipients across deployments; locking; S3 keys per internal target.

- [ ] **Step 1: Failing tests** — tab listed and opens with Add target in the header; rows collapsed with kind/bucket/usage/source; adding internal and external (calls `createPublishTarget` with the exact body, secret included only on add); test connection shows a failure step; locked fields read-only when in use; remove after confirm, absent for default; help button opens `How publishing targets work`; admins only.
- [ ] **Step 2: `npx vitest run --project web` FAIL**  **Step 3: Implement**  **Step 4: PASS + `npm run check`**
- [ ] **Step 5: Commit** `web: Published outputs administration tab`

### Task 9: Web — General tab picker and S3 key grants

**Files:**
- Modify: `apps/web/src/templates/TemplateEditor.tsx` (a `Publish to` row after the Default model row: `<select aria-label="Publish to">` from `listPublishTargetChoices`, empty option `Default (<default label>)` writing no `publishTo`; a stored id that is no choice kept as `<id> (not on this deployment)`), `apps/web/src/help/GeneralHelp.tsx` (`<h3>Publish to</h3>`), `apps/web/src/access/S3KeysSection.tsx` (issue form: target tick boxes from `internalTargets`, at least one; `ConsumerCard` shows its targets with *Change targets* → tick boxes → `setS3KeyTargets`; the lead text no longer names one bucket; no internal target → note pointing at Published outputs), `apps/web/src/api/client.ts` (`createS3Key(label, days, targets)`, `setS3KeyTargets(id, targets)`, types updated), `apps/web/test/fake-api.ts`, `apps/web/test/TemplateEditor.test.tsx`, `apps/web/test/S3KeysSection.test.tsx`, `apps/web/test/Help.test.tsx`

- [ ] **Step 1: Failing tests** — General: picking `finance-lake` and saving writes `delivery.publishTo`; picking Default removes it (and keeps `formats`); an unknown stored id shows `(not on this deployment)`; the Outputs tab's RDF switch keeps `publishTo`. S3 keys: issue sends chosen targets; Create disabled with none ticked; change targets calls `setS3KeyTargets`; no internal targets → the note.
- [ ] **Step 2: FAIL**  **Step 3: Implement**  **Step 4: `npm run check` PASS**
- [ ] **Step 5: Commit** `web: pick a recipe's publishing target; S3 keys per target`

### Task 10: Docs and deploy

**Files:**
- Modify: `CLAUDE.md` (contracts row "Publishing targets (migration 0050)": TS `packages/shared/src/publish-targets.ts`, `apps/api/src/publish-targets/`, `DeliverySchema.publishTo`, `JobOutput.targetId`, `WithdrawParamsSchema` targets | Python `publish_targets.py`, `Template.publish_to`, `queue.record_published(…, target)`, `WithdrawParams` targets; fixture `publish-targets.json`; a Rules-of-the-road bullet; Results bullet and ADR 0008 bullet updated; `TARGET_S3_*` only seed `default`), `deploy/.env.example` (comment: seeds the `default` target on first start, then Administration > Published outputs), `deploy/README.md`, `docs/adr/0008-s3-read-keys.md` (status note: keys per internal target), `docs/architecture.md` (publish target paragraph), `docs/openapi.json` (`npm run openapi`)

- [ ] **Step 1:** Write the doc changes.  **Step 2:** `npm run check` and `npm run worker:test` PASS.  **Step 3: Commit** `docs: publishing targets`
