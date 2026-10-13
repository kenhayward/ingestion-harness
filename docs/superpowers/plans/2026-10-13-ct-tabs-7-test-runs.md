# Workbench tabs 7/8: Test runs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign the Test runs tab (handoff §11) and land TR1–TR4. **TR1:** `POST /api/workbench/projects/:id/test-runs` takes optional `sampleIds` (only ready dev samples; holdout and unknown ids 400, a sample still preparing or failed 409). **TR2:** every run of one POST shares a `batchId` (stored as `params.batchId`), and `JobSummary` gains `batchId`, `startedAt`, `finishedAt` (`attempts` already exists). **TR3:** the worker writes a `step progress` job event per model call of a Workbench run; `GET …/test-runs` returns each running job's latest progress of this attempt (`TestRun.progress`). **TR4:** `GET /api/queue/summary` → `{ ahead, running, etaSeconds }`.

**Architecture:**

- *Migration 0028* (`db/migrations/0028_job_timing.sql`): `jobs.started_at`, `jobs.finished_at` and a `BEFORE UPDATE OF status` trigger that sets them for `process` runs only (a claim sets `started_at`, clears `finished_at`; leaving `running` sets `finished_at`). The worker is unchanged and never reads them; the approval (`publish`) and step re-runs (`rerun`) reuse the row with another task, so they never overwrite the extraction's times. Plus a partial index on `finished_at` for the queue estimate.
- *Shared* (`packages/shared/src/jobs.ts`): `JobSummary.batchId/startedAt/finishedAt`, `STEP_PROGRESS_EVENT`, `StepProgressSchema`, `TestRunSchema` (= `JobSummary` + `progress`), `QueueSummarySchema`. (`overview.ts`): the runs status text becomes "n test runs in progress · n awaiting review". Shared fixture `packages/shared/test/fixtures/step-progress.json` pins the event payload on both sides.
- *Repositories*: `JOB_SELECT` reads `params->>'batchId'`, `started_at`, `finished_at`; new `IngestionRepo.queueStats()` (Memory + Pg) — so a Pg integration test is included.
- *Worker*: `extract.run_extraction(on_attempt=)`, `pipeline.run_step_extraction(progress=)`, `template_pipeline.STEP_PROGRESS` + `step_reporter` (Workbench jobs only, advisory: a failed event write never fails a step).
- *API*: `TestRunsBody.sampleIds`, `params.batchId`; `apps/api/src/workbench/test-runs.ts` (`stepProgress`); the list route returns `TestRun[]`; `GET /api/queue/summary` in `routes/jobs.ts` with the pure `queueSummary` (`apps/api/src/jobs/queue-summary.ts`). `LIST_CACHE_VERSION` 2 → 3 (status text changed).
- *Web*: client (`runDevTests(projectId, { model, sampleIds })`, `listTestRuns` → `TestRun[]`, `getQueueSummary`), pure helpers `apps/web/src/workbench/runs.ts`, `RunBatchCard.tsx`, `RunSamples.tsx`, `RunsTab.tsx` rewritten (it owns its `TabHeader` so the primary sits in the header), `ProjectPage` wiring, CSS.

**Tech Stack:** React 19, Vitest + Testing Library, Zod (shared), Fastify + OpenAPI route docs, PostgreSQL 17 (plpgsql trigger), Python 3.13 (pytest, mypy --strict, ruff), CSS on existing `--ih-*` tokens.

**Spec:** `docs/design/workbench-tabs/WORKBENCH-TABS-HANDOFF.md` §0 (rules shared by every tab), §11 Test runs, rows **TR1–TR4** of "New API", "Tests to add" (Test runs); screens `docs/design/workbench-tabs/screenshots/light/11-runs.png`, `screenshots/states/11b-runs-new-batch.png`.

## Global Constraints

- **Card CSS gotcha:** `.card` has **no padding**. The new padded blocks (`.runs-samples-card`, `.runs-batch-head`, `.runs-others`) are added to the shared padding rule in `apps/web/src/styles/stages.css` (the block that starts `/* Workbench tab cards: .card itself has no padding …`, `padding: 12px 16px`) and their `h3` (`.runs-samples-card h3`, `.runs-batch-head h3`, `.runs-others h3`) to the `font-weight: 600` rule below it — extend those two selector lists, do not duplicate them. The batch table is not padded by the card: its cells carry `padding: 8px 16px`.
- **Grids never overflow:** `.runs-tab` is `grid-template-columns: minmax(0, 1fr)` with `min-width: 0`; `.runs-batch-head` and `.runs-samples-card` are wrapping flex rows whose children have `min-width: 0`; file names wrap with `overflow-wrap: anywhere`; the stacked bar is `width: 220px; max-width: 100%`. Below 760 px the queue line takes its own row and the bar goes full width.
- **Wide tables in `.table-scroll`:** each batch's table (and the Other runs table) sits in `<div className="table-scroll">`.
- **Side panels:** this tab has none (no sticky panel needed).
- **Disabled buttons carry a `title` reason (tested):** *Run on n dev samples* ("Every version is published: start the next version on the Template tab first", "Select at least one prepared dev sample"). Disabled sample tick boxes carry `title` "Still preparing" or "Preparation failed: …" (tested).
- **Selectable controls:** the handoff draws sample chips *with tick boxes*, so each chip is a native `<input type="checkbox">` inside its `<label>` (a checkbox is the correct role for a multi-select; no `aria-pressed` buttons on this tab). *Show* toggles carry `aria-expanded`.
- **Charts are `role="img"` with a text alternative:** the batch's stacked status bar (`aria-label="Batch status: 3 succeeded · 1 awaiting review · 2 running"`, the same text visible beside it) and each running row's step bar (`aria-label="Step 2 of 3 · line_items · chunk 2 of 2"`, the same text in the detail line).
- **Holdout is sealed (§0.3):** the tab lists dev samples only; the API refuses holdout `sampleIds` (400) before queuing anything.
- **Stale responses and polling:** `RunsTab.load` numbers its requests with a sequence ref (a slower earlier response, or one arriving after unmount, is dropped) and polls at `pollMs` only while a run is queued or running or a dev sample is preparing (`inFlight` ref: no overlapping polls). `onChanged` (the page's overview reload) fires after a run starts and when the last active run finishes.
- **Model picker follows main (#90/#91):** *Run on n dev samples* and *Retry* open the shared `ReprocessDialog` (model choices, "Template's models" = no override, local-only projects cannot pick an external choice).
- **Migration** is `0028_job_timing.sql` (highest existing is 0027). Forward-only.
- **Cross-language contracts change together:** the `step progress` event (Task 3: TS schema + worker emitter + shared fixture). `params.batchId`, `started_at`, `finished_at` are TS-only (the worker neither reads nor writes them; the timing is a database trigger) — the CLAUDE.md table records that.
- **Never call a real LLM** (worker tests use `FakeProvider`). Worker commands: `/c/Users/kenha/AppData/Roaming/Python/Python313/Scripts/uv.exe run --directory worker pytest …`. Pg integration: `docker run --rm -d --name ih-test-pg-runs -e POSTGRES_PASSWORD=test -p 55447:5432 postgres:17-alpine`, then `IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55447/postgres npx vitest run --config apps/api/vitest.integration.config.ts workbench-pg`, then `docker rm -f ih-test-pg-runs`.
- Tests first (red, then green); `npm run check` green at the end; never `git add -A` (stage the files each task names); commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A retried run stays in its batch and its progress never shows a previous attempt.** Retry keeps `params` (the Pg retry merges `outputs` into them; Memory keeps the summary's `batchId`), so the row stays in its batch. A reaped or retried attempt's old `step progress` events are older than the new claim's `started_at`, so `stepProgress` returns null until the new attempt writes one (Task 4 test: an event before `startedAt` is ignored).
2. **Approving or re-running a step must not reset a run's duration.** The trigger only fires for `task = 'process'`; approve sets `task = 'publish'` in the same UPDATE as `status = 'queued'`, and a step re-run uses `task = 'rerun'`. Task 1's Pg test walks running → awaiting_review → (publish) queued → running → succeeded and asserts the extraction's times are unchanged.
3. **A selection that went stale between load and click.** A sample removed, moved to holdout or re-preparing after the page loaded: the API answers 400/409 naming the file, nothing is queued (the check runs before any job is created), and the dialog keeps the refusal on screen (Task 2 + Task 9 tests).
4. **The queue estimate with no history.** Queue empty → `etaSeconds: 0` ("Queue: empty, runs start right away"); queued jobs but no timed run in the last 24 h → `etaSeconds: null` (count only, no "about"). A queue summary that cannot be read hides the line, never the tab (Task 5 and Task 9 tests).
5. **Old and non-batch jobs.** Runs from before this PR (`batchId` null), reference runs and evaluation jobs (which the list route has always returned) are not batches: they go to a collapsed *Other runs* list so nothing disappears from the tab (Task 9 test). Durations of rows from before migration 0028 show "—".

## Deviations from the handoff (follow main; recorded here and in the report)

- *Run on n dev samples* and *Retry* open the shared `ReprocessDialog` (main #90/#91: one model picker, one re-process dialog) instead of running at once.
- The queue line says "n jobs ahead", not "n production jobs ahead": a new Workbench run (priority −10) waits behind every queued document job, production and earlier Workbench runs alike.
- Row detail lines come from the job (status, review reasons, error, attempts, live step progress). The handoff's per-step summaries ("3 steps · totals took 2 attempts", "check passed") would need every job's step runs in the list; left out.
- The batch subtitle shows "n dev samples · started by <token label> · <model>"; "started by you" and "before the anchor change on 12 Oct" (needs TP1's draft change history) are left out.
- TR3's `progress` is on `TestRun` (the test-runs list only), not on every `JobSummary`: it costs an events query and only this tab shows it.
- TR2's `startedAt`/`finishedAt` come from a database trigger (migration 0028) instead of worker writes, and time the latest extraction attempt only.
- TR1's Template *Try on* is not wired here (the Template tab is PR 8); `sampleIds` is ready for it.
- Sample chips are checkboxes (the handoff's tick boxes), not `aria-pressed` buttons.

---

## File map

| File | Change |
| --- | --- |
| `db/migrations/0028_job_timing.sql` | Create: `started_at`, `finished_at`, trigger, index |
| `packages/shared/src/jobs.ts` | `JobSummary` fields; `STEP_PROGRESS_EVENT`, `StepProgressSchema`, `TestRunSchema`, `QueueSummarySchema` |
| `packages/shared/src/overview.ts` | runs status text |
| `packages/shared/test/jobs.test.ts` | Create: schema + fixture tests |
| `packages/shared/test/fixtures/step-progress.json` | Create: shared event payloads |
| `packages/shared/test/overview.test.ts` | runs status text cases |
| `apps/api/src/repositories/{types,memory,pg}.ts` | `JobSummary` fields; `QueueStats`, `queueStats()` |
| `apps/api/src/routes/workbench.ts` | `sampleIds`, `batchId`, list returns `TestRun[]` |
| `apps/api/src/workbench/test-runs.ts` | Create: `stepProgress` |
| `apps/api/src/jobs/queue-summary.ts` | Create: `queueSummary` |
| `apps/api/src/routes/jobs.ts` | `GET /queue/summary` |
| `apps/api/src/workbench/list.ts` | `LIST_CACHE_VERSION = 3` |
| `apps/api/test/workbench-runs.test.ts`, `apps/api/test/queue.test.ts` (create), `apps/api/test/workbench-overview.test.ts`, `apps/api/test/integration/workbench-pg.test.ts` | tests |
| `worker/src/ingest_worker/{extract,pipeline,template_pipeline}.py` | progress callbacks + event |
| `worker/tests/test_step_progress.py` (create), `worker/tests/test_queue_integration.py` | tests |
| `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/test/client.test.ts` | client |
| `apps/web/src/workbench/runs.ts` (create), `apps/web/test/runs-derive.test.ts` (create) | pure helpers |
| `apps/web/src/workbench/RunBatchCard.tsx` (create), `apps/web/test/RunBatchCard.test.tsx` (create) | batch card |
| `apps/web/src/workbench/RunSamples.tsx` (create) | sample chips + queue line |
| `apps/web/src/workbench/RunsTab.tsx`, `apps/web/test/RunsTab.test.tsx` | tab |
| `apps/web/src/workbench/ProjectPage.tsx` | wiring |
| `apps/web/src/styles/stages.css` | Test runs CSS |
| `CLAUDE.md`, `docs/openapi.json` | docs |

---

### Task 1: Migration 0028 and `JobSummary.batchId/startedAt/finishedAt` (TR2)

**Files:**
- Create: `db/migrations/0028_job_timing.sql`
- Modify: `packages/shared/src/jobs.ts`, `apps/api/src/repositories/memory.ts`, `apps/api/src/repositories/pg.ts`, `apps/web/test/fake-api.ts`
- Test: `packages/shared/test/jobs.test.ts` (create), `apps/api/test/integration/workbench-pg.test.ts`, `worker/tests/test_queue_integration.py`

**Interfaces:**
- Produces: `JobSummary.batchId: string | null` (from `jobs.params->>'batchId'`), `JobSummary.startedAt: string | null`, `JobSummary.finishedAt: string | null` (ISO). MemoryRepo sets `batchId` from `params.batchId` when a job is created and `startedAt`/`finishedAt` to null (tests set them directly on `repo.jobs`).
- Consumed by: Task 2 (batch id), Task 4 (`startedAt` guards progress), Task 5 (`queueStats` median), Tasks 7–9 (web).

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/test/jobs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { JobSummarySchema } from '../src/index.js';

const summary = {
  id: '6f1c2c1e-0000-4000-8000-000000000001',
  documentId: '6f1c2c1e-0000-4000-8000-000000000002',
  filename: 'a.pdf',
  contentType: 'application/pdf',
  specId: 'letter',
  specVersion: 2,
  status: 'succeeded',
  modelOverride: null,
  modelsUsed: [],
  attempts: 1,
  error: null,
  task: 'process',
  test: true,
  referenceId: null,
  projectId: 'letter',
  createdBy: null,
  reviewReasons: null,
  reviewer: null,
  reviewNote: null,
  reviewedAt: null,
  createdAt: '2026-10-13T10:00:00.000Z',
  updatedAt: '2026-10-13T10:01:00.000Z',
};

describe('JobSummary timing and batch (TR2)', () => {
  it('carries the batch and the extraction times', () => {
    const parsed = JobSummarySchema.parse({
      ...summary,
      batchId: '6f1c2c1e-0000-4000-8000-000000000003',
      startedAt: '2026-10-13T10:00:05.000Z',
      finishedAt: '2026-10-13T10:00:36.000Z',
    });
    expect(parsed).toMatchObject({ batchId: expect.any(String), startedAt: expect.any(String) });
  });

  it('allows a job outside any batch and never timed', () => {
    expect(
      JobSummarySchema.safeParse({ ...summary, batchId: null, startedAt: null, finishedAt: null })
        .success,
    ).toBe(true);
  });

  it('requires the fields (every producer sets them)', () => {
    expect(JobSummarySchema.safeParse(summary).success).toBe(false);
  });
});
```

Append to `apps/api/test/integration/workbench-pg.test.ts`, inside the top-level `describe.skipIf(!url)(…)` (after `'refreshes the outputs snapshot on retry, keeping the other params'`):

```ts
  it('times process runs with the trigger and reads the batch from params (TR2)', async () => {
    const projectId = await newProject();
    const batchId = randomUUID();
    const job = await repo.createWorkbenchJob(doc(projectId), {
      projectId,
      task: 'process',
      params: { dataPolicy: 'local', batchId },
    });
    expect(job).toMatchObject({ batchId, startedAt: null, finishedAt: null });
    const set = (sql: string) => pool.query(`UPDATE jobs SET ${sql} WHERE id = $1`, [job.id]);
    const read = async () => (await repo.getJob(job.id))!;

    await set(`status = 'running'`); // the worker's claim
    const running = await read();
    expect(running.startedAt).not.toBeNull();
    expect(running.finishedAt).toBeNull();

    await set(`status = 'awaiting_review'`);
    const reviewed = await read();
    expect(reviewed.startedAt).toBe(running.startedAt);
    expect(reviewed.finishedAt).not.toBeNull();
    expect(Date.parse(reviewed.finishedAt!)).toBeGreaterThanOrEqual(Date.parse(running.startedAt!));

    // Approve (publish task on the same row), the publish run: the extraction's times stay.
    await set(`status = 'queued', task = 'publish'`);
    await set(`status = 'running'`);
    await set(`status = 'succeeded'`);
    const published = await read();
    expect(published.startedAt).toBe(reviewed.startedAt);
    expect(published.finishedAt).toBe(reviewed.finishedAt);

    // A retried extraction is timed again: the claim clears the old finish.
    await set(`status = 'queued', task = 'process'`);
    await set(`status = 'running'`);
    expect((await read()).finishedAt).toBeNull();
    // A job without a batch reads null.
    const plain = await repo.createDocumentAndJob(doc(projectId), null);
    expect(plain.batchId).toBeNull();
  });
```

Append to `worker/tests/test_queue_integration.py`:

```python
def test_the_database_times_a_claimed_extraction(
    queue_with_queued_job: tuple[PgJobQueue, str],
) -> None:
    """Migration 0028: the claim and the finish set started_at/finished_at (worker unchanged)."""
    q, job_id = queue_with_queued_job
    claimed = q.claim("w1")
    assert claimed is not None and claimed.id == job_id

    def times() -> tuple[object, object]:
        row = q._conn.execute(
            "SELECT started_at, finished_at FROM jobs WHERE id = %s", (job_id,)
        ).fetchone()
        assert row is not None
        return row[0], row[1]

    started, finished = times()
    assert started is not None and finished is None
    q.complete(claimed, [], "outputs")
    started_after, finished_after = times()
    assert started_after == started
    assert finished_after is not None and finished_after >= started  # type: ignore[operator]
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project shared packages/shared/test/jobs.test.ts`
Expected: FAIL — the schema strips unknown keys, so case 1 fails on `toMatchObject` (`batchId` missing) and case 3 fails (`safeParse(summary).success` is `true`).

Run the Pg test (container from Global Constraints): `IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55447/postgres npx vitest run --config apps/api/vitest.integration.config.ts workbench-pg -t "times process runs"`
Expected: FAIL (`batchId` undefined).

The worker integration test needs `DATABASE_URL` of a migrated database; run it after Step 3 against the same container: `DATABASE_URL=postgres://postgres:test@localhost:55447/postgres /c/Users/kenha/AppData/Roaming/Python/Python313/Scripts/uv.exe run --directory worker pytest -m integration tests/test_queue_integration.py -k times` (expected FAIL before the migration: column `started_at` does not exist).

- [ ] **Step 3: Implement**

Create `db/migrations/0028_job_timing.sql`:

```sql
-- Test runs tab (Workbench tabs handoff TR2): when a job's extraction last started and finished.
-- Set by the database, so the worker is unchanged and never reads them. Only `process` runs are
-- timed: approving (task `publish`) and step re-runs (task `rerun`) reuse the row and must keep
-- the extraction's times. A claim sets started_at and clears finished_at; leaving `running`
-- (done, review, failure, cancel, reaped lock) sets finished_at.
ALTER TABLE jobs ADD COLUMN started_at timestamptz;
ALTER TABLE jobs ADD COLUMN finished_at timestamptz;

CREATE FUNCTION jobs_timing() RETURNS trigger AS $$
BEGIN
  IF NEW.task = 'process' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'running' THEN
      NEW.started_at := now();
      NEW.finished_at := NULL;
    ELSIF OLD.status = 'running' THEN
      NEW.finished_at := now();
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER jobs_timing BEFORE UPDATE OF status ON jobs
  FOR EACH ROW EXECUTE FUNCTION jobs_timing();

-- The queue estimate (GET /api/queue/summary) reads recently finished, timed runs.
CREATE INDEX jobs_finished_idx ON jobs (finished_at DESC) WHERE finished_at IS NOT NULL;
```

In `packages/shared/src/jobs.ts`, at the end of `JobSummarySchema`'s object (after `updatedAt: z.string(),`), add:

```ts
  /**
   * Workbench test runs started together (one `POST …/test-runs`) share this id
   * (`params.batchId`; handoff TR2). Null for every other job and for runs from before batches.
   */
  batchId: z.string().nullable(),
  /**
   * The latest extraction attempt's start and end (migration 0028: a database trigger on
   * `process` runs; approving and step re-runs keep them). Null before the first claim, for
   * other tasks, and for jobs from before the migration; `finishedAt` is null while running.
   */
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
```

In `apps/api/src/repositories/pg.ts`:

- `JOB_SELECT`: change the second line's tail so it reads
  `j.model_override, j.attempts, j.error, j.task, j.test, j.reference_id, j.project_id, j.created_by, j.review_reasons, j.reviewer,`
  `j.review_note, j.reviewed_at, j.created_at, j.updated_at, j.params->>'batchId' AS batch_id, j.started_at, j.finished_at,`
  (i.e. append `j.params->>'batchId' AS batch_id, j.started_at, j.finished_at,` after `j.updated_at,` and before the `array(SELECT model …)` line).
- `interface JobRow`: add `batch_id: string | null; started_at: Date | null; finished_at: Date | null;`.
- `toSummary`: add after `updatedAt`:

```ts
    batchId: r.batch_id,
    startedAt: r.started_at ? r.started_at.toISOString() : null,
    finishedAt: r.finished_at ? r.finished_at.toISOString() : null,
```

In `apps/api/src/repositories/memory.ts`, `createDocumentAndJob`'s `job` literal, after `updatedAt: now,` add:

```ts
      batchId: typeof params?.batchId === 'string' ? params.batchId : null,
      startedAt: null,
      finishedAt: null,
```

In `apps/web/test/fake-api.ts`, `job()`'s literal, after `updatedAt: …,` add `batchId: null, startedAt: null, finishedAt: null,`.

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run --project shared packages/shared/test/jobs.test.ts` → PASS.
Run: `npm run typecheck` → PASS (every `JobSummary` producer sets the fields).
Run the Pg test from Step 2 → PASS; the worker integration test from Step 2 → PASS. Then `docker rm -f ih-test-pg-runs` (or keep it for Tasks 5's Pg test).
Run: `npm test` → PASS (OpenAPI conformance: every documented `JobSummary` response now carries the fields).

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0028_job_timing.sql packages/shared/src/jobs.ts packages/shared/test/jobs.test.ts apps/api/src/repositories/memory.ts apps/api/src/repositories/pg.ts apps/api/test/integration/workbench-pg.test.ts apps/web/test/fake-api.ts worker/tests/test_queue_integration.py
git commit -m "Jobs: batch id and extraction times on JobSummary (TR2, migration 0028)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: API — run selected samples as one batch (TR1, TR2)

**Files:**
- Modify: `apps/api/src/routes/workbench.ts` (`TestRunsBody`, `POST …/test-runs`)
- Test: `apps/api/test/workbench-runs.test.ts`

**Interfaces:**
- Consumes: `JobSummary.batchId` (Task 1), `sampleViews(app, projectId)` (exists).
- Produces: `POST /api/workbench/projects/:id/test-runs` body `{ model?: string; sampleIds?: string[] }` (uuid, 1–200, unique). Errors: 400 `sample <id> is not a sample of this project`, 400 `<file> is a holdout sample: holdout samples are never test-run`, 409 `<file> is not prepared yet`. Every queued job carries `params.batchId` (one fresh uuid per call) and the response's `jobs[].batchId`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/workbench-runs.test.ts`, inside `describe('workbench dev test runs', …)`:

```ts
  const runWith = (app: Awaited<ReturnType<typeof project>>['app'], payload: object) =>
    app.inject({ method: 'POST', url: '/api/workbench/projects/letter/test-runs', payload });

  it('runs only the chosen ready dev samples, as one batch (TR1, TR2)', async () => {
    const { app, repo, add, templates } = await project();
    await templates.updateDraft('letter', 1, letter(1));
    const a = await add(1);
    await add(2);
    const c = await add(3);
    const res = await runWith(app, { sampleIds: [a.id, c.id] });
    expect(res.statusCode).toBe(201);
    const jobs = res.json().jobs as { id: string; filename: string; batchId: string }[];
    expect(jobs.map((j) => j.filename).sort()).toEqual(['s1.pdf', 's3.pdf']);
    const [batch] = new Set(jobs.map((j) => j.batchId));
    expect(batch).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(jobs.map((j) => j.batchId)).size).toBe(1);
    for (const j of jobs) expect(repo.jobParams.get(j.id)).toMatchObject({ batchId: batch });

    const again = (await runWith(app, {})).json().jobs as { batchId: string }[];
    expect(again).toHaveLength(3); // no sampleIds: every ready dev sample
    expect(new Set(again.map((j) => j.batchId)).size).toBe(1);
    expect(again[0]!.batchId).not.toBe(batch);
    const listed = (await app.inject('/api/workbench/projects/letter/test-runs')).json() as {
      batchId: string | null;
    }[];
    expect(new Set(listed.map((j) => j.batchId))).toEqual(new Set([batch, again[0]!.batchId]));
  });

  it('refuses holdout, unknown and unprepared samples before queuing anything', async () => {
    const { app, repo, add, templates } = await project();
    await templates.updateDraft('letter', 1, letter(1));
    const dev = await add(1);
    const holdout = await add(2, 'holdout');
    const preparing = await add(3, 'dev', false);
    const before = repo.jobs.size;

    const held = await runWith(app, { sampleIds: [dev.id, holdout.id] });
    expect(held.statusCode).toBe(400);
    expect(held.json().error).toBe(
      's2.pdf is a holdout sample: holdout samples are never test-run',
    );
    const unknown = await runWith(app, { sampleIds: ['00000000-0000-4000-8000-000000000009'] });
    expect(unknown.statusCode).toBe(400);
    expect(unknown.json().error).toBe(
      'sample 00000000-0000-4000-8000-000000000009 is not a sample of this project',
    );
    const notReady = await runWith(app, { sampleIds: [preparing.id] });
    expect(notReady.statusCode).toBe(409);
    expect(notReady.json().error).toBe('s3.pdf is not prepared yet');
    expect(repo.jobs.size).toBe(before);
  });

  it.each([
    ['an empty selection', { sampleIds: [] }],
    ['a duplicate', { sampleIds: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001'] }],
    ['a non-uuid', { sampleIds: ['s1.pdf'] }],
  ])('rejects %s', async (_name, payload) => {
    const { app, add, templates } = await project();
    await templates.updateDraft('letter', 1, letter(1));
    await add(1);
    expect((await runWith(app, payload)).statusCode).toBe(400);
  });

  it('keeps a retried run in its batch', async () => {
    const { app, repo, add, templates } = await project();
    await templates.updateDraft('letter', 1, letter(1));
    await add(1);
    const [job] = (await runWith(app, {})).json().jobs as { id: string; batchId: string }[];
    repo.jobs.set(job!.id, { ...repo.jobs.get(job!.id)!, status: 'failed' });
    const retried = await app.inject({ method: 'POST', url: `/api/jobs/${job!.id}/retry`, payload: {} });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().batchId).toBe(job!.batchId);
  });
```

(Run `npx prettier --write apps/api/test/workbench-runs.test.ts` after pasting: the `it.each` row is long.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project api apps/api/test/workbench-runs.test.ts`
Expected: FAIL — `sampleIds` is an unknown key of the strict body (400 where 201 is expected); `batchId` is null.

- [ ] **Step 3: Implement** in `apps/api/src/routes/workbench.ts`.

Replace `const TestRunsBody = …;` with:

```ts
const TestRunsBody = z
  .object({
    model: z.string().min(1).max(80).optional(),
    sampleIds: z
      .array(z.string().uuid())
      .min(1)
      .max(200)
      .refine((ids) => new Set(ids).size === ids.length, 'sample ids must be unique')
      .optional()
      .describe('Only these samples (each a ready dev sample). Default: every ready dev sample.'),
  })
  .strict();
```

In the `POST '/workbench/projects/:id/test-runs'` route:

- In `description`, replace "Queues a test job of the open draft for every ready dev sample (holdout samples are never used)." with "Queues a test job of the open draft for every ready dev sample, or for the ready dev samples in \`sampleIds\` (holdout samples are never used). The jobs of one call share a \`batchId\` (the Test runs tab's batches)."
- In `response`, change the 400 text to `'Zod issues, a model that cannot run here, `the draft is not valid` (with `issues`), a sample id that is not a sample of this project, or a holdout sample.'` and the 409 to `'`no open draft to test; start the next version first`, `no prepared dev samples to run`, or `<file> is not prepared yet`.'` (keep the existing `res`/`error` helpers and the backtick quoting style of the file).
- Replace the handler's tail from `const ready = (await sampleViews(app, projectId)).filter(` through `return reply.code(201).send({ jobs });` with:

```ts
      const views = await sampleViews(app, projectId);
      let chosen = views.filter((s) => s.view.role === 'dev' && s.view.state === 'ready');
      if (body.data.sampleIds) {
        const byId = new Map(views.map((s) => [s.record.id, s]));
        for (const id of body.data.sampleIds) {
          const sample = byId.get(id);
          if (!sample) {
            return reply.code(400).send({ error: `sample ${id} is not a sample of this project` });
          }
          if (sample.view.role !== 'dev') {
            return reply.code(400).send({
              error: `${sample.record.filename} is a holdout sample: holdout samples are never test-run`,
            });
          }
          if (sample.view.state !== 'ready') {
            return reply
              .code(409)
              .send({ error: `${sample.record.filename} is not prepared yet` });
          }
        }
        const wanted = new Set(body.data.sampleIds);
        chosen = chosen.filter((s) => wanted.has(s.record.id));
      }
      if (!chosen.length) return reply.code(409).send({ error: 'no prepared dev samples to run' });
      const batchId = randomUUID();
      const jobs = await Promise.all(
        chosen.map(({ record }) =>
          app.deps.repo.createWorkbenchJob(sampleDocument(record, projectId, draft), {
            projectId,
            task: 'process',
            params: {
              dataPolicy: project.dataPolicy,
              batchId,
              ...draftOutputsSnapshot(definition),
            },
            modelOverride: model,
            createdBy: req.auth?.label ?? null,
          }),
        ),
      );
      return reply.code(201).send({ jobs });
```

(`randomUUID` is already imported from `node:crypto` at the top of the file.)

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run --project api apps/api/test/workbench-runs.test.ts apps/api/test/model-picker.test.ts apps/api/test/jobs-creator.test.ts apps/api/test/openapi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/workbench.ts apps/api/test/workbench-runs.test.ts
git commit -m "Workbench API: test-run selected dev samples as one batch (TR1, TR2)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Step progress events — shared schema, worker emitter, shared fixture (TR3 contract)

**Files:**
- Create: `packages/shared/test/fixtures/step-progress.json`, `worker/tests/test_step_progress.py`
- Modify: `packages/shared/src/jobs.ts`, `packages/shared/test/jobs.test.ts`, `worker/src/ingest_worker/extract.py`, `worker/src/ingest_worker/pipeline.py`, `worker/src/ingest_worker/template_pipeline.py`

**Interfaces:**
- Produces (TS, `@ih/shared`): `STEP_PROGRESS_EVENT = 'step progress'`; `StepProgressSchema` = `{ step: string; index: int ≥1; of: int ≥1; attempt: int ≥1; chunk: { n: int ≥1; of: int ≥1 } | null }`; `type StepProgress`; `TestRunSchema = JobSummarySchema.extend({ progress: StepProgressSchema.nullable() })`; `type TestRun`.
- Produces (Python): `template_pipeline.STEP_PROGRESS = "step progress"`; `template_pipeline.step_reporter(job, queue, step_id, index, of) -> Callable[[int, dict[str, int] | None], None] | None` (None for jobs without a project); `extract.run_extraction(..., on_attempt: Callable[[int], None] | None = None)`; `pipeline.run_step_extraction(..., progress: Callable[[int, dict[str, int] | None], None] | None = None)` (the chunk dict is the existing `{"index", "count"}`).
- Event payload (the contract): `{"step", "index", "of", "attempt", "chunk": null | {"n", "of"}}`, one event at the start of each model call (each attempt of each chunk) of a Workbench job's extract step; cache hits write none. `index`/`of` count extract steps only (check steps never call a model).
- Consumed by: Task 4 (API reads), Tasks 7–8 (web shows).

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/test/fixtures/step-progress.json` — the events the worker writes for `worker/tests/test_template_pipeline.py`'s `TEMPLATE` (extract steps `header`, `date`, `data`; `data` is chunked into 2 calls):

```json
{
  "templateRun": [
    { "step": "header", "index": 1, "of": 3, "attempt": 1, "chunk": null },
    { "step": "date", "index": 2, "of": 3, "attempt": 1, "chunk": null },
    { "step": "data", "index": 3, "of": 3, "attempt": 1, "chunk": { "n": 1, "of": 2 } },
    { "step": "data", "index": 3, "of": 3, "attempt": 1, "chunk": { "n": 2, "of": 2 } }
  ]
}
```

Append to `packages/shared/test/jobs.test.ts` (add `import { readFileSync } from 'node:fs';` at the top and `StepProgressSchema, TestRunSchema` to the import from `'../src/index.js'`):

```ts
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/step-progress.json', import.meta.url), 'utf8'),
) as { templateRun: unknown[] };

describe('step progress (TR3)', () => {
  it.each(fixture.templateRun.map((e, i) => [i, e] as const))(
    "parses the worker's event %i",
    (_i, event) => {
      expect(StepProgressSchema.parse(event)).toEqual(event);
    },
  );

  it.each([
    ['a zero attempt', { step: 'a', index: 1, of: 1, attempt: 0, chunk: null }],
    ['a missing chunk key', { step: 'a', index: 1, of: 1, attempt: 1 }],
    ['a half chunk', { step: 'a', index: 1, of: 1, attempt: 1, chunk: { n: 1 } }],
  ])('rejects %s', (_name, event) => {
    expect(StepProgressSchema.safeParse(event).success).toBe(false);
  });

  it('a test run is a job summary with its progress', () => {
    const run = {
      ...summary,
      status: 'running',
      batchId: null,
      startedAt: '2026-10-13T10:00:05.000Z',
      finishedAt: null,
      progress: fixture.templateRun[2],
    };
    expect(TestRunSchema.parse(run).progress).toEqual(fixture.templateRun[2]);
    expect(TestRunSchema.safeParse({ ...run, progress: null }).success).toBe(true);
  });
});
```

Create `worker/tests/test_step_progress.py`:

```python
"""Step progress events (Workbench tabs TR3): one per model call of a Workbench run."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

from ingest_worker.config import REPO_ROOT
from ingest_worker.main import run_once
from ingest_worker.template_pipeline import STEP_PROGRESS

from .fakes import FakeQueue
from .test_step_context import make
from .test_template_pipeline import JOB, RESPONSES, TEMPLATE

FIXTURE = REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "step-progress.json"
EXPECTED: list[dict[str, Any]] = json.loads(FIXTURE.read_text(encoding="utf-8"))["templateRun"]

WORKBENCH = replace(JOB, test=True, project_id="demo", params={"dataPolicy": "external"})


def run(tmp_path: Path, job: Any, responses: list[Any]) -> FakeQueue:
    deps, _ = make(tmp_path, responses)
    queue = FakeQueue(jobs=[job], templates={("demo", 1): TEMPLATE})
    run_once(queue, deps, "w1")
    return queue


def progress(queue: FakeQueue) -> list[dict[str, Any]]:
    return [data for _, _, message, data in queue.event_details if message == STEP_PROGRESS]


def test_a_workbench_run_reports_each_model_call_like_the_shared_fixture(tmp_path: Path) -> None:
    queue = run(tmp_path, WORKBENCH, RESPONSES)
    assert queue.completed or queue.awaiting  # the run itself is unaffected
    assert progress(queue) == EXPECTED


def test_a_retried_attempt_is_reported(tmp_path: Path) -> None:
    queue = run(tmp_path, WORKBENCH, ["not json", *RESPONSES])
    assert [(e["step"], e["attempt"]) for e in progress(queue)[:3]] == [
        ("header", 1),
        ("header", 2),
        ("date", 1),
    ]


def test_production_jobs_write_no_progress(tmp_path: Path) -> None:
    queue = run(tmp_path, JOB, RESPONSES)
    assert progress(queue) == []


def test_a_step_served_from_the_cache_reports_nothing(tmp_path: Path) -> None:
    deps, _ = make(tmp_path, RESPONSES)
    first = FakeQueue(jobs=[WORKBENCH], templates={("demo", 1): TEMPLATE})
    run_once(first, deps, "w1")
    second = FakeQueue(jobs=[replace(WORKBENCH, id="job-2")], templates={("demo", 1): TEMPLATE})
    run_once(second, deps, "w1")
    assert progress(first) == EXPECTED
    assert progress(second) == []


class _BrokenEvents(FakeQueue):
    def event(
        self, job_id: str, level: str, message: str, data: dict[str, Any] | None = None
    ) -> None:
        if message == STEP_PROGRESS:
            raise RuntimeError("database blip")
        super().event(job_id, level, message, data)


def test_a_failed_progress_write_never_fails_the_run(tmp_path: Path) -> None:
    deps, _ = make(tmp_path, RESPONSES)
    queue = _BrokenEvents(jobs=[WORKBENCH], templates={("demo", 1): TEMPLATE})
    run_once(queue, deps, "w1")
    assert queue.failed == [] and queue.reviewed == []
    assert queue.completed or queue.awaiting
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project shared packages/shared/test/jobs.test.ts` → FAIL (`StepProgressSchema` is undefined).
Run: `/c/Users/kenha/AppData/Roaming/Python/Python313/Scripts/uv.exe run --directory worker pytest tests/test_step_progress.py` → FAIL (`ImportError: cannot import name 'STEP_PROGRESS'`).

- [ ] **Step 3: Implement**

`packages/shared/src/jobs.ts`, after `export type JobSummary = …;`:

```ts
/** Job event a Workbench run's worker writes per model call (worker: template_pipeline.STEP_PROGRESS). */
export const STEP_PROGRESS_EVENT = 'step progress';

/**
 * Where a running Workbench extraction is (handoff TR3): extract step `index` of `of` (check
 * steps are not counted), its id, the attempt of the current call and, for a chunked step, the
 * chunk. Shared fixture: packages/shared/test/fixtures/step-progress.json.
 */
export const StepProgressSchema = z.object({
  step: z.string(),
  index: z.number().int().positive(),
  of: z.number().int().positive(),
  attempt: z.number().int().positive(),
  chunk: z
    .object({ n: z.number().int().positive(), of: z.number().int().positive() })
    .nullable(),
});
export type StepProgress = z.infer<typeof StepProgressSchema>;

/** A project's job as the Test runs tab lists it: the summary plus a running run's progress. */
export const TestRunSchema = JobSummarySchema.extend({
  /** While running: the latest progress of this attempt; null otherwise or before any. */
  progress: StepProgressSchema.nullable(),
});
export type TestRun = z.infer<typeof TestRunSchema>;
```

`worker/src/ingest_worker/extract.py`, `run_extraction`: add the keyword parameter after `check`:

```python
    on_attempt: Callable[[int], None] | None = None,
```

extend the docstring with `` `on_attempt(n)` is called before each model call (progress reporting).``, and make the loop's first statement:

```python
    for n in range(1, max_attempts + 1):
        if on_attempt is not None:
            on_attempt(n)
        result = provider.complete_json(
```

`worker/src/ingest_worker/pipeline.py`:

- Add to `run_step_extraction`'s keyword-only parameters (after `cache: StepCache | None = None,`):

```python
    progress: Callable[[int, dict[str, int] | None], None] | None = None,
```

and to its docstring: `` `progress(attempt, chunk)` is called before each model call (never for a cache hit).`` (`Callable` — import it from `collections.abc` if the module does not already.)
- Add above `run_step_extraction`:

```python
def _attempt_reporter(
    progress: Callable[[int, dict[str, int] | None], None] | None,
    chunk: dict[str, int] | None,
) -> Callable[[int], None] | None:
    """Bind a chunk to the step's progress callback (None: no reporting)."""
    if progress is None:
        return None
    report = progress
    return lambda attempt: report(attempt, chunk)
```

- In the `for audit_id, prompt, chunk in rendered:` loop, pass `on_attempt=_attempt_reporter(progress, chunk),` to `run_extraction(...)` (after `max_tokens=ex.max_tokens,`). `chunk` there is `dict[str, Any] | None`; if mypy objects, annotate `_attempt_reporter`'s `chunk` as `dict[str, Any] | None` and `progress` as `Callable[[int, dict[str, Any] | None], None] | None` — use the same alias in all three places.

`worker/src/ingest_worker/template_pipeline.py`:

- Imports: add `import logging` and `from collections.abc import Callable`; below `ISSUE_COLUMNS = …` add:

```python
log = logging.getLogger("ingest_worker")

#: Job event the API reads for the Test runs tab (TS: STEP_PROGRESS_EVENT, StepProgressSchema).
STEP_PROGRESS = "step progress"

Progress = Callable[[int, dict[str, Any] | None], None]


def step_reporter(
    job: ClaimedJob, queue: JobQueue, step_id: str, index: int, of: int
) -> Progress | None:
    """Workbench jobs only: a `step progress` event before each model call of a step (its place
    among the extract steps, the attempt, the chunk). Advisory: a failed write (job deleted
    mid-run, database blip) never fails the step. Production jobs write none."""
    if job.project_id is None:
        return None

    def report(attempt: int, chunk: dict[str, Any] | None) -> None:
        data = {
            "step": step_id,
            "index": index,
            "of": of,
            "attempt": attempt,
            "chunk": None if chunk is None else {"n": chunk["index"], "of": chunk["count"]},
        }
        try:
            queue.event(job.id, "info", STEP_PROGRESS, data)
        except Exception:
            log.exception("could not record step progress for job %s", job.id)

    return report
```

- `_run_step`: add the keyword parameter `progress: Progress | None = None,` (after `cache`) and pass `progress=progress` to `run_step_extraction(...)` (after `cache=cache`).
- `process_template_job`: after `compiled = {…}` add `extract_ids = [s.id for s in template.extract_steps()]`, and in the `_run_step(...)` call add (after `cache=cache,`):

```python
            progress=step_reporter(
                job, queue, step.id, extract_ids.index(step.id) + 1, len(extract_ids)
            ),
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run --project shared packages/shared/test/jobs.test.ts` → PASS.
Run: `/c/Users/kenha/AppData/Roaming/Python/Python313/Scripts/uv.exe run --directory worker pytest tests/test_step_progress.py tests/test_step_cache.py tests/test_template_pipeline.py tests/test_extract.py` → PASS.
Run: `npm run worker:lint` → PASS (ruff, format, mypy --strict).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/jobs.ts packages/shared/test/jobs.test.ts packages/shared/test/fixtures/step-progress.json worker/src/ingest_worker/extract.py worker/src/ingest_worker/pipeline.py worker/src/ingest_worker/template_pipeline.py worker/tests/test_step_progress.py
git commit -m "Worker: step progress events for Workbench runs, shared schema and fixture (TR3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: API — test runs with their progress (TR3)

**Files:**
- Create: `apps/api/src/workbench/test-runs.ts`
- Modify: `apps/api/src/routes/workbench.ts` (`GET …/test-runs`)
- Test: `apps/api/test/workbench-runs.test.ts`

**Interfaces:**
- Consumes: `STEP_PROGRESS_EVENT`, `StepProgressSchema`, `TestRunSchema` (Task 3); `JobSummary.startedAt` (Task 1); `IngestionRepo.latestEvents` (exists).
- Produces: `stepProgress(job: JobSummary, events: readonly JobEventRecord[]): StepProgress | null`; `GET /api/workbench/projects/:id/test-runs` → `TestRun[]` (unchanged membership: every project job except `prepare`, newest first).

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/workbench-runs.test.ts` (top-level, after the existing describes; add `STEP_PROGRESS_EVENT` to the `@ih/shared` import):

```ts
describe('test run progress (TR3)', () => {
  async function runningRun() {
    const ctx = await project();
    await ctx.templates.updateDraft('letter', 1, letter(1));
    await ctx.add(1);
    const [created] = (await ctx.run()).json().jobs as { id: string }[];
    const id = created!.id;
    const startedAt = ctx.repo.now();
    ctx.repo.jobs.set(id, { ...ctx.repo.jobs.get(id)!, status: 'running', startedAt });
    const listed = async () =>
      ((await ctx.app.inject('/api/workbench/projects/letter/test-runs')).json() as {
        id: string;
        progress: unknown;
      }[]).find((j) => j.id === id)!;
    return { ...ctx, id, listed };
  }
  const event = { step: 'totals', index: 3, of: 3, attempt: 2, chunk: null };

  it("shows a running run's latest progress of this attempt", async () => {
    const r = await runningRun();
    expect((await r.listed()).progress).toBeNull(); // nothing reported yet
    r.repo.addEvent(r.id, 'info', STEP_PROGRESS_EVENT, { ...event, attempt: 1 });
    r.repo.addEvent(r.id, 'info', STEP_PROGRESS_EVENT, event);
    expect((await r.listed()).progress).toEqual(event);
  });

  it("ignores an earlier attempt's progress, malformed data and finished runs", async () => {
    const r = await runningRun();
    r.repo.addEvent(r.id, 'info', STEP_PROGRESS_EVENT, event);
    // The run is claimed again (retry or reaped lock): the old event predates this attempt.
    r.repo.jobs.set(r.id, { ...r.repo.jobs.get(r.id)!, startedAt: r.repo.now() });
    expect((await r.listed()).progress).toBeNull();
    r.repo.addEvent(r.id, 'info', STEP_PROGRESS_EVENT, { step: 'totals' });
    expect((await r.listed()).progress).toBeNull();
    r.repo.addEvent(r.id, 'info', STEP_PROGRESS_EVENT, event);
    r.repo.jobs.set(r.id, { ...r.repo.jobs.get(r.id)!, status: 'succeeded' });
    expect((await r.listed()).progress).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project api apps/api/test/workbench-runs.test.ts -t "progress"`
Expected: FAIL (`progress` is undefined).

- [ ] **Step 3: Implement**

Create `apps/api/src/workbench/test-runs.ts`:

```ts
import {
  STEP_PROGRESS_EVENT,
  StepProgressSchema,
  type JobSummary,
  type StepProgress,
} from '@ih/shared';
import type { JobEventRecord } from '../repositories/types.js';

/**
 * A running test run's progress in this attempt (handoff TR3): the newest `step progress` event
 * written since the job was claimed (`startedAt`, else the claim's `updatedAt` for rows from
 * before migration 0028), so an earlier attempt's progress never shows.
 */
export function stepProgress(
  job: JobSummary,
  events: readonly JobEventRecord[],
): StepProgress | null {
  if (job.status !== 'running') return null;
  const latest = events.find((e) => e.jobId === job.id && e.message === STEP_PROGRESS_EVENT);
  if (!latest || Date.parse(latest.at) < Date.parse(job.startedAt ?? job.updatedAt)) return null;
  const parsed = StepProgressSchema.safeParse(latest.data);
  return parsed.success ? parsed.data : null;
}
```

In `apps/api/src/routes/workbench.ts`: import `stepProgress` from `'../workbench/test-runs.js'`, add `STEP_PROGRESS_EVENT` and `TestRunSchema` to the `@ih/shared` import; in the `GET '/workbench/projects/:id/test-runs'` route set the description to

```ts
        description: md`
          The project's jobs except sample preparation: test runs, reference runs and
          evaluation jobs, newest first. Test runs started together share a \`batchId\`; a
          running job carries its latest \`progress\` in this attempt (step, attempt, chunk;
          null before the first model call). Open one with \`GET /api/jobs/{id}/review\`.
        `,
```

the 200 response to `res('The jobs.', z.array(TestRunSchema))`, and the handler's tail to:

```ts
      const jobs = (await app.deps.repo.listProjectJobs(req.params.id)).filter(
        (j) => j.task !== 'prepare',
      );
      const running = jobs.filter((j) => j.status === 'running').map((j) => j.id);
      const events = running.length
        ? await app.deps.repo.latestEvents(running, [STEP_PROGRESS_EVENT])
        : [];
      return jobs.map((j) => ({ ...j, progress: stepProgress(j, events) }));
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run --project api apps/api/test/workbench-runs.test.ts apps/api/test/openapi.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/workbench/test-runs.ts apps/api/src/routes/workbench.ts apps/api/test/workbench-runs.test.ts
git commit -m "Workbench API: test runs carry their step progress (TR3)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Queue summary — `queueStats`, `GET /api/queue/summary` (TR4)

**Files:**
- Create: `apps/api/src/jobs/queue-summary.ts`, `apps/api/test/queue.test.ts`
- Modify: `packages/shared/src/jobs.ts`, `apps/api/src/repositories/types.ts`, `apps/api/src/repositories/memory.ts`, `apps/api/src/repositories/pg.ts`, `apps/api/src/routes/jobs.ts`, `apps/api/test/integration/workbench-pg.test.ts`, `docs/openapi.json` (generated)

**Interfaces:**
- Produces (shared): `QueueSummarySchema = { ahead: int ≥0, running: int ≥0, etaSeconds: int ≥0 | null }`, `type QueueSummary`.
- Produces (repo): `interface QueueStats { queued: number; running: number; medianSeconds: number | null }`; `IngestionRepo.queueStats(): Promise<QueueStats>` — queued/running count jobs **with a document** (`document_id IS NOT NULL`: the CLAUDE.md rule for queries bypassing `JOB_SELECT`); `medianSeconds` is the median of `finished_at - started_at` over the 50 newest timed jobs finished in the last 24 h (null if none).
- Produces (API): `queueSummary(stats: QueueStats): QueueSummary` — `ahead = queued`; `etaSeconds = 0` when nothing is queued, `null` without a median, else `ceil(queued × median / max(1, running))`. Route `GET /api/queue/summary` (tag Jobs, `operationId: 'getQueueSummary'`, any signed-in user).
- Consumed by: Task 7 (client), Task 9 (queue line).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/queue.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { queueSummary } from '../src/jobs/queue-summary.js';
import { testApp } from './helpers.js';

const doc = (n: number) => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  filename: `q${n}.pdf`,
  sha256: String(n).repeat(64),
  sizeBytes: 1,
  specId: 'letter',
  specVersion: 1,
  bucket: 'inbox',
  objectKey: `letter/v1/q${n}.pdf`,
});

describe('queueSummary (TR4)', () => {
  it.each([
    ['an empty queue starts right away', { queued: 0, running: 2, medianSeconds: null }, 0],
    ['no timing history: count only', { queued: 3, running: 1, medianSeconds: null }, null],
    ['one busy worker', { queued: 2, running: 1, medianSeconds: 60 }, 120],
    ['workers share the queue', { queued: 3, running: 2, medianSeconds: 40 }, 60],
    ['an idle queue counts one worker', { queued: 2, running: 0, medianSeconds: 30.4 }, 61],
  ])('%s', (_name, stats, eta) => {
    expect(queueSummary(stats)).toEqual({
      ahead: stats.queued,
      running: stats.running,
      etaSeconds: eta,
    });
  });
});

describe('GET /api/queue/summary', () => {
  it('counts the queue and estimates from recent timed runs', async () => {
    const { app, repo } = await testApp();
    expect((await app.inject('/api/queue/summary')).json()).toEqual({
      ahead: 0,
      running: 0,
      etaSeconds: 0,
    });
    // Four jobs: the first two stay queued, c runs, d finished 60 s after it started.
    const [, , c, d] = await Promise.all(
      [1, 2, 3, 4].map((n) => repo.createDocumentAndJob(doc(n), null)),
    );
    const now = Date.now();
    const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
    repo.jobs.set(c!.id, { ...c!, status: 'running', startedAt: iso(5_000) });
    repo.jobs.set(d!.id, {
      ...d!,
      status: 'succeeded',
      startedAt: iso(100_000),
      finishedAt: iso(40_000), // took 60 s
    });
    expect((await app.inject('/api/queue/summary')).json()).toEqual({
      ahead: 2,
      running: 1,
      etaSeconds: 120,
    });
  });

  it('ignores runs that finished more than a day ago', async () => {
    const { app, repo } = await testApp();
    const [, old] = await Promise.all([1, 2].map((n) => repo.createDocumentAndJob(doc(n), null)));
    const day = 24 * 3600_000;
    repo.jobs.set(old!.id, {
      ...old!,
      status: 'succeeded',
      startedAt: new Date(Date.now() - day - 120_000).toISOString(),
      finishedAt: new Date(Date.now() - day - 60_000).toISOString(),
    });
    expect((await app.inject('/api/queue/summary')).json()).toEqual({
      ahead: 1,
      running: 0,
      etaSeconds: null,
    });
  });
});
```

Append to `apps/api/test/integration/workbench-pg.test.ts` (inside the top-level describe):

```ts
  it('counts the queue and takes the median of the newest timed runs (TR4)', async () => {
    const projectId = await newProject();
    const before = await repo.queueStats();
    const queued = await repo.createDocumentAndJob(doc(projectId), null);
    const running = await repo.createDocumentAndJob(doc(projectId), null);
    await pool.query(`UPDATE jobs SET status = 'running' WHERE id = $1`, [running.id]);
    // 50 runs finished "later" than anything else, so they are the newest 50: median 20 s.
    const timed = doc(projectId);
    await repo.createDocumentAndJob(timed, null);
    await pool.query(
      `INSERT INTO jobs (document_id, status, started_at, finished_at)
       SELECT $1, 'succeeded', now() + interval '1 hour', now() + interval '1 hour 20 seconds'
         FROM generate_series(1, 50)`,
      [timed.id],
    );
    try {
      const after = await repo.queueStats();
      expect(after.queued).toBe(before.queued + 2); // `queued` + the job created with `timed`
      expect(after.running).toBe(before.running + 1);
      expect(after.medianSeconds).toBeCloseTo(20, 3);
    } finally {
      await pool.query(`DELETE FROM documents WHERE id = ANY($1::uuid[])`, [
        [queued.documentId, running.documentId, timed.id],
      ]);
    }
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project api apps/api/test/queue.test.ts` → FAIL (module `../src/jobs/queue-summary.js` not found).

- [ ] **Step 3: Implement**

`packages/shared/src/jobs.ts`, after `TestRun`:

```ts
/**
 * The queue a new Workbench run waits behind (handoff TR4): queued document jobs (production
 * and earlier Workbench runs), the jobs running now, and a rough wait (null without recent timed
 * runs; 0 when nothing is queued).
 */
export const QueueSummarySchema = z.object({
  ahead: z.number().int().nonnegative(),
  running: z.number().int().nonnegative(),
  etaSeconds: z.number().int().nonnegative().nullable(),
});
export type QueueSummary = z.infer<typeof QueueSummarySchema>;
```

`apps/api/src/repositories/types.ts`: next to `JobEventRecord`, add

```ts
/** What the queue estimate reads (GET /api/queue/summary). Document jobs only. */
export interface QueueStats {
  queued: number;
  running: number;
  /** Median seconds of the 50 newest timed runs finished in the last 24 h; null if none. */
  medianSeconds: number | null;
}
```

and to `IngestionRepo`, after `latestEvents`:

```ts
  /** Queued and running document jobs, and the median duration of recent timed runs. */
  queueStats(): Promise<QueueStats>;
```

`apps/api/src/repositories/memory.ts` (import `type QueueStats` from `./types.js`), after `latestEvents`:

```ts
  async queueStats(): Promise<QueueStats> {
    const jobs = [...this.jobs.values()];
    const since = Date.now() - 24 * 3600_000;
    const secs = jobs
      .filter((j) => j.startedAt && j.finishedAt && Date.parse(j.finishedAt) > since)
      .sort((a, b) => b.finishedAt!.localeCompare(a.finishedAt!))
      .slice(0, 50)
      .map((j) => (Date.parse(j.finishedAt!) - Date.parse(j.startedAt!)) / 1000)
      .filter((s) => s >= 0)
      .sort((a, b) => a - b);
    const mid = secs.length / 2;
    const median = !secs.length
      ? null
      : secs.length % 2
        ? secs[Math.floor(mid)]!
        : (secs[mid - 1]! + secs[mid]!) / 2;
    return {
      queued: jobs.filter((j) => j.status === 'queued').length,
      running: jobs.filter((j) => j.status === 'running').length,
      medianSeconds: median,
    };
  }
```

(MemoryRepo's `jobs` map only holds document jobs; segment, draft and export jobs live in their own maps.)

`apps/api/src/repositories/pg.ts` (import `type QueueStats`), after `latestEvents`:

```ts
  async queueStats(): Promise<QueueStats> {
    // Document jobs only (any query bypassing JOB_SELECT must exclude document-less rows).
    const { rows } = await this.pool.query<{
      queued: string;
      running: string;
      median: number | null;
    }>(
      `SELECT count(*) FILTER (WHERE status = 'queued') AS queued,
              count(*) FILTER (WHERE status = 'running') AS running,
              (SELECT percentile_cont(0.5) WITHIN GROUP (ORDER BY secs)
                 FROM (SELECT extract(epoch FROM finished_at - started_at)::float8 AS secs
                         FROM jobs
                        WHERE document_id IS NOT NULL AND finished_at >= started_at
                          AND finished_at > now() - interval '24 hours'
                        ORDER BY finished_at DESC LIMIT 50) t) AS median
         FROM jobs
        WHERE document_id IS NOT NULL AND status IN ('queued', 'running')`,
    );
    const row = rows[0]!;
    return {
      queued: Number(row.queued),
      running: Number(row.running),
      medianSeconds: row.median === null ? null : Number(row.median),
    };
  }
```

Create `apps/api/src/jobs/queue-summary.ts`:

```ts
import type { QueueSummary } from '@ih/shared';
import type { QueueStats } from '../repositories/types.js';

/**
 * The Test runs tab's queue line (handoff TR4). A new Workbench run waits behind every queued
 * document job; each running job is taken as one busy worker (at least one), and recent runs'
 * median duration gives a rough wait. No history: no estimate (null). Nothing queued: 0.
 */
export function queueSummary({ queued, running, medianSeconds }: QueueStats): QueueSummary {
  const etaSeconds =
    queued === 0
      ? 0
      : medianSeconds === null
        ? null
        : Math.ceil((queued * medianSeconds) / Math.max(1, running));
  return { ahead: queued, running, etaSeconds };
}
```

`apps/api/src/routes/jobs.ts`: add `QueueSummarySchema` to the `@ih/shared` import and `import { queueSummary } from '../jobs/queue-summary.js';`; inside `jobRoutes`, after the `GET '/jobs'` route, add:

```ts
  app.get(
    '/queue/summary',
    {
      schema: {
        tags: ['Jobs'],
        operationId: 'getQueueSummary',
        summary: 'How long a new run would wait',
        description: md`
          The queue a new Workbench test run waits behind: \`ahead\` counts the queued jobs
          with a document (production first, then earlier Workbench runs), \`running\` the jobs
          running now, and \`etaSeconds\` is a rough wait from the median duration of the
          newest timed runs of the last 24 hours, shared among the busy workers (null without
          such runs; 0 when nothing is queued). Counts only: no job or project is named.
        `,
        response: { 200: res('The queue.', QueueSummarySchema) },
      },
    },
    async () => queueSummary(await app.deps.repo.queueStats()),
  );
```

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run --project api apps/api/test/queue.test.ts apps/api/test/openapi.test.ts apps/api/test/access.test.ts` → PASS (the access sweep finds the new route guarded).
Run the Pg test: `IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55447/postgres npx vitest run --config apps/api/vitest.integration.config.ts workbench-pg -t "median"` → PASS.
Run: `npm run openapi` and check `git diff --stat docs/openapi.json` shows the new path, the `sampleIds` body, `TestRun` and the `JobSummary` fields.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/jobs.ts apps/api/src/repositories/types.ts apps/api/src/repositories/memory.ts apps/api/src/repositories/pg.ts apps/api/src/jobs/queue-summary.ts apps/api/src/routes/jobs.ts apps/api/test/queue.test.ts apps/api/test/integration/workbench-pg.test.ts docs/openapi.json
git commit -m "Jobs API: queue summary with a rough wait for new runs (TR4)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Overview — the runs status line, list cache version

**Files:**
- Modify: `packages/shared/src/overview.ts`, `packages/shared/test/overview.test.ts`, `apps/api/test/workbench-overview.test.ts`, `apps/api/src/workbench/list.ts`

**Interfaces:**
- Produces: the `runs` overview item's `status`: running → `"{u} test run(s) in progress"` plus `" · {a} awaiting review"` when any; warn → `"{a} awaiting review"`; accepted → `"{t} finished"`; pending → `"No runs yet"` (states unchanged). `LIST_CACHE_VERSION = 3`.

- [ ] **Step 1: Write the failing tests**

In `packages/shared/test/overview.test.ts`, test `'describes Publish, Template and Test runs'`: change the expected `status: '2 running'` to `status: '2 test runs in progress · 1 awaiting review'`, and add after that expectation:

```ts
    expect(
      status(ctx({ runs: { total: 3, unfinished: 1, awaitingReview: 0 } }), 'runs').status,
    ).toBe('1 test run in progress');
```

(The old text is replaced deliberately: the handoff's status line names the runs in progress and the ones awaiting review together.)

In `apps/api/test/workbench-overview.test.ts`, test `'counts test runs by status'`: replace `expect((await p.item('runs')).state).toBe('running');` with

```ts
    expect(await p.item('runs')).toMatchObject({
      state: 'running',
      status: '1 test run in progress',
    });
```

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project shared packages/shared/test/overview.test.ts -t "Test runs"` → FAIL (`'2 running'`).

- [ ] **Step 3: Implement** — in `packages/shared/src/overview.ts`, `overviewItems`, replace the `runsText` expression with:

```ts
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
  const awaiting =
    ctx.runs.awaitingReview > 0 ? ` · ${ctx.runs.awaitingReview} awaiting review` : '';
  const runsText =
    runs === 'running'
      ? `${plural(ctx.runs.unfinished, 'test run')} in progress${awaiting}`
      : runs === 'warn'
        ? `${ctx.runs.awaitingReview} awaiting review`
        : runs === 'accepted'
          ? `${ctx.runs.total} finished`
          : 'No runs yet';
```

In `apps/api/src/workbench/list.ts` set `export const LIST_CACHE_VERSION = 3;` (the list rows carry the overview's status text).

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run --project shared packages/shared/test/overview.test.ts packages/shared/test/overview-list.test.ts` → PASS.
Run: `npx vitest run --project api apps/api/test/workbench-overview.test.ts apps/api/test/workbench-list.test.ts` → PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/overview.ts packages/shared/test/overview.test.ts apps/api/test/workbench-overview.test.ts apps/api/src/workbench/list.ts
git commit -m "Workbench overview: Test runs status names runs in progress and awaiting review

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Web — client, fakes, pure Test runs helpers

**Files:**
- Create: `apps/web/src/workbench/runs.ts`, `apps/web/test/runs-derive.test.ts`
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/test/client.test.ts`

**Interfaces:**
- Consumes: `TestRun`, `StepProgress`, `QueueSummary` (Tasks 3, 5); `statusLabel`, `statusTone`, `Tone` (`apps/web/src/jobs/derive.ts`); `shortDateTime` (`apps/web/src/workbench/references.ts`).
- Produces (client): `runDevTests(projectId, opts?: { model?: string | null; sampleIds?: string[] }): Promise<{ jobs: JobSummary[] }>` (body `{ model? , sampleIds? }`, each only when set); `listTestRuns(projectId): Promise<TestRun[]>`; `getQueueSummary(): Promise<QueueSummary>` (`GET /api/queue/summary`).
- Produces (fakes): `testRunView(overrides?: Partial<TestRun>): TestRun` (a dev test run of `letter`, `progress: null`); `fakeApi` gains `getQueueSummary` → `{ ahead: 0, running: 0, etaSeconds: 0 }`.
- Produces (`runs.ts`):
  - `interface RunBatch { id; createdAt; specVersion; createdBy: string | null; modelOverride: string | null; runs: TestRun[]; active: boolean }`
  - `isActiveRun(run): boolean`; `runBatches(runs): { batches: RunBatch[]; others: TestRun[] }` (batches newest first, rows by file name)
  - `splitBatches(batches): { shown: RunBatch[]; hidden: RunBatch[] }` (the newest two and any active one shown)
  - `interface Segment { status: JobStatus; count: number; label: string; tone: Tone }`; `batchSegments(batch): Segment[]`; `segmentsText(segments): string`
  - `batchTitle(batch, now): string`; `batchSubtitle(batch, choices: readonly ModelChoice[]): string`; `olderText(hidden): string`
  - `progressText(p: StepProgress): string`; `runDetail(run): { text: string; tone: 'muted' | 'warn' | 'danger' | 'info' }`
  - `formatDuration(seconds): string`; `runDuration(run, now): string`
  - `type RunAction = 'review-now' | 'review' | 'retry' | null`; `runAction(run): RunAction`
  - `interface SampleChoice { sample: SampleView; selectable: boolean; reason: string | null }`; `runSamples(samples): SampleChoice[]` (dev only)
  - `runLabel(n): string`; `runBlockedReason(draft: number | null, n: number): string | null`; `queueText(q: QueueSummary | null): string | null`

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/client.test.ts`, test `'sends the model choice of a dev test run and of a test upload, before the file'`: replace

```ts
    await api.runDevTests('letter', 'test');
    await api.runDevTests('letter', null);
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { model: 'test' },
      {},
    ]);
```

with

```ts
    await api.runDevTests('letter', { model: 'test' });
    await api.runDevTests('letter', { model: null });
    await api.runDevTests('letter', { sampleIds: ['s1', 's2'] });
    await api.runDevTests('letter');
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
      { model: 'test' },
      {},
      { sampleIds: ['s1', 's2'] },
      {},
    ]);
```

(The signature changes from a positional model to options, so the call sites change with it; the bodies sent for the old calls are unchanged.) Append a new test to that describe:

```ts
  it('reads the queue summary', async () => {
    const fetchMock = vi.fn(async (_url: string) =>
      respond(200, { ahead: 3, running: 1, etaSeconds: 120 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    expect(await api.getQueueSummary()).toEqual({ ahead: 3, running: 1, etaSeconds: 120 });
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/queue/summary');
  });
```

Create `apps/web/test/runs-derive.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { ModelChoice, TestRun } from '@ih/shared';
import {
  batchSegments,
  batchSubtitle,
  batchTitle,
  formatDuration,
  olderText,
  progressText,
  queueText,
  runAction,
  runBatches,
  runBlockedReason,
  runDetail,
  runDuration,
  runLabel,
  runSamples,
  segmentsText,
  splitBatches,
  type RunBatch,
} from '../src/workbench/runs.js';
import { sampleView, testRunView } from './fake-api.js';

const at = (s: number) => new Date(Date.UTC(2026, 9, 12, 10, 0, s)).toISOString();

describe('runBatches', () => {
  it('groups by batch, newest first, rows by file; runs outside a batch go to others', () => {
    const old1 = testRunView({ batchId: 'b1', filename: 'b.pdf', createdAt: at(0) });
    const old2 = testRunView({ batchId: 'b1', filename: 'a.pdf', createdAt: at(1) });
    const fresh = testRunView({ batchId: 'b2', filename: 'c.pdf', createdAt: at(30), status: 'running' });
    const loose = testRunView({ batchId: null, filename: 'ref.pdf' });
    const { batches, others } = runBatches([old1, fresh, loose, old2]);
    expect(batches.map((b) => b.id)).toEqual(['b2', 'b1']);
    expect(batches[1]!.runs.map((r) => r.filename)).toEqual(['a.pdf', 'b.pdf']);
    expect(batches[1]!.createdAt).toBe(at(0));
    expect(batches.map((b) => b.active)).toEqual([true, false]);
    expect(others).toEqual([loose]);
  });
});

describe('splitBatches', () => {
  const b = (id: string, active = false) => ({ id, active }) as RunBatch;
  it.each([
    [[b('1'), b('2')], ['1', '2'], []],
    [[b('1'), b('2'), b('3'), b('4')], ['1', '2'], ['3', '4']],
    [[b('1'), b('2'), b('3', true)], ['1', '2', '3'], []],
  ])('%#', (batches, shown, hidden) => {
    const split = splitBatches(batches);
    expect(split.shown.map((x) => x.id)).toEqual(shown);
    expect(split.hidden.map((x) => x.id)).toEqual(hidden);
  });
});

describe('batch header', () => {
  const batch = (runs: TestRun[], extra: Partial<RunBatch> = {}): RunBatch => ({
    id: 'b',
    createdAt: at(0),
    specVersion: 4,
    createdBy: 'ken',
    modelOverride: null,
    runs,
    active: false,
    ...extra,
  });

  it('counts statuses in a fixed order with their tones', () => {
    const segments = batchSegments(
      batch([
        testRunView({ status: 'running' }),
        testRunView({ status: 'succeeded' }),
        testRunView({ status: 'awaiting_review' }),
        testRunView({ status: 'succeeded' }),
        testRunView({ status: 'failed' }),
      ]),
    );
    expect(segments.map((s) => [s.status, s.count, s.tone])).toEqual([
      ['succeeded', 2, 'ok'],
      ['awaiting_review', 1, 'warn'],
      ['running', 1, 'info'],
      ['failed', 1, 'danger'],
    ]);
    expect(segmentsText(segments)).toBe('2 succeeded · 1 awaiting review · 1 running · 1 failed');
  });

  it('titles a batch by time and draft version, "Just now" within a minute', () => {
    const b1 = batch([]);
    expect(batchTitle(b1, Date.parse(at(30)))).toBe('Just now · draft v4');
    expect(batchTitle(b1, Date.parse(at(0)) + 3600_000)).toMatch(/^12 Oct, \d\d:\d\d · draft v4$/);
  });

  it('says how many samples, who started it and which models ran', () => {
    const choices = [{ id: 'fast', label: 'Fast model' }] as ModelChoice[];
    expect(batchSubtitle(batch([testRunView(), testRunView()]), choices)).toBe(
      "2 dev samples · started by ken · template's models",
    );
    expect(
      batchSubtitle(batch([testRunView()], { createdBy: null, modelOverride: 'fast' }), choices),
    ).toBe('1 dev sample · Fast model');
    expect(batchSubtitle(batch([testRunView()], { modelOverride: 'gone' }), choices)).toBe(
      '1 dev sample · started by ken · gone',
    );
  });

  it('summarises hidden batches by version', () => {
    expect(olderText([batch([]), batch([], { specVersion: 3 }), batch([])])).toBe(
      'Older batches: 3 more on v3 and v4',
    );
    expect(olderText([batch([], { specVersion: 2 })])).toBe('Older batches: 1 more on v2');
  });
});

describe('run rows', () => {
  it.each([
    [{ step: 'totals', index: 3, of: 3, attempt: 2, chunk: null }, 'Step 3 of 3 · totals · attempt 2'],
    [{ step: 'line_items', index: 2, of: 3, attempt: 1, chunk: { n: 2, of: 2 } }, 'Step 2 of 3 · line_items · chunk 2 of 2'],
  ])('progress %#', (p, text) => expect(progressText(p)).toBe(text));

  it.each<[Partial<TestRun>, string, string]>([
    [{ status: 'queued' }, 'Waiting for a worker', 'muted'],
    [{ status: 'queued', attempts: 1, error: 'timeout' }, 'Retrying after attempt 1: timeout', 'warn'],
    [{ status: 'running' }, 'Starting…', 'info'],
    [
      { status: 'running', progress: { step: 'totals', index: 3, of: 3, attempt: 1, chunk: null } },
      'Step 3 of 3 · totals',
      'info',
    ],
    [{ status: 'awaiting_review', reviewReasons: ['Check flagged a', 'b'] }, 'Check flagged a; b', 'warn'],
    [{ status: 'awaiting_review', reviewReasons: null }, 'Waiting for your review', 'warn'],
    [{ status: 'failed', error: 'invalid JSON', attempts: 3 }, 'invalid JSON (after 3 attempts)', 'danger'],
    [{ status: 'failed', error: null, attempts: 1 }, 'Failed', 'danger'],
    [{ status: 'needs_review', error: 'refused' }, 'refused', 'warn'],
    [{ status: 'succeeded', attempts: 1, reviewedAt: null }, 'Finished · nothing to review', 'muted'],
    [{ status: 'succeeded', attempts: 2, reviewedAt: at(9), reviewer: 'ken' }, 'Approved by ken · took 2 attempts', 'muted'],
    [{ status: 'rejected', reviewNote: 'wrong' }, 'Rejected: wrong', 'muted'],
    [{ status: 'cancelled' }, 'Cancelled', 'muted'],
  ])('detail %j', (fields, text, tone) => {
    expect(runDetail(testRunView(fields))).toEqual({ text, tone });
  });

  it.each([
    [0, '0:00'],
    [31.4, '0:31'],
    [125, '2:05'],
    [3725, '1:02:05'],
    [-3, '0:00'],
  ])('formats %s s as %s', (s, text) => expect(formatDuration(s)).toBe(text));

  it('times finished runs from start to finish and running ones up to now', () => {
    const now = Date.parse(at(50));
    expect(runDuration(testRunView({ status: 'succeeded', startedAt: at(0), finishedAt: at(31) }), now)).toBe('0:31');
    expect(runDuration(testRunView({ status: 'running', startedAt: at(6) }), now)).toBe('0:44');
    expect(runDuration(testRunView({ status: 'queued', startedAt: at(0), finishedAt: at(9) }), now)).toBe('—');
    expect(runDuration(testRunView({ status: 'succeeded', startedAt: null }), now)).toBe('—');
  });

  it.each([
    ['awaiting_review', 'review-now'],
    ['succeeded', 'review'],
    ['failed', 'retry'],
    ['needs_review', 'retry'],
    ['cancelled', 'retry'],
    ['queued', null],
    ['running', null],
    ['rejected', null],
  ] as const)('%s → %s', (status, action) => {
    expect(runAction(testRunView({ status }))).toBe(action);
  });
});

describe('samples and the run button', () => {
  it('offers dev samples only; preparing and failed ones are not selectable, with a reason', () => {
    const choices = runSamples([
      sampleView({ filename: 'a.pdf' }),
      sampleView({ filename: 'h.pdf', role: 'holdout' }),
      sampleView({ filename: 'p.pdf', state: 'preparing' }),
      sampleView({
        filename: 'f.pdf',
        state: 'failed',
        prepareError: { code: 'password', message: 'PDF is password-protected' },
      }),
    ]);
    expect(choices.map((c) => [c.sample.filename, c.selectable, c.reason])).toEqual([
      ['a.pdf', true, null],
      ['p.pdf', false, 'Still preparing'],
      ['f.pdf', false, 'Preparation failed: PDF is password-protected'],
    ]);
  });

  it('labels and blocks the run button', () => {
    expect(runLabel(6)).toBe('Run on 6 dev samples');
    expect(runLabel(1)).toBe('Run on 1 dev sample');
    expect(runBlockedReason(null, 3)).toBe(
      'Every version is published: start the next version on the Template tab first',
    );
    expect(runBlockedReason(4, 0)).toBe('Select at least one prepared dev sample');
    expect(runBlockedReason(4, 2)).toBeNull();
  });

  it.each([
    [null, null],
    [{ ahead: 0, running: 0, etaSeconds: 0 }, 'Queue: empty, runs start right away'],
    [{ ahead: 3, running: 1, etaSeconds: null }, 'Queue: 3 jobs ahead'],
    [{ ahead: 1, running: 1, etaSeconds: 40 }, 'Queue: 1 job ahead · under a minute'],
    [{ ahead: 3, running: 1, etaSeconds: 120 }, 'Queue: 3 jobs ahead · about 2 min'],
    [{ ahead: 90, running: 1, etaSeconds: 7200 }, 'Queue: 90 jobs ahead · about 2 h'],
  ])('queue %j', (q, text) => expect(queueText(q)).toBe(text));
});
```

(Run `npx prettier --write apps/web/test/runs-derive.test.ts` after pasting.)

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run --project web apps/web/test/runs-derive.test.ts apps/web/test/client.test.ts`
Expected: FAIL (`runs.js` not found; `testRunView` not exported; `getQueueSummary` is not a function).

- [ ] **Step 3: Implement**

`apps/web/src/api/client.ts`: add `QueueSummary` and `TestRun` to the `@ih/shared` type import; in the `Api` interface replace the two `runDevTests`/`listTestRuns` lines (and their comments) with:

```ts
  /**
   * Test-run the open draft on the ready dev samples (handoff TR1): `sampleIds` picks some (all
   * when absent); `model` is a model choice's id for every step (null or absent: the template's).
   */
  runDevTests(
    projectId: string,
    opts?: { model?: string | null; sampleIds?: string[] },
  ): Promise<{ jobs: JobSummary[] }>;
  /** The project's jobs except preparation, with batches and live step progress (TR2, TR3). */
  listTestRuns(projectId: string): Promise<TestRun[]>;
  /** The queue a new run waits behind, with a rough wait (TR4). */
  getQueueSummary(): Promise<QueueSummary>;
```

and in `createHttpApi` replace `runDevTests`/`listTestRuns` with:

```ts
    runDevTests: (id, opts) =>
      post<{ jobs: JobSummary[] }>(`${base}/workbench/projects/${id}/test-runs`, {
        ...(opts?.model ? { model: opts.model } : {}),
        ...(opts?.sampleIds ? { sampleIds: opts.sampleIds } : {}),
      }),
    listTestRuns: (id) =>
      apiFetch(`${base}/workbench/projects/${id}/test-runs`).then(json<TestRun[]>),
    getQueueSummary: () => apiFetch(`${base}/queue/summary`).then(json<QueueSummary>),
```

`apps/web/test/fake-api.ts`: add `TestRun` to its `@ih/shared` type import; in `fakeApi`'s defaults, next to `listTestRuns`, add `getQueueSummary: vi.fn(async () => ({ ahead: 0, running: 0, etaSeconds: 0 })),`; and after `job()` add:

```ts
/** A dev test run of `letter` as the Test runs tab lists it (no batch, no progress). */
export function testRunView(overrides: Partial<TestRun> = {}): TestRun {
  return {
    ...job({ test: true, projectId: 'letter', specId: 'letter', filename: 's1.pdf' }),
    progress: null,
    ...overrides,
  };
}
```

Create `apps/web/src/workbench/runs.ts`:

```ts
import type {
  JobStatus,
  ModelChoice,
  QueueSummary,
  SampleView,
  StepProgress,
  TestRun,
} from '@ih/shared';
import { statusLabel, statusTone, type Tone } from '../jobs/derive.js';
import { shortDateTime } from './references.js';

/** Test runs started together (one `POST …/test-runs`, handoff TR2). */
export interface RunBatch {
  id: string;
  /** The earliest run's creation time. */
  createdAt: string;
  specVersion: number;
  createdBy: string | null;
  /** The model the batch was started with (a retry may change one run's). */
  modelOverride: string | null;
  /** By file name. */
  runs: TestRun[];
  active: boolean;
}

const ACTIVE: ReadonlySet<JobStatus> = new Set(['queued', 'running']);
export const isActiveRun = (run: TestRun) => ACTIVE.has(run.status);

/** Batches newest first; runs outside a batch (older runs, reference and evaluation jobs). */
export function runBatches(runs: readonly TestRun[]): { batches: RunBatch[]; others: TestRun[] } {
  const groups = new Map<string, TestRun[]>();
  const others: TestRun[] = [];
  for (const run of runs) {
    if (run.batchId === null) others.push(run);
    else groups.set(run.batchId, [...(groups.get(run.batchId) ?? []), run]);
  }
  const batches = [...groups].map(([id, members]): RunBatch => {
    const first = members.reduce((a, b) => (b.createdAt < a.createdAt ? b : a));
    return {
      id,
      createdAt: first.createdAt,
      specVersion: first.specVersion,
      createdBy: first.createdBy,
      modelOverride: first.modelOverride,
      runs: [...members].sort(
        (a, b) => a.filename.localeCompare(b.filename) || a.id.localeCompare(b.id),
      ),
      active: members.some(isActiveRun),
    };
  });
  batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return { batches, others };
}

/** The newest two batches and any still running are shown; older ones wait behind *Show*. */
export function splitBatches(batches: readonly RunBatch[]): {
  shown: RunBatch[];
  hidden: RunBatch[];
} {
  const shown = batches.filter((b, i) => i < 2 || b.active);
  return { shown, hidden: batches.filter((b) => !shown.includes(b)) };
}

const ORDER: readonly JobStatus[] = [
  'succeeded',
  'awaiting_review',
  'running',
  'queued',
  'needs_review',
  'failed',
  'rejected',
  'cancelled',
];

export interface Segment {
  status: JobStatus;
  count: number;
  label: string;
  tone: Tone;
}

/** The batch's stacked status bar, in a fixed order. */
export function batchSegments(batch: RunBatch): Segment[] {
  return ORDER.map((status) => ({
    status,
    count: batch.runs.filter((r) => r.status === status).length,
    label: statusLabel(status).toLowerCase(),
    tone: statusTone(status),
  })).filter((s) => s.count > 0);
}

export const segmentsText = (segments: readonly Segment[]) =>
  segments.map((s) => `${s.count} ${s.label}`).join(' · ');

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** "12 Oct, 10:14 · draft v4", or "Just now · draft v4" within a minute. */
export function batchTitle(batch: RunBatch, now: number): string {
  const when =
    now - Date.parse(batch.createdAt) < 60_000 ? 'Just now' : shortDateTime(batch.createdAt);
  return `${when} · draft v${batch.specVersion}`;
}

/** "6 dev samples · started by ken · template's models". */
export function batchSubtitle(batch: RunBatch, choices: readonly ModelChoice[]): string {
  const model =
    batch.modelOverride === null
      ? "template's models"
      : (choices.find((c) => c.id === batch.modelOverride)?.label ?? batch.modelOverride);
  return [
    plural(batch.runs.length, 'dev sample'),
    ...(batch.createdBy ? [`started by ${batch.createdBy}`] : []),
    model,
  ].join(' · ');
}

/** "Older batches: 4 more on v3 and v4". */
export function olderText(hidden: readonly RunBatch[]): string {
  const versions = [...new Set(hidden.map((b) => b.specVersion))]
    .sort((a, b) => a - b)
    .map((v) => `v${v}`);
  const list =
    versions.length <= 2
      ? versions.join(' and ')
      : `${versions.slice(0, -1).join(', ')} and ${versions.at(-1)}`;
  return `Older batches: ${hidden.length} more on ${list}`;
}

/** "Step 2 of 3 · line_items · chunk 2 of 2 · attempt 2". */
export function progressText(p: StepProgress): string {
  return [
    `Step ${p.index} of ${p.of}`,
    p.step,
    ...(p.chunk ? [`chunk ${p.chunk.n} of ${p.chunk.of}`] : []),
    ...(p.attempt > 1 ? [`attempt ${p.attempt}`] : []),
  ].join(' · ');
}

export type DetailTone = 'muted' | 'warn' | 'danger' | 'info';

/** The row's detail line: progress, what review flagged, or the error in the job's words. */
export function runDetail(run: TestRun): { text: string; tone: DetailTone } {
  switch (run.status) {
    case 'queued':
      return run.attempts > 0 && run.error
        ? { text: `Retrying after attempt ${run.attempts}: ${run.error}`, tone: 'warn' }
        : { text: 'Waiting for a worker', tone: 'muted' };
    case 'running':
      return { text: run.progress ? progressText(run.progress) : 'Starting…', tone: 'info' };
    case 'awaiting_review':
      return {
        text: run.reviewReasons?.length ? run.reviewReasons.join('; ') : 'Waiting for your review',
        tone: 'warn',
      };
    case 'needs_review':
      return { text: run.error ?? 'Needs an operator', tone: 'warn' };
    case 'failed':
      return {
        text: `${run.error ?? 'Failed'}${run.attempts > 1 ? ` (after ${run.attempts} attempts)` : ''}`,
        tone: 'danger',
      };
    case 'succeeded': {
      const head = run.reviewedAt
        ? `Approved by ${run.reviewer ?? 'a reviewer'}`
        : 'Finished · nothing to review';
      return {
        text: run.attempts > 1 ? `${head} · took ${run.attempts} attempts` : head,
        tone: 'muted',
      };
    }
    case 'rejected':
      return { text: run.reviewNote ? `Rejected: ${run.reviewNote}` : 'Rejected', tone: 'muted' };
    case 'cancelled':
      return { text: 'Cancelled', tone: 'muted' };
  }
}

/** "0:31", "2:05", "1:02:05". */
export function formatDuration(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

/** The latest attempt's run time; up to now while running; "—" when not timed. */
export function runDuration(run: TestRun, now: number): string {
  if (!run.startedAt || run.status === 'queued') return '—';
  const start = Date.parse(run.startedAt);
  if (run.status === 'running') return formatDuration((now - start) / 1000);
  return run.finishedAt ? formatDuration((Date.parse(run.finishedAt) - start) / 1000) : '—';
}

export type RunAction = 'review-now' | 'review' | 'retry' | null;

const ACTIONS: Record<JobStatus, RunAction> = {
  awaiting_review: 'review-now',
  succeeded: 'review',
  failed: 'retry',
  needs_review: 'retry',
  cancelled: 'retry',
  queued: null,
  running: null,
  rejected: null,
};
export const runAction = (run: TestRun): RunAction => ACTIONS[run.status];

export interface SampleChoice {
  sample: SampleView;
  selectable: boolean;
  /** Why it cannot be picked (the tick box's title). */
  reason: string | null;
}

/** The dev samples a batch can run on (holdout is never offered). */
export function runSamples(samples: readonly SampleView[]): SampleChoice[] {
  return samples
    .filter((s) => s.role === 'dev')
    .map((sample) => ({
      sample,
      selectable: sample.state === 'ready',
      reason:
        sample.state === 'ready'
          ? null
          : sample.state === 'preparing'
            ? 'Still preparing'
            : `Preparation failed: ${sample.prepareError?.message ?? sample.error ?? 'unknown error'}`,
    }));
}

export const runLabel = (n: number) => `Run on ${plural(n, 'dev sample')}`;

/** Why *Run on n dev samples* is disabled; null when it can run. */
export function runBlockedReason(draft: number | null, selected: number): string | null {
  if (draft === null) {
    return 'Every version is published: start the next version on the Template tab first';
  }
  if (selected === 0) return 'Select at least one prepared dev sample';
  return null;
}

const etaText = (s: number) =>
  s < 60 ? 'under a minute' : s < 5400 ? `about ${Math.round(s / 60)} min` : `about ${Math.round(s / 3600)} h`;

/** "Queue: 3 jobs ahead · about 2 min"; null when the queue could not be read. */
export function queueText(q: QueueSummary | null): string | null {
  if (q === null) return null;
  if (q.ahead === 0) return 'Queue: empty, runs start right away';
  const head = `Queue: ${plural(q.ahead, 'job')} ahead`;
  return q.etaSeconds === null ? head : `${head} · ${etaText(q.etaSeconds)}`;
}
```

(`etaText` carries its own "about": "under a minute" reads without it.)

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run --project web apps/web/test/runs-derive.test.ts apps/web/test/client.test.ts` → PASS.
Run: `npm run typecheck` → FAIL only in `RunsTab.tsx` (`runDevTests(projectId, model)` now takes options) — fix that one call now as `api.runDevTests(projectId, { model })` so the tree typechecks; Task 9 rewrites the file.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/test/fake-api.ts apps/web/test/client.test.ts apps/web/src/workbench/runs.ts apps/web/test/runs-derive.test.ts apps/web/src/workbench/RunsTab.tsx
git commit -m "Workbench web: test run client options, queue summary, pure batch helpers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Batch card — `RunBatchCard`

**Files:**
- Create: `apps/web/src/workbench/RunBatchCard.tsx`, `apps/web/test/RunBatchCard.test.tsx`

**Interfaces:**
- Consumes: Task 7 helpers; `StatusPill` (`apps/web/src/ui/StatusPill.tsx`).
- Produces: `RunBatchCard({ batch, title, subtitle, now, onRetry }: { batch: RunBatch; title: string; subtitle: string; now: number; onRetry: (run: TestRun) => void })` — a `<section aria-label={title}>` card (class `runs-batch`, plus `is-live` while active) with the stacked bar (`role="img"`), a table `aria-label={`Runs of ${title}`}` inside `.table-scroll`, one row per run (file, status pill, detail, step bar on running rows, duration, action). Also exports `RunRows({ runs, now, onRetry })` (the `<tbody>` rows) for the Other runs table.

- [ ] **Step 1: Write the failing tests** — create `apps/web/test/RunBatchCard.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RunBatchCard } from '../src/workbench/RunBatchCard.js';
import type { RunBatch } from '../src/workbench/runs.js';
import { testRunView } from './fake-api.js';

const at = (s: number) => new Date(Date.UTC(2026, 9, 12, 10, 0, s)).toISOString();

function batch(active = true): RunBatch {
  return {
    id: 'b1',
    createdAt: at(0),
    specVersion: 4,
    createdBy: 'ken',
    modelOverride: null,
    active,
    runs: [
      testRunView({ id: '11111111-0000-4000-8000-000000000001', filename: 'acme.pdf', status: 'succeeded', startedAt: at(0), finishedAt: at(31) }),
      testRunView({ id: '11111111-0000-4000-8000-000000000002', filename: 'globex.pdf', status: 'awaiting_review', reviewReasons: ['Check flagged supplier_name'] }),
      testRunView({
        id: '11111111-0000-4000-8000-000000000003',
        filename: 'hooli.pdf',
        status: 'running',
        startedAt: at(0),
        progress: { step: 'line_items', index: 2, of: 3, attempt: 1, chunk: { n: 2, of: 2 } },
      }),
      testRunView({ id: '11111111-0000-4000-8000-000000000004', filename: 'stark.pdf', status: 'failed', error: 'invalid JSON', attempts: 3 }),
    ],
  };
}

const renderCard = (b = batch(), onRetry = vi.fn()) =>
  render(
    <RunBatchCard
      batch={b}
      title="12 Oct, 10:14 · draft v4"
      subtitle="4 dev samples · started by ken · template's models"
      now={Date.parse(at(72))}
      onRetry={onRetry}
    />,
  );
const row = (file: string) =>
  screen.getByRole('cell', { name: file }).closest('tr') as HTMLTableRowElement;

describe('RunBatchCard', () => {
  it('heads the batch with its title, subtitle and a stacked status bar with a text alternative', () => {
    renderCard();
    const card = screen.getByRole('region', { name: '12 Oct, 10:14 · draft v4' });
    expect(card).toHaveClass('runs-batch', 'is-live');
    expect(card).toHaveTextContent("4 dev samples · started by ken · template's models");
    const text = '1 succeeded · 1 awaiting review · 1 running · 1 failed';
    expect(within(card).getByRole('img', { name: `Batch status: ${text}` })).toBeInTheDocument();
    expect(within(card).getByText(text)).toBeInTheDocument();
  });

  it('is not live once nothing runs', () => {
    renderCard(batch(false));
    expect(screen.getByRole('region', { name: /draft v4/ })).not.toHaveClass('is-live');
  });

  it('shows each run with its status, detail, duration and action', () => {
    renderCard();
    expect(screen.getByRole('table', { name: 'Runs of 12 Oct, 10:14 · draft v4' })).toBeInTheDocument();
    const done = row('acme.pdf');
    expect(within(done).getByText('Succeeded')).toBeInTheDocument();
    expect(within(done).getByText('0:31')).toBeInTheDocument();
    expect(within(done).getByRole('link', { name: 'Review' })).toHaveAttribute(
      'href',
      '#/review/11111111-0000-4000-8000-000000000001',
    );
    const waiting = row('globex.pdf');
    expect(within(waiting).getByText('Check flagged supplier_name')).toBeInTheDocument();
    expect(within(waiting).getByRole('link', { name: 'Review now' })).toHaveAttribute(
      'href',
      '#/review/11111111-0000-4000-8000-000000000002',
    );
    const running = row('hooli.pdf');
    expect(within(running).getByText('1:12')).toBeInTheDocument();
    expect(within(running).queryByRole('link')).toBeNull();
    expect(within(row('stark.pdf')).getByText('invalid JSON (after 3 attempts)')).toBeInTheDocument();
  });

  it('draws a running row\'s step progress as an image with the same words', () => {
    renderCard();
    const running = row('hooli.pdf');
    const label = 'Step 2 of 3 · line_items · chunk 2 of 2';
    expect(within(running).getByRole('img', { name: label })).toBeInTheDocument();
    expect(within(running).getByText(label)).toBeInTheDocument();
  });

  it('offers Retry on a failed run', async () => {
    const onRetry = vi.fn();
    renderCard(batch(), onRetry);
    await userEvent.click(within(row('stark.pdf')).getByRole('button', { name: 'Retry stark.pdf' }));
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ filename: 'stark.pdf' }));
  });
});
```

(Run `npx prettier --write apps/web/test/RunBatchCard.test.tsx`.)

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/RunBatchCard.test.tsx` → FAIL (module not found).

- [ ] **Step 3: Implement** — create `apps/web/src/workbench/RunBatchCard.tsx`:

```tsx
import type { StepProgress, TestRun } from '@ih/shared';
import { StatusPill } from '../ui/StatusPill.js';
import {
  batchSegments,
  progressText,
  runAction,
  runDetail,
  runDuration,
  segmentsText,
  type RunBatch,
} from './runs.js';

/** A running step as segments, one per extract step (done, current, to do). */
function StepBar({ progress }: { progress: StepProgress }) {
  return (
    <span className="runs-stepbar" role="img" aria-label={progressText(progress)}>
      {Array.from({ length: progress.of }, (_, i) => (
        <span
          key={i}
          className={
            i + 1 < progress.index ? 'is-done' : i + 1 === progress.index ? 'is-current' : ''
          }
        />
      ))}
    </span>
  );
}

/** One run per row: file, status, detail (with step progress), duration, Review or Retry. */
export function RunRows({
  runs,
  now,
  onRetry,
}: {
  runs: readonly TestRun[];
  now: number;
  onRetry: (run: TestRun) => void;
}) {
  return (
    <>
      {runs.map((run) => {
        const detail = runDetail(run);
        const action = runAction(run);
        return (
          <tr key={run.id}>
            <td>
              <code className="runs-file">{run.filename}</code>
            </td>
            <td>
              <StatusPill status={run.status} />
            </td>
            <td>
              <span className={`runs-detail tone-text-${detail.tone}`}>{detail.text}</span>
              {run.status === 'running' && run.progress && <StepBar progress={run.progress} />}
            </td>
            <td className="runs-duration">{runDuration(run, now)}</td>
            <td className="runs-action">
              {action === 'review-now' && (
                <a className="runs-review-now" href={`#/review/${run.id}`}>
                  Review now
                </a>
              )}
              {action === 'review' && <a href={`#/review/${run.id}`}>Review</a>}
              {action === 'retry' && (
                <button
                  type="button"
                  aria-label={`Retry ${run.filename}`}
                  onClick={() => onRetry(run)}
                >
                  Retry
                </button>
              )}
            </td>
          </tr>
        );
      })}
    </>
  );
}

/** Column heads shared by the batch tables. */
export function RunHead() {
  return (
    <thead>
      <tr>
        <th scope="col">File</th>
        <th scope="col">Status</th>
        <th scope="col">Detail</th>
        <th scope="col" className="runs-duration">
          Duration
        </th>
        <th scope="col">
          <span className="visually-hidden">Action</span>
        </th>
      </tr>
    </thead>
  );
}

/** One batch of test runs (handoff §11): header with a stacked status bar, then its rows. */
export function RunBatchCard({
  batch,
  title,
  subtitle,
  now,
  onRetry,
}: {
  batch: RunBatch;
  title: string;
  subtitle: string;
  now: number;
  onRetry: (run: TestRun) => void;
}) {
  const segments = batchSegments(batch);
  const summary = segmentsText(segments);
  return (
    <section className={`card runs-batch${batch.active ? ' is-live' : ''}`} aria-label={title}>
      <header className="runs-batch-head">
        <div className="runs-batch-title">
          <h3>{title}</h3>
          <p className="muted">{subtitle}</p>
        </div>
        <div className="runs-batch-status">
          <span className="runs-stack" role="img" aria-label={`Batch status: ${summary}`}>
            {segments.map((s) => (
              <span
                key={s.status}
                className="runs-stack-seg"
                style={{ flexGrow: s.count, background: `var(--ih-${s.tone}-fg)` }}
              />
            ))}
          </span>
          <span className="runs-stack-legend muted">{summary}</span>
        </div>
      </header>
      <div className="table-scroll">
        <table className="runs-table" aria-label={`Runs of ${title}`}>
          <RunHead />
          <tbody>
            <RunRows runs={batch.runs} now={now} onRetry={onRetry} />
          </tbody>
        </table>
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Run** `npx vitest run --project web apps/web/test/RunBatchCard.test.tsx` → PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/RunBatchCard.tsx apps/web/test/RunBatchCard.test.tsx
git commit -m "Workbench web: test run batch card with status bar, step progress, review and retry

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Test runs tab — header, sample chips, queue line, batches, polling; ProjectPage; CSS

**Files:**
- Create: `apps/web/src/workbench/RunSamples.tsx`
- Modify: `apps/web/src/workbench/RunsTab.tsx` (rewrite), `apps/web/test/RunsTab.test.tsx` (rewrite), `apps/web/src/workbench/ProjectPage.tsx`, `apps/web/src/styles/stages.css`

**Interfaces:**
- Consumes: Tasks 7–8; `TabHeader` (`apps/web/src/workbench/TabHeader.tsx`), `ReprocessDialog`, `useModelChoices`.
- Produces: `RunSamples({ choices, selected, onToggle, queue }: { choices: SampleChoice[]; selected: ReadonlySet<string>; onToggle: (id: string) => void; queue: string | null })`; `RunsTab({ api, projectId, dataPolicy, draft, item, pollMs, onChanged }: { …; item: OverviewItem | null; onChanged: () => void })` — renders its own `TabHeader` (title "Test runs") with the primary in `actions`.

- [ ] **Step 1: Write the failing tests** — replace `apps/web/test/RunsTab.test.tsx` with:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { OverviewItem, TestRun } from '@ih/shared';
import { ApiError } from '../src/api/client.js';
import { RunsTab } from '../src/workbench/RunsTab.js';
import { fakeApi, sampleView, testRunView } from './fake-api.js';

const item: OverviewItem = {
  stage: 'runs',
  state: 'running',
  status: '2 test runs in progress · 1 awaiting review',
  metrics: [],
};
const ready = (n: number) =>
  sampleView({ id: `00000000-0000-4000-8000-00000000000${n}`, filename: `s${n}.pdf` });
const at = (s: number) => new Date(Date.UTC(2026, 9, 12, 10, 0, s)).toISOString();

function tab(api = fakeApi(), props: Partial<Parameters<typeof RunsTab>[0]> = {}) {
  const onChanged = vi.fn();
  render(
    <RunsTab
      api={api}
      projectId="letter"
      dataPolicy="local"
      draft={4}
      item={item}
      pollMs={60_000}
      onChanged={onChanged}
      {...props}
    />,
  );
  return { api, onChanged };
}
const runButton = () => screen.findByRole('button', { name: /^Run on \d+ dev samples?$/ });

describe('RunsTab', () => {
  it('heads the tab with the status line and what test runs are', async () => {
    tab();
    expect(await screen.findByRole('heading', { level: 2, name: 'Test runs' })).toBeInTheDocument();
    expect(screen.getByText('2 test runs in progress · 1 awaiting review')).toBeInTheDocument();
    expect(screen.getByText(/Runs draft v4 on prepared dev samples/)).toHaveTextContent(
      "Test runs aren't scored (Evaluate compares with references), holdout samples are never used",
    );
  });

  it('ticks every ready dev sample; preparing and failed ones cannot be picked, with a reason', async () => {
    tab(
      fakeApi({
        listSamples: vi.fn(async () => [
          ready(1),
          ready(2),
          sampleView({ filename: 'h.pdf', role: 'holdout' }),
          sampleView({ filename: 'p.pdf', state: 'preparing' }),
          sampleView({
            filename: 'f.pdf',
            state: 'failed',
            prepareError: { code: 'corrupt', message: 'PDF could not be read' },
          }),
        ]),
      }),
    );
    expect(await screen.findByRole('checkbox', { name: 's1.pdf' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 's2.pdf' })).toBeChecked();
    expect(screen.queryByRole('checkbox', { name: 'h.pdf' })).toBeNull();
    const preparing = screen.getByRole('checkbox', { name: 'p.pdf' });
    expect(preparing).toBeDisabled();
    expect(preparing).not.toBeChecked();
    expect(preparing).toHaveAttribute('title', 'Still preparing');
    expect(screen.getByRole('checkbox', { name: 'f.pdf' })).toHaveAttribute(
      'title',
      'Preparation failed: PDF could not be read',
    );
    expect(await runButton()).toHaveTextContent('Run on 2 dev samples');
  });

  it('the selection count drives the button label; none selected disables it with a reason', async () => {
    tab(fakeApi({ listSamples: vi.fn(async () => [ready(1), ready(2)]) }));
    await userEvent.click(await screen.findByRole('checkbox', { name: 's1.pdf' }));
    expect(await runButton()).toHaveTextContent('Run on 1 dev sample');
    await userEvent.click(screen.getByRole('checkbox', { name: 's2.pdf' }));
    const button = await runButton();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', 'Select at least one prepared dev sample');
  });

  it('cannot run without an open draft, and says why', async () => {
    tab(fakeApi({ listSamples: vi.fn(async () => [ready(1)]) }), { draft: null });
    const button = await runButton();
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      'title',
      'Every version is published: start the next version on the Template tab first',
    );
  });

  it('runs the selected samples with the picked model choice, then reloads', async () => {
    const queued = testRunView({ batchId: 'b1', filename: 's2.pdf', status: 'queued', createdAt: at(0) });
    const listTestRuns = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([queued]);
    const api = fakeApi({
      listSamples: vi.fn(async () => [ready(1), ready(2)]),
      listTestRuns,
      runDevTests: vi.fn(async () => ({ jobs: [queued] })),
    });
    const { onChanged } = tab(api);
    await userEvent.click(await screen.findByRole('checkbox', { name: 's1.pdf' }));
    await userEvent.click(await runButton());
    const dialog = screen.getByRole('dialog', { name: 'Run v4 on 1 dev sample' });
    const model = within(dialog).getByRole('combobox', { name: 'Model' });
    expect(model).toHaveValue('');
    // A local-only project cannot pick an external model choice.
    expect(
      (within(model).getByRole('option', { name: /Cloud model/ }) as HTMLOptionElement).disabled,
    ).toBe(true);
    await userEvent.selectOptions(model, 'New for testing only');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Run' }));
    expect(api.runDevTests).toHaveBeenCalledWith('letter', {
      model: 'test',
      sampleIds: ['00000000-0000-4000-8000-000000000002'],
    });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('region', { name: /draft v4/ })).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();
  });

  it('keeps a refusal in the dialog', async () => {
    const api = fakeApi({
      listSamples: vi.fn(async () => [ready(1)]),
      runDevTests: vi.fn(async () => {
        throw new ApiError('s1.pdf is not prepared yet', 409);
      }),
    });
    tab(api);
    await userEvent.click(await runButton());
    await userEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('s1.pdf is not prepared yet');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('shows the queue line', async () => {
    tab(fakeApi({ getQueueSummary: vi.fn(async () => ({ ahead: 3, running: 1, etaSeconds: 120 })) }));
    expect(await screen.findByText('Queue: 3 jobs ahead · about 2 min')).toBeInTheDocument();
  });

  it('keeps the tab when the queue cannot be read', async () => {
    tab(
      fakeApi({
        listSamples: vi.fn(async () => [ready(1)]),
        getQueueSummary: vi.fn(async () => {
          throw new Error('down');
        }),
      }),
    );
    expect(await runButton()).toBeEnabled();
    expect(screen.queryByText(/^Queue:/)).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('lists batches newest first and keeps older ones behind Show', async () => {
    const runs: TestRun[] = [1, 2, 3].map((n) =>
      testRunView({ batchId: `b${n}`, filename: `s${n}.pdf`, status: 'succeeded', createdAt: at(n), specVersion: n + 1 }),
    );
    tab(fakeApi({ listTestRuns: vi.fn(async () => runs) }));
    const regions = await screen.findAllByRole('region', { name: /· draft v/ });
    expect(regions.map((r) => r.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/draft v4$/),
      expect.stringMatching(/draft v3$/),
    ]);
    expect(screen.getByText('Older batches: 1 more on v2')).toBeInTheDocument();
    const show = screen.getByRole('button', { name: 'Show' });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(show);
    expect(screen.getAllByRole('region', { name: /· draft v/ })).toHaveLength(3);
    expect(screen.getByRole('button', { name: 'Hide' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('keeps runs outside a batch in a collapsed Other runs list', async () => {
    tab(fakeApi({ listTestRuns: vi.fn(async () => [testRunView({ filename: 'ref.pdf', status: 'succeeded' })]) }));
    const show = await screen.findByRole('button', { name: 'Show other runs (1)' });
    expect(screen.queryByRole('cell', { name: 'ref.pdf' })).toBeNull();
    await userEvent.click(show);
    expect(screen.getByRole('cell', { name: 'ref.pdf' })).toBeInTheDocument();
  });

  it('retries a failed run through the re-process dialog', async () => {
    const failed = testRunView({ batchId: 'b1', filename: 's1.pdf', status: 'failed', modelOverride: null });
    const api = fakeApi({ listTestRuns: vi.fn(async () => [failed]) });
    tab(api);
    await userEvent.click(await screen.findByRole('button', { name: 'Retry s1.pdf' }));
    const dialog = screen.getByRole('dialog', { name: 'Retry s1.pdf' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retry' }));
    expect(api.retryJob).toHaveBeenCalledWith(failed.id, null);
  });

  it('polls only while a run is active', async () => {
    const running = testRunView({ batchId: 'b1', status: 'running' });
    const idle = vi.fn(async () => [testRunView({ batchId: 'b1', status: 'succeeded' })]);
    tab(fakeApi({ listTestRuns: idle }), { pollMs: 20 });
    await screen.findByRole('region', { name: /draft v/ });
    await new Promise((r) => setTimeout(r, 120));
    expect(idle).toHaveBeenCalledTimes(1);

    const busy = vi.fn(async () => [running]);
    tab(fakeApi({ listTestRuns: busy }), { pollMs: 20 });
    await waitFor(() => expect(busy.mock.calls.length).toBeGreaterThan(2));
  });

  it('tells the page when the last active run finishes', async () => {
    const running = testRunView({ batchId: 'b1', status: 'running' });
    const done = { ...running, status: 'succeeded' as const };
    const listTestRuns = vi.fn().mockResolvedValueOnce([running]).mockResolvedValue([done]);
    const { onChanged } = tab(fakeApi({ listTestRuns }), { pollMs: 20 });
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("drops a slower earlier response (another project's runs never replace these)", async () => {
    let slow!: (runs: TestRun[]) => void;
    const mine = testRunView({ batchId: 'b1', filename: 'mine.pdf', status: 'succeeded' });
    const listTestRuns = vi.fn((projectId: string) =>
      projectId === 'letter'
        ? new Promise<TestRun[]>((r) => (slow = r))
        : Promise.resolve([mine]),
    );
    const api = fakeApi({ listTestRuns });
    const props = {
      api,
      dataPolicy: 'local' as const,
      draft: 4,
      item,
      pollMs: 60_000,
      onChanged: vi.fn(),
    };
    const { rerender } = render(<RunsTab {...props} projectId="letter" />);
    rerender(<RunsTab {...props} projectId="other" />);
    expect(await screen.findByRole('cell', { name: 'mine.pdf' })).toBeInTheDocument();
    slow([testRunView({ batchId: 'b9', filename: 'stale.pdf', status: 'succeeded' })]);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByRole('cell', { name: 'mine.pdf' })).toBeInTheDocument();
    expect(screen.queryByRole('cell', { name: 'stale.pdf' })).toBeNull();
  });
});
```

(Run `npx prettier --write apps/web/test/RunsTab.test.tsx`. This file replaces the old one deliberately: "Run on dev samples…" became "Run on n dev samples" with a selection, `runDevTests` takes options, the flat table became batches; the old cases — dialog with the model picker and the local-only external choice, refusal kept in the dialog, no open draft — are all still covered above. The old "disables the dialog's Run button while in flight" case is the `ReprocessDialog`'s own behaviour, covered in `ReprocessDialog.test.tsx`.)

- [ ] **Step 2: Run** `npx vitest run --project web apps/web/test/RunsTab.test.tsx` → FAIL (no `item` header, no checkboxes, no batches).

- [ ] **Step 3: Implement**

Create `apps/web/src/workbench/RunSamples.tsx`:

```tsx
import type { SampleChoice } from './runs.js';

/** The Samples card (handoff §11): dev samples with tick boxes and the queue line. */
export function RunSamples({
  choices,
  selected,
  onToggle,
  queue,
}: {
  choices: readonly SampleChoice[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  queue: string | null;
}) {
  return (
    <section className="card runs-samples-card" aria-labelledby="runs-samples-title">
      <h3 id="runs-samples-title">Samples</h3>
      {choices.length === 0 ? (
        <p className="muted">No dev samples yet: add some on the Samples tab.</p>
      ) : (
        <ul className="runs-chips">
          {choices.map(({ sample, selectable, reason }) => {
            const on = selectable && selected.has(sample.id);
            return (
              <li key={sample.id}>
                <label
                  className={`run-chip${on ? ' is-on' : ''}${selectable ? '' : ' is-off'}`}
                  title={reason ?? undefined}
                >
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={!selectable}
                    title={reason ?? undefined}
                    onChange={() => onToggle(sample.id)}
                  />
                  <code>{sample.filename}</code>
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {queue && <p className="muted runs-queue">{queue}</p>}
    </section>
  );
}
```

Replace `apps/web/src/workbench/RunsTab.tsx` with:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DataPolicy, OverviewItem, QueueSummary, SampleView, TestRun } from '@ih/shared';
import type { Api } from '../api/client.js';
import { useModelChoices } from '../ui/ModelPicker.js';
import { ReprocessDialog } from '../ui/ReprocessDialog.js';
import { RunBatchCard, RunHead, RunRows } from './RunBatchCard.js';
import { RunSamples } from './RunSamples.js';
import {
  batchSubtitle,
  batchTitle,
  isActiveRun,
  olderText,
  queueText,
  runBatches,
  runBlockedReason,
  runLabel,
  runSamples,
  splitBatches,
} from './runs.js';
import { TabHeader } from './TabHeader.js';

interface Loaded {
  runs: TestRun[];
  samples: SampleView[];
  queue: QueueSummary | null;
}

/**
 * Test runs (handoff §11, TR1–TR4): pick dev samples, run the draft on them as one batch, follow
 * each batch's runs (status, step progress, duration) and open them in Review or retry them.
 * Polls while a run is queued or running, or a dev sample is still preparing.
 */
export function RunsTab({
  api,
  projectId,
  dataPolicy,
  draft,
  item,
  pollMs,
  onChanged,
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  draft: number | null;
  item: OverviewItem | null;
  pollMs: number;
  /** A run started or the last active one finished: the page reloads its overview. */
  onChanged: () => void;
}) {
  const [data, setData] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** null: untouched, so every ready dev sample is selected (newly ready ones join). */
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const [asking, setAsking] = useState(false);
  const [retrying, setRetrying] = useState<TestRun | null>(null);
  const [showOlder, setShowOlder] = useState(false);
  const [showOthers, setShowOthers] = useState(false);
  const choices = useModelChoices(api);
  const seq = useRef(0);
  const inFlight = useRef(false);
  const wasActive = useRef(false);

  const load = useCallback(async () => {
    const id = ++seq.current;
    inFlight.current = true;
    try {
      const [runs, samples, queue] = await Promise.all([
        api.listTestRuns(projectId),
        api.listSamples(projectId),
        api.getQueueSummary().catch(() => null), // the queue line is optional
      ]);
      if (id !== seq.current) return; // a newer load (or unmount) superseded this one
      setData({ runs, samples, queue });
      setNow(Date.now());
      setError(null);
    } catch (err) {
      if (id === seq.current) setError((err as Error).message);
    } finally {
      if (id === seq.current) inFlight.current = false;
    }
  }, [api, projectId]);

  useEffect(() => {
    void load();
    const counter = seq; // the counter object itself, not a rendered node
    return () => {
      counter.current++;
    };
  }, [load]);

  const runsActive = data?.runs.some(isActiveRun) ?? false;
  const preparing =
    data?.samples.some((s) => s.role === 'dev' && s.state === 'preparing') ?? false;
  useEffect(() => {
    if (!runsActive && !preparing) return;
    const timer = setInterval(() => {
      if (!inFlight.current) void load();
    }, pollMs);
    return () => clearInterval(timer);
  }, [runsActive, preparing, pollMs, load]);

  // The page learns when the last active run finishes (its rail shows the tab's status).
  useEffect(() => {
    if (wasActive.current && !runsActive) onChanged();
    wasActive.current = runsActive;
  }, [runsActive, onChanged]);

  const sampleChoices = useMemo(() => runSamples(data?.samples ?? []), [data]);
  const selectable = sampleChoices.filter((c) => c.selectable).map((c) => c.sample.id);
  const selected = new Set(picked === null ? selectable : selectable.filter((id) => picked.has(id)));
  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  };
  const blocked = runBlockedReason(draft, selected.size);
  const label = runLabel(selected.size);

  const { batches, others } = useMemo(() => runBatches(data?.runs ?? []), [data]);
  const { shown, hidden } = splitBatches(batches);
  const visible = showOlder ? batches : shown;

  return (
    <div className="runs-tab">
      <TabHeader
        title="Test runs"
        item={item}
        description={
          draft !== null
            ? `Runs draft v${draft} on prepared dev samples so you can look at the results in Review. Test runs aren't scored (Evaluate compares with references), holdout samples are never used, and runs queue behind production jobs.`
            : 'Every version is published; start the next version on the Template tab to test-run it.'
        }
        actions={
          <button
            type="button"
            className="primary"
            disabled={blocked !== null}
            title={blocked ?? undefined}
            onClick={() => setAsking(true)}
          >
            {label}
          </button>
        }
      />
      {error && <p role="alert">{error}</p>}
      {data && (
        <RunSamples
          choices={sampleChoices}
          selected={selected}
          onToggle={toggle}
          queue={queueText(data.queue)}
        />
      )}
      {visible.map((batch) => {
        const title = batchTitle(batch, now);
        return (
          <RunBatchCard
            key={batch.id}
            batch={batch}
            title={title}
            subtitle={batchSubtitle(batch, choices)}
            now={now}
            onRetry={setRetrying}
          />
        );
      })}
      {hidden.length > 0 && (
        <p className="muted runs-older">
          {showOlder ? 'Older batches shown' : olderText(hidden)} ·{' '}
          <button
            type="button"
            className="link"
            aria-expanded={showOlder}
            onClick={() => setShowOlder((v) => !v)}
          >
            {showOlder ? 'Hide' : 'Show'}
          </button>
        </p>
      )}
      {data && batches.length === 0 && others.length === 0 && (
        <p className="muted">No test runs yet.</p>
      )}
      {others.length > 0 && (
        <section className="card runs-others" aria-labelledby="runs-others-title">
          <h3 id="runs-others-title">Other runs</h3>
          <p className="muted">
            Reference runs, evaluation runs and runs from before batches.{' '}
            <button
              type="button"
              className="link"
              aria-expanded={showOthers}
              onClick={() => setShowOthers((v) => !v)}
            >
              {showOthers ? 'Hide other runs' : `Show other runs (${others.length})`}
            </button>
          </p>
          {showOthers && (
            <div className="table-scroll">
              <table className="runs-table" aria-label="Other runs">
                <RunHead />
                <tbody>
                  <RunRows runs={others} now={now} onRetry={setRetrying} />
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      {asking && draft !== null && (
        <ReprocessDialog
          title={`Run v${draft} on ${selected.size} dev sample${selected.size === 1 ? '' : 's'}`}
          confirmLabel="Run"
          choices={choices}
          emptyLabel="Template's models"
          dataPolicy={dataPolicy}
          summary={
            <p>
              Test-runs the draft on the selected dev samples (never holdout) as one batch.
              Unchanged steps reuse their cached output; nothing is delivered.
            </p>
          }
          onConfirm={async (model) => {
            await api.runDevTests(projectId, { model, sampleIds: [...selected] });
            onChanged();
            await load();
          }}
          onClose={() => setAsking(false)}
        />
      )}
      {retrying && (
        <ReprocessDialog
          title={`Retry ${retrying.filename}`}
          confirmLabel="Retry"
          choices={choices}
          initialModel={retrying.modelOverride ?? ''}
          emptyLabel="Template's models"
          dataPolicy={dataPolicy}
          summary={<p>Runs the draft on {retrying.filename} again, in the same batch.</p>}
          onConfirm={async (model) => {
            await api.retryJob(retrying.id, model);
            onChanged();
            await load();
          }}
          onClose={() => setRetrying(null)}
        />
      )}
    </div>
  );
}
```

Notes for the implementer:
- `[...selected]` keeps the chips' order (sample order from the API), which the test pins (`['…0002']` after unticking `s1.pdf`).
- `button.link` is the existing link-looking button style (`apps/web/src/styles.css`, used by the Jobs and Models pages); add no new one.
- The "drops a slower earlier response" test changes `projectId`: the effect's cleanup bumps the sequence, so the first project's late answer is ignored. Batch tables show only on the second project (its runs are `succeeded`, so the "mine.pdf" cell is in the newest batch's table).
- That test calls `render` directly (already imported) to use its `rerender`.

In `apps/web/src/workbench/ProjectPage.tsx`, replace

```tsx
          {tab === 'runs' && header('runs')}
          {tab === 'runs' && (
            <RunsTab
              api={api}
              projectId={project.id}
              dataPolicy={project.dataPolicy}
              draft={draft}
              pollMs={pollMs}
            />
          )}
```

with

```tsx
          {tab === 'runs' && (
            <RunsTab
              api={api}
              projectId={project.id}
              dataPolicy={project.dataPolicy}
              draft={draft}
              item={itemOf('runs')}
              pollMs={pollMs}
              onChanged={loadOverview}
            />
          )}
```

In `apps/web/src/styles/stages.css`:

1. Add `.runs-samples-card`, `.runs-batch-head` and `.runs-others` to the padding selector list (after `.revise-earlier`), and `.runs-samples-card h3`, `.runs-batch-head h3`, `.runs-others h3` to the `font-weight: 600` list (after `.revise-failures h3`).
2. Append at the end of the file:

```css
/* Test runs (handoff §11) */
.runs-tab {
  display: grid;
  grid-template-columns: minmax(0, 1fr);
  gap: 16px;
  min-width: 0;
}
.runs-samples-card {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  min-width: 0;
}
.runs-samples-card > * {
  min-width: 0;
}
.runs-samples-card h3 {
  margin: 0;
  font-size: var(--ih-text-md);
}
.runs-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.run-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 4px 10px;
  border: 1px solid var(--ih-border);
  border-radius: var(--ih-radius-pill);
  background: var(--ih-surface);
  cursor: pointer;
}
.run-chip.is-on {
  border-color: var(--ih-info-fg);
  background: var(--ih-info-bg);
}
.run-chip.is-off {
  opacity: 0.6;
  cursor: not-allowed;
}
.run-chip code {
  overflow-wrap: anywhere;
}
.runs-queue {
  margin: 0 0 0 auto;
}
.runs-batch.is-live {
  border-color: var(--ih-info-fg);
}
.runs-batch-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px 16px;
  min-width: 0;
}
.runs-batch-head > * {
  min-width: 0;
}
.runs-batch-head h3 {
  margin: 0;
  font-size: var(--ih-text-md);
}
.runs-batch-head p {
  margin: 2px 0 0;
}
.runs-batch-status {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
}
.runs-stack {
  display: flex;
  width: 220px;
  max-width: 100%;
  height: 8px;
  overflow: hidden;
  border-radius: 4px;
  background: var(--ih-neutral-bg);
}
.runs-stack-seg {
  display: block;
  height: 100%;
}
.runs-table {
  width: 100%;
  border-collapse: collapse;
}
.runs-table th,
.runs-table td {
  padding: 8px 16px;
  border-top: 1px solid var(--ih-border);
  text-align: left;
  vertical-align: top;
}
.runs-table th {
  font-size: var(--ih-text-xs);
  font-weight: 500;
  color: var(--ih-muted);
}
.runs-file {
  overflow-wrap: anywhere;
}
.runs-duration {
  text-align: right;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.runs-action {
  text-align: right;
  white-space: nowrap;
}
.runs-review-now {
  font-weight: 600;
}
.runs-stepbar {
  display: flex;
  gap: 4px;
  width: 186px;
  max-width: 100%;
  margin-top: 6px;
}
.runs-stepbar span {
  flex: 1;
  height: 4px;
  border-radius: 2px;
  background: var(--ih-neutral-bg);
}
.runs-stepbar .is-done {
  background: var(--ih-ok-fg);
}
.runs-stepbar .is-current {
  background: var(--ih-info-fg);
}
.runs-older {
  margin: 0;
}
@media (max-width: 760px) {
  .runs-queue {
    flex-basis: 100%;
    margin-left: 0;
  }
  .runs-stack {
    width: 100%;
  }
}
```

(Check `--ih-text-md`/`--ih-text-xs` exist in `tokens.css` — they do — and keep to existing tokens only.)

- [ ] **Step 4: Run them to see them pass**

Run: `npx vitest run --project web apps/web/test/RunsTab.test.tsx apps/web/test/RunBatchCard.test.tsx apps/web/test/ProjectPage.test.tsx` → PASS (ProjectPage's "opens the runs tab with the H2 Test runs and its status" still passes: the tab renders its own `TabHeader`).
Run: `npm run typecheck && npm run lint` → PASS.

- [ ] **Step 5: Look at it** (optional but recommended): `deploy/scripts/dev-infra.ps1 up`, `npm run dev:api`, `npm run dev:web`, open `#/workbench/<id>/runs` at 1440 px and at 375 px (Browser pane `resize_window` preset `mobile`), check the batch card's border, no horizontal page scroll, the bar and chips wrapping. Reset the viewport (`preset: "desktop"`) afterwards.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/workbench/RunSamples.tsx apps/web/src/workbench/RunsTab.tsx apps/web/test/RunsTab.test.tsx apps/web/src/workbench/ProjectPage.tsx apps/web/src/styles/stages.css
git commit -m "Workbench web: Test runs tab with sample selection, queue line and batches (handoff 11)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs and the full check

**Files:**
- Modify: `CLAUDE.md` (and `docs/openapi.json` if regenerating changes it)

- [ ] **Step 1: Docs** — in `CLAUDE.md`:

1. Contract table, row "Job statuses and tasks": append to the TS cell "; `JobSummary.batchId` (from `params.batchId`, set by `POST …/test-runs`; TS only, the worker ignores it), `startedAt`/`finishedAt` (`jobs.started_at`/`finished_at`, migration 0028, set by the `jobs_timing` trigger on `process` runs; TS only)" and to the Python cell "; the worker neither reads nor writes `started_at`/`finished_at` (a trigger sets them on its claim and finish)".
2. Contract table: add a row after "Workbench prepared text and segmentation":
   `| Test run step progress (Test runs, TR3) | `STEP_PROGRESS_EVENT`, `StepProgressSchema`, `TestRunSchema` in `packages/shared/src/jobs.ts`; `stepProgress` in `apps/api/src/workbench/test-runs.ts` (latest event at or after `startedAt`) | `template_pipeline.STEP_PROGRESS`, `step_reporter` (Workbench jobs only, advisory), `run_step_extraction(progress=)`, `run_extraction(on_attempt=)`; shared fixture `packages/shared/test/fixtures/step-progress.json` |`
3. In the **Workbench** bullet, replace "dev test runs are ordinary test jobs." with "dev test runs are ordinary test jobs: `POST …/test-runs` takes optional `sampleIds` (ready dev samples only: an unknown id or a holdout sample is a 400, one not prepared a 409, checked before anything is queued) and stamps every job of the call with one `params.batchId`; `GET …/test-runs` returns `TestRun`s (the job summary plus a running job's `progress` from its latest `step progress` event of this attempt). `GET /api/queue/summary` (any user, counts only) gives `ahead` (queued document jobs), `running` and a rough `etaSeconds` (`queueSummary`: median of the 50 newest runs timed in the last 24 h, over the running jobs; null without history, 0 for an empty queue)."
4. At the end of the **UI** bullet, append: " Test runs (`RunsTab`, `RunSamples`, `RunBatchCard`, helpers in `workbench/runs.ts`) follows handoff §11: *Run on n dev samples* (the selected ready dev samples; opens the re-process dialog), sample tick boxes (preparing and failed ones disabled with a reason), the queue line, batches newest first (live border, stacked status bar, rows with status, detail, step progress, duration, *Review now*/*Review*/*Retry*), older batches and runs outside a batch (reference and evaluation runs, runs from before batches) behind *Show*."
5. In the "Job statuses and tasks" mention of migrations in the Rules section if any lists migration numbers for jobs (search `migration 0023` in the Access bullet): no change needed.

- [ ] **Step 2: Run** `npm run openapi` (commit `docs/openapi.json` if it changed), then `npm run check` → green (lint, typecheck, every TS project, `worker:lint`, `worker:test`). Then `npx prettier --check .`; fix only the reported files with `npx prettier --write <file>`.

Also re-run the Pg integration tests once on a fresh container (Global Constraints) and the worker integration test against it: `DATABASE_URL=postgres://postgres:test@localhost:55447/postgres /c/Users/kenha/AppData/Roaming/Python/Python313/Scripts/uv.exe run --directory worker pytest -m integration tests/test_queue_integration.py` → PASS; `docker rm -f ih-test-pg-runs`.

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/openapi.json
git commit -m "Docs: test run batches, step progress, queue summary and the Test runs tab in CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

(Never `git add -A`.)

---

## Self-review

- **Spec coverage (§11):** status line (Task 6), description text and primary *Run on n dev samples* following the selection (Tasks 7, 9), sample chips with tick boxes, ready on by default, preparing/failed greyed with a reason (Tasks 7, 9), queue estimate (Tasks 5, 7, 9), batches newest first with live border, title, who/what, stacked bar and counts (Tasks 7–9), rows with file, pill, detail, 3-segment step bar on running rows, duration, *Review now*/*Review*/*Retry* (Task 8), older batches behind *Show* (Tasks 7, 9). TR1 (Task 2), TR2 (Tasks 1–2), TR3 (Tasks 3–4), TR4 (Task 5). "Tests to add": selection count drives the label (Task 9), preparing/failed not selectable (Tasks 7, 9), status text (Tasks 6, 9), disabled reasons (Task 9). §0: tab header (Task 9), holdout sealed (Tasks 2, 7), accessibility (Tasks 8–9), polling only while running (Task 9).
- **Contracts:** step progress event on both sides with a shared fixture (Task 3); `batchId`/timing TS-only and documented (Tasks 1, 10); `LIST_CACHE_VERSION` bumped (Task 6); new route documented and swept (Task 5); repository interface change with a Pg integration test (Tasks 1, 5).
- **Type consistency:** `TestRun`, `StepProgress`, `QueueSummary`, `QueueStats`, `RunBatch`, `SampleChoice`, `runDevTests(projectId, { model, sampleIds })` are named the same in every task.
