# Workbench project list API (PR 6 of 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the Workbench project list for 100–1,000 projects: `GET /api/workbench/projects` pages, filters, sorts and counts on the server (handoff W1), with per-signed-in-token pins (W3), a seed script for 1,000 projects and a p95 < 200 ms integration test.

**Architecture:** Each project's list row (`ProjectListItem`) is derived from exactly the same code as the project page (`projectOverview` + PR 2's pure functions) and cached in a new `workbench_list_cache` table under a **fingerprint** — a cheap per-project aggregate (counts and latest timestamps) over every table the overview reads, computed for all projects in one SQL query. A list request reads the fingerprints, recomputes only the rows whose fingerprint changed (bounded concurrency), then filters, counts facets, sorts and pages in memory with a pure shared function (`queryProjects`). This is the handoff's "cached project state refreshed on every event", computed lazily so the Python worker needs no change. Pins live in `workbench_pins (owner, project_id)`.

**Tech Stack:** Fastify + Zod, Postgres (forward-only migration 0022), MemoryRepo/PgRepo adapters, Vitest (unit + `apps/api/test/integration/` against a throwaway Postgres).

**Spec:** `docs/design/workbench-redesign/WORKBENCH-HANDOFF.md` §5 W1 and W3, §1 (facets and sorts), "Definition of done" (p95). PR 2–4 code: `packages/shared/src/overview.ts`, `apps/api/src/routes/workbench-overview.ts`.

## Global Constraints

- `GET /api/workbench/projects ?q=<name or id substring, ≤100 chars> &filter=all|attention|running|ready|progress|published &phase=prepare|draft|verify|published &policy=local|external &sort=activity|name|score|samples &ids=<up to 20 comma-separated ids> &page=1 &size=25|50|100` → `{ items: ProjectListItem[]; total: number; facets: { all; attention; running; ready; progress; published } }`. `total` is after all filters; `facets` ignore `filter` but honour `q`/`phase`/`policy`. Defaults: `filter=all`, `sort=activity`, `page=1`, `size=25`. The old unpaged `ProjectSummary[]` stays behind `?all=1` until the web moves (PR 7).
- Sorts: `activity` = `lastActivityAt` desc; `name` = A–Z; `score` = holdout score ascending, nulls last; `samples` = fewest samples first. Ties break by id.
- Facets: attention = any stage `stale`/`proposed`/`warn`; running = any stage `running`, or unfinished test/evaluation runs; ready = the gate passes on the open draft; progress = has an open draft; published = no open draft.
- `ProjectListItem` extends `ProjectSummary` with `stages` (10 entries, fixed order), `phase`, `done` (0–10), `next`, `holdoutScore`, `devSamples`, `holdoutSamples`, `lastActivityAt`, and `flags { attention, running, ready }`.
- Pins: `GET /api/workbench/pins` → `string[]` (most recent first), `PUT /api/workbench/pins/:projectId` → 204 (404 unknown project), `DELETE /api/workbench/pins/:projectId` → 204 (idempotent). Pins belong to the signed-in token (`req.auth.tokenId`; `'local'` when access control is off in tests). The bootstrap admin token is recreated on every API start, so its pins reset then — named admin tokens (migration 0021) keep theirs.
- Never compute stage states for every project on every request: only rows whose fingerprint changed are recomputed.
- p95 of `GET /api/workbench/projects` < 200 ms with 1,000 seeded projects, measured against a **throwaway** `postgres:17-alpine` container (never the user's dev-infra DB), skipped unless `IH_TEST_DATABASE_URL` is set.
- New routes documented (OpenAPI schema; none on `UNDOCUMENTED`); access sweep covers them. Forward-only migration `db/migrations/0022_workbench_list.sql`.
- Tests first; `npm run check` green; commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never stage `config/llm-providers.yaml`.

## Review Focus

1. **Stale cache after a change the fingerprint misses** — every input the overview reads must move the fingerprint: a job status change (worker), a sample role switch, a template edit, a reference saved or superseded, a brief save, a threshold or policy change, a deletion of any child row (Task 2 Pg integration test, one assertion per input).
2. **Page past the end / empty result** — `page` beyond the last page returns `items: []` with the true `total`; no match returns `total: 0` and zero facets (Task 1 tests).
3. **Bad query values** (`size=30`, `page=0`, `sort=x`, `q` > 100 chars) → 400 with Zod issues, never a 500 (Task 3 test).
4. **A project deleted between the fingerprint read and the recompute** — skipped, not a 500; its cache row and pins go with it (FK cascade) (Task 3 and Task 2 tests).
5. **Concurrent first loads** (two list requests on a cold cache) both answer and leave one cache row per project (upsert) (Task 3 test with two parallel injects).

---

### Task 1: Shared list types and `queryProjects`

**Files:**
- Modify: `packages/shared/src/overview.ts` (append) 
- Test: `packages/shared/test/overview-list.test.ts` (create)

**Interfaces:**
- Consumes: `ProjectSummarySchema`, `DATA_POLICIES` (`workbench.ts`); `OVERVIEW_STAGES`, `OverviewStateSchema`, `OverviewEntry`, `OverviewInputs`, `overviewStates`, `phaseOf`, `nextAction`, `NextAction` (this file).
- Produces:
  - `NEXT_ACTION_KINDS` (const array of the 9 kinds; `NextActionKind` becomes `(typeof NEXT_ACTION_KINDS)[number]`), `OVERVIEW_PHASES = ['prepare','draft','verify','published'] as const`.
  - `LIST_FILTERS`, `LIST_SORTS`, `PAGE_SIZES = [25, 50, 100] as const`.
  - `ProjectListQuerySchema` (Zod, query strings coerced), `type ProjectListQuery`.
  - `ProjectListItemSchema`, `type ProjectListItem`; `ProjectListPageSchema = { items, total, facets }`, `type ProjectListPage`.
  - `listItemFrom(input: { summary: ProjectSummary; inputs: OverviewInputs; runsUnfinished: number; holdoutScore: number | null; devSamples: number; holdoutSamples: number; lastActivityAt: string }): ProjectListItem`
  - `queryProjects(items: readonly ProjectListItem[], query: ProjectListQuery): ProjectListPage`

- [ ] **Step 1: Write the failing tests** — `packages/shared/test/overview-list.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ProjectListQuerySchema,
  listItemFrom,
  queryProjects,
  type GateView,
  type OverviewInputs,
  type ProjectListItem,
} from '../src/index.js';

const gate = (over: Partial<GateView> = {}): GateView => ({
  threshold: 0.9, iterationId: null, score: null, passes: false, reason: 'none', ...over,
});
const done = (['survey', 'outputs', 'sections', 'steps', 'references'] as const).map((stage) => ({
  stage, state: 'accepted' as const, completedAt: null,
}));
const inputs = (over: Partial<OverviewInputs> = {}): OverviewInputs => ({
  draft: 2, published: 1, briefSaved: true, samples: { total: 6, preparing: 0, failed: 0 },
  stages: done, revise: null, evaluation: { running: false }, gate: gate(), ...over,
});
const summary = (id: string, name = id) => ({
  id, name, createdAt: '2026-10-01T00:00:00.000Z', dataPolicy: 'local' as const,
  dataPolicyChangedAt: null, dataPolicyChangedBy: null, publishThreshold: 0.9,
  thresholdSetBy: null, thresholdSetAt: null, draft: 2, published: 1, samples: 6,
});
const item = (id: string, over: Partial<Parameters<typeof listItemFrom>[0]> = {}): ProjectListItem =>
  listItemFrom({
    summary: summary(id), inputs: inputs(), runsUnfinished: 0, holdoutScore: null,
    devSamples: 4, holdoutSamples: 2, lastActivityAt: '2026-10-13T00:00:00.000Z', ...over,
  });
const q = (raw: Record<string, string> = {}) => ProjectListQuerySchema.parse(raw);

describe('listItemFrom', () => {
  it('derives stages, phase, next action and flags from the overview inputs', () => {
    const i = item('a', { inputs: inputs({ stages: done.map((s) => (s.stage === 'steps' ? { ...s, state: 'proposed' as const } : s)) }) });
    expect(i.stages).toHaveLength(10);
    expect(i.stages[5]).toEqual({ stage: 'steps', state: 'proposed' });
    expect(i.phase).toBe('draft');
    expect(i.done).toBe(5);
    expect(i.next).toEqual({ kind: 'decide', stage: 'steps', label: 'Decide on Steps' });
    expect(i.flags).toEqual({ attention: true, running: false, ready: false });
  });

  it('flags running for unfinished runs even when no stage is running', () => {
    expect(item('a', { runsUnfinished: 2 }).flags.running).toBe(true);
    expect(item('a', { inputs: inputs({ evaluation: { running: true } }) }).flags.running).toBe(true);
  });

  it('flags ready when the gate passes and attention when a holdout run failed it', () => {
    expect(item('a', { inputs: inputs({ gate: gate({ iterationId: 'i', score: 0.95, passes: true }) }) }).flags.ready).toBe(true);
    expect(item('a', { inputs: inputs({ gate: gate({ iterationId: 'i', score: 0.5 }) }) }).flags.attention).toBe(true);
  });
});

describe('ProjectListQuerySchema', () => {
  it('fills the defaults', () => {
    expect(q()).toEqual({ filter: 'all', sort: 'activity', page: 1, size: 25 });
  });
  it.each([{ size: '30' }, { page: '0' }, { sort: 'x' }, { filter: 'x' }, { phase: 'x' }, { policy: 'x' }, { q: 'x'.repeat(101) }, { extra: '1' }])(
    'refuses %o',
    (raw) => {
      expect(ProjectListQuerySchema.safeParse(raw).success).toBe(false);
    },
  );
});

describe('queryProjects', () => {
  const items = [
    item('alpha', { summary: summary('alpha', 'Zeta report'), lastActivityAt: '2026-10-10T00:00:00.000Z', holdoutScore: 0.8, devSamples: 1, holdoutSamples: 0 }),
    item('beta', { summary: { ...summary('beta', 'Alpha invoice'), dataPolicy: 'external' }, lastActivityAt: '2026-10-12T00:00:00.000Z', holdoutScore: null, devSamples: 5, holdoutSamples: 2 }),
    item('gamma', { summary: { ...summary('gamma', 'Middle'), draft: null }, inputs: inputs({ draft: null }), lastActivityAt: '2026-10-11T00:00:00.000Z', holdoutScore: 0.95, devSamples: 3, holdoutSamples: 1 }),
  ];
  const ids = (page: ReturnType<typeof queryProjects>) => page.items.map((i) => i.id);

  it('sorts by last activity by default', () => {
    expect(ids(queryProjects(items, q()))).toEqual(['beta', 'gamma', 'alpha']);
  });
  it.each([
    ['name', ['beta', 'gamma', 'alpha']],
    ['score', ['alpha', 'gamma', 'beta']],
    ['samples', ['alpha', 'gamma', 'beta']],
  ] as const)('sorts by %s', (sort, expected) => {
    expect(ids(queryProjects(items, q({ sort })))).toEqual(expected);
  });
  it('searches name and id, case-insensitively', () => {
    expect(ids(queryProjects(items, q({ q: 'INVOICE' })))).toEqual(['beta']);
    expect(ids(queryProjects(items, q({ q: 'gam' })))).toEqual(['gamma']);
  });
  it('narrows to the given ids (pinned and recent cards)', () => {
    expect(ids(queryProjects(items, q({ ids: 'gamma, alpha' })))).toEqual(['gamma', 'alpha']);
    expect(ProjectListQuerySchema.safeParse({ ids: Array.from({ length: 21 }, (_, n) => `p${n}`).join(',') }).success).toBe(false);
  });
  it('filters by phase and policy', () => {
    expect(ids(queryProjects(items, q({ phase: 'published' })))).toEqual(['gamma']);
    expect(ids(queryProjects(items, q({ policy: 'external' })))).toEqual(['beta']);
  });
  it('counts facets before the filter chip but after search', () => {
    const page = queryProjects(items, q({ filter: 'published' }));
    expect(page.total).toBe(1);
    expect(page.facets).toEqual({ all: 3, attention: 0, running: 0, ready: 0, progress: 2, published: 1 });
    expect(queryProjects(items, q({ q: 'zeta' })).facets.all).toBe(1);
  });
  it('pages, and answers an empty page past the end with the true total', () => {
    const many = Array.from({ length: 30 }, (_, n) => item(`p${String(n).padStart(2, '0')}`, { lastActivityAt: `2026-10-${String(n + 1).padStart(2, '0')}T00:00:00.000Z` }));
    expect(queryProjects(many, q({ page: '2' })).items).toHaveLength(5);
    expect(queryProjects(many, q({ page: '3' }))).toMatchObject({ items: [], total: 30 });
  });
  it('answers zero everything when nothing matches', () => {
    expect(queryProjects(items, q({ q: 'nothing' }))).toEqual({
      items: [], total: 0, facets: { all: 0, attention: 0, running: 0, ready: 0, progress: 0, published: 0 },
    });
  });
});
```

- [ ] **Step 2: Run** `npx vitest run --project shared packages/shared/test/overview-list.test.ts` → FAIL.

- [ ] **Step 3: Implement** — append to `packages/shared/src/overview.ts` (import `DATA_POLICIES`, `ProjectSummarySchema`, `type ProjectSummary` from `./workbench.js`):

```ts
export const NEXT_ACTION_KINDS = [
  'refresh', 'decide', 'brief', 'samples', 'running', 'below_threshold', 'publish', 'start_version', 'continue',
] as const;
// Replace the existing `NextActionKind` union with:
// export type NextActionKind = (typeof NEXT_ACTION_KINDS)[number];

export const OVERVIEW_PHASES = ['prepare', 'draft', 'verify', 'published'] as const;
export const LIST_FILTERS = ['all', 'attention', 'running', 'ready', 'progress', 'published'] as const;
export const LIST_SORTS = ['activity', 'name', 'score', 'samples'] as const;
export const PAGE_SIZES = [25, 50, 100] as const;

export const ProjectListQuerySchema = z
  .object({
    q: z.string().trim().max(100).optional(),
    filter: z.enum(LIST_FILTERS).default('all'),
    phase: z.enum(OVERVIEW_PHASES).optional(),
    policy: z.enum(DATA_POLICIES).optional(),
    sort: z.enum(LIST_SORTS).default('activity'),
    /** Comma-separated project ids (at most 20): only those rows (the list's pinned and recent cards). */
    ids: z
      .string()
      .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean))
      .refine((a) => a.length <= 20, 'at most 20 ids')
      .optional(),
    page: z.coerce.number().int().min(1).default(1),
    size: z.coerce
      .number()
      .int()
      .refine((n) => (PAGE_SIZES as readonly number[]).includes(n), 'size must be 25, 50 or 100')
      .default(25),
  })
  .strict();
export type ProjectListQuery = z.infer<typeof ProjectListQuerySchema>;

export const ProjectListItemSchema = ProjectSummarySchema.extend({
  stages: z.array(z.object({ stage: z.enum(OVERVIEW_STAGES), state: OverviewStateSchema })).length(10),
  phase: z.enum(OVERVIEW_PHASES),
  done: z.number().int().min(0).max(10),
  next: z
    .object({ kind: z.enum(NEXT_ACTION_KINDS), stage: z.enum(OVERVIEW_STAGES).nullable(), label: z.string() })
    .nullable(),
  /** Latest complete holdout score of the draft (else of the live version); null when none. */
  holdoutScore: z.number().nullable(),
  devSamples: z.number().int(),
  holdoutSamples: z.number().int(),
  lastActivityAt: z.string(),
  /** What the facets count (running also covers unfinished runs, which no stage shows). */
  flags: z.object({ attention: z.boolean(), running: z.boolean(), ready: z.boolean() }),
});
export type ProjectListItem = z.infer<typeof ProjectListItemSchema>;

const FacetsSchema = z.object(
  Object.fromEntries(LIST_FILTERS.map((f) => [f, z.number().int()])) as Record<
    (typeof LIST_FILTERS)[number],
    z.ZodNumber
  >,
);
export const ProjectListPageSchema = z.object({
  items: z.array(ProjectListItemSchema),
  total: z.number().int(),
  facets: FacetsSchema,
});
export type ProjectListPage = z.infer<typeof ProjectListPageSchema>;

/** One list row from the same inputs the project page uses. */
export function listItemFrom(input: {
  summary: ProjectSummary;
  inputs: OverviewInputs;
  runsUnfinished: number;
  holdoutScore: number | null;
  devSamples: number;
  holdoutSamples: number;
  lastActivityAt: string;
}): ProjectListItem {
  const entries = overviewStates(input.inputs);
  const { phase, done } = phaseOf(entries, input.inputs.draft);
  const has = (...states: OverviewState[]) => entries.some((e) => states.includes(e.state));
  return {
    ...input.summary,
    stages: entries.map((e) => ({ stage: e.stage, state: e.state })),
    phase,
    done,
    next: nextAction(input.inputs, entries),
    holdoutScore: input.holdoutScore,
    devSamples: input.devSamples,
    holdoutSamples: input.holdoutSamples,
    lastActivityAt: input.lastActivityAt,
    flags: {
      attention: has('stale', 'proposed', 'warn'),
      running: has('running') || input.runsUnfinished > 0 || input.inputs.evaluation.running,
      ready: input.inputs.draft !== null && input.inputs.gate.passes,
    },
  };
}

const inFacet = (f: (typeof LIST_FILTERS)[number], i: ProjectListItem) =>
  f === 'all' ||
  (f === 'attention' && i.flags.attention) ||
  (f === 'running' && i.flags.running) ||
  (f === 'ready' && i.flags.ready) ||
  (f === 'progress' && i.draft !== null) ||
  (f === 'published' && i.draft === null);

const ORDER: Record<(typeof LIST_SORTS)[number], (a: ProjectListItem, b: ProjectListItem) => number> = {
  activity: (a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt),
  name: (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
  score: (a, b) =>
    a.holdoutScore === b.holdoutScore ? 0 : a.holdoutScore === null ? 1 : b.holdoutScore === null ? -1 : a.holdoutScore - b.holdoutScore,
  samples: (a, b) => a.samples - b.samples,
};

/** Search, phase and policy, then facet counts, the filter chip, the sort and the page (handoff W1). */
export function queryProjects(items: readonly ProjectListItem[], query: ProjectListQuery): ProjectListPage {
  const needle = query.q?.toLowerCase() ?? '';
  const base = items.filter(
    (i) =>
      (needle === '' || i.name.toLowerCase().includes(needle) || i.id.toLowerCase().includes(needle)) &&
      (query.ids === undefined || query.ids.includes(i.id)) &&
      (query.phase === undefined || i.phase === query.phase) &&
      (query.policy === undefined || i.dataPolicy === query.policy),
  );
  const facets = Object.fromEntries(
    LIST_FILTERS.map((f) => [f, base.filter((i) => inFacet(f, i)).length]),
  ) as ProjectListPage['facets'];
  const sorted = base
    .filter((i) => inFacet(query.filter, i))
    .sort((a, b) => ORDER[query.sort](a, b) || a.id.localeCompare(b.id));
  const start = (query.page - 1) * query.size;
  return { items: sorted.slice(start, start + query.size), total: sorted.length, facets };
}
```

(`samples` sort: the test expects alpha (6 samples per `summary`) … — `summary()` gives every item `samples: 6`, so set `samples` in the three test items' summaries to `1`, `7`, `4` respectively when you make the test concrete, matching `devSamples + holdoutSamples`; keep the expected order alpha, gamma, beta.)

- [ ] **Step 4: Run** the shared tests → PASS; `npm run typecheck && npm run lint`; prettier.
- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/overview.ts packages/shared/test/overview-list.test.ts
git commit -m "Workbench list: shared list rows, query, facets and paging"
```

---

### Task 2: Migration 0022 and repo support (fingerprints, list cache, pins)

**Files:**
- Create: `db/migrations/0022_workbench_list.sql`
- Modify: `apps/api/src/workbench/repo.ts` (interface + `MemoryWorkbenchRepo` + `PgWorkbenchRepo`)
- Test: `apps/api/test/workbench-list-repo.test.ts` (Memory, create); `apps/api/test/integration/workbench-pg.test.ts` (Pg, extend)

**Interfaces:**
- Produces on `WorkbenchRepo`:
  - `projectFingerprints(): Promise<{ id: string; fingerprint: string; lastActivityAt: string }[]>`
  - `listCache(): Promise<Map<string, { fingerprint: string; item: unknown }>>`
  - `putListCache(projectId: string, fingerprint: string, item: unknown): Promise<void>` (upsert; a missing project is ignored, not an error)
  - `listPins(owner: string): Promise<string[]>` (pinned_at desc), `pin(owner, projectId): Promise<boolean>` (false: unknown project), `unpin(owner, projectId): Promise<void>`

Migration:

```sql
-- Workbench project list (redesign W1/W3): a per-project cache of the list row, kept under a
-- fingerprint of the project's data (recomputed when it changes), and per-token pins.
CREATE TABLE workbench_list_cache (
  project_id   text        PRIMARY KEY REFERENCES workbench_projects (id) ON DELETE CASCADE,
  fingerprint  text        NOT NULL,
  item         jsonb       NOT NULL,
  computed_at  timestamptz NOT NULL DEFAULT now()
);

-- owner: the access token id (the bootstrap admin token is recreated on every start, so its
-- pins reset then), or 'local' when access control is off.
CREATE TABLE workbench_pins (
  owner       text        NOT NULL,
  project_id  text        NOT NULL REFERENCES workbench_projects (id) ON DELETE CASCADE,
  pinned_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (owner, project_id)
);
```

**Fingerprint (Pg)** — one query over `workbench_projects` with `LEFT JOIN` grouped aggregates; the fingerprint is `md5(concat_ws('|', …))` of every value below, and `lastActivityAt` is the `greatest(...)` of the activity timestamps (project `created_at`, jobs `updated_at`, samples `created_at`, proposals `created_at`/`decided_at`, skips, briefs, iterations, publications, feedback). Before writing it, read the columns of each table in `db/migrations/*.sql` and include, per project:
- the project row: `data_policy`, `data_policy_changed_at`, `publish_threshold`, `threshold_set_at`, `name`;
- `jobs` with `project_id = p.id` (all tasks, incl. document-less draft/segment/export): `count(*)`, `max(updated_at)`;
- `workbench_samples`: `count(*)`, count of `role = 'holdout'`, `max(created_at)`, and a `string_agg(id || role, ',' ORDER BY id)` (role switches change it);
- `workbench_proposals`: `count(*)`, `max(created_at)`, `max(decided_at)`, `count(decision)`;
- `workbench_stage_skips`: `count(*)`, `max(skipped_at)`;
- `workbench_briefs`: `max(version)`;
- `workbench_iterations`: `count(*)`, `max(created_at)`, `count(scores)`, `count(gate_cache)`;
- `workbench_publications`: `count(*)`, `max(published_at)`;
- `workbench_feedback`: `count(*)`, `count(resolved_by)`, `max(created_at)`;
- `templates` with `id = p.id`: `count(*)`, `max(updated_at)`, `string_agg(version || status, ',' ORDER BY version)`;
- `template_references` with `template_id = p.id`: `count(*)`, `max(created_at)`, `count(superseded_at)`.
Add indexes only if `EXPLAIN` on 1,000 seeded projects shows a sequential scan dominating (record the plan in the report; `jobs(project_id)` likely exists already).

**Memory** — `projectFingerprints` builds the same idea from the in-memory maps (a JSON string of the relevant records' ids, statuses and timestamps, hashed with `createHash('md5')`); `lastActivityAt` the max of the same timestamps (or the project's `createdAt`).

- [ ] **Step 1: Write the failing tests**
  - `apps/api/test/workbench-list-repo.test.ts` (Memory, via `testApp()`'s `ctx.workbench`): fingerprints list every project; a fingerprint changes after each of: adding a sample, switching its role, a job status change (`ctx.repo.jobs.set`), saving a brief, a template draft edit (`ctx.templates.updateDraft`), a threshold change, skipping a stage, recording a publication, adding feedback; it does **not** change when nothing changed; `lastActivityAt` moves forward after adding a sample. `putListCache` then `listCache` round-trips; `putListCache` for an unknown project is a no-op. Pins: `pin` → `listPins` newest first; `pin` of an unknown project → `false`; `unpin` twice is fine; deleting the project (`deleteProject`) removes its pins and cache row.
  - `apps/api/test/integration/workbench-pg.test.ts` — the same fingerprint-change checklist (one assertion per input, including a `template_references` insert and supersede, and a feedback resolve), the cache upsert, pins and the cascade on project delete, against `PgWorkbenchRepo` (follow the file's existing setup: it applies `db/migrations` to `IH_TEST_DATABASE_URL` and skips when unset).
  Run the Memory test → FAIL. (Run the Pg test with a throwaway container: `docker run --rm -d --name ih-test-pg -e POSTGRES_PASSWORD=test -p 55433:5432 postgres:17-alpine`, `IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55433/postgres npx vitest run --config apps/api/vitest.integration.config.ts workbench-pg` → FAIL; stop the container afterwards with `docker stop ih-test-pg`. Never point it at the dev-infra database.)

- [ ] **Step 2: Implement** the migration and both repos. In `MemoryWorkbenchRepo.deleteProject`, also drop the project's cache row and pins.

- [ ] **Step 3: Run** both tests → PASS; `npx vitest run --project api`; typecheck/lint/prettier.

- [ ] **Step 4: Commit**

```bash
git add db/migrations/0022_workbench_list.sql apps/api/src/workbench/repo.ts apps/api/test/workbench-list-repo.test.ts apps/api/test/integration/workbench-pg.test.ts
git commit -m "Workbench list: fingerprints, a list-row cache and pins (migration 0022)"
```

---

### Task 3: The paged list route

**Files:**
- Modify: `apps/api/src/routes/workbench-overview.ts` (export `projectListItem`), `apps/api/src/routes/workbench.ts` (`GET /workbench/projects`), `apps/web/src/api/client.ts` (`listProjects` → `?all=1`), `apps/web/test/client.test.ts`
- Create: `apps/api/src/workbench/list.ts` (`listProjectsPage(app, query)`, `refreshListCache(app)`)
- Regenerate: `docs/openapi.json`
- Test: `apps/api/test/workbench-list.test.ts` (create)

**Interfaces:**
- Consumes: Task 1 (`ProjectListQuerySchema`, `ProjectListPageSchema`, `listItemFrom`, `queryProjects`), Task 2 repo methods, `projectOverview` internals.
- Produces:
  - In `workbench-overview.ts`: refactor so the inputs are reusable — `overviewParts(app, project)` returns `{ overview, inputs, runs, samples }` (what `projectOverview` computes today) and `projectOverview` returns `overviewParts(...).overview`; `projectListItem(app, project, lastActivityAt): Promise<ProjectListItem>` builds the row with `listItemFrom` (`summary` from `overview.project` + sample count; `runsUnfinished` from the runs counts; `holdoutScore` = `gate.score` with an open draft, else the newest own-model (`model === null`) holdout iteration of the live version that has cached `scores` → its score, else null; `devSamples`/`holdoutSamples` by role).
  - `refreshListCache(app): Promise<ProjectListItem[]>`: read fingerprints and the cache; for each project whose cached fingerprint differs (or is missing), compute `projectListItem` with at most 8 in flight, `putListCache(id, fingerprintReadBeforeCompute, item)`; a project gone by then is skipped; return every current row (parsed with `ProjectListItemSchema`; a cache row that fails to parse counts as stale).
  - `listProjectsPage(app, query)` = `queryProjects(await refreshListCache(app), query)`.
  - Route: `GET /workbench/projects` — if `req.query.all === '1'` keep today's handler (legacy `ProjectSummary[]`); otherwise `ProjectListQuerySchema.safeParse(req.query)` (400 with issues on failure) → `listProjectsPage`. Document both in the route schema (querystring: the list query plus `all`; response 200 as `z.union([ProjectListPageSchema, z.array(ProjectSummarySchema)])` described as "the page; with `all=1` the unpaged list (deprecated)").
  - Web: `httpApi.listProjects()` calls `/api/workbench/projects?all=1` (the Workbench page moves to the paged list in PR 7).

- [ ] **Step 1: Write the failing tests** — `apps/api/test/workbench-list.test.ts` with `testApp()`:
  - three projects (create via `POST /api/workbench/projects`), one with a sample and a brief, one fully published (create, then publish its draft through the templates repo as other tests do, or seed a published template version), one with an external data policy (set via the repo): `GET /api/workbench/projects` → 200, `total: 3`, `facets.all: 3`, `facets.published: 1`, items sorted by last activity, each item valid against `ProjectListItemSchema`.
  - `?q=`, `?policy=external`, `?filter=published`, `?sort=name`, `?size=25&page=2` (empty items, true total).
  - Bad values (`size=30`, `page=0`, `sort=x`, `q` of 101 chars) → 400.
  - `?all=1` → the legacy array (same as before this PR).
  - Cache: after one request, a second request computes nothing (spy on `projectOverview`'s inputs, e.g. `vi.spyOn(app.deps.workbench, 'listProposals')` call count unchanged); after adding a sample to one project, only that project is recomputed (one more `listProposals` call); the changed row reflects it (`devSamples` + 1).
  - Two parallel cold requests (`Promise.all([inject, inject])`) both 200 and the cache holds exactly one row per project.
  - A project deleted after its fingerprint was read but before recompute is skipped (simulate: stub `projectFingerprints` to include an id that `getProject` returns null for) → 200, not listed.
  Run → FAIL.

- [ ] **Step 2: Implement** as described. Keep `projectOverview`'s behaviour and tests unchanged (the refactor is internal).

- [ ] **Step 3: Run** `npx vitest run --project api`, `npx vitest run --project web`, `npm run openapi` then the openapi test without `-u`; typecheck/lint/prettier.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/workbench/list.ts apps/api/src/routes/workbench-overview.ts apps/api/src/routes/workbench.ts apps/api/test/workbench-list.test.ts apps/web/src/api/client.ts apps/web/test/client.test.ts docs/openapi.json
git commit -m "Workbench list: paged, filtered, sorted project list with facets (W1)"
```

---

### Task 4: Pins routes

**Files:**
- Modify: `apps/api/src/routes/workbench.ts` (or a new `apps/api/src/routes/workbench-pins.ts` registered in `app.ts` — prefer the new file)
- Regenerate: `docs/openapi.json`
- Test: `apps/api/test/workbench-pins.test.ts` (create)

**Interfaces:**
- Produces: `GET /api/workbench/pins` → `string[]`; `PUT /api/workbench/pins/:projectId` → 204 / 404 `{ error: 'project not found' }`; `DELETE /api/workbench/pins/:projectId` → 204. Owner = `req.auth?.tokenId ?? 'local'`.

- [ ] **Step 1: Write the failing tests** — with `testApp()` (owner `local`): pin two projects → `GET` lists the newer first; `PUT` an unknown id → 404; `DELETE` twice → 204 both times; deleting a project drops it from pins. With `accessApp()` (see `apps/api/test/helpers.ts`): two tokens see their own pins only. Run → FAIL.
- [ ] **Step 2: Implement** the three documented routes (tags `['Projects & data policy']` or a new `Workbench pins` tag if `TAGS` requires registration — follow `apps/api/src/openapi/document.ts`).
- [ ] **Step 3: Run** api tests, `npm run openapi`, the openapi + access tests; typecheck/lint/prettier.
- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/workbench-pins.ts apps/api/src/app.ts apps/api/src/openapi/document.ts apps/api/test/workbench-pins.test.ts docs/openapi.json
git commit -m "Workbench list: per-token pins (W3)"
```

---

### Task 5: Seed 1,000 projects, the p95 test, docs

**Files:**
- Create: `apps/api/src/workbench/seed.ts` (`seedWorkbenchProjects(pool: pg.Pool, count: number, prefix = 'seed'): Promise<string[]>`), `apps/api/scripts/seed-workbench.ts`, `apps/api/test/integration/workbench-list-perf.test.ts`
- Modify: `apps/api/package.json` (script `seed:workbench`), `CLAUDE.md`, `docs/design/workbench.md`

**Interfaces:**
- `seedWorkbenchProjects` inserts `count` projects with plausible variety directly in SQL (each: a `templates` draft row with a small valid definition — copy the shape `skeleton()` in `apps/api/src/templates/drafts.ts` produces; every 3rd also a published v1; 1–8 samples each with a `documents` row and a succeeded `prepare` job; a brief on half; a few proposals and skips; a holdout iteration with `gate_cache` on some). Ids `${prefix}-0001` … Returns the ids.
- Script: `DATABASE_URL=… npm run seed:workbench -w @ih/api -- 1000` → seeds and prints the count. Refuses without `DATABASE_URL`; prints a warning that it writes rows.

- [ ] **Step 1: Write the test** `apps/api/test/integration/workbench-list-perf.test.ts` (skips unless `IH_TEST_DATABASE_URL`): apply migrations, seed 1,000 projects, build the app with Pg adapters (as `workbench-pg.test.ts` builds its deps; object store = `MemoryObjectStore` with the seeded triage written, or tolerate missing triage), warm the cache with one `GET /api/workbench/projects`, then run 40 requests mixing `sort`/`filter`/`q`/`page`, touching 3 random projects between every 10 (update a job's `updated_at`) so a few rows recompute; measure each with `performance.now()`; assert p95 < 200 ms; log p50/p95/max. Also assert the warm-up finished (no time bound on the first request, but log it).
- [ ] **Step 2: Run** it against a throwaway container (as in Task 2) → it must pass; record the timings in the report. If p95 ≥ 200 ms, profile (`EXPLAIN ANALYZE` of the fingerprint query, count of recomputes) and add the narrowest index or batching that fixes it — note it in the report.
- [ ] **Step 3: Implement** the seed module and script; add `"seed:workbench": "tsx scripts/seed-workbench.ts"` (or the runner the package already uses for scripts — check `apps/api/package.json`).
- [ ] **Step 4: Docs** — CLAUDE.md Workbench bullet: one paragraph on the list (W1 query, facets, `workbench_list_cache` keyed by `projectFingerprints`, recompute-on-change with 8 in flight, `?all=1` legacy, pins per token (`workbench_pins`, bootstrap admin pins reset on restart), seed script, the perf test and how to run it). `docs/design/workbench.md`: a short "Project list (redesign)" section. Add the migration to the CLAUDE.md contracts table only if it changes a cross-language contract (it does not: the worker never reads these tables).
- [ ] **Step 5: Run** `npm run check`, `npm run format:check`. Commit:

```bash
git add apps/api/src/workbench/seed.ts apps/api/scripts/seed-workbench.ts apps/api/test/integration/workbench-list-perf.test.ts apps/api/package.json CLAUDE.md docs/design/workbench.md
git commit -m "Workbench list: seed 1,000 projects and hold p95 under 200 ms"
```
