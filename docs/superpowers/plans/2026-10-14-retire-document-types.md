# Retire document types: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can **retire** a document type (every version at once) and **unretire** it again. Nothing is deleted: old jobs, results, references and published recipes stay readable. A retired type is hidden from new-work pickers and lists by default, and the API refuses new work for it with a 409 `<title> is retired: unretire it to use it again`.

**Architecture:**

- *Migration 0030* (`db/migrations/0030_document_type_retirements.sql`): one row per retired type id (`type_id` PK, `retired_at`, `retired_by`). No foreign key, so the same table covers database recipes and file-only legacy `spec.yaml` types. Unretiring deletes the row.
- *Shared* (`packages/shared/src/retirement.ts`): `RetirementSchema`, `retiredMessage(title)`. `SpecSummary.retired?`, `ProjectView.retired`, `ProjectListItem.retired`, `ProjectListQuery.retired` (`include`), and `queryProjects` leaves retired rows out unless `retired=include` or `ids` names them.
- *API*: `TemplateRepo` gets `listRetirements/retirement/retire/unretire` (Memory and Pg; `WorkbenchRepo.deleteProject` drops the row of a deleted type). `apps/api/src/templates/retirement.ts` has the guard (`retiredProblem`, the `refuseRetired` preHandler). New admin routes `PUT|DELETE /api/specs/:id/retirement` (tag Specs, `x-admin`, logged). Listings: `GET /api/specs` hides retired types unless `?retired=include`, `GET /api/templates` and every `ProjectView` carry `retired`, and the Workbench list overlays the live retirement on its cached rows (`LIST_CACHE_VERSION` 3 → 4). Refusals cover uploads, retry, recipe create/draft/publish/import, regression, Workbench project creation, bundle import and every Workbench route that queues model or document work.
- *Worker*: **unchanged.** It never reads the table, and jobs already queued or running finish.
- *Web*: client (`listSpecs({ retired })`, `retireType`, `unretireType`, `TemplateListItem.retired`), `ui/retired.ts` + `ui/RetiredBanner.tsx`, the Document types page (Show retired, card state, admin Retire…/Unretire), the recipe editor (banner, Publish and Try on blocked), the Workbench list (Show retired, Retired tag), and the project page (banner with admin Unretire, every job-creating button disabled with a reason).

**Tech Stack:** Zod (shared), Fastify + OpenAPI route docs, PostgreSQL 17, React 19, Vitest + Testing Library, CSS on existing `--ih-*` tokens.

**Spec:** the feature request in this session (no design doc). Conventions: `CLAUDE.md` (TDD, forward-only migrations, ports and adapters, routes documented, access sweep, terminology).

---

## Decisions for the user (review before execution)

Each choice below is built into the tasks. Flip any of them before execution starts.

| # | Decision | Recommendation (built in) | Alternative |
| --- | --- | --- | --- |
| D1 | **Where the flag lives** | Its own table keyed by type id (`document_type_retirements`), no FK, so legacy `spec.yaml` types can be retired too. Unretire **deletes** the row: the history is only in the API log. | Keep history rows (`unretired_at`, `unretired_by`) for an audit trail. |
| D2 | **`GET /api/specs`** | Hides retired types by default (the route's documented meaning is "available for upload"). `?retired=include` lists them too, each with a `retired` field. Jobs, Home and Results ask with `include`, so old jobs keep their type titles and the Results type filter keeps retired types. | Always list every type with the field and let each picker filter. |
| D3 | **Other listings** | `GET /api/templates` returns every type with `retired` (nullable), and the Document types page filters on the client with a *Show retired* tick box. The Workbench list filters on the server (`retired=include`). When `ids=` names projects (the pinned and recent cards), retired ones are still returned, with their tag. | Hide retired pins too. |
| D4 | **Refused (409) for a retired type** | Document upload (and Templates-page test runs, which use the same route), retry/re-process of **any** job of the type, regression runs, `POST /api/templates` with a retired id (a legacy id), new drafts, publishing (Templates and Workbench routes), YAML import (draft or published), Workbench project creation, bundle import under that id, sample upload, dev test runs, every drafting stage (survey, outputs, sections, steps, references, revise), holdout reference runs, re-verify, evaluate, compare. | — |
| D5 | **Allowed for a retired type** | Reading everything. Edits that queue no job: saving the draft, the brief, feedback, deciding proposals, skip/keep a stage, restoring an iteration, data policy, threshold, sample role. Deleting drafts, samples, jobs, references and the (never-published) project. Cancel. **Review of jobs already awaiting review**: approve (which delivers production outputs), reject, step re-run. Saving a reference from a finished run. **Anchor previews** (segment jobs: no model call, no document, one per project) and **bundle export** (an archive). | Refuse previews and step re-runs too (then the Sections tab needs disabling as well). |
| D6 | **Jobs already queued or running** | They finish. The worker is not changed: retiring is a "no new work" switch, not a kill switch. Cancel stays available. | A worker check at claim time (needs a Python reader of the table and a new job outcome). |
| D7 | **Retire with an open draft or a Workbench project** | Allowed. The project page shows a retired banner (with *Unretire* for admins) and every job-creating action is disabled with the reason. | Refuse retiring while a draft is open. |
| D8 | **Idempotency** | Retiring a retired type answers 200 with the **first** retirement (who/when unchanged, nothing logged). Unretiring a type that is not retired is a 204. An unknown type is a 404 for both. | 409 on a repeated retire. |
| D9 | **Seeding** | `seedTemplates` still imports a missing `specs/<id>/v<N>/template.yaml` version (published), and the type **stays retired**: the flag lives with the type, not the version, and seeding never touches the table. Pinned by a test. | Skip seeding retired types. |
| D10 | **Legacy `spec.yaml` types** | Retirable through the API (`PUT /api/specs/:id/retirement` accepts any id in the registry or the database), and then hidden from uploads and refused like any type. **No UI button**: the Document types page lists database recipes only. | List file-only types on the Document types page (read-only cards with Retire). **Needs your input.** |
| D11 | **Deleting a never-published Workbench project** | Also deletes its retirement row (the type is gone; a stale row would block reusing the id). | Keep the row. |
| D12 | **No reason field** | Retire takes no body (YAGNI). The type shows "Retired by X on 14 Oct 2026". | An optional `reason` (1-200 chars) shown on the card and banner. |
| D13 | **Retry buttons** | Jobs page *Retry…/Re-process…*, Runs tab *Retry* and the Samples tab's prepare retry are **not** pre-disabled (the job lists do not know which types are retired); the re-process dialog keeps the 409 on screen. The Document types card, the recipe editor and the Workbench project page disable their own job-creating buttons with a reason. | Feed the retired ids to `JobActions` too. |
| D14 | **API path** | `PUT /api/specs/:id/retirement` (retire) and `DELETE /api/specs/:id/retirement` (unretire), tag *Specs*, since a type may be a legacy spec. | `/api/document-types/:id/retire` (a new tag). |

**Needs your input before building:** D10 (do legacy types need a UI?), D5 (is approving an already-awaiting production job of a retired type, which delivers to the target, acceptable?), D14 (path naming).

---

## Global Constraints

- **Terminology:** users see **document type** for the type and **recipe** for a template. New UI text says "retired", "Retire…", "Unretire", never "archive". Code names, API paths and tables keep `template`/`spec`.
- **Model names, never refs** in normal-user UI (no change expected here; do not print refs in banners or titles).
- **The refusal text is exact:** `retiredMessage(title)` = `` `${title} is retired: unretire it to use it again` ``, where `title` is the newest recipe's `name`, else the legacy spec's `title`, else the id. Every refusal is a **409**.
- **Disabled buttons carry a `title` reason (tested):** the reason is `RETIRED_REASON` = `This document type is retired: an admin can unretire it on the Document types page` (`apps/web/src/ui/retired.ts`). A retired reason wins over any other reason for the same button.
- **`.card` has no padding.** This plan adds no new padded card. The banner reuses `.stale-banner` (`data-tone="skip"`); the list tag extends the existing `.ext-tag` rule in `apps/web/src/styles/stages.css` (do not duplicate its declarations). Existing tokens only (`--ih-skip-bg`, `--ih-skip-fg`).
- **Testing Library by role and label**, never class names, except where an existing test in that file already does.
- **Admin-only routes:** the check runs in a `preHandler` before anything else (so the OpenAPI `x-admin` test sees `403 admins only` for a user, whatever the id), the route is marked `'x-admin': true`, and documents `403`.
- **Every route documented**; every new or changed response status is in the route's `response` (the conformance check runs in every API test). Run `npm run openapi` and commit `docs/openapi.json` in each task that changes a route.
- **Migration** is `0030_document_type_retirements.sql` (highest existing is 0029). Forward-only.
- **Cross-language contracts:** none. The worker never reads `document_type_retirements` (the CLAUDE.md table says so, Task 10).
- **Pg integration:** `docker run --rm -d --name ih-test-pg-retire -e POSTGRES_PASSWORD=test -p 55448:5432 postgres:17-alpine`, then `IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55448/postgres npx vitest run --config apps/api/vitest.integration.config.ts workbench-pg`, then `docker rm -f ih-test-pg-retire`.
- Tests first (red, then green); `npm run check` green at the end; never `git add -A` (stage the files each task names); commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A retired type reached by another door.** The guard is per route, so a new job-creating route added later could forget it. Task 6's table test lists every Workbench POST that queues a job and asserts that no job of any kind (process, prepare, draft) was created; Task 5 does the same for uploads, retry and regression. A reviewer should grep `createDocumentAndJob|createWorkbenchJob|createDraftJob|createRegressionJob|retryJob|addSampleFile` and check each caller is guarded or listed as allowed in D5.
2. **Seeding after a retire.** A deploy that adds `specs/<id>/v<N+1>/template.yaml` for a retired type seeds the version but must leave the type retired and hidden (Task 4 test, D9).
3. **Old jobs keep their names.** Jobs, Home and Results read titles from `GET /api/specs`; with retired types hidden by default they must ask with `?retired=include`, or every old job of a retired type would show its raw id (Task 7 tests).
4. **The cached Workbench list after a retire.** Retiring changes no table the list fingerprint reads, so the retirement is overlaid on every request instead of cached; a retire or unretire shows on the next list request without recomputing rows (Task 4 test: retire, list, unretire, list).
5. **Retire racing a deleted project, or a double click.** Retiring twice keeps the first retirement and logs once (D8, Pg test with two concurrent `retire` calls); deleting a never-published project removes its retirement in the same transaction (Task 2 Pg test).

## Deviations and notes

- The web never pre-disables Retry buttons (D13); the API's 409 is shown in the re-process dialog.
- Anchor previews and bundle export stay allowed (D5), so the Sections tab and the Brief tab's export panel are unchanged.
- The Templates-page standalone editor shows the banner and blocks Publish; its Test rail and Run regression are not pre-disabled (their errors show the 409).

---

## File map

| File | Change |
| --- | --- |
| `packages/shared/src/retirement.ts` | Create: `RetirementSchema`, `retiredMessage` |
| `packages/shared/src/index.ts` | export it |
| `packages/shared/src/spec.ts` | `SpecSummarySchema.retired` (optional) |
| `packages/shared/src/workbench.ts` | `ProjectViewSchema.retired` |
| `packages/shared/src/overview.ts` | `ProjectListItemSchema.retired`, `ProjectListQuerySchema.retired`, `listItemFrom`, `queryProjects` |
| `packages/shared/test/retirement.test.ts` | Create |
| `packages/shared/test/overview-list.test.ts` | retired rows |
| `db/migrations/0030_document_type_retirements.sql` | Create |
| `apps/api/src/templates/repo.ts` | `TemplateRepo` retirement methods (Memory + Pg) |
| `apps/api/src/workbench/repo.ts` | `deleteProject` removes the retirement |
| `apps/api/src/templates/retirement.ts` | Create: `typeExists`, `typeTitle`, `retiredProblem`, `refuseRetired`, `RETIRED_DOC` |
| `apps/api/src/routes/specs.ts` | retire/unretire routes; `?retired=include` |
| `apps/api/src/templates/definitions.ts` | `listDefinitions(deps, { includeRetired })` |
| `apps/api/src/routes/templates.ts` | `retired` on the list; refusals (create, drafts, publish, import) |
| `apps/api/src/routes/workbench.ts` | `projectView.retired`; refusals |
| `apps/api/src/workbench/list.ts` | overlay; `LIST_CACHE_VERSION = 4` |
| `apps/api/src/routes/{documents,jobs,references,workbench-bundle}.ts` | refusals |
| `apps/api/src/openapi/document.ts` | Specs tag text |
| `apps/api/test/retirement-repo.test.ts`, `retirement.test.ts`, `retirement-refusals.test.ts`, `workbench-retired.test.ts` | Create |
| `apps/api/test/{templates,workbench-delete,workbench-bundle}.test.ts`, `apps/api/test/integration/workbench-pg.test.ts` | tests |
| `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/test/client.test.ts` | client |
| `apps/web/src/ui/retired.ts`, `apps/web/src/ui/RetiredBanner.tsx` | Create |
| `apps/web/src/{home/HomePage,jobs/JobsPage,results/ResultsPage,jobs/UploadStrip}.tsx` | `listSpecs` |
| `apps/web/src/templates/{TemplatesPage,TemplateCard,TemplateEditor,EditorHeader,EmbeddedHeader,TryOn,editor-derive}.tsx/.ts`, `apps/web/src/App.tsx` | Document types page and editor |
| `apps/web/src/workbench/{WorkbenchPage,ProjectTable}.tsx` | list |
| `apps/web/src/workbench/{ProjectPage,ProjectHeader,SamplesTab,RunsTab,ReferencesTab,EvaluateTab,GateCard,StagePanel,SurveyTab,ReviseTab}.tsx` | project page |
| `apps/web/src/styles/stages.css` | `.retired-tag` |
| `apps/web/test/*.test.tsx` | tests named per task |
| `CLAUDE.md`, `docs/openapi.json` | docs |

---

### Task 1: Shared schemas (retirement, summaries, project list)

**Files:**
- Create: `packages/shared/src/retirement.ts`, `packages/shared/test/retirement.test.ts`
- Modify: `packages/shared/src/index.ts`, `packages/shared/src/spec.ts`, `packages/shared/src/workbench.ts`, `packages/shared/src/overview.ts`, `packages/shared/test/overview-list.test.ts`, `apps/web/test/fake-api.ts`

**Interfaces:**
- Produces: `RetirementSchema` / `type Retirement = { retiredAt: string; retiredBy: string | null }`; `retiredMessage(title: string): string`; `SpecSummary.retired?: Retirement`; `ProjectView.retired: Retirement | null`; `ProjectListItem.retired: Retirement | null` (`listItemFrom` always sets `null`; the API overlays the live value); `ProjectListQuery.retired?: 'include'`.
- Consumed by: every later task.

- [ ] **Step 1: Write the failing tests**

Create `packages/shared/test/retirement.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  ProjectViewSchema,
  RetirementSchema,
  SpecSummarySchema,
  retiredMessage,
} from '../src/index.js';

const retirement = { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' };

describe('retirement', () => {
  it('words the refusal every route answers', () => {
    expect(retiredMessage('Supplier invoice')).toBe(
      'Supplier invoice is retired: unretire it to use it again',
    );
  });

  it('parses a retirement, with or without who', () => {
    expect(RetirementSchema.parse(retirement)).toEqual(retirement);
    expect(RetirementSchema.safeParse({ ...retirement, retiredBy: null }).success).toBe(true);
    expect(RetirementSchema.safeParse({ retiredBy: 'ken' }).success).toBe(false);
  });

  it('lists a document type with its retirement only when retired', () => {
    const summary = { id: 'letter', version: 1, title: 'Letter' };
    expect(SpecSummarySchema.parse(summary)).toEqual(summary);
    expect(SpecSummarySchema.parse({ ...summary, retired: retirement }).retired).toEqual(
      retirement,
    );
  });

  it('requires the retirement on a project view (null when active)', () => {
    const view = {
      project: {
        id: 'letter',
        name: 'Letter',
        createdAt: '2026-10-01T00:00:00.000Z',
        dataPolicy: 'local',
        dataPolicyChangedAt: null,
        dataPolicyChangedBy: null,
        publishThreshold: 0.9,
        thresholdSetBy: null,
        thresholdSetAt: null,
      },
      draft: 1,
      published: null,
      brief: null,
    };
    expect(ProjectViewSchema.safeParse(view).success).toBe(false);
    expect(ProjectViewSchema.safeParse({ ...view, retired: null }).success).toBe(true);
    expect(ProjectViewSchema.safeParse({ ...view, retired: retirement }).success).toBe(true);
  });
});
```

Append to `packages/shared/test/overview-list.test.ts` (it already defines `item`, `q` and `summary`):

```ts
describe('retired projects', () => {
  const retirement = { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' };
  const items: ProjectListItem[] = [item('alpha'), { ...item('beta'), retired: retirement }];
  const ids = (page: ReturnType<typeof queryProjects>) => page.items.map((i) => i.id);

  it('leaves the retirement null in a derived row (the API overlays the live one)', () => {
    expect(item('alpha').retired).toBeNull();
  });
  it('leaves retired projects out by default, from the facets too', () => {
    const page = queryProjects(items, q());
    expect(ids(page)).toEqual(['alpha']);
    expect(page.total).toBe(1);
    expect(page.facets.all).toBe(1);
  });
  it('lists them with retired=include', () => {
    const page = queryProjects(items, q({ retired: 'include' }));
    expect(ids(page)).toEqual(['alpha', 'beta']);
    expect(page.facets.all).toBe(2);
  });
  it('lists them when ids names them (pinned and recent cards)', () => {
    expect(ids(queryProjects(items, q({ ids: 'beta' })))).toEqual(['beta']);
  });
  it('refuses any other retired value', () => {
    expect(ProjectListQuerySchema.safeParse({ retired: 'only' }).success).toBe(false);
  });
});
```

(If the file has no `q` helper, add `const q = (raw: Record<string, string> = {}) => ProjectListQuerySchema.parse(raw);` at the top; it already exists as of #96.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run packages/shared/test/retirement.test.ts packages/shared/test/overview-list.test.ts`
Expected: FAIL: `retiredMessage` / `RetirementSchema` are not exported; `retired` is not a known query key.

- [ ] **Step 3: Implement**

Create `packages/shared/src/retirement.ts`:

```ts
import { z } from 'zod';

/**
 * A retired document type (migration 0030): hidden from new work (uploads, test runs, drafting,
 * publishing), every version still readable. Keyed by type id, so legacy spec.yaml types too.
 */
export const RetirementSchema = z.object({
  retiredAt: z.string().describe('When an admin retired the document type.'),
  retiredBy: z
    .string()
    .nullable()
    .describe('The label of the token that retired it; null without access control.'),
});
export type Retirement = z.infer<typeof RetirementSchema>;

/** The 409 every route that would start new work for a retired document type answers. */
export const retiredMessage = (title: string) =>
  `${title} is retired: unretire it to use it again`;
```

In `packages/shared/src/index.ts`, add after `export * from './spec.js';`:

```ts
export * from './retirement.js';
```

In `packages/shared/src/spec.ts`, import `import { RetirementSchema } from './retirement.js';` at the top and add to `SpecSummarySchema` after `model`:

```ts
  /** Set only for a retired document type, listed with `GET /api/specs?retired=include`. */
  retired: RetirementSchema.optional().describe(
    'Set only for a retired document type (listed with `?retired=include`).',
  ),
```

In `packages/shared/src/workbench.ts`, import `RetirementSchema` from `./retirement.js` and add to `ProjectViewSchema` after `brief`:

```ts
  /** The document type is retired: nothing new runs for it (null when it is not). */
  retired: RetirementSchema.nullable(),
```

In `packages/shared/src/overview.ts` (import `RetirementSchema` from `./retirement.js`):

1. `ProjectListQuerySchema`: add after `policy`:

```ts
    /** `include`: list retired document types too (default: left out unless `ids` names them). */
    retired: z.enum(['include']).optional(),
```

2. `ProjectListItemSchema`: add after `flags`:

```ts
  /** Live, never cached: the list route overlays it on every request (null when active). */
  retired: RetirementSchema.nullable(),
```

3. `listItemFrom`: add `retired: null,` to the returned object (after `lastActivityAt`).

4. `queryProjects`: replace the `base` filter with:

```ts
  // Retired projects only when asked for, or when named (the pinned and recent cards).
  const showRetired = query.retired === 'include' || query.ids !== undefined;
  const base = items.filter(
    (i) =>
      (showRetired || i.retired === null) &&
      (needle === '' ||
        i.name.toLowerCase().includes(needle) ||
        i.id.toLowerCase().includes(needle)) &&
      (query.ids === undefined || query.ids.includes(i.id)) &&
      (query.phase === undefined || i.phase === query.phase) &&
      (query.policy === undefined || i.dataPolicy === query.policy),
  );
```

In `apps/web/test/fake-api.ts`: add `retired: null,` to the object returned by `projectView()` (after `brief: null`) and by `projectListItem()`.

- [ ] **Step 4: Run the tests, then the type check**

Run: `npx vitest run packages/shared/test` then `npm run typecheck`
Expected: PASS. If `npm run typecheck` reports a `ProjectView`/`ProjectListItem` literal without `retired` in `apps/api/src`, it is `projectView()` in `apps/api/src/routes/workbench.ts`: leave it for Task 4 by adding `retired: null` there now (Task 4 replaces it with the live value).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/retirement.ts packages/shared/src/index.ts packages/shared/src/spec.ts packages/shared/src/workbench.ts packages/shared/src/overview.ts packages/shared/test/retirement.test.ts packages/shared/test/overview-list.test.ts apps/web/test/fake-api.ts apps/api/src/routes/workbench.ts
git commit -m "$(cat <<'EOF'
Shared: document type retirement schema and retired project list rows

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Migration 0030 and the retirement store

**Files:**
- Create: `db/migrations/0030_document_type_retirements.sql`, `apps/api/test/retirement-repo.test.ts`
- Modify: `apps/api/src/templates/repo.ts`, `apps/api/src/workbench/repo.ts`, `apps/api/test/integration/workbench-pg.test.ts`

**Interfaces:**
- Produces on `TemplateRepo` (Memory and Pg):
  - `listRetirements(): Promise<Map<string, Retirement>>`
  - `retirement(id: string): Promise<Retirement | null>`
  - `retire(id: string, by: string | null): Promise<{ retirement: Retirement; created: boolean }>` (an already retired type keeps its first retirement, `created: false`)
  - `unretire(id: string): Promise<boolean>` (false when it was not retired)
  - `MemoryTemplateRepo.retirements: Map<string, Retirement>` (tests)
- `WorkbenchRepo.deleteProject(id)` also deletes the type's retirement (D11).

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/retirement-repo.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { MemoryTemplateRepo } from '../src/templates/repo.js';
import { testApp } from './helpers.js';

describe('MemoryTemplateRepo retirements', () => {
  it('retires once, keeps the first retirement, and unretires', async () => {
    const repo = new MemoryTemplateRepo();
    expect(await repo.retirement('letter')).toBeNull();
    const first = await repo.retire('letter', 'ken');
    expect(first).toEqual({
      created: true,
      retirement: { retiredAt: expect.any(String), retiredBy: 'ken' },
    });
    const again = await repo.retire('letter', 'someone else');
    expect(again).toEqual({ created: false, retirement: first.retirement });
    expect([...(await repo.listRetirements())]).toEqual([['letter', first.retirement]]);
    expect(await repo.unretire('letter')).toBe(true);
    expect(await repo.unretire('letter')).toBe(false);
    expect(await repo.retirement('letter')).toBeNull();
  });

  it('is removed with a deleted never-published project (D11)', async () => {
    const { app, templates, workbench } = await testApp();
    await app.inject({
      method: 'POST',
      url: '/api/workbench/projects',
      payload: { id: 'letter', name: 'Letter' },
    });
    await templates.retire('letter', 'ken');
    expect(await workbench.deleteProject('letter')).not.toBeNull();
    expect(await templates.retirement('letter')).toBeNull();
  });
});
```

Append to `apps/api/test/integration/workbench-pg.test.ts`, inside the top-level `describe.skipIf(!url)(…)`:

```ts
  it('retires and unretires a document type (migration 0030)', async () => {
    const id = `it-${randomUUID().slice(0, 8)}`;
    expect(await templates.retirement(id)).toBeNull();
    // Two concurrent retires: one row, both answer the same retirement, one is "created".
    const [a, b] = await Promise.all([templates.retire(id, 'ken'), templates.retire(id, 'ann')]);
    expect([a.created, b.created].sort()).toEqual([false, true]);
    expect(a.retirement).toEqual(b.retirement);
    expect((await templates.listRetirements()).get(id)).toEqual(a.retirement);
    expect(await templates.unretire(id)).toBe(true);
    expect(await templates.unretire(id)).toBe(false);
  });

  it('deletes the retirement with a never-published project (D11)', async () => {
    const projectId = await newProject();
    await templates.create(projectId, 1, { id: projectId, version: 1, name: 'x' }, 'draft');
    await templates.retire(projectId, 'ken');
    expect(await workbench.deleteProject(projectId)).not.toBeNull();
    expect(await templates.retirement(projectId)).toBeNull();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/api/test/retirement-repo.test.ts`
Expected: FAIL: `repo.retirement is not a function`.

- [ ] **Step 3: Implement**

Create `db/migrations/0030_document_type_retirements.sql`:

```sql
-- Retired document types: hidden from new work (uploads, test runs, drafting, publishing) and
-- refused by the API with a 409, while every version, job, result and reference stays readable.
-- One row per retired type id. No foreign key: a type is a database recipe (templates) or a
-- file-only legacy spec.yaml. Unretiring deletes the row (who and when are in the API log).
-- Read by the API only: the worker never reads it, so jobs already queued finish.
CREATE TABLE document_type_retirements (
  type_id    text        PRIMARY KEY,
  retired_at timestamptz NOT NULL DEFAULT now(),
  retired_by text
);
```

In `apps/api/src/templates/repo.ts`:

1. Import: `import type { Retirement, TemplateChange, TemplateChangeInput } from '@ih/shared';` (replacing the existing type import).

2. Add to `interface TemplateRepo` after `listChanges`:

```ts
  /** Retired document types by id (migration 0030); a type is a recipe or a legacy spec. */
  listRetirements(): Promise<Map<string, Retirement>>;
  retirement(id: string): Promise<Retirement | null>;
  /** Retires the type; one already retired keeps its first retirement (`created` false). */
  retire(id: string, by: string | null): Promise<{ retirement: Retirement; created: boolean }>;
  /** False when the type was not retired. */
  unretire(id: string): Promise<boolean>;
```

3. In `MemoryTemplateRepo`, add the field after `changes`:

```ts
  /** document_type_retirements, by type id. */
  readonly retirements = new Map<string, Retirement>();
```

and the methods after `listChanges`:

```ts
  async listRetirements() {
    return new Map(this.retirements);
  }

  async retirement(id: string) {
    return this.retirements.get(id) ?? null;
  }

  async retire(id: string, by: string | null) {
    const existing = this.retirements.get(id);
    if (existing) return { retirement: existing, created: false };
    const retirement: Retirement = { retiredAt: this.now(), retiredBy: by };
    this.retirements.set(id, retirement);
    return { retirement, created: true };
  }

  async unretire(id: string) {
    return this.retirements.delete(id);
  }
```

4. Above `PgTemplateRepo`, add:

```ts
interface RetirementRow {
  type_id: string;
  retired_at: Date;
  retired_by: string | null;
}

const toRetirement = (r: RetirementRow): Retirement => ({
  retiredAt: r.retired_at.toISOString(),
  retiredBy: r.retired_by,
});
```

and to `PgTemplateRepo` after `listChanges`:

```ts
  async listRetirements() {
    const { rows } = await this.pool.query<RetirementRow>(
      'SELECT type_id, retired_at, retired_by FROM document_type_retirements',
    );
    return new Map(rows.map((r) => [r.type_id, toRetirement(r)]));
  }

  async retirement(id: string) {
    const { rows } = await this.pool.query<RetirementRow>(
      'SELECT type_id, retired_at, retired_by FROM document_type_retirements WHERE type_id = $1',
      [id],
    );
    return rows[0] ? toRetirement(rows[0]) : null;
  }

  async retire(id: string, by: string | null) {
    // The outer SELECT sees the snapshot from before the insert: it answers the existing row
    // only when the insert did nothing.
    const { rows } = await this.pool.query<RetirementRow & { created: boolean }>(
      `WITH ins AS (
         INSERT INTO document_type_retirements (type_id, retired_by) VALUES ($1, $2)
         ON CONFLICT (type_id) DO NOTHING
         RETURNING type_id, retired_at, retired_by)
       SELECT type_id, retired_at, retired_by, true AS created FROM ins
       UNION ALL
       SELECT type_id, retired_at, retired_by, false AS created FROM document_type_retirements
        WHERE type_id = $1 AND NOT EXISTS (SELECT 1 FROM ins)`,
      [id, by],
    );
    const row = rows[0];
    if (row) return { retirement: toRetirement(row), created: row.created };
    // A concurrent retire committed after this statement's snapshot: read its row.
    return { retirement: (await this.retirement(id))!, created: false };
  }

  async unretire(id: string) {
    const { rowCount } = await this.pool.query(
      'DELETE FROM document_type_retirements WHERE type_id = $1',
      [id],
    );
    return (rowCount ?? 0) > 0;
  }
```

In `apps/api/src/workbench/repo.ts`:

- `MemoryWorkbenchRepo.deleteProject`: just before `this.projects.delete(id);` add

```ts
    // The type is gone: a stale retirement would block reusing the id (D11).
    this.templates.retirements.delete(id);
```

- `PgWorkbenchRepo.deleteProject`: just before `await client.query('DELETE FROM workbench_projects WHERE id = $1', [id]);` add

```ts
      // The type is gone: a stale retirement would block reusing the id (D11).
      await client.query('DELETE FROM document_type_retirements WHERE type_id = $1', [id]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run apps/api/test/retirement-repo.test.ts apps/api/test/workbench-delete.test.ts`
Expected: PASS.

Then the Pg test (commands in Global Constraints). Expected: the two new tests PASS with the rest of `workbench-pg`.

- [ ] **Step 5: Commit**

```bash
git add db/migrations/0030_document_type_retirements.sql apps/api/src/templates/repo.ts apps/api/src/workbench/repo.ts apps/api/test/retirement-repo.test.ts apps/api/test/integration/workbench-pg.test.ts
git commit -m "$(cat <<'EOF'
API: document_type_retirements (migration 0030) in the template repos

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Retire and unretire routes (admin) and the guard helper

**Files:**
- Create: `apps/api/src/templates/retirement.ts`, `apps/api/test/retirement.test.ts`
- Modify: `apps/api/src/routes/specs.ts`, `apps/api/src/openapi/document.ts`, `docs/openapi.json`

**Interfaces:**
- Consumes: Task 2's `TemplateRepo` retirement methods; `retiredMessage` (Task 1).
- Produces (`apps/api/src/templates/retirement.ts`):
  - `typeExists(deps, id): Promise<boolean>` (a recipe row or a registry definition)
  - `typeTitle(deps, id): Promise<string>`
  - `retiredProblem(deps, id): Promise<string | null>` (the 409 text, or null)
  - `refuseRetired(app): preHandler` (reads `req.params.id`; 409 when retired)
  - `RETIRED_DOC: string` (for route docs)
- Routes: `PUT /api/specs/:id/retirement` → 200 `{ id, retired: Retirement }`; `DELETE /api/specs/:id/retirement` → 204. Both 403 for users, 404 `document type not found`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/retirement.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { accessApp, letter, testApp } from './helpers.js';

const retire = (id: string, cookie?: string) => ({
  method: 'PUT' as const,
  url: `/api/specs/${id}/retirement`,
  ...(cookie ? { headers: { cookie } } : {}),
});
const unretire = (id: string, cookie?: string) => ({
  method: 'DELETE' as const,
  url: `/api/specs/${id}/retirement`,
  ...(cookie ? { headers: { cookie } } : {}),
});

describe('PUT /api/specs/:id/retirement', () => {
  it('retires a recipe type, and a second retire keeps the first (D8)', async () => {
    const { app, templates } = await testApp();
    await templates.create('letter', 1, letter(1), 'published');
    const first = await app.inject(retire('letter'));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({
      id: 'letter',
      retired: { retiredAt: expect.any(String), retiredBy: null },
    });
    const again = await app.inject(retire('letter'));
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual(first.json());
  });

  it('retires a file-only legacy spec type (D10)', async () => {
    const { app, templates } = await testApp();
    expect((await app.inject(retire('demo'))).statusCode).toBe(200);
    expect(await templates.retirement('demo')).not.toBeNull();
  });

  it('answers 404 for an unknown type, for both verbs', async () => {
    const { app } = await testApp();
    for (const req of [retire('nope'), unretire('nope')]) {
      const res = await app.inject(req);
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('document type not found');
    }
  });

  it('records the admin who retired it; users are refused', async () => {
    const { app, templates, adminCookie, userCookie } = await accessApp();
    await templates.create('letter', 1, letter(1), 'published');
    const user = await app.inject(retire('letter', userCookie));
    expect(user.statusCode).toBe(403);
    expect(user.json().error).toBe('admins only');
    expect((await app.inject(unretire('letter', userCookie))).statusCode).toBe(403);
    const me = (await app.inject({ url: '/api/auth/me', headers: { cookie: adminCookie } })).json();
    const res = await app.inject(retire('letter', adminCookie));
    expect(res.json().retired.retiredBy).toBe(me.label);
  });
});

describe('DELETE /api/specs/:id/retirement', () => {
  it('unretires, and answers 204 for a type that is not retired (D8)', async () => {
    const { app, templates } = await testApp();
    await templates.create('letter', 1, letter(1), 'published');
    await app.inject(retire('letter'));
    expect((await app.inject(unretire('letter'))).statusCode).toBe(204);
    expect(await templates.retirement('letter')).toBeNull();
    expect((await app.inject(unretire('letter'))).statusCode).toBe(204);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/api/test/retirement.test.ts`
Expected: FAIL with 404 for every request (no route).

- [ ] **Step 3: Implement**

Create `apps/api/src/templates/retirement.ts`:

```ts
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { retiredMessage } from '@ih/shared';
import type { AppDeps } from '../app.js';

type Deps = Pick<AppDeps, 'templates' | 'specs'>;

/** For route docs: the 409 a retired document type answers. */
export const RETIRED_DOC =
  '`{name} is retired: unretire it to use it again` for a retired document type';

/** A document type is a database recipe (any version) or a file definition in `specs/`. */
export async function typeExists(deps: Deps, id: string): Promise<boolean> {
  return (
    deps.specs.get(id) !== undefined || (await deps.templates.list()).some((r) => r.id === id)
  );
}

/** The name people know a type by: its newest recipe's name, else its spec title, else the id. */
export async function typeTitle(deps: Deps, id: string): Promise<string> {
  const newest = (await deps.templates.list()).filter((r) => r.id === id).at(-1);
  if (newest) return String(newest.definition.name ?? id);
  const file = deps.specs.get(id);
  if (file) return file.kind === 'spec' ? file.spec.title : file.template.name;
  return id;
}

/** The 409 text when the type is retired (no new work for it), else null. */
export async function retiredProblem(deps: Deps, id: string): Promise<string | null> {
  if (!(await deps.templates.retirement(id))) return null;
  return retiredMessage(await typeTitle(deps, id));
}

/**
 * preHandler for routes whose `:id` is a document type (or its Workbench project): a retired
 * type is refused before the body is read, so nothing is queued or written.
 */
export const refuseRetired =
  (app: FastifyInstance) => async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id?: string };
    if (id === undefined) return;
    const problem = await retiredProblem(app.deps, id);
    if (problem) return reply.code(409).send({ error: problem });
  };
```

In `apps/api/src/routes/specs.ts`:

1. Imports: change the shared import to `import { DocumentSpecSchema, RetirementSchema, TemplateSchema } from '@ih/shared';`, add `import type { FastifyReply, FastifyRequest } from 'fastify';`, change the openapi import to `import { error, md, noContent, res } from '../openapi/zod.js';` and add `import { typeExists } from '../templates/retirement.js';`.

2. Above `specRoutes`, add:

```ts
const TypeParams = z.object({ id: z.string().describe('The document type id.') });
const RetirementView = z.object({ id: z.string(), retired: RetirementSchema });
const ADMINS_ONLY = error('`admins only`: the session was opened with a user token.');
const TYPE_NOT_FOUND = error('`document type not found`.');
```

3. Inside `specRoutes`, after the `/specs/:id` route, add:

```ts
  /** Admins only (ADR 0006); `deps.access === null` disables it in unit tests. */
  const adminOnly = async (req: FastifyRequest, reply: FastifyReply) => {
    if (app.deps.access && req.auth?.role !== 'admin') {
      return reply.code(403).send({ error: 'admins only' });
    }
  };

  app.put<{ Params: { id: string } }>(
    '/specs/:id/retirement',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Specs'],
        'x-admin': true,
        operationId: 'retireDocumentType',
        summary: 'Retire a document type',
        description: md`
          Retires every version of a document type (a recipe or a legacy spec). Nothing is
          deleted: its jobs, results, references and versions stay readable, and jobs already
          queued or running finish. It is left out of \`GET /api/specs\` (unless
          \`?retired=include\`) and of the Workbench list (unless \`retired=include\`), and new
          work for it is refused with a 409 \`{name} is retired: unretire it to use it again\`:
          uploads, retries, test and regression runs, new drafts, publishing, imports and the
          Workbench actions that queue jobs. Retiring a retired type keeps its first retirement.
        `,
        params: TypeParams,
        response: {
          200: res('The retirement (the first one when it was already retired).', RetirementView),
          403: ADMINS_ONLY,
          404: TYPE_NOT_FOUND,
        },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      if (!(await typeExists(app.deps, id))) {
        return reply.code(404).send({ error: 'document type not found' });
      }
      const by = req.auth?.label ?? null;
      const { retirement, created } = await app.deps.templates.retire(id, by);
      if (created) req.log.info({ typeId: id, by }, 'document type retired');
      return { id, retired: retirement };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/specs/:id/retirement',
    {
      preHandler: adminOnly,
      schema: {
        tags: ['Specs'],
        'x-admin': true,
        operationId: 'unretireDocumentType',
        summary: 'Unretire a document type',
        description: md`
          Makes a retired document type available again for uploads and new work. A type that is
          not retired is left as it is (still a 204).
        `,
        params: TypeParams,
        response: { 204: noContent('Unretired.'), 403: ADMINS_ONLY, 404: TYPE_NOT_FOUND },
      },
    },
    async (req, reply) => {
      const { id } = req.params;
      if (!(await typeExists(app.deps, id))) {
        return reply.code(404).send({ error: 'document type not found' });
      }
      if (await app.deps.templates.unretire(id)) {
        req.log.info({ typeId: id, by: req.auth?.label ?? null }, 'document type unretired');
      }
      return reply.code(204).send();
    },
  );
```

In `apps/api/src/openapi/document.ts`, replace the `Specs` tag text with:

```ts
  Specs: md`
    Document types as uploads see them: database recipes and the definitions loaded from the
    repository's \`specs/\` folder (legacy \`spec.yaml\` and \`template.yaml\`). Versions are
    immutable once published. An admin can retire a document type (hidden from new work, still
    readable) and unretire it.
  `,
```

- [ ] **Step 4: Run the tests, the OpenAPI and access tests**

Run: `npx vitest run apps/api/test/retirement.test.ts`
Expected: PASS.

Run: `npm run openapi` then `npx vitest run apps/api/test/openapi.test.ts apps/api/test/access.test.ts`
Expected: PASS (the `x-admin` test sees `403 admins only` for both new routes; the sweep sees them guarded).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/templates/retirement.ts apps/api/src/routes/specs.ts apps/api/src/openapi/document.ts apps/api/test/retirement.test.ts docs/openapi.json
git commit -m "$(cat <<'EOF'
API: admins retire and unretire document types

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Listings show or hide retired types; seeding keeps them retired

**Files:**
- Modify: `apps/api/src/templates/definitions.ts`, `apps/api/src/routes/specs.ts`, `apps/api/src/routes/templates.ts`, `apps/api/src/routes/workbench.ts`, `apps/api/src/workbench/list.ts`, `apps/api/test/retirement.test.ts`, `apps/api/test/templates.test.ts`, `docs/openapi.json`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: `listDefinitions(deps, { includeRetired?: boolean })`; `GET /api/specs?retired=include`; `TemplateType.retired: Retirement | null` on `GET /api/templates`; `ProjectView.retired` from `projectView()`; `listProjectsPage` overlays `retired`; `LIST_CACHE_VERSION = 4`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/test/retirement.test.ts` (add `multipart` and `fakePdf` are not needed; add `import type { ProjectListPage } from '@ih/shared';` at the top):

```ts
describe('listings of a retired type', () => {
  async function retiredLetter() {
    const ctx = await testApp();
    await ctx.templates.create('letter', 1, letter(1), 'published');
    await ctx.templates.create('memo', 1, { ...letter(1), id: 'memo', name: 'Memo' }, 'published');
    await ctx.app.inject(retire('letter'));
    return ctx;
  }

  it('leaves it out of GET /api/specs unless retired=include (D2)', async () => {
    const { app } = await retiredLetter();
    const ids = (body: { id: string }[]) => [...new Set(body.map((s) => s.id))];
    const plain = (await app.inject('/api/specs')).json();
    expect(ids(plain)).not.toContain('letter');
    expect(ids(plain)).toContain('memo');
    const all = await app.inject('/api/specs?retired=include');
    expect(all.statusCode).toBe(200);
    const letterRow = all.json().find((s: { id: string }) => s.id === 'letter');
    expect(letterRow.retired).toEqual({ retiredAt: expect.any(String), retiredBy: null });
    expect(all.json().find((s: { id: string }) => s.id === 'memo').retired).toBeUndefined();
    expect((await app.inject('/api/specs?retired=yes')).statusCode).toBe(400);
  });

  it('still resolves the definition (reading is allowed)', async () => {
    const { app } = await retiredLetter();
    expect((await app.inject('/api/specs/letter')).statusCode).toBe(200);
  });

  it('marks it on GET /api/templates (D3)', async () => {
    const { app } = await retiredLetter();
    const list = (await app.inject('/api/templates')).json();
    expect(list.find((t: { id: string }) => t.id === 'letter').retired).toMatchObject({
      retiredBy: null,
    });
    expect(list.find((t: { id: string }) => t.id === 'memo').retired).toBeNull();
  });

  it('carries it on the project view and overview', async () => {
    const { app } = await testApp();
    await app.inject({
      method: 'POST',
      url: '/api/workbench/projects',
      payload: { id: 'letter', name: 'Letter' },
    });
    expect((await app.inject('/api/workbench/projects/letter')).json().retired).toBeNull();
    await app.inject(retire('letter'));
    expect((await app.inject('/api/workbench/projects/letter')).json().retired).toMatchObject({
      retiredBy: null,
    });
    expect(
      (await app.inject('/api/workbench/projects/letter/overview')).json().project.retired,
    ).not.toBeNull();
  });

  it('hides it from the Workbench list until asked for, live after a retire or unretire', async () => {
    const { app } = await testApp();
    for (const [id, name] of [
      ['letter', 'Letter'],
      ['memo', 'Memo'],
    ]) {
      await app.inject({ method: 'POST', url: '/api/workbench/projects', payload: { id, name } });
    }
    const list = async (qs = '') =>
      (await app.inject(`/api/workbench/projects${qs}`)).json() as ProjectListPage;
    expect((await list()).items.map((i) => i.id).sort()).toEqual(['letter', 'memo']);
    await app.inject(retire('letter'));
    expect((await list()).items.map((i) => i.id)).toEqual(['memo']);
    const all = await list('?retired=include');
    expect(all.items.find((i) => i.id === 'letter')?.retired).not.toBeNull();
    expect((await list('?ids=letter')).items.map((i) => i.id)).toEqual(['letter']);
    await app.inject(unretire('letter'));
    expect((await list()).items.map((i) => i.id).sort()).toEqual(['letter', 'memo']);
  });
});
```

Append to the `template lifecycle` describe in `apps/api/test/templates.test.ts`:

```ts
  it('seeds a missing version of a retired type and leaves it retired (D9)', async () => {
    const { templates } = await testApp();
    await templates.retire('process-validation-protocol', 'ken');
    expect(await seedTemplates(templates, repoSpecsDir)).toContain(
      'process-validation-protocol v3',
    );
    expect((await templates.get('process-validation-protocol', 3))?.status).toBe('published');
    expect(await templates.retirement('process-validation-protocol')).toMatchObject({
      retiredBy: 'ken',
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/api/test/retirement.test.ts apps/api/test/templates.test.ts`
Expected: the listing tests FAIL (retired types still listed; no `retired` fields). The seeding test PASSES already (seeding never touches the table): it pins the behaviour, so keep it.

- [ ] **Step 3: Implement**

`apps/api/src/templates/definitions.ts`, replace `listDefinitions` with:

```ts
/**
 * Document types offered for upload: published database recipes + file definitions. Retired
 * types are left out, or with `includeRetired` listed with their `retired` (old jobs and results
 * still name them).
 */
export async function listDefinitions(
  deps: AppDeps,
  { includeRetired = false }: { includeRetired?: boolean } = {},
): Promise<DefinitionSummary[]> {
  const [all, retirements] = await Promise.all([
    deps.templates.list(),
    deps.templates.listRetirements(),
  ]);
  const records = all.filter((r) => r.status === 'published');
  const fromDb: DefinitionSummary[] = records.map((r) => ({
    id: r.id,
    version: r.version,
    title: String(r.definition.name ?? r.id),
    description: r.definition.description as string | undefined,
    ...(typeof r.definition.model === 'string' ? { model: r.definition.model } : {}),
    kind: 'template',
  }));
  const seen = new Set(fromDb.map((d) => `${d.id}@${d.version}`));
  const files = deps.specs.list().filter((d) => !seen.has(`${d.id}@${d.version}`));
  return [...fromDb, ...files]
    .flatMap((d) => {
      const retired = retirements.get(d.id);
      if (!retired) return [d];
      return includeRetired ? [{ ...d, retired }] : [];
    })
    .sort((a, b) => a.id.localeCompare(b.id) || a.version - b.version);
}
```

`apps/api/src/routes/specs.ts`, the `/specs` route: add to the schema

```ts
        querystring: z
          .object({
            retired: z
              .enum(['include'])
              .optional()
              .describe('`include`: list retired document types too, each with `retired`.'),
          })
          .strict(),
```

append to its description: ``Retired document types are left out unless \`retired=include\`.``, add `400: error('Zod issues for an invalid query.'),` to `response`, and replace the handler with:

```ts
    async (req, reply) => {
      const query = z.object({ retired: z.enum(['include']).optional() }).strict().safeParse(req.query);
      if (!query.success) return reply.code(400).send({ error: query.error.issues });
      return listDefinitions(app.deps, { includeRetired: query.data.retired === 'include' });
    },
```

(The route's generic becomes `app.get<{ Querystring: Record<string, string> }>(`.)

`apps/api/src/routes/templates.ts`:

1. Import `RetirementSchema` from `@ih/shared`.
2. `TemplateTypeSchema`: add after `draft`:

```ts
  retired: RetirementSchema.nullable().describe(
    'Set when the document type is retired (hidden from new work); null when it is not.',
  ),
```

3. In the `GET /templates` handler, read the retirements once and add them to each entry:

```ts
    async (req) => {
      const byId = new Map<string, TemplateRecord[]>();
      const [records, retirements] = await Promise.all([
        repo().list(),
        app.deps.templates.listRetirements(),
      ]);
      for (const r of records) byId.set(r.id, [...(byId.get(r.id) ?? []), r]);
```

and in the mapped entry add `retired: retirements.get(id) ?? null,` after `draft: draft?.version ?? null,`. Append to the route description: ``\`retired\` is set for a retired document type.``

`apps/api/src/routes/workbench.ts`, `projectView`:

```ts
export async function projectView(
  app: FastifyInstance,
  project: WorkbenchProject,
): Promise<ProjectView> {
  const [{ draft, published }, brief, retired] = await Promise.all([
    versionsOf(app.deps.templates, project.id),
    app.deps.workbench.latestBrief(project.id),
    app.deps.templates.retirement(project.id),
  ]);
  return { project, draft, published, brief, retired };
}
```

Append to the `GET /workbench/projects` description: ``Retired document types are left out unless \`retired=include\`, or \`ids\` names them; each row's \`retired\` is read live.``

`apps/api/src/workbench/list.ts`:

1. `export const LIST_CACHE_VERSION = 4;` (rows gained `retired`).
2. Replace `listProjectsPage` with:

```ts
/**
 * GET /api/workbench/projects: the cached rows, searched, counted, sorted and paged (W1). The
 * retirement is overlaid on every request, never cached: retiring changes no table the
 * fingerprints read, so it shows on the next request without recomputing a row.
 */
export async function listProjectsPage(
  app: FastifyInstance,
  query: ProjectListQuery,
): Promise<ProjectListPage> {
  const [rows, retirements] = await Promise.all([
    refreshListCache(app),
    app.deps.templates.listRetirements(),
  ]);
  return queryProjects(
    rows.map((r) => ({ ...r, retired: retirements.get(r.id) ?? null })),
    query,
  );
}
```

- [ ] **Step 4: Run the tests and regenerate the docs**

Run: `npx vitest run apps/api/test/retirement.test.ts apps/api/test/templates.test.ts apps/api/test/workbench-list.test.ts apps/api/test/workbench-overview.test.ts`
Expected: PASS.

Run: `npm run openapi` then `npx vitest run apps/api/test/openapi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/templates/definitions.ts apps/api/src/routes/specs.ts apps/api/src/routes/templates.ts apps/api/src/routes/workbench.ts apps/api/src/workbench/list.ts apps/api/test/retirement.test.ts apps/api/test/templates.test.ts docs/openapi.json
git commit -m "$(cat <<'EOF'
API: listings hide retired document types unless asked; views carry retired

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Refuse new work for a retired type: uploads, retry, recipes, regression

**Files:**
- Create: `apps/api/test/retirement-refusals.test.ts`
- Modify: `apps/api/src/routes/documents.ts`, `apps/api/src/routes/jobs.ts`, `apps/api/src/routes/templates.ts`, `apps/api/src/routes/references.ts`, `docs/openapi.json`

**Interfaces:**
- Consumes: `retiredProblem`, `refuseRetired`, `RETIRED_DOC` (Task 3).
- Produces: 409s on `POST /api/documents`, `POST /api/jobs/:id/retry`, `POST /api/templates`, `POST /api/templates/:id/drafts`, `POST /api/templates/:id/versions/:version/publish`, `POST /api/templates/import`, `POST /api/templates/:id/versions/:version/regression`.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/retirement-refusals.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { stringify as toYaml } from 'yaml';
import { fakePdf, letter, multipart, testApp } from './helpers.js';

const RETIRED = 'Letter is retired: unretire it to use it again';

/** letter v1 published, v2 draft, one finished upload; then letter is retired. */
async function retired() {
  const ctx = await testApp();
  await ctx.templates.create('letter', 1, letter(1), 'published');
  await ctx.templates.create('letter', 2, letter(2), 'draft');
  const upload = await ctx.app.inject({
    method: 'POST',
    url: '/api/documents',
    ...multipart({ specId: 'letter' }, { filename: 'a.pdf', content: fakePdf() }),
  });
  expect(upload.statusCode).toBe(201);
  const job = upload.json();
  ctx.repo.jobs.set(job.id, { ...ctx.repo.jobs.get(job.id)!, status: 'failed' });
  await ctx.templates.retire('letter', 'ken');
  return { ...ctx, job };
}

describe('new work for a retired document type (D4)', () => {
  it.each([
    [
      'an upload',
      () => ({
        method: 'POST' as const,
        url: '/api/documents',
        ...multipart({ specId: 'letter' }, { filename: 'b.pdf', content: fakePdf() }),
      }),
    ],
    [
      'a test run of the draft',
      () => ({
        method: 'POST' as const,
        url: '/api/documents',
        ...multipart(
          { specId: 'letter', specVersion: '2', test: 'true' },
          { filename: 'b.pdf', content: fakePdf() },
        ),
      }),
    ],
    ['a new draft', () => ({ method: 'POST' as const, url: '/api/templates/letter/drafts', payload: {} })],
    [
      'publishing the draft',
      () => ({ method: 'POST' as const, url: '/api/templates/letter/versions/2/publish' }),
    ],
    [
      'a regression run',
      () => ({ method: 'POST' as const, url: '/api/templates/letter/versions/1/regression' }),
    ],
    [
      'a YAML import as a draft',
      () => ({
        method: 'POST' as const,
        url: '/api/templates/import',
        payload: { yaml: toYaml(letter(3)) },
      }),
    ],
    [
      'a YAML import published',
      () => ({
        method: 'POST' as const,
        url: '/api/templates/import',
        payload: { yaml: toYaml(letter(3)), publish: true },
      }),
    ],
  ])('refuses %s with a 409 and queues nothing', async (_name, request) => {
    const ctx = await retired();
    const before = { jobs: ctx.repo.jobs.size, versions: (await ctx.templates.list()).length };
    const res = await ctx.app.inject(request());
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(RETIRED);
    expect({ jobs: ctx.repo.jobs.size, versions: (await ctx.templates.list()).length }).toEqual(
      before,
    );
  });

  it('refuses a retry or re-process of an old job of the type', async () => {
    const { app, job, repo } = await retired();
    const res = await app.inject({ method: 'POST', url: `/api/jobs/${job.id}/retry`, payload: {} });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(RETIRED);
    expect(repo.jobs.get(job.id)?.status).toBe('failed');
  });

  it('refuses a new database type under a retired legacy id, named by its spec title', async () => {
    const { app, templates } = await testApp();
    await templates.retire('demo', null);
    const res = await app.inject({
      method: 'POST',
      url: '/api/templates',
      payload: { id: 'demo', name: 'Demo again' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Demo is retired: unretire it to use it again');
    const upload = await app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'demo' }, { filename: 'b.pdf', content: fakePdf() }),
    });
    expect(upload.statusCode).toBe(409);
  });
});

describe('what stays allowed for a retired document type (D5)', () => {
  it('saves and deletes the draft, reads versions, and approves a job awaiting review', async () => {
    const { app, job, repo } = await retired();
    const save = await app.inject({
      method: 'PUT',
      url: '/api/templates/letter/versions/2',
      payload: { definition: { ...letter(2), name: 'Letter' } },
    });
    expect(save.statusCode).toBe(200);
    expect((await app.inject('/api/templates/letter/versions/1')).statusCode).toBe(200);
    repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'awaiting_review' });
    const approve = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/approve`,
      payload: {},
    });
    expect(approve.statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/templates/letter/versions/2' })).statusCode,
    ).toBe(204);
  });

  it('works again after an unretire', async () => {
    const { app } = await retired();
    await app.inject({ method: 'DELETE', url: '/api/specs/letter/retirement' });
    const upload = await app.inject({
      method: 'POST',
      url: '/api/documents',
      ...multipart({ specId: 'letter' }, { filename: 'c.pdf', content: fakePdf() }),
    });
    expect(upload.statusCode).toBe(201);
  });
});
```

(If `fakePdf` takes an argument in `helpers.ts`, call it as the other tests do; `multipart(fields, file)` writes fields first.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/api/test/retirement-refusals.test.ts`
Expected: FAIL: the refusals answer 201/200 (or 400 for the empty regression), not 409.

- [ ] **Step 3: Implement**

`apps/api/src/routes/documents.ts`: import `import { retiredProblem, RETIRED_DOC } from '../templates/retirement.js';`. After `const spec = resolved.definition;` add:

```ts
      const retired = await retiredProblem(app.deps, spec.id);
      if (retired) return reply.code(409).send({ error: retired });
```

and add to `response`: `409: error(RETIRED_DOC + '.'),`. Append to the description list: ``- A retired document type is refused (409) until an admin unretires it.``

`apps/api/src/routes/jobs.ts`: import `retiredProblem, RETIRED_DOC`. In the retry handler, after `const current = await app.deps.repo.getJob(req.params.id);` add:

```ts
      // A retry is new work: a retired document type is refused (its old jobs stay readable).
      const retired = current ? await retiredProblem(app.deps, current.specId) : null;
      if (retired) return reply.code(409).send({ error: retired });
```

and change its 409 doc to `` error('`job not found or not in a retryable state`, or ' + RETIRED_DOC + '.') ``.

`apps/api/src/routes/templates.ts`: import `import { refuseRetired, retiredProblem, RETIRED_DOC } from '../templates/retirement.js';`. Inside `templateRoutes`, after `const withIssues = issuesOf(app);` add `const notRetired = refuseRetired(app);`.

- `POST /templates` (create): after the existing "already exists" check add

```ts
      // A retired legacy spec id stays retired: no new recipe type under it.
      const retired = await retiredProblem(app.deps, body.data.id);
      if (retired) return reply.code(409).send({ error: retired });
```

  and change its 409 doc to `` error('`document type {id} already exists`, or ' + RETIRED_DOC + '.') ``.
- `POST /templates/:id/versions/:version/publish` and `POST /templates/:id/drafts`: add `preHandler: notRetired,` next to `schema:` in the route options, and append ` + ', or ' + RETIRED_DOC + '.'` to each 409 text (for publish, the full text becomes `` '`{id} v{version} is already published`, `publish {id} from the Workbench (holdout gate)` for a Workbench document type, or ' + RETIRED_DOC + '.' ``).
- `POST /templates/import`: after the `ident` check add

```ts
      const retired = await retiredProblem(app.deps, ident.data.id);
      if (retired) return reply.code(409).send({ error: retired });
```

  and append `, or ${RETIRED_DOC}` to its 409 text.

`apps/api/src/routes/references.ts`: import `refuseRetired, RETIRED_DOC`; in the `POST /templates/:id/versions/:version/regression` route options add `preHandler: refuseRetired(app),` and `409: error(RETIRED_DOC + '.'),` to its `response`.

- [ ] **Step 4: Run the tests and regenerate the docs**

Run: `npx vitest run apps/api/test/retirement-refusals.test.ts apps/api/test/documents.test.ts apps/api/test/jobs.test.ts apps/api/test/templates.test.ts apps/api/test/regression.test.ts`
Expected: PASS.

Run: `npm run openapi` then `npx vitest run apps/api/test/openapi.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/documents.ts apps/api/src/routes/jobs.ts apps/api/src/routes/templates.ts apps/api/src/routes/references.ts apps/api/test/retirement-refusals.test.ts docs/openapi.json
git commit -m "$(cat <<'EOF'
API: refuse uploads, retries, drafts, publishing, imports and regression for retired types

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Refuse Workbench work for a retired type

**Files:**
- Create: `apps/api/test/workbench-retired.test.ts`
- Modify: `apps/api/src/routes/workbench.ts`, `apps/api/src/routes/workbench-bundle.ts`, `apps/api/test/workbench-bundle.test.ts`, `docs/openapi.json`

**Interfaces:**
- Consumes: `refuseRetired`, `retiredProblem`, `RETIRED_DOC` (Task 3).
- Produces: 409s on `POST /api/workbench/projects` (existing or new id), `POST …/:id/publish`, `…/samples`, `…/test-runs`, `…/stages/:stage` (every stage, references and revise included), `…/holdout/reference-runs`, `…/references/:sid/run`, `…/evaluations`, `…/evaluations/compare`, and `POST /api/workbench/projects/import` under a retired id. Not refused (D5): segmentations, export, brief, feedback, proposals, skip/confirm, restore, policy, threshold, sample role/delete, project delete.

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/workbench-retired.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { multipart, testApp } from './helpers.js';

const RETIRED = 'Letter is retired: unretire it to use it again';
const pdf = Buffer.from('%PDF-1.7\n% sample\n%%EOF\n');
const SID = '00000000-0000-4000-8000-000000000001';

async function retiredProject() {
  const ctx = await testApp();
  await ctx.app.inject({
    method: 'POST',
    url: '/api/workbench/projects',
    payload: { id: 'letter', name: 'Letter' },
  });
  await ctx.templates.retire('letter', 'ken');
  const counts = () => ({
    jobs: ctx.repo.jobs.size,
    drafts: ctx.repo.draftJobs.size,
    samples: ctx.workbench.samples.size,
    iterations: ctx.workbench.iterations.length,
  });
  return { ...ctx, counts };
}

const P = '/api/workbench/projects/letter';

describe('Workbench work for a retired document type (D4)', () => {
  it.each([
    ['publish', { method: 'POST', url: `${P}/publish`, payload: {} }],
    ['dev test runs', { method: 'POST', url: `${P}/test-runs`, payload: {} }],
    ...['survey', 'outputs', 'sections', 'steps', 'references', 'revise'].map(
      (stage) => [`the ${stage} stage`, { method: 'POST', url: `${P}/stages/${stage}`, payload: {} }] as const,
    ),
    ['holdout reference runs', { method: 'POST', url: `${P}/holdout/reference-runs` }],
    ['a re-verify', { method: 'POST', url: `${P}/references/${SID}/run` }],
    ['an evaluation', { method: 'POST', url: `${P}/evaluations`, payload: {} }],
    ['a model comparison', { method: 'POST', url: `${P}/evaluations/compare`, payload: {} }],
  ] as const)('refuses %s with a 409 and queues nothing', async (_name, request) => {
    const ctx = await retiredProject();
    const before = ctx.counts();
    const res = await ctx.app.inject(request as Parameters<typeof ctx.app.inject>[0]);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(RETIRED);
    expect(ctx.counts()).toEqual(before);
  });

  it('refuses a sample upload before reading the file', async () => {
    const ctx = await retiredProject();
    const before = ctx.counts();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `${P}/samples`,
      ...multipart({ role: 'dev' }, { filename: 's.pdf', content: pdf }),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe(RETIRED);
    expect(ctx.counts()).toEqual(before);
  });

  it('refuses a project for a retired type that has none yet', async () => {
    const { app, templates } = await testApp();
    await templates.create('memo', 1, { id: 'memo', version: 1, name: 'Memo' }, 'published');
    await templates.retire('memo', null);
    const res = await app.inject({
      method: 'POST',
      url: '/api/workbench/projects',
      payload: { id: 'memo' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('Memo is retired: unretire it to use it again');
    expect(await templates.list()).toHaveLength(1); // no next draft was opened
  });
});

describe('what a retired Workbench project still allows (D5)', () => {
  it.each([
    ['reading the project', { method: 'GET', url: P }],
    ['the overview', { method: 'GET', url: `${P}/overview` }],
    ['saving the brief', { method: 'PUT', url: `${P}/brief`, payload: { purpose: 'QA' } }],
    ['adding feedback', { method: 'POST', url: `${P}/feedback`, payload: { text: 'Dates are wrong' } }],
    ['an anchor preview', { method: 'POST', url: `${P}/segmentations`, payload: {} }],
    ['a bundle export', { method: 'POST', url: `${P}/export` }],
    ['saving the draft', { method: 'PUT', url: '/api/templates/letter/versions/1', payload: { definition: { id: 'letter', version: 1, name: 'Letter' } } }],
    ['deleting the project', { method: 'DELETE', url: P }],
  ] as const)('allows %s', async (_name, request) => {
    const ctx = await retiredProject();
    const res = await ctx.app.inject(request as Parameters<typeof ctx.app.inject>[0]);
    // Other refusals (no samples yet, …) are fine: only the retired one must not happen.
    const body = (res.body ? res.json() : {}) as { error?: unknown };
    expect(body.error ?? '').not.toBe(RETIRED);
    expect(res.statusCode).not.toBe(500);
  });
});
```

(The feedback body field is whatever `FeedbackBodySchema` names; a 400 there still passes, since only the retired refusal is checked.)

Append to the `import` describe in `apps/api/test/workbench-bundle.test.ts`:

```ts
  it('refuses a bundle under a retired id and writes nothing', async () => {
    const { app, repo, store, templates, workbench } = await testApp();
    await templates.retire('memo', 'ken');
    const counts = async () => ({
      templates: (await templates.list()).length,
      projects: (await workbench.listProjects()).length,
      objects: store.objects.size,
      jobs: repo.jobs.size,
    });
    const before = await counts();
    const res = await importBundle(app, bundle());
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('memo is retired: unretire it to use it again');
    expect(await counts()).toEqual(before);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/api/test/workbench-retired.test.ts apps/api/test/workbench-bundle.test.ts`
Expected: the refusal tests FAIL (201/202/400/404 instead of 409); the "allows" tests PASS already and pin D5.

- [ ] **Step 3: Implement**

`apps/api/src/routes/workbench.ts`:

1. Import `import { refuseRetired, retiredProblem, RETIRED_DOC } from '../templates/retirement.js';`.
2. Inside `workbenchRoutes`, before the first route, add:

```ts
  /** Routes that queue model or document work refuse a retired document type (D4). */
  const notRetired = refuseRetired(app);
```

3. Add `preHandler: notRetired,` beside `schema:` in the options of these routes:
   `POST /workbench/projects/:id/publish`, `POST /workbench/projects/:id/samples`, `POST /workbench/projects/:id/test-runs`, `POST /workbench/projects/:id/stages/:stage`, `POST /workbench/projects/:id/holdout/reference-runs`, `POST /workbench/projects/:id/references/:sid/run`, `POST /workbench/projects/:id/evaluations`, `POST /workbench/projects/:id/evaluations/compare`.

4. Docs: in each of those routes, append `, or ${RETIRED_DOC}` to the existing `409` description string (publish's is a `res(…)`: append to its text; evaluations and compare spread `EVALUATION_REFUSED`: add `RETIRED_DOC` to the `409` text inside `EVALUATION_REFUSED`; the samples route's 409 text too). Every one of these routes already documents a 409.

5. `POST /workbench/projects` (create): after the "already exists" check add

```ts
      const retired = await retiredProblem(app.deps, id);
      if (retired) return reply.code(409).send({ error: retired });
```

   and change its 409 doc to `` error('`a workbench project for {id} already exists`, or ' + RETIRED_DOC + '.') ``.

`apps/api/src/routes/workbench-bundle.ts`: import `retiredProblem, RETIRED_DOC`. In `createFromBundle`, right after the `taken` check (`return answer(409, taken);` block) add:

```ts
    const retired = await retiredProblem(app.deps, projectId);
    if (retired) return answer(409, { error: retired });
```

and change the import route's 409 doc to `` error('The id is taken: import under another id; or ' + RETIRED_DOC + '.') ``.

- [ ] **Step 4: Run the tests and regenerate the docs**

Run: `npx vitest run apps/api/test/workbench-retired.test.ts apps/api/test/workbench-bundle.test.ts apps/api/test/workbench.test.ts apps/api/test/workbench-runs.test.ts apps/api/test/workbench-stages.test.ts apps/api/test/workbench-evaluation.test.ts apps/api/test/workbench-publish.test.ts`
Expected: PASS.

Run: `npm run openapi` then `npx vitest run apps/api/test/openapi.test.ts apps/api/test/access.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/workbench.ts apps/api/src/routes/workbench-bundle.ts apps/api/test/workbench-retired.test.ts apps/api/test/workbench-bundle.test.ts docs/openapi.json
git commit -m "$(cat <<'EOF'
API: Workbench refuses job-creating actions for a retired document type

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: Web client, retired helpers, and the spec lists

**Files:**
- Create: `apps/web/src/ui/retired.ts`, `apps/web/src/ui/RetiredBanner.tsx`, `apps/web/test/retired-ui.test.tsx`
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/test/client.test.ts`, `apps/web/src/home/HomePage.tsx`, `apps/web/src/jobs/JobsPage.tsx`, `apps/web/src/results/ResultsPage.tsx`, `apps/web/src/jobs/UploadStrip.tsx`, `apps/web/test/JobsPage.test.tsx`, `apps/web/test/UploadStrip.test.tsx`, plus `retired: null` on every `TemplateListItem` literal the type check flags (`apps/web/test/TemplatesPage.test.tsx`, `TemplateEditor.test.tsx`, `AppShell.test.tsx`, `template-quality.test.ts`)

**Interfaces:**
- Produces:
  - `Api.listSpecs(options?: { retired?: 'include' }): Promise<SpecSummary[]>`
  - `Api.retireType(id: string): Promise<{ id: string; retired: Retirement }>`, `Api.unretireType(id: string): Promise<void>`
  - `TemplateListItem.retired: Retirement | null`
  - `listProjectPage` sends `retired` (via `ProjectListQuery`, Task 1)
  - `RETIRED_REASON: string`, `retiredLine(r: Retirement): string` (`apps/web/src/ui/retired.ts`)
  - `<RetiredBanner retirement onUnretire? busy? />` (`apps/web/src/ui/RetiredBanner.tsx`)

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/retired-ui.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RETIRED_REASON, retiredLine } from '../src/ui/retired.js';
import { RetiredBanner } from '../src/ui/RetiredBanner.js';

const retirement = { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' };

describe('retired helpers', () => {
  it('says who retired it and when', () => {
    expect(retiredLine(retirement)).toBe('Retired by ken on 14 Oct 2026');
    expect(retiredLine({ ...retirement, retiredBy: null })).toBe('Retired on 14 Oct 2026');
  });
  it('gives one reason for every disabled action', () => {
    expect(RETIRED_REASON).toBe(
      'This document type is retired: an admin can unretire it on the Document types page',
    );
  });
});

describe('RetiredBanner', () => {
  it('explains what retired means; admins get Unretire', async () => {
    const onUnretire = vi.fn();
    render(<RetiredBanner retirement={retirement} onUnretire={onUnretire} />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('Retired by ken on 14 Oct 2026');
    expect(note).toHaveTextContent(/Nothing new runs for it/);
    await userEvent.click(screen.getByRole('button', { name: 'Unretire' }));
    expect(onUnretire).toHaveBeenCalled();
  });
  it('has no Unretire without the handler (users)', () => {
    render(<RetiredBanner retirement={retirement} />);
    expect(screen.queryByRole('button', { name: 'Unretire' })).not.toBeInTheDocument();
  });
});
```

Append to `apps/web/test/client.test.ts`:

```ts
describe('http api: retired document types', () => {
  it('lists specs with or without retired ones, and retires and unretires', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? new Response(null, { status: 204 })
        : init?.method === 'PUT'
          ? Response.json({ id: 'a b', retired: { retiredAt: 'x', retiredBy: null } })
          : Response.json([]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.listSpecs();
    await api.listSpecs({ retired: 'include' });
    await api.retireType('a b');
    await api.unretireType('a b');
    await api.listProjectPage({ retired: 'include' });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET'])).toEqual([
      ['/api/specs', 'GET'],
      ['/api/specs?retired=include', 'GET'],
      ['/api/specs/a%20b/retirement', 'PUT'],
      ['/api/specs/a%20b/retirement', 'DELETE'],
      ['/api/workbench/projects?retired=include', 'GET'],
    ]);
  });
});
```

Append to `apps/web/test/JobsPage.test.tsx`, inside its first describe (next to "names document types from the spec list"):

```tsx
  it('asks for retired document types too, so old jobs keep their names', async () => {
    const api = fakeApi({
      listSpecs: vi.fn(async () => [
        {
          id: 'inv',
          version: 3,
          title: 'Supplier invoice',
          retired: { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' },
        },
      ]),
    });
    page([job({ filename: 'a.pdf', specId: 'inv', specVersion: 3 })], { api });
    const list = screen.getByRole('region', { name: 'Job list' });
    expect(await within(list).findByText('Supplier invoice v3')).toBeInTheDocument();
    expect(api.listSpecs).toHaveBeenCalledWith({ retired: 'include' });
  });
```

Append to the `UploadStrip document types` describe in `apps/web/test/UploadStrip.test.tsx`:

```tsx
  it('never offers a retired document type', async () => {
    const api = fakeApi({
      listSpecs: vi.fn(async () => [
        { id: 'letter', version: 1, title: 'Letter' },
        {
          id: 'memo',
          version: 2,
          title: 'Memo',
          retired: { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: null },
        },
      ]),
    });
    render(<UploadStrip api={api} onUploaded={() => {}} />);
    await screen.findByRole('option', { name: 'Letter · v1' });
    expect(screen.queryByRole('option', { name: 'Memo · v2' })).not.toBeInTheDocument();
    expect(api.listSpecs).toHaveBeenCalledWith();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/web/test/retired-ui.test.tsx apps/web/test/client.test.ts apps/web/test/JobsPage.test.tsx apps/web/test/UploadStrip.test.tsx`
Expected: FAIL: the modules do not exist; `retireType` is not a function; `listSpecs` is called without arguments.

- [ ] **Step 3: Implement**

Create `apps/web/src/ui/retired.ts`:

```ts
import type { Retirement } from '@ih/shared';

/** Why every job-creating action of a retired document type is disabled. */
export const RETIRED_REASON =
  'This document type is retired: an admin can unretire it on the Document types page';

/** "Retired by ken on 14 Oct 2026". */
export function retiredLine(r: Retirement): string {
  const on = new Date(r.retiredAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return r.retiredBy ? `Retired by ${r.retiredBy} on ${on}` : `Retired on ${on}`;
}
```

Create `apps/web/src/ui/RetiredBanner.tsx`:

```tsx
import type { Retirement } from '@ih/shared';
import { retiredLine } from './retired.js';

/**
 * A retired document type: who retired it, what that means, and Unretire for admins (pass
 * `onUnretire` only to admins). Reuses the stale banner's look in its grey `skip` tone.
 */
export function RetiredBanner({
  retirement,
  onUnretire,
  busy = false,
}: {
  retirement: Retirement;
  onUnretire?: () => void;
  busy?: boolean;
}) {
  return (
    <div className="stale-banner" role="note" data-tone="skip">
      <p className="stale-banner-text">
        <strong>{retiredLine(retirement)}.</strong> Nothing new runs for it: uploads, test runs,
        drafting and publishing are off. Its jobs, results and references stay readable.
      </p>
      {onUnretire && (
        <div className="stale-banner-actions">
          <button type="button" disabled={busy} onClick={onUnretire}>
            Unretire
          </button>
        </div>
      )}
    </div>
  );
}
```

`apps/web/src/api/client.ts`:

1. Import `Retirement` from `@ih/shared` with the other shared types.
2. `TemplateListItem`: add after `draft`:

```ts
  /** Set when the document type is retired (hidden from new work); null when it is not. */
  retired: Retirement | null;
```

3. In `interface Api`: replace `listSpecs(): Promise<SpecSummary[]>;` with

```ts
  /** Document types for upload; `retired: 'include'` lists retired ones too (old jobs' names). */
  listSpecs(options?: { retired?: 'include' }): Promise<SpecSummary[]>;
  /** Admins: retire / unretire a document type (all its versions). */
  retireType(id: string): Promise<{ id: string; retired: Retirement }>;
  unretireType(id: string): Promise<void>;
```

4. In `createHttpApi`: replace `listSpecs` with

```ts
    listSpecs: (options) =>
      apiFetch(`${base}/specs${options?.retired ? `?retired=${options.retired}` : ''}`).then(
        json<SpecSummary[]>,
      ),
    retireType: (id) =>
      post<{ id: string; retired: Retirement }>(
        `${base}/specs/${encodeURIComponent(id)}/retirement`,
        {},
        'PUT',
      ),
    unretireType: (id) =>
      noContent(
        apiFetch(`${base}/specs/${encodeURIComponent(id)}/retirement`, { method: 'DELETE' }),
      ),
```

   and in `listProjectPage` add `if (query.retired) params.set('retired', query.retired);` after the `policy` line.

`apps/web/test/fake-api.ts`: add to `fakeApi` defaults

```ts
    retireType: vi.fn(async (id: string) => ({
      id,
      retired: { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' },
    })),
    unretireType: vi.fn(async () => undefined),
```

Pages that name types: in `apps/web/src/home/HomePage.tsx`, `apps/web/src/jobs/JobsPage.tsx` and `apps/web/src/results/ResultsPage.tsx` change `api.listSpecs().then(` to `api.listSpecs({ retired: 'include' }).then(` (each with the comment `// Retired types too: old jobs and results keep their names.`).

`apps/web/src/jobs/UploadStrip.tsx`: keep `api.listSpecs()` (retired ones are left out by the API) and, belt and braces, filter in the success handler: change `(all) => {` to `(listed) => {` and add as its first line

```ts
        const all = listed.filter((s) => !s.retired); // the API leaves them out; never offer one
```

TemplateListItem literals: run `npm run typecheck` and add `retired: null,` after `draft` in each flagged literal (expected: `TemplatesPage.test.tsx` `list`, `TemplateEditor.test.tsx` `listItem`, and any in `AppShell.test.tsx` / `template-quality.test.ts`).

- [ ] **Step 4: Run the tests and the type check**

Run: `npx vitest run apps/web/test/retired-ui.test.tsx apps/web/test/client.test.ts apps/web/test/JobsPage.test.tsx apps/web/test/UploadStrip.test.tsx apps/web/test/HomePage.test.tsx apps/web/test/ResultsPage.test.tsx` then `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/ui/retired.ts apps/web/src/ui/RetiredBanner.tsx apps/web/src/api/client.ts apps/web/test/fake-api.ts apps/web/test/client.test.ts apps/web/test/retired-ui.test.tsx apps/web/src/home/HomePage.tsx apps/web/src/jobs/JobsPage.tsx apps/web/src/results/ResultsPage.tsx apps/web/src/jobs/UploadStrip.tsx apps/web/test/JobsPage.test.tsx apps/web/test/UploadStrip.test.tsx apps/web/test/TemplatesPage.test.tsx apps/web/test/TemplateEditor.test.tsx apps/web/test/AppShell.test.tsx apps/web/test/template-quality.test.ts
git commit -m "$(cat <<'EOF'
Web: retire client, retired banner, and spec lists that keep old type names

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

(Drop from `git add` any listed test file the type check did not need to touch.)

---

### Task 8: Document types page and the recipe editor

**Files:**
- Modify: `apps/web/src/templates/TemplatesPage.tsx`, `apps/web/src/templates/TemplateCard.tsx`, `apps/web/src/App.tsx`, `apps/web/src/templates/editor-derive.ts`, `apps/web/src/templates/EditorHeader.tsx`, `apps/web/src/templates/EmbeddedHeader.tsx`, `apps/web/src/templates/TryOn.tsx`, `apps/web/src/templates/TemplateEditor.tsx`
- Test: `apps/web/test/TemplatesPage.test.tsx`, `apps/web/test/TemplateEditor.test.tsx`, `apps/web/test/editor-derive.test.ts`

**Interfaces:**
- Consumes: Task 7 (`retireType`, `unretireType`, `TemplateListItem.retired`, `RETIRED_REASON`, `retiredLine`, `RetiredBanner`).
- Produces: `TemplatesPage` prop `role: 'admin' | 'user'` (default `'user'`); `TemplateCard` props `role`, `onChanged`; `publishBlocker(dirty, issues, retired = false)`; `tryOnBlockedReason` unchanged; `TryOn` prop `retired?: string | null`; `EditorHeader` prop `retired?: boolean`; `EmbeddedHeader` prop `retired?: string | null`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/test/editor-derive.test.ts`:

```ts
describe('publishBlocker for a retired type', () => {
  it('names the retirement before any other reason', () => {
    expect(publishBlocker(true, 3, true)).toBe(RETIRED_REASON);
    expect(publishBlocker(false, 0, false)).toBeNull();
  });
});
```

(import `RETIRED_REASON` from `'../src/ui/retired.js'` and `publishBlocker` if not already imported.)

Append to `apps/web/test/TemplatesPage.test.tsx`:

```tsx
const retirement = { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' };
const withRetired: TemplateListItem[] = [
  list[0]!,
  { ...list[1]!, retired: retirement },
];

describe('TemplatesPage retired types', () => {
  it('hides retired types until Show retired is ticked', async () => {
    const api = fakeApi({ listTemplates: vi.fn(async () => withRetired) });
    render(<TemplatesPage api={api} onNavigate={vi.fn()} />);
    await screen.findByRole('article', { name: 'Process Validation Protocol' });
    expect(screen.queryByRole('article', { name: 'Certificate of analysis' })).toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show retired (1)' }));
    const coa = screen.getByRole('article', { name: 'Certificate of analysis' });
    expect(within(coa).getByText('Retired')).toBeInTheDocument();
    expect(within(coa).getByText('Retired by ken on 14 Oct 2026')).toBeInTheDocument();
    const newDraft = within(coa).getByRole('button', { name: 'New draft from v2' });
    expect(newDraft).toBeDisabled();
    expect(newDraft).toHaveAttribute('title', RETIRED_REASON);
    const testRun = within(coa).getByRole('button', { name: 'Test run' });
    expect(testRun).toBeDisabled();
    expect(testRun).toHaveAttribute('title', RETIRED_REASON);
  });

  it('lets admins retire (after a confirm) and unretire; users see neither', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const listTemplates = vi
      .fn()
      .mockResolvedValueOnce(list)
      .mockResolvedValue(withRetired);
    const api = fakeApi({ listTemplates });
    render(<TemplatesPage api={api} onNavigate={vi.fn()} role="admin" />);
    const coa = await screen.findByRole('article', { name: 'Certificate of analysis' });
    await userEvent.click(within(coa).getByRole('button', { name: 'Retire…' }));
    expect(confirm).toHaveBeenCalled();
    expect(api.retireType).toHaveBeenCalledWith('coa');
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Show retired (1)' }));
    const retired = screen.getByRole('article', { name: 'Certificate of analysis' });
    await userEvent.click(within(retired).getByRole('button', { name: 'Unretire' }));
    expect(api.unretireType).toHaveBeenCalledWith('coa');
    confirm.mockRestore();
  });

  it('shows no retire controls to users', async () => {
    const api = fakeApi({ listTemplates: vi.fn(async () => list) });
    render(<TemplatesPage api={api} onNavigate={vi.fn()} role="user" />);
    const coa = await screen.findByRole('article', { name: 'Certificate of analysis' });
    expect(within(coa).queryByRole('button', { name: 'Retire…' })).toBeNull();
  });
});
```

(import `RETIRED_REASON` from `'../src/ui/retired.js'`.)

Append to `apps/web/test/TemplateEditor.test.tsx`:

```tsx
describe('TemplateEditor of a retired type', () => {
  const retirement = { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' };
  it('shows the banner and blocks Publish with the reason', async () => {
    setup(view({ ...validDefinition(), version: 1 }), {
      listTemplates: vi.fn(async () => [{ ...listItem(null, 1), retired: retirement }]),
    });
    expect(await screen.findByRole('note')).toHaveTextContent('Retired by ken on 14 Oct 2026');
    const publish = screen.getByRole('button', { name: /^Publish v1/ });
    expect(publish).toBeDisabled();
    expect(publish).toHaveAttribute('title', RETIRED_REASON);
  });
});
```

(import `RETIRED_REASON` from `'../src/ui/retired.js'`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/web/test/editor-derive.test.ts apps/web/test/TemplatesPage.test.tsx apps/web/test/TemplateEditor.test.tsx`
Expected: FAIL: no Show retired box, no retired state, Publish enabled.

- [ ] **Step 3: Implement**

`apps/web/src/templates/editor-derive.ts`, `publishBlocker`:

```ts
export function publishBlocker(dirty: boolean, issues: number, retired = false): string | null {
  if (retired) return RETIRED_REASON;
  if (dirty) return 'Save the draft before publishing';
  if (issues > 0) return `Fix ${plural(issues, 'validation issue')}`;
  return null;
}
```

(import `RETIRED_REASON` from `'../ui/retired.js'`.)

`apps/web/src/templates/EditorHeader.tsx`: add the prop `retired = false` (type `retired?: boolean;`, doc `/** The document type is retired: Publish is off. */`) and change `const blocker = publishBlocker(dirty, issues);` to `const blocker = publishBlocker(dirty, issues, retired);`.

`apps/web/src/templates/TryOn.tsx`: add the prop `retired = null` (type `retired?: string | null;`, doc `/** Why nothing may run (a retired document type); null otherwise. */`) and change the `blocked` line to

```ts
  const blocked =
    retired ?? tryOnBlockedReason(dirty, samples === null ? null : ready.length, issues);
```

`apps/web/src/templates/EmbeddedHeader.tsx`: add the prop `retired = null` (type `retired?: string | null;`) and pass `retired={retired}` to `<TryOn …>`.

`apps/web/src/templates/TemplateEditor.tsx`:

1. Imports: `import type { Retirement } from '@ih/shared';`, `import { RETIRED_REASON } from '../ui/retired.js';`, `import { RetiredBanner } from '../ui/RetiredBanner.js';`.
2. State next to `publishedVersion`: `const [retired, setRetired] = useState<Retirement | null>(null);`
3. Replace the `listTemplates` call in the load effect with:

```ts
    api.listTemplates().then(
      (items) => {
        const item = items.find((t) => t.id === templateId);
        setPublishedVersion(item?.published ?? null);
        setRetired(item?.retired ?? null);
      },
      () => {
        setPublishedVersion(null);
        setRetired(null);
      },
    );
```

4. `<EmbeddedHeader …>`: `publishBlocker={publishBlocker(dirty, issues.length, retired !== null)}` and add `retired={retired ? RETIRED_REASON : null}`.
5. `<EditorHeader …>`: add `retired={retired !== null}`, and directly after the standalone header's closing `)}` add

```tsx
      {!embedded && retired && <RetiredBanner retirement={retired} />}
```

   (Embedded, the project page shows its own banner: Task 10.)

`apps/web/src/templates/TemplateCard.tsx`:

1. Imports: `import { RETIRED_REASON, retiredLine } from '../ui/retired.js';`.
2. Props: add `role = 'user'` and `onChanged` (types `role?: 'admin' | 'user';` and `/** The type was retired or unretired: reload the list. */ onChanged: () => void;`).
3. After `const quality = …` add:

```ts
  const retired = item.retired;
  const setRetirement = async (retire: boolean) => {
    if (
      retire &&
      !window.confirm(
        `Retire ${item.name}? It leaves uploads and new work; nothing is deleted, and an admin can unretire it.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      if (retire) await api.retireType(item.id);
      else await api.unretireType(item.id);
      onChanged();
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
```

4. In `.pills`, after the draft pill: `{retired && <span className="pill tone-neutral">Retired</span>}`; after the quality `<p>`: `{retired && <p className="muted">{retiredLine(retired)}</p>}`.
5. "New draft from vN" button: `disabled={busy || retired !== null}` and `title={retired ? RETIRED_REASON : undefined}`.
6. Replace the Test run `<label className="button" htmlFor={fileId}>Test run</label>` + `<input …/>` pair with:

```tsx
            {retired ? (
              <button type="button" disabled title={RETIRED_REASON}>
                Test run
              </button>
            ) : (
              <>
                <label className="button" htmlFor={fileId}>
                  Test run
                </label>
                <input
                  id={fileId}
                  className="visually-hidden"
                  type="file"
                  accept={SOURCE_ACCEPT}
                  aria-label={`Test run ${item.name} with a PDF or Word document`}
                  onChange={(e) => {
                    pickTestFile(e.target.files?.[0]);
                    e.target.value = '';
                  }}
                />
              </>
            )}
```

7. At the end of `.card-actions` add:

```tsx
        {role === 'admin' && (
          <button type="button" disabled={busy} onClick={() => void setRetirement(!retired)}>
            {retired ? 'Unretire' : 'Retire…'}
          </button>
        )}
```

`apps/web/src/templates/TemplatesPage.tsx`:

1. Props: add `role = 'user'` (type `role?: 'admin' | 'user';`).
2. State: `const [showRetired, setShowRetired] = useState(false);` and a reload:

```ts
  const reload = useCallback(() => {
    api.listTemplates().then(setItems, (err: Error) => setError(err.message));
  }, [api]);
  useEffect(reload, [reload]);
```

   (replacing the existing effect; import `useCallback`).
3. Filtering:

```ts
  const retiredCount = (items ?? []).filter((t) => t.retired).length;
  const shown = (items ?? []).filter(
    (t) => (showRetired || !t.retired) && matchesQuery(query, t.id, t.name),
  );
```

4. Below the page header (before the error line):

```tsx
      {retiredCount > 0 && (
        <label className="inline">
          <input
            type="checkbox"
            checked={showRetired}
            onChange={(e) => setShowRetired(e.target.checked)}
          />
          Show retired ({retiredCount})
        </label>
      )}
```

5. Pass `role={role}` and `onChanged={reload}` to each `<TemplateCard>`.

`apps/web/src/App.tsx`: `page = <TemplatesPage api={api} onNavigate={navigate} query={query} role={me.role} />;`

- [ ] **Step 4: Run the tests**

Run: `npx vitest run apps/web/test/editor-derive.test.ts apps/web/test/TemplatesPage.test.tsx apps/web/test/TemplateEditor.test.tsx apps/web/test/App.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/templates/TemplatesPage.tsx apps/web/src/templates/TemplateCard.tsx apps/web/src/App.tsx apps/web/src/templates/editor-derive.ts apps/web/src/templates/EditorHeader.tsx apps/web/src/templates/EmbeddedHeader.tsx apps/web/src/templates/TryOn.tsx apps/web/src/templates/TemplateEditor.tsx apps/web/test/editor-derive.test.ts apps/web/test/TemplatesPage.test.tsx apps/web/test/TemplateEditor.test.tsx
git commit -m "$(cat <<'EOF'
Web: retire and unretire on the Document types page; editor blocks a retired type

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Workbench list: Show retired and the Retired tag

**Files:**
- Modify: `apps/web/src/workbench/WorkbenchPage.tsx`, `apps/web/src/workbench/ProjectTable.tsx`, `apps/web/src/styles/stages.css`
- Test: `apps/web/test/WorkbenchPage.test.tsx`, `apps/web/test/ProjectTable.test.tsx`

**Interfaces:**
- Consumes: `ProjectListQuery.retired`, `ProjectListItem.retired` (Task 1), the client (Task 7).

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/test/WorkbenchPage.test.tsx`:

```tsx
describe('WorkbenchPage retired projects', () => {
  it('asks for retired projects only when Show retired is ticked', async () => {
    const api = fakeApi();
    page(api);
    await waitFor(() => expect(lastListCall(api)).toBeDefined());
    expect(lastListCall(api)?.retired).toBeUndefined();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Show retired' }));
    await waitFor(() => expect(lastListCall(api)).toMatchObject({ retired: 'include', page: 1 }));
  });
});
```

(Use the imports the file already has; add `waitFor`/`userEvent` if missing.)

Append to `apps/web/test/ProjectTable.test.tsx`:

```tsx
describe('retired projects in the list', () => {
  it('tags a retired project in the table and on its card', () => {
    const item = projectListItem({
      retired: { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' },
    });
    const { unmount } = render(
      <ProjectTable items={[item]} pinned={new Set()} onTogglePin={vi.fn()} now={Date.now()} />,
    );
    expect(screen.getByText('Retired')).toBeInTheDocument();
    unmount();
    render(<ProjectCard item={item} now={Date.now()} />);
    expect(screen.getByText('Retired')).toBeInTheDocument();
  });
});
```

(import `ProjectCard` from `'../src/workbench/ProjectTable.js'` if the file does not already.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/web/test/WorkbenchPage.test.tsx apps/web/test/ProjectTable.test.tsx`
Expected: FAIL: no "Show retired" checkbox; no "Retired" text.

- [ ] **Step 3: Implement**

`apps/web/src/workbench/WorkbenchPage.tsx`:

1. `ListState`: add `/** List retired document types too. */ retired: boolean;`.
2. Initial state: `retired: false,`.
3. `request()`: add `...(s.retired ? { retired: 'include' as const } : {}),` after the `policy` line.
4. In `.list-toolbar`, after the Models `<label>`:

```tsx
        <label className="inline list-select">
          <input
            type="checkbox"
            checked={state.retired}
            onChange={(e) => change({ retired: e.target.checked })}
          />
          Show retired
        </label>
```

`apps/web/src/workbench/ProjectTable.tsx`: after each `{item.dataPolicy === 'external' && <span className="ext-tag">EXT</span>}` (the card header and the table's title cell) add

```tsx
        {item.retired && <span className="retired-tag">Retired</span>}
```

`apps/web/src/styles/stages.css`: change the selector `.ext-tag {` to `.ext-tag,\n.retired-tag {` and add after that rule:

```css
.retired-tag {
  background: var(--ih-skip-bg);
  color: var(--ih-skip-fg);
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run apps/web/test/WorkbenchPage.test.tsx apps/web/test/ProjectTable.test.tsx apps/web/test/list-derive.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/WorkbenchPage.tsx apps/web/src/workbench/ProjectTable.tsx apps/web/src/styles/stages.css apps/web/test/WorkbenchPage.test.tsx apps/web/test/ProjectTable.test.tsx
git commit -m "$(cat <<'EOF'
Web: Workbench list hides retired projects unless Show retired is ticked

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Workbench project page: banner and disabled actions; docs

**Files:**
- Modify: `apps/web/src/workbench/ProjectPage.tsx`, `ProjectHeader.tsx`, `SamplesTab.tsx`, `RunsTab.tsx`, `ReferencesTab.tsx`, `EvaluateTab.tsx`, `GateCard.tsx`, `StagePanel.tsx`, `SurveyTab.tsx`, `ReviseTab.tsx`, `CLAUDE.md`
- Create: `apps/web/test/retired-project.test.tsx`
- Test: `apps/web/test/ProjectHeader.test.tsx`, `apps/web/test/ProjectPage.test.tsx`

**Interfaces:**
- Consumes: `ProjectView.retired` (Task 4), `RETIRED_REASON`, `RetiredBanner`, `unretireType` (Task 7).
- Produces: an optional prop `retired?: string | null` (default `null`; doc `/** Why job-creating actions are off (a retired document type); null when they are not. */`) on `SamplesTab`, `RunsTab`, `ReferencesTab`, `EvaluateTab`, `GateCard`, `StagePanel`, `SurveyTab`, `ReviseTab`. A non-null value disables the tab's job-creating button(s) with that value as `title`, ahead of any other reason.

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/retired-project.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RETIRED_REASON } from '../src/ui/retired.js';
import { EvaluateTab } from '../src/workbench/EvaluateTab.js';
import { GateCard } from '../src/workbench/GateCard.js';
import { ReferencesTab } from '../src/workbench/ReferencesTab.js';
import { ReviseTab } from '../src/workbench/ReviseTab.js';
import { RunsTab } from '../src/workbench/RunsTab.js';
import { SamplesTab } from '../src/workbench/SamplesTab.js';
import { StagePanel } from '../src/workbench/StagePanel.js';
import { SurveyTab } from '../src/workbench/SurveyTab.js';
import {
  fakeApi,
  projectOverview,
  projectView,
  publishGateView,
  referenceInfo,
  referenceRow,
  sampleView,
} from './fake-api.js';

const R = RETIRED_REASON;
const blockedByRetirement = async (name: string | RegExp) => {
  const button = await screen.findByRole('button', { name });
  expect(button).toBeDisabled();
  expect(button).toHaveAttribute('title', R);
};
const item = projectOverview().stages[0]!;

describe('a retired project disables every job-creating action with the reason', () => {
  it('Samples: adding samples', async () => {
    render(<SamplesTab api={fakeApi()} projectId="letter" pollMs={60_000} retired={R} />);
    const input = await screen.findByLabelText('Add sample documents');
    expect(input).toBeDisabled();
    expect(input).toHaveAttribute('title', R);
  });

  it('Test runs: Run on n dev samples', async () => {
    const api = fakeApi({ listSamples: vi.fn(async () => [sampleView()]) });
    render(
      <RunsTab
        api={api}
        projectId="letter"
        dataPolicy="local"
        draft={4}
        item={item}
        pollMs={60_000}
        onChanged={vi.fn()}
        retired={R}
      />,
    );
    await blockedByRetirement(/^Run on/);
  });

  it('Outputs: Propose outputs', async () => {
    render(
      <StagePanel
        api={fakeApi()}
        projectId="letter"
        stage="outputs"
        dataPolicy="local"
        hasDraft
        pollMs={1}
        onApplied={vi.fn()}
        onSkipped={vi.fn()}
        retired={R}
      />,
    );
    await blockedByRetirement('Propose outputs');
  });

  it('Survey: Run survey', async () => {
    render(
      <SurveyTab
        api={fakeApi()}
        projectId="letter"
        dataPolicy="local"
        brief={null}
        onBriefSaved={vi.fn()}
        pollMs={1}
        retired={R}
      />,
    );
    await blockedByRetirement('Run survey');
  });

  it('Revise: Ask the model for a revision', async () => {
    render(
      <ReviseTab
        api={fakeApi()}
        projectId="letter"
        dataPolicy="local"
        draft={4}
        pollMs={60_000}
        onApplied={vi.fn()}
        onChanged={vi.fn()}
        retired={R}
      />,
    );
    await blockedByRetirement('Ask the model for a revision');
  });

  it('Evaluate: Evaluate and Compare models', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      listReferenceRows: vi.fn(async () => [referenceRow({ reference: referenceInfo() })]),
    });
    render(
      <EvaluateTab
        api={api}
        projectId="letter"
        dataPolicy="local"
        draft={2}
        published={null}
        pollMs={1}
        onRestored={vi.fn()}
        onStarted={vi.fn()}
        onGateChanged={vi.fn()}
        retired={R}
      />,
    );
    await blockedByRetirement(/^Evaluate v2 on dev/);
    await blockedByRetirement('Compare models…');
  });

  it('References: the dev reference runs', async () => {
    render(
      <ReferencesTab
        api={fakeApi()}
        projectId="letter"
        dataPolicy="local"
        draft={2}
        published={1}
        item={item}
        pollMs={1}
        onChanged={vi.fn()}
        retired={R}
      />,
    );
    await blockedByRetirement(/^Run the draft model on/);
  });

  it('Gate card: Publish', async () => {
    render(
      <GateCard
        api={fakeApi()}
        projectId="letter"
        draft={2}
        published={1}
        gate={publishGateView()}
        publications={[]}
        threshold={{ value: 0.9, setBy: null, setAt: null }}
        devScore={null}
        onChanged={vi.fn()}
        onPublished={vi.fn()}
        retired={R}
      />,
    );
    await blockedByRetirement('Publish v2');
  });
});
```

(If a component's default fakes do not render the button, copy the setup of that component's own `tab()` helper from its test file; `SurveyTab` takes the same `brief` value its test file uses.)

Append to `apps/web/test/ProjectHeader.test.tsx`:

```tsx
  it('shows Retired and disables Publish for a retired type', () => {
    render(
      <ProjectHeader
        view={projectView({
          draft: 4,
          retired: { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' },
        })}
        gate={gateView()}
        role="user"
        onTogglePolicy={vi.fn()}
      />,
    );
    expect(screen.getByText('Retired')).toBeInTheDocument();
    const publish = screen.getByRole('button', { name: 'Publish v4' });
    expect(publish).toBeDisabled();
    expect(publish).toHaveAttribute('title', RETIRED_REASON);
    expect(screen.queryByRole('link', { name: 'Publish v4' })).toBeNull();
  });
```

(import `RETIRED_REASON` from `'../src/ui/retired.js'`.)

Append to `apps/web/test/ProjectPage.test.tsx`:

```tsx
describe('ProjectPage of a retired type', () => {
  const retired = { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' };
  it('shows the banner, and an admin can unretire it', async () => {
    const getProject = vi
      .fn()
      .mockResolvedValueOnce(projectView({ retired }))
      .mockResolvedValue(projectView());
    const api = fakeApi({
      getProject,
      getProjectOverview: vi.fn(async () => projectOverview()),
    });
    page(api, 'brief');
    expect(await screen.findByText(/Retired by ken on 14 Oct 2026/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Unretire' }));
    expect(api.unretireType).toHaveBeenCalledWith('letter');
    await waitFor(() => expect(screen.queryByText(/Retired by ken/)).toBeNull());
  });
});
```

(Use the file's existing `page()` helper, which renders with `role="admin"`; add `waitFor`/`userEvent` imports if missing. If the page loads the project through another call than `getProject`, stub that one instead.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/web/test/retired-project.test.tsx apps/web/test/ProjectHeader.test.tsx apps/web/test/ProjectPage.test.tsx`
Expected: FAIL: buttons enabled without the reason; no banner.

- [ ] **Step 3: Implement**

Every tab below gets the optional prop: add `retired = null,` to the destructured props and

```ts
  /** Why job-creating actions are off (a retired document type); null when they are not. */
  retired?: string | null;
```

to the props type. Import nothing else unless named.

- `SamplesTab.tsx`: the file input gets `disabled={uploading || summary.slots === 0 || retired !== null}` and `title={retired ?? undefined}`; `onDrop`'s condition becomes `if (!uploading && slotsLeft > 0 && retired === null)`.
- `RunsTab.tsx`: `const blocked = retired ?? (loading ? 'Loading samples…' : runBlockedReason(draft, selected.size));`
- `ReferencesTab.tsx`: `const devReason = retired ?? runReason(hasDraft, busy || running, devCount, 'dev');`, `const holdoutReason = retired ?? runReason(hasDraft, busy || running, holdoutCount, 'holdout');`, and the `reverifyReason={…}` expression becomes `reverifyReason={retired ?? (<the existing expression>)}`.
- `EvaluateTab.tsx`: wrap the existing `evaluateBlocked` expression as `const evaluateBlocked = retired ?? (<existing expression>);`, and `const compareBlocked = retired ?? (draft !== null && holdout ? COMPARE_HOLDOUT_REASON : evaluateBlocked);`. Pass `retired={retired}` to its `<GateCard …>`.
- `GateCard.tsx`: the Publish button gets `disabled={busy || retired !== null}` and `title={retired ?? (busy ? 'Working…' : undefined)}`.
- `StagePanel.tsx`: the propose button gets `disabled={running || busy || !hasDraft || retired !== null}` and `title={retired ?? undefined}`.
- `SurveyTab.tsx`: the run button gets `disabled={running || busy || unsavedAnswers || retired !== null}` and `title={retired ?? (unsavedAnswers ? 'Save your answers first' : undefined)}`.
- `ReviseTab.tsx`: `const askReason = retired ?? (<the existing expression>);`

`ProjectHeader.tsx` (import `RETIRED_REASON` from `'../ui/retired.js'`): after the "Developing vN" pill add `{view.retired && <span className="pill tone-neutral">Retired</span>}`, and replace the Publish link block with:

```tsx
        {draft !== null &&
          gate &&
          (view.retired ? (
            <button type="button" disabled title={RETIRED_REASON}>
              Publish v{draft}
            </button>
          ) : (
            <a className="button" href={`#/workbench/${project.id}/template`} title={gate.reason}>
              Publish v{draft}
            </a>
          ))}
```

`ProjectPage.tsx` (imports `RETIRED_REASON` from `'../ui/retired.js'` and `RetiredBanner` from `'../ui/RetiredBanner.js'`):

1. After `const { project, draft, published } = view;` add

```ts
  /** A retired type: every job-creating action is off, with this reason (D7). */
  const retired = view.retired ? RETIRED_REASON : null;
  const unretire = () =>
    void act(async () => {
      await api.unretireType(project.id);
      load();
      loadOverview();
    });
```

2. After `{error && <p role="alert">{error}</p>}` (below `<ProjectHeader …/>`) add

```tsx
      {view.retired && (
        <RetiredBanner
          retirement={view.retired}
          onUnretire={role === 'admin' ? unretire : undefined}
        />
      )}
```

3. Pass `retired={retired}` to `<SamplesTab>`, `<SurveyTab>`, both `<StagePanel>`s, `<ReferencesTab>`, `<EvaluateTab>`, `<ReviseTab>`, `<RunsTab>`.
4. The "Start v{n}" button (no open draft) gets `disabled={retired !== null}` and `title={retired ?? undefined}`.

(The Recipe tab's embedded editor learns the retirement itself from `listTemplates`: Task 8.)

`CLAUDE.md`:

1. Cross-language contracts table: add a row after "Job statuses and tasks":

```markdown
| Retired document types (migration 0030) | `RetirementSchema`, `retiredMessage` in `packages/shared/src/retirement.ts`; `SpecSummary.retired`, `ProjectView.retired`, `ProjectListItem.retired`, `ProjectListQuery.retired`; `TemplateRepo.retire/unretire/retirement/listRetirements`, `apps/api/src/templates/retirement.ts` (TS only) | none: the worker never reads `document_type_retirements`; queued jobs finish |
```

2. Rules of the road: add a bullet after "Templates live in the database":

```markdown
- **Retired document types (migration 0030):** an admin retires or unretires a type (every version, recipe or legacy spec) with `PUT|DELETE /api/specs/:id/retirement` (admin-only, logged `document type retired`/`unretired`; retiring again keeps the first retirement; unretiring a type that is not retired is a 204; unknown is a 404). The row (`document_type_retirements`: `type_id`, `retired_at`, `retired_by` = token label) lives with the type, not a version, so seeding a missing `specs/*/template.yaml` version keeps the type retired, and deleting a never-published Workbench project removes it. Nothing is deleted and everything stays readable. Hidden by default: `GET /api/specs` (`?retired=include` lists them with `retired`; Jobs, Home and Results ask for them so old jobs keep their names; the upload strip never offers one), the Document types page (*Show retired*), the Workbench list (`retired=include`; `ids=` still returns them). `GET /api/templates` and every `ProjectView` carry `retired`; the Workbench list overlays it live (never cached; `LIST_CACHE_VERSION` 4). New work is a 409 `<name> is retired: unretire it to use it again` (`retiredProblem`, the `refuseRetired` preHandler): uploads and Templates test runs, retry/re-process of any of its jobs, regression runs, a new type under a retired legacy id, new drafts, publishing (both routes), YAML import, Workbench project creation, bundle import under that id, sample uploads, dev test runs, every drafting stage, holdout reference runs, re-verify, evaluate and compare. Allowed: reading, edits that queue no job (draft, brief, feedback, proposals, skip/keep, restore, policy, threshold, sample role), deletes, cancel, review of jobs already awaiting review (approve, reject, step re-run), saving a reference, anchor previews and bundle export. Jobs already queued or running finish (the worker is unchanged). The web disables each job-creating button with `RETIRED_REASON` (`apps/web/src/ui/retired.ts`) and shows `RetiredBanner` (admins get *Unretire*) on the project page and the standalone recipe editor; Retry buttons are not pre-disabled (the dialog shows the 409).
```

- [ ] **Step 4: Run the tests, then everything CI checks**

Run: `npx vitest run apps/web/test/retired-project.test.tsx apps/web/test/ProjectHeader.test.tsx apps/web/test/ProjectPage.test.tsx apps/web/test/SamplesTab.test.tsx apps/web/test/RunsTab.test.tsx apps/web/test/ReferencesTab.test.tsx apps/web/test/EvaluateTab.test.tsx apps/web/test/GateCard.test.tsx apps/web/test/StagePanel.test.tsx apps/web/test/SurveyTab.test.tsx apps/web/test/ReviseTab.test.tsx`
Expected: PASS.

Run: `npm run check`
Expected: green (lint, format, typecheck, every TS test, worker lint and tests unchanged).

Run the Pg integration test once more (Global Constraints). Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/ProjectPage.tsx apps/web/src/workbench/ProjectHeader.tsx apps/web/src/workbench/SamplesTab.tsx apps/web/src/workbench/RunsTab.tsx apps/web/src/workbench/ReferencesTab.tsx apps/web/src/workbench/EvaluateTab.tsx apps/web/src/workbench/GateCard.tsx apps/web/src/workbench/StagePanel.tsx apps/web/src/workbench/SurveyTab.tsx apps/web/src/workbench/ReviseTab.tsx apps/web/test/retired-project.test.tsx apps/web/test/ProjectHeader.test.tsx apps/web/test/ProjectPage.test.tsx CLAUDE.md
git commit -m "$(cat <<'EOF'
Web: retired project banner; job-creating actions disabled with the reason

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** reversible flag (Tasks 2–3); nothing deleted, readable (Task 4 "still resolves", Task 5/6 "allowed" tests); hidden from upload picker, `GET /api/specs`, Document types page, Workbench list, search (Tasks 4, 7–9; the page searches filter the shown set, the Workbench search is server-side after the retired filter); 409 refusals (Tasks 5–6); queued jobs finish, worker untouched (D6, CLAUDE.md row); retry refused (Task 5); admin-only, who/when shown, logged (Task 3, Task 7 `retiredLine`, Task 8 card line, Task 10 banner); open draft / project allowed with banner and disabled actions (Task 10); seeding (Task 4); legacy specs (Task 3 test, D10).
- **Type consistency:** `retire(id, by)` returns `{ retirement, created }` everywhere; `RETIRED_REASON` (web) vs `retiredMessage` (shared, API 409) are deliberately different texts; the `retired` prop on tabs is `string | null` (a reason), while `TemplateListItem.retired`, `ProjectView.retired` and `ProjectListItem.retired` are `Retirement | null`.
