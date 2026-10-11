# Cancel and Delete Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators cancel queued or running jobs and delete finished jobs (one at a time, or in bulk by age) from the Jobs tab.

**Architecture:**
- A new `cancelled` job status: a DB enum value, mirrored in the TS and Python contracts.
- The worker checks for a cancel at safe points and raises `JobCancelled`. Its status writes are guarded with `AND status='running'`.
- The API adds cancel, delete and cleanup routes. Deletion runs in a DB transaction, followed by best-effort removal of internal files through new `ObjectStore.delete`/`deletePrefix` methods.
- The web Jobs table gets inline-confirmed row actions and a bulk-cleanup panel.

**Tech Stack:** Python 3.13 worker (psycopg, pytest, mypy --strict); Fastify + Zod 3 API; React + Vitest + Testing Library; Postgres migrations.

**Spec:** `docs/superpowers/specs/2026-10-11-job-cancel-delete-design.md`

## Global Constraints

- TDD: write each test first, watch it fail, then implement.
- Unit tests stay offline. Pg-only behaviour gets `@pytest.mark.integration` tests, which are excluded by default.
- Cross-language contract: add `cancelled` to `db/migrations/0006_cancel.sql`, `packages/shared/src/jobs.ts` and the worker docs, in the same PR.
- Migrations are forward-only. Python code uses `from __future__ import annotations` and must pass mypy --strict and ruff. TypeScript uses ESM `.js` suffixes and Zod at every boundary.
- Deletable statuses are exactly: `succeeded`, `failed`, `needs_review`, `rejected`, `cancelled`.
- Never delete published target copies or the OCR cache.
- Worker commands run as `cd worker && python -m uv run …` locally (`uv` is installed via pip).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A cancel arrives after the last checkpoint but before `complete` or `await_review`.** The guarded UPDATE matches no row, so no outputs are recorded and the status stays `cancelled`. Pinned by the Pg integration test in Task 1, and in `FakeQueue` by making `complete` honour cancellation.
2. **A regression job's PDF is shared with its reference document.** Deleting the regression job must keep the inbox object. Pinned in Task 4.
3. **The job's document is used by a reference.** The document row and its PDF are kept, while the job row is deleted. Pinned in Task 4.
4. **Storage deletion fails** (the S3 endpoint is down). The DB delete still succeeds, the API returns 204, and the failure is logged. Pinned in Task 4 with `UnreachableStore`-style failing deletes.
5. **Bulk cleanup with a zero or invalid number of days, or nothing matching.** Invalid input returns 400. A zero match returns `count: 0`, and the UI shows "No finished jobs older than N days." Pinned in Tasks 4 and 6.

---

### Task 1: Worker cancellation

**Files:**
- Modify: `worker/src/ingest_worker/queue.py` (protocol `is_cancelled`, PgJobQueue guards), `worker/src/ingest_worker/pipeline.py` (`JobCancelled`, `check_cancelled`, checkpoints in the spec loop), `worker/src/ingest_worker/template_pipeline.py` (checkpoint in the step loop), `worker/src/ingest_worker/main.py` (checkpoints before publish/record, catch `JobCancelled`), `worker/tests/fakes.py`
- Test: `worker/tests/test_cancel.py`, `worker/tests/test_queue_integration.py`

**Interfaces:**
- Produces: `JobQueue.is_cancelled(job_id: str) -> bool`; `pipeline.JobCancelled(Exception)`; `pipeline.check_cancelled(job, queue) -> None`; `FakeQueue.cancel_when: Callable[[], bool] | None`.

- [ ] **Step 1: Add the fake hook and write the failing tests**

In `worker/tests/fakes.py`, add `from collections.abc import Callable` to the imports and a field to `FakeQueue`:

```python
    #: Simulates an operator cancel: is_cancelled() returns cancel_when() for every job.
    cancel_when: Callable[[], bool] | None = None

    def is_cancelled(self, job_id: str) -> bool:
        return bool(self.cancel_when and self.cancel_when())
```

```python
# worker/tests/test_cancel.py
"""Operator cancellation: the worker stops at safe points and never writes a status."""

from __future__ import annotations

from pathlib import Path

from ingest_worker.main import run_once

from .fakes import FakeQueue
from .test_template_db import make
from .test_template_pipeline import JOB, TEMPLATE


def test_cancel_during_the_pipeline_stops_before_the_next_step(tmp_path: Path) -> None:
    deps, provider, target = make(tmp_path)
    queue = FakeQueue(
        jobs=[JOB],
        templates={("demo", 1): TEMPLATE},
        cancel_when=lambda: len(provider.calls) >= 1,
    )
    assert run_once(queue, deps, "w1") is True
    first_step_calls = len(provider.calls)
    assert 1 <= first_step_calls < 4  # the remaining steps never ran
    assert not (queue.awaiting or queue.completed or queue.reviewed or queue.failed)
    assert (JOB.id, "warn", "cancelled") in queue.events


def test_cancel_before_publishing_delivers_nothing(tmp_path: Path) -> None:
    deps, provider, target = make(tmp_path)
    no_review = {**TEMPLATE, "review": {"required": "never"}}
    queue = FakeQueue(
        jobs=[JOB],
        templates={("demo", 1): no_review},
        cancel_when=lambda: len(provider.calls) >= 4,  # all steps ran
    )
    run_once(queue, deps, "w1")
    assert len(provider.calls) == 4
    assert target.objects == {}
    assert not (queue.completed or queue.published or queue.failed)
    assert (JOB.id, "warn", "cancelled") in queue.events


def test_jobs_that_are_not_cancelled_run_normally(tmp_path: Path) -> None:
    deps, provider, _ = make(tmp_path)
    queue = FakeQueue(jobs=[JOB], templates={("demo", 1): TEMPLATE}, cancel_when=lambda: False)
    run_once(queue, deps, "w1")
    assert queue.awaiting
```

Check first that `MemoryObjectStore` exposes `objects` (it does: `self.objects[(bucket, key)]`) and that `TEMPLATE` accepts `review.required: never`. If the template schema differs, set the field the way `test_template_db.test_test_runs_are_never_published` does.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `cd worker && python -m uv run pytest tests/test_cancel.py -q`
Expected: FAIL. The first two tests run to completion (awaiting/published is set) and no `cancelled` event is recorded.

- [ ] **Step 3: Implement**

`pipeline.py`, after `class DocumentError`:

```python
class JobCancelled(Exception):
    """An operator cancelled the job: stop at the next safe point, write no status."""


def check_cancelled(job: ClaimedJob, queue: JobQueue) -> None:
    """Safe point between LLM calls / before side effects."""
    if queue.is_cancelled(job.id):
        raise JobCancelled(job.id)
```

In the spec loop (`for ex in spec.extractions:`), make `check_cancelled(job, queue)` the first statement of the body. In `template_pipeline.py`, do the same in the process loop `for step in template.pipeline:`. Import `check_cancelled` from `.pipeline` alongside the existing imports.

`queue.py`, in the `JobQueue` protocol after `claim`:

```python
    def is_cancelled(self, job_id: str) -> bool:
        """True once an operator cancelled the job (status 'cancelled')."""
        ...
```

`PgJobQueue`:

```python
    def is_cancelled(self, job_id: str) -> bool:
        row = self._conn.execute("SELECT status FROM jobs WHERE id = %s", (job_id,)).fetchone()
        return row is not None and row[0] == "cancelled"
```

Guard every status write. A cancel committed by the API must win:
- `complete`: inside the transaction, call `if not self._finish(job.id, "succeeded", None): return` **before** `_record_outputs`.
- `await_review`: run the UPDATE with `AND status = 'running'` first; return when its `rowcount` is 0, then record outputs.
- `fail` (re-queue branch): add `AND status = 'running'` to its WHERE clause.
- `_finish` returns `bool`, and its SQL ends `WHERE id = %s AND status = 'running'`:

```python
    def _finish(self, job_id: str, status: str, error: str | None) -> bool:
        cur = self._conn.execute(
            """UPDATE jobs SET status = %s, error = %s, locked_by = NULL, locked_at = NULL,
                      updated_at = now() WHERE id = %s AND status = 'running'""",
            (status, error, job_id),
        )
        return cur.rowcount > 0
```

Extend the module docstring with one line: "Statuses: queued, running, succeeded, failed, needs_review, awaiting_review, rejected, cancelled (operator; the worker never overwrites it)."

`main.py`:
- import `JobCancelled, check_cancelled` from `.pipeline`;
- add `check_cancelled(job, queue)` immediately before each `queue.complete(...)` and `queue.await_review(...)`;
- add `check_cancelled(job, queue)` immediately before `publish_outputs(...)` in the no-review branch, and before `publish_job(...)` in the publish task;
- add a first `except` clause in `run_once`:

```python
    except JobCancelled:
        log.info("job %s cancelled by an operator", job.id)
        queue.event(job.id, "warn", "cancelled")
        return True
```

The `else:` branch of the try calls `check_cancelled`, which can raise. So move the no-review publish/complete code **inside** the `try` (after `result = process_job(...)`), and keep the `except` clauses after it. Rewrite `run_once` so every `check_cancelled` call sits inside the `try`.

- [ ] **Step 4: Write the Pg guard integration test** (excluded by default; runs against dev-infra)

```python
# worker/tests/test_queue_integration.py
"""PgJobQueue against a real Postgres (deploy/scripts/dev-infra up). Excluded by default."""

from __future__ import annotations

import os
import uuid

import pytest

from ingest_worker.queue import ClaimedJob, PgJobQueue

pytestmark = pytest.mark.integration


@pytest.fixture
def queue_and_job():  # type: ignore[no-untyped-def]
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL not set")
    q = PgJobQueue(url)
    doc, job = str(uuid.uuid4()), str(uuid.uuid4())
    q._conn.execute(
        """INSERT INTO documents (id, filename, sha256, size_bytes, spec_id, spec_version, bucket, object_key)
           VALUES (%s, 'a.pdf', 'x', 1, 'demo', 1, 'inbox', %s)""",
        (doc, f"demo/v1/{doc}.pdf"),
    )
    q._conn.execute(
        "INSERT INTO jobs (id, document_id, status) VALUES (%s, %s, 'running')", (job, doc)
    )
    claimed = ClaimedJob(job, doc, "demo", 1, "inbox", f"demo/v1/{doc}.pdf", None, 1, 3)
    yield q, claimed
    q._conn.execute("DELETE FROM documents WHERE id = %s", (doc,))
    q.close()


def test_a_cancel_wins_over_late_worker_writes(queue_and_job) -> None:  # type: ignore[no-untyped-def]
    q, job = queue_and_job
    q._conn.execute("UPDATE jobs SET status = 'cancelled' WHERE id = %s", (job.id,))
    assert q.is_cancelled(job.id)
    q.complete(job, [], "outputs")
    q.needs_review(job, "x")
    q.fail(job, "x")
    q.await_review(job, [], "outputs", ["r"])
    row = q._conn.execute("SELECT status FROM jobs WHERE id = %s", (job.id,)).fetchone()
    assert row is not None and row[0] == "cancelled"
```

Before relying on the INSERT columns, check them against `db/migrations/0001_init.sql`, and adjust the column names to match.

- [ ] **Step 5: Run and confirm everything passes**

Run: `cd worker && python -m uv run pytest -q` (all tests; integration tests are deselected) and `python -m uv run ruff check . && python -m uv run ruff format --check . && python -m uv run mypy src`
Expected: PASS and clean. Integration test: run it only when dev-infra is up; otherwise record that in the ledger.

- [ ] **Step 6: Commit**

```bash
git add worker
git commit -m "Worker: stop cancelled jobs at safe points; guard status writes" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: `cancelled` status, cancel and retry in the API

**Files:**
- Create: `db/migrations/0006_cancel.sql`
- Modify: `packages/shared/src/jobs.ts`, `apps/api/src/repositories/{types,memory,pg}.ts`, `apps/api/src/routes/jobs.ts`
- Test: `apps/api/test/jobs.test.ts`

**Interfaces:**
- Produces: `IngestionRepo.cancelJob(id: string): Promise<JobSummary | null>` (null = not queued/running or unknown); `POST /api/jobs/:id/cancel`; `retryJob` also accepts `cancelled`.

- [ ] **Step 1: Write the failing tests** (add a `describe('job cancellation', …)` to `apps/api/test/jobs.test.ts`)

```ts
describe('job cancellation', () => {
  it('cancels queued and running jobs and records an event', async () => {
    const { app, repo, job } = await seedJob();
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: job.id, status: 'cancelled' });
    expect(repo.events.get(job.id)?.at(-1)).toMatchObject({ level: 'warn', message: 'cancelled' });

    const running = (await seedJob());
    running.repo.jobs.set(running.job.id, { ...running.repo.jobs.get(running.job.id)!, status: 'running' });
    expect(
      (await running.app.inject({ method: 'POST', url: `/api/jobs/${running.job.id}/cancel` })).json(),
    ).toMatchObject({ status: 'cancelled' });
  });

  it.each(['succeeded', 'failed', 'needs_review', 'awaiting_review', 'rejected', 'cancelled'] as const)(
    'refuses to cancel a %s job',
    async (status) => {
      const { app, repo, job } = await seedJob();
      repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status });
      const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
      expect(res.statusCode).toBe(409);
    },
  );

  it('404s for unknown jobs', async () => {
    const { app } = await testApp();
    expect((await app.inject({ method: 'POST', url: `/api/jobs/${crypto.randomUUID()}/cancel` })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: '/api/jobs/nope/cancel' })).statusCode).toBe(404);
  });

  it('retries a cancelled job', async () => {
    const { app, job } = await seedJob();
    await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/cancel` });
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'queued', task: 'process', attempts: 0 });
  });
});
```

`MemoryRepo` has no events store yet. Add `readonly events = new Map<string, { level: string; message: string }[]>();` and push to it in `cancelJob`.

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run --project api apps/api/test/jobs.test.ts`
Expected: FAIL. The cancel route returns 404 and retry of a cancelled job returns 409.

- [ ] **Step 3: Implement**

`db/migrations/0006_cancel.sql`:

```sql
-- Operators can cancel queued/running jobs. The worker checks for the status at safe points and
-- never overwrites it (all worker status writes are guarded with AND status = 'running').
-- (ADD VALUE inside a transaction is fine on PG >= 12 as long as the value isn't used in it.)
ALTER TYPE job_status ADD VALUE IF NOT EXISTS 'cancelled';
```

`packages/shared/src/jobs.ts`: append `'cancelled',` to `JOB_STATUSES`, and add the exported constant:

```ts
/** Finished jobs: these can be deleted (queued/running must be cancelled, review decided). */
export const DELETABLE_STATUSES: readonly JobStatus[] = [
  'succeeded',
  'failed',
  'needs_review',
  'rejected',
  'cancelled',
];
```

`types.ts`, in `IngestionRepo`:

```ts
  /** queued/running -> cancelled (+ event). Null if unknown or not cancellable. */
  cancelJob(id: string): Promise<JobSummary | null>;
```

`memory.ts`:

```ts
  readonly events = new Map<string, { level: string; message: string }[]>();

  async cancelJob(id: string): Promise<JobSummary | null> {
    const job = this.jobs.get(id);
    if (!job || (job.status !== 'queued' && job.status !== 'running')) return null;
    this.events.set(id, [...(this.events.get(id) ?? []), { level: 'warn', message: 'cancelled' }]);
    return this.update(id, { status: 'cancelled' });
  }
```

Also change `retryJob`'s status check to `!['failed', 'needs_review', 'cancelled'].includes(job.status)`.

`pg.ts`:

```ts
  async cancelJob(id: string): Promise<JobSummary | null> {
    const { rowCount } = await this.pool.query(
      `WITH cancelled AS (
         UPDATE jobs SET status = 'cancelled', locked_by = NULL, locked_at = NULL, updated_at = now()
          WHERE id = $1 AND status IN ('queued', 'running')
          RETURNING id)
       INSERT INTO job_events (job_id, level, message) SELECT id, 'warn', 'cancelled' FROM cancelled`,
      [id],
    );
    return rowCount ? await this.getJob(id) : null;
  }
```

Also change retry's `status IN ('failed', 'needs_review')` to `('failed', 'needs_review', 'cancelled')`. `getJob` returns `JobDetail`, which is a `JobSummary` with outputs. Strip it in the route the way the retry route does today (check `routes/jobs.ts`; retry returns `job`).

`routes/jobs.ts`, after retry:

```ts
  app.post<{ Params: { id: string } }>('/jobs/:id/cancel', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return reply.code(404).send({ error: 'not found' });
    if (!(await app.deps.repo.getJob(req.params.id))) return reply.code(404).send({ error: 'not found' });
    const job = await app.deps.repo.cancelJob(req.params.id);
    return job ?? reply.code(409).send({ error: 'only queued or running jobs can be cancelled' });
  });
```

- [ ] **Step 4: Run and confirm they pass**

Run: `npx vitest run --project api` then `npm run typecheck`
Expected: PASS and clean. Fix any exhaustive `JobStatus` switch or record the typecheck flags, e.g. CSS class maps or `metrics.ts`.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0006_cancel.sql packages/shared apps/api
git commit -m "Add cancelled job status; API cancel route and retry of cancelled jobs" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: `ObjectStore.delete` / `deletePrefix`

**Files:**
- Modify: `apps/api/src/storage/object-store.ts`, `apps/api/src/storage/s3.ts`
- Test: `apps/api/test/s3.test.ts`, `apps/api/test/object-store.test.ts`

**Interfaces:**
- Produces: `ObjectStore.delete(bucket: string, key: string): Promise<void>`, `ObjectStore.deletePrefix(bucket: string, prefix: string): Promise<number>` (number of objects deleted); `S3ObjectStore` constructor `(opts: S3Options, client?: Pick<S3Client, 'send'>)`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/test/object-store.test.ts
import { describe, expect, it } from 'vitest';
import { MemoryObjectStore } from '../src/storage/object-store.js';

describe('MemoryObjectStore deletes', () => {
  it('deletes one key and everything under a prefix (in that bucket only)', async () => {
    const s = new MemoryObjectStore();
    for (const key of ['j1/a.json', 'j1/pages/p1.jpg', 'j10/a.json'])
      await s.put('runs', key, Buffer.from('x'), 'application/json');
    await s.put('other', 'j1/a.json', Buffer.from('x'), 'application/json');
    expect(await s.deletePrefix('runs', 'j1/')).toBe(2);
    expect(await s.get('runs', 'j10/a.json')).not.toBeNull();
    expect(await s.get('other', 'j1/a.json')).not.toBeNull();
    await s.delete('runs', 'j10/a.json');
    await s.delete('runs', 'missing'); // no error
    expect(await s.get('runs', 'j10/a.json')).toBeNull();
  });
});
```

Append to `apps/api/test/s3.test.ts`:

```ts
import { DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { vi } from 'vitest';
import { S3ObjectStore } from '../src/storage/s3.js';

const opts = { endpoint: 'http://s3', region: 'r', accessKeyId: 'a', secretAccessKey: 's' };

describe('S3ObjectStore deletes', () => {
  it('deletes a single key', async () => {
    const send = vi.fn(async () => ({}));
    await new S3ObjectStore(opts, { send } as never).delete('b', 'k');
    expect(send.mock.calls[0]![0]).toBeInstanceOf(DeleteObjectCommand);
    expect((send.mock.calls[0]![0] as DeleteObjectCommand).input).toEqual({ Bucket: 'b', Key: 'k' });
  });

  it('lists every page under a prefix and deletes in batches', async () => {
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof ListObjectsV2Command) {
        return cmd.input.ContinuationToken
          ? { Contents: [{ Key: 'j1/c' }], IsTruncated: false }
          : { Contents: [{ Key: 'j1/a' }, { Key: 'j1/b' }], IsTruncated: true, NextContinuationToken: 't' };
      }
      return {};
    });
    expect(await new S3ObjectStore(opts, { send } as never).deletePrefix('runs', 'j1/')).toBe(3);
    const deletes = send.mock.calls.map((c) => c[0]).filter((c) => c instanceof DeleteObjectsCommand) as DeleteObjectsCommand[];
    expect(deletes.flatMap((d) => d.input.Delete!.Objects!.map((o) => o.Key))).toEqual(['j1/a', 'j1/b', 'j1/c']);
    const lists = send.mock.calls.map((c) => c[0]).filter((c) => c instanceof ListObjectsV2Command) as ListObjectsV2Command[];
    expect(lists[0]!.input).toMatchObject({ Bucket: 'runs', Prefix: 'j1/' });
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run --project api test/object-store.test.ts test/s3.test.ts`
Expected: FAIL, because `deletePrefix`/`delete` are not functions.

- [ ] **Step 3: Implement**

`object-store.ts`, added to the interface:

```ts
  delete(bucket: string, key: string): Promise<void>;
  /** Delete every object whose key starts with `prefix`. Returns how many were deleted. */
  deletePrefix(bucket: string, prefix: string): Promise<number>;
```

`MemoryObjectStore`:

```ts
  async delete(bucket: string, key: string): Promise<void> {
    this.objects.delete(`${bucket}/${key}`);
  }

  async deletePrefix(bucket: string, prefix: string): Promise<number> {
    const keys = [...this.objects.keys()].filter((k) => k.startsWith(`${bucket}/${prefix}`));
    for (const k of keys) this.objects.delete(k);
    return keys.length;
  }
```

`s3.ts`: add `DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command` to the imports. Change the client field to `private readonly client: Pick<S3Client, 'send'>;` and the constructor to `constructor(opts: S3Options, client?: Pick<S3Client, 'send'>) { this.client = client ?? new S3Client(s3ClientConfig(opts)); }`. Add:

```ts
  async delete(bucket: string, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  async deletePrefix(bucket: string, prefix: string): Promise<number> {
    let deleted = 0;
    let token: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }),
      );
      const keys = (page.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
      if (keys.length) {
        await this.client.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys, Quiet: true } }),
        );
        deleted += keys.length;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
    return deleted;
  }
```

`send` typing: `Pick<S3Client,'send'>` keeps the overloads, so `page` is typed as `ListObjectsV2CommandOutput`. If TypeScript can't infer this, cast the result explicitly to `ListObjectsV2CommandOutput` (imported as a type).

Any other `ObjectStore` implementation in tests (`UnreachableStore` extends the memory one) needs no change.

- [ ] **Step 4: Run and confirm they pass**

Run: `npx vitest run --project api` and `npm run typecheck`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/storage apps/api/test/object-store.test.ts apps/api/test/s3.test.ts
git commit -m "API storage: delete a key and delete by prefix" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Delete one job, and bulk cleanup

**Files:**
- Create: `apps/api/src/jobs/delete.ts` (storage clean-up helper)
- Modify: `apps/api/src/repositories/{types,memory,pg}.ts`, `apps/api/src/routes/jobs.ts`
- Test: `apps/api/test/delete-jobs.test.ts`

**Interfaces:**
- Consumes: `ObjectStore.delete/deletePrefix` (Task 3), `DELETABLE_STATUSES` (Task 2).
- Produces:
  - `RemovedJob = { jobId: string; draftObjects: { bucket: string; key: string }[]; inboxObject: { bucket: string; key: string } | null }`;
  - `IngestionRepo.deleteJob(id): Promise<{ result: 'deleted'; removed: RemovedJob } | { result: 'not_found' } | { result: 'conflict'; status: JobStatus }>`;
  - `IngestionRepo.finishedJobIdsBefore(cutoffIso: string): Promise<string[]>`;
  - `removeJobFiles(deps, removed, log): Promise<void>`;
  - routes `DELETE /api/jobs/:id`, `POST /api/jobs/cleanup`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/test/delete-jobs.test.ts
import type { JobOutput } from '@ih/shared';
import { describe, expect, it } from 'vitest';
import { MemoryObjectStore } from '../src/storage/object-store.js';
import { fakePdf, multipart, testApp } from './helpers.js';

type Ctx = Awaited<ReturnType<typeof testApp>>;

async function upload(ctx: Ctx, filename = 'a.pdf') {
  return (
    await ctx.app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'tdemo' }, { filename, content: fakePdf }),
    })
  ).json();
}

const draft = (jobId: string): JobOutput => ({
  outputId: 'document', stage: 'draft', format: 'json', bucket: 'outputs', key: `tdemo/v1/document/${jobId}.json`, rowCount: null,
});
const published = (jobId: string): JobOutput => ({
  outputId: 'document', stage: 'published', format: 'json', bucket: 'published', key: `pub/tdemo/v1/document/${jobId}.json`, rowCount: null,
});

/** A finished job with a draft, a published copy, run files and its inbox PDF in storage. */
async function finishedJob(ctx: Ctx, status = 'succeeded' as const) {
  const job = await upload(ctx);
  ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, status });
  ctx.repo.outputs.set(job.id, [draft(job.id), published(job.id)]);
  await ctx.store.put('outputs', draft(job.id).key, Buffer.from('{}'), 'application/json');
  await ctx.targetStore.put('published', published(job.id).key, Buffer.from('{}'), 'application/json');
  await ctx.store.put('runs', `${job.id}/head/attempt-1.json`, Buffer.from('{}'), 'application/json');
  await ctx.store.put('runs', `${job.id}/pages/page-1.jpg`, Buffer.from('x'), 'image/jpeg');
  await ctx.store.put('runs', 'ocr-cache/abc/p1.txt', Buffer.from('x'), 'text/plain');
  const doc = ctx.repo.documents.get(job.documentId)!;
  return { job, doc };
}

describe('DELETE /api/jobs/:id', () => {
  it('deletes the job, its document and internal files, keeping published copies and the OCR cache', async () => {
    const ctx = await testApp();
    const { job, doc } = await finishedJob(ctx);
    expect(await ctx.store.get(doc.bucket, doc.objectKey)).not.toBeNull();

    const res = await ctx.app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}` });
    expect(res.statusCode).toBe(204);
    expect(ctx.repo.jobs.has(job.id)).toBe(false);
    expect(ctx.repo.documents.has(job.documentId)).toBe(false);
    expect(await ctx.store.get('outputs', draft(job.id).key)).toBeNull();
    expect(await ctx.store.get('runs', `${job.id}/pages/page-1.jpg`)).toBeNull();
    expect(await ctx.store.get(doc.bucket, doc.objectKey)).toBeNull();
    expect(await ctx.targetStore.get('published', published(job.id).key)).not.toBeNull();
    expect(await ctx.store.get('runs', 'ocr-cache/abc/p1.txt')).not.toBeNull();
  });

  it.each(['queued', 'running', 'awaiting_review'] as const)('refuses to delete a %s job', async (status) => {
    const ctx = await testApp();
    const job = await upload(ctx);
    ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, status });
    const res = await ctx.app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}` });
    expect(res.statusCode).toBe(409);
    expect(ctx.repo.jobs.has(job.id)).toBe(true);
  });

  it.each(['failed', 'needs_review', 'rejected', 'cancelled'] as const)('deletes a %s job', async (status) => {
    const ctx = await testApp();
    const { job } = await finishedJob(ctx, status as never);
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}` })).statusCode).toBe(204);
  });

  it('keeps a PDF that another document row shares (regression runs)', async () => {
    const ctx = await testApp();
    const { job, doc } = await finishedJob(ctx);
    ctx.repo.documents.set('other-doc', { ...doc, id: 'other-doc' });
    await ctx.app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}` });
    expect(await ctx.store.get(doc.bucket, doc.objectKey)).not.toBeNull();
  });

  it('keeps the document and PDF of a regression reference', async () => {
    const ctx = await testApp();
    const { job, doc } = await finishedJob(ctx);
    await ctx.repo.createReference({
      templateId: 'tdemo', name: 'ref', documentId: job.documentId, sourceJobId: job.id, expected: { fields: {}, tables: {} },
    });
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}` })).statusCode).toBe(204);
    expect(ctx.repo.jobs.has(job.id)).toBe(false);
    expect(ctx.repo.documents.has(job.documentId)).toBe(true);
    expect(await ctx.store.get(doc.bucket, doc.objectKey)).not.toBeNull();
  });

  it('still deletes the job when storage clean-up fails', async () => {
    class BrokenDeletes extends MemoryObjectStore {
      override async delete(): Promise<void> { throw new Error('ECONNREFUSED'); }
      override async deletePrefix(): Promise<number> { throw new Error('ECONNREFUSED'); }
    }
    const ctx = await testApp({ store: new BrokenDeletes() });
    const job = await upload(ctx);
    ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, status: 'failed' });
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/jobs/${job.id}` })).statusCode).toBe(204);
    expect(ctx.repo.jobs.has(job.id)).toBe(false);
  });

  it('404s for unknown ids', async () => {
    const ctx = await testApp();
    expect((await ctx.app.inject({ method: 'DELETE', url: `/api/jobs/${crypto.randomUUID()}` })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'DELETE', url: '/api/jobs/nope' })).statusCode).toBe(404);
  });
});

describe('POST /api/jobs/cleanup', () => {
  async function aged(ctx: Ctx, status: string, daysAgo: number) {
    const job = await upload(ctx);
    const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
    ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, status: status as never, updatedAt: at });
    return job;
  }

  it('previews and deletes finished jobs older than N days only', async () => {
    const ctx = await testApp();
    const old1 = await aged(ctx, 'succeeded', 40);
    const old2 = await aged(ctx, 'failed', 31);
    const recent = await aged(ctx, 'succeeded', 5);
    const oldRunning = await aged(ctx, 'running', 90);

    const preview = await ctx.app.inject({ method: 'POST', url: '/api/jobs/cleanup', payload: { olderThanDays: 30, dryRun: true } });
    expect(preview.json()).toEqual({ count: 2 });
    expect(ctx.repo.jobs.size).toBe(4);

    const run = await ctx.app.inject({ method: 'POST', url: '/api/jobs/cleanup', payload: { olderThanDays: 30, dryRun: false } });
    expect(run.json()).toEqual({ deleted: 2 });
    expect([...ctx.repo.jobs.keys()].sort()).toEqual([recent.id, oldRunning.id].sort());
    expect(ctx.repo.jobs.has(old1.id) || ctx.repo.jobs.has(old2.id)).toBe(false);
  });

  it('returns zero when nothing matches and validates input', async () => {
    const ctx = await testApp();
    await aged(ctx, 'succeeded', 1);
    expect((await ctx.app.inject({ method: 'POST', url: '/api/jobs/cleanup', payload: { olderThanDays: 30, dryRun: true } })).json()).toEqual({ count: 0 });
    for (const payload of [{ olderThanDays: 0, dryRun: true }, { olderThanDays: 'x', dryRun: true }, { olderThanDays: 30 }]) {
      expect((await ctx.app.inject({ method: 'POST', url: '/api/jobs/cleanup', payload })).statusCode).toBe(400);
    }
  });
});
```

`MemoryRepo.documents` is keyed by document id and holds `NewDocument` (`bucket`, `objectKey`); confirm this before running. `createReference` takes the `Reference` fields minus `id`/`createdAt`; adjust the field names if the shared `Reference` type differs.

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run --project api test/delete-jobs.test.ts`
Expected: FAIL. DELETE returns 404 because no route exists, and cleanup returns 404.

- [ ] **Step 3: Implement the repo methods**

`types.ts`:

```ts
export interface StoredObject {
  bucket: string;
  key: string;
}

/** What a deleted job leaves to clean up in the internal store. */
export interface RemovedJob {
  jobId: string;
  draftObjects: StoredObject[];
  /** The inbox PDF, when no remaining document row or reference needs it. */
  inboxObject: StoredObject | null;
}

export type DeleteJobResult =
  | { result: 'deleted'; removed: RemovedJob }
  | { result: 'not_found' }
  | { result: 'conflict'; status: JobStatus };
```

and in `IngestionRepo`:

```ts
  /** Delete a finished job (+ its document unless still needed). Storage is the caller's job. */
  deleteJob(id: string): Promise<DeleteJobResult>;
  /** Ids of finished jobs whose updated_at is before `cutoffIso`. */
  finishedJobIdsBefore(cutoffIso: string): Promise<string[]>;
```

`memory.ts` (import `DELETABLE_STATUSES` from `@ih/shared` and the new types):

```ts
  async deleteJob(id: string): Promise<DeleteJobResult> {
    const job = this.jobs.get(id);
    if (!job) return { result: 'not_found' };
    if (!DELETABLE_STATUSES.includes(job.status)) return { result: 'conflict', status: job.status };
    const draftObjects = (this.outputs.get(id) ?? [])
      .filter((o) => o.stage === 'draft')
      .map((o) => ({ bucket: o.bucket, key: o.key }));
    this.jobs.delete(id);
    for (const map of [this.outputs, this.edits, this.stepRuns, this.events, this.publishedAt]) map.delete(id);
    const doc = this.documents.get(job.documentId);
    const stillUsed =
      [...this.jobs.values()].some((j) => j.documentId === job.documentId) ||
      [...this.references.values()].some((r) => r.documentId === job.documentId);
    let inboxObject: StoredObject | null = null;
    if (doc && !stillUsed) {
      this.documents.delete(job.documentId);
      const shared = [...this.documents.values()].some(
        (d) => d.bucket === doc.bucket && d.objectKey === doc.objectKey,
      );
      if (!shared) inboxObject = { bucket: doc.bucket, key: doc.objectKey };
    }
    return { result: 'deleted', removed: { jobId: id, draftObjects, inboxObject } };
  }

  async finishedJobIdsBefore(cutoffIso: string): Promise<string[]> {
    const cutoff = Date.parse(cutoffIso);
    return [...this.jobs.values()]
      .filter((j) => DELETABLE_STATUSES.includes(j.status) && Date.parse(j.updatedAt) < cutoff)
      .map((j) => j.id);
  }
```

`pg.ts` (follow the existing `pool.connect()` + `BEGIN`/`COMMIT`/`ROLLBACK` pattern at line ~146):

```ts
  async deleteJob(id: string): Promise<DeleteJobResult> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const found = await client.query<{ status: JobStatus; document_id: string; bucket: string; object_key: string }>(
        `SELECT j.status, j.document_id, d.bucket, d.object_key
           FROM jobs j JOIN documents d ON d.id = j.document_id WHERE j.id = $1 FOR UPDATE OF j`,
        [id],
      );
      const row = found.rows[0];
      if (!row) {
        await client.query('ROLLBACK');
        return { result: 'not_found' };
      }
      if (!DELETABLE_STATUSES.includes(row.status)) {
        await client.query('ROLLBACK');
        return { result: 'conflict', status: row.status };
      }
      const drafts = await client.query<{ bucket: string; object_key: string }>(
        `SELECT bucket, object_key FROM job_outputs WHERE job_id = $1 AND stage = 'draft'`,
        [id],
      );
      await client.query('DELETE FROM jobs WHERE id = $1', [id]);
      const doc = await client.query(
        `DELETE FROM documents d WHERE d.id = $1
            AND NOT EXISTS (SELECT 1 FROM jobs WHERE document_id = d.id)
            AND NOT EXISTS (SELECT 1 FROM template_references WHERE document_id = d.id)`,
        [row.document_id],
      );
      let inboxObject: StoredObject | null = null;
      if (doc.rowCount) {
        const shared = await client.query(
          'SELECT 1 FROM documents WHERE bucket = $1 AND object_key = $2 LIMIT 1',
          [row.bucket, row.object_key],
        );
        if (!shared.rowCount) inboxObject = { bucket: row.bucket, key: row.object_key };
      }
      await client.query('COMMIT');
      return {
        result: 'deleted',
        removed: {
          jobId: id,
          draftObjects: drafts.rows.map((d) => ({ bucket: d.bucket, key: d.object_key })),
          inboxObject,
        },
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async finishedJobIdsBefore(cutoffIso: string): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT id FROM jobs WHERE status = ANY($1::job_status[]) AND updated_at < $2 ORDER BY updated_at`,
      [DELETABLE_STATUSES, cutoffIso],
    );
    return rows.map((r) => r.id);
  }
```

- [ ] **Step 4: Implement storage clean-up and the routes**

```ts
// apps/api/src/jobs/delete.ts
import type { FastifyBaseLogger } from 'fastify';
import type { AppDeps } from '../app.js';
import type { RemovedJob } from '../repositories/types.js';

/**
 * Best-effort removal of a deleted job's internal files: drafts, everything under {jobId}/ in the
 * runs bucket, and the inbox PDF when nothing else needs it. Published target copies and the OCR
 * cache are never touched. Failures are logged; the database delete already happened.
 */
export async function removeJobFiles(
  deps: Pick<AppDeps, 'store' | 'buckets'>,
  removed: RemovedJob,
  log: FastifyBaseLogger,
): Promise<void> {
  const tasks: Promise<unknown>[] = [
    ...removed.draftObjects.map((o) => deps.store.delete(o.bucket, o.key)),
    deps.store.deletePrefix(deps.buckets.runs, `${removed.jobId}/`),
    ...(removed.inboxObject ? [deps.store.delete(removed.inboxObject.bucket, removed.inboxObject.key)] : []),
  ];
  for (const result of await Promise.allSettled(tasks)) {
    if (result.status === 'rejected') {
      log.warn({ err: result.reason, jobId: removed.jobId }, 'job file clean-up failed');
    }
  }
}
```

`routes/jobs.ts` (import `removeJobFiles`):

```ts
const CleanupBody = z.object({
  olderThanDays: z.number().int().min(1).max(3650),
  dryRun: z.boolean(),
});

  app.delete<{ Params: { id: string } }>('/jobs/:id', async (req, reply) => {
    if (!UUID.safeParse(req.params.id).success) return reply.code(404).send({ error: 'not found' });
    const res = await app.deps.repo.deleteJob(req.params.id);
    if (res.result === 'not_found') return reply.code(404).send({ error: 'not found' });
    if (res.result === 'conflict') {
      return reply.code(409).send({ error: `a ${res.status} job cannot be deleted: cancel or review it first` });
    }
    await removeJobFiles(app.deps, res.removed, req.log);
    return reply.code(204).send();
  });

  app.post('/jobs/cleanup', async (req, reply) => {
    const body = CleanupBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: body.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') });
    }
    const cutoff = new Date(Date.now() - body.data.olderThanDays * 86_400_000).toISOString();
    const ids = await app.deps.repo.finishedJobIdsBefore(cutoff);
    if (body.data.dryRun) return { count: ids.length };
    let deleted = 0;
    for (const id of ids) {
      const res = await app.deps.repo.deleteJob(id);
      if (res.result !== 'deleted') continue; // changed status meanwhile: skip it
      deleted++;
      await removeJobFiles(app.deps, res.removed, req.log);
    }
    return { deleted };
  });
```

Register `/jobs/cleanup` **before** any `/jobs/:id`-style POST route if Fastify reports a conflict. Static segments take priority in find-my-way, so normally order doesn't matter.

- [ ] **Step 5: Run and confirm they pass**

Run: `npx vitest run --project api` and `npm run typecheck && npm run lint`
Expected: PASS and clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api
git commit -m "API: delete finished jobs and bulk clean-up by age" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Web Api port and Jobs table row actions

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/src/components/JobsTable.tsx`, `apps/web/src/styles.css`
- Test: `apps/web/test/JobsTable.test.tsx`

**Interfaces:**
- Produces: `Api.cancelJob(id): Promise<JobSummary>`, `Api.deleteJob(id): Promise<void>`, `Api.cleanupJobs(olderThanDays: number, dryRun: boolean): Promise<{ count?: number; deleted?: number }>`.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/test/JobsTable.test.tsx
import type { JobStatus } from '@ih/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { JobsTable } from '../src/components/JobsTable.js';
import { fakeApi, job } from './fake-api.js';

const row = (name: string) => screen.getByText(name).closest('tr')!;
const buttons = (name: string) =>
  within(row(name)).queryAllByRole('button').map((b) => b.textContent);

describe('JobsTable actions', () => {
  it.each<[JobStatus, string[]]>([
    ['queued', ['Cancel']],
    ['running', ['Cancel']],
    ['succeeded', ['Delete']],
    ['failed', ['Retry', 'Delete']],
    ['needs_review', ['Retry', 'Delete']],
    ['cancelled', ['Retry', 'Delete']],
    ['rejected', ['Delete']],
    ['awaiting_review', []],
  ])('%s jobs offer %j', (status, expected) => {
    render(<JobsTable api={fakeApi()} jobs={[job({ filename: 'a.pdf', status })]} onChanged={vi.fn()} />);
    expect(buttons('a.pdf')).toEqual(expected);
  });

  it('confirms before deleting, mentions published copies, and refreshes', async () => {
    const api = fakeApi();
    const onChanged = vi.fn();
    const j = job({ filename: 'a.pdf', status: 'succeeded' });
    render(<JobsTable api={api} jobs={[j]} onChanged={onChanged} />);
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Delete' }));
    expect(within(row('a.pdf')).getByText(/Delete a\.pdf\?/)).toHaveTextContent('Published copies in the target are kept.');
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Keep' }));
    expect(api.deleteJob).not.toHaveBeenCalled();
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Confirm' }));
    expect(api.deleteJob).toHaveBeenCalledWith(j.id);
    expect(onChanged).toHaveBeenCalled();
  });

  it('confirms before cancelling', async () => {
    const api = fakeApi();
    const j = job({ filename: 'a.pdf', status: 'running' });
    render(<JobsTable api={api} jobs={[j]} onChanged={vi.fn()} />);
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Cancel' }));
    expect(within(row('a.pdf')).getByText('Cancel job?')).toBeInTheDocument();
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Confirm' }));
    expect(api.cancelJob).toHaveBeenCalledWith(j.id);
  });

  it('shows action errors in the row', async () => {
    const api = fakeApi({ deleteJob: vi.fn(async () => { throw new Error('a running job cannot be deleted'); }) });
    render(<JobsTable api={api} jobs={[job({ filename: 'a.pdf', status: 'failed' })]} onChanged={vi.fn()} />);
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Delete' }));
    await userEvent.click(within(row('a.pdf')).getByRole('button', { name: 'Confirm' }));
    expect(await within(row('a.pdf')).findByRole('alert')).toHaveTextContent('a running job cannot be deleted');
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run --project web test/JobsTable.test.tsx`
Expected: FAIL. No Cancel/Delete buttons exist yet, and `fakeApi` lacks `deleteJob`.

- [ ] **Step 3: Implement**

Add to the `Api` interface in `client.ts`:

```ts
  cancelJob(id: string): Promise<JobSummary>;
  deleteJob(id: string): Promise<void>;
  /** Finished jobs older than N days: dryRun → { count }, else { deleted }. */
  cleanupJobs(olderThanDays: number, dryRun: boolean): Promise<{ count?: number; deleted?: number }>;
```

The `createHttpApi` implementation follows. Check whether a `del`/`post` helper exists before writing it; `post` exists.

```ts
    cancelJob: (id) => post<JobSummary>(`${base}/jobs/${id}/cancel`, {}),
    deleteJob: async (id) => {
      const res = await fetch(`${base}/jobs/${id}`, { method: 'DELETE' });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ? String(body.error) : `${res.status} ${res.statusText}`);
      }
    },
    cleanupJobs: (olderThanDays, dryRun) =>
      post<{ count?: number; deleted?: number }>(`${base}/jobs/cleanup`, { olderThanDays, dryRun }),
```

Add to `fakeApi`:

```ts
    cancelJob: vi.fn(async (id: string) => job({ id, status: 'cancelled' })),
    deleteJob: vi.fn(async () => undefined),
    cleanupJobs: vi.fn(async (_days: number, dryRun: boolean) => (dryRun ? { count: 0 } : { deleted: 0 })),
```

`JobsTable.tsx`: replace the actions cell with a `<JobActions api={api} job={job} onChanged={onChanged} />` component in the same file:

```tsx
const DELETABLE = new Set<JobStatus>(['succeeded', 'failed', 'needs_review', 'rejected', 'cancelled']);
const RETRYABLE = new Set<JobStatus>(['failed', 'needs_review', 'cancelled']);

function JobActions({ api, job, onChanged }: { api: Api; job: JobSummary; onChanged: () => void }) {
  const [confirm, setConfirm] = useState<'cancel' | 'delete' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<unknown>) => {
    setError(null);
    try {
      await action();
      setConfirm(null);
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (confirm) {
    return (
      <>
        <span>
          {confirm === 'delete'
            ? `Delete ${job.filename}? Published copies in the target are kept.`
            : 'Cancel job?'}
        </span>{' '}
        <button type="button" onClick={() => void run(() => (confirm === 'delete' ? api.deleteJob(job.id) : api.cancelJob(job.id)))}>
          Confirm
        </button>
        <button type="button" onClick={() => setConfirm(null)}>
          Keep
        </button>
        {error && <div role="alert" className="error">{error}</div>}
      </>
    );
  }
  return (
    <>
      {job.status === 'awaiting_review' && <a href={`#/review/${job.id}`}>Review</a>}
      {RETRYABLE.has(job.status) && (
        <button type="button" onClick={() => void run(() => api.retryJob(job.id))}>Retry</button>
      )}
      {(job.status === 'queued' || job.status === 'running') && (
        <button type="button" onClick={() => setConfirm('cancel')}>Cancel</button>
      )}
      {DELETABLE.has(job.status) && (
        <button type="button" className="danger" onClick={() => setConfirm('delete')}>Delete</button>
      )}
      {error && <div role="alert" className="error">{error}</div>}
    </>
  );
}
```

The confirm-state text test uses a regex `/Delete a\.pdf\?/` on a single `<span>`, so the whole sentence lives in one text node as written. Import `useState` and `type JobStatus`. In `styles.css`, add `.status-cancelled { color: #57606a; }` next to `.status-rejected`. The existing App test "offers retry only for failed ones" still holds: its failed/succeeded jobs now also show Delete, but its assertion counts only Retry buttons.

- [ ] **Step 4: Run and confirm they pass**

Run: `npx vitest run --project web` and `npm run typecheck`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "Web: cancel, delete and retry actions on the Jobs table" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Bulk clean-up panel

**Files:**
- Create: `apps/web/src/components/JobCleanup.tsx`
- Modify: `apps/web/src/App.tsx` (render it under `JobsTable` in `JobsView`, passing `onChanged={refresh}`)
- Test: `apps/web/test/JobCleanup.test.tsx`

**Interfaces:**
- Consumes: `Api.cleanupJobs` (Task 5).
- Produces: `JobCleanup({ api, onChanged })`.

- [ ] **Step 1: Write the failing tests**

```tsx
// apps/web/test/JobCleanup.test.tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { JobCleanup } from '../src/components/JobCleanup.js';
import { fakeApi } from './fake-api.js';

describe('JobCleanup', () => {
  it('previews, then deletes finished jobs older than N days', async () => {
    const cleanupJobs = vi.fn(async (_d: number, dryRun: boolean) => (dryRun ? { count: 37 } : { deleted: 37 }));
    const onChanged = vi.fn();
    render(<JobCleanup api={fakeApi({ cleanupJobs })} onChanged={onChanged} />);
    const days = screen.getByLabelText('Delete finished jobs older than (days)');
    expect(days).toHaveValue(30);
    await userEvent.clear(days);
    await userEvent.type(days, '60');
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(cleanupJobs).toHaveBeenLastCalledWith(60, true);
    expect(await screen.findByText('37 jobs will be deleted (published copies are kept).')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Delete 37 jobs' }));
    expect(cleanupJobs).toHaveBeenLastCalledWith(60, false);
    expect(await screen.findByRole('status')).toHaveTextContent('Deleted 37 jobs.');
    expect(onChanged).toHaveBeenCalled();
  });

  it('says when nothing matches, and can be dismissed', async () => {
    render(<JobCleanup api={fakeApi()} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('No finished jobs older than 30 days.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Delete \d+ jobs/ })).not.toBeInTheDocument();
  });

  it('keeps without deleting, and shows errors', async () => {
    const cleanupJobs = vi
      .fn()
      .mockResolvedValueOnce({ count: 3 })
      .mockRejectedValueOnce(new Error('olderThanDays: too small'));
    render(<JobCleanup api={fakeApi({ cleanupJobs })} onChanged={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Keep' }));
    expect(screen.queryByText(/jobs will be deleted/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('olderThanDays: too small');
  });
});
```

- [ ] **Step 2: Run and confirm they fail**

Run: `npx vitest run --project web test/JobCleanup.test.tsx`
Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement**

```tsx
// apps/web/src/components/JobCleanup.tsx
import { useState } from 'react';
import type { Api } from '../api/client.js';

/** Bulk delete of finished jobs by age: preview (dry run) first, then confirm. */
export function JobCleanup({ api, onChanged }: { api: Api; onChanged: () => void }) {
  const [days, setDays] = useState(30);
  const [preview, setPreview] = useState<number | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const act = async (dryRun: boolean) => {
    setError(null);
    setDone(null);
    try {
      const res = await api.cleanupJobs(days, dryRun);
      if (dryRun) setPreview(res.count ?? 0);
      else {
        setPreview(null);
        setDone(`Deleted ${res.deleted ?? 0} jobs.`);
        onChanged();
      }
    } catch (err) {
      setPreview(null);
      setError((err as Error).message);
    }
  };

  return (
    <section className="job-cleanup" aria-label="Clean up old jobs">
      <label className="inline">
        Delete finished jobs older than (days)
        <input
          type="number"
          min={1}
          value={days}
          onChange={(e) => {
            setDays(Number(e.target.value));
            setPreview(null);
          }}
        />
      </label>
      <button type="button" onClick={() => void act(true)}>
        Preview
      </button>
      {preview === 0 && <p>No finished jobs older than {days} days.</p>}
      {preview !== null && preview > 0 && (
        <p>
          {preview} jobs will be deleted (published copies are kept).{' '}
          <button type="button" className="danger" onClick={() => void act(false)}>
            Delete {preview} jobs
          </button>
          <button type="button" onClick={() => setPreview(null)}>
            Keep
          </button>
        </p>
      )}
      {done && <p role="status">{done}</p>}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
```

The "No finished jobs older than 30 days." text sits in a single `<p>` containing a number interpolation, which renders as multiple text nodes. `getByText` matches the element's full text content, so the matcher works.

In `App.tsx`'s `JobsView`, render `<JobCleanup api={api} onChanged={refresh} />` after `<JobsTable …/>`. In `styles.css`, add `.job-cleanup { margin-top: 1rem; display: flex; flex-wrap: wrap; gap: 0.5rem 1rem; align-items: center; } .job-cleanup input { width: 5rem; }`.

- [ ] **Step 4: Run and confirm they pass**

Run: `npx vitest run --project web` and `npm run typecheck && npm run lint && npm run format:check`
Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "Web: bulk clean-up of finished jobs by age" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Docs and full verification

**Files:**
- Create: `docs/adr/0005-job-cancellation-and-deletion.md`
- Modify: `docs/architecture.md` (status flow diagram near line 16), `CLAUDE.md` (contracts table "Job statuses" row; error routing bullet)

- [ ] **Step 1: Write the ADR**

```markdown
# 0005 — Job cancellation and deletion

**Status:** accepted · 2026-10-11

## Context
Operators need to stop jobs (e.g. a wrong model on a slow local LLM) and remove old jobs and
their files. The worker owns status transitions while a job runs.

## Decision
- New status `cancelled`, set by the API for queued/running jobs. The worker checks
  `is_cancelled` at safe points (before each step, before publishing/recording) and raises
  `JobCancelled`; every worker status write is guarded with `AND status = 'running'`, so a
  cancel always wins. An in-flight LLM call finishes first.
- Finished jobs (succeeded, failed, needs_review, rejected, cancelled) can be deleted: one DB
  transaction removes the job (cascading history) and its document unless another job or a
  regression reference uses it; then internal files (drafts, runs/{jobId}/, the inbox PDF when
  unshared) are deleted best-effort. Published target copies and the OCR cache are kept.

## Consequences
- Contract change on both sides (enum + JOB_STATUSES); Retry also re-queues cancelled jobs.
- Storage clean-up can leave orphans if S3 is down (logged); never dangling DB references.
```

- [ ] **Step 2: Update the docs**
  - `docs/architecture.md`: add `cancelled` to the status flow (queued/running ─► cancelled (operator)). Add one sentence on deletion pointing to ADR 0005.
  - `CLAUDE.md`: in the cross-language contracts table, change the Job statuses row's Python column to "`db/migrations` `job_status` enum (incl. `cancelled`, 0006), `queue.py`". In the **Error routing** bullet, append: "`JobCancelled` (operator cancel) → no status write; worker status writes are guarded `AND status='running'`."

- [ ] **Step 3: Full verification**

Run: `npm run check` (worker steps call `uv`; if it's missing from PATH, run them as `cd worker && python -m uv run ruff check . && python -m uv run ruff format --check . && python -m uv run mypy src && python -m uv run pytest -q`)
Expected: everything green.

- [ ] **Step 4: Commit**

```bash
git add docs CLAUDE.md
git commit -m "Docs: ADR 0005 job cancellation and deletion" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
