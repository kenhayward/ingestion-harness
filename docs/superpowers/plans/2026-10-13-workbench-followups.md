# Workbench Follow-ups (Phase 6 Deferred Items) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the items deferred from phases 5a, 5b and 6.

- **Phase 6:**
  - Bundles carry the accepted survey and stage progress.
  - Bundle import no longer holds the whole bundle in memory.
  - An unpublished Workbench project can be deleted, so a failed import can be retried under the same id.
- **Phase 5a:**
  - Publishing and recording the publication become one transaction.
  - Threshold changes record who made them.
  - The publish gate stops recomputing unchanged holdout runs.
- **Phase 5b:**
  - An emptied version is not refilled from an older one.
  - Every Workbench test run snapshots its outputs.
  - Regression never runs a legacy and a pinned reference for the same PDF.

**Architecture:**
- **Survey and stage state.** Export params gain `completedStages`. The worker writes `survey.json` and lists `completedStages` in the manifest, both optional, so earlier v1 bundles still import.
- **Recreating that state on import.** Import recreates it the way the app records it:
  - The survey becomes a finished, document-less `draft` job with its drafting result in the runs bucket, plus a proposal accepted through `decideProposal`.
  - The other completed stages are recorded as skips, since the imported draft already holds their content.
- **Streaming import.** The upload streams to a temporary directory. Entries inflate in streams:
  - Sample PDFs go to temp files, with their sha256 computed as they stream.
  - Only the small metadata entries stay in memory.
  - Validation is unchanged and still comes before any write. The temp directory is always removed.
- **Project delete.** `DELETE /api/workbench/projects/:id` removes a project whose document type has no published version, in this order:
  1. All its jobs, documents, samples, Workbench rows and references, and the template drafts.
  2. Then their stored files: best-effort, after the database delete, the same way job delete works.

**Tech Stack:** Fastify + Zod + fflate (streaming `Unzip`), Node `fs/promises` + `node:os` temp dirs, Python worker (Pydantic), React.

**Spec:** `docs/design/workbench.md` (Bundle section; Risks/open questions: retention follows ADR 0005), `docs/adr/0005-*.md` (deletion rules), `docs/adr/0007-workbench.md`.

## Global Constraints

- Holdout rule unchanged: bundles carry dev samples only; `survey.json` is the accepted survey body (dev-only by construction).
- Bundle format stays `ih-workbench-bundle` v1: the new manifest field and the `survey.json` entry are optional, so bundles exported before this change import exactly as they do today.
- Import still validates everything before the first write, and every 400/409 leaves nothing behind (including no temp files).
- Project delete is refused (409) when any version of the document type is published: publications, regression runs and production jobs belong to a published type and are not deleted here. Retention of published types' projects stays an open question (design doc).
- Deleting follows ADR 0005's pattern: database rows first in one transaction, then best-effort removal of stored files; published target copies, the OCR cache and the content-keyed caches (`prepared/`, `step-cache/`, `ocr-cache/`) are never touched.
- Unit tests never touch Postgres/S3/LLMs; `PgWorkbenchRepo`/`PgRepo` changes get cases in the opt-in `apps/api/test/integration/workbench-pg.test.ts` on a throwaway container only.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit `config/llm-providers.yaml`.

## Review Focus

1. A bundle exported before this change (no `survey.json`, no `completedStages`) imports exactly as before, with all stages pending — pinned in Task 1.
2. An imported project's survey is the one `acceptedSurvey` returns, so its next drafting context matches the bundle's `context.md` survey block — pinned in Task 1.
3. A failed or refused import leaves no temp directory behind — pinned in Task 2.
4. Deleting a project while its prepare jobs are still queued or running succeeds and leaves no rows behind; a worker finishing later writes nothing that resurrects them — pinned in Task 3 (rows) and by the existing claim guards.
5. Deleting is refused for a published type, and nothing is removed — pinned in Task 3.

---

### Task 1: Survey and stage state travel in the bundle

**Files:**
- Modify: `packages/shared/src/bundle.ts` (+ `packages/shared/test/bundle.test.ts`)
- Modify: `worker/src/ingest_worker/bundle.py` (+ `worker/tests/test_bundle.py`)
- Modify: `apps/api/src/routes/workbench-bundle.ts`, `apps/api/src/repositories/types.ts`, `memory.ts`, `pg.ts` (finished draft job)
- Test: `apps/api/test/workbench-bundle.test.ts`, `apps/api/test/integration/workbench-pg.test.ts`

**Interfaces:**
- `BundleManifestSchema` gains `completedStages: z.array(z.enum(['survey', 'outputs', 'sections', 'steps'])).optional()`.
- Worker `ExportParams` gains `completed_stages: list[str] = Field(default_factory=list, alias="completedStages")`; the manifest carries `completedStages` (always written by new exports); `survey.json` is written when `params.survey` is not None (the JSON body, `indent=2`).
- Export params (API) gain `completedStages`: the stages of `STAGE_ORDER` whose `stageStates` state is `accepted` or `skipped` at export time.
- `Repo.createFinishedDraftJob(projectId: string, params: Record<string, unknown>): Promise<<the row type createDraftJob returns>>` — inserts a document-less `draft` job with `status = 'succeeded'` (never claimed), `test = true`, workbench priority.
- Import: when `survey.json` is present it must parse with `SurveyBodySchema` (else 400 `survey.json: <issue>`), validated with everything else before any write.

- [ ] **Step 1: Failing tests**

Shared (`bundle.test.ts`): the existing manifest literal still parses (no `completedStages`); `{ ...manifest, completedStages: ['survey', 'outputs'] }` parses; `completedStages: ['references']` is rejected.

Worker (`test_bundle.py`):

```python
SURVEY = {"summary": "Letters", "variants": [], "data": [], "questions": []}  # match SurveyBody's real shape


def test_export_carries_the_survey_and_completed_stages(fixture_specs_dir: Path) -> None:
    store, deps = make(fixture_specs_dir)
    manifest = run_export(export_job(survey=SURVEY, completedStages=["survey", "outputs"]), deps, FakeQueue())
    files = read_zip(store.get("runs", export_key("letter", "job-x")))
    assert json.loads(files["survey.json"]) == SURVEY
    assert manifest["completedStages"] == ["survey", "outputs"]


def test_export_without_a_survey_has_no_survey_entry(fixture_specs_dir: Path) -> None:
    store, deps = make(fixture_specs_dir)
    manifest = run_export(export_job(), deps, FakeQueue())
    files = read_zip(store.get("runs", export_key("letter", "job-x")))
    assert "survey.json" not in files
    assert manifest["completedStages"] == []
```

(Take `SURVEY`'s real shape from `SurveyBodySchema` / `drafting.SURVEY_SCHEMA`; adapt the helpers to what `test_bundle.py` already has.) Update the existing exact-manifest assertion to include `"completedStages": []` — a deliberate change (the manifest gained a field).

API (`workbench-bundle.test.ts`):
1. Export params include `completedStages` — skip survey and outputs, export → `params.completedStages` equals `['survey', 'outputs']`.
2. Import with `survey.json` and `completedStages: ['survey', 'outputs', 'sections']`:
   - `GET /api/workbench/projects/<id>/stages` shows survey `accepted`, outputs and sections `skipped`, steps `pending`, and none of them `stale`;
   - `acceptedSurvey` for the new project (read it through the route that exposes the survey, or call the exported helper) returns the imported body;
   - no job of the new project is `queued` except the samples' `prepare` jobs.
3. Import of a manifest without `completedStages` and without `survey.json` → every stage `pending` (today's behaviour).
4. `survey.json` that is not a valid survey → 400 `survey.json: …` and nothing written.
5. `completedStages` containing `survey` without a `survey.json` → the survey stage is recorded as **skipped** (the draft holds the work; there is no survey body to accept).

- [ ] **Step 2: Run them and see them fail**

Run: `npx vitest run --project shared`, `npx vitest run --project api apps/api/test/workbench-bundle.test.ts`, `cd worker && uv run pytest tests/test_bundle.py`. Expected: FAIL on the new cases.

- [ ] **Step 3: Implement**

- Shared schema: the optional field above.
- Worker: `ExportParams.completed_stages`; manifest `"completedStages": params.completed_stages`; `build_bundle` takes `survey: dict[str, Any] | None` and writes `survey.json` after `brief.json` when not None (keep entries in a fixed order).
- API export: `completedStages: (await allStages(app, id)).filter((s) => STAGE_ORDER.includes(s.stage) && (s.state === 'accepted' || s.state === 'skipped')).map((s) => s.stage)` (export `allStages` from `workbench.ts` if needed; it includes `references` — filter to `STAGE_ORDER`).
- Repo `createFinishedDraftJob` (memory + Pg: `INSERT INTO jobs (project_id, task, test, priority, max_attempts, params, status) VALUES ($1, 'draft', true, $2, 3, $3, 'succeeded')`).
- Import, after the samples are added (write phase, in this order):
  1. If a survey body was given: `const job = await repo.createFinishedDraftJob(id, { stage: 'survey', dataPolicy: 'local', imported: true })` — check `DraftParams` is never applied to it (it is never claimed); then `store.put(runs, draftingKey(id, job.id), JSON.stringify({ stage: 'survey', model: 'imported', body: survey, usage: { inputTokens: 0, outputTokens: 0 } }))` (must satisfy `DraftResultSchema`); then `workbench.createProposal({ id: job.id, projectId: id, stage: 'survey', briefVersion: <imported brief version or null>, baseVersion: null, baseDefinition: null, feedbackIds: null })` and `workbench.decideProposal(id, job.id, 'accepted')`.
  2. For each of `outputs`, `sections`, `steps` (in `STAGE_ORDER` order) in `completedStages`: `workbench.addSkip(id, stage)`. For `survey` in `completedStages` without a survey body: `addSkip(id, 'survey')` first.
  The order matters: completions must be chronological in `STAGE_ORDER` so nothing is `stale`.
- If any step of this phase throws, the existing "import failed after creating project …" 500 applies; update its text to say the project can now be deleted (Task 3 adds the route; until then keep the current text — Task 3 changes it).

- [ ] **Step 4: Pass, Pg case, commit**

Run the three suites again; then the Pg integration test on a throwaway container (port 55494, single simple commands: `docker run --rm -d --name ih-fu-pg -e POSTGRES_PASSWORD=test -p 55494:5432 postgres:17-alpine`; `IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55494/postgres npx vitest run --config apps/api/vitest.integration.config.ts workbench-pg`; `docker rm -f ih-fu-pg`) with a case: `createFinishedDraftJob` inserts a `succeeded` draft job that `listDraftJobs` returns and that is never claimable (status not `queued`). `npm run check` (exit code).

```bash
git add packages/shared worker apps/api
git commit -m "Workbench bundle: carry the accepted survey and completed stages"
```

---

### Task 2: Stream bundle import through temporary files

**Files:**
- Modify: `apps/api/src/routes/workbench-bundle.ts` (split the unzip/validate part into `apps/api/src/workbench/bundle-import.ts` if the file passes ~400 lines)
- Test: `apps/api/test/workbench-bundle.test.ts`

**Interfaces:**
- `readBundle(stream: Readable, opts: { maxUploadBytes: number; maxInflated: number; maxEntries: number; tmpRoot?: string }): Promise<ReadBundle>` where

```ts
interface BundleSampleFile {
  /** Temp file holding the inflated PDF. */
  path: string;
  sha256: string;
  size: number;
  /** First bytes, for the %PDF check. */
  head: Buffer;
}
interface ReadBundle {
  dir: string; // temp dir to remove (always, in finally)
  /** manifest.json, brief.json, template.yaml, survey.json — the only entries kept in memory. */
  text: Map<string, Buffer>;
  /** samples/<sha>.pdf entries, by entry name. */
  samples: Map<string, BundleSampleFile>;
}
```

  It throws `BundleError(message)` for `bundle is too large`, `not a valid bundle (zip)` and `sample <name>: larger than the upload limit`; the route maps it to 400. Other entries (`context.md`, `stages/*`, `README.md`) are inflated, counted toward the caps, and discarded.
- Behaviour stays identical to today for every existing test; the per-file limit is enforced while streaming (abort as soon as an entry passes `maxUploadBytes`).

- [ ] **Step 1: Failing tests**

```ts
it('removes its temporary files after an import and after a refusal', async () => {
  const before = await tmpEntries(); // readdir(os.tmpdir()) filtered to 'ih-import-'
  await importBundle(app, bundle()); // 201
  await importBundle(app, Buffer.from('nope')); // 400
  await importBundle(app, bundle({ manifest: { formatVersion: 2 } })); // 400
  expect(await tmpEntries()).toEqual(before);
});

it('refuses a sample over the upload limit while streaming it', async () => {
  // testApp({ maxUploadBytes: 1024 }); a sample PDF of 4 KiB → 400 'sample <file>: larger than the upload limit'
  // and nothing written (existing helper assertions)
});
```

Plus a unit test of `readBundle` on a hand-built zip: `text` holds exactly `manifest.json`/`brief.json`/`template.yaml`, `samples` holds the PDF with the right sha256/size/head and a temp file whose bytes equal the PDF; `context.md` is not kept.

Run: `npx vitest run --project api apps/api/test/workbench-bundle.test.ts` — Expected: the new tests FAIL (`readBundle` missing; no temp dir used).

- [ ] **Step 2: Implement**

- Route: stop calling `file.toBuffer()`. `const dir = await mkdtemp(join(tmpdir(), 'ih-import-'))`; stream `file.file` into `dir/bundle.zip` with `pipeline` and a byte counter that aborts past the upload cap (also check `file.file.truncated` → 400 `bundle is too large`).
- `readBundle` reads `bundle.zip` in 64 KiB chunks (`createReadStream(..., { highWaterMark: 65536 })`) and pushes them into fflate's `Unzip` with `UnzipInflate` registered (as today), keeping the running inflated-bytes and entry-count caps. In `ondata` per entry: for `samples/*.pdf` write chunks to `dir/<n>.pdf` (sync `fs.writeSync` on an fd opened at entry start is fine; close it on `final`), update a `createHash('sha256')`, count bytes (abort past `maxUploadBytes`), keep the first 8 bytes; for the four metadata names collect chunks in memory; drop everything else.
- Validation uses `samples.get(s.file)` (`head` for `isPdf`, `sha256`, `size`); the write phase reads each PDF with `readFile(path)` just before `addSampleFile` (one PDF in memory at a time).
- `finally { await rm(dir, { recursive: true, force: true }) }` around the whole route body after the temp dir exists.

- [ ] **Step 3: Pass and commit**

Run: `npx vitest run --project api` then `npm run check` (exit codes).

```bash
git add apps/api
git commit -m "API: stream bundle import through temporary files"
```

---

### Task 3: Delete an unpublished Workbench project; docs

**Files:**
- Modify: `apps/api/src/workbench/repo.ts` (interface, memory, Pg), `apps/api/src/routes/workbench.ts` (route), `apps/api/src/routes/workbench-bundle.ts` (failure message)
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/src/workbench/ProjectPage.tsx` (+ test)
- Modify: `CLAUDE.md`, `docs/architecture.md`, `docs/design/workbench.md`
- Test: `apps/api/test/workbench-delete.test.ts` (create), `apps/api/test/integration/workbench-pg.test.ts`

**Interfaces:**
- `WorkbenchRepo.deleteProject(id: string): Promise<{ jobs: RemovedJob[]; documents: StoredObject[] } | null>` — null when no such project. In one transaction it deletes, for the project:
  - every job with `project_id = id` (cascades take their outputs, step runs, events, proposals);
  - feedback, iterations, publications, stage skips, briefs and samples;
  - `template_references` of the template;
  - every document with `spec_id = id` that no remaining job references;
  - the `workbench_projects` row.
  It returns each deleted job's draft outputs (as `RemovedJob`) and the inbox objects of deleted documents that no remaining document row shares.
- `DELETE /api/workbench/projects/:id`:
  - 404 when the project is unknown;
  - 409 `<id> has a published version; published document types keep their project` when any template version is published;
  - otherwise 204.
  After the database delete it removes each open template draft (`templates.deleteDraft`), then, best-effort:
  - `removeJobFiles` for each job;
  - the inbox objects;
  - the prefixes `drafting/<id>/`, `segmentation/<id>/` and `exports/<id>/` in the runs bucket.
  It logs `workbench project deleted` with the counts.
- `Api.deleteProject(id: string): Promise<void>`.

- [ ] **Step 1: Failing tests**

`apps/api/test/workbench-delete.test.ts` (reuse the `project()`/`add()` helpers pattern):
1. Deletes everything of an unpublished project:
   - Setup: a project with two samples (one prepare job still `queued`), a brief, a skipped stage, a draft job with a drafting object, an evaluation iteration with a test-run job and its draft output object, a reference, feedback and a finished export with its zip.
   - The delete returns 204.
   - Afterwards:
     - `GET /api/workbench/projects/letter` is 404 and the template has no versions;
     - `repo.jobs` and the memory workbench maps hold nothing for `letter`;
     - the inbox PDFs, `drafting/letter/…`, `exports/letter/…` and the job's `{jobId}/` runs objects are gone;
     - `prepared/<sha>/text.json` is kept (a content cache).
2. Refuses a published type and removes nothing (409, every row and object still there).
3. Unknown project → 404.
4. An id becomes reusable: delete, then `POST /api/workbench/projects` with the same id → 201.
5. A sample PDF shared with another document row (same inbox object) is not deleted from the store.
6. The import failure message now reads `import failed after creating project <id>; delete the project and import again` (update the existing test deliberately).

Pg integration case: a project with jobs, samples, iterations and references is deleted in one call. No rows remain in any workbench table, in `jobs` or in `documents` for it. A second project is untouched.

Web: on the project page, a "Delete project" button asks for the project id to be typed. It calls `api.deleteProject` only when the typed id matches, then navigates to the Workbench list. The server error is shown when the delete is refused.

Run: `npx vitest run --project api apps/api/test/workbench-delete.test.ts` and `npx vitest run --project web` — Expected: FAIL.

- [ ] **Step 2: Implement**

- Pg `deleteProject`: mirror `PgRepo.deleteJob`'s transaction:
  1. `SELECT … FOR UPDATE` the project row.
  2. Collect draft outputs for every project job (`job_outputs` stage `draft`).
  3. Delete in foreign-key order. Read every table's FKs in `db/migrations` and delete children first. Prefer explicit deletes over relying on cascades you have not verified.
  4. Delete documents with `spec_id = $1` that are unreferenced, returning their bucket/key.
  5. Compute the inbox objects that no remaining document row shares.
  6. Delete the project row and commit.
- Memory `deleteProject`: the same effects on `MemoryWorkbenchRepo`'s maps and the wrapped `MemoryRepo`'s jobs, documents, outputs and references.
- Route: as specified above. Template drafts are removed after the database delete. If `deleteDraft` fails, log it; the draft stays visible on Document types and can be deleted there.
- Web: the client method, the fake, and the button with an inline confirm (a text input labelled "Type <id> to confirm" plus a "Delete project" submit button). Tests query by role and label.

- [ ] **Step 3: Docs**

- `docs/design/workbench.md`, Bundle section:
  - the survey and completed stages travel in the bundle (optional `survey.json`, `completedStages`);
  - import recreates them (accepted survey; skips for the rest);
  - import streams through temporary files.
  - Replace the "survey not imported" line.
- `docs/design/workbench.md`, API sketch: `DELETE /projects/:id` (unpublished only).
- `docs/design/workbench.md`, Risks: the retention question now covers only published types' projects.
- `CLAUDE.md`, Workbench bullet: the same facts, plus `deleteProject`'s scope (what is and isn't removed).
- `docs/architecture.md`: one sentence each.

- [ ] **Step 4: Full check, Pg run, commit**

1. Run `npm run check`, `npm run format:check` and `npm run worker:lint`, checking exit codes.
2. Run the Pg integration test on a throwaway container, as in Task 1.

```bash
git add apps CLAUDE.md docs
git commit -m "Workbench: delete an unpublished project; docs for the follow-ups"
```

---

### Task 4: Atomic publish and threshold attribution (5a follow-ups); migration 0020

**Files:**
- Create: `db/migrations/0020_workbench_followups.sql`
- Modify: `apps/api/src/workbench/repo.ts` (interface, memory and Pg)
- Modify: `apps/api/src/routes/workbench.ts` (the publish and PATCH routes)
- Modify: `packages/shared/src/workbench.ts` (`WorkbenchProject` fields)
- Modify: `apps/web/src/workbench/PublishPanel.tsx`
- Test: `apps/api/test/workbench-publish.test.ts`, `apps/api/test/workbench-publish-repo.test.ts`, `apps/api/test/integration/workbench-pg.test.ts`, `apps/web/test/PublishPanel.test.tsx`

**Interfaces:**
- Migration 0020 (Task 5 uses it too):

```sql
-- Workbench follow-ups: who last changed the publish threshold, and a per-iteration cache of the
-- publish gate's raw holdout scores (keyed by a fingerprint of the iteration's jobs).
ALTER TABLE workbench_projects
  ADD COLUMN threshold_set_by text,
  ADD COLUMN threshold_set_at timestamptz;
ALTER TABLE workbench_iterations ADD COLUMN gate_cache jsonb;
```

- Threshold attribution:
  - `WorkbenchProject` gains `thresholdSetBy: string | null` and `thresholdSetAt: string | null`.
  - `setPublishThreshold(id, threshold, actor: string | null)` sets both columns (`now()`).
- `WorkbenchRepo.publishDraft(input: { projectId: string; version: number; definition: Record<string, unknown>; publication: Omit<Publication, 'id' | 'publishedAt'> }): Promise<{ result: 'published'; publication: Publication } | { result: 'changed' } | { result: 'not-draft' }>`
  - In Pg this is ONE transaction:
    1. `SELECT definition, status FROM templates WHERE id = $1 AND version = $2 FOR UPDATE`.
    2. If there is no row or it is not a draft → `not-draft`.
    3. If `stableJson(row.definition) !== stableJson(input.definition)` → `changed` (compare in TS after the locked read).
    4. `UPDATE templates SET status='published', published_at=now(), updated_at=now() WHERE … AND status='draft'`.
    5. `INSERT INTO workbench_publications …`.
    6. COMMIT.
  - Memory does the same against `MemoryTemplateRepo`. Give `MemoryWorkbenchRepo` access to it the way it already holds `MemoryRepo`, and adapt `testApp()` and the composition root.
  - The publish route replaces the sequence (re-check, `templates.publish`, `recordPublication`) with this single call:
    - `changed` → 409 `the draft changed while publishing; check the gate again`;
    - `not-draft` → 409 `no open draft to publish`;
    - the response is otherwise unchanged.

- [ ] **Step 1: Failing tests.**
  - Repo tests (memory), one per result. `published` writes both the template status and the publication; `changed` and `not-draft` write neither.
  - Rollback, memory: the publication insert fails (spy it to throw) → the template stays a draft. Make the memory implementation write both only after both have succeeded.
  - Rollback, Pg (integration test): a publication with a threshold outside the CHECK range makes the INSERT fail inside the transaction, and the draft stays a draft.
  - The existing "draft changed while publishing" API test keeps passing.
  - Threshold:
    - `PATCH /projects/:id` records `thresholdSetBy` from `req.auth?.label ?? null`, plus `thresholdSetAt`.
    - `GET /projects/:id` returns both fields.
    - PublishPanel shows "Threshold set by <label> on <date>" when they are present.
- [ ] **Step 2: See the tests fail, implement, then see them pass** (`npx vitest run --project api` and `--project web`).
- [ ] **Step 3: Docs.** In the 5a text of `CLAUDE.md` and `docs/design/workbench.md`, add two points:
  - the gate re-check, the publish and the publication record now happen in one transaction;
  - the threshold records who set it.
- [ ] **Step 4: Pg run, check, commit.** Run the Pg integration test on a throwaway container, as in Task 1. Then run `npm run check` and check its exit code.

```bash
git add db/migrations/0020_workbench_followups.sql apps packages CLAUDE.md docs
git commit -m "Workbench: publish atomically and attribute threshold changes"
```

---

### Task 5: Cache the publish gate's holdout scores by job fingerprint (5a follow-up)

**Files:**
- Modify: `apps/api/src/workbench/repo.ts` (`setGateCache`, `IterationRecord.gateCache`), `apps/api/src/routes/workbench.ts` (`gateFor`)
- Test: `apps/api/test/workbench-publish.test.ts`, `apps/api/test/integration/workbench-pg.test.ts`

**Interfaces:**
- `IterationRecord.gateCache: { fingerprint: string; score: number | null; completed: number; total: number } | null`.
- `WorkbenchRepo.setGateCache(iterationId: string, cache: NonNullable<IterationRecord['gateCache']>): Promise<void>`.
- **Fingerprint:** sha256 of `stableJson` of the iteration's jobs, in `jobIds` order.
  - Each job contributes `[id, status, updatedAt, referenceId]`.
  - A deleted job contributes `[id, null, null, null]`.
  - The data comes from one `listProjectRuns(projectId)` call.
- **In `gateFor`:**
  - When `gateCache.fingerprint` equals the fresh fingerprint, use the cached score, completed and total.
  - Otherwise recompute with `iterationView` (raw holdout output, as today). Store the result with `setGateCache` only when every job has finished: none queued, running or awaiting_review.
  - Coverage stays live, computed from `sample_shas` and the current samples.

- [ ] **Step 1: Failing tests.**
  1. **Cache hit:** a second `GET /publish-gate` with nothing changed reads no job documents. Count document reads by wrapping or spying on the `MemoryObjectStore`.
  2. **Invalidation:** each of these changes the fingerprint, and the test asserts the gate changes:
     - deleting a job;
     - changing a job's status (a re-run);
     - nulling a job's `referenceId` (an unpinned reference hard-deleted).
  3. **Review edits:** a `reviewed-document.json` still never changes the gate.
- [ ] **Step 2: Make them pass.** See them fail, implement, see them pass. Add a Pg integration case for the `setGateCache` round-trip. Run `npm run check`.
- [ ] **Step 3: Docs.** In the 5a text of CLAUDE.md, replace "`gateFor` always recomputes those scores from the jobs" with the fingerprint cache rule (it still reads the raw output).
- [ ] **Step 4: Commit**

```bash
git add apps CLAUDE.md docs
git commit -m "Workbench: cache publish gate scores by a fingerprint of the iteration's jobs"
```

---

### Task 6: References follow-ups (5b)

**Files:**
- Modify:
  - `apps/api/src/repositories/memory.ts` and `pg.ts` (`carryReferencesForward`);
  - `apps/api/src/regression/report.ts` (`versionReferences`);
  - `apps/api/src/routes/workbench.ts`: every place that creates a Workbench `process` job (test runs, evaluations, compare, reference runs);
  - any other API path that creates a test `process` job on a draft template version (search for `createDocumentAndJob(` and `createWorkbenchJob(`).
- Test: `apps/api/test/references-repo.test.ts`, `references.test.ts`, `workbench-versions.test.ts`, the tests of the job-creating routes you touch, and `apps/api/test/integration/workbench-pg.test.ts`.

**Rules:**
1. **Emptied version.** `carryReferencesForward` takes as its source the newest earlier version that has ANY reference row, live or superseded, and copies that version's live rows (possibly none). An emptied v2 therefore passes on nothing, and v1 is not resurrected.
   - Pg: drop the `superseded_at IS NULL` filter from the `max(template_version)` subquery, but keep the outer filter.
   - Memory: the same.
2. **Snapshot on every test run.** Every API path that creates a `process` test job on a DRAFT version stores `params.outputs = <that draft's definition.outputs>`:
   - dev test runs;
   - evaluation runs (dev and holdout);
   - compare groups;
   - the Templates/editor test run, if it can carry params. Where the repo method can't take params, extend it minimally, keeping Memory and Pg the same.
   Reference runs already do this. Saving a reference then uses the snapshot, so the "draft changed after this run" 409 only remains for jobs created before this change. Update existing `toEqual` assertions on params deliberately, and list each one in your report.
3. **One reference per PDF.** `versionReferences` builds on `listReferencesWithSha` (every row): keep live references that are pinned to the version or unpinned and not outdated, then keep ONE per document sha256, preferring the pinned one. Return plain `Reference` objects (drop `sha256`).

- [ ] **Step 1: Failing tests.**
  - Repo (memory and Pg): soft-delete every v2 reference → `carryReferencesForward('letter', 3)` returns 0, and v3 has none.
  - For each job-creating route you change, `getJobParams(job).outputs` equals the draft outputs at creation.
  - End to end: a dev test run of a draft, then a draft edit to `steps` only, then approve and save the reference → 201. Today this is a 409.
  - Regression: an unpinned (legacy) reference and a pinned v2 reference for the same PDF → `versionReferences('letter', 2)` has exactly one entry, the pinned one, and `POST …/versions/2/regression` creates one job.
- [ ] **Step 2: Make the tests pass.**
  1. Run the tests and see them fail.
  2. Implement, then see them pass.
  3. Run the Pg integration test.
  4. Run `npm run check`.
- [ ] **Step 3: Docs.** In the 5b text of CLAUDE.md and `docs/design/workbench.md`, describe:
  - the carry-source rule;
  - the outputs snapshot on every Workbench test run;
  - dedupe by PDF.
- [ ] **Step 4: Commit**

```bash
git add apps CLAUDE.md docs
git commit -m "References: no refill of emptied versions, outputs snapshot on every test run, one reference per PDF"
```
