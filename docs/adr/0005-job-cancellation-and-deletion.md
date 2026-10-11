# 0005 — Job cancellation and deletion

**Status:** accepted · 2026-10-11

## Context
Operators need to stop jobs (e.g. a wrong model on a slow local LLM) and to remove old jobs and
their files. The worker owns status transitions while a job runs.

## Decision
- New status `cancelled`, set by the API for queued/running jobs. The worker checks
  `is_cancelled` at safe points (before each step, before publishing or recording a result) and
  raises `JobCancelled`; every worker status write is guarded with `AND status = 'running'`, so a
  cancel always wins. An in-flight LLM call finishes first.
- Finished jobs (succeeded, failed, needs_review, rejected, cancelled) can be deleted: one DB
  transaction removes the job (cascading its history) and its document unless another job or a
  regression reference uses it; then internal files (drafts, `runs/{jobId}/`, the inbox PDF when
  no other document row shares it) are deleted best-effort. Published target copies and the OCR
  cache are kept.
- A run is identified by its claim (`jobs.locked_at`). `is_cancelled` and every worker status
  write require `status = 'running'` *and* that claim, so a job that was cancelled, deleted,
  retried or re-claimed stops its old run, whose late writes are no-ops. Outcome writes that fail
  because the job row was deleted are logged, never fatal. Drafts are recorded as soon as they are
  written so Delete can remove them.
- Retry of a cancelled job keeps its task (`publish`, `rerun`), so an approval or a re-run
  request survives Cancel → Retry; failed jobs still re-run processing.

## Consequences
- **Publishing cannot be undone by a cancel.** The last cancel check is just before publishing;
  a cancel that lands while files are being written to the final target only changes the status
  (the delivered files and their `published` rows remain, and Results shows them). Retry of such
  a job re-publishes over the same keys.
- Delete and bulk clean-up are destructive and, like every mutating route, assume the API is on a
  trusted network (the project has no auth layer).
- Contract change on both sides (enum value + `JOB_STATUSES`); Retry also re-queues cancelled
  jobs.
- Storage clean-up can leave orphaned files if S3 is down (logged), but never database rows that
  point at deleted files.
