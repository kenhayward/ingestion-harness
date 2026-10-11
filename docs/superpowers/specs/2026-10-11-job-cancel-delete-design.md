# Cancel and delete jobs: design

Date: 2026-10-11 · Status: approved in conversation (sections 1–3)

## Goal

From the Jobs tab, operators can **cancel** queued or running jobs and **delete** finished
jobs, one at a time or in bulk by age, without leaving orphaned records or internal files.
Published copies in the final target are never touched.

## 1. `cancelled` status and stopping running jobs

- **Contract.** Migration `0006_cancel.sql` adds `cancelled` to the `job_status` enum. Add it
  to `JOB_STATUSES` (`packages/shared/src/jobs.ts`) in the same PR, and document it in the
  worker's `queue.py`. *(Ruling: no `cancelled_at` column. The status, `updated_at` and a
  `job_events` row record the cancel, so YAGNI.)*
- **Cancel queued:** `UPDATE jobs SET status='cancelled' … WHERE id=$1 AND status IN
  ('queued','running')` clears the lock and records a `job_events` row. The worker claims only
  `queued` rows with `FOR UPDATE SKIP LOCKED`, so it never starts a cancelled job.
- **Cancel running:** the same update. The worker calls `queue.is_cancelled(job_id)` at safe
  points:
  - before each spec extraction or template step;
  - before publishing to the target;
  - before recording the result (complete / await_review).

  When it sees the cancel it raises `JobCancelled`. `run_once` then logs a `cancelled` event and
  writes no status. An LLM call that has already started still finishes. Drafts already written
  stay until the job is deleted.
- **Guards:** every worker status write (`_finish`, `fail` re-queue, `await_review`, `complete`)
  only applies `WHERE status='running'`. `complete` and `await_review` record their outputs only
  when that update matched, so a late cancel cannot be undone.
- **Retry** also applies to `cancelled` jobs (re-queued as `process`, attempts reset).

## 2. Deleting jobs

- **Deletable statuses:** `succeeded`, `failed`, `needs_review`, `rejected`, `cancelled`.
  Queued, running and awaiting_review jobs return 409; cancel or review them first.
- **In one DB transaction:**
  - Delete the job row. This cascades to `job_events`, `job_outputs`, `review_edits` and
    `step_runs`; `template_references.source_job_id` is set to NULL.
  - Delete its document row, unless another job uses the document or a
    `template_references.document_id` points at it.
- **Afterwards, best effort (failures are logged, never fatal):**
  - Delete the job's draft outputs (`job_outputs` with `stage='draft'`) from the internal store.
  - Delete everything under `{jobId}/` in the runs bucket (audit, page previews, reviewed
    document).
  - Delete the inbox PDF, but only if the document row was deleted and no remaining document row
    has the same `(bucket, object_key)`. Regression jobs share a reference's PDF.
- **Kept:**
  - published outputs in the final target;
  - the OCR cache (`runs/ocr-cache/…`, keyed by PDF sha256 and shared across jobs).
- **`ObjectStore` port:** `delete(bucket, key)` and `deletePrefix(bucket, prefix)`. In S3,
  `deletePrefix` uses `ListObjectsV2` pages and `DeleteObjects`. Both methods are also added to
  `MemoryObjectStore`.
- **API:**
  - `POST /api/jobs/:id/cancel` returns the `JobSummary` with 200, 409 when the job isn't queued
    or running, and 404 when it doesn't exist.
  - `DELETE /api/jobs/:id` returns 204, or 409 / 404.
  - `POST /api/jobs/cleanup {olderThanDays: int 1..3650, dryRun: boolean}` acts on finished jobs
    whose `updated_at` is older than the cutoff. It returns `{count}` when `dryRun` is true and
    `{deleted}` otherwise.

## 3. Jobs tab UI

- **Row actions:**
  - **Cancel** for `queued` and `running` jobs.
  - **Delete** for the finished statuses.
  - **Retry** for `failed`, `needs_review` and `cancelled` jobs.
  - **Review** stays as it is for `awaiting_review`.
- **Inline confirmation instead of browser dialogs:**
  - Delete becomes `Delete a.pdf? [Confirm] [Keep]`, with the note "Published copies in the
    target are kept."
  - Cancel becomes `Cancel job? [Confirm] [Keep]`.
- **Bulk cleanup** (under the table): "Delete finished jobs older than [30] days" with a
  **Preview** button.
  - Preview does a dry run and shows "N jobs will be deleted (published copies are kept)" with
    **Delete N jobs** and **Keep**.
  - When nothing matches it shows "No finished jobs older than N days."
- **Refresh and errors:** every action refreshes the list straight away. Errors show as alerts
  in the row, or under the cleanup controls for the bulk action.
- **Styling:** a `cancelled` status style (grey).

## Testing (written first)

- **Worker** (`FakeQueue`):
  - a cancel during the pipeline stops before the next step, with no further LLM calls and no
    status written;
  - a cancel before publishing means nothing reaches the target;
  - a `cancelled` event is recorded.
- **PgJobQueue guards:** an integration test marked `@pytest.mark.integration`.
- **API** (`MemoryRepo` + `MemoryObjectStore`):
  - cancel status rules;
  - delete status rules;
  - which storage is deleted and which is kept;
  - the shared-PDF and reference-kept cases;
  - cleanup with a dry run, and a validation 400;
  - retry of a cancelled job.
- **S3 store:** the delete methods, tested against a stub client.
- **Web** (`fakeApi`):
  - which buttons each status gets;
  - confirm and keep flows;
  - bulk preview, delete, and the empty message;
  - error alerts.

## Out of scope

Cancelling `awaiting_review` jobs (use Reject), deleting published target copies, and automatic
retention policies.
