# Workbench 4a/6: References, Evaluation Runs and the Scorecard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the loop from a draft template to a score.
- The **references stage** runs the draft on each dev sample with the `draft` model. You verify each result in the existing Review screen and save it as a reference.
- **Evaluate** re-runs the draft against those references.
- An **iteration** records each evaluation: the template snapshot, the brief version and the model. Its **scorecard** shows accuracy per sample, per field and per table column, with a drill-down and a trend across iterations. Any iteration's template can be restored into the draft.

**Architecture:** Almost everything reuses machinery that already exists.
- **Reference runs** are ordinary workbench test runs (project jobs, so the data policy applies) with `modelOverride = 'draft'`. Verification is the existing Review screen's "Save as reference".
- **Matching samples to references.** A sample is matched to its reference by the PDF's **sha256**. Every test run copies the sample's document, so the sha is the stable link, and no schema change is needed for it.
- **Evaluation jobs** are workbench jobs that also carry `referenceId`, like regression jobs. They are compared with `compareToReference`, which gains per-column counts.
- **Iterations** are rows in `workbench_iterations` (migration `0013`) listing their job ids.
  - The scorecard is computed on read with one pure function, `buildScorecard`.
  - Once every job has finished, the summary score is cached on the row, so the trend never re-reads finished documents.
- **References stage state** comes from the samples and their references, through one pure function, `referencesStage`. The stage rail shows it after Steps.

**Tech Stack:** Fastify + Zod (API), React + Testing Library + Vitest (web), Postgres migration. No worker changes: evaluation and reference runs are ordinary `process` jobs.

**Spec:** [docs/design/workbench.md](../../design/workbench.md): "User journey" steps 8–9, "Evaluation" → "Scorecard", "Data model" → `workbench_iterations`, "API (sketch)" (`evaluate`, `iterations`, `revert`), "UI" (References, Evaluate, History). Also [ADR 0007](../../adr/0007-workbench.md).

**Depends on:** Workbench 3b ([kenhayward/ingestion-harness#48](https://github.com/kenhayward/ingestion-harness/pull/48)) merged. That PR adds migration `0012`, `stageStates` and `StageView`, and `GET /stages`. Branch from `main` after it lands.

**Phase 4 split** (each part is usable on its own):
- **4a (this plan):** the references stage, Evaluate on dev, the scorecard with drill-down and trend, iterations with restore.
- **4b:** the step cache and the model comparison view: the same iteration run on `default`, `fast` and `draft` side by side, plus "re-run uncached".
- **4c:** feedback on fields, steps and sections, and the `revise` drafting task.

In 4a, Evaluate already takes an optional model alias, so 4b's comparison view is only UI and caching.

## Global Constraints

- **Sample ↔ reference link** goes by the PDF sha256.
  - A dev sample is **verified** when the project's document type has a reference whose document has the sample's sha256. If several do, the newest wins.
  - Holdout samples are never used in 4a. Holdout evaluation comes in phase 5.
- **Reference runs:**
  - Started by `POST /api/workbench/projects/:id/stages/references`.
  - Need the open draft to be valid (400 with `issues`, as test runs do).
  - Only allowed once Survey, Outputs, Sections and Steps are all complete (accepted or skipped). Otherwise 409 `finish the <stage> stage first (accept or skip it)`.
  - One test run per ready **dev** sample that has no reference yet, with `modelOverride: 'draft'` and `params: { dataPolicy }`. If every dev sample is already verified: 409 `every dev sample already has a reference`.
- **References stage state:**
  - `accepted` once every ready dev sample is verified (`completedAt` = the newest of those references' `createdAt`), unless a later skip makes it `skipped`.
  - `stale` when an earlier stage completed after that time.
  - `running` while a reference run is queued or running.
  - `proposed` when runs or references exist but not all samples are verified.
  - `pending` otherwise.
  - `references` is also skippable through `POST /stages/references/skip`.
- **Evaluate:** `POST /api/workbench/projects/:id/evaluations` with body `{ model?: 'default' | 'fast' | 'draft' }` (strict).
  - Needs a valid open draft: 409 `no open draft; start the next version on the Template tab`, or 400 with `issues`.
  - Creates one workbench job per ready dev sample **that has a reference**, with `referenceId` set, `modelOverride = model ?? null` and `params: { dataPolicy }`. If there are none: 409 `no verified references for the dev samples; verify some on the References tab first`.
  - Records an iteration: `templateVersion` = the draft version, `definition` = a snapshot, `briefVersion`, `set: 'dev'`, `model` and `jobIds`.
- **Finished jobs** (terminal for scoring): `succeeded`, `awaiting_review`, `failed`, `needs_review`, `cancelled`, or a missing job.
  - A comparison exists only for `succeeded` / `awaiting_review` (the existing `regressionFinished`).
  - An iteration is `complete` when every job has finished. Its cached `scores` is `{ score, completed, total }`.
- **Scorecard:**
  - `score` is the mean of the per-sample `comparison.score` over compared samples, or null when none.
  - Field accuracy is matched / compared per field id.
  - Column accuracy is matched cells / considered cells per `table.column`.
  - Both lists are sorted worst first (accuracy ascending, then id).
- **Restore:** `POST /iterations/:iid/restore` writes the iteration's definition into the **open** draft, with id and version pinned. Without an open draft: 409 `no open draft; start the next version on the Template tab`. The web asks for confirmation first.
- **Migrations and process.** Migrations are forward-only: `db/migrations/0013_workbench_iterations.sql`. Zod at every boundary (request bodies). Never call real LLMs from tests. CI runs `npm run format:check`.

## Review Focus

1. **A dev sample with no reference.** Evaluate skips it, the scorecard shows nothing for it, and the overall score uses only the compared samples. If no sample has a reference, Evaluate gets 409. (Task 4 test.)
2. **An evaluation job that fails, goes to `needs_review` or is deleted.** That sample counts as finished with no comparison. The iteration still completes, and its score covers the rest. (Task 1 `buildScorecard` and Task 4 tests.)
3. **Restoring an iteration after the draft has moved on.** The open draft becomes exactly the snapshot, with id and version pinned to the open draft. Without an open draft: 409. (Task 4 test.)
4. **A local-only project.** Reference and evaluation runs carry `params.dataPolicy`, so the worker refuses an external `draft` / `fast` model for them as it does for test runs. (Task 3 and Task 4 tests assert the params.)
5. **A table whose rows come back in another order or with one wrong cell.** Column accuracy charges only that column. (Task 1 `compareToReference` column test.)

---

## File map

| File | Responsibility |
| --- | --- |
| `db/migrations/0013_workbench_iterations.sql` (new) | `workbench_iterations` |
| `packages/shared/src/evaluation.ts` (new) | Comparison types (moved from the API), `TableComparison.columns`, `Accuracy`, `SampleResult`, `Scorecard`, `buildScorecard`, `finishedJob`, `IterationSummary` / `IterationView`, `ReferenceRow`, `EVALUATION_MODELS` |
| `packages/shared/src/drafting.ts` | `referencesStage`, `firstIncomplete` |
| `apps/api/src/regression/compare.ts` | Per-column counts; imports the types from shared |
| `apps/api/src/repositories/{types,memory,pg}.ts` | `WorkbenchJobOptions.referenceId` / `modelOverride`; `listProjectRuns`; `listReferencesWithSha` |
| `apps/api/src/workbench/repo.ts` | Iterations |
| `apps/api/src/routes/workbench.ts` | References rows, reference runs, references stage state, evaluations, iterations, restore |
| `apps/web/src/api/client.ts`, `test/fake-api.ts` | Client methods and builders |
| `apps/web/src/workbench/ReferencesTab.tsx`, `EvaluateTab.tsx` (new) | The two tabs |
| `apps/web/src/workbench/ProjectPage.tsx`, `router.ts` | Wiring and tabs |
| `CLAUDE.md`, `docs/architecture.md`, `docs/design/workbench.md` | Document it |

---

### Task 1: Shared evaluation contracts, column counts, scorecard, references stage, migration

**Files:**
- Create: `packages/shared/src/evaluation.ts`, `packages/shared/test/evaluation.test.ts`, `db/migrations/0013_workbench_iterations.sql`
- Modify: `packages/shared/src/index.ts`, `packages/shared/src/drafting.ts`, `packages/shared/test/drafting.test.ts`, `apps/api/src/regression/compare.ts`, `apps/api/test/compare.test.ts` (or wherever `compareToReference` is tested; find it with grep)

**Interfaces:**
- Produces (`@ih/shared`):
  - `FieldComparison`, `TableComparison`, `Comparison`: moved verbatim from `apps/api/src/regression/compare.ts`. `TableComparison` gains `columns: Record<string, { matched: number; total: number }>`.
  - `EVALUATION_MODELS = ['default', 'fast', 'draft'] as const`, `type EvaluationModel`
  - `finishedJob(status: JobStatus | null): boolean`. It is true for a missing job or one of `succeeded | awaiting_review | failed | needs_review | cancelled`.
  - `interface Accuracy { id: string; matched: number; total: number; accuracy: number }`
  - `interface SampleResult { sampleId: string | null; filename: string; jobId: string | null; status: JobStatus | null; error: string | null; comparison: Comparison | null }`
  - `interface Scorecard { score: number | null; completed: number; total: number; fields: Accuracy[]; columns: Accuracy[] }`
  - `buildScorecard(samples: SampleResult[]): Scorecard`
  - `interface IterationSummary`, which has these fields:
    - `id: string; projectId: string; templateVersion: number; briefVersion: number | null`
    - `set: 'dev'; model: EvaluationModel | null; createdAt: string`
    - `status: 'running' | 'complete'; score: number | null; completed: number; total: number`
  - `interface IterationView extends IterationSummary { scorecard: Scorecard; samples: SampleResult[] }`
  - `interface ReferenceRow`, which has these fields:
    - `sampleId: string; filename: string; sha256: string`
    - `reference: { id: string; name: string; createdAt: string } | null`
    - `run: { jobId: string; status: JobStatus; error: string | null; modelOverride: string | null } | null`
  - `drafting.ts`:
    - `firstIncomplete(states: StageView[]): DraftStage | null`, the first stage in `STAGE_ORDER` with `completedAt === null`
    - `referencesStage(earlier: StageView[], input: { devSamples: number; verified: number; lastVerifiedAt: string | null; running: boolean; hasRuns: boolean; skippedAt: string | null }): StageView`
- Produces (API): `compareToReference` fills `TableComparison.columns`.

- [ ] **Step 1: Write the failing tests**

`packages/shared/test/evaluation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { buildScorecard, finishedJob, type Comparison, type SampleResult } from '../src/index.js';

const comparison = (
  score: number,
  fields: [string, boolean][],
  columns: Record<string, { matched: number; total: number }> = {},
): Comparison => ({
  score,
  fields: fields.map(([id, match]) => ({ id, expected: 'e', actual: match ? 'e' : 'x', match })),
  tables: Object.keys(columns).length
    ? [{ id: 'items', expected: 1, actual: 1, matched: 0, missing: [], extra: [], changed: [], cells: 0, cellsTotal: 0, columns }]
    : [],
});

const sample = (over: Partial<SampleResult>): SampleResult => ({
  sampleId: 's',
  filename: 'a.pdf',
  jobId: 'j',
  status: 'succeeded',
  error: null,
  comparison: null,
  ...over,
});

describe('finishedJob', () => {
  it.each([
    ['succeeded', true],
    ['awaiting_review', true],
    ['failed', true],
    ['needs_review', true],
    ['cancelled', true],
    ['queued', false],
    ['running', false],
  ] as const)('%s → %s', (status, finished) => {
    expect(finishedJob(status)).toBe(finished);
  });

  it('treats a missing job as finished', () => {
    expect(finishedJob(null)).toBe(true);
  });
});

describe('buildScorecard', () => {
  it('averages compared samples and ranks fields and columns worst first', () => {
    const card = buildScorecard([
      sample({ comparison: comparison(1, [['date', true], ['ref', true]], { name: { matched: 2, total: 2 } }) }),
      sample({ sampleId: 't', comparison: comparison(0.5, [['date', false], ['ref', true]], { name: { matched: 1, total: 2 } }) }),
      sample({ sampleId: 'u', status: 'failed', error: 'boom' }),
    ]);
    expect(card.score).toBe(0.75);
    expect(card).toMatchObject({ completed: 2, total: 3 });
    expect(card.fields).toEqual([
      { id: 'date', matched: 1, total: 2, accuracy: 0.5 },
      { id: 'ref', matched: 2, total: 2, accuracy: 1 },
    ]);
    expect(card.columns).toEqual([{ id: 'items.name', matched: 3, total: 4, accuracy: 0.75 }]);
  });

  it('has no score when nothing was compared', () => {
    expect(buildScorecard([sample({ status: 'running' })])).toMatchObject({
      score: null,
      completed: 0,
      total: 1,
      fields: [],
      columns: [],
    });
  });
});
```

Append to `packages/shared/test/drafting.test.ts`:

```ts
import { firstIncomplete, referencesStage, type StageView } from '../src/index.js';

describe('references stage', () => {
  const done = (stage: StageView['stage'], at: string): StageView => ({ stage, state: 'accepted', completedAt: at });
  const earlier = [
    done('survey', '2026-10-12T10:00:01.000Z'),
    done('outputs', '2026-10-12T10:00:02.000Z'),
    done('sections', '2026-10-12T10:00:03.000Z'),
    done('steps', '2026-10-12T10:00:04.000Z'),
  ];
  const base = { devSamples: 2, verified: 0, lastVerifiedAt: null, running: false, hasRuns: false, skippedAt: null };

  it('needs every earlier stage complete', () => {
    expect(firstIncomplete(earlier)).toBeNull();
    expect(firstIncomplete([...earlier.slice(0, 3), { stage: 'steps', state: 'pending', completedAt: null }])).toBe('steps');
  });

  it('is accepted when every dev sample is verified, and stale after a later earlier-stage change', () => {
    expect(referencesStage(earlier, base)).toEqual({ stage: 'references', state: 'pending', completedAt: null });
    expect(referencesStage(earlier, { ...base, hasRuns: true, running: true }).state).toBe('running');
    expect(referencesStage(earlier, { ...base, hasRuns: true, verified: 1, lastVerifiedAt: '2026-10-12T10:00:05.000Z' }).state).toBe('proposed');
    const complete = { ...base, verified: 2, lastVerifiedAt: '2026-10-12T10:00:05.000Z' };
    expect(referencesStage(earlier, complete)).toEqual({
      stage: 'references',
      state: 'accepted',
      completedAt: '2026-10-12T10:00:05.000Z',
    });
    const changedLater = [...earlier.slice(0, 3), done('steps', '2026-10-12T10:00:09.000Z')];
    expect(referencesStage(changedLater, complete).state).toBe('stale');
  });

  it('can be skipped', () => {
    expect(referencesStage(earlier, { ...base, skippedAt: '2026-10-12T10:00:06.000Z' })).toEqual({
      stage: 'references',
      state: 'skipped',
      completedAt: '2026-10-12T10:00:06.000Z',
    });
  });
});
```

Add to the existing `compareToReference` test file (find it with `grep -rl compareToReference apps/api/test`):

```ts
  it('counts table cells per column, so one wrong cell charges one column', () => {
    const expected = {
      fields: {},
      tables: { items: [{ name: 'Bolt', qty: '2' }, { name: 'Nut', qty: '5' }] },
    };
    const actual = {
      fields: {},
      tables: { items: [{ name: 'Nut', qty: '5' }, { name: 'Bolt', qty: '3' }] },
    };
    const [table] = compareToReference(expected, actual).tables;
    expect(table!.columns).toEqual({ name: { matched: 2, total: 2 }, qty: { matched: 1, total: 2 } });
  });

  it('charges every column of missing and extra rows', () => {
    const [table] = compareToReference(
      { fields: {}, tables: { items: [{ name: 'Bolt', qty: '2' }] } },
      { fields: {}, tables: { items: [{ name: 'Washer', qty: '9' }] } },
    ).tables;
    expect(table!.columns).toEqual({ name: { matched: 0, total: 2 }, qty: { matched: 0, total: 2 } });
  });
```

(In the second case the rows share no cell, so the expected row is *missing* and the actual row is *extra*. Each column is then considered twice and matched zero times.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run packages/shared apps/api/test/<compare test file>`
Expected: FAIL. `buildScorecard` is not exported, and `columns` is undefined.

- [ ] **Step 3: Write the migration**

`db/migrations/0013_workbench_iterations.sql`:

```sql
-- Workbench phase 4a (ADR 0007): one row per evaluation run of the draft. The scorecard is
-- computed from the jobs; `scores` caches the summary once every job has finished.

CREATE TABLE workbench_iterations (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id        text        NOT NULL REFERENCES workbench_projects (id),
  template_version  integer     NOT NULL,
  definition        jsonb       NOT NULL,
  brief_version     integer,
  eval_set          text        NOT NULL DEFAULT 'dev' CHECK (eval_set IN ('dev', 'holdout')),
  model             text,
  job_ids           uuid[]      NOT NULL,
  scores            jsonb,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX workbench_iterations_project_idx ON workbench_iterations (project_id, created_at DESC);
```

- [ ] **Step 4: Implement**

`packages/shared/src/evaluation.ts`:

```ts
import type { JobStatus } from './jobs.js';

/** Workbench evaluation (ADR 0007, phase 4a): comparisons, scorecards, iterations. */

export interface FieldComparison {
  id: string;
  expected: unknown;
  actual: unknown;
  match: boolean;
}

export interface TableComparison {
  id: string;
  expected: number;
  actual: number;
  /** Rows identical to their expected counterpart. */
  matched: number;
  /** Expected rows with no counterpart sharing any cell. */
  missing: Record<string, unknown>[];
  /** Actual rows not aligned to any expected row. */
  extra: Record<string, unknown>[];
  /** Aligned rows that differ, with the differing columns. */
  changed: {
    expected: Record<string, unknown>;
    actual: Record<string, unknown>;
    columns: string[];
  }[];
  /** Equal cells / all cells considered (aligned rows, missing rows, extra rows). */
  cells: number;
  cellsTotal: number;
  /** The same cell counts per column. */
  columns: Record<string, { matched: number; total: number }>;
}

export interface Comparison {
  /** (matched fields + equal cells) / (fields + all cells considered); 1 = identical. */
  score: number;
  fields: FieldComparison[];
  tables: TableComparison[];
}

export const EVALUATION_MODELS = ['default', 'fast', 'draft'] as const;
export type EvaluationModel = (typeof EVALUATION_MODELS)[number];

const FINISHED: readonly JobStatus[] = ['succeeded', 'awaiting_review', 'failed', 'needs_review', 'cancelled'];
/** A job that will not change its result any more (a missing job counts as finished). */
export const finishedJob = (status: JobStatus | null): boolean =>
  status === null || FINISHED.includes(status);

export interface Accuracy {
  id: string;
  matched: number;
  total: number;
  accuracy: number;
}

export interface SampleResult {
  sampleId: string | null;
  filename: string;
  jobId: string | null;
  status: JobStatus | null;
  error: string | null;
  comparison: Comparison | null;
}

export interface Scorecard {
  /** Mean per-sample score over compared samples; null when none was compared. */
  score: number | null;
  completed: number;
  total: number;
  /** Worst first. */
  fields: Accuracy[];
  /** `table.column`, worst first. */
  columns: Accuracy[];
}

function ranked(counts: Map<string, { matched: number; total: number }>): Accuracy[] {
  return [...counts.entries()]
    .filter(([, c]) => c.total > 0)
    .map(([id, c]) => ({ id, matched: c.matched, total: c.total, accuracy: c.matched / c.total }))
    .sort((a, b) => a.accuracy - b.accuracy || a.id.localeCompare(b.id));
}

export function buildScorecard(samples: SampleResult[]): Scorecard {
  const compared = samples.flatMap((s) => (s.comparison ? [s.comparison] : []));
  const fields = new Map<string, { matched: number; total: number }>();
  const columns = new Map<string, { matched: number; total: number }>();
  for (const c of compared) {
    for (const f of c.fields) {
      const n = fields.get(f.id) ?? { matched: 0, total: 0 };
      fields.set(f.id, { matched: n.matched + (f.match ? 1 : 0), total: n.total + 1 });
    }
    for (const t of c.tables) {
      for (const [column, counts] of Object.entries(t.columns)) {
        const id = `${t.id}.${column}`;
        const n = columns.get(id) ?? { matched: 0, total: 0 };
        columns.set(id, { matched: n.matched + counts.matched, total: n.total + counts.total });
      }
    }
  }
  return {
    score: compared.length ? compared.reduce((sum, c) => sum + c.score, 0) / compared.length : null,
    completed: compared.length,
    total: samples.length,
    fields: ranked(fields),
    columns: ranked(columns),
  };
}

export interface IterationSummary {
  id: string;
  projectId: string;
  templateVersion: number;
  briefVersion: number | null;
  set: 'dev';
  /** Alias every step was overridden with; null = the template's own models. */
  model: EvaluationModel | null;
  createdAt: string;
  status: 'running' | 'complete';
  score: number | null;
  completed: number;
  total: number;
}

export interface IterationView extends IterationSummary {
  scorecard: Scorecard;
  samples: SampleResult[];
}

/** One dev sample on the References tab. */
export interface ReferenceRow {
  sampleId: string;
  filename: string;
  sha256: string;
  reference: { id: string; name: string; createdAt: string } | null;
  /** Latest test run of this sample that is not an evaluation run. */
  run: { jobId: string; status: JobStatus; error: string | null; modelOverride: string | null } | null;
}
```

In `packages/shared/src/index.ts`, add `export * from './evaluation.js';`.

In `packages/shared/src/drafting.ts`, append:

```ts
/** The first proposal stage that is neither accepted nor skipped (references needs all four). */
export function firstIncomplete(states: StageView[]): DraftStage | null {
  return STAGE_ORDER.find((stage) => !states.find((s) => s.stage === stage)?.completedAt) ?? null;
}

/**
 * The references stage (phase 4a) is complete once every ready dev sample has a verified
 * reference; it is derived from samples and references, not from proposals.
 */
export function referencesStage(
  earlier: StageView[],
  input: {
    devSamples: number;
    verified: number;
    lastVerifiedAt: string | null;
    running: boolean;
    hasRuns: boolean;
    skippedAt: string | null;
  },
): StageView {
  const verifiedAt =
    input.devSamples > 0 && input.verified >= input.devSamples ? input.lastVerifiedAt : null;
  const skipped = input.skippedAt !== null && (verifiedAt === null || input.skippedAt > verifiedAt);
  const completedAt = skipped ? input.skippedAt : verifiedAt;
  const stale =
    completedAt !== null && earlier.some((s) => s.completedAt !== null && s.completedAt > completedAt);
  const state: StageState = input.running
    ? 'running'
    : completedAt !== null
      ? stale
        ? 'stale'
        : skipped
          ? 'skipped'
          : 'accepted'
      : input.hasRuns || input.verified > 0
        ? 'proposed'
        : 'pending';
  return { stage: 'references', state, completedAt };
}
```

`apps/api/src/regression/compare.ts`:
- Replace the three local interfaces with `import type { Comparison, FieldComparison, TableComparison } from '@ih/shared';` and `export type { Comparison, FieldComparison, TableComparison };`, so existing importers keep working.
- In `compareToReference`, initialise `columns: {}` in the result.
- Add a helper `const count = (column: string, equal: boolean) => { const c = result.columns[column] ?? { matched: 0, total: 0 }; result.columns[column] = { matched: c.matched + (equal ? 1 : 0), total: c.total + 1 }; };` inside the table loop.
- Call it for every column of an aligned row (`equal = !differing.includes(column)`), and with `false` for every key of a missing row and of an extra row.

- [ ] **Step 5: Run tests, fix fallout**

Run: `npx vitest run packages/shared apps/api && npm run typecheck`
Expected: PASS. Any `TableComparison` literal in tests or fakes needs `columns: {}`.

- [ ] **Step 6: Commit**

```bash
git add db/migrations/0013_workbench_iterations.sql packages/shared apps/api
git commit -m "Workbench: evaluation contracts, per-column comparison counts, scorecard and references stage"
```

---

### Task 2: API repos: iterations, job options, runs and references by sha

**Files:**
- Modify: `apps/api/src/repositories/{types,memory,pg}.ts`, `apps/api/src/workbench/repo.ts`, `apps/api/test/integration/workbench-pg.test.ts`
- Test: `apps/api/test/workbench-evaluation-repo.test.ts` (new)

**Interfaces:**
- Consumes: migration 0013; `EvaluationModel` (Task 1).
- Produces:
  - `WorkbenchJobOptions` gains `referenceId?: string | null` and `modelOverride?: string | null`. Both default to null, and both are stored on the job: `jobs.reference_id` and `jobs.model_override`.
  - `IngestionRepo.listProjectRuns(projectId: string): Promise<{ job: JobSummary; sha256: string }[]>`. These are the project's `process` jobs, newest first, each with its document's sha256.
  - `IngestionRepo.listReferencesWithSha(templateId: string): Promise<(Reference & { sha256: string })[]>`, newest first.
  - `interface IterationRecord`, which has these fields:
    - `id: string; projectId: string; templateVersion: number`
    - `definition: Record<string, unknown>; briefVersion: number | null`
    - `set: 'dev'; model: EvaluationModel | null; jobIds: string[]`
    - `scores: { score: number | null; completed: number; total: number } | null; createdAt: string`
  - `WorkbenchRepo` gains:
    - `createIteration(input: Omit<IterationRecord, 'id' | 'scores' | 'createdAt'>): Promise<IterationRecord>`
    - `listIterations(projectId): Promise<IterationRecord[]>`, newest first
    - `getIteration(projectId, id): Promise<IterationRecord | null>`
    - `setIterationScores(id, scores): Promise<void>`

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-evaluation-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { testApp } from './helpers.js';

const doc = (id: string, sha256: string) => ({
  id,
  filename: `${id}.pdf`,
  sha256,
  sizeBytes: 1,
  specId: 'letter',
  specVersion: 1,
  bucket: 'inbox',
  objectKey: `k/${id}`,
});

async function setup() {
  const ctx = await testApp();
  await ctx.workbench.createProject('letter', 'Letter');
  return ctx;
}

describe('evaluation persistence', () => {
  it('stores reference and model override on workbench jobs and lists runs with their sha', async () => {
    const { repo } = await setup();
    const plain = await repo.createWorkbenchJob(doc('d1', 'sha-a'), { projectId: 'letter', task: 'process' });
    const evaluation = await repo.createWorkbenchJob(doc('d2', 'sha-a'), {
      projectId: 'letter',
      task: 'process',
      referenceId: '00000000-0000-4000-8000-000000000001',
      modelOverride: 'draft',
    });
    expect(plain).toMatchObject({ referenceId: null, modelOverride: null });
    expect(evaluation).toMatchObject({
      referenceId: '00000000-0000-4000-8000-000000000001',
      modelOverride: 'draft',
    });
    const runs = await repo.listProjectRuns('letter');
    expect(runs.map((r) => [r.job.id, r.sha256])).toEqual([
      [evaluation.id, 'sha-a'],
      [plain.id, 'sha-a'],
    ]);
  });

  it('lists references with the sha of their document', async () => {
    const { repo } = await setup();
    const job = await repo.createWorkbenchJob(doc('d1', 'sha-b'), { projectId: 'letter', task: 'process' });
    await repo.createReference({
      templateId: 'letter',
      name: 'first',
      documentId: job.documentId,
      sourceJobId: job.id,
      expected: { fields: {}, tables: {} },
    });
    expect((await repo.listReferencesWithSha('letter')).map((r) => [r.name, r.sha256])).toEqual([
      ['first', 'sha-b'],
    ]);
  });

  it('records iterations and caches their scores', async () => {
    const { workbench } = await setup();
    const a = await workbench.createIteration({
      projectId: 'letter',
      templateVersion: 1,
      definition: { id: 'letter', version: 1 },
      briefVersion: 2,
      set: 'dev',
      model: null,
      jobIds: ['00000000-0000-4000-8000-000000000002'],
    });
    const b = await workbench.createIteration({ ...a, model: 'fast', jobIds: [] });
    expect((await workbench.listIterations('letter')).map((i) => i.id)).toEqual([b.id, a.id]);
    await workbench.setIterationScores(a.id, { score: 0.5, completed: 1, total: 1 });
    expect(await workbench.getIteration('letter', a.id)).toMatchObject({
      scores: { score: 0.5, completed: 1, total: 1 },
      definition: { id: 'letter', version: 1 },
    });
    expect(await workbench.getIteration('other', a.id)).toBeNull();
  });
});
```

(`createIteration({ ...a, ... })` spreads extra keys such as `id`, `scores` and `createdAt`. If TypeScript objects, build the second input explicitly. Check the `MemoryRepo.createReference` and `createDocumentAndJob` signatures and adapt the helpers to them. Keep the assertions.)

Extend the opt-in Pg integration test with the same three behaviours.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-evaluation-repo.test.ts`
Expected: FAIL. `repo.listProjectRuns` is not a function.

- [ ] **Step 3: Implement**

- `types.ts`: the new options, with doc comments ("evaluation run: the reference it is scored against" and "every step runs on this alias, e.g. `draft` for reference runs"), plus the two port methods.
- `MemoryRepo`:
  - `createWorkbenchJob` passes `modelOverride ?? null` and `referenceId ?? null` through to `createDocumentAndJob`. Use its existing parameters, or `update` the job after creation.
  - `listProjectRuns`: the project's jobs with `task === 'process'`, newest first by insertion order, each with `this.documents.get(job.documentId)!.sha256`.
  - `listReferencesWithSha`: `listReferences` plus the document's sha256, newest first.
- `PgRepo`:
  - `createWorkbenchJob` passes `modelOverride ?? null` and `referenceId ?? null` into `insertDocumentAndJob`.
  - `listProjectRuns`: `${JOB_SELECT} WHERE j.project_id = $1 AND j.task = 'process' ORDER BY j.created_at DESC`. If `JOB_SELECT` does not select `d.sha256`, add a separate query `SELECT j.id, d.sha256 FROM jobs j JOIN documents d ON d.id = j.document_id WHERE j.project_id = $1 AND j.task = 'process'` and join the results in code.
  - `listReferencesWithSha`: `SELECT r.*, d.sha256 FROM template_references r JOIN documents d ON d.id = r.document_id WHERE r.template_id = $1 ORDER BY r.created_at DESC`.
- `workbench/repo.ts`:
  - Memory keeps `iterations: IterationRecord[]`. `createIteration` stamps `id: randomUUID()`, `scores: null` and `createdAt` from the monotonic clock (`this.now()` from 3b). `listIterations` returns newest first. `getIteration` checks the project. `setIterationScores` replaces the record.
  - Pg:

```ts
  async createIteration(i: Omit<IterationRecord, 'id' | 'scores' | 'createdAt'>) {
    const { rows } = await this.pool.query<IterationRow>(
      `INSERT INTO workbench_iterations
         (project_id, template_version, definition, brief_version, eval_set, model, job_ids)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [i.projectId, i.templateVersion, JSON.stringify(i.definition), i.briefVersion, i.set, i.model, i.jobIds],
    );
    return toIteration(rows[0]!);
  }
```

The other three methods follow the same pattern. `listIterations` uses `ORDER BY created_at DESC, id DESC`. `getIteration` uses `WHERE project_id = $1 AND id = $2`. `setIterationScores` is `UPDATE workbench_iterations SET scores = $2 WHERE id = $1`. `IterationRow` and `toIteration` map snake_case to the record (`eval_set` → `set`, `job_ids` → `jobIds`, `created_at.toISOString()`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project api && npm run typecheck && npm run lint && npx prettier --check apps/api`
Expected: PASS. If Docker is available, also run the opt-in `workbench-pg` test against a **throwaway** container (see `CLAUDE.md`) and record the result.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "API: iterations, reference/model options on workbench jobs, runs and references by sha"
```

---

### Task 3: API: the references stage

**Files:**
- Modify: `apps/api/src/routes/workbench.ts`
- Test: `apps/api/test/workbench-references.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 1–2; `stagesOf`, `sampleViews`, `versionsOf`, `validateTemplate` (existing).
- Produces:
  - `GET /api/workbench/projects/:id/references` returns `ReferenceRow[]`, one per ready **dev** sample, oldest first. `reference` is the newest reference whose sha matches. `run` is the newest `process` job of that sha with `referenceId === null`.
  - `POST /api/workbench/projects/:id/stages/references` returns 201 `{ jobs: JobSummary[] }` and follows the Global Constraints.
  - `GET /stages` appends the references `StageView`.
  - `POST /stages/references/skip` is allowed.

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-references.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { preparedTriageKey, type ReferenceRow, type SampleView, type StageView } from '@ih/shared';
import { letter, multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);

async function project() {
  const ctx = await testApp();
  await ctx.app.inject({ method: 'POST', url: '/api/workbench/projects', payload: { id: 'letter', name: 'Letter' } });
  await ctx.templates.updateDraft('letter', 1, letter(1));
  const add = async (n: number, role = 'dev') => {
    const s = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/samples',
        ...multipart({ role }, { filename: `s${n}.pdf`, content: pdf(n) }),
      })
    ).json() as SampleView;
    const prep = ctx.repo.jobs.get(s.prepareJobId!)!;
    ctx.repo.jobs.set(prep.id, { ...prep, status: 'succeeded' });
    const triage = { sha256: s.sha256, pageCount: 1, ocrPages: [], chars: 5, ocrModel: null };
    await ctx.store.put('runs', preparedTriageKey(s.sha256), Buffer.from(JSON.stringify(triage)), 'application/json');
    return s;
  };
  const skipAll = async () => {
    for (const stage of ['survey', 'outputs', 'sections', 'steps']) {
      await ctx.app.inject({ method: 'POST', url: `/api/workbench/projects/letter/stages/${stage}/skip` });
    }
  };
  const propose = () => ctx.app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/references' });
  const rows = async () => (await ctx.app.inject('/api/workbench/projects/letter/references')).json() as ReferenceRow[];
  const stage = async () =>
    ((await ctx.app.inject('/api/workbench/projects/letter/stages')).json() as StageView[]).find(
      (s) => s.stage === 'references',
    );
  return { ...ctx, add, skipAll, propose, rows, stage };
}

describe('references stage', () => {
  it('waits for the earlier stages', async () => {
    const { add, propose } = await project();
    await add(1);
    const res = await propose();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('finish the survey stage first (accept or skip it)');
  });

  it('runs the draft model on dev samples without a reference, carrying the data policy', async () => {
    const { add, skipAll, propose, repo, rows, stage } = await project();
    const dev = await add(1);
    await add(2, 'holdout');
    await skipAll();
    expect((await stage())!.state).toBe('pending');
    const res = await propose();
    expect(res.statusCode).toBe(201);
    const [job] = res.json().jobs as { id: string; modelOverride: string; referenceId: string | null }[];
    expect(job).toMatchObject({ modelOverride: 'draft', referenceId: null });
    expect(repo.jobParams.get(job!.id)).toEqual({ dataPolicy: 'local' });
    expect((await stage())!.state).toBe('running');
    expect(await rows()).toEqual([
      {
        sampleId: dev.id,
        filename: 's1.pdf',
        sha256: dev.sha256,
        reference: null,
        run: { jobId: job!.id, status: 'queued', error: null, modelOverride: 'draft' },
      },
    ]);
  });

  it('is accepted once every dev sample has a reference, and refuses to propose again', async () => {
    const { add, skipAll, propose, repo, rows, stage } = await project();
    await add(1);
    await skipAll();
    const [job] = (await propose()).json().jobs as { id: string; documentId: string }[];
    repo.jobs.set(job!.id, { ...repo.jobs.get(job!.id)!, status: 'succeeded' });
    await repo.createReference({
      templateId: 'letter',
      name: 's1',
      documentId: job!.documentId,
      sourceJobId: job!.id,
      expected: { fields: { sender: 'Acme' }, tables: {} },
    });
    expect((await rows())[0]!.reference).toMatchObject({ name: 's1' });
    expect((await stage())!.state).toBe('accepted');
    const again = await propose();
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('every dev sample already has a reference');
  });

  it('can be skipped', async () => {
    const { app, add, skipAll, stage } = await project();
    await add(1);
    await skipAll();
    const res = await app.inject({ method: 'POST', url: '/api/workbench/projects/letter/stages/references/skip' });
    expect(res.statusCode).toBe(201);
    expect((await stage())!.state).toBe('skipped');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-references.test.ts`
Expected: FAIL. `GET /references` returns 404, and `stages/references` returns 400.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/workbench.ts`, add the module helper:

```ts
/** Ready dev samples with their newest reference (by PDF sha256) and newest non-evaluation run. */
async function referenceRows(app: FastifyInstance, projectId: string): Promise<ReferenceRow[]> {
  const samples = (await sampleViews(app, projectId))
    .filter((s) => s.view.role === 'dev' && s.view.state === 'ready')
    .map((s) => s.record)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const references = await app.deps.repo.listReferencesWithSha(projectId);
  const runs = (await app.deps.repo.listProjectRuns(projectId)).filter((r) => r.job.referenceId === null);
  return samples.map((s) => {
    const reference = references.find((r) => r.sha256 === s.sha256) ?? null;
    const run = runs.find((r) => r.sha256 === s.sha256)?.job ?? null;
    return {
      sampleId: s.id,
      filename: s.filename,
      sha256: s.sha256,
      reference: reference && { id: reference.id, name: reference.name, createdAt: reference.createdAt },
      run: run && { jobId: run.id, status: run.status, error: run.error, modelOverride: run.modelOverride },
    };
  });
}

async function referencesView(app: FastifyInstance, projectId: string, earlier: StageView[]) {
  const rows = await referenceRows(app, projectId);
  const verified = rows.filter((r) => r.reference !== null);
  const skips = await app.deps.workbench.listSkips(projectId);
  return referencesStage(earlier, {
    devSamples: rows.length,
    verified: verified.length,
    lastVerifiedAt: verified.map((r) => r.reference!.createdAt).sort().at(-1) ?? null,
    running: rows.some((r) => r.run !== null && (r.run.status === 'queued' || r.run.status === 'running')),
    hasRuns: rows.some((r) => r.run !== null),
    skippedAt: skips.find((s) => s.stage === 'references')?.skippedAt ?? null,
  });
}
```

Routes:
- `GET /workbench/projects/:id/stages`: `const earlier = await stagesOf(app, id); return [...earlier, await referencesView(app, id, earlier)];`
- `GET /workbench/projects/:id/references`: 404 for an unknown project, otherwise `referenceRows`.
- In `POST /stages/:stage`, before the `AVAILABLE_STAGES` check, handle `references` (in a small helper) with `const projectId = req.params.id;`:
  1. 404 for an unknown project.
  2. `const blocking = firstIncomplete(await stagesOf(app, projectId))`, then 409 `finish the ${blocking} stage first (accept or skip it)`.
  3. Without an open draft, 409 `no open draft; start the next version on the Template tab`.
  4. `validateTemplate(draftRecord.definition)`; if there are issues, 400 `{ error: 'the draft is not valid', issues }`.
  5. `const todo = (await referenceRows(app, projectId)).filter((r) => r.reference === null)`. If it is empty, 409 `every dev sample already has a reference`.
  6. For each row, create a job exactly as the 3a test-run route does, from the sample record (look it up by `sampleId` in `sampleViews`), with options `{ projectId, task: 'process', params: { dataPolicy: project.dataPolicy }, modelOverride: 'draft' }`.
  7. Reply `201 { jobs }`.
- Skip route: allow `references` as well as `AVAILABLE_STAGES`. For `references`, the order check is `firstIncomplete(await stagesOf(...))`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project api && npm run typecheck && npm run lint && npx prettier --check apps/api`
Expected: PASS, including the 3b stage tests: their `GET /stages` expectations now have a fifth entry, `references:pending`. Update those expected arrays by appending `'references:pending'`. That's a deliberate contract change; say so in the report.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "API: references stage (draft-model runs on dev samples, verified by sha, stage state)"
```

---

### Task 4: API: evaluations, iterations and restore

**Files:**
- Modify: `apps/api/src/routes/workbench.ts`
- Test: `apps/api/test/workbench-evaluation.test.ts` (new)

**Interfaces:**
- Consumes: Tasks 1–3; `jobDocument`, `regressionFinished` (`regression/report.ts`), `compareToReference`, `pinned`.
- Produces:
  - `POST /api/workbench/projects/:id/evaluations` with `{ model? }` returns 201 `IterationView`.
  - `GET /api/workbench/projects/:id/iterations` returns `IterationSummary[]`, newest first.
  - `GET /api/workbench/projects/:id/iterations/:iid` returns `IterationView`. It is 404 for an unknown or malformed id.
  - `POST /api/workbench/projects/:id/iterations/:iid/restore` returns the `ProjectView`, after writing the snapshot into the open draft.

- [ ] **Step 1: Write the failing test**

`apps/api/test/workbench-evaluation.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  outputKey,
  preparedTriageKey,
  type IterationSummary,
  type IterationView,
  type SampleView,
} from '@ih/shared';
import { letter, multipart, testApp } from './helpers.js';

const pdf = (n: number) => Buffer.from(`%PDF-1.7\n% sample ${n}\n%%EOF\n`);

async function project() {
  const ctx = await testApp();
  await ctx.app.inject({ method: 'POST', url: '/api/workbench/projects', payload: { id: 'letter', name: 'Letter' } });
  await ctx.templates.updateDraft('letter', 1, letter(1));
  const add = async (n: number) => {
    const s = (
      await ctx.app.inject({
        method: 'POST',
        url: '/api/workbench/projects/letter/samples',
        ...multipart({ role: 'dev' }, { filename: `s${n}.pdf`, content: pdf(n) }),
      })
    ).json() as SampleView;
    const prep = ctx.repo.jobs.get(s.prepareJobId!)!;
    ctx.repo.jobs.set(prep.id, { ...prep, status: 'succeeded' });
    const triage = { sha256: s.sha256, pageCount: 1, ocrPages: [], chars: 5, ocrModel: null };
    await ctx.store.put('runs', preparedTriageKey(s.sha256), Buffer.from(JSON.stringify(triage)), 'application/json');
    return s;
  };
  /** A verified reference for a sample: a finished test run of it, saved with `expected`. */
  const verify = async (s: SampleView, sender: string) => {
    const job = await ctx.repo.createWorkbenchJob(
      {
        id: crypto.randomUUID(),
        filename: s.filename,
        sha256: s.sha256,
        sizeBytes: 1,
        specId: 'letter',
        specVersion: 1,
        bucket: 'inbox',
        objectKey: `letter/${s.id}`,
      },
      { projectId: 'letter', task: 'process' },
    );
    return ctx.repo.createReference({
      templateId: 'letter',
      name: s.filename,
      documentId: job.documentId,
      sourceJobId: job.id,
      expected: { fields: { sender }, tables: {} },
    });
  };
  /** Finish an evaluation job with a document whose sender is `sender`. */
  const finish = async (jobId: string, sender: string) => {
    const job = ctx.repo.jobs.get(jobId)!;
    const key = outputKey('letter', 1, 'document', job.documentId, 'json');
    await ctx.store.put('outputs', key, Buffer.from(JSON.stringify({ fields: { sender: { value: sender } }, tables: {} })), 'application/json');
    ctx.repo.outputs.set(jobId, [{ outputId: 'document', stage: 'draft', format: 'json', bucket: 'outputs', key, rowCount: null }]);
    ctx.repo.jobs.set(jobId, { ...job, status: 'succeeded' });
  };
  const evaluate = (payload: unknown = {}) =>
    ctx.app.inject({ method: 'POST', url: '/api/workbench/projects/letter/evaluations', payload });
  const view = async (id: string) =>
    (await ctx.app.inject(`/api/workbench/projects/letter/iterations/${id}`)).json() as IterationView;
  return { ...ctx, add, verify, finish, evaluate, view };
}

describe('evaluations', () => {
  it('needs at least one verified dev sample', async () => {
    const { add, evaluate } = await project();
    await add(1);
    const res = await evaluate();
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no verified references for the dev samples; verify some on the References tab first');
  });

  it('runs verified samples against their references, with the model and data policy', async () => {
    const { add, verify, evaluate, repo } = await project();
    const a = await add(1);
    await add(2); // no reference: not evaluated
    const ref = await verify(a, 'Acme');
    const res = await evaluate({ model: 'fast' });
    expect(res.statusCode).toBe(201);
    const it = res.json() as IterationView;
    expect(it).toMatchObject({ templateVersion: 1, set: 'dev', model: 'fast', status: 'running', total: 1, score: null });
    const [jobId] = (await repo.listProjectRuns('letter')).filter((r) => r.job.referenceId === ref.id).map((r) => r.job.id);
    expect(repo.jobs.get(jobId!)).toMatchObject({ referenceId: ref.id, modelOverride: 'fast', specVersion: 1 });
    expect(repo.jobParams.get(jobId!)).toEqual({ dataPolicy: 'local' });
    expect((await evaluate({ model: 'opus' })).statusCode).toBe(400);
  });

  it('scores finished samples, counts failures as finished, and caches the summary', async () => {
    const { app, add, verify, finish, evaluate, view, repo, workbench } = await project();
    const a = await add(1);
    const b = await add(2);
    await verify(a, 'Acme');
    await verify(b, 'Globex');
    const it = (await evaluate()).json() as IterationView;
    const [jobA, jobB] = (await repo.listProjectRuns('letter')).filter((r) => r.job.referenceId).map((r) => r.job.id).reverse();
    await finish(jobA!, 'Acme');
    expect((await view(it.id)).status).toBe('running');
    repo.jobs.set(jobB!, { ...repo.jobs.get(jobB!)!, status: 'failed', error: 'boom' });
    const done = await view(it.id);
    expect(done).toMatchObject({ status: 'complete', score: 1, completed: 1, total: 2 });
    expect(done.scorecard.fields).toEqual([{ id: 'sender', matched: 1, total: 1, accuracy: 1 }]);
    expect(done.samples.find((s) => s.jobId === jobB)).toMatchObject({ status: 'failed', error: 'boom', comparison: null });
    expect((await workbench.getIteration('letter', it.id))!.scores).toEqual({ score: 1, completed: 1, total: 2 });
    const [summary] = (await app.inject('/api/workbench/projects/letter/iterations')).json() as IterationSummary[];
    expect(summary).toMatchObject({ id: it.id, status: 'complete', score: 1 });
  });

  it('restores an iteration into the open draft', async () => {
    const { app, add, verify, evaluate, templates } = await project();
    const a = await add(1);
    await verify(a, 'Acme');
    const it = (await evaluate()).json() as IterationView;
    await templates.updateDraft('letter', 1, { ...letter(1), name: 'Changed later' });
    const res = await app.inject({ method: 'POST', url: `/api/workbench/projects/letter/iterations/${it.id}/restore` });
    expect(res.statusCode).toBe(200);
    expect((await templates.get('letter', 1))!.definition).toEqual(letter(1));
    expect((await app.inject('/api/workbench/projects/letter/iterations/not-a-uuid')).statusCode).toBe(404);
  });
});
```

(The local variables named `it` shadow Vitest's `it`. Rename them to `iteration` if lint flags the shadowing, here and in Task 6's tests.

Check these against the code and adapt only the scaffolding, never the assertions:
- the `outputKey` signature (`packages/shared/src/storage-keys.ts`);
- the `JobOutput` shape;
- how `MemoryRepo` stores outputs, which `jobDocument` reads through `getJob(id).outputs`;
- which bucket the test app uses for `outputs`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/api/test/workbench-evaluation.test.ts`
Expected: FAIL. `POST /evaluations` returns 404.

- [ ] **Step 3: Implement**

In `apps/api/src/routes/workbench.ts`:

```ts
const EvaluateBody = z.object({ model: z.enum(EVALUATION_MODELS).optional() }).strict();
const IterationParams = z.object({ id: Id, iid: z.string().uuid() });

/** The scorecard of an iteration, computed from its jobs; caches the summary once complete. */
async function iterationView(app: FastifyInstance, it: IterationRecord): Promise<IterationView> {
  const references = await app.deps.repo.listReferencesWithSha(it.projectId);
  const samples = (await app.deps.workbench.listSamples(it.projectId));
  const results: SampleResult[] = await Promise.all(
    it.jobIds.map(async (jobId) => {
      const job = await app.deps.repo.getJob(jobId);
      const reference = job ? references.find((r) => r.id === job.referenceId) ?? null : null;
      const sample = reference ? samples.find((s) => s.sha256 === reference.sha256) ?? null : null;
      const document = job && reference && regressionFinished(job.status) ? await jobDocument(app, job) : null;
      return {
        sampleId: sample?.id ?? null,
        filename: job?.filename ?? 'deleted job',
        jobId: job?.id ?? null,
        status: job?.status ?? null,
        error: job?.error ?? null,
        comparison: document && reference ? compareToReference(reference.expected, document) : null,
      };
    }),
  );
  const scorecard = buildScorecard(results);
  const status = results.every((r) => finishedJob(r.status)) ? 'complete' : 'running';
  const scores = { score: scorecard.score, completed: scorecard.completed, total: scorecard.total };
  if (status === 'complete' && it.scores === null) await app.deps.workbench.setIterationScores(it.id, scores);
  return { ...summaryOf(it), status, ...scores, scorecard, samples: results };
}

function summaryOf(it: IterationRecord): Omit<IterationSummary, 'status' | 'score' | 'completed' | 'total'> {
  return {
    id: it.id,
    projectId: it.projectId,
    templateVersion: it.templateVersion,
    briefVersion: it.briefVersion,
    set: it.set,
    model: it.model,
    createdAt: it.createdAt,
  };
}
```

Routes:

```ts
  app.post<{ Params: ProjectParams }>('/workbench/projects/:id/evaluations', async (req, reply) => {
    const projectId = req.params.id;
    const project = await workbench.getProject(projectId);
    if (!project) return reply.code(404).send({ error: 'project not found' });
    const body = EvaluateBody.safeParse(req.body ?? {});
    if (!body.success) return reply.code(400).send({ error: body.error.issues });
    const { draft } = await versionsOf(templates, projectId);
    if (draft === null) {
      return reply.code(409).send({ error: 'no open draft; start the next version on the Template tab' });
    }
    const record = (await templates.get(projectId, draft))!;
    const issues = validateTemplate(record.definition);
    if (issues.length) return reply.code(400).send({ error: 'the draft is not valid', issues });
    const rows = (await referenceRows(app, projectId)).filter((r) => r.reference !== null);
    if (!rows.length) {
      return reply.code(409).send({
        error: 'no verified references for the dev samples; verify some on the References tab first',
      });
    }
    const samples = new Map((await sampleViews(app, projectId)).map((s) => [s.record.id, s.record]));
    const model = body.data.model ?? null;
    const jobs = await Promise.all(
      rows.map((row) => {
        const s = samples.get(row.sampleId)!;
        return app.deps.repo.createWorkbenchJob(
          {
            id: randomUUID(),
            filename: s.filename,
            sha256: s.sha256,
            sizeBytes: s.sizeBytes,
            specId: projectId,
            specVersion: draft,
            bucket: s.bucket,
            objectKey: s.objectKey,
          },
          {
            projectId,
            task: 'process',
            params: { dataPolicy: project.dataPolicy },
            referenceId: row.reference!.id,
            modelOverride: model,
          },
        );
      }),
    );
    const brief = await workbench.latestBrief(projectId);
    const iteration = await workbench.createIteration({
      projectId,
      templateVersion: draft,
      definition: record.definition,
      briefVersion: brief?.version ?? null,
      set: 'dev',
      model,
      jobIds: jobs.map((j) => j.id),
    });
    return reply.code(201).send(await iterationView(app, iteration));
  });

  app.get<{ Params: ProjectParams }>('/workbench/projects/:id/iterations', async (req, reply) => {
    if (!(await workbench.getProject(req.params.id))) {
      return reply.code(404).send({ error: 'project not found' });
    }
    const iterations = await workbench.listIterations(req.params.id);
    return Promise.all(
      iterations.map(async (it): Promise<IterationSummary> => {
        if (it.scores) return { ...summaryOf(it), status: 'complete', ...it.scores };
        const { scorecard: _s, samples: _x, ...summary } = await iterationView(app, it);
        return summary;
      }),
    );
  });

  app.get<{ Params: { id: string; iid: string } }>(
    '/workbench/projects/:id/iterations/:iid',
    async (req, reply) => {
      const params = IterationParams.safeParse(req.params);
      const it = params.success ? await workbench.getIteration(params.data.id, params.data.iid) : null;
      if (!it) return reply.code(404).send({ error: 'iteration not found' });
      return iterationView(app, it);
    },
  );

  app.post<{ Params: { id: string; iid: string } }>(
    '/workbench/projects/:id/iterations/:iid/restore',
    async (req, reply) => {
      const params = IterationParams.safeParse(req.params);
      const it = params.success ? await workbench.getIteration(params.data.id, params.data.iid) : null;
      if (!it) return reply.code(404).send({ error: 'iteration not found' });
      const { draft } = await versionsOf(templates, it.projectId);
      if (draft === null) {
        return reply.code(409).send({ error: 'no open draft; start the next version on the Template tab' });
      }
      const saved = await templates.updateDraft(it.projectId, draft, pinned(it.definition, it.projectId, draft));
      if (!saved) return reply.code(409).send({ error: 'the draft is no longer open' });
      req.log.info({ projectId: it.projectId, iteration: it.id, version: draft }, 'iteration restored');
      return projectView(app, (await workbench.getProject(it.projectId))!);
    },
  );
```

(Imports: `EVALUATION_MODELS`, `buildScorecard`, `finishedJob` and the types `IterationSummary`, `IterationView`, `ReferenceRow`, `SampleResult`, `StageView` from `@ih/shared`; `jobDocument` and `regressionFinished` from `../regression/report.js`; `compareToReference` from `../regression/compare.js`; `IterationRecord` from `../workbench/repo.js`. If ESLint objects to the unused destructured names in the list route, build the summary with `summaryOf` plus the four computed fields instead.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project api && npm run typecheck && npm run lint && npx prettier --check apps/api`
Expected: PASS, including the `access.test.ts` sweep.

- [ ] **Step 5: Commit**

```bash
git add apps/api
git commit -m "API: evaluations of the draft against references, iteration scorecards and restore"
```

---

### Task 5: Web: client and the References tab

**Files:**
- Create: `apps/web/src/workbench/ReferencesTab.tsx`
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`
- Test: `apps/web/test/ReferencesTab.test.tsx` (new), `apps/web/test/client.test.ts`

**Interfaces:**
- Produces:
  - Api:
    - `listReferenceRows(projectId): Promise<ReferenceRow[]>`
    - `proposeReferences(projectId): Promise<JobSummary[]>`. It POSTs `/stages/references` and returns `res.jobs`.
    - `startEvaluation(projectId, model: EvaluationModel | null): Promise<IterationView>`. The body is `{}` or `{ model }`.
    - `listIterations(projectId): Promise<IterationSummary[]>`
    - `getIteration(projectId, iterationId): Promise<IterationView>`
    - `restoreIteration(projectId, iterationId): Promise<ProjectView>`
  - fake-api defaults: `listReferenceRows` and `listIterations` return `[]`; the others throw "not stubbed". Builders `referenceRow(overrides?)` and `iterationView(overrides?)`.
  - `ReferencesTab({ api, projectId, dataPolicy, hasDraft, pollMs, onChanged })`:
    - **Rows:** a table labelled "References", one row per sample: file name; the run status, with **Verify in Review** linking to `#/review/<jobId>` when the run is `awaiting_review` or `succeeded`; and the reference (a `✓ name` or "Not verified").
    - **Run button:** "Run the draft model on unverified samples", disabled without an open draft.
    - **Notes:** the policy note, and a muted hint: "Open each run in Review, correct the values, and Save as reference."
    - **Skip this stage** button.
    - **Polling:** polls while any run is queued or running.
    - **onChanged:** called after proposing or skipping.

- [ ] **Step 1: Write the failing tests**

`client.test.ts`:

```ts
describe('http api: evaluation', () => {
  it('proposes references, evaluates, lists, opens and restores iterations', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => respond(200, { jobs: [] }));
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.listReferenceRows('letter');
    await api.proposeReferences('letter');
    await api.startEvaluation('letter', 'fast');
    await api.startEvaluation('letter', null);
    await api.listIterations('letter');
    await api.getIteration('letter', 'i1');
    await api.restoreIteration('letter', 'i1');
    const calls = fetchMock.mock.calls.map(([url, init]) => [
      init?.method ?? 'GET',
      url,
      init?.body ? JSON.parse(String(init.body)) : undefined,
    ]);
    expect(calls).toEqual([
      ['GET', '/api/workbench/projects/letter/references', undefined],
      ['POST', '/api/workbench/projects/letter/stages/references', {}],
      ['POST', '/api/workbench/projects/letter/evaluations', { model: 'fast' }],
      ['POST', '/api/workbench/projects/letter/evaluations', {}],
      ['GET', '/api/workbench/projects/letter/iterations', undefined],
      ['GET', '/api/workbench/projects/letter/iterations/i1', undefined],
      ['POST', '/api/workbench/projects/letter/iterations/i1/restore', {}],
    ]);
  });
});
```

`apps/web/test/ReferencesTab.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ReferencesTab } from '../src/workbench/ReferencesTab.js';
import { fakeApi, job, referenceRow } from './fake-api.js';

function tab(overrides = {}, hasDraft = true) {
  const api = fakeApi(overrides);
  const onChanged = vi.fn();
  render(
    <ReferencesTab api={api} projectId="letter" dataPolicy="local" hasDraft={hasDraft} pollMs={1} onChanged={onChanged} />,
  );
  return { api, onChanged };
}

describe('ReferencesTab', () => {
  it('lists each dev sample with its run and reference', async () => {
    tab({
      listReferenceRows: vi.fn(async () => [
        referenceRow({ filename: 'a.pdf', run: { jobId: 'j1', status: 'awaiting_review', error: null, modelOverride: 'draft' } }),
        referenceRow({ filename: 'b.pdf', run: null, reference: { id: 'r1', name: 'b', createdAt: '' } }),
      ]),
    });
    const table = await screen.findByRole('table', { name: 'References' });
    const a = within(table).getByText('a.pdf').closest('tr')!;
    expect(within(a).getByRole('link', { name: 'Verify in Review' })).toHaveAttribute('href', '#/review/j1');
    expect(within(a).getByText('Not verified')).toBeInTheDocument();
    const b = within(table).getByText('b.pdf').closest('tr')!;
    expect(within(b).getByText('✓ b')).toBeInTheDocument();
  });

  it('runs the draft model on unverified samples and polls while they run', async () => {
    const listReferenceRows = vi
      .fn()
      .mockResolvedValueOnce([referenceRow({ run: null })])
      .mockResolvedValueOnce([referenceRow({ run: { jobId: 'j1', status: 'running', error: null, modelOverride: 'draft' } })])
      .mockResolvedValue([referenceRow({ run: { jobId: 'j1', status: 'awaiting_review', error: null, modelOverride: 'draft' } })]);
    const { api, onChanged } = tab({ listReferenceRows, proposeReferences: vi.fn(async () => [job()]) });
    await userEvent.click(await screen.findByRole('button', { name: 'Run the draft model on unverified samples' }));
    expect(api.proposeReferences).toHaveBeenCalledWith('letter');
    expect(onChanged).toHaveBeenCalled();
    expect(await screen.findByRole('link', { name: 'Verify in Review' })).toBeInTheDocument();
  });

  it('needs an open draft', async () => {
    tab({}, false);
    expect(await screen.findByRole('button', { name: 'Run the draft model on unverified samples' })).toBeDisabled();
  });

  it('skips the stage', async () => {
    const { api, onChanged } = tab({ skipStage: vi.fn(async () => []) });
    await userEvent.click(await screen.findByRole('button', { name: 'Skip this stage' }));
    expect(api.skipStage).toHaveBeenCalledWith('letter', 'references');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/client.test.ts apps/web/test/ReferencesTab.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

`client.ts`, following the existing patterns:
- `listReferenceRows: (id) => apiFetch(\`${base}/workbench/projects/${id}/references\`).then(json<ReferenceRow[]>)`
- `proposeReferences: (id) => post<{ jobs: JobSummary[] }>(\`${base}/workbench/projects/${id}/stages/references\`, {}).then((r) => r.jobs)`
- `startEvaluation: (id, model) => post<IterationView>(\`${base}/workbench/projects/${id}/evaluations\`, model ? { model } : {})`
- `listIterations: (id) => apiFetch(\`${base}/workbench/projects/${id}/iterations\`).then(json<IterationSummary[]>)`
- `getIteration: (id, iid) => apiFetch(\`${base}/workbench/projects/${id}/iterations/${iid}\`).then(json<IterationView>)`
- `restoreIteration: (id, iid) => post<ProjectView>(\`${base}/workbench/projects/${id}/iterations/${iid}/restore\`, {})`

`fake-api.ts` builders:

```ts
export function referenceRow(overrides: Partial<ReferenceRow> = {}): ReferenceRow {
  return {
    sampleId: crypto.randomUUID(),
    filename: 'a.pdf',
    sha256: 'sha-a',
    reference: null,
    run: null,
    ...overrides,
  };
}

export function iterationView(overrides: Partial<IterationView> = {}): IterationView {
  return {
    id: crypto.randomUUID(),
    projectId: 'letter',
    templateVersion: 2,
    briefVersion: 1,
    set: 'dev',
    model: null,
    createdAt: '2026-10-12T10:00:00.000Z',
    status: 'complete',
    score: 0.75,
    completed: 2,
    total: 2,
    scorecard: {
      score: 0.75,
      completed: 2,
      total: 2,
      fields: [
        { id: 'sent_on', matched: 1, total: 2, accuracy: 0.5 },
        { id: 'sender', matched: 2, total: 2, accuracy: 1 },
      ],
      columns: [],
    },
    samples: [
      {
        sampleId: 's1',
        filename: 'a.pdf',
        jobId: 'j1',
        status: 'succeeded',
        error: null,
        comparison: {
          score: 0.5,
          fields: [
            { id: 'sent_on', expected: '2026-03-01', actual: '2026-01-03', match: false },
            { id: 'sender', expected: 'Acme', actual: 'Acme', match: true },
          ],
          tables: [],
        },
      },
      {
        sampleId: 's2',
        filename: 'b.pdf',
        jobId: 'j2',
        status: 'succeeded',
        error: null,
        comparison: {
          score: 1,
          fields: [
            { id: 'sent_on', expected: '2026-04-02', actual: '2026-04-02', match: true },
            { id: 'sender', expected: 'Globex', actual: 'Globex', match: true },
          ],
          tables: [],
        },
      },
    ],
    ...overrides,
  };
}
```

`apps/web/src/workbench/ReferencesTab.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import type { DataPolicy, ReferenceRow } from '@ih/shared';
import type { Api } from '../api/client.js';

const POLICY_NOTE: Record<DataPolicy, string> = {
  local: 'Runs on local models; holdout samples are never sent.',
  external:
    'Dev sample text may be sent to an external model provider; holdout samples are never sent.',
};

const reviewable = (status: string) => status === 'awaiting_review' || status === 'succeeded';
const active = (status: string) => status === 'queued' || status === 'running';

/** Stage 5 (ADR 0007): the draft model proposes values; the user verifies them in Review. */
export function ReferencesTab({
  api,
  projectId,
  dataPolicy,
  hasDraft,
  pollMs,
  onChanged,
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  hasDraft: boolean;
  pollMs: number;
  onChanged: () => void;
}) {
  const [rows, setRows] = useState<ReferenceRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setRows(await api.listReferenceRows(projectId));
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const running = rows?.some((r) => r.run !== null && active(r.run.status)) ?? false;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), pollMs);
    return () => clearInterval(timer);
  }, [running, pollMs, refresh]);

  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const propose = () =>
    act(async () => {
      const jobs = await api.proposeReferences(projectId);
      setMessage(`${jobs.length} run${jobs.length === 1 ? '' : 's'} queued`);
      onChanged();
      await refresh();
    });
  const skip = () =>
    act(async () => {
      await api.skipStage(projectId, 'references');
      setMessage('Stage skipped');
      onChanged();
    });

  return (
    <div className="references-tab">
      <p className="muted">{POLICY_NOTE[dataPolicy]}</p>
      <p className="muted">Open each run in Review, correct the values, and Save as reference.</p>
      <div className="actions">
        <button
          type="button"
          className="primary"
          disabled={!hasDraft || busy || running}
          onClick={() => void propose()}
        >
          Run the draft model on unverified samples
        </button>
        <button type="button" disabled={busy} onClick={() => void skip()}>
          Skip this stage
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      {rows === null ? (
        <p>Loading…</p>
      ) : (
        <table aria-label="References">
          <thead>
            <tr>
              <th>Sample</th>
              <th>Run</th>
              <th>Reference</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.sampleId}>
                <td>{r.filename}</td>
                <td>
                  {r.run ? (
                    <>
                      {r.run.status.replace('_', ' ')}
                      {r.run.error && <small className="muted"> {r.run.error}</small>}{' '}
                      {reviewable(r.run.status) && <a href={`#/review/${r.run.jobId}`}>Verify in Review</a>}
                    </>
                  ) : (
                    <span className="muted">No run yet</span>
                  )}
                </td>
                <td>{r.reference ? `✓ ${r.reference.name}` : <span className="muted">Not verified</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project web && npm run typecheck && npm run lint && npx prettier --check apps/web`
Expected: PASS. Check `npm run typecheck`'s **exit code**.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "Web: evaluation client and the References tab"
```

---

### Task 6: Web: the Evaluate tab (scorecard, drill-down, trend, restore)

**Files:**
- Create: `apps/web/src/workbench/EvaluateTab.tsx`
- Test: `apps/web/test/EvaluateTab.test.tsx` (new)

**Interfaces:**
- Consumes: Task 5 client methods and builders.
- Produces: `EvaluateTab({ api, projectId, dataPolicy, hasDraft, pollMs, onRestored })`.
  - **Model picker:** a select labelled "Model" with the options "Template's models" (null), `default`, `fast` and `draft`.
  - **Evaluate the draft** button, disabled without an open draft; plus the policy note.
  - **Latest iteration:**
    - overall score as a percentage (`Score 75%`), version, model and status;
    - a table labelled "Samples" (file, score, **Review** link to `#/review/<jobId>`, error);
    - a table labelled "Field accuracy" listing fields and columns worst first;
    - drill-down: clicking a sample row's **Details** button shows a table labelled `Fields in <file>` with expected, actual and match.
  - **Polling:** polls `getIteration` while the latest iteration is running.
  - **History:** a table labelled "History" listing iterations newest first (version, model, score, date), each with **Restore**. Restore confirms with `window.confirm('Replace the open draft with the template from this iteration?')`, then calls `restoreIteration` and `onRestored()`.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/EvaluateTab.test.tsx`:

```tsx
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { EvaluateTab } from '../src/workbench/EvaluateTab.js';
import { fakeApi, iterationView, projectView } from './fake-api.js';

function tab(overrides = {}, hasDraft = true) {
  const api = fakeApi(overrides);
  const onRestored = vi.fn();
  render(
    <EvaluateTab api={api} projectId="letter" dataPolicy="local" hasDraft={hasDraft} pollMs={1} onRestored={onRestored} />,
  );
  return { api, onRestored };
}

describe('EvaluateTab', () => {
  it('evaluates with the chosen model and polls until complete', async () => {
    const running = iterationView({ status: 'running', score: null, completed: 0 });
    const done = iterationView({ id: running.id });
    const { api } = tab({
      listIterations: vi.fn(async () => []),
      startEvaluation: vi.fn(async () => running),
      getIteration: vi.fn().mockResolvedValueOnce(running).mockResolvedValue(done),
    });
    await userEvent.selectOptions(await screen.findByLabelText('Model'), 'fast');
    await userEvent.click(screen.getByRole('button', { name: 'Evaluate the draft' }));
    expect(api.startEvaluation).toHaveBeenCalledWith('letter', 'fast');
    expect(await screen.findByText('Score 75%')).toBeInTheDocument();
  });

  it('shows per-sample scores, worst fields first, and a drill-down', async () => {
    const it = iterationView();
    tab({ listIterations: vi.fn(async () => [it]), getIteration: vi.fn(async () => it) });
    const samples = await screen.findByRole('table', { name: 'Samples' });
    const a = within(samples).getByText('a.pdf').closest('tr')!;
    expect(within(a).getByText('50%')).toBeInTheDocument();
    expect(within(a).getByRole('link', { name: 'Review' })).toHaveAttribute('href', '#/review/j1');
    const accuracy = screen.getByRole('table', { name: 'Field accuracy' });
    const [first] = within(accuracy).getAllByRole('row').slice(1);
    expect(first).toHaveTextContent('sent_on');
    expect(first).toHaveTextContent('1 / 2');
    await userEvent.click(within(a).getByRole('button', { name: 'Details' }));
    const detail = screen.getByRole('table', { name: 'Fields in a.pdf' });
    const row = within(detail).getByText('sent_on').closest('tr')!;
    expect(row).toHaveTextContent('2026-03-01');
    expect(row).toHaveTextContent('2026-01-03');
  });

  it('restores an iteration from the history after confirming', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const it = iterationView();
    const { api, onRestored } = tab({
      listIterations: vi.fn(async () => [it]),
      getIteration: vi.fn(async () => it),
      restoreIteration: vi.fn(async () => projectView()),
    });
    const history = await screen.findByRole('table', { name: 'History' });
    await userEvent.click(within(history).getByRole('button', { name: 'Restore' }));
    expect(confirm).toHaveBeenCalled();
    expect(api.restoreIteration).toHaveBeenCalledWith('letter', it.id);
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
    confirm.mockRestore();
  });

  it('needs an open draft', async () => {
    tab({}, false);
    expect(await screen.findByRole('button', { name: 'Evaluate the draft' })).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/EvaluateTab.test.tsx`
Expected: FAIL. `EvaluateTab` does not exist.

- [ ] **Step 3: Implement**

`apps/web/src/workbench/EvaluateTab.tsx`:

```tsx
import { useCallback, useEffect, useState } from 'react';
import {
  EVALUATION_MODELS,
  type DataPolicy,
  type EvaluationModel,
  type IterationSummary,
  type IterationView,
} from '@ih/shared';
import type { Api } from '../api/client.js';

const POLICY_NOTE: Record<DataPolicy, string> = {
  local: 'Runs on local models; holdout samples are never sent.',
  external:
    'Dev sample text may be sent to an external model provider; holdout samples are never sent.',
};

const pct = (n: number | null) => (n === null ? '–' : `${Math.round(n * 100)}%`);
const show = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'string' ? v : JSON.stringify(v));

/** Evaluate the draft on verified dev samples; scorecard, drill-down and history (ADR 0007). */
export function EvaluateTab({
  api,
  projectId,
  dataPolicy,
  hasDraft,
  pollMs,
  onRestored,
}: {
  api: Api;
  projectId: string;
  dataPolicy: DataPolicy;
  hasDraft: boolean;
  pollMs: number;
  onRestored: () => void;
}) {
  const [history, setHistory] = useState<IterationSummary[] | null>(null);
  const [current, setCurrent] = useState<IterationView | null>(null);
  const [model, setModel] = useState<EvaluationModel | ''>('');
  const [open, setOpen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await api.listIterations(projectId);
      setHistory(list);
      setCurrent(list[0] ? await api.getIteration(projectId, list[0].id) : null);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, [api, projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const currentId = current?.id;
  const running = current?.status === 'running';
  useEffect(() => {
    if (!running || !currentId) return;
    const timer = setInterval(() => {
      api.getIteration(projectId, currentId).then(
        (it) => {
          setCurrent(it);
          if (it.status === 'complete') void load();
        },
        (err: Error) => setError(err.message),
      );
    }, pollMs);
    return () => clearInterval(timer);
  }, [running, currentId, pollMs, api, projectId, load]);

  const act = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const evaluate = () =>
    act(async () => {
      const it = await api.startEvaluation(projectId, model || null);
      setCurrent(it);
      setOpen(null);
      setHistory([it, ...(history ?? [])]);
    });
  const restore = (id: string) =>
    act(async () => {
      if (!window.confirm('Replace the open draft with the template from this iteration?')) return;
      await api.restoreIteration(projectId, id);
      onRestored();
    });

  const accuracy = current ? [...current.scorecard.fields, ...current.scorecard.columns] : [];
  const opened = current?.samples.find((s) => s.jobId === open) ?? null;

  return (
    <div className="evaluate-tab">
      <p className="muted">{POLICY_NOTE[dataPolicy]}</p>
      <div className="actions">
        <label>
          Model{' '}
          <select value={model} onChange={(e) => setModel(e.target.value as EvaluationModel | '')}>
            <option value="">Template&apos;s models</option>
            {EVALUATION_MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="primary"
          disabled={!hasDraft || busy || running}
          onClick={() => void evaluate()}
        >
          Evaluate the draft
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      {current && (
        <section aria-label="Latest evaluation">
          <h3>Score {pct(current.score)}</h3>
          <p className="muted">
            v{current.templateVersion} · {current.model ?? "template's models"} · {current.completed} of{' '}
            {current.total} compared · {current.status}
          </p>
          <table aria-label="Samples">
            <thead>
              <tr>
                <th>Sample</th>
                <th>Score</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {current.samples.map((s, i) => (
                <tr key={`${i}-${s.jobId ?? s.filename}`}>
                  <td>{s.filename}</td>
                  <td>{s.comparison ? pct(s.comparison.score) : '–'}</td>
                  <td>
                    {s.status ? s.status.replace('_', ' ') : 'deleted'}
                    {s.error && <small className="muted"> {s.error}</small>}
                  </td>
                  <td>
                    {s.jobId && <a href={`#/review/${s.jobId}`}>Review</a>}{' '}
                    {s.comparison && s.jobId && (
                      <button type="button" onClick={() => setOpen(open === s.jobId ? null : s.jobId)}>
                        Details
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {opened?.comparison && (
            <table aria-label={`Fields in ${opened.filename}`}>
              <thead>
                <tr>
                  <th>Field</th>
                  <th>Expected</th>
                  <th>Actual</th>
                  <th>Match</th>
                </tr>
              </thead>
              <tbody>
                {opened.comparison.fields.map((f) => (
                  <tr key={f.id}>
                    <td>{f.id}</td>
                    <td>{show(f.expected)}</td>
                    <td>{show(f.actual)}</td>
                    <td>{f.match ? '✓' : '✗'}</td>
                  </tr>
                ))}
                {opened.comparison.tables.map((t) => (
                  <tr key={`table-${t.id}`}>
                    <td>{t.id}</td>
                    <td>{t.expected} rows</td>
                    <td>{t.actual} rows</td>
                    <td>
                      {t.matched} matched · {t.changed.length} changed · {t.missing.length} missing ·{' '}
                      {t.extra.length} extra
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <table aria-label="Field accuracy">
            <thead>
              <tr>
                <th>Field or column</th>
                <th>Correct</th>
                <th>Accuracy</th>
              </tr>
            </thead>
            <tbody>
              {accuracy.map((a) => (
                <tr key={a.id}>
                  <td>{a.id}</td>
                  <td>
                    {a.matched} / {a.total}
                  </td>
                  <td>{pct(a.accuracy)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
      {history && history.length > 0 && (
        <table aria-label="History">
          <thead>
            <tr>
              <th>Version</th>
              <th>Model</th>
              <th>Score</th>
              <th>When</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td>v{h.templateVersion}</td>
                <td>{h.model ?? "template's"}</td>
                <td>{h.status === 'complete' ? pct(h.score) : 'running'}</td>
                <td>{new Date(h.createdAt).toLocaleString()}</td>
                <td>
                  <button type="button" disabled={busy} onClick={() => void restore(h.id)}>
                    Restore
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
```

(Fields and columns share the "Field accuracy" table. Fields come first, then columns, each worst first, so the first data row is the worst field. The test relies on that.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project web && npm run typecheck && npm run lint && npx prettier --check apps/web`
Expected: PASS. Check `npm run typecheck`'s **exit code**.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "Web: Evaluate tab (scorecard, per-sample drill-down, field accuracy, history and restore)"
```

---

### Task 7: Web: References and Evaluate tabs on the project page

**Files:**
- Modify: `apps/web/src/router.ts`, `apps/web/src/workbench/ProjectPage.tsx`
- Test: `apps/web/test/router.test.ts`, `apps/web/test/ProjectPage.test.tsx`

**Interfaces:**
- Produces:
  - `PROJECT_TABS = ['samples', 'brief', 'survey', 'outputs', 'sections', 'steps', 'references', 'evaluate', 'template', 'runs']`
  - `TAB_LABEL` adds `references: 'References'` and `evaluate: 'Evaluate'`.
  - The references tab shows its stage state from `listStages`, as the other stages do.
  - `ReferencesTab` gets `onChanged={changed}`; `EvaluateTab` gets `onRestored={changed}`.

- [ ] **Step 1: Write the failing tests**

`router.test.ts` rows:

```ts
['#/workbench/letter/references', { name: 'project', projectId: 'letter', tab: 'references' }],
['#/workbench/letter/evaluate', { name: 'project', projectId: 'letter', tab: 'evaluate' }],
```

`ProjectPage.test.tsx`:

```tsx
  it('shows the references stage state and renders the References and Evaluate tabs', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      listStages: vi.fn(async () => [
        { stage: 'references' as const, state: 'proposed' as const, completedAt: null },
      ]),
    });
    const { unmount } = render(
      <ProjectPage api={api} projectId="letter" tab="references" onNavigate={vi.fn()} role="admin" />,
    );
    const tabs = await screen.findByRole('navigation', { name: 'Project' });
    expect(await within(tabs).findByRole('link', { name: /References · proposed/ })).toBeInTheDocument();
    expect(
      await screen.findByRole('button', { name: 'Run the draft model on unverified samples' }),
    ).toBeInTheDocument();
    unmount();
    render(<ProjectPage api={api} projectId="letter" tab="evaluate" onNavigate={vi.fn()} role="admin" />);
    expect(await screen.findByRole('button', { name: 'Evaluate the draft' })).toBeInTheDocument();
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/web/test/router.test.ts apps/web/test/ProjectPage.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `router.ts`: the new `PROJECT_TABS`.
- `ProjectPage.tsx`:
  - Add the two labels.
  - Render the tabs:

```tsx
      {tab === 'references' && (
        <ReferencesTab
          key={`references-${revision}`}
          api={api}
          projectId={project.id}
          dataPolicy={project.dataPolicy}
          hasDraft={draft !== null}
          pollMs={pollMs}
          onChanged={changed}
        />
      )}
      {tab === 'evaluate' && (
        <EvaluateTab
          api={api}
          projectId={project.id}
          dataPolicy={project.dataPolicy}
          hasDraft={draft !== null}
          pollMs={pollMs}
          onRestored={changed}
        />
      )}
```

  - The stage suffix in the tab bar already covers any tab whose name matches a `StageView.stage`, so `references` needs no extra code. Confirm it, and adjust if the 3b code only looks at the four proposal stages.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run --project web && npm run typecheck && npm run lint && npx prettier --check apps/web`
Expected: PASS. Check `npm run typecheck`'s **exit code**.

- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "Web: References and Evaluate tabs on the workbench project page"
```

---

### Task 8: Docs, full check and smoke test

**Files:**
- Modify: `CLAUDE.md`, `docs/architecture.md`, `docs/design/workbench.md`

- [ ] **Step 1: Document it**

`CLAUDE.md`:
- **Contracts table:** add an **Evaluation** row.
  - TS: `packages/shared/src/evaluation.ts` (`Comparison` with per-column counts, `buildScorecard`, `IterationView`, `ReferenceRow`) and `referencesStage` in `drafting.ts`.
  - Python: none. Evaluation and reference runs are ordinary `process` jobs.
- **Workbench bullet:**
  - Samples are linked to references by PDF sha256.
  - Reference runs are dev test runs with `modelOverride: 'draft'`, verified in Review with "Save as reference". The references stage is accepted once every ready dev sample is verified.
  - Evaluate creates project jobs carrying `referenceId`, `modelOverride` and `params.dataPolicy`, and records a `workbench_iterations` row (migration 0013) with a definition snapshot.
  - The scorecard is computed from the jobs, and the summary is cached in `scores` once every job has finished.
  - Restore writes the snapshot into the open draft.

`docs/architecture.md`: one paragraph in the Workbench section on references and evaluation.

`docs/design/workbench.md`, Phasing:
- Phase 4 is split into **4a (done):** references stage, Evaluate on dev, scorecard and drill-down, iterations with restore.
- **4b (next):** step cache, model comparison and re-run uncached.
- **4c:** feedback and `revise`.

- [ ] **Step 2: Full check**

Run `npm run check` and `npm run format:check`, checking the exit codes. If `uv` is not on PATH, add its directory first.
Expected: PASS.

- [ ] **Step 3: Smoke test (throwaway infra only)**

1. Apply migrations 0001–0013 to a throwaway Postgres by running the opt-in `workbench-pg` test against it (`CLAUDE.md`), then remove the container.
2. If a full stack with a local `draft` model is available:
   - run the references stage on two dev samples;
   - verify both in Review and save them as references;
   - Evaluate, check the scorecard, and open a drill-down;
   - change the draft, Evaluate again, and check that the trend shows two iterations;
   - restore the first.
3. Make no external LLM calls. Record what you could not run in the PR description.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs
git commit -m "Workbench: document phase 4a (references, evaluation, scorecard, iterations)"
```
