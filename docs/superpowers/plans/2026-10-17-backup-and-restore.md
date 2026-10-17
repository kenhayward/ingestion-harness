# Backup and Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin makes one encrypted backup of the whole stack from Administration > Backup, downloads it, and restores it on any server either *as this deployment* or *as a copy* (production → staging).

**Architecture:** The engine runs in the API process (`apps/api/src/backup/`), behind ports so unit tests stay offline. A backup streams `pg_dump`, every object of the stack's own buckets, the `lake-*` SeaweedFS identities and a Fuseki N-Quads dump through our own entry framing and a chunked AES-256-GCM stream (key = HKDF of `LLM_SECRETS_KEY`) into a `backups` bucket. A restore is uploaded in resumable parts. It is then verified end to end, restored into a **side database** that is migrated and adjusted (copy rules, sessions, maintenance, queue pause), and objects, identities and the triple store are replaced. Only then is the live database swapped for the side one by `ALTER DATABASE … RENAME`, so a failure before the swap leaves the database untouched.

**Tech Stack:** Node 24 / Fastify / TypeScript, `node:crypto` (`hkdfSync`, AES-256-GCM), `pg`, `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` (new), `pg_dump`/`pg_restore` 17 (Alpine `postgresql17-client`), Python worker (pause + `rebuild` task), React web.

**Spec:** [docs/superpowers/specs/2026-10-17-backup-and-restore-design.md](../specs/2026-10-17-backup-and-restore-design.md)

## Global Constraints

- TDD per CLAUDE.md: a failing test first for every behaviour; unit tests never touch the network, Postgres, SeaweedFS or Fuseki; real infra only in `apps/api/test/integration/` (skips without its env) or `@pytest.mark.integration`.
- New migrations are named `db/migrations/YYYYMMDDHHMM_description.sql` (UTC time of writing), forward-only.
- Every new route: `tags` (new tag `Backup` in `TAGS`, `apps/api/src/openapi/document.ts`), `summary`, `description`, `operationId`, `response` per status, `'x-admin': true`; admin-only; not in `operatorMayCall`. `npm run openapi` regenerates `docs/openapi.json`.
- The encryption key never enters the backup file and is never stored; a pasted key is used for one restore only.
- The file header: magic `CTBAK\x00\x01\n` (8 bytes), 16-byte random salt, u32 BE chunk size `1048576`. KDF: `hkdfSync('sha256', masterKey, salt, 'ct-backup v1', 32)`.
- Upload part size `67108864` (64 MiB). Only the newest finished backup is kept.
- UI copy says **recipe**, never template; app name **CT Studio**.
- Cross-language contracts change on both sides in the same PR (job task `rebuild`, `queue_control`, `publish_targets.inert_at`).
- Help: a detailed `backup` topic, `HelpButton` on the Backup tab, an entry in `HELP_INDEX` (under the admin entries).
- `npm run check` green before declaring done.

## Review Focus

1. **The API restarts mid-restore** (container killed): the status in the `backups` bucket must say `failed` on next start, maintenance must stay on, and the live database must be untouched if the swap had not happened → Task 11 `recovers an interrupted restore as failed`.
2. **A resumed upload sends parts out of order or twice** → complete only when every part `0…n-1` is present exactly once, a re-sent part replaces the earlier one → Task 8 tests.
3. **A backup is restored onto a stack without Fuseki (or the reverse)** → no failure; the report says `triple store not restored: run rdf_rebuild` (or `backup has no triple store`) → Task 11 test.
4. **Create backup while a restore runs, restore while a backup runs, two restores** → 409 `a backup or restore is already running` → Task 7 and Task 12 tests.
5. **Bucket names differ between the two deployments** (staging's `S3_BUCKET_INBOX` ≠ production's): role buckets map by role, never by name → Task 11 test `maps role buckets by role`.

---

## File structure

```
packages/shared/src/backup.ts                 schemas and types shared by api and web
apps/api/src/backup/crypto.ts                 key derivation, encrypt/decrypt Transforms
apps/api/src/backup/archive.ts                entry framing writer/reader
apps/api/src/backup/ports.ts                  DatabaseDumper, GraphStoreDump, IamStore, BackupStore ports + fakes' types
apps/api/src/backup/pg-tools.ts               pg_dump / pg_restore / side database / swap (real adapter)
apps/api/src/backup/fuseki.ts                 dataset GET/PUT over GSP (real adapter)
apps/api/src/backup/seaweed-iam-file.ts       lake-* identities via the filer (real adapter)
apps/api/src/backup/create.ts                 createBackup orchestration
apps/api/src/backup/uploads.ts                resumable part uploads
apps/api/src/backup/check.ts                  verify pass → manifest
apps/api/src/backup/copy-rules.ts             KeptState read + applied in the side DB
apps/api/src/backup/restore.ts                runRestore orchestration, status persistence
apps/api/src/backup/service.ts                BackupService: one-at-a-time lock, state, wiring
apps/api/src/routes/backup.ts                 routes
apps/web/src/access/BackupPage.tsx            the tab
apps/web/src/access/RestoreDialog.tsx         upload, mode, key, check, confirm, progress
apps/web/src/access/backup-upload.ts          part uploader with resume
apps/web/src/help/BackupHelp.tsx              help body
worker/src/ingest_worker/queue.py             pause condition
worker/src/ingest_worker/main.py              `rebuild` task
db/migrations/<stamp>_backup_restore.sql      queue_control, task 'rebuild', publish_targets.inert_at
docs/adr/0015-backup-and-restore.md
```

---

### Task 1: Shared contract

**Files:**
- Create: `packages/shared/src/backup.ts`, `packages/shared/test/backup.test.ts`
- Modify: `packages/shared/src/index.ts` (export)

**Interfaces — Produces:**
- `BACKUP_FORMAT_VERSION = 1`, `BACKUP_PART_BYTES = 67108864`
- `BucketRoleSchema = z.enum(['inbox','outputs','runs','target'])`
- `BackupManifestSchema` (strict): `{ format: 'ct-backup', formatVersion: 1, appVersion: string, commit: string|null, lastMigration: string, migrations: string[], instanceName: string, baseIri: string, startedAt: string, finishedAt: string, createdBy: string, buckets: { role: BucketRole, name: string, objects: number, bytes: number }[], parts: { name: string, bytes: number, sha256: string }[], fuseki: boolean, lakeIdentities: number }`
- `BackupViewSchema`: `{ id, status: 'running'|'succeeded'|'failed', startedAt, finishedAt: string|null, createdBy, bytes: number|null, error: string|null, progress: { phase: 'database'|'objects'|'identities'|'triples'|'finishing', done: number, of: number, bytes: number }|null }`
- `RestoreModeSchema = z.enum(['deployment','copy'])`
- `RestoreStartBodySchema`: `{ uploadId: uuid, mode, key?: string }` — `key` required when `mode === 'copy'` (refine, message `paste the key of the deployment this backup came from`)
- `RestorePhaseSchema = z.enum(['checking','checked','restoring','succeeded','failed'])`
- `RestoreStatusSchema`: `{ id, mode, phase, step: string|null, done: number, of: number, manifest: BackupManifest|null, plan: { dropped: string[], kept: string[] }|null, error: string|null, report: RestoreReport|null, startedBy, updatedAt }`
- `RestoreReportSchema`: `{ restored: { table: string, rows: number }[] , objects: number, missingObjects: { bucket: string, key: string }[], copy: { cancelledJobs: number, droppedTargets: string[], withdrawnOutputs: number, recipesNeedingModel: string[], recipesNeedingTarget: string[] }|null, triples: 'restored'|'none-in-backup'|'no-triple-store'|'reminting', previousDatabase: string, adminTokenRotated: true }`
- `RestoreConfirmBodySchema`: `{ instanceName: string }`
- `QueueControlViewSchema`: `{ paused: boolean, pausedAt: string|null, pausedBy: string|null, reason: string|null }`, `QueueControlBodySchema`: `{ paused: boolean }`
- `UploadViewSchema`: `{ id, size: number, partBytes: number, parts: number, received: number[] }`, `UploadStartBodySchema`: `{ size: number (int, 1…2**40), fileName: string(1-255) }`
- `copyPlan(): { dropped: string[], kept: string[] }` — fixed copy for the dialog: dropped = `['GitHub connections and users\' linked GitHub accounts','External publishing targets','The backup\'s model endpoints, keys, model choices and settings','Data-lake S3 keys','Queued and running jobs (cancelled)']`, kept = `['This server\'s model endpoints, choices and settings','This server\'s publishing targets','This server\'s GitHub settings and instance name','This server\'s data-lake keys','This server\'s base IRI (graphs are re-minted)']`

- [ ] **Step 1:** Write `backup.test.ts`: manifest parses a valid fixture and refuses an unknown key; `RestoreStartBodySchema` refuses `{mode:'copy'}` without `key` with the message above and accepts `{mode:'deployment'}` without one; `UploadStartBodySchema` refuses `size: 0`.
- [ ] **Step 2:** Run `npx vitest run packages/shared/test/backup.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement `packages/shared/src/backup.ts`, export from the index.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(shared): backup and restore contract`.

---

### Task 2: Encrypted stream

**Files:** Create `apps/api/src/backup/crypto.ts`, `apps/api/test/backup-crypto.test.ts`

**Interfaces — Produces:**
- `backupKey(master: Buffer, salt: Buffer): Buffer`
- `encryptStream(master: Buffer): Transform` — emits header then chunks
- `decryptStream(masters: Buffer[]): Transform` — reads header, tries each master on the **first** chunk, then sticks with the one that worked; errors `BackupKeyError('this key does not open the backup')` or `BackupCorruptError(reason)`
- `parseMasterKey(value: string): Buffer` — same rule as `masterKey` in `apps/api/src/llm/secrets.ts` (export and reuse it there rather than duplicating)

Chunk framing: `[u32 BE ciphertextLength][ciphertext][16-byte tag]`; nonce = 4 zero bytes + u64 BE chunk index; AAD = u64 BE index + 1 byte (`1` on the last chunk, else `0`). The last chunk is always emitted on flush (possibly empty), so a stream ending without a final-flagged chunk is `BackupCorruptError('the backup is truncated')`.

- [ ] **Step 1:** Tests: `round-trips 3.5 chunks of random bytes`; `round-trips an empty input`; `refuses another key with BackupKeyError`; `falls back to the previous key` (`decryptStream([wrong, right])`); `detects a flipped byte` (BackupCorruptError); `detects truncation` (drop the last frame); `detects reordered chunks`; `refuses a bad magic`.
- [ ] **Step 2:** Run `npx vitest run apps/api/test/backup-crypto.test.ts` → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(api): chunked AES-GCM backup stream`.

---

### Task 3: Archive framing

**Files:** Create `apps/api/src/backup/archive.ts`, `apps/api/test/backup-archive.test.ts`

**Interfaces — Produces:**
- `class ArchiveWriter { constructor(out: Writable); entry(name: string, body: Readable | Buffer, size: number): Promise<{ sha256: string }>; end(): Promise<void> }` — each entry: `[u32 BE headerLength][header JSON {name,size}][size bytes]`; `end()` writes a zero-length header terminator. Throws if the body's length differs from `size`.
- `readArchive(input: Readable): AsyncIterable<{ name: string; size: number; body: Readable }>` — the consumer must drain `body` before the next entry; computes nothing itself.
- Entry names used by later tasks: `postgres.dump`, `objects/index.jsonl`, `objects/<role>/<bucketName>/<key>`, `iam/lake-identities.json`, `fuseki.nq`, and **`manifest.json` last**.

- [ ] **Step 1:** Tests: `writes and reads three entries in order`; `keeps keys with slashes, spaces and unicode`; `refuses a body shorter than its size`; `reads an empty archive`; `errors on a stream cut inside an entry`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit `feat(api): backup archive framing`.

---

### Task 4: Streaming object store

**Files:**
- Modify: `apps/api/src/storage/object-store.ts`, `apps/api/src/storage/s3.ts`, `apps/api/package.json` (add `@aws-sdk/lib-storage`, same major as `client-s3`)
- Test: `apps/api/test/object-store.test.ts` (Memory), `apps/api/test/integration/s3-stream.test.ts` (dev-infra, skips without `S3_ENDPOINT`)

**Interfaces — Produces (added to `ObjectStore`):**
- `list(bucket: string, prefix?: string): AsyncIterable<{ key: string; size: number }>`
- `getStream(bucket: string, key: string): Promise<{ body: Readable; size: number; contentType: string } | null>`
- `putStream(bucket: string, key: string, body: Readable, contentType: string): Promise<void>` (S3: `Upload` from lib-storage, part size 16 MiB)
- `createMultipart / uploadPart / completeMultipart / abortMultipart(bucket, key, …)` — `createMultipart(bucket, key, contentType): Promise<string>`, `uploadPart(bucket, key, uploadId, partNumber /*1-based*/, body: Readable, size: number): Promise<string /*etag*/>`, `completeMultipart(bucket, key, uploadId, parts: {partNumber: number; etag: string}[]): Promise<void>`, `abortMultipart(bucket, key, uploadId): Promise<void>`

Every other `ObjectStore` implementation in the repo (search `implements ObjectStore`) gets them too.

- [ ] **Step 1:** Memory tests: `list pages through 2,500 keys under a prefix`; `getStream returns null for a missing key`; `putStream stores the streamed bytes and content type`; `multipart parts complete in part order whatever the upload order`. Integration: the same four against SeaweedFS with a 40 MiB `putStream`.
- [ ] **Step 2:** Run `npx vitest run apps/api/test/object-store.test.ts` → FAIL. **Step 3:** Implement. **Step 4:** PASS (and `npm run test:integration -- s3-stream` against dev-infra).
- [ ] **Step 5:** Commit `feat(api): streaming and multipart object store`.

---

### Task 5: Migration, worker pause, `rebuild` task, inert targets

**Files:**
- Create: `db/migrations/<UTC stamp>_backup_restore.sql`
- Modify: `worker/src/ingest_worker/queue.py` (`CLAIM_SQL`), `worker/src/ingest_worker/main.py` (`_run_claimed`), `worker/src/ingest_worker/rdf_rebuild.py` (a `RebuildParams` + `run_rebuild_job`), `worker/src/ingest_worker/publish_targets.py` (`PgPublishTargetStore`, `LiveTargets`: inert = absent), `apps/api/src/publish-targets/repo.ts` (Pg + Memory `list`/`get`/choices skip `inert_at IS NOT NULL`), `apps/api/src/repositories/pg.ts` + `memory.ts` (`queueBackground` task union adds `'rebuild'`), `packages/shared/src/jobs.ts` (task list if typed there), `worker/tests/fakes.py` (`FakeQueue` pause)
- Tests: `worker/tests/test_queue.py` (integration, Pg), `worker/tests/test_main.py`, `worker/tests/test_publish_targets.py`, `apps/api/test/publish-targets.test.ts`

Migration content:
```sql
CREATE TABLE queue_control (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  paused boolean NOT NULL DEFAULT false,
  paused_at timestamptz, paused_by text, reason text);
INSERT INTO queue_control (id) VALUES (true);
ALTER TABLE jobs DROP CONSTRAINT jobs_task_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_task_check CHECK (task IN ('process','publish','rerun','prepare','segment','draft','export','ontology','graph','embed','withdraw','republish','suggest','rebuild'));
ALTER TABLE publish_targets ADD COLUMN inert_at timestamptz;
```
Check `jobs_document_or_project` (from 0032/0037): it must allow `rebuild` without document or project, like `withdraw`; extend it in the same migration.

`CLAIM_SQL` gains `AND NOT EXISTS (SELECT 1 FROM queue_control WHERE paused)`. The `rebuild` task's params: `{ mode: 'remint' | 'rebuild' }` (`RebuildParams`, `extra="forbid"`); it runs `remint(deps, queue, PgRebuildSource(conn))` or `rebuild(deps)` and completes with no outputs.

- [ ] **Step 1:** Worker tests: `test_claim_skips_while_paused` (integration: pause → `claim` returns None; unpause → returns the job); `test_rebuild_task_runs_remint` (FakeQueue, a stub remint records the call); `test_inert_target_is_missing` (`LiveTargets.get` raises `TargetMissing` for an inert row). API test: `an inert target is not listed and is a 404`.
- [ ] **Step 2:** Run `cd worker && uv run pytest tests/test_main.py -k rebuild` and the API test → FAIL.
- [ ] **Step 3:** Write the migration and implement.
- [ ] **Step 4:** Run the narrow tests, then `npm run worker:test` and `npm run worker:lint` → PASS.
- [ ] **Step 5:** Add the CLAUDE.md contract notes (Job statuses and tasks row: `rebuild`; Publishing targets row: `inert_at`). Commit `feat: queue pause, rebuild task, inert publishing targets`.

---

### Task 6: Backup creation

**Files:**
- Create: `apps/api/src/backup/ports.ts`, `apps/api/src/backup/create.ts`, `apps/api/src/backup/pg-tools.ts`, `apps/api/src/backup/fuseki.ts`, `apps/api/src/backup/seaweed-iam-file.ts`, `apps/api/test/backup-create.test.ts`, `apps/api/test/backup-fakes.ts`

**Interfaces — Produces (`ports.ts`):**
- `interface DatabaseTools { dump(): Promise<{ body: Readable; done: Promise<void> }>; migrations(): Promise<string[]> /* schema_migrations, sorted */; createSideDatabase(name: string): Promise<string /*url*/>; restore(url: string, body: Readable): Promise<void>; swap(side: string, keepAs: string): Promise<void>; dropDatabase(name: string): Promise<void> }` — real: `pg_dump -Fc --no-owner --no-acl`, `pg_restore --no-owner --no-acl -d`, swap connects to the `postgres` database, `pg_terminate_backend` on both, `ALTER DATABASE live RENAME TO keepAs; ALTER DATABASE side RENAME TO live`.
- `interface TripleStoreDump { available(): Promise<boolean>; dump(): Promise<Readable>; replace(body: Readable): Promise<void> }` — real: `GET {RDF_ENDPOINT}/{RDF_DATASET}/data` `Accept: application/n-quads`, `PUT` same URL `Content-Type: application/n-quads`, basic auth `RDF_USER`/`RDF_PASSWORD`; `available()` false when `RDF_ENDPOINT` is blank.
- `interface LakeIdentities { read(): Promise<unknown[]> /* lake-* entries only */; replace(entries: unknown[]): Promise<void> /* keeps every non-lake identity */ }` — real: filer `GET|PUT {SEAWEEDFS_FILER_URL}/etc/iam/identity.json` (default `http://seaweedfs:8888`).
- `interface BackupDeps { db: DatabaseTools; store: ObjectStore; buckets: { inbox; outputs; runs; backups }; internalTargetBuckets(): Promise<string[]> /* distinct buckets of internal, non-inert targets, excluding own */; triples: TripleStoreDump; lake: LakeIdentities; master: Buffer; version: { appVersion: string; commit: string|null }; instanceName(): Promise<string>; baseIri(): Promise<string>; now(): Date }`
- `createBackup(deps: BackupDeps, id: string, by: string, onProgress: (p: BackupView['progress']) => void): Promise<{ key: string; bytes: number; manifest: BackupManifest }>` — writes `backups/<id>.ctbak` via `putStream` through `ArchiveWriter` → `encryptStream`; order: `postgres.dump`, objects bucket by bucket (each object entry, then `objects/index.jsonl` lines `{role,bucket,key,size,sha256,contentType}`), `iam/lake-identities.json`, `fuseki.nq` when available, `manifest.json`. A `getStream` returning null (deleted mid-backup) is skipped.

- [ ] **Step 0 (spike, throwaway, against dev-infra):** confirm (a) `GET/PUT /ct/data` with N-Quads on Fuseki 6.2.0 dumps and replaces the whole dataset with the `ct-writer` user, and (b) the `lake-*` identities live at `/etc/iam/identity.json` on the SeaweedFS 4.48 filer and a PUT is picked up by S3 without a restart. If either fails, stop and report: the fallback (Fuseki: queue a `rebuild` task instead; IAM: re-issue keys) changes the design and needs the owner.
- [ ] **Step 1:** Tests (fakes in `backup-fakes.ts`: `FakeDatabaseTools`, `FakeTripleStore`, `FakeLakeIdentities`, `MemoryObjectStore`): `writes an archive whose manifest counts every bucket`; `the decrypted archive lists postgres.dump first and manifest.json last`; `skips an object deleted during the backup`; `omits fuseki.nq when no triple store`; `includes internal target buckets but never the backups bucket`; `reports progress through each phase`.
- [ ] **Step 2:** Run `npx vitest run apps/api/test/backup-create.test.ts` → FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(api): create an encrypted stack backup`.

---

### Task 7: Backup service, routes, deployment wiring

**Files:**
- Create: `apps/api/src/backup/service.ts`, `apps/api/src/routes/backup.ts`, `apps/api/test/backup-routes.test.ts`
- Modify: `apps/api/src/app.ts` (`AppDeps.backup: BackupService | null`), `apps/api/src/server.ts` (wire real adapters; one `makePool(max)` helper that attaches `pool.on('error', …)` to **every** pool, so the swap's terminated connections log instead of crashing), `apps/api/src/config.ts` (`S3_BUCKET_BACKUPS` default `ingest-backups`, `RDF_ENDPOINT`, `RDF_DATASET` default `ct`, `RDF_USER`, `RDF_PASSWORD`, `SEAWEEDFS_FILER_URL`), `apps/api/src/openapi/document.ts` (`Backup` tag), `apps/api/src/access/` sweeps unchanged but new routes appear in them, `deploy/docker/api.Dockerfile` (`RUN apk add --no-cache postgresql17-client` before `USER node`), `deploy/docker-compose.yml` (api: `S3_BUCKET_BACKUPS`, `RDF_*` writer env, `SEAWEEDFS_FILER_URL`, networks `[default, rdf]`), `worker/src/ingest_worker/admin.py` (create the backups bucket; env `S3_BUCKET_BACKUPS`), `deploy/.env.example`

**Interfaces — Produces:**
- `class BackupService { constructor(deps: BackupDeps & RestoreDeps); status(): Promise<{ backup: BackupView | null; restore: RestoreStatus | null; queue: QueueControlView }>; startBackup(by: string): BackupView /* 409 when busy */; download(id): Promise<{ body: Readable; size: number; fileName: string } | null>; … restore methods from Task 11 }` — the busy lock covers backups and restores; backup metadata lives at `backups/<id>.json` in the backups bucket (never Postgres); a new success deletes the previous `.ctbak` and `.json`.
- Routes: `GET /api/backup` (status), `POST /api/backup/backups` (202 `BackupView`; 409 `a backup or restore is already running`), `GET /api/backup/backups/:id/file` (attachment `ct-backup-<instance>-<yyyyMMdd-HHmm>.ctbak`), `PUT /api/backup/queue` (`QueueControlBody`, writes `queue_control` with `paused_by` = user name).

- [ ] **Step 1:** Route tests with `buildApp` + fakes: `an admin starts a backup and sees it finish`; `a second start while running is a 409`; `a designer gets 403 and an operator OPERATOR_REFUSED`; `download streams the file as an attachment`; `pausing and resuming the queue records who`. Check `openapi.test.ts` passes.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** `npx vitest run --project api` → PASS; `npm run openapi`.
- [ ] **Step 5:** Commit `feat(api): backup routes and deployment wiring`.

---

### Task 8: Resumable upload

**Files:** Create `apps/api/src/backup/uploads.ts`, `apps/api/test/backup-uploads.test.ts`; modify `apps/api/src/routes/backup.ts`, `deploy/docker/nginx.conf`

**Interfaces — Produces:**
- `class BackupUploads { start(body: UploadStartBody, by): Promise<UploadView>; part(id, n: number /*0-based*/, body: Readable, size: number): Promise<UploadView>; get(id): Promise<UploadView | null>; complete(id): Promise<{ key: string }>; abort(id) }` — S3 multipart in the backups bucket at `uploads/<id>.ctbak`, state `uploads/<id>.json` (parts' etags). Part `n` must be `BACKUP_PART_BYTES` long except the last (`size - n*BACKUP_PART_BYTES`); else 400 `part n must be X bytes`. `complete` with a missing part is a 409 `parts missing: …`. One upload at a time; a new start aborts the previous.
- Routes: `POST /api/backup/uploads`, `GET /api/backup/uploads/:id`, `PUT /api/backup/uploads/:id/parts/:n` (raw `application/octet-stream`, register a stream content-type parser scoped to this route, body limit 65 MiB), `POST /api/backup/uploads/:id/complete`.
- nginx: `location ^~ /api/backup/uploads/ { client_max_body_size 80m; proxy_request_buffering off; proxy_read_timeout 300s; … }` (headers as the bundle import block), and the download location `proxy_buffering off`.

- [ ] **Step 1:** Tests: `parts arriving out of order complete`; `a re-sent part replaces the first`; `complete with a missing part is a 409 naming it`; `a wrong-sized part is a 400`; `a new upload aborts the old one`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(api): resumable backup upload`.

---

### Task 9: Check pass

**Files:** Create `apps/api/src/backup/check.ts`, `apps/api/test/backup-check.test.ts`

**Interfaces — Produces:**
- `checkBackup(input: () => Promise<Readable>, masters: Buffer[], localMigrations: string[], onProgress): Promise<{ manifest: BackupManifest; master: Buffer }>` — decrypts and reads every entry, hashing each against `manifest.parts` (read last; entries are buffered only as hashes); errors: `BackupKeyError`, `BackupCorruptError`, `BackupTooNewError('this backup was made by a newer CT Studio (migration <name>): upgrade this server first')` when any `manifest.migrations` entry is missing locally.

- [ ] **Step 1:** Tests (build fixtures with `createBackup` + fakes): `returns the manifest for a good file`; `wrong key`; `previous key opens it`; `a part whose hash differs`; `a newer migration is refused`; `an older backup passes`.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5:** Commit `feat(api): verify a backup before restoring`.

---

### Task 10: Copy rules

**Files:** Create `apps/api/src/backup/copy-rules.ts`, `apps/api/test/integration/backup-copy-rules.test.ts` (Pg, skips without `IH_TEST_DATABASE_URL`)

**Interfaces — Produces:**
- `type KeptState = Record<KeptTable, unknown[]>` with `KEPT_TABLES = ['llm_endpoints','llm_models','llm_choices','llm_settings','github_sync_settings','linked_data_settings','linked_data_base_history','s3_consumers','s3_access_keys','s3_consumer_targets'] as const` and `publish_targets` read separately.
- `readKeptState(live: pg.ClientBase): Promise<KeptState & { targets: unknown[] }>` — `SELECT row_to_json(t) FROM <table> t`.
- `applyCopyRules(side: pg.ClientBase, kept, opts: { secretsFrom: Buffer; secretsTo: Buffer }): Promise<RestoreReport['copy']>` in **one transaction**, in this order:
  1. Cancel every `queued`/`running` job of any task (status `cancelled`, `job_events` `cancelled` with `{reason:'restored as a copy'}`).
  2. Delete `template_github_pushes`, `template_github_links`, `github_link_states`; clear GitHub fields of `user_profiles` (the columns from migration 0044).
  3. Replace each `KEPT_TABLES` table's rows with `kept`'s (`DELETE`, then `INSERT … SELECT * FROM json_populate_recordset(null::<table>, $1)`), children after parents; bump `llm_config_state`.
  4. Publishing targets: for each backup row whose id staging also has → overwrite with staging's row; staging-only rows → insert; backup-only **external** rows → `inert_at = now()`, credentials and endpoint cleared, and every `job_outputs` row naming them gets `withdrawn_at = now()`; `published_graphs` rows naming them deleted. Backup rows that were external and whose id staging has as internal: their `job_outputs` rows are withdrawn too (the recorded bucket is not in this SeaweedFS). Bump `publish_targets_state`.
  5. Return counts plus `recipesNeedingModel` (template ids whose steps or `model` name a choice id not in the kept `llm_choices`, `default` aside) and `recipesNeedingTarget` (`delivery.publishTo` naming an inert or absent target).

  Note (refinement of the spec, same intent): internal targets' objects are restored to **the bucket names and keys the delivery records hold**, not re-keyed into staging's bucket, so every recorded `job_outputs` key keeps resolving.

- [ ] **Step 1:** Integration tests on two throwaway databases (migrate both, seed with SQL): `keeps staging's LLM config and drops production's`; `drops GitHub links and users' GitHub tokens`; `makes production's external targets inert and withdraws their outputs`; `staging's row wins on a shared id`; `cancels queued jobs of every task`; `lists recipes naming a missing model choice`.
- [ ] **Step 2:** Run with `IH_TEST_DATABASE_URL` (CLAUDE.md container recipe) → FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit `feat(api): copy rules for restoring production into staging`.

---

### Task 11: Restore run

**Files:** Create `apps/api/src/backup/restore.ts`, `apps/api/test/backup-restore.test.ts`, `apps/api/test/integration/backup-roundtrip.test.ts`; modify `apps/api/src/maintenance/repo.ts` (`MaintenanceGate.force(view)`/`release()`, `current()` returns the override first)

**Interfaces — Consumes:** Tasks 2, 3, 4, 6, 9, 10. **Produces:**
- `interface RestoreDeps extends BackupDeps { gate: MaintenanceGate; localMigrations(): Promise<string[]>; migrate(url: string): Promise<void>; rotateAdminToken(): Promise<void> /* access.rotateAdminPassword + the usual log line */; createEmbedJobs(model: string): Promise<number>; secrets: SecretsKeys; liveDatabaseName: string }`
- `runRestore(deps: RestoreDeps, r: { id; mode; key: Buffer; uploadKey: string; by }, status: (s: Partial<RestoreStatus>) => Promise<void>): Promise<RestoreReport>` — steps, each reported as `step`:
  1. `gate.force(…)` with message `CT Studio is being restored from a backup.`; pause `queue_control` in the live DB.
  2. Create side database `<live>_restore_<yyyyMMddHHmm>`; stream the archive a second time; `postgres.dump` → `db.restore`; other entries handled as they come (objects to their **role-mapped** bucket — `inbox|outputs|runs` → this server's names, `target` → the recorded name, `ensureBucket` first — collecting the written keys per bucket; `iam` held; `fuseki.nq` to a temp file).
  3. `migrate(sideUrl)`.
  4. In the side DB: copy rules (copy mode; `secretsFrom` = the opening key) — or nothing extra (deployment mode); then always: `DELETE FROM sessions`; `queue_control` paused (`reason 'restored from backup'`); `maintenance` row enabled with the same message.
  5. Delete objects in each restored bucket that the backup did not write. Then fill `report.missingObjects`: every `documents` inbox key and every non-withdrawn `job_outputs` key of an internal target (read from the side DB) that was not written (test: `reports a document whose file was not in the backup`).
  6. Deployment mode: `lake.replace(entries)`. Copy mode: identities untouched.
  7. Triples: backup has `fuseki.nq` and `triples.available()` → `replace`; copy mode then inserts a `rebuild` job `{mode:'remint'}` in the side DB (it runs once the worker is resumed) → `'reminting'`; no triple store → `'no-triple-store'`; none in backup → `'none-in-backup'`.
  8. `db.swap(side, '<live>_before_restore_<stamp>')` → `report.previousDatabase`.
  9. `rotateAdminToken()`; copy mode with an `embedding_model` setting → `createEmbedJobs(model)`; `gate.release()` (the row keeps maintenance on).
  A failure before step 8 drops the side database, leaves the queue paused and maintenance forced on (row set too), and sets `failed` with the error; objects already replaced are named in the error (`objects were partly replaced: restore again`).
- Status persisted at `restores/<id>.json` in the backups bucket after every step; on API start, `BackupService.recover()` marks a `restoring` status `failed` (`the API restarted during the restore`) and sets the maintenance row on.

- [ ] **Step 1:** Unit tests with fakes: `deployment mode replaces database, objects, identities and triples, then swaps`; `copy mode applies the copy rules and leaves identities alone` (copy rules via an injected fake); `maps role buckets by role`; `deletes objects the backup does not have`; `a failure before the swap drops the side database and keeps the live one`; `reports when the backup has no triple store` and `when this server has none`; `recovers an interrupted restore as failed`; `forces maintenance for non-admins throughout` (gate.current() is enabled at each step). Gate test: `force overrides the stored row until release`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Integration round trip (dev-infra + `IH_TEST_DATABASE_URL`-style throwaway Postgres + Fuseki): seed a job, an object, a graph; back up; mutate everything; restore as deployment; assert all three are back and the previous database exists. Run it.
- [ ] **Step 6:** Commit `feat(api): restore a backup as this deployment or as a copy`.

---

### Task 12: Restore routes

**Files:** Modify `apps/api/src/routes/backup.ts`, `apps/api/src/backup/service.ts`, `apps/api/src/access/routes.ts` (public route config); test `apps/api/test/backup-routes.test.ts`

**Interfaces — Produces:**
- `POST /api/backup/restores` (`RestoreStartBody`) → 202 `{ status: RestoreStatus, token: string }`; starts the check (deployment mode: masters = this server's current then previous; copy mode: the pasted key via `parseMasterKey`, 400 when malformed); 409 when busy or the upload is not complete.
- `GET /api/backup/restores/:id` — `config.public`; allowed for an admin session **or** header `X-Restore-Token` equal (timing-safe) to the token, which lives only in memory and in the status file as a sha256; 404 otherwise.
- `POST /api/backup/restores/:id/confirm` (`RestoreConfirmBody`) — admin session or token; 409 unless `phase === 'checked'`; 400 `type <instance> to confirm` unless `instanceName` equals `manifest.instanceName`; 202 then `runRestore`.
- `DELETE /api/backup/restores/:id` — cancel a checked restore (nothing changed).
- `status.plan` = `copyPlan()` in copy mode, null otherwise.

- [ ] **Step 1:** Tests: `copy mode without a key is a 400`; `a wrong key ends the check as failed with "this key does not open the backup"`; `confirm needs the instance name`; `the token reads status after the session is gone`; `without token or admin the status is a 404`; `a restore while a backup runs is a 409`. openapi and access sweeps pass (the public route is in the sweep's public list with a reason).
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run --project api`).
- [ ] **Step 5:** Commit `feat(api): restore routes`.

---

### Task 13: Backup tab and restore dialog

**Files:** Create `apps/web/src/access/BackupPage.tsx`, `apps/web/src/access/RestoreDialog.tsx`, `apps/web/src/access/backup-upload.ts`, `apps/web/test/BackupPage.test.tsx`, `apps/web/test/backup-upload.test.ts`; modify `apps/web/src/access/AdminDialog.tsx` (tab `{ id: 'backup', label: 'Backup', icon: <an existing archive-like IconName> }`, after Maintenance), `apps/web/src/api/client.ts` + `apps/web/test/fake-api.ts` (methods below)

**Interfaces — Produces (Api):** `getBackupStatus()`, `startBackup()`, `backupDownloadUrl(id): string`, `setQueuePaused(paused: boolean)`, `startUpload(body)`, `getUpload(id)`, `uploadPart(id, n, blob: Blob, onProgress?)`, `completeUpload(id)`, `startRestore(body)` → `{ status, token }`, `getRestore(id, token)`, `confirmRestore(id, instanceName, token)`, `cancelRestore(id, token)`.
- `uploadBackup(api, file: File, opts: { resumeId?: string; onProgress(sent, total) }): Promise<string /*uploadId*/>` — slices `BACKUP_PART_BYTES`, skips parts `getUpload` already has, retries a failed part 3 times; the upload id is remembered in `localStorage` key `ih.backupUpload` (`{ id, name, size, lastModified }`, wrapped in try/catch) so choosing the same file again resumes.

Page (inside `admin-section`, heading + `HelpButton topic="backup"` as on `PublishedOutputsPage`): *Create backup* in the header slot (`InSlot`); the latest backup (when, who, size, Download); progress while running; a warning callout **“Keep a copy of deploy/.env somewhere other than this server. Without its LLM_SECRETS_KEY this backup cannot be opened.”**; *Restore…*; a *Queue* line (paused/running, *Resume queue*) and, when maintenance is on, a pointer to the Maintenance tab.

Dialog steps: choose file (resume note) → mode (two radio cards: *Restore as this deployment* — disaster recovery, server move; *Restore as a copy* — production into staging) → key field (copy only, `type=password`, hint *the LLM_SECRETS_KEY of the deployment the backup came from*) → checking progress → manifest summary + `plan` lists (copy) + type-the-instance-name confirm → progress (polls `getRestore` every 2 s with the token) → report (counts, missing objects, copy section, previous database name, *the admin-from-the-log token was rotated: see the API log*, *Sign in again*). The dialog cannot be closed while restoring.

- [ ] **Step 1:** Tests: upload `skips parts the server has` and `retries a failing part`; page `shows the .env warning`, `Create backup calls startBackup and shows progress`, `designers never see the tab` (AdminDialog), dialog `copy mode needs a key`, `confirm stays disabled until the instance name is typed`, `shows the report after success`.
- [ ] **Step 2–4:** FAIL → implement → PASS (`npx vitest run --project web`).
- [ ] **Step 5:** Commit `feat(web): Backup tab and restore dialog`.

---

### Task 14: Help topic

**Files:** Create `apps/web/src/help/BackupHelp.tsx`; modify `apps/web/src/help/topics.tsx` (`backup: { title: 'Backing up and restoring CT Studio', body: <BackupHelp /> }`), `apps/web/src/help/index.ts` (`{ topic: 'backup', label: 'Backup and restore' }` after `published-outputs`); test `apps/web/test/BackupPage.test.tsx` (`the ? opens Backing up and restoring CT Studio`); `Help.test.tsx` and `HelpCenter.test.tsx` must pass unchanged.

The body, in user words (recipe, not template), with headings, covers in this order:
1. **What a backup holds**: the database (recipes, jobs, users, settings, ontologies), every stored file (uploads, outputs, run records, caches, internal publishing targets' files), the data-lake keys, the triple store. **Not included**: `deploy/.env`, the files on external publishing targets, the software itself.
2. **Encryption and the key**: the file is encrypted with a key made from `LLM_SECRETS_KEY`; it is useless without it; keep a copy of `deploy/.env` off the server; rotating the key (`LLM_SECRETS_KEY_PREVIOUS` still opens older backups).
3. **Making and downloading a backup**: background run, one kept on the server, jobs keep running, files added during it may be missing.
4. **Which restore to choose**: *as this deployment* (disaster recovery, same address on new hardware: copy `.env` first, deploy the same or newer version, sign in as the admin from the log); *as a copy* (production into staging).
5. **What a copy keeps and drops**: the `copyPlan()` lists, external targets made unusable and their deliveries hidden, recipes that may need a model choice or target (named in the report), graphs re-minted under this server's base IRI, embeddings refreshed for this server's model, jobs awaiting review kept.
6. **During and after a restore**: maintenance for everyone but admins, queue paused, the check before anything changes, typing the instance name, everyone signed out, the admin-from-the-log token rotated (see the API log), the report, the previous database kept (name in the report; how to drop it: `docker exec ingestion-postgres-1 dropdb -U <user> <name>`), resuming the queue and switching maintenance off.
7. **Moving to a new server, step by step**: back up → download → copy `deploy/.env` → deploy on the new server (`deploy/scripts/deploy.sh`) → sign in with the admin token from the log → Administration > Backup > Restore… as this deployment → check the report → resume the queue → switch maintenance off → point DNS.
8. **Size and space**: a restore needs room for the upload, a second copy of the database while it runs, and the files.

- [ ] **Step 1:** Write the placement test → FAIL. **Step 2:** Write the body, registry and index entries. **Step 3:** `npx vitest run --project web` → PASS.
- [ ] **Step 4:** Commit `docs(web): help for backup and restore`.

---

### Task 15: Docs and full check

**Files:** Create `docs/adr/0015-backup-and-restore.md` (decision: engine in the API, side database + rename swap, own framing + chunked GCM, HKDF of `LLM_SECRETS_KEY`, copy rules, Fuseki over GSP, identities via the filer; rejected: tar dependency, restoring into the live DB in place, including `.env`); modify `deploy/README.md` (backup section rewritten around the tab; the nightly Fuseki cron kept as an extra safety net), `docs/architecture.md` (one paragraph), `CLAUDE.md` (Commands table row; a *Backup and restore* rule of the road naming the key files; contract rows from Task 5), `deploy/.env.example` (new vars, Task 7)

- [ ] **Step 1:** Write the docs.
- [ ] **Step 2:** Run `npm run check` and `npm run worker:test` / `npm run worker:lint` → all green; run the Task 11 round trip once more.
- [ ] **Step 3:** Commit `docs: backup and restore`.
