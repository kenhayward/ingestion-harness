# Retire document types: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin can **retire** a document type (every version at once, database recipe or legacy file-only `spec.yaml`) from the Document types page or the API, and **unretire** it again through the API only. Nothing is deleted: old jobs, results, references and published recipes stay readable. A retired type disappears from the Document types page, the upload picker and the Workbench list, and the API refuses new work for it with a 409 `<title> is retired: unretire it to use it again`.

**Architecture:**

- *Migration 0030* (`db/migrations/0030_document_type_retirements.sql`): one row per retired type id (`type_id` PK, `retired_at`, `retired_by`). No foreign key, so the same table covers database recipes and file-only legacy `spec.yaml` types. Unretiring deletes the row.
- *Shared* (`packages/shared/src/retirement.ts`): `RetirementSchema`, `retiredMessage(title)`. `SpecSummary.retired?`, `SpecSummary.kind?` (moved up from the API's `DefinitionSummarySchema`, so the web can tell a legacy file-only spec from a recipe), `ProjectView.retired`, `ProjectListItem.retired`, `ProjectListQuery.retired` (`include`), and `queryProjects` leaves retired rows out unless `retired=include` or `ids` names them.
- *API*: `TemplateRepo` gets `listRetirements/retirement/retire/unretire` (Memory and Pg; `WorkbenchRepo.deleteProject` drops the row of a deleted type). `apps/api/src/templates/retirement.ts` has the guard (`retiredProblem`, the `refuseRetired` preHandler). New admin routes `PUT|DELETE /api/specs/:id/retirement` (tag Specs, `x-admin`, logged). Listings: `GET /api/specs` hides retired types unless `?retired=include`, `GET /api/templates` and every `ProjectView` carry `retired`, and the Workbench list overlays the live retirement on its cached rows (`LIST_CACHE_VERSION` 3 → 4). Refusals cover uploads, retry, recipe create/draft/publish/import, regression, Workbench project creation, bundle import and every Workbench route that queues model or document work.
- *Worker*: **unchanged.** It never reads the table, and jobs already queued or running finish.
- *Web*: client (`listSpecs({ retired })`, `retireType`, `TemplateListItem.retired`; **no** `unretireType`: unretiring is API-only), `ui/retired.ts` + `ui/RetiredBanner.tsx` (who and when, plus "An admin can unretire it through the API: DELETE /api/specs/{id}/retirement."), the Document types page (retired types left off entirely, no toggle; legacy file-only types listed as read-only cards built from `GET /api/specs` `kind: 'spec'` rows; admin *Retire…* on every card through a confirm `Dialog`), the recipe editor of a retired type opened by URL (read-only, banner, every job-creating and publish action disabled with the reason), the Workbench list (retired projects left out, no toggle; pinned and recent cards still show them with a *Retired* tag), and the project page (banner, no Unretire, every job-creating button disabled with a reason).

**Tech Stack:** Zod (shared), Fastify + OpenAPI route docs, PostgreSQL 17, React 19, Vitest + Testing Library, CSS on existing `--ih-*` tokens.

**Spec:** the feature request in this session (no design doc). Conventions: `CLAUDE.md` (TDD, forward-only migrations, ports and adapters, routes documented, access sweep, terminology).

---

## Decisions

Each choice below is built into the tasks. Rows marked **Decided (user)** were settled by the user on 14 Oct 2026 and override any earlier wording; the others are recommendations the user has not flipped (flip any of them before execution starts).

| # | Decision | Built in | Alternative |
| --- | --- | --- | --- |
| D1 | **Where the flag lives** | Its own table keyed by type id (`document_type_retirements`), no FK, so legacy `spec.yaml` types can be retired too. Unretire **deletes** the row: the history is only in the API log. | Keep history rows (`unretired_at`, `unretired_by`) for an audit trail. |
| D2 | **`GET /api/specs`** | Hides retired types by default (the route's documented meaning is "available for upload"). `?retired=include` lists them too, each with a `retired` field. Jobs, Home and Results ask with `include`, so old jobs keep their type titles and the Results type filter keeps retired types. Every row carries `kind` (`spec` or `template`), which the Document types page uses for its legacy cards (D16). | Always list every type with the field and let each picker filter. |
| D3 | **Other listings** | `GET /api/templates` returns every type with `retired` (nullable); the Document types page leaves retired ones out on the client (D15). The Workbench list filters on the server (`retired=include` exists for API callers only, D18). When `ids=` names projects (the pinned and recent cards), retired ones are still returned, with their tag. | Hide retired pins too. |
| D4 | **Refused (409) for a retired type** | Document upload (and Templates-page test runs, which use the same route), retry/re-process of **any** job of the type, regression runs, `POST /api/templates` with a retired id (a legacy id), new drafts, publishing (Templates and Workbench routes), YAML import (draft or published), Workbench project creation, bundle import under that id, sample upload, dev test runs, every drafting stage (survey, outputs, sections, steps, references, revise), holdout reference runs, re-verify, evaluate, compare. | — |
| D5 | **Allowed for a retired type** (approve: **Decided (user)**) | Reading everything. Edits that queue no job: saving the draft, the brief, feedback, deciding proposals, skip/keep a stage, restoring an iteration, data policy, threshold, sample role (an API rule: the web's recipe editor is stricter, D17). Deleting drafts, samples, jobs, references and the (never-published) project. Cancel. **Review of jobs already awaiting review**: a production job of a retired type already awaiting review is **approved and delivered normally** (queued as a `publish` task that delivers to the target; pinned by a Task 5 test), reject, step re-run. Saving a reference from a finished run. **Anchor previews** (segment jobs: no model call, no document, one per project) and **bundle export** (an archive). | Refuse previews and step re-runs too (then the Sections tab needs disabling as well). |
| D6 | **Jobs already queued or running** | They finish. The worker is not changed: retiring is a "no new work" switch, not a kill switch. Cancel stays available. | A worker check at claim time (needs a Python reader of the table and a new job outcome). |
| D7 | **Retire with an open draft or a Workbench project** | Allowed. The project page shows a retired banner (who, when, and the unretire route; **no Unretire button**, D14) and every job-creating action is disabled with the reason. | Refuse retiring while a draft is open. |
| D8 | **Idempotency** | Retiring a retired type answers 200 with the **first** retirement (who/when unchanged, nothing logged). Unretiring a type that is not retired is a 204. An unknown type is a 404 for both. | 409 on a repeated retire. |
| D9 | **Seeding** | `seedTemplates` still imports a missing `specs/<id>/v<N>/template.yaml` version (published), and the type **stays retired**: the flag lives with the type, not the version, and seeding never touches the table. Pinned by a test. | Skip seeding retired types. |
| D10 | **Legacy `spec.yaml` types** (**Decided (user)**) | Retirable through the API (`PUT /api/specs/:id/retirement` accepts any id in the registry or the database) **and** on the Document types page: file-only legacy types are listed there as read-only cards (D16) with an admin *Retire…*. Once retired they are hidden from uploads and from the page and refused like any type. | — |
| D11 | **Deleting a never-published Workbench project** | Also deletes its retirement row (the type is gone; a stale row would block reusing the id). | Keep the row. |
| D12 | **No reason field** | Retire takes no body (YAGNI). The type shows "Retired by X on 14 Oct 2026". | An optional `reason` (1-200 chars) shown on the banner. |
| D13 | **Retry buttons** | Jobs page *Retry…/Re-process…*, Runs tab *Retry* and the Samples tab's prepare retry are **not** pre-disabled (the job lists do not know which types are retired); the re-process dialog keeps the 409 on screen. The recipe editor (standalone and embedded: Publish, Save draft, New draft, Try on, the Test rail and Run regression) and the Workbench project page disable their own job-creating buttons with a reason. The Document types page never shows a retired type, so its cards need no retired state. | Feed the retired ids to `JobActions` too. |
| D14 | **API path; who unretires** (**Decided (user)**) | `PUT /api/specs/:id/retirement` (retire) and `DELETE /api/specs/:id/retirement` (unretire), tag *Specs*, both admin-only. **Unretire is API-only for every type**: no Unretire button anywhere in the web (Document types page, recipe editor, Workbench project banner, Workbench list). The web client has `retireType` and no `unretireType`. Banners and tags say who retired the type and when, and name the route an admin uses to unretire it. | — |
| D15 | **Retired types on the Document types page** (**Decided (user)**) | **Not shown at all**: no *Show retired* tick box, no retired cards. Retiring a type from the page removes its card and leaves a status line naming the unretire route. | — |
| D16 | **Legacy cards on the Document types page** (**Decided (user)**; shape recommended) | Built from `GET /api/specs` (without `retired`: the API already leaves retired types out): every `kind: 'spec'` row whose id has **no** database recipe in `GET /api/templates` (any status, retired included, so a retired recipe never reappears as a legacy card), grouped by id (`legacyTypes` in `apps/web/src/templates/legacy.ts`). Card: the newest version's title, the id, a *Legacy spec (file)* tag, the versions (`Versions v1, v2`), a one-line "read-only here" note, no editor link, no Test run or export, and *Retire…* for admins. Shown after the recipe cards and filtered by the same top-bar search. | List legacy types through `GET /api/templates` (a server-side change for every caller). |
| D17 | **A retired type's recipe editor opened by URL** (**Decided (user)**; recommended behaviour) | It opens **read-only**, like a published version (the editor's `editable` is false: every field, Apply YAML and the step buttons are disabled). Standalone (`#/templates/:id/:version`): the retired banner under the header; Publish, Save draft, New draft from vN, the Test rail (sample input and Run test) and *Run regression on vN…* are disabled with `RETIRED_REASON`; Export YAML and *More → Delete draft* stay (deleting is allowed, D5). Embedded (the Workbench Recipe tab): the same read-only form and disabled Try on / Publish / New draft; the banner is the project page's. The API still accepts a draft save (D5), so an unretire needs no repair. | Keep the editor editable (hand saves allowed) and block only job-creating and publish actions. |
| D18 | **Workbench list** (**Decided (user)**; recommended behaviour) | Retired projects are **hidden by default with no toggle** in the main list (the web never sends `retired=include`; the API keeps the parameter for API callers). Pinned and recent cards (`ids=`) and direct project URLs still open the project: the card and the row show a *Retired* tag whose `title` says who retired it, when, and the unretire route; the project page shows the banner and disables its job-creating actions. | A *Show retired* toggle in the list. |

**Still open (recommendations, not yet confirmed):** D12 (no reason field), D13 (Retry buttons not pre-disabled on the Jobs page and the Runs tab), and D17's embedded half (the Workbench Recipe tab is read-only too, while the project's other no-job edits, such as the brief, feedback and deciding a pending proposal, stay available per D5).

---

## Global Constraints

- **Terminology:** users see **document type** for the type and **recipe** for a template. New UI text says "retired", "Retire…", never "archive". Code names, API paths and tables keep `template`/`spec`. The legacy card's tag is exactly *Legacy spec (file)*.
- **Unretire is API-only (D14):** no element in the web is named or labelled *Unretire* (tests assert `queryByRole('button', { name: /unretire/i })` is null on the Document types page, the recipe editor and the project page). Where the web explains how to bring a type back it uses `unretireHint(id)` = `` `An admin can unretire it through the API: DELETE /api/specs/${id}/retirement.` `` (`apps/web/src/ui/retired.ts`).
- **Retired types never appear on the Document types page (D15)**, as cards or in its counts and empty states; the legacy cards come from `GET /api/specs` without `retired`, which already leaves them out.
- **Model names, never refs** in normal-user UI (no change expected here; do not print refs in banners or titles).
- **The refusal text is exact:** `retiredMessage(title)` = `` `${title} is retired: unretire it to use it again` ``, where `title` is the newest recipe's `name`, else the legacy spec's `title`, else the id. Every refusal is a **409**.
- **Disabled buttons carry a `title` reason (tested):** the reason is `RETIRED_REASON` = `This document type is retired: an admin can unretire it through the API` (`apps/web/src/ui/retired.ts`). A retired reason wins over any other reason for the same button.
- **`.card` has no padding.** This plan adds no new padded card: the legacy card reuses `.type-card` (with its existing `.type-card-head`, `.pills`, `.card-actions`), the retire confirm reuses `Dialog`. The banner reuses `.stale-banner` (`data-tone="skip"`); the list tag extends the existing `.ext-tag` rule in `apps/web/src/styles/stages.css` (do not duplicate its declarations). Existing tokens only (`--ih-skip-bg`, `--ih-skip-fg`).
- **Testing Library by role and label**, never class names, except where an existing test in that file already does.
- **Admin-only routes:** the check runs in a `preHandler` before anything else (so the OpenAPI `x-admin` test sees `403 admins only` for a user, whatever the id), the route is marked `'x-admin': true`, and documents `403`.
- **Every route documented**; every new or changed response status is in the route's `response` (the conformance check runs in every API test). Run `npm run openapi` and commit `docs/openapi.json` in each task that changes a route.
- **Migration** is `0030_document_type_retirements.sql` (highest existing is 0029). Forward-only.
- **Cross-language contracts:** none. The worker never reads `document_type_retirements` (the CLAUDE.md table says so, Task 11).
- **Pg integration:** `docker run --rm -d --name ih-test-pg-retire -e POSTGRES_PASSWORD=test -p 55448:5432 postgres:17-alpine`, then `IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55448/postgres npx vitest run --config apps/api/vitest.integration.config.ts workbench-pg`, then `docker rm -f ih-test-pg-retire`.
- Tests first (red, then green); `npm run check` green at the end; never `git add -A` (stage the files each task names); commit messages end with a blank line and `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A retired type reached by another door.** The guard is per route, so a new job-creating route added later could forget it. Task 6's table test lists every Workbench POST that queues a job and asserts that no job of any kind (process, prepare, draft) was created; Task 5 does the same for uploads, retry and regression. A reviewer should grep `createDocumentAndJob|createWorkbenchJob|createDraftJob|createRegressionJob|retryJob|addSampleFile` and check each caller is guarded or listed as allowed in D5.
2. **Seeding after a retire.** A deploy that adds `specs/<id>/v<N+1>/template.yaml` for a retired type seeds the version but must leave the type retired and hidden (Task 4 test, D9).
3. **Old jobs keep their names.** Jobs, Home and Results read titles from `GET /api/specs`; with retired types hidden by default they must ask with `?retired=include`, or every old job of a retired type would show its raw id (Task 7 tests).
4. **The cached Workbench list after a retire.** Retiring changes no table the list fingerprint reads, so the retirement is overlaid on every request instead of cached; a retire or unretire shows on the next list request without recomputing rows (Task 4 test: retire, list, unretire, list).
5. **Retire racing a deleted project, or a double click.** Retiring twice keeps the first retirement and logs once (D8, Pg test with two concurrent `retire` calls); deleting a never-published project removes its retirement in the same transaction (Task 2 Pg test).
6. **Legacy cards never duplicate a recipe.** A type with both `spec.yaml` file versions and a database recipe (`process-validation-protocol`: v1-v2 `spec.yaml`, v3 seeded `template.yaml`) is a recipe card only; a retired recipe never reappears as a legacy card (the recipe ids come from `GET /api/templates`, retired included). `legacyTypes` table test, Task 8.
7. **No Unretire in the web.** grep `apps/web/src` for `unretire` (case-insensitive): only `unretireHint`, its text and comments saying unretiring is API-only may match (Task 11 Step 4).

## Deviations and notes

- The web never pre-disables the Jobs page and Runs tab Retry buttons (D13); the API's 409 is shown in the re-process dialog.
- Anchor previews and bundle export stay allowed (D5), so the Sections tab and the Brief tab's export panel are unchanged.
- The recipe editor of a retired type is read-only (D17), stricter than the API (which still accepts a draft save, D5). Its Test rail and Run regression are disabled with the reason (this replaces the earlier "not pre-disabled" note).
- `SpecSummarySchema.kind` moves from the API-only `DefinitionSummarySchema` to the shared schema as an optional field; the API still always sends it (`DefinitionSummarySchema` overrides it as required), so `docs/openapi.json` does not change for it.

---

## File map

| File | Change |
| --- | --- |
| `packages/shared/src/retirement.ts` | Create: `RetirementSchema`, `retiredMessage` |
| `packages/shared/src/index.ts` | export it |
| `packages/shared/src/spec.ts` | `SpecSummarySchema.retired` and `SpecSummarySchema.kind` (both optional) |
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
| `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`, `apps/web/test/client.test.ts` | client (`retireType` only; no `unretireType`) |
| `apps/web/src/ui/retired.ts`, `apps/web/src/ui/RetiredBanner.tsx` | Create (`RETIRED_REASON`, `retiredLine`, `unretireHint`, `retiredNote`; the banner has no button) |
| `apps/web/src/{home/HomePage,jobs/JobsPage,results/ResultsPage,jobs/UploadStrip}.tsx` | `listSpecs` |
| `apps/web/src/templates/legacy.ts`, `apps/web/src/templates/LegacyTypeCard.tsx`, `apps/web/src/templates/RetireDialog.tsx` | Create: `legacyTypes`, the read-only legacy card, the retire confirm |
| `apps/web/src/templates/{TemplatesPage,TemplateCard}.tsx`, `apps/web/src/App.tsx` | Document types page: retired left out, legacy cards, admin *Retire…* |
| `apps/web/src/templates/{TemplateEditor,EditorHeader,EmbeddedHeader,TryOn,TestRail,QualityPanel,editor-derive}.tsx/.ts` | read-only editor of a retired type |
| `apps/web/test/legacy-types.test.ts` | Create |
| `apps/web/src/workbench/{WorkbenchPage,ProjectTable}.tsx` | list (no toggle; *Retired* tag on cards and rows) |
| `apps/web/src/workbench/{ProjectPage,ProjectHeader,SamplesTab,RunsTab,ReferencesTab,EvaluateTab,GateCard,StagePanel,SurveyTab,ReviseTab}.tsx` | project page (banner without Unretire) |
| `apps/web/src/styles/stages.css` | `.retired-tag` |
| `apps/web/test/*.test.tsx` | tests named per task |
| `CLAUDE.md`, `docs/openapi.json` | docs |

---

### Task 1: Shared schemas (retirement, summaries, project list)

**Files:**
- Create: `packages/shared/src/retirement.ts`, `packages/shared/test/retirement.test.ts`
- Modify: `packages/shared/src/index.ts`, `packages/shared/src/spec.ts`, `packages/shared/src/workbench.ts`, `packages/shared/src/overview.ts`, `packages/shared/test/overview-list.test.ts`, `apps/web/test/fake-api.ts`

**Interfaces:**
- Produces: `RetirementSchema` / `type Retirement = { retiredAt: string; retiredBy: string | null }`; `retiredMessage(title: string): string`; `SpecSummary.retired?: Retirement`; `SpecSummary.kind?: 'spec' | 'template'` (moved from the API's `DefinitionSummarySchema`, which keeps it required; the Document types page's legacy cards read it, Task 8); `ProjectView.retired: Retirement | null`; `ProjectListItem.retired: Retirement | null` (`listItemFrom` always sets `null`; the API overlays the live value); `ProjectListQuery.retired?: 'include'`.
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

  it('says whether a listed type is a legacy spec file or a recipe (legacy cards)', () => {
    const summary = { id: 'demo', version: 2, title: 'Demo v2' };
    expect(SpecSummarySchema.parse({ ...summary, kind: 'spec' }).kind).toBe('spec');
    expect(SpecSummarySchema.parse({ ...summary, kind: 'template' }).kind).toBe('template');
    expect(SpecSummarySchema.parse(summary).kind).toBeUndefined();
    expect(SpecSummarySchema.safeParse({ ...summary, kind: 'file' }).success).toBe(false);
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
Expected: FAIL: `retiredMessage` / `RetirementSchema` are not exported; `retired` is not a known query key; `kind` is stripped (undefined) by `SpecSummarySchema`.

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
  /**
   * `spec`: a legacy spec.yaml file; `template`: a recipe. The API always sends it
   * (`DefinitionSummarySchema` makes it required); the Document types page lists `spec` rows
   * without a database recipe as legacy cards.
   */
  kind: z
    .enum(['spec', 'template'])
    .optional()
    .describe('`spec`: a legacy spec.yaml; `template`: a template.'),
```

`apps/api/src/specs/spec-registry.ts` keeps `DefinitionSummarySchema = SpecSummarySchema.extend({ kind: … })` unchanged: the extension overrides the optional field with the required one, so the API's response schema and `docs/openapi.json` stay the same.

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
          Makes a retired document type available again for uploads and new work. This route is
          the only way to unretire a type: the web app has no Unretire button (retiring is also on
          the Document types page). A type that is not retired is left as it is (still a 204).
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
    readable; also on the Document types page) and unretire it (here only).
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

  it('lists legacy file-only types with kind spec until retired (the legacy cards, D16)', async () => {
    const { app } = await retiredLetter();
    const legacy = (body: { id: string; version: number; kind: string }[]) =>
      body.filter((s) => s.kind === 'spec').map((s) => `${s.id} v${s.version}`);
    expect(legacy((await app.inject('/api/specs')).json())).toEqual(['demo v1', 'demo v2']);
    await app.inject(retire('demo'));
    expect(legacy((await app.inject('/api/specs')).json())).toEqual([]);
    expect(legacy((await app.inject('/api/specs?retired=include')).json())).toEqual([
      'demo v1',
      'demo v2',
    ]);
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
Expected: the listing tests FAIL (retired types still listed; no `retired` fields; the retired `demo` still listed). The seeding test PASSES already (seeding never touches the table): it pins the behaviour, so keep it. (If `testApp()`'s registry holds legacy specs other than `demo` v1-v2, list them too: the test pins exactly the `kind: 'spec'` rows `helpers.ts` registers.)

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
  it('saves and deletes the draft and reads versions', async () => {
    const { app } = await retired();
    const save = await app.inject({
      method: 'PUT',
      url: '/api/templates/letter/versions/2',
      payload: { definition: { ...letter(2), name: 'Letter' } },
    });
    expect(save.statusCode).toBe(200);
    expect((await app.inject('/api/templates/letter/versions/1')).statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'DELETE', url: '/api/templates/letter/versions/2' })).statusCode,
    ).toBe(204);
  });

  it('approves a production job already awaiting review: queued to publish and deliver (D5, decided)', async () => {
    const { app, job, repo } = await retired();
    expect(job.test).toBe(false); // a production upload, not a test run
    repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'awaiting_review' });
    const approve = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/approve`,
      payload: { reviewer: 'kh' },
    });
    expect(approve.statusCode).toBe(200);
    // The same as for an active type: the worker's publish task delivers it to the target.
    expect(approve.json()).toMatchObject({
      id: job.id,
      status: 'queued',
      task: 'publish',
      test: false,
      reviewer: 'kh',
    });
  });

  it('rejects a job of a retired type awaiting review', async () => {
    const { app, job, repo } = await retired();
    repo.jobs.set(job.id, { ...repo.jobs.get(job.id)!, status: 'awaiting_review' });
    const reject = await app.inject({
      method: 'POST',
      url: `/api/jobs/${job.id}/reject`,
      payload: { reason: 'type retired' },
    });
    expect(reject.statusCode).toBe(200);
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
Expected: FAIL: the refusals answer 201/200 (or 400 for the empty regression), not 409. The three D5 tests PASS already (approve, reject and draft saves have no guard): they pin the decided behaviour, so keep them, and Step 3 must not add a guard to `review.ts`.

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

Run: `npx vitest run apps/api/test/retirement-refusals.test.ts apps/api/test/documents.test.ts apps/api/test/jobs.test.ts apps/api/test/templates.test.ts apps/api/test/regression.test.ts apps/api/test/review.test.ts`
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
  - `Api.retireType(id: string): Promise<{ id: string; retired: Retirement }>` (admins). **No `unretireType`**: unretiring is API-only (D14).
  - `TemplateListItem.retired: Retirement | null`
  - `listProjectPage` sends `retired` when a caller passes it (via `ProjectListQuery`, Task 1; the web itself never does, D18)
  - `apps/web/src/ui/retired.ts`: `RETIRED_REASON: string`, `retiredLine(r: Retirement): string`, `unretireHint(id: string): string`, `retiredNote(r: Retirement, id: string): string`
  - `<RetiredBanner retirement typeId />` (`apps/web/src/ui/RetiredBanner.tsx`): no button

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/retired-ui.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RETIRED_REASON, retiredLine, retiredNote, unretireHint } from '../src/ui/retired.js';
import { RetiredBanner } from '../src/ui/RetiredBanner.js';

const retirement = { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' };

describe('retired helpers', () => {
  it('says who retired it and when', () => {
    expect(retiredLine(retirement)).toBe('Retired by ken on 14 Oct 2026');
    expect(retiredLine({ ...retirement, retiredBy: null })).toBe('Retired on 14 Oct 2026');
  });
  it('gives one reason for every disabled action', () => {
    expect(RETIRED_REASON).toBe(
      'This document type is retired: an admin can unretire it through the API',
    );
  });
  it('names the route an admin unretires with (API only, D14)', () => {
    expect(unretireHint('letter')).toBe(
      'An admin can unretire it through the API: DELETE /api/specs/letter/retirement.',
    );
    expect(retiredNote(retirement, 'letter')).toBe(
      'Retired by ken on 14 Oct 2026. An admin can unretire it through the API: DELETE /api/specs/letter/retirement.',
    );
  });
});

describe('RetiredBanner', () => {
  it('explains what retired means and how an admin brings it back, with no button', () => {
    render(<RetiredBanner retirement={retirement} typeId="letter" />);
    const note = screen.getByRole('note');
    expect(note).toHaveTextContent('Retired by ken on 14 Oct 2026');
    expect(note).toHaveTextContent(/Nothing new runs for it/);
    expect(note).toHaveTextContent('DELETE /api/specs/letter/retirement');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
```

Append to `apps/web/test/client.test.ts`:

```ts
describe('http api: retired document types', () => {
  it('lists specs with or without retired ones, and retires', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? Response.json({ id: 'a b', retired: { retiredAt: 'x', retiredBy: null } })
        : Response.json([]),
    );
    vi.stubGlobal('fetch', fetchMock);
    const api = createHttpApi('/api');
    await api.listSpecs();
    await api.listSpecs({ retired: 'include' });
    await api.retireType('a b');
    await api.listProjectPage({ retired: 'include' });
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init?.method ?? 'GET'])).toEqual([
      ['/api/specs', 'GET'],
      ['/api/specs?retired=include', 'GET'],
      ['/api/specs/a%20b/retirement', 'PUT'],
      ['/api/workbench/projects?retired=include', 'GET'],
    ]);
    // Unretiring is API-only (D14): the web client has no call for it.
    expect('unretireType' in api).toBe(false);
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
  'This document type is retired: an admin can unretire it through the API';

/** "Retired by ken on 14 Oct 2026". */
export function retiredLine(r: Retirement): string {
  const on = new Date(r.retiredAt).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  return r.retiredBy ? `Retired by ${r.retiredBy} on ${on}` : `Retired on ${on}`;
}

/** Unretiring is API-only (D14): the web names the route instead of offering a button. */
export const unretireHint = (id: string) =>
  `An admin can unretire it through the API: DELETE /api/specs/${id}/retirement.`;

/** "Retired by ken on 14 Oct 2026. An admin can unretire it through the API: …" (tag titles). */
export const retiredNote = (r: Retirement, id: string) => `${retiredLine(r)}. ${unretireHint(id)}`;
```

Create `apps/web/src/ui/RetiredBanner.tsx`:

```tsx
import type { Retirement } from '@ih/shared';
import { retiredLine, unretireHint } from './retired.js';

/**
 * A retired document type: who retired it, what that means, and the API route an admin
 * unretires it with (there is no Unretire button, D14). Reuses the stale banner's look in its
 * grey `skip` tone.
 */
export function RetiredBanner({ retirement, typeId }: { retirement: Retirement; typeId: string }) {
  return (
    <div className="stale-banner" role="note" data-tone="skip">
      <p className="stale-banner-text">
        <strong>{retiredLine(retirement)}.</strong> Nothing new runs for it: uploads, test runs,
        drafting and publishing are off. Its jobs, results and references stay readable.{' '}
        {unretireHint(typeId)}
      </p>
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
  /** Admins: retire a document type (all its versions). Unretiring is API-only (D14). */
  retireType(id: string): Promise<{ id: string; retired: Retirement }>;
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
```

   (`post(url, body, method)` is the file's helper, as `setLlmSettings` uses it.) In `listProjectPage` add `if (query.retired) params.set('retired', query.retired);` after the `policy` line.

`apps/web/test/fake-api.ts`: add to `fakeApi` defaults

```ts
    retireType: vi.fn(async (id: string) => ({
      id,
      retired: { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' },
    })),
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

### Task 8: Document types page: retired left out, legacy cards, admin Retire…

**Files:**
- Create: `apps/web/src/templates/legacy.ts`, `apps/web/src/templates/LegacyTypeCard.tsx`, `apps/web/src/templates/RetireDialog.tsx`, `apps/web/test/legacy-types.test.ts`
- Modify: `apps/web/src/templates/TemplatesPage.tsx`, `apps/web/src/templates/TemplateCard.tsx`, `apps/web/src/App.tsx`
- Test: `apps/web/test/TemplatesPage.test.tsx`

**Interfaces:**
- Consumes: Task 1 (`SpecSummary.kind`), Task 7 (`listSpecs`, `retireType`, `TemplateListItem.retired`, `unretireHint`).
- Produces:
  - `legacyTypes(specs: readonly SpecSummary[], recipeIds: ReadonlySet<string>): LegacyType[]`, `versionsText(versions): string`, `interface LegacyType { id; title; description: string | null; versions: number[] }` (`apps/web/src/templates/legacy.ts`)
  - `<LegacyTypeCard item onRetire? />`, `<RetireDialog api id name onRetired onClose />`
  - `TemplatesPage` prop `role?: 'admin' | 'user'` (default `'user'`); `TemplateCard` prop `onRetire?: () => void` (passed to admins only)
- Decisions: D10, D15, D16 (retired types never on the page; legacy file-only types as read-only cards; *Retire…* for admins on every card through a confirm `Dialog`; no Unretire, D14).

- [ ] **Step 1: Write the failing tests**

Create `apps/web/test/legacy-types.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { SpecSummary } from '@ih/shared';
import { legacyTypes, versionsText, type LegacyType } from '../src/templates/legacy.js';

const spec = (
  id: string,
  version: number,
  title = id,
  kind: SpecSummary['kind'] = 'spec',
): SpecSummary => ({ id, version, title, kind });
const legacy = (id: string, title: string, versions: number[]): LegacyType => ({
  id,
  title,
  description: null,
  versions,
});
const retired = { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: null };

const cases: [string, SpecSummary[], string[], LegacyType[]][] = [
  ['no specs', [], [], []],
  [
    'one file-only type: versions oldest first, the newest title',
    [spec('demo', 2, 'Demo v2'), spec('demo', 1, 'Demo')],
    [],
    [legacy('demo', 'Demo v2', [1, 2])],
  ],
  [
    'a type with a database recipe is a recipe card only',
    [spec('pvp', 1), spec('pvp', 2), spec('pvp', 3, 'pvp', 'template')],
    ['pvp'],
    [],
  ],
  ['a template file is never legacy', [spec('tdemo', 1, 'Template demo', 'template')], [], []],
  ['a row without kind is left out', [{ id: 'old', version: 1, title: 'Old' }], [], []],
  ['a retired row is left out', [{ ...spec('gone', 1), retired }], [], []],
  [
    'sorted by title',
    [spec('b', 1, 'Beta'), spec('a', 1, 'Alpha')],
    [],
    [legacy('a', 'Alpha', [1]), legacy('b', 'Beta', [1])],
  ],
];

describe('legacyTypes (D16)', () => {
  it.each(cases)('%s', (_name, specs, recipeIds, expected) => {
    expect(legacyTypes(specs, new Set(recipeIds))).toEqual(expected);
  });

  it('keeps the newest description', () => {
    expect(
      legacyTypes([{ ...spec('demo', 1), description: 'Old' }, { ...spec('demo', 2), description: 'New' }], new Set()),
    ).toEqual([{ id: 'demo', title: 'demo', description: 'New', versions: [1, 2] }]);
  });
});

describe('versionsText', () => {
  it.each([
    [[1], 'Version v1'],
    [[1, 2], 'Versions v1, v2'],
  ])('%j reads %s', (versions, text) => {
    expect(versionsText(versions)).toBe(text);
  });
});
```

Append to `apps/web/test/TemplatesPage.test.tsx` (add `waitFor` to the `@testing-library/react` import and `import type { SpecSummary } from '@ih/shared';`):

```tsx
const retirement = { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' };
const withRetired: TemplateListItem[] = [list[0]!, { ...list[1]!, retired: retirement }];
/** demo: file-only legacy; pvp: legacy files plus a database recipe (a recipe card only). */
const legacySpecs: SpecSummary[] = [
  { id: 'demo', version: 1, title: 'Demo', kind: 'spec' },
  { id: 'demo', version: 2, title: 'Demo v2', kind: 'spec' },
  { id: 'pvp', version: 2, title: 'Process Validation Protocol', kind: 'spec' },
  { id: 'pvp', version: 3, title: 'Process Validation Protocol', kind: 'template' },
];

describe('TemplatesPage retired types (D15)', () => {
  it('leaves retired document types off the page, with no Show retired toggle', async () => {
    setup({ listTemplates: vi.fn(async () => withRetired) });
    await screen.findByRole('article', { name: 'Process Validation Protocol' });
    expect(screen.queryByRole('article', { name: 'Certificate of analysis' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /retired/i })).toBeNull();
    expect(screen.queryByText(/Retired/)).toBeNull();
  });

  it('says there are none when every document type is retired', async () => {
    setup({ listTemplates: vi.fn(async () => [{ ...list[1]!, retired: retirement }]) });
    expect(await screen.findByText('No document types yet.')).toBeInTheDocument();
  });
});

describe('TemplatesPage legacy spec types (D16)', () => {
  it('lists file-only legacy specs as read-only cards', async () => {
    setup({ listSpecs: vi.fn(async () => legacySpecs) });
    const demo = await screen.findByRole('article', { name: 'Demo v2' });
    expect(within(demo).getByText('demo')).toBeInTheDocument();
    expect(within(demo).getByText('Legacy spec (file)')).toBeInTheDocument();
    expect(within(demo).getByText('Versions v1, v2')).toBeInTheDocument();
    expect(within(demo).getByText(/read-only here/)).toBeInTheDocument();
    // No editor, Workbench, Test run or export; and users get no Retire….
    expect(within(demo).queryByRole('link')).toBeNull();
    expect(within(demo).queryByRole('button')).toBeNull();
    expect(within(demo).queryByLabelText(/Test run/)).toBeNull();
    // A type with a database recipe is its recipe card only.
    expect(screen.getAllByRole('article', { name: 'Process Validation Protocol' })).toHaveLength(1);
  });

  it('filters legacy cards with the top-bar search', async () => {
    const api = fakeApi({
      listTemplates: vi.fn(async () => list),
      listSpecs: vi.fn(async () => legacySpecs),
    });
    render(<TemplatesPage api={api} onNavigate={vi.fn()} query="demo" />);
    expect(await screen.findByRole('article', { name: 'Demo v2' })).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: 'Certificate of analysis' })).toBeNull();
  });

  it('asks GET /api/specs without retired ones', async () => {
    const { api } = setup({ listSpecs: vi.fn(async () => legacySpecs) });
    await screen.findByRole('article', { name: 'Demo v2' });
    expect(api.listSpecs).toHaveBeenCalledWith();
  });
});

describe('TemplatesPage Retire… (admins, D10 and D15)', () => {
  const admin = (overrides = {}) => {
    const api = fakeApi({
      listTemplates: vi.fn(async () => list),
      listSpecs: vi.fn(async () => legacySpecs),
      ...overrides,
    });
    render(<TemplatesPage api={api} onNavigate={vi.fn()} role="admin" />);
    return api;
  };

  it('retires a recipe after the confirm; its card leaves the page', async () => {
    const api = admin({
      listTemplates: vi.fn().mockResolvedValueOnce(list).mockResolvedValue(withRetired),
    });
    const coa = await screen.findByRole('article', { name: 'Certificate of analysis' });
    await userEvent.click(within(coa).getByRole('button', { name: 'Retire…' }));
    const dialog = screen.getByRole('dialog', { name: 'Retire Certificate of analysis' });
    expect(dialog).toHaveTextContent('Nothing is deleted');
    expect(dialog).toHaveTextContent('DELETE /api/specs/coa/retirement');
    expect(api.retireType).not.toHaveBeenCalled();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retire' }));
    expect(api.retireType).toHaveBeenCalledWith('coa');
    await waitFor(() =>
      expect(screen.queryByRole('article', { name: 'Certificate of analysis' })).toBeNull(),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Certificate of analysis is retired. An admin can unretire it through the API: DELETE /api/specs/coa/retirement.',
    );
    expect(screen.queryByRole('button', { name: /unretire/i })).toBeNull();
  });

  it('retires a legacy spec type', async () => {
    const api = admin({
      listSpecs: vi
        .fn()
        .mockResolvedValueOnce(legacySpecs)
        .mockResolvedValue(legacySpecs.filter((s) => s.id !== 'demo')),
    });
    const demo = await screen.findByRole('article', { name: 'Demo v2' });
    await userEvent.click(within(demo).getByRole('button', { name: 'Retire…' }));
    const dialog = screen.getByRole('dialog', { name: 'Retire Demo v2' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retire' }));
    expect(api.retireType).toHaveBeenCalledWith('demo');
    await waitFor(() => expect(screen.queryByRole('article', { name: 'Demo v2' })).toBeNull());
  });

  it('keeps the type when the confirm is cancelled', async () => {
    const api = admin();
    const coa = await screen.findByRole('article', { name: 'Certificate of analysis' });
    await userEvent.click(within(coa).getByRole('button', { name: 'Retire…' }));
    await userEvent.click(
      within(screen.getByRole('dialog', { name: 'Retire Certificate of analysis' })).getByRole(
        'button',
        { name: 'Cancel' },
      ),
    );
    expect(api.retireType).not.toHaveBeenCalled();
    expect(screen.getByRole('article', { name: 'Certificate of analysis' })).toBeInTheDocument();
  });

  it('keeps a refusal in the dialog', async () => {
    admin({
      retireType: vi.fn(async () => {
        throw new Error('admins only');
      }),
    });
    const coa = await screen.findByRole('article', { name: 'Certificate of analysis' });
    await userEvent.click(within(coa).getByRole('button', { name: 'Retire…' }));
    const dialog = screen.getByRole('dialog', { name: 'Retire Certificate of analysis' });
    await userEvent.click(within(dialog).getByRole('button', { name: 'Retire' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('admins only');
  });

  it('shows no Retire… to users, on recipe or legacy cards', async () => {
    setup({ listSpecs: vi.fn(async () => legacySpecs) });
    await screen.findByRole('article', { name: 'Demo v2' });
    expect(screen.queryByRole('button', { name: 'Retire…' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/web/test/legacy-types.test.ts apps/web/test/TemplatesPage.test.tsx`
Expected: FAIL: `legacy.js` does not exist; the retired card is still shown; no legacy cards; no *Retire…* button.

- [ ] **Step 3: Implement**

Create `apps/web/src/templates/legacy.ts`:

```ts
import type { SpecSummary } from '@ih/shared';

/** A file-only legacy `spec.yaml` document type, as the Document types page lists it (D16). */
export interface LegacyType {
  id: string;
  /** The newest version's title. */
  title: string;
  description: string | null;
  /** Every version, oldest first. */
  versions: number[];
}

/**
 * The legacy cards: `kind: 'spec'` rows of `GET /api/specs` whose id has no database recipe.
 * `recipeIds` is every id `GET /api/templates` lists, retired ones included, so a retired recipe
 * never comes back as a legacy card. Retired rows are left out (the API leaves them out unless
 * asked with `retired=include`). Sorted by title.
 */
export function legacyTypes(
  specs: readonly SpecSummary[],
  recipeIds: ReadonlySet<string>,
): LegacyType[] {
  const byId = new Map<string, SpecSummary[]>();
  for (const s of specs) {
    if (s.kind !== 'spec' || s.retired || recipeIds.has(s.id)) continue;
    byId.set(s.id, [...(byId.get(s.id) ?? []), s]);
  }
  return [...byId.values()]
    .map((rows) => {
      const sorted = [...rows].sort((a, b) => a.version - b.version);
      const newest = sorted.at(-1)!;
      return {
        id: newest.id,
        title: newest.title,
        description: newest.description ?? null,
        versions: sorted.map((r) => r.version),
      };
    })
    .sort((a, b) => a.title.localeCompare(b.title));
}

/** "Version v1" or "Versions v1, v2". */
export const versionsText = (versions: readonly number[]) =>
  `${versions.length === 1 ? 'Version' : 'Versions'} ${versions.map((v) => `v${v}`).join(', ')}`;
```

Create `apps/web/src/templates/LegacyTypeCard.tsx`:

```tsx
import { useId } from 'react';
import { Icon } from '../ui/Icon.js';
import { versionsText, type LegacyType } from './legacy.js';

/**
 * A legacy file-only `spec.yaml` document type (D16): read-only here (its files live in the
 * repository's `specs/` folder), so no editor, test run, Workbench or export. Admins get
 * *Retire…*.
 */
export function LegacyTypeCard({
  item,
  onRetire,
}: {
  item: LegacyType;
  /** Admins only: opens the retire confirm. */
  onRetire?: () => void;
}) {
  const titleId = useId();
  return (
    <article className="type-card" aria-labelledby={titleId}>
      <div className="type-card-head">
        <span className="type-icon" aria-hidden="true">
          <Icon name="types" size={20} />
        </span>
        <div>
          <h2 id={titleId}>{item.title}</h2>
          <span className="mono muted">{item.id}</span>
        </div>
      </div>
      <div className="pills">
        <span className="pill tone-neutral">Legacy spec (file)</span>
        <span className="pill tone-ok">{versionsText(item.versions)}</span>
      </div>
      {item.description && <p className="shape-line">{item.description}</p>}
      <p className="shape-line muted">
        Defined by spec.yaml files in the repository: read-only here.
      </p>
      {onRetire && (
        <div className="card-actions">
          <button type="button" onClick={onRetire}>
            Retire…
          </button>
        </div>
      )}
    </article>
  );
}
```

Create `apps/web/src/templates/RetireDialog.tsx`:

```tsx
import { useState } from 'react';
import type { Api } from '../api/client.js';
import { Dialog } from '../ui/Dialog.js';
import { unretireHint } from '../ui/retired.js';

/**
 * Confirms retiring a document type (admins; a recipe or a legacy spec). Runs only on its
 * Retire button, keeps a refusal as an alert, and reports success to the page, which reloads.
 */
export function RetireDialog({
  api,
  id,
  name,
  onRetired,
  onClose,
}: {
  api: Api;
  id: string;
  name: string;
  onRetired: () => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retire = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.retireType(id);
      onRetired();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={`Retire ${name}`}
      onClose={onClose}
      actions={
        <button type="button" className="primary" disabled={busy} onClick={() => void retire()}>
          Retire
        </button>
      }
    >
      <p>
        Retiring {name} (<span className="mono">{id}</span>) takes every version off this page,
        uploads and new work. Nothing is deleted: its jobs, results and references stay readable,
        and jobs already queued finish.
      </p>
      <p className="muted">{unretireHint(id)}</p>
      {error && <p role="alert">{error}</p>}
    </Dialog>
  );
}
```

`apps/web/src/templates/TemplateCard.tsx`: add the prop `onRetire` (type `/** Admins only: opens the retire confirm. */ onRetire?: () => void;`) and, at the end of `.card-actions`:

```tsx
        {onRetire && (
          <button type="button" onClick={onRetire}>
            Retire…
          </button>
        )}
```

(The card needs no retired state: a retired type is never on the page, D15.)

`apps/web/src/templates/TemplatesPage.tsx`:

1. Imports: `useCallback` from `react`; `import type { SpecSummary } from '@ih/shared';`; `import { unretireHint } from '../ui/retired.js';`; `import { LegacyTypeCard } from './LegacyTypeCard.js';`; `import { legacyTypes } from './legacy.js';`; `import { RetireDialog } from './RetireDialog.js';`.
2. Props: add `role = 'user'` (type `/** Admins get Retire… on every card. */ role?: 'admin' | 'user';`), and update the doc comment: `Document types (UI handoff §4): a card per database recipe and per legacy file-only spec (D16), plus New and Import in dialogs. Retired types are not shown (D15).`
3. State and loading (replacing the existing effect):

```ts
  const [specs, setSpecs] = useState<SpecSummary[]>([]);
  /** The card whose Retire… confirm is open. */
  const [retiring, setRetiring] = useState<{ id: string; name: string } | null>(null);
  /** Said after a retire, since the card leaves the page. */
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(() => {
    api.listTemplates().then(setItems, (err: Error) => setError(err.message));
    // Legacy cards (D16); GET /api/specs leaves retired types out. Optional: no error shown.
    api.listSpecs().then(setSpecs, () => setSpecs([]));
  }, [api]);
  useEffect(reload, [reload]);

  // Retired types are not shown here at all (D15); unretiring is API-only (D14).
  const active = (items ?? []).filter((t) => !t.retired);
  const legacy = items === null ? [] : legacyTypes(specs, new Set(items.map((t) => t.id)));
  const shown = active.filter((t) => matchesQuery(query, t.id, t.name));
  const shownLegacy = legacy.filter((l) => matchesQuery(query, l.id, l.title));
  const retire = (id: string, name: string) =>
    role === 'admin' ? () => setRetiring({ id, name }) : undefined;
```

   (`shown` replaces the existing `shown` line.)
4. Render: after `{error && <p role="alert">{error}</p>}` add

```tsx
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}
```

   and replace the list block with:

```tsx
      {items === null ? (
        !error && <p>Loading…</p>
      ) : active.length + legacy.length === 0 ? (
        <p>No document types yet.</p>
      ) : shown.length + shownLegacy.length === 0 ? (
        <p>No document types match “{query.trim()}”.</p>
      ) : (
        <div className="type-grid">
          {shown.map((t) => (
            <TemplateCard
              key={t.id}
              api={api}
              item={t}
              onNavigate={onNavigate}
              onRetire={retire(t.id, t.name)}
            />
          ))}
          {shownLegacy.map((l) => (
            <LegacyTypeCard key={l.id} item={l} onRetire={retire(l.id, l.title)} />
          ))}
        </div>
      )}
      {retiring && (
        <RetireDialog
          api={api}
          id={retiring.id}
          name={retiring.name}
          onClose={() => setRetiring(null)}
          onRetired={() => {
            setNotice(`${retiring.name} is retired. ${unretireHint(retiring.id)}`);
            setRetiring(null);
            reload();
          }}
        />
      )}
```

`apps/web/src/App.tsx`: `page = <TemplatesPage api={api} onNavigate={navigate} query={query} role={me.role} />;`

- [ ] **Step 4: Run the tests**

Run: `npx vitest run apps/web/test/legacy-types.test.ts apps/web/test/TemplatesPage.test.tsx apps/web/test/App.test.tsx`
Expected: PASS (the existing TemplatesPage tests are unaffected: the default `listSpecs` fake has no `kind`, so it adds no legacy card).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/templates/legacy.ts apps/web/src/templates/LegacyTypeCard.tsx apps/web/src/templates/RetireDialog.tsx apps/web/src/templates/TemplatesPage.tsx apps/web/src/templates/TemplateCard.tsx apps/web/src/App.tsx apps/web/test/legacy-types.test.ts apps/web/test/TemplatesPage.test.tsx
git commit -m "$(cat <<'EOF'
Web: Document types page lists legacy specs, hides retired types; admins retire

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: The recipe editor of a retired type is read-only

**Files:**
- Modify: `apps/web/src/templates/editor-derive.ts`, `apps/web/src/templates/EditorHeader.tsx`, `apps/web/src/templates/EmbeddedHeader.tsx`, `apps/web/src/templates/TryOn.tsx`, `apps/web/src/templates/TestRail.tsx`, `apps/web/src/templates/QualityPanel.tsx`, `apps/web/src/templates/TemplateEditor.tsx`
- Test: `apps/web/test/editor-derive.test.ts`, `apps/web/test/TemplateEditor.test.tsx`

**Interfaces:**
- Consumes: Task 7 (`TemplateListItem.retired`, `RETIRED_REASON`, `RetiredBanner`).
- Produces: `publishBlocker(dirty, issues, retired = false)`; `EditorHeader` prop `retired?: boolean`; `EmbeddedHeader`, `TryOn`, `TestRail`, `QualityPanel` prop `retired?: string | null` (the reason; null when active).
- Decision: D17. Opened by URL (`#/templates/:id/:version`, or the Workbench Recipe tab), a retired type's recipe is read-only like a published version; Publish, Save draft, New draft from vN, Try on, the Test rail and Run regression are disabled with `RETIRED_REASON`; Export YAML and *More → Delete draft* stay; the standalone editor shows `RetiredBanner` (embedded, the project page shows it, Task 11). No Unretire.

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

Append to `apps/web/test/TemplateEditor.test.tsx` (import `RETIRED_REASON` from `'../src/ui/retired.js'`):

```tsx
describe('TemplateEditor of a retired type (D17: read-only)', () => {
  const retirement = { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' };
  const retiredList = (published: number | null, draft: number | null) =>
    vi.fn(async () => [{ ...listItem(published, draft), retired: retirement }]);
  const blocked = (element: HTMLElement) => {
    expect(element).toBeDisabled();
    expect(element).toHaveAttribute('title', RETIRED_REASON);
  };

  it('opens a draft read-only with the banner; publish, save and test runs carry the reason', async () => {
    setup(view({ ...validDefinition(), version: 2 }), { listTemplates: retiredList(1, 2) });
    const note = await screen.findByRole('note');
    expect(note).toHaveTextContent('Retired by ken on 14 Oct 2026');
    expect(note).toHaveTextContent('DELETE /api/specs/letter/retirement');
    blocked(screen.getByRole('button', { name: /^Publish v2/ }));
    blocked(screen.getByRole('button', { name: 'Save draft' }));
    expect(screen.getByLabelText('Name')).toBeDisabled(); // the form is read-only
    blocked(screen.getByLabelText('Sample document'));
    blocked(screen.getByRole('button', { name: 'Run test' }));
    // Still allowed: export, and deleting the draft (D5).
    expect(screen.getByRole('link', { name: 'Export YAML' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'More actions' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: /unretire/i })).toBeNull();
  });

  it('disables New draft from vN on a published version', async () => {
    setup(view({ ...validDefinition(), version: 1 }, 'published'), {
      listTemplates: retiredList(1, null),
    });
    await screen.findByRole('note');
    blocked(screen.getByRole('button', { name: 'New draft from v1' }));
  });

  it('disables Run regression on the Quality tab', async () => {
    setup(view({ ...validDefinition(), version: 1 }, 'published'), {
      listTemplates: retiredList(1, null),
      listReferences: vi.fn(async () => [
        {
          id: 'r1',
          templateId: 'letter',
          name: 'acme',
          documentId: 'd',
          sourceJobId: 'j',
          expected: { fields: {}, tables: {} },
          createdAt: '',
        },
      ]),
    });
    await screen.findByRole('note');
    await userEvent.click(await tab(/Quality/));
    blocked(await screen.findByRole('button', { name: 'Run regression on v1…' }));
  });

  it('embedded: read-only, Try on and Publish carry the reason, and no banner of its own', async () => {
    setup(
      view({ ...validDefinition(), version: 2 }),
      {
        listTemplates: retiredList(1, 2),
        listSamples: vi.fn(async () => [sampleView()]),
      },
      { onChanged: vi.fn() },
    );
    const publish = await screen.findByRole('button', { name: /^Publish v2/ });
    await waitFor(() => expect(publish).toHaveAttribute('title', RETIRED_REASON));
    expect(publish).toBeDisabled();
    blocked(screen.getByRole('button', { name: 'Test run' }));
    expect(screen.queryByRole('note')).toBeNull(); // the project page shows the banner
  });

  it('stays editable for an active type', async () => {
    setup(view({ ...validDefinition(), version: 2 }), {
      listTemplates: vi.fn(async () => [listItem(1, 2)]),
    });
    await screen.findByText('from published v1 · letter');
    expect(screen.getByLabelText('Name')).toBeEnabled();
    expect(screen.queryByRole('note')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/web/test/editor-derive.test.ts apps/web/test/TemplateEditor.test.tsx`
Expected: FAIL: no banner, Publish/Save/Test rail enabled, the form editable.

- [ ] **Step 3: Implement**

`apps/web/src/templates/editor-derive.ts`, `publishBlocker` (import `RETIRED_REASON` from `'../ui/retired.js'`):

```ts
export function publishBlocker(dirty: boolean, issues: number, retired = false): string | null {
  if (retired) return RETIRED_REASON;
  if (dirty) return 'Save the draft before publishing';
  if (issues > 0) return `Fix ${plural(issues, 'validation issue')}`;
  return null;
}
```

`apps/web/src/templates/EditorHeader.tsx` (import `RETIRED_REASON` from `'../ui/retired.js'`): add the prop `retired = false` (type `/** The document type is retired: read-only, nothing new runs (D17). */ retired?: boolean;`), change `const blocker = publishBlocker(dirty, issues);` to `const blocker = publishBlocker(dirty, issues, retired);`, and

- Save draft: `disabled={retired || !dirty || saving}` and `title={retired ? RETIRED_REASON : saving ? 'Saving…' : undefined}`;
- New draft from v{version}: `disabled={retired}` and `title={retired ? RETIRED_REASON : undefined}`.

`apps/web/src/templates/TryOn.tsx`: add the prop `retired = null` (type `/** Why nothing may run (a retired document type); null otherwise. */ retired?: string | null;`) and change the `blocked` line to

```ts
  const blocked =
    retired ?? tryOnBlockedReason(dirty, samples === null ? null : ready.length, issues);
```

`apps/web/src/templates/EmbeddedHeader.tsx`: add the prop `retired = null` (type `/** Why nothing new may run (a retired document type); null otherwise. */ retired?: string | null;`), pass `retired={retired}` to `<TryOn …>`, and give the New draft button `disabled={retired !== null}` and `title={retired ?? undefined}`.

`apps/web/src/templates/TestRail.tsx`: add the prop `retired = null` (same type and doc as `TryOn`) and

- the file input: `disabled={retired !== null}` and `title={retired ?? undefined}`;
- the drop zone's `onDrop`: `if (retired === null) choose(e.dataTransfer.files[0]);` (after `e.preventDefault();`);
- the Run test button: `disabled={retired !== null || !sample || busy}` and `title={retired ?? undefined}`.

`apps/web/src/templates/QualityPanel.tsx`: add the prop `retired = null` (same type and doc) and give the *Run regression on v{version}…* button `disabled={retired !== null}` and `title={retired ?? undefined}`.

`apps/web/src/templates/TemplateEditor.tsx`:

1. Imports: `import type { Retirement } from '@ih/shared';`, `import { RETIRED_REASON } from '../ui/retired.js';`, `import { RetiredBanner } from '../ui/RetiredBanner.js';`.
2. State next to `publishedVersion`: `/** The type's retirement (D17: read-only); null when active. */ const [retired, setRetired] = useState<Retirement | null>(null);`
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

4. Replace `const editable = record.status === 'draft';` with

```ts
  /** A retired type's recipe is read-only, like a published version (D17). */
  const editable = record.status === 'draft' && retired === null;
  /** Why nothing new may run: a retired document type (null when active). */
  const blockedBy = retired ? RETIRED_REASON : null;
```

5. `<EmbeddedHeader …>`: `publishBlocker={publishBlocker(dirty, issues.length, retired !== null)}` and add `retired={blockedBy}`.
6. `<EditorHeader …>`: add `retired={retired !== null}`, and directly after the header's `)}` (the end of the `embedded ? … : …` expression) add

```tsx
      {!embedded && retired && <RetiredBanner retirement={retired} typeId={templateId} />}
```

   (Embedded, the project page shows its own banner: Task 11.)
7. `<QualityPanel …>`: add `retired={blockedBy}`; `<TestRail …>`: add `retired={blockedBy}`.

The rest follows from `editable`: the `<fieldset disabled={!editable}>` holds every field and Apply YAML, the step buttons use `!editable`, and the embedded `UnsavedBar` only shows while `editable`.

- [ ] **Step 4: Run the tests**

Run: `npx vitest run apps/web/test/editor-derive.test.ts apps/web/test/TemplateEditor.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/templates/editor-derive.ts apps/web/src/templates/EditorHeader.tsx apps/web/src/templates/EmbeddedHeader.tsx apps/web/src/templates/TryOn.tsx apps/web/src/templates/TestRail.tsx apps/web/src/templates/QualityPanel.tsx apps/web/src/templates/TemplateEditor.tsx apps/web/test/editor-derive.test.ts apps/web/test/TemplateEditor.test.tsx
git commit -m "$(cat <<'EOF'
Web: a retired type's recipe editor is read-only, with the reason on every action

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Workbench list: retired projects left out, Retired tag on cards

**Files:**
- Modify: `apps/web/src/workbench/ProjectTable.tsx`, `apps/web/src/styles/stages.css`
- Test: `apps/web/test/WorkbenchPage.test.tsx`, `apps/web/test/ProjectTable.test.tsx`

**Interfaces:**
- Consumes: `ProjectListItem.retired` (Task 1), `retiredNote` (Task 7).
- Decision: D18. The main list never asks for retired projects and has **no** *Show retired* toggle (`WorkbenchPage.tsx` is unchanged: its requests carry no `retired`, so the API leaves retired projects out). Pinned and recent cards ask by `ids`, which the API answers with retired projects too: their card (and a row, should one reach the table) shows a *Retired* tag whose `title` is `retiredNote(…)` (who, when, and the unretire route). The project URL still opens (Task 11).

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/test/WorkbenchPage.test.tsx`:

```tsx
describe('WorkbenchPage retired projects (D18)', () => {
  const retired = { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' };

  it('never asks the main list for retired projects, and has no toggle for them', async () => {
    const api = fakeApi();
    page(api);
    await screen.findByRole('table');
    expect(listCalls(api).every((q) => q.retired === undefined)).toBe(true);
    expect(screen.queryByRole('checkbox', { name: /retired/i })).toBeNull();
  });

  it('still shows a pinned retired project as a card, tagged Retired', async () => {
    const api = fakeApi({
      listPins: vi.fn(async () => ['invoice']),
      listProjectPage: vi.fn(async (q: Query) =>
        q.ids
          ? projectListPage({ items: [{ ...invoice, retired }], total: 1 })
          : projectListPage(),
      ),
    });
    page(api);
    const cards = await screen.findByRole('region', { name: 'Pinned and recent' });
    const tag = await within(cards).findByText('Retired');
    expect(tag).toHaveAttribute(
      'title',
      'Retired by ken on 14 Oct 2026. An admin can unretire it through the API: DELETE /api/specs/invoice/retirement.',
    );
    expect(within(cards).queryByRole('button', { name: /unretire/i })).toBeNull();
  });
});
```

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
    expect(screen.getByText('Retired')).toHaveAttribute(
      'title',
      expect.stringContaining('Retired by ken on 14 Oct 2026'),
    );
    unmount();
    render(<ProjectCard item={item} now={Date.now()} />);
    expect(screen.getByText('Retired')).toBeInTheDocument();
  });

  it('has no tag for an active project', () => {
    render(<ProjectCard item={projectListItem()} now={Date.now()} />);
    expect(screen.queryByText('Retired')).toBeNull();
  });
});
```

(import `ProjectCard` from `'../src/workbench/ProjectTable.js'` if the file does not already; `ProjectCard` needs only `item` and `now`.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/web/test/WorkbenchPage.test.tsx apps/web/test/ProjectTable.test.tsx`
Expected: FAIL: no "Retired" tag. (The "never asks" test PASSES already and pins D18: keep it.)

- [ ] **Step 3: Implement**

`apps/web/src/workbench/ProjectTable.tsx` (import `retiredNote` from `'../ui/retired.js'`): after each `{item.dataPolicy === 'external' && <span className="ext-tag">EXT</span>}` (the card header and the table's title cell) add

```tsx
        {item.retired && (
          <span className="retired-tag" title={retiredNote(item.retired, item.id)}>
            Retired
          </span>
        )}
```

`apps/web/src/styles/stages.css`: change the selector `.ext-tag {` to `.ext-tag,\n.retired-tag {` and add after that rule:

```css
.retired-tag {
  background: var(--ih-skip-bg);
  color: var(--ih-skip-fg);
}
```

`apps/web/src/workbench/WorkbenchPage.tsx`: no change (no toggle, D18).

- [ ] **Step 4: Run the tests**

Run: `npx vitest run apps/web/test/WorkbenchPage.test.tsx apps/web/test/ProjectTable.test.tsx apps/web/test/list-derive.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/ProjectTable.tsx apps/web/src/styles/stages.css apps/web/test/WorkbenchPage.test.tsx apps/web/test/ProjectTable.test.tsx
git commit -m "$(cat <<'EOF'
Web: Workbench list leaves retired projects out; pinned cards tag them Retired

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Workbench project page: banner and disabled actions; docs

**Files:**
- Modify: `apps/web/src/workbench/ProjectPage.tsx`, `ProjectHeader.tsx`, `SamplesTab.tsx`, `RunsTab.tsx`, `ReferencesTab.tsx`, `EvaluateTab.tsx`, `GateCard.tsx`, `StagePanel.tsx`, `SurveyTab.tsx`, `ReviseTab.tsx`, `CLAUDE.md`
- Create: `apps/web/test/retired-project.test.tsx`
- Test: `apps/web/test/ProjectHeader.test.tsx`, `apps/web/test/ProjectPage.test.tsx`

**Interfaces:**
- Consumes: `ProjectView.retired` (Task 4), `RETIRED_REASON`, `RetiredBanner` (Task 7). No unretire call: the banner names the API route instead (D14).
- Decisions: D7, D14, D18. A retired project still opens from a pinned or recent card or its URL; it shows the banner (no button) and every job-creating action is disabled with the reason; the Recipe tab's editor is read-only (Task 9).
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
describe('ProjectPage of a retired type (D7, D14, D18)', () => {
  const retired = { retiredAt: '2026-10-14T09:00:00.000Z', retiredBy: 'ken' };
  it('still opens, with the banner naming the unretire route and no Unretire, even for admins', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => projectView({ retired })),
      getProjectOverview: vi.fn(async () => projectOverview()),
    });
    page(api, 'brief');
    await screen.findByText(/Retired by ken on 14 Oct 2026/);
    const banner = screen
      .getAllByRole('note')
      .find((n) => n.textContent?.includes('Retired by ken on 14 Oct 2026'));
    expect(banner).toHaveTextContent('DELETE /api/specs/letter/retirement');
    expect(screen.queryByRole('button', { name: /unretire/i })).toBeNull();
    expect(api).not.toHaveProperty('unretireType');
  });

  it('shows no banner for an active type', async () => {
    const api = fakeApi({
      getProject: vi.fn(async () => projectView()),
      getProjectOverview: vi.fn(async () => projectOverview()),
    });
    page(api, 'brief');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/Retired by/)).toBeNull();
  });
});
```

(Use the file's existing `page()` helper, which renders with `role="admin"`. If the page loads the project through another call than `getProject`, stub that one instead; if the project header's name is not a level-1 heading, wait for the element the file's other tests wait for.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run apps/web/test/retired-project.test.tsx apps/web/test/ProjectHeader.test.tsx apps/web/test/ProjectPage.test.tsx`
Expected: FAIL: buttons enabled without the reason; no banner; no Retired pill. (The "no banner for an active type" test PASSES already.)

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

`ProjectHeader.tsx` (import `RETIRED_REASON` and `retiredNote` from `'../ui/retired.js'`): after the "Developing vN" pill add

```tsx
        {view.retired && (
          <span className="pill tone-neutral" title={retiredNote(view.retired, project.id)}>
            Retired
          </span>
        )}
```

and replace the Publish link block with:

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
```

2. After `{error && <p role="alert">{error}</p>}` (below `<ProjectHeader …/>`) add

```tsx
      {/* No Unretire here, for admins either: unretiring is API-only (D14). */}
      {view.retired && <RetiredBanner retirement={view.retired} typeId={project.id} />}
```

3. Pass `retired={retired}` to `<SamplesTab>`, `<SurveyTab>`, both `<StagePanel>`s, `<ReferencesTab>`, `<EvaluateTab>`, `<ReviseTab>`, `<RunsTab>`.
4. The "Start v{n}" button (no open draft) gets `disabled={retired !== null}` and `title={retired ?? undefined}`.

(The Recipe tab's embedded editor learns the retirement itself from `listTemplates` and is read-only: Task 9.)

`CLAUDE.md`:

1. Cross-language contracts table: add a row after "Job statuses and tasks":

```markdown
| Retired document types (migration 0030) | `RetirementSchema`, `retiredMessage` in `packages/shared/src/retirement.ts`; `SpecSummary.retired`, `SpecSummary.kind`, `ProjectView.retired`, `ProjectListItem.retired`, `ProjectListQuery.retired`; `TemplateRepo.retire/unretire/retirement/listRetirements`, `apps/api/src/templates/retirement.ts` (TS only) | none: the worker never reads `document_type_retirements`; queued jobs finish |
```

2. Rules of the road: add a bullet after "Templates live in the database":

```markdown
- **Retired document types (migration 0030):** an admin retires or unretires a type (every version, recipe or legacy spec) with `PUT|DELETE /api/specs/:id/retirement` (admin-only, logged `document type retired`/`unretired`; retiring again keeps the first retirement; unretiring a type that is not retired is a 204; unknown is a 404). The row (`document_type_retirements`: `type_id`, `retired_at`, `retired_by` = token label) lives with the type, not a version, so seeding a missing `specs/*/template.yaml` version keeps the type retired, and deleting a never-published Workbench project removes it. Nothing is deleted and everything stays readable. Hidden: `GET /api/specs` by default (`?retired=include` lists them with `retired`; every row carries `kind`; Jobs, Home and Results ask for them so old jobs keep their names; the upload strip never offers one), the Document types page always (no toggle), the Workbench list by default (`retired=include` for API callers, no toggle in the web; `ids=` still returns them, so pinned and recent cards show them with a *Retired* tag and the project URL opens). `GET /api/templates` and every `ProjectView` carry `retired`; the Workbench list overlays it live (never cached; `LIST_CACHE_VERSION` 4). New work is a 409 `<name> is retired: unretire it to use it again` (`retiredProblem`, the `refuseRetired` preHandler): uploads and Templates test runs, retry/re-process of any of its jobs, regression runs, a new type under a retired legacy id, new drafts, publishing (both routes), YAML import, Workbench project creation, bundle import under that id, sample uploads, dev test runs, every drafting stage, holdout reference runs, re-verify, evaluate and compare. Allowed: reading, edits that queue no job (draft, brief, feedback, proposals, skip/keep, restore, policy, threshold, sample role), deletes, cancel, review of jobs already awaiting review (approve, reject, step re-run), saving a reference, anchor previews and bundle export. Jobs already queued or running finish (the worker is unchanged). Web: admins retire any type, recipe or legacy, from the Document types page (*Retire…* and a confirm `Dialog`, `RetireDialog`); the page lists file-only legacy `spec.yaml` types as read-only cards (`legacyTypes` in `apps/web/src/templates/legacy.ts`: `kind: 'spec'` rows of `GET /api/specs` with no database recipe; tag *Legacy spec (file)*). **Unretiring is API-only**: there is no Unretire button anywhere and no `unretireType` in the client; `RetiredBanner` (project page, standalone recipe editor) and the *Retired* tags say who retired the type, when, and name `DELETE /api/specs/{id}/retirement` (`unretireHint`). A retired type's recipe editor is read-only (like a published version). The web disables each job-creating button with `RETIRED_REASON` (`apps/web/src/ui/retired.ts`); the Jobs page and Runs tab Retry buttons are not pre-disabled (the dialog shows the 409).
```

- [ ] **Step 4: Run the tests, then everything CI checks**

Run: `npx vitest run apps/web/test/retired-project.test.tsx apps/web/test/ProjectHeader.test.tsx apps/web/test/ProjectPage.test.tsx apps/web/test/SamplesTab.test.tsx apps/web/test/RunsTab.test.tsx apps/web/test/ReferencesTab.test.tsx apps/web/test/EvaluateTab.test.tsx apps/web/test/GateCard.test.tsx apps/web/test/StagePanel.test.tsx apps/web/test/SurveyTab.test.tsx apps/web/test/ReviseTab.test.tsx`
Expected: PASS.

Run: `npm run check`
Expected: green (lint, format, typecheck, every TS test, worker lint and tests unchanged).

Run the Pg integration test once more (Global Constraints). Expected: PASS.

Run: `git grep -n -i unretire -- apps/web/src`
Expected: only `unretireHint` (its definition in `ui/retired.ts` and its uses) and comments saying unretiring is API-only: no `unretireType`, no Unretire button (Review Focus 7).

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

- **Spec coverage:** reversible flag (Tasks 2–3; unretire through the API only, D14); nothing deleted, readable (Task 4 "still resolves", Task 5/6 "allowed" tests); approving an already-awaiting production job delivers normally (Task 5, D5 decided); hidden from upload picker, `GET /api/specs`, Document types page (always, no toggle), Workbench list (no toggle; pinned/recent still shown and tagged), search (Tasks 4, 7, 8, 10; the page search filters the shown set, the Workbench search is server-side after the retired filter); 409 refusals (Tasks 5–6); queued jobs finish, worker untouched (D6, CLAUDE.md row); retry refused (Task 5); admin-only, who/when shown, logged (Task 3, Task 7 `retiredLine`/`unretireHint`, Task 10 tag title, Task 11 banner); Retire… on the Document types page for recipes and legacy file-only specs (Task 8, D10/D16); a retired recipe editor opened by URL is read-only (Task 9, D17); open draft / project allowed with banner and disabled actions (Task 11); seeding (Task 4); legacy specs through the API (Task 3 test) and listed with `kind` (Task 4 test).
- **No Unretire in the web:** no `unretireType` in the client (Task 7 test), no button in the banner (Task 7), the Document types page (Task 8), the recipe editor (Task 9), the Workbench list (Task 10) or the project page (Task 11); each of those tests asserts `queryByRole('button', { name: /unretire/i })` is null where it renders a retired type.
- **Type consistency:** `retire(id, by)` returns `{ retirement, created }` everywhere; `RETIRED_REASON` (web) vs `retiredMessage` (shared, API 409) are deliberately different texts; the `retired` prop on tabs is `string | null` (a reason), while `TemplateListItem.retired`, `ProjectView.retired` and `ProjectListItem.retired` are `Retirement | null`.
