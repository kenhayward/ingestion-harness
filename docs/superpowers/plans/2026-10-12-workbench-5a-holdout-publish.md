# Workbench 5a/6: Holdout Evaluation and the Publish Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the loop with an honest test, then publish.
- **Holdout references.** Holdout samples get their own references, made by running the template's **own** models and verifying the results in Review.
- **Holdout evaluation.** Evaluate runs on holdout as well as dev. Holdout failures are shown to the user but are never fed to drafting.
- **Holdout history.** Each sample shows how many holdout evaluations it was used in.
- **Publish gate.** **Publish** checks the latest complete holdout evaluation **of the current draft** against the project's threshold. At or above the threshold, it publishes. Below it, or with no such evaluation, publishing needs an override reason. Every publish is logged.
- **No bypass.** A document type with a Workbench project can only be published from the Workbench.

**Architecture:**
- **Holdout runs.** Everything reuses 4a.
  - `referenceRows` and `evaluationInputs` take a `set` (`'dev' | 'holdout'`). The references stage state stays dev-only.
  - Holdout reference runs are ordinary forced-review test runs with **no model override**: holdout text is extracted by the template's own models and never shown to a drafting model.
  - Evaluate gets `{ set }`, and the iteration records it. Existing 4c code already ignores holdout iterations for revise (`set === 'dev'`), and model comparison stays dev-only.
- **The gate.** It is one pure function, `publishGate`, over the threshold and the project's holdout iterations. An iteration counts only if its `templateVersion` is the open draft's and its snapshot `stableJson`-equals the current draft.
- **Publishing.** Publishes go through the existing template publish, then are recorded in `workbench_publications` (migration `0016`), together with the threshold, the score, the iteration and any override reason.

**Tech Stack:** Fastify + Zod (API), React + Testing Library (web), Postgres migration. No worker changes.

**Spec:** [docs/design/workbench.md](../../design/workbench.md): "Evaluation" → "Holdout" (holdout failures visible to the user; `added_for_version` and holdout history stay with the sample; the publish gate uses the holdout score, at or above `publish_threshold` publishes directly, below needs an override reason that is recorded), "User journey" steps 10–11, "API (sketch)" (`evaluate { set }`, `publish { overrideReason? }`, PATCH threshold), ADR 0007 decisions "Holdout: enforced, always visible" and "Overridable threshold".

**Depends on:** 4c ([kenhayward/ingestion-harness#51](https://github.com/kenhayward/ingestion-harness/pull/51)), merged. Migration `0015` is the latest.

**Phase 5 split:**
- **5a (this plan):** holdout references and evaluation, holdout history, the publish gate and the publication log.
- **5b:** references across versions. References are pinned per version for regression, and accepted references are copied forward and re-verified only where outputs changed.

## Global Constraints

- **Threshold.** `publishThreshold` is a number in `[0, 1]` with default `0.9` (`workbench_projects.publish_threshold`). It is changed by `PATCH /api/workbench/projects/:id` with `{ publishThreshold }` (strict). Any session can change it, as ADR 0007 records ("overridable threshold"); the change is logged.
- **Holdout reference runs.** `POST /api/workbench/projects/:id/holdout/reference-runs`:
  - Needs a valid open draft: 409 or 400, with the same messages as 4a.
  - Creates one forced-review test run (`params: { dataPolicy, forceReview: true }`, **`modelOverride: null`**) per ready **holdout** sample that has no reference and no active run.
  - 409 `no prepared holdout samples to run` when there are none; 409 `every holdout sample already has a reference` when all are verified.
  - It is **not** part of the stage order and has no stage state.
- **References view.** `GET /references?set=holdout` returns the holdout rows. Without `set`, or with `set=dev`, the dev rows are returned as before.
- **Evaluate.** `POST /evaluations` accepts `{ model?, uncached?, set? }`, with `set` defaulting to `'dev'`. For `holdout`:
  - Jobs are created for the ready holdout samples that have references.
  - If there are none: 409 `no verified references for the holdout samples; verify them on the References tab first`.
  - `model` is allowed. `/evaluations/compare` stays dev-only.
- **Holdout never reaches drafting.** The 4c filters stay as they are: revise uses `set === 'dev'` iterations only, failure diffs are filtered to dev samples, and feedback may only name dev samples and dev iterations.
- **Gate.** `publishGate({ threshold, candidates })`, where each candidate is a holdout iteration `{ id, status, score, matchesDraft, createdAt }`. It picks the **newest** candidate with `status === 'complete'` and `matchesDraft`. Then:
  - `passes = score !== null && score >= threshold`.
  - `reason` is exactly one of:
    - `no complete holdout evaluation of the current draft`
    - `holdout score <pct> is below the threshold <pct>`
    - `holdout score <pct> meets the threshold <pct>`

    where `<pct>` is the value as a whole-number percentage (`Math.round(x * 100)%`).
- **Publish.** `POST /api/workbench/projects/:id/publish` with `{ overrideReason?: string 10..1000 }` (strict).
  1. Needs an open draft: 409 `no open draft to publish`.
  2. The draft must be valid: 400 with `issues`.
  3. If the gate does not pass and there is no override: 409 with `{ error: '<gate reason>; give an override reason to publish anyway', gate }`.
  4. Otherwise publish the draft through the template repo, record a publication, and reply 201 `{ publication, project: ProjectView }`.
  5. If the gate passes, an override reason is ignored and recorded as null.
- **No bypass.** `POST /api/templates/:id/versions/:v/publish` returns 409 `publish <id> from the Workbench (holdout gate)` when a Workbench project with that id exists. The Templates page publish button shows that error as it does other errors.
- **Holdout history.** `SampleView.holdoutRuns` is the number of holdout iterations whose jobs included this sample's sha256.
- **Migrations and process.** Migrations are forward-only: `db/migrations/0016_workbench_publish.sql`. Zod at every boundary. CI runs `npm run format:check`. Never call real LLMs from tests.

## Review Focus

1. **The draft was edited after the holdout evaluation.** The gate must not count that evaluation, because its snapshot no longer matches. Publishing then needs a fresh holdout run or an override. (Task 1 and Task 4 tests.)
2. **Publishing straight from the Templates page.** For a Workbench document type this gets 409. Types without a project publish as before. (Task 4 test.)
3. **A holdout iteration or holdout reference run reaching revise.** It never does. The 4c tests stay green, and one new test pins that a complete holdout iteration is ignored by revise. (Task 3 test.)
4. **An override reason sent when the gate passes.** The publish succeeds, and the publication records no override. (Task 4 test.)
5. **The threshold set to 0 or 1, or out of range.** 0 always passes once a matching evaluation exists. 1 needs a perfect score. Values outside `[0, 1]` get 400. (Task 1 and Task 4 tests.)

---

### Task 1: Migration and shared contracts

**Files:**
- Create: `db/migrations/0016_workbench_publish.sql`
- Modify: `packages/shared/src/workbench.ts` (`WorkbenchProject.publishThreshold`, `SampleView.holdoutRuns`), `packages/shared/src/evaluation.ts` (`EvaluationSet`, `IterationSummary.set`, gate types, `publishGate`, `Publication`, `PublishBodySchema`)
- Test: `packages/shared/test/evaluation.test.ts`

**Interfaces:**
- Produces:
  - `EVALUATION_SETS = ['dev', 'holdout'] as const` and `type EvaluationSet`. `IterationSummary.set: EvaluationSet`.
  - `WorkbenchProject.publishThreshold: number`
  - `SampleView.holdoutRuns: number`
  - `PublishBodySchema = z.object({ overrideReason: z.string().trim().min(10).max(1000).optional() }).strict()`
  - `ThresholdBodySchema = z.object({ publishThreshold: z.number().min(0).max(1) }).strict()`
  - `interface GateCandidate { id: string; status: 'running' | 'complete'; score: number | null; matchesDraft: boolean; createdAt: string }`
  - `interface GateView { threshold: number; iterationId: string | null; score: number | null; passes: boolean; reason: string }`
  - `publishGate(input: { threshold: number; candidates: GateCandidate[] }): GateView`
  - `interface Publication { id: string; projectId: string; version: number; iterationId: string | null; score: number | null; threshold: number; overrideReason: string | null; publishedBy: string | null; publishedAt: string }`

- [ ] **Step 1: Write the failing test**

Append to `packages/shared/test/evaluation.test.ts`:

```ts
import { PublishBodySchema, ThresholdBodySchema, publishGate, type GateCandidate } from '../src/index.js';

describe('publishGate', () => {
  const c = (over: Partial<GateCandidate>): GateCandidate => ({
    id: 'i1',
    status: 'complete',
    score: 0.95,
    matchesDraft: true,
    createdAt: '2026-10-12T10:00:00.000Z',
    ...over,
  });

  it('passes on the newest complete holdout run of the current draft', () => {
    expect(
      publishGate({
        threshold: 0.9,
        candidates: [c({ id: 'old', score: 0.5, createdAt: '2026-10-12T09:00:00.000Z' }), c({ id: 'new' })],
      }),
    ).toEqual({ threshold: 0.9, iterationId: 'new', score: 0.95, passes: true, reason: 'holdout score 95% meets the threshold 90%' });
  });

  it('fails below the threshold', () => {
    expect(publishGate({ threshold: 0.9, candidates: [c({ score: 0.82 })] })).toMatchObject({
      passes: false,
      reason: 'holdout score 82% is below the threshold 90%',
    });
  });

  it('ignores running runs and runs of an older draft', () => {
    const gate = publishGate({
      threshold: 0.9,
      candidates: [c({ id: 'running', status: 'running' }), c({ id: 'stale', matchesDraft: false })],
    });
    expect(gate).toEqual({
      threshold: 0.9,
      iterationId: null,
      score: null,
      passes: false,
      reason: 'no complete holdout evaluation of the current draft',
    });
  });

  it('handles the threshold edges', () => {
    expect(publishGate({ threshold: 0, candidates: [c({ score: 0 })] }).passes).toBe(true);
    expect(publishGate({ threshold: 1, candidates: [c({ score: 0.99 })] }).passes).toBe(false);
    expect(publishGate({ threshold: 1, candidates: [c({ score: 1 })] }).passes).toBe(true);
    expect(publishGate({ threshold: 0.5, candidates: [c({ score: null })] }).passes).toBe(false);
  });
});

describe('publish bodies', () => {
  it('validates override reasons and thresholds', () => {
    expect(PublishBodySchema.safeParse({}).success).toBe(true);
    expect(PublishBodySchema.safeParse({ overrideReason: 'too short' }).success).toBe(false);
    expect(PublishBodySchema.safeParse({ overrideReason: 'Holdout sample 3 is a known bad scan' }).success).toBe(true);
    expect(ThresholdBodySchema.safeParse({ publishThreshold: 0.8 }).success).toBe(true);
    expect(ThresholdBodySchema.safeParse({ publishThreshold: 1.2 }).success).toBe(false);
    expect(ThresholdBodySchema.safeParse({ publishThreshold: -0.1 }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/shared/test/evaluation.test.ts`
Expected: FAIL. `publishGate` is not exported.

- [ ] **Step 3: Implement**

`db/migrations/0016_workbench_publish.sql`:

```sql
-- Workbench phase 5a (ADR 0007): the publish gate's threshold and the publication log.

ALTER TABLE workbench_projects
  ADD COLUMN publish_threshold numeric NOT NULL DEFAULT 0.9
    CHECK (publish_threshold >= 0 AND publish_threshold <= 1);

CREATE TABLE workbench_publications (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id       text        NOT NULL REFERENCES workbench_projects (id),
  version          integer     NOT NULL,
  iteration_id     uuid        REFERENCES workbench_iterations (id) ON DELETE SET NULL,
  score            numeric,
  threshold        numeric     NOT NULL,
  override_reason  text,
  published_by     text,
  published_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workbench_publications_project_idx ON workbench_publications (project_id, published_at DESC);
```

`evaluation.ts`:

```ts
export const EVALUATION_SETS = ['dev', 'holdout'] as const;
export type EvaluationSet = (typeof EVALUATION_SETS)[number];

export const PublishBodySchema = z
  .object({ overrideReason: z.string().trim().min(10).max(1000).optional() })
  .strict();
export const ThresholdBodySchema = z.object({ publishThreshold: z.number().min(0).max(1) }).strict();

export interface GateCandidate {
  id: string;
  status: 'running' | 'complete';
  score: number | null;
  /** The iteration ran the open draft as it is now (version and definition snapshot). */
  matchesDraft: boolean;
  createdAt: string;
}

export interface GateView {
  threshold: number;
  iterationId: string | null;
  score: number | null;
  passes: boolean;
  reason: string;
}

const percent = (x: number) => `${Math.round(x * 100)}%`;

/** The publish gate (ADR 0007): the newest complete holdout run of the current draft decides. */
export function publishGate({
  threshold,
  candidates,
}: {
  threshold: number;
  candidates: GateCandidate[];
}): GateView {
  const run = candidates
    .filter((c) => c.status === 'complete' && c.matchesDraft)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (!run) {
    return { threshold, iterationId: null, score: null, passes: false, reason: 'no complete holdout evaluation of the current draft' };
  }
  const passes = run.score !== null && run.score >= threshold;
  const shown = run.score === null ? 'none' : percent(run.score);
  return {
    threshold,
    iterationId: run.id,
    score: run.score,
    passes,
    reason: passes
      ? `holdout score ${shown} meets the threshold ${percent(threshold)}`
      : `holdout score ${shown} is below the threshold ${percent(threshold)}`,
  };
}

export interface Publication {
  id: string;
  projectId: string;
  version: number;
  iterationId: string | null;
  score: number | null;
  threshold: number;
  overrideReason: string | null;
  /** Label of the session's token. */
  publishedBy: string | null;
  publishedAt: string;
}
```

Change `IterationSummary.set` to `EvaluationSet`. In `workbench.ts`, add `publishThreshold: number` to `WorkbenchProject` and `holdoutRuns: number` to `SampleView`, each with a doc comment.

- [ ] **Step 4: Run tests, fix fallout**

Run: `npx vitest run packages/shared && npm run typecheck`. Check the **exit code**.
Expected: the shared tests PASS. Fix the fallout with neutral values:
- `publishThreshold: 0.9` in the Memory project create and the web `projectView()` builder. Map it in Pg's `toProject` with `Number(row.publish_threshold)` (Postgres `numeric` comes back as a string).
- `holdoutRuns: 0` in `toView` (Task 3 fills it) and in the web `sampleView()` builder.
- Every `set: 'dev'` literal typed as `IterationSummary['set']`.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0016_workbench_publish.sql packages/shared apps
git commit -m "Workbench: migration 0016 and the publish gate / holdout contracts"
```

---

### Task 2: API repo: threshold and publications

**Files:**
- Modify: `apps/api/src/workbench/repo.ts`, `apps/api/test/integration/workbench-pg.test.ts`
- Test: `apps/api/test/workbench-publish-repo.test.ts` (new)

**Interfaces:**
- Produces (`WorkbenchRepo`):
  - `setPublishThreshold(id: string, threshold: number): Promise<WorkbenchProject | null>`
  - `recordPublication(p: Omit<Publication, 'id' | 'publishedAt'>): Promise<Publication>`
  - `listPublications(projectId: string): Promise<Publication[]>`, newest first
  - `createIteration` accepts `set: EvaluationSet` (already typed by Task 1; Pg writes `eval_set`)
  - Memory timestamps use the shared monotonic clock. Pg converts `numeric` to `number`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-publish-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

describe('publish persistence', () => {
  it('stores the threshold and logs publications newest first', async () => {
    const { workbench } = await testApp();
    await workbench.createProject('letter', 'Letter');
    expect((await workbench.getProject('letter'))!.publishThreshold).toBe(0.9);
    expect((await workbench.setPublishThreshold('letter', 0.75))!.publishThreshold).toBe(0.75);
    expect(await workbench.setPublishThreshold('nope', 0.5)).toBeNull();
    const a = await workbench.recordPublication({
      projectId: 'letter', version: 1, iterationId: null, score: null, threshold: 0.75,
      overrideReason: 'First version, no holdout yet', publishedBy: 'admin',
    });
    const b = await workbench.recordPublication({
      projectId: 'letter', version: 2, iterationId: null, score: 0.92, threshold: 0.75,
      overrideReason: null, publishedBy: null,
    });
    expect((await workbench.listPublications('letter')).map((p) => p.id)).toEqual([b.id, a.id]);
    expect(b.publishedAt > a.publishedAt).toBe(true);
  });

  it('records holdout iterations', async () => {
    const { workbench } = await testApp();
    await workbench.createProject('letter', 'Letter');
    const it0 = await workbench.createIteration({
      projectId: 'letter', templateVersion: 1, definition: {}, briefVersion: null, set: 'holdout',
      model: null, jobIds: [], groupId: null, uncached: false,
    });
    expect((await workbench.getIteration('letter', it0.id))!.set).toBe('holdout');
  });
});
```

Extend the opt-in Pg test with the same behaviour. Check that `numeric` values come back as numbers (`0.75`, `0.92`), not strings.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-publish-repo.test.ts`
Expected: FAIL. `setPublishThreshold` is not a function.

- [ ] **Step 3: Implement**

- Memory: `publications: Publication[]`, with ids from `randomUUID()` and times from the monotonic clock. `setPublishThreshold` updates the stored project.
- Pg:
  - `UPDATE workbench_projects SET publish_threshold = $2 WHERE id = $1 RETURNING *`
  - `INSERT INTO workbench_publications (project_id, version, iteration_id, score, threshold, override_reason, published_by) VALUES (...) RETURNING *`
  - `SELECT * FROM workbench_publications WHERE project_id = $1 ORDER BY published_at DESC, id DESC`
  - A `toPublication` mapper using `Number()` for `score` and `threshold`, and `toISOString()` for `published_at`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project api && npm run typecheck && npm run lint && npx prettier --check apps/api`. Check the typecheck **exit code**. Run the opt-in Pg test on a **throwaway** container if Docker is available.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "API: publish threshold and the publication log"
```

---

### Task 3: API: holdout references, holdout evaluation, holdout history

**Files:**
- Modify: `apps/api/src/routes/workbench.ts`
- Test: `apps/api/test/workbench-holdout.test.ts` (new)

**Interfaces:**
- Consumes: Task 1 contracts; the 4a helpers `referenceEntries` / `referenceRows`, `evaluationInputs` and `startIteration`.
- Produces:
  - `referenceEntries(app, projectId, set: EvaluationSet = 'dev')` and `referenceRows(..., set)`, filtered on `view.role === set`. The references stage view keeps calling them with `'dev'`.
  - `GET /references?set=holdout` (Zod: `z.object({ set: z.enum(EVALUATION_SETS).optional() })`).
  - `POST /holdout/reference-runs` (Global Constraints).
  - `evaluationInputs(app, projectId, reply, set = 'dev')`, with the set-specific 409 message. `startIteration` options gain `set`.
  - `POST /evaluations` accepts `set`. `/evaluations/compare` passes `'dev'`.
  - `SampleView.holdoutRuns` is computed in `sampleViews`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-holdout.test.ts`. Reuse the 4a `project` / `add` / `setRole` / `verify` / `finish` / `evaluate` scaffolding, and the 4c `start` / `feedback` helpers.

```ts
describe('holdout', () => {
  it('runs the template’s own models on unverified holdout samples, forcing review', async () => {
    const { app, add, setRole, repo } = await project();
    await add(1);
    const h = await add(2);
    await setRole(h.id, 'holdout');
    const res = await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/holdout/reference-runs' });
    expect(res.statusCode).toBe(201);
    const [job] = res.json().jobs as { id: string; modelOverride: string | null }[];
    expect(job!.modelOverride).toBeNull();
    expect(repo.jobParams.get(job!.id)).toEqual({ dataPolicy: 'local', forceReview: true });
    const rows = (await app.inject('/api/workbench/projects/letter/references?set=holdout')).json();
    expect(rows.map((r: { filename: string }) => r.filename)).toEqual(['s2.pdf']);
    const dev = (await app.inject('/api/workbench/projects/letter/references')).json();
    expect(dev.map((r: { filename: string }) => r.filename)).toEqual(['s1.pdf']);
  });

  it('refuses holdout runs with no holdout samples, or when all are verified', async () => {
    const { app, add, setRole, verify } = await project();
    await add(1);
    const none = await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/holdout/reference-runs' });
    expect(none.json().error).toBe('no prepared holdout samples to run');
    const h = await add(2);
    await setRole(h.id, 'holdout');
    await verify(h, 'Acme');
    const done = await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/holdout/reference-runs' });
    expect(done.json().error).toBe('every holdout sample already has a reference');
  });

  it('evaluates on holdout, counts each sample’s holdout runs, and never feeds revise', async () => {
    const { app, add, setRole, verify, evaluate, finish, repo, start, feedback } = await project();
    const d = await add(1);
    const h = await add(2);
    await setRole(h.id, 'holdout');
    await verify(d, 'Acme');
    expect((await evaluate({ set: 'holdout' })).json().error).toBe(
      'no verified references for the holdout samples; verify them on the References tab first',
    );
    await verify(h, 'Globex');
    const holdout = (await evaluate({ set: 'holdout' })).json();
    expect(holdout).toMatchObject({ set: 'holdout', total: 1 });
    for (const r of (await repo.listProjectRuns('letter')).filter((x) => x.job.referenceId)) await finish(r.job.id, 'Wrong');
    const samples = (await app.inject('/api/workbench/projects/letter/samples')).json() as { id: string; holdoutRuns: number }[];
    expect(samples.find((s) => s.id === h.id)!.holdoutRuns).toBe(1);
    expect(samples.find((s) => s.id === d.id)!.holdoutRuns).toBe(0);
    await feedback({ target: 'field', targetId: 'sender', body: 'Letterhead' });
    const revise = (await start('revise')).json();
    expect((repo.draftJobs.get(revise.id)!.params as { failures: unknown[] }).failures).toEqual([]);
  });

  it('keeps model comparison dev-only', async () => {
    const { app, add, setRole, verify } = await project();
    const h = await add(1);
    await setRole(h.id, 'holdout');
    await verify(h, 'Acme');
    const res = await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/evaluations/compare', payload: {} });
    expect(res.statusCode).toBe(409); // no verified DEV references
  });
});
```

(Adapt the scaffolding: `evaluate` must accept a payload, and `verify` creates a reference from a finished test run, as in the 4a tests. Keep the assertions.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-holdout.test.ts`
Expected: FAIL. `/holdout/reference-runs` returns 404.

- [ ] **Step 3: Implement**

- `referenceEntries` / `referenceRows`: add the `set` parameter and filter `s.view.role === set && s.view.state === 'ready'`. Every existing caller passes or defaults to `'dev'`.
- `GET /references`: parse `req.query` with the schema above and pass the set.
- `POST /holdout/reference-runs`:
  1. Run the 4a open-draft and valid-draft checks, with the same messages.
  2. `const holdout = await referenceEntries(app, projectId, 'holdout')`. If it is empty, 409 `no prepared holdout samples to run`.
  3. `todo` = rows without a reference and whose latest run is not `queued` or `running`. If every row has a reference, 409 `every holdout sample already has a reference`. If `todo` is empty for another reason, 409 `reference runs are already running`.
  4. Create jobs with `createWorkbenchJob(sampleDocument(record, projectId, draft), { projectId, task: 'process', params: { dataPolicy, forceReview: true }, modelOverride: null })`.
  5. Reply 201 `{ jobs }`.
- `EvaluateBody` adds `set: z.enum(EVALUATION_SETS).optional()`.
  - `evaluationInputs(..., set)` uses `referenceRows(app, projectId, set)` and the set-specific message: the 4a dev message is unchanged, and the holdout one is from the Global Constraints.
  - `startIteration` writes `set` to the iteration.
  - `/evaluations/compare` uses `'dev'`.
- `sampleViews`: compute `holdoutRuns` once per call.
  1. `const holdoutIterations = (await workbench.listIterations(projectId)).filter((i) => i.set === 'holdout')`.
  2. `const shaByJob = new Map((await repo.listProjectRuns(projectId)).map((r) => [r.job.id, r.sha256]))`.
  3. For each sample, count the iterations where some `jobIds` entry maps to the sample's sha.
  4. Pass the count into `toView`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project api && npm run typecheck && npm run lint && npx prettier --check apps/api`. Check the typecheck **exit code**.
Expected: PASS. Every 4a/4b/4c test is unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "API: holdout references and evaluation; holdout history per sample"
```

---

### Task 4: API: the publish gate, publishing and the Templates bypass

**Files:**
- Modify: `apps/api/src/routes/workbench.ts`, `apps/api/src/routes/templates.ts`
- Test: `apps/api/test/workbench-publish.test.ts` (new), `apps/api/test/templates.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `stableJson` (`@ih/shared`), `iterationView`, the template repo `publish`.
- Produces:
  - `PATCH /api/workbench/projects/:id` with `ThresholdBodySchema` returns `ProjectView`. It returns 400 for a bad body and 404 for an unknown project.
  - `GET /api/workbench/projects/:id/publish-gate` returns `GateView`. Without an open draft: `{ ...gate, passes: false, reason: 'no open draft to publish' }`.
  - `POST /api/workbench/projects/:id/publish` follows the Global Constraints.
  - `GET /api/workbench/projects/:id/publications` returns `Publication[]`.
  - `POST /api/templates/:id/versions/:v/publish` returns 409 when a Workbench project with that id exists.

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-publish.test.ts` (same scaffolding as Task 3):

```ts
describe('publish gate', () => {
  async function holdoutRun(ctx: Awaited<ReturnType<typeof project>>, sender: string) {
    const h = await ctx.add(9);
    await ctx.setRole(h.id, 'holdout');
    await ctx.verify(h, 'Acme');
    const iteration = (await ctx.evaluate({ set: 'holdout' })).json();
    const [run] = (await ctx.repo.listProjectRuns('letter')).filter((r) => r.job.referenceId);
    await ctx.finish(run!.job.id, sender);
    return iteration as { id: string };
  }
  const publish = (ctx: Awaited<ReturnType<typeof project>>, payload: object = {}) =>
    ctx.app.inject({ method: 'POST', url: '/api/workbench/projects/letter/publish', payload });

  it('publishes when the holdout run of the current draft meets the threshold', async () => {
    const ctx = await project();
    const iteration = await holdoutRun(ctx, 'Acme');
    const gate = (await ctx.app.inject('/api/workbench/projects/letter/publish-gate')).json();
    expect(gate).toMatchObject({ iterationId: iteration.id, passes: true, score: 1 });
    const res = await publish(ctx, { overrideReason: 'not needed but harmless here' });
    expect(res.statusCode).toBe(201);
    expect(res.json().publication).toMatchObject({ version: 1, iterationId: iteration.id, score: 1, threshold: 0.9, overrideReason: null });
    expect((await ctx.templates.get('letter', 1))!.status).toBe('published');
  });

  it('needs an override below the threshold and records it', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Wrong');
    const refused = await publish(ctx);
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toBe('holdout score 0% is below the threshold 90%; give an override reason to publish anyway');
    const res = await publish(ctx, { overrideReason: 'Scan quality on the holdout sample is unusable' });
    expect(res.statusCode).toBe(201);
    expect(res.json().publication.overrideReason).toBe('Scan quality on the holdout sample is unusable');
    const [logged] = (await ctx.app.inject('/api/workbench/projects/letter/publications')).json();
    expect(logged.overrideReason).toBe('Scan quality on the holdout sample is unusable');
  });

  it('does not count a holdout run of an earlier draft', async () => {
    const ctx = await project();
    await holdoutRun(ctx, 'Acme');
    await ctx.templates.updateDraft('letter', 1, { ...letter(1), name: 'Edited after the run' });
    const gate = (await ctx.app.inject('/api/workbench/projects/letter/publish-gate')).json();
    expect(gate).toMatchObject({ passes: false, reason: 'no complete holdout evaluation of the current draft' });
    expect((await publish(ctx)).statusCode).toBe(409);
  });

  it('changes the threshold within [0, 1]', async () => {
    const ctx = await project();
    const patch = (publishThreshold: number) =>
      ctx.app.inject({ method: 'PATCH', url: '/api/workbench/projects/letter', payload: { publishThreshold } });
    expect((await patch(0.5)).json().project.publishThreshold).toBe(0.5);
    expect((await patch(1.5)).statusCode).toBe(400);
    await holdoutRun(ctx, 'Wrong');
    await patch(0);
    expect((await publish(ctx)).statusCode).toBe(201);
  });

  it('refuses publishing a workbench type from the Templates page', async () => {
    const ctx = await project();
    const res = await ctx.app.inject({ method: 'POST', url: '/api/templates/letter/versions/1/publish' });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('publish letter from the Workbench (holdout gate)');
  });
});
```

`templates.test.ts`: assert that a document type **without** a Workbench project still publishes from the templates route (it does today; this pins it).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-publish.test.ts`
Expected: FAIL. `/publish-gate` returns 404.

- [ ] **Step 3: Implement**

In `routes/workbench.ts`:

```ts
/** The publish gate for the open draft: holdout iterations of exactly this draft count. */
async function gateFor(app: FastifyInstance, project: WorkbenchProject): Promise<GateView & { draft: number | null }> {
  const { draft } = await versionsOf(app.deps.templates, project.id);
  if (draft === null) {
    return { threshold: project.publishThreshold, iterationId: null, score: null, passes: false, reason: 'no open draft to publish', draft };
  }
  const current = stableJson((await app.deps.templates.get(project.id, draft))!.definition);
  const holdout = (await app.deps.workbench.listIterations(project.id)).filter((i) => i.set === 'holdout');
  const candidates = await Promise.all(
    holdout.map(async (i) => {
      const matchesDraft = i.templateVersion === draft && stableJson(i.definition) === current;
      const summary = i.scores
        ? { status: 'complete' as const, score: i.scores.score }
        : await iterationView(app, i).then((v) => ({ status: v.status, score: v.score }));
      return { id: i.id, createdAt: i.createdAt, matchesDraft, ...summary };
    }),
  );
  return { ...publishGate({ threshold: project.publishThreshold, candidates }), draft };
}
```

(Only compute `iterationView` for iterations whose `matchesDraft` is true, to avoid needless work. Restructure the map accordingly.)

Routes:
- `PATCH /workbench/projects/:id`: parse `ThresholdBodySchema` (400), call `setPublishThreshold` (404), log `{ projectId, publishThreshold }`, and return `projectView`.
- `GET /publish-gate`: 404 for an unknown project. Return the `GateView` without `draft`.
- `POST /publish`:
  1. Parse `PublishBodySchema`.
  2. Return 404 for an unknown project.
  3. Compute `gate = await gateFor(app, project)`.
  4. If `gate.draft === null`, 409 `no open draft to publish`.
  5. Validate the draft definition (400 with issues).
  6. If `!gate.passes && !body.overrideReason`, 409 `{ error: \`${gate.reason}; give an override reason to publish anyway\`, gate }`.
  7. `const published = await templates.publish(project.id, gate.draft)`. If it is null, 409 `the draft is no longer open`.
  8. `const publication = await workbench.recordPublication({ projectId, version: gate.draft, iterationId: gate.iterationId, score: gate.score, threshold: gate.threshold, overrideReason: gate.passes ? null : body.overrideReason!, publishedBy: req.auth?.label ?? null })`.
  9. Log it, then reply 201 `{ publication, project: await projectView(app, project) }`.
- `GET /publications`: return `listPublications`.

`routes/templates.ts`, in the publish route, before publishing: `if (await app.deps.workbench.getProject(id)) return reply.code(409).send({ error: \`publish ${id} from the Workbench (holdout gate)\` });`. Check `app.deps.workbench` exists in the templates route's deps; it is part of `AppDeps`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project api && npm run typecheck && npm run lint && npx prettier --check apps/api`. Check the typecheck **exit code**.
Expected: PASS. If an existing test published a Workbench type through the Templates route, it now gets 409. Change it to a type without a project, or publish through `/workbench/.../publish`, and note it as a deliberate behaviour change.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "API: publish gate on the holdout score, publication log and no Templates bypass"
```

---

### Task 5: Web: holdout on References and Evaluate, the Publish panel, holdout history

**Files:**
- Create: `apps/web/src/workbench/PublishPanel.tsx`
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/src/workbench/ReferencesTab.tsx`, `apps/web/src/workbench/EvaluateTab.tsx`, `apps/web/src/workbench/SamplesTab.tsx`
- Test: `apps/web/test/PublishPanel.test.tsx` (new), `apps/web/test/ReferencesTab.test.tsx`, `apps/web/test/EvaluateTab.test.tsx`, `apps/web/test/SamplesTab.test.tsx`, `apps/web/test/client.test.ts`

**Interfaces:**
- Produces:
  - Api:
    - `listReferenceRows(projectId, set?: EvaluationSet)`, which appends `?set=holdout` only for holdout
    - `startHoldoutReferenceRuns(projectId): Promise<JobSummary[]>`
    - `startEvaluation(projectId, model, options?: { uncached?: boolean; set?: EvaluationSet })`, which sends `set` only when it is `'holdout'`
    - `setPublishThreshold(projectId, threshold): Promise<ProjectView>`
    - `getPublishGate(projectId): Promise<GateView>`
    - `publish(projectId, overrideReason?: string): Promise<{ publication: Publication; project: ProjectView }>`
    - `listPublications(projectId): Promise<Publication[]>`
    - fake-api defaults: `listPublications` returns `[]`; `getPublishGate` returns a not-passing gate; the others throw "not stubbed". Builders `gateView(overrides?)` and `publication(overrides?)`.
  - ReferencesTab: a second table labelled "Holdout references", with a **Run the template on unverified holdout samples** button. Its note reads "Holdout samples are extracted by the template's own models; drafting never sees them."
  - EvaluateTab:
    - A select labelled "Set" with Dev (default) and Holdout, passed to `startEvaluation`.
    - History rows show "holdout" for holdout iterations.
    - Compare models is disabled when the set is Holdout.
    - Below everything, `<PublishPanel api projectId onPublished />`.
  - PublishPanel:
    - Shows the gate's `reason`, a threshold number input labelled "Publish threshold (%)" with a **Save threshold** button, a **Publish v{draft}** button, and (when the gate does not pass) a textarea labelled "Override reason" that must hold at least 10 characters before Publish is enabled.
    - After publishing it shows "Published v{n}" and calls `onPublished()`.
    - It lists recent publications, with each override reason.
  - SamplesTab: each holdout sample row shows `used in N holdout evaluations` when N > 0.

- [ ] **Step 1: Write the failing tests**

`PublishPanel.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PublishPanel } from '../src/workbench/PublishPanel.js';
import { fakeApi, gateView, projectView, publication } from './fake-api.js';

function panel(overrides = {}) {
  const api = fakeApi({ getProject: vi.fn(async () => projectView()), ...overrides });
  const onPublished = vi.fn();
  render(<PublishPanel api={api} projectId="letter" draft={2} onPublished={onPublished} />);
  return { api, onPublished };
}

describe('PublishPanel', () => {
  it('publishes directly when the gate passes', async () => {
    const { api, onPublished } = panel({
      getPublishGate: vi.fn(async () => gateView({ passes: true, reason: 'holdout score 95% meets the threshold 90%' })),
      publish: vi.fn(async () => ({ publication: publication({ version: 2 }), project: projectView() })),
    });
    expect(await screen.findByText('holdout score 95% meets the threshold 90%')).toBeInTheDocument();
    expect(screen.queryByLabelText('Override reason')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Publish v2' }));
    expect(api.publish).toHaveBeenCalledWith('letter', undefined);
    expect(await screen.findByText('Published v2')).toBeInTheDocument();
    expect(onPublished).toHaveBeenCalled();
  });

  it('needs an override reason below the threshold', async () => {
    const { api } = panel({
      getPublishGate: vi.fn(async () => gateView({ passes: false, reason: 'holdout score 80% is below the threshold 90%' })),
      publish: vi.fn(async () => ({ publication: publication(), project: projectView() })),
    });
    const button = await screen.findByRole('button', { name: 'Publish v2' });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Override reason'), 'Known bad scan in holdout');
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(api.publish).toHaveBeenCalledWith('letter', 'Known bad scan in holdout');
  });

  it('saves the threshold as a fraction', async () => {
    const { api } = panel({ setPublishThreshold: vi.fn(async () => projectView()) });
    const input = await screen.findByLabelText('Publish threshold (%)');
    await userEvent.clear(input);
    await userEvent.type(input, '80');
    await userEvent.click(screen.getByRole('button', { name: 'Save threshold' }));
    expect(api.setPublishThreshold).toHaveBeenCalledWith('letter', 0.8);
  });
});
```

Add these to the existing test files, following each file's existing style:
- **ReferencesTab:** the "Holdout references" table renders the rows from `listReferenceRows('letter', 'holdout')`, and the run button calls `startHoldoutReferenceRuns`.
- **EvaluateTab:** choosing Set = Holdout calls `startEvaluation('letter', null, { uncached: false, set: 'holdout' })`, and Compare models is disabled then.
- **SamplesTab:** a sample with `holdoutRuns: 2` shows "used in 2 holdout evaluations".
- **client:** the URLs and bodies for the new methods.

(The existing 4a/4b assertion `startEvaluation('letter', 'fast', { uncached: false })` becomes `{ uncached: false, set: 'dev' }` if the tab always passes the set. That is a deliberate change; note it.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/PublishPanel.test.tsx apps/web/test/ReferencesTab.test.tsx apps/web/test/EvaluateTab.test.tsx apps/web/test/SamplesTab.test.tsx apps/web/test/client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `client.ts` / `fake-api.ts`: the methods and builders. `publish` sends `overrideReason ? { overrideReason } : {}`. `setPublishThreshold` uses `PATCH`.
- `ReferencesTab.tsx`: load the holdout rows alongside the dev rows and render a second table with the same columns. The button follows the existing busy-guard pattern and calls `startHoldoutReferenceRuns`. Polling also covers active holdout runs.
- `EvaluateTab.tsx`:
  - `const [set, setSet] = useState<EvaluationSet>('dev')`, a labelled select, and pass `set` to `startEvaluation` options.
  - Disable Compare when `set === 'holdout'`.
  - History cell: `h.set === 'holdout' && ' · holdout'`, using the file's existing separator constant.
  - Render `<PublishPanel api={api} projectId={projectId} draft={draft} onPublished={onRestored} />` at the bottom. `EvaluateTab` needs a `draft: number | null` prop from `ProjectPage`, which already has it. Hide the panel when `draft` is null.
- `PublishPanel.tsx`:
  - Load `getPublishGate`, `listPublications` and `getProject` (for the threshold as a percentage).
  - The threshold input is `type="number"` with `min=0`, `max=100` and `step=1`. Save calls `setPublishThreshold(projectId, value / 100)` and reloads the gate.
  - The override textarea has `maxLength=1000` and is shown only when `!gate.passes`.
  - The Publish button is disabled while busy, or when `!gate.passes && overrideReason.trim().length < 10`.
  - Errors appear in `role="alert"`; "Published v{n}" appears in `role="status"`.
  - The publications list shows version, date, score as a percentage or "–", and "override: …" when there is an override.
- `SamplesTab.tsx`: add `{s.holdoutRuns > 0 && <small className="muted">used in {s.holdoutRuns} holdout evaluations</small>}` to the row.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project web && npm run typecheck && npm run lint && npx prettier --check apps/web`. Check the typecheck **exit code**. No U+FFFD in any file.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "Web: holdout references and evaluation, the publish panel and holdout history"
```

---

### Task 6: Docs, full check and smoke test

**Files:**
- Modify: `CLAUDE.md`, `docs/architecture.md`, `docs/design/workbench.md`

- [ ] **Step 1: Document it**

`CLAUDE.md`, Workbench bullet:
- Holdout reference runs use the template's own models with forced review, through `POST /holdout/reference-runs`.
- Evaluate takes `{ set }`. Holdout iterations are visible to the user but ignored by revise. Model comparison stays dev-only.
- `SampleView.holdoutRuns` gives each sample's holdout history.
- The publish gate is `publishGate` in `evaluation.ts`: the newest complete holdout iteration whose snapshot equals the open draft is compared against `publish_threshold` (default 0.9, migration 0016). Below the threshold, publishing needs an override reason of 10 characters or more.
- Publications are logged in `workbench_publications`.
- A Workbench document type cannot be published from the Templates route (409).

Contracts table: add `publishGate`, `GateView` and `Publication` to the evaluation row (TS only).

`docs/architecture.md`: one paragraph on holdout and the publish gate.

`docs/design/workbench.md`, Phasing:
- Phase 5 is split into **5a (done):** holdout evaluation, the publish gate and holdout history.
- **5b (next):** references across versions.

- [ ] **Step 2: Full check**

Run `npm run check` and `npm run format:check`, checking the exit codes. If `uv` is not on PATH, add its directory first.

- [ ] **Step 3: Smoke test (throwaway infra only)**

1. Apply migrations 0001–0016 through the opt-in `workbench-pg` test on a throwaway Postgres, then remove the container.
2. If a full stack is available:
   - Verify a holdout reference.
   - Run a holdout evaluation.
   - Check the gate. Publish directly or with an override, and check the publication log.
   - Confirm the Templates page refuses to publish this type.
3. No external LLM calls. Record what you couldn't run in the PR description.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs
git commit -m "Workbench: document phase 5a (holdout evaluation and the publish gate)"
```
