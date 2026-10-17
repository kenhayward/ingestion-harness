# Backup and restore

Status: implemented, 2026-10-17 ([ADR 0015](../../adr/0015-backup-and-restore.md); see Deviations at the end). Owner: Ken Hayward.

## Why

Content Transformation Studio (CT Studio) has no way to capture a whole deployment. Today the only backup is Fuseki's
nightly N-Quads dump (`deploy/README.md`); Postgres and SeaweedFS are not backed up at all.
Three needs, one feature:

1. **Disaster recovery**: the server fails; rebuild the same deployment from the last backup.
2. **Server move**: the same endpoint (same address, same name) moves to new hardware.
3. **Production → staging**: refresh staging with real production data to test new features,
   while staging stays staging (its own address, identity, models and connections).

Not automated: an admin makes a backup by hand from the Administration dialog and restores one
the same way. Scheduling may come later; it is out of scope.

## Goals

- One backup file holds everything needed to recreate the deployment's *state* on another server,
  given the same `deploy/.env` (which the operator copies by hand).
- **Same backup, two restores**: *Restore as this deployment* and *Restore as a copy*.
- The file is encrypted end to end; it cannot be opened without the deployment's `LLM_SECRETS_KEY`.
- Works for production's expected size (under 10 GB in the medium term) through the browser.

## Non-goals

- Backing up `deploy/.env`, the images, or the code. The images are rebuilt or pulled from the
  version the manifest records; `.env` is copied manually.
- Backing up what external publishing targets hold (that data belongs to those systems).
- Scheduled or rotating backups, off-site upload, retention policies, data cleanup (cleanup to keep
  the size manageable is a separate, later piece of work).
- Merging two deployments. A restore replaces; it never merges.

## Anti-goals (a failure even if it "works")

- A staging copy that reaches production's outside world: delivering to production's external S3
  targets, pushing to GitHub as production's instance, calling paid models with production's keys,
  or keeping production's data-lake keys working.
- A backup that silently restores half: a wrong key, a tampered file, or a version mismatch must be
  refused **before anything is changed**.
- The encryption key inside the backup file.
- Jobs queued in production starting to run on staging the moment it comes up.

## What the stack's state is

All state lives in three Docker volumes plus `.env`:

| Store | Volume | In the backup |
| --- | --- | --- |
| Postgres 17 + pgvector | `postgres-data` | the whole database (`pg_dump`, custom format), embeddings included |
| SeaweedFS | `seaweedfs-data` | every object in the inbox, outputs and runs buckets, and in the bucket of every **internal** publishing target; the `lake-*` IAM identities (S3 keys for the data lake, ADR 0008) |
| Fuseki (profile `rdf`) | `fuseki-data` | an N-Quads dump of the dataset (the same thing `admin.sh backup` writes), when the `rdf` profile is on |
| `deploy/.env` | (host file) | **no**: copied by hand |

Left out: the backups bucket itself (below) and nothing else. Caches (`ocr-cache/`, `step-cache/`,
`prepared/`, `converted/`) are included: they are what makes re-runs and regressions identical, and
dropping them would change scores after a move. (Excluding caches to shrink the file is a possible
later option, not in this version.)

## The backup file

One file, `ct-backup-<instance>-<UTC timestamp>.ctbak`, made of:

1. A small **plaintext header**: a magic string and format version, the KDF salt, and the
   chunk size. Nothing about the content.
2. An **encrypted stream** of a tar archive:
   - `manifest.json`: format version; CT Studio version (`APP_VERSION`) and commit; the newest
     migration applied; the instance name (`github_sync_settings.instance_name`) and effective base IRI;
     when the backup started and finished and who made it; whether Fuseki was included; for every part a
     byte count and sha256; object counts per bucket.
   - `postgres.dump`
   - `objects/<bucket>/<key>` for every object (content type kept in a sidecar index
     `objects/index.jsonl`: bucket, key, size, sha256, content type).
   - `iam/lake-identities.json`: the `lake-*` identities and their policies, as SeaweedFS IAM
     returns them (their secrets are only in SeaweedFS, so they must be captured here).
   - `fuseki.nq.gz` (when included).

**Encryption.** The key is derived from `LLM_SECRETS_KEY` with HKDF-SHA256 (a random salt per file, the info
string `ct-backup v1`), so the key that encrypts stored secrets is never used directly for a second purpose.
The stream is AES-256-GCM in fixed-size chunks (for example 1 MiB), each with its own nonce
(a counter) and the chunk index and a last-chunk flag bound into the associated data, so chunks cannot
be reordered, dropped or truncated undetected. A file of any size streams in constant memory.
The exact framing is the builder's choice within those properties.

The file is useless without the `LLM_SECRETS_KEY` it was made under. The Backup tab says so plainly:
*keep a copy of `deploy/.env` somewhere other than this server, or this backup cannot be opened.*

## Making a backup

- Administration gets a **Backup** tab (admins only, like the other tabs; the tab's main button
  *Create backup* sits in the dialog header via `InSlot`, like *Add endpoint*).
- *Create backup* starts the work in the background and shows progress (phase: database, objects
  n of N, identities, triple store, encrypting; bytes written). When finished: size, time, who made it,
  and a **Download** link. Only the newest backup is kept on the server; making a new one deletes
  the old one once the new one succeeds. One backup at a time (a second *Create backup* while one
  runs is a 409).
- The finished file is stored in a dedicated SeaweedFS bucket `backups` (created like the others by
  `init-buckets`), never itself included in a backup. Download streams it from there.
- Jobs keep running during a backup. The Postgres dump is a consistent snapshot. Objects are read
  after the dump starts, so an object written during the backup may or may not be in it, and one
  deleted during it may be missing; the manifest records the start time and the restore reports (does
  not fail on) database rows whose object is missing.
- A failed backup leaves the previous one in place and shows the reason.

## Restoring

The Backup tab's **Restore…** opens a dialog:

1. **Upload** the file in parts (64 MiB each), resumable: an interrupted upload continues from the
   last part received, the browser keeping the upload id. Parts land in the `backups` bucket. The
   nginx limit is raised for the restore path only (as for bundle import), with
   `proxy_request_buffering off`.
2. **Choose the mode**: *Restore as this deployment* or *Restore as a copy*.
3. **Key**: as this deployment, the server's own `LLM_SECRETS_KEY` opens the file (then
   `LLM_SECRETS_KEY_PREVIOUS`, for a backup made before a rotation); as a copy, the admin pastes the key
   of the deployment the backup came from. The key is used for this restore only and never stored.
4. **Check**: the whole file is decrypted and verified (every chunk's tag, every part's sha256 against the
   manifest) **before anything is changed**. A wrong key, a damaged or altered file, or a backup from
   **newer** code than this server (a migration this server does not have) is refused here. The dialog
   then shows the manifest: instance, version, when, by whom, sizes, counts, and, as a copy, what will be
   dropped and kept.
5. **Confirm** by typing the instance name shown, since a restore replaces everything on this server.
6. **Run**:
   - turn on maintenance mode (existing feature: everyone but admins gets the maintenance page) and
     pause the worker (no job is claimed until the restore finishes and an admin resumes it);
   - replace the database, then run the migrations (a backup from older code is restored and migrated
     forward);
   - replace the bucket contents (inbox, outputs, runs, internal target buckets) and the `lake-*`
     identities;
   - replace the Fuseki dataset when the backup has one, else leave Fuseki to an `rdf_rebuild`
     (the result screen says so);
   - apply the copy rules (below) when restoring as a copy;
   - end every session and rotate the admin-from-the-log token, so everyone signs in again
     (the new token appears in the API log as on every start);
   - write a **restore report** (what was restored, counts, missing objects, what the copy rules did,
     recipes that will need attention).
7. **Afterwards**: maintenance stays on and the worker stays paused until an admin looks around and
   switches both back (the tab shows both, with the report).

Restore needs only a running stack and an admin: on a brand-new server that is the admin from
the log, signing in with the token the API prints on start.

The restore's own progress and report cannot live in the database it is replacing: they are kept
in the `backups` bucket (or another store outside Postgres) and read from there until it finishes.

## The two restore modes

### Restore as this deployment

Everything comes back as it was: users (passwords too), recipes and every version, Workbench
projects, jobs and their files, results, ontologies and embeddings, publishing targets with their
encrypted secrets, LLM endpoints, models, choices and settings with their encrypted keys, GitHub
settings, links, push records and users' linked accounts, data-lake consumers and their identities,
linked-data settings, published graphs. The instance name and base IRI are the backup's, so GitHub
sync and graph IRIs carry on. This server's `.env` must hold the same `LLM_SECRETS_KEY`, or the
stored secrets cannot be read (the check step catches this: the file would not open).

### Restore as a copy (production → staging)

The principle: **what a copy drops from the backup, it keeps from this server.** The things that
reach the outside world, or that define this deployment's identity, stay as this server has them;
everything else comes from the backup.

Kept from **this server** (staging), replacing the backup's:

- the whole LLM configuration: endpoints (and their keys), discovered and curated models, model
  choices, pipeline settings (`llm_endpoints`, `llm_models`, `llm_choices`, `llm_settings`,
  `llm_config_state`); staging's models are defined locally and stay;
- external publishing targets and their secrets;
- GitHub: `github_sync_settings` (instance name and root), and no GitHub links, push records or
  users' linked GitHub accounts from the backup;
- data-lake consumers and their `lake-*` identities;
- linked-data settings (the base IRI, so staging mints its own IRIs);
- maintenance settings.

Taken from **the backup** (production): users and their passwords (sign-ins work as in production),
profiles (minus GitHub), recipes, Workbench projects, jobs, results, documents, ontologies, internal
targets' bucket contents, published graph records, sign-in history.

Consequences the restore handles and reports:

- **Queued and running jobs** from the backup, of every task, do not run: the worker is paused after the restore, and
  jobs that were queued or running are cancelled as part of the copy (the report lists them), so an
  admin resuming the worker on staging does not process production's backlog.
- **Recipes naming a model choice staging lacks** run into the existing checks (a draft or publish
  shows the issue; a run goes to `needs_review`). The report lists them.
- **Publishing targets** (decided with the owner): **every external target of the backup is dropped.**
  None of production's external targets exists on the copy in any form an admin or a job can use:
  not listed, no credentials, nothing delivered to it. Delivery records that name one
  (`job_outputs.target_id`, `published_graph_versions`/`published_graphs`, `s3_consumer_targets`)
  are history of files that live outside staging; they are marked withdrawn (`withdrawn_at`), so
  Results and readers skip them, and the target rows themselves are removed if the foreign keys allow it,
  else kept hidden and inert (the builder's call). A recipe still naming a dropped id gets the existing
  `no publishing target <id>` issue and, at run time, `needs_review`. Staging's own targets stay as
  they are. On an **id both have** (`default` above all) staging's row wins: production's delivery
  records keep the id, and, if that row is internal, production's objects for it are written into
  staging's bucket and prefix under the same keys (if staging's row is external, they are not copied
  anywhere and the records are marked withdrawn as above). An **internal** target only production has
  comes across as it is (a bucket in staging's own SeaweedFS), with its objects.
- **The triple store** (decided with the owner): production's graphs are loaded and then **re-minted**
  under staging's base IRI (`rdf_rebuild --remint`, after the copy rules), so they show on staging's
  Linked data panel with staging's IRIs.
- **Jobs awaiting review** from the backup stay, so review can be tested; approving one delivers
  under the target rules above. `withdraw` jobs naming a dropped target are cancelled with the rest.
- **Ontology embeddings**: production's vectors are kept; `embed` jobs are queued for staging's own
  embedding model (they run once the worker is resumed).
- **Encrypted secrets that are kept from the backup**: none are, by the rules above (all of them live
  in the LLM config, external targets and GitHub tokens). If a later change adds one, the copy
  re-encrypts it from the backup's key to this server's key.

## Constraints

- Postgres 17 + pgvector (`ingestion-postgres:17-pgvector-0.8.0`); `pg_dump`/`pg_restore` of the
  same major version must be available wherever backup and restore run.
- SeaweedFS 4.48 (exact pin); IAM through its embedded IAM on the S3 port (as the S3 key issuer).
- Fuseki only when the `rdf` profile is on.
- Migrations are forward-only and timestamp-named (ADR 0014); a restore from older code migrates forward.
- Every new route is documented (OpenAPI), admin-only, covered by the access sweeps; operators reach none.
- **Help (asked for by the owner):** a detailed help topic for the Backup tab, opened by the `?`
  in the tab (`TabHelp`, as on the other Administration tabs) and listed in the Help panel
  (`HELP_INDEX`, under Administration). Written in user words, it explains: what a backup holds and
  what it does not (`.env`, external targets' data); that the file is encrypted with a key from
  `LLM_SECRETS_KEY` and is useless without a copy of `.env` kept off the server; how to make and
  download one; the two restore modes and when to use each (disaster recovery and server move vs.
  production → staging); exactly what a copy keeps from this server and what it drops from the backup
  (external targets, GitHub, model configuration, data-lake keys, base IRI, re-minted graphs, cancelled
  jobs); what happens during and after a restore (maintenance, paused worker, sessions ended, the log
  admin's new token, the report, resuming); and a step-by-step for moving to a new server.
- Unit tests stay offline (ports and adapters: the backup writer and reader over fake stores); the real
  round trip (Postgres + SeaweedFS + Fuseki) is an integration test against dev-infra.
- The deploy README's backup section is rewritten around this feature (the Fuseki cron stays as an
  extra safety net, or is removed: builder's call).

## Decided with the owner

- One backup format, two restore modes.
- Copy mode drops GitHub connections, external S3 targets and external model keys, keeps user
  accounts, and keeps this server's own versions of everything it drops (its model definitions especially).
- The encryption key stays in `.env` only; the whole file is encrypted with a key from
  `LLM_SECRETS_KEY`; a copy restore asks for the source deployment's key.
- Expected size under 10 GB; cleanup is later work.
- A copy restore replaces staging's own data (except what the copy keeps).
- A copy drops every external publishing target of the backup; staging keeps its own.
- A copy re-mints production's graphs under staging's base IRI.

## Calls made in this design (not yet confirmed by the owner)

- Upload in resumable 64 MiB parts rather than one request or a file copied onto the server.
- Only the newest backup is kept on the server, in a `backups` bucket.
- Caches are included.
- Every session ends and the log admin's token rotates after any restore.
- Maintenance mode and a paused worker after a restore, until an admin switches them off.
- Copy mode also keeps data-lake consumers, linked-data and maintenance settings from this server,
  and cancels the backup's queued and running jobs.
- Confirm a restore by typing the instance name.
- On a target id both deployments have, staging's row wins.
- Maintenance is gated outside Postgres for the whole restore and forced on after the database swap
  (overriding the backup's maintenance row), so non-admins never reach a half-restored API.
- The admin running the restore follows it with a restore-scoped token held outside Postgres
  (valid for that restore only), then signs in again to read the report in the app.
- Copy: jobs awaiting review stay; production's embeddings are kept and `embed` jobs queued for staging's model.

## Left to the builder

- Where backup and restore run (the API process with `pg_dump` in its image, the worker as a
  document-less job, or a separate one-shot service), as long as restore does not depend on the
  database it replaces and the API stays up to show progress.
- How the worker is paused (a flag outside the replaced data, or stopping the claim loop).
- The encryption framing within the properties above; the archive layout details.
- The data model for production's external targets kept as non-delivering rows in a copy.
- How the restore treats objects in this server's buckets that the backup does not have (deleted, so
  the buckets equal the backup's, is the expected result).

## Deviations

What the build did differently from this design:

- **Data-lake identities are not backed up.** SeaweedFS 4.48 keeps one file per identity and a filer write breaks its IAM, so a backup carries none; a restore reports the consumers whose keys must be re-issued (`SEAWEEDFS_FILER_URL` was not added).
- **Triple store through Graph Store Protocol.** Whole-dataset GET and PUT on `/{dataset}/data` worked on Fuseki 6.2.0, so the `rdf_rebuild` fallback is used only for a copy's re-minted graphs.
- **Target objects keep their recorded bucket names in a copy**, so every recorded `job_outputs` key still resolves; the cost is unused objects on staging for ids staging has as external.
- **Side database and rename swap**, with running jobs given up to 2 minutes before they are cancelled, and the queue paused (`queue_control`) rather than the worker stopped.
- **A checked restore expires after 30 minutes** (drops the decrypted key, frees the lock); *Cancel restore* does the same.
- **A copy keeps no secret from the backup** (`applyCopyRules` has no `secretsFrom`/`secretsTo`); maintenance is not a kept table, the restore forces it on with its message.
- **`status()` also returns `lastSucceeded`**, so a failed backup leaves the previous one downloadable.
