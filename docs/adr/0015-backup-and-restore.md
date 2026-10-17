# 0015: Backup and restore from the Administration dialog

**Status:** accepted · 2026-10-17 · [design](../superpowers/specs/2026-10-17-backup-and-restore-design.md)

## Context
The only backup was Fuseki's nightly N-Quads dump. Postgres (recipes, jobs, users, settings,
ontologies, embeddings) and SeaweedFS (uploads, outputs, run records, internal publishing targets)
were not backed up at all. Three needs: disaster recovery, moving a deployment to new hardware,
and refreshing staging with production's data while staging stays staging.

## Decision
- **The engine lives in the API** (`apps/api/src/backup/`), driven from Administration > Backup
  by an admin; nothing is scheduled. It reaches the stores through ports (`ports.ts`) so the unit
  tests need no infrastructure.
- **One file, `.ctbak`, with our own framing** (`archive.ts`: entries `[u32 header length][JSON
  {name,size}][bytes]`, manifest last) inside **chunked AES-256-GCM** (`crypto.ts`: 1 MiB frames,
  nonce = chunk index, associated data = index and a final flag, so reordering, dropping or
  truncating a chunk fails). The key is **HKDF of `LLM_SECRETS_KEY`** with a random salt per file;
  `LLM_SECRETS_KEY_PREVIOUS` still opens older backups. Encrypted columns therefore stay readable
  after a restore of the same deployment, and the file is useless without `deploy/.env`.
- **Contents:** a `pg_dump` of the database, every object of the inbox, outputs and runs buckets
  and of internal publishing targets' buckets, and the whole Fuseki dataset through the Graph
  Store Protocol (`fuseki.ts`: `GET /{dataset}/data` without `?graph` returns every graph as
  N-Quads, `PUT` replaces them; checked against Fuseki 6.2.0). Only the newest successful backup
  is kept, in a backups bucket (`S3_BUCKET_BACKUPS`) that is never itself backed up.
- **Restore checks everything first** (`check.ts`: key, every frame, the manifest, the schema
  version against this build's) and only then asks the admin to type the instance name. A checked
  restore not confirmed in 30 minutes expires, so the pasted key does not stay in memory.
- **A side database and a rename swap** (`restore-pg.ts`): the dump is restored into a second
  database, the copy rules run there, and the databases are renamed at the end. A failure before
  the swap leaves this server's database as it was; the previous one is kept under a name in the
  report. The restore pauses the job queue (`queue_control`, migration 202610171218; a claim query
  skips while paused), turns maintenance mode on, gives running jobs 2 minutes and cancels the
  rest. Afterwards sessions end, the admin-from-the-log token is rotated, and the queue stays
  paused and maintenance on until an admin resumes them.
- **Two modes.** *As this deployment* restores everything. *As a copy* (`copy-rules.ts`) keeps this
  server's model endpoints, choices and settings, publishing targets, GitHub settings, linked-data
  settings and data-lake consumers; drops the backup's GitHub links and tokens and its external
  targets (kept inert for the foreign keys, `inert_at`, their deliveries hidden as withdrawn);
  cancels queued and running jobs; queues embedding jobs; and queues one `rebuild` job that
  re-mints the graphs under this server's base IRI. Objects of internal targets keep their
  recorded bucket names in a copy, so every recorded `job_outputs` key still resolves.
- **Data-lake identities are not restored.** SeaweedFS 4.48 keeps one file per identity and a
  filer write breaks its IAM, so a backup carries none (`NoLakeIdentities`); the report lists the
  consumers whose keys must be re-issued after a move to a new server.
- **Uploads for restore** go in 64 MB parts into the backups bucket (`uploads.ts`), resumable by
  choosing the same file again.

## Rejected
- **A tar dependency** for the container: the framing is thirty lines and streams in both
  directions.
- **Restoring into the live database in place:** a failure half way would leave a mixture of two
  deployments; the side database makes the swap the only step that changes anything.
- **Including `deploy/.env`:** it holds the key that opens the file and every other secret, so
  the backup would open itself. The admin keeps `.env` elsewhere.
- **Encrypting with a password typed per backup:** one more thing to lose; the key already has to
  be kept safe.

## Consequences
- A backup is useless without the `LLM_SECRETS_KEY` it was made under; copying a production backup
  to staging means pasting production's key (never stored).
- Files on external publishing targets, the software and `.env` are outside the backup.
- A restore needs space for the uploaded file, a second copy of the database while it runs (and
  the kept previous one) and the files.
- Files added while a backup runs may be missing; the restore report lists them.
