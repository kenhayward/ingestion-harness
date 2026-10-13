# Workbench project list screen (PR 7 of 7) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the Workbench page as the handoff's project list for 100–1,000 projects: header with **Import bundle** and **New project** dialogs, pinned and recent cards, server-counted filter chips, a debounced search and Phase / Models / Sort selects, the projects table (pin, document type, progress strip, next action, versions, holdout score bar, samples, activity), and a footer with rows per page, a legend and a pager; rows become cards on phones.

**Architecture:** The page talks only to PR 6's API through the `Api` port: `listProjectPage(query)` for the table and chips, `listProjectPage({ ids })` for the cards, and `listPins`/`pin`/`unpin`. Pure helpers (`pagerPages`, `phaseLine`, `nextHref`, `recentProjects`/`rememberProject`) are table-tested. The table and cards are presentational components fed `ProjectListItem`s and reuse PR 2's `ProgressStrip` and `NextAction`.

**Tech Stack:** React 19, Vitest + Testing Library (fake timers for the debounce), CSS on `--ih-*` tokens.

**Spec:** `docs/design/workbench-redesign/WORKBENCH-HANDOFF.md` §1, W3 (client part); screenshot `docs/design/workbench-redesign/screenshots/{light,dark}/10-workbench-list.png`; PR 6's API (`ProjectListQuery`, `ProjectListItem`, `ProjectListPage`, pins routes).

## Global Constraints

- Header: "Workbench" + the existing description. Actions: **Import bundle** (secondary → the existing `ImportBundle` flow in a `Dialog`) and **New project** (primary → `Dialog` with Id, Name and "Leave the name empty to open an existing document type.").
- Pinned and recent: `section aria-label="Pinned and recent"`, up to 3 cards in an auto-fit grid (min 280 px); each card: star, name, last activity, 10-segment progress strip + phase text, next action (status icon + text, tone coloured); the whole card opens the project; pinned first, then most recently opened (`ih.wbRecent`, client-side), de-duplicated.
- Filter chips: `role=group aria-label="Filter projects"`, counts from the server facets formatted `1,000`: **All · Needs you** (amber count) **· Running · Ready to publish · In progress · Published, no draft**. Selecting one resets to page 1.
- Toolbar: search (`aria-label="Search projects by name or id"`, debounce 250 ms, server side), **Phase** (Any / Prepare / Draft with the model / Verify and publish / Published, no draft), **Models** (Any / Local only / External allowed), **Sort** (Last activity — default / Name A–Z / Holdout score, lowest first / Fewest samples); right-aligned "Showing 1–25 of 1,000".
- Table: `section aria-label="Projects"`, scroll box, sticky header row, min-width 1060 px. Columns: Pin (star toggle, `aria-pressed`, `aria-label="Pin <name>"`, filled amber when pinned) · Document type (name 600 + id mono 11 px; `EXT` tag in warn tone when `dataPolicy='external'`; link → project Overview) · Progress (strip; phase line "Draft · 5 of 10 done"; the strip's accessible name spells out every stage) · Next action (icon + verb phrase, tone; link → the right tab) · Versions ("Draft vN" over "Live vM" / "Not published", muted) · Holdout score (% ok when ≥ threshold, warn below, "—" when none, + 84 px bar with a 2 px tick at the project's `publishThreshold`) · Samples (total over "N dev · M hold") · Activity (relative time).
- Footer (`nav aria-label="Pages"`): rows per page 25/50/100 (persisted in `localStorage` `ih.wbPageSize`, try/catch), legend of the segment colours + "Score tick = publish threshold", pager ‹ 1 2 3 … N › with the current page `aria-current="page"`.
- Empty / no match: "No document types match. Clear the search or pick another filter."
- Mobile (< 640 px): pinned cards stack, toolbar wraps, table rows render as cards (name, progress strip, next action); nothing scrolls the page sideways at 390 px.
- Tests first; `npm run check` green; commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`; never stage `config/llm-providers.yaml`.

## Review Focus

1. **Typing fast in search** — one request after 250 ms of quiet, not one per keystroke; a slower earlier response never overwrites a newer one (Task 3 tests with fake timers and out-of-order fakes).
2. **Pin toggle failing** (network) — the star reverts and an error shows; no stuck optimistic state (Task 2/3 test).
3. **Stored page size garbage** (`ih.wbPageSize = "7"` or storage throwing) — falls back to 25 (Task 1 test).
4. **Last page shrinks** (a filter change while on page 4) — the page resets to 1 on any query change except paging (Task 3 test).
5. **No pins and no recents** — the "Pinned and recent" section is omitted, not an empty box (Task 3 test).

---

### Task 0: Warm the list cache before the page depends on it (API)

PR 6's final review: a cold cache takes ≈ 27 s to fill at 1,000 projects (after a deploy that bumps `LIST_CACHE_VERSION`), and concurrent cold requests each recompute the same rows. This task lands before the web switches to the paged list.

**Files:**
- Modify: `apps/api/src/workbench/list.ts`, `apps/api/src/server.ts`, `apps/api/src/routes/workbench.ts` (list route description), `packages/shared/src/overview.ts` (empty `ids`), `docs/openapi.json` (regenerate)
- Test: `apps/api/test/workbench-list.test.ts`, `packages/shared/test/overview-list.test.ts`

**Interfaces:**
- `refreshListCache(app)` becomes single-flight per app: concurrent callers share one in-flight promise (keyed on the app instance, e.g. a `WeakMap<FastifyInstance, Promise<…>>`), cleared when it settles (also on rejection).
- `warmListCache(app): Promise<void>` = two sequential `refreshListCache` passes (the second absorbs rows whose computation wrote gate/score caches and so moved their own fingerprint); `server.ts` starts it after `app.listen` without awaiting it, logging `warn` on failure. Never called from `buildApp` (tests stay unaffected).
- `ProjectListQuerySchema`: an empty `ids` (`ids=` or `ids=,`) means "no ids filter" (absent), not "match nothing".
- The list route's description says facets are scoped by `ids` too.

- [ ] **Step 1: Write the failing tests** — two concurrent `refreshListCache(app)` calls on a cold cache compute each project once (spy on `workbench.listProposals`: calls equal the project count, not double); a rejected refresh does not poison the next call; `ProjectListQuerySchema.parse({ ids: '' }).ids` is `undefined` (and `','` too).
- [ ] **Step 2: Implement**; run `npx vitest run --project api` and `--project shared`; `npm run openapi`, then the openapi test without `-u`; typecheck, lint, prettier.
- [ ] **Step 3: Commit**

```bash
git add apps/api/src/workbench/list.ts apps/api/src/server.ts apps/api/src/routes/workbench.ts packages/shared/src/overview.ts docs/openapi.json apps/api/test/workbench-list.test.ts packages/shared/test/overview-list.test.ts
git commit -m "Workbench list: warm the cache at startup and share concurrent refreshes"
```

---

### Task 1: Client calls, fakes and pure helpers

**Files:**
- Modify: `apps/web/src/api/client.ts`, `apps/web/test/fake-api.ts`
- Create: `apps/web/src/workbench/listDerive.ts`
- Test: `apps/web/test/client.test.ts`, `apps/web/test/list-derive.test.ts` (create)

**Interfaces:**
- Produces:
  - `Api.listProjectPage(query: Partial<ProjectListQuery>): Promise<ProjectListPage>` (GET `/api/workbench/projects` with only the set, non-default params, in this order: `q, filter, phase, policy, sort, ids, page, size`; `ids` joined with commas), `Api.listPins(): Promise<string[]>`, `Api.pin(projectId): Promise<void>` (PUT), `Api.unpin(projectId): Promise<void>` (DELETE). (`ProjectListQuery.ids` is `string[]` after parsing; the client takes `string[]`.)
  - Fake defaults: `listProjectPage: vi.fn(async () => projectListPage())`, `listPins: vi.fn(async () => [])`, `pin`/`unpin: vi.fn(async () => undefined)`; fixtures `projectListItem(overrides)` (a valid `ProjectListItem` for id `letter`) and `projectListPage(overrides)` (`{ items: [projectListItem()], total: 1, facets: { all: 1, attention: 0, running: 0, ready: 0, progress: 1, published: 0 } }`).
  - `listDerive.ts`: `pagerPages(current: number, last: number): (number | '…')[]`; `phaseLine(item: ProjectListItem): string`; `nextHref(item: ProjectListItem): string`; `PAGE_SIZE_KEY = 'ih.wbPageSize'`, `loadPageSize(): 25 | 50 | 100`, `savePageSize(n)`; `RECENT_KEY = 'ih.wbRecent'`, `recentProjects(): string[]`, `rememberProject(id: string): void` (most recent first, de-duplicated, max 10); `formatCount(n) = n.toLocaleString('en-US')`.

- [ ] **Step 1: Write the failing tests**

`apps/web/test/list-derive.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  formatCount, loadPageSize, nextHref, pagerPages, phaseLine, recentProjects, rememberProject, savePageSize,
} from '../src/workbench/listDerive.js';
import { projectListItem } from './fake-api.js';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('pagerPages', () => {
  it.each([
    [1, 1, [1]],
    [1, 5, [1, 2, 3, 4, 5]],
    [1, 40, [1, 2, 3, '…', 40]],
    [20, 40, [1, '…', 19, 20, 21, '…', 40]],
    [40, 40, [1, '…', 38, 39, 40]],
    [3, 40, [1, 2, 3, 4, '…', 40]],
  ] as const)('page %i of %i', (current, last, expected) => {
    expect(pagerPages(current, last)).toEqual(expected);
  });
});

describe('phaseLine', () => {
  it.each([
    [{ phase: 'draft' as const, done: 5 }, 'Draft · 5 of 10 done'],
    [{ phase: 'prepare' as const, done: 1 }, 'Prepare · 1 of 10 done'],
    [{ phase: 'verify' as const, done: 9 }, 'Verify · 9 of 10 done'],
    [{ phase: 'published' as const, done: 10 }, 'Published · no open draft'],
  ])('%o', (over, text) => {
    expect(phaseLine(projectListItem(over))).toBe(text);
  });
});

describe('nextHref', () => {
  it.each([
    [{ kind: 'decide' as const, stage: 'steps' as const, label: 'Decide on Steps' }, '#/workbench/letter/steps'],
    [{ kind: 'publish' as const, stage: 'publish' as const, label: 'Publish v2' }, '#/workbench/letter/evaluate'],
    [{ kind: 'start_version' as const, stage: null, label: 'Start v4' }, '#/workbench/letter/template'],
  ])('%o', (next, href) => {
    expect(nextHref(projectListItem({ next }))).toBe(href);
  });
});

describe('page size', () => {
  it('defaults to 25 and remembers 25, 50 or 100', () => {
    expect(loadPageSize()).toBe(25);
    savePageSize(50);
    expect(loadPageSize()).toBe(50);
  });
  it('ignores garbage and storage that throws', () => {
    localStorage.setItem('ih.wbPageSize', '7');
    expect(loadPageSize()).toBe(25);
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(loadPageSize()).toBe(25);
  });
});

describe('recent projects', () => {
  it('keeps the ten most recently opened, newest first, without duplicates', () => {
    for (let n = 0; n < 12; n++) rememberProject(`p${n}`);
    rememberProject('p5');
    const recent = recentProjects();
    expect(recent[0]).toBe('p5');
    expect(recent).toHaveLength(10);
    expect(new Set(recent).size).toBe(10);
  });
  it('survives storage that throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => rememberProject('x')).not.toThrow();
  });
});

describe('formatCount', () => {
  it('groups thousands', () => {
    expect(formatCount(1000)).toBe('1,000');
    expect(formatCount(37)).toBe('37');
  });
});
```

`apps/web/test/client.test.ts` — add tests copying the file's existing fetch-stub pattern: `listProjectPage({ q: 'inv', filter: 'attention', ids: ['a', 'b'], page: 2, size: 50 })` requests `/api/workbench/projects?q=inv&filter=attention&ids=a%2Cb&page=2&size=50` (use `URLSearchParams` so the comma is encoded the way it encodes it — assert the exact string your implementation produces with `URLSearchParams`); `listProjectPage({})` requests `/api/workbench/projects` with no `?`; `listPins` GETs `/api/workbench/pins`; `pin('a b')` PUTs `/api/workbench/pins/a%20b`; `unpin` DELETEs.

- [ ] **Step 2: Run** `npx vitest run apps/web/test/list-derive.test.ts apps/web/test/client.test.ts` → FAIL.

- [ ] **Step 3: Implement** `listDerive.ts`:

```ts
import { PAGE_SIZES, type ProjectListItem } from '@ih/shared';

/** Page buttons: first, last, the current one and its neighbours, gaps as '…'. */
export function pagerPages(current: number, last: number): (number | '…')[] {
  if (last <= 5) return Array.from({ length: last }, (_, i) => i + 1);
  const keep = new Set([1, last, current - 1, current, current + 1].filter((p) => p >= 1 && p <= last));
  if (current <= 3) [2, 3, 4].forEach((p) => p <= current + 1 && keep.add(p));
  if (current >= last - 2) [last - 2, last - 1].forEach((p) => keep.add(p));
  const pages = [...keep].sort((a, b) => a - b);
  const out: (number | '…')[] = [];
  pages.forEach((p, i) => {
    if (i > 0 && p - pages[i - 1]! > 1) out.push('…');
    out.push(p);
  });
  return out;
}

const PHASE: Record<ProjectListItem['phase'], string> = {
  prepare: 'Prepare',
  draft: 'Draft',
  verify: 'Verify',
  published: 'Published',
};

export function phaseLine(item: ProjectListItem): string {
  return item.phase === 'published' ? 'Published · no open draft' : `${PHASE[item.phase]} · ${item.done} of 10 done`;
}

export function nextHref(item: ProjectListItem): string {
  const stage = item.next?.stage ?? null;
  const tab = stage === null ? 'template' : stage === 'publish' ? 'evaluate' : stage;
  return `#/workbench/${item.id}/${tab}`;
}

export const PAGE_SIZE_KEY = 'ih.wbPageSize';
export function loadPageSize(): 25 | 50 | 100 {
  try {
    const n = Number(localStorage.getItem(PAGE_SIZE_KEY));
    return (PAGE_SIZES as readonly number[]).includes(n) ? (n as 25 | 50 | 100) : 25;
  } catch {
    return 25;
  }
}
export function savePageSize(n: 25 | 50 | 100): void {
  try {
    localStorage.setItem(PAGE_SIZE_KEY, String(n));
  } catch {
    // Private mode or blocked storage: the choice lasts for this visit only.
  }
}

export const RECENT_KEY = 'ih.wbRecent';
export function recentProjects(): string[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string').slice(0, 10) : [];
  } catch {
    return [];
  }
}
export function rememberProject(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentProjects().filter((x) => x !== id)].slice(0, 10)));
  } catch {
    // Recents are a convenience; nothing to do when storage is unavailable.
  }
}

export const formatCount = (n: number) => n.toLocaleString('en-US');
```

(Check `pagerPages` against every table row; adjust the window logic, not the expectations.)

Client: add the four methods to the `Api` interface (doc comments) and `httpApi`, using `URLSearchParams` for the query. Fake: defaults and fixtures as specified (build `projectListItem` with all `ProjectListItemSchema` fields: copy `projectView()`'s project fields, `draft: 2, published: 1, samples: 6`, 10 `stages` from `OVERVIEW_STAGES` with plausible states, `phase: 'draft', done: 5`, `next: { kind: 'decide', stage: 'steps', label: 'Decide on Steps' }`, `holdoutScore: null`, `devSamples: 4, holdoutSamples: 2`, `lastActivityAt: '2026-10-13T08:00:00.000Z'`, `flags: { attention: true, running: false, ready: false }`).

- [ ] **Step 4: Run** the tests → PASS; `npx vitest run --project web`, typecheck, lint, prettier.
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/api/client.ts apps/web/test/fake-api.ts apps/web/src/workbench/listDerive.ts apps/web/test/client.test.ts apps/web/test/list-derive.test.ts
git commit -m "Workbench list web: list and pin calls, pager and recents helpers"
```

---

### Task 2: `ProjectTable`, `ProjectCard`, `ScoreBar`, `PinButton`

**Files:**
- Create: `apps/web/src/workbench/ProjectTable.tsx` (exports `ProjectTable`, `ProjectCard`, `ScoreBar`, `PinButton`)
- Modify: `apps/web/src/styles/stages.css`
- Test: `apps/web/test/ProjectTable.test.tsx` (create)

**Interfaces:**
- Consumes: Task 1 (`phaseLine`, `nextHref`), `ProgressStrip`, `NextAction` (PR 2), `relativeTime` (`apps/web/src/jobs/derive.ts`).
- Produces:
  - `PinButton({ name, pinned, onToggle })` — `button aria-pressed aria-label="Pin <name>"`, star icon filled amber when pinned.
  - `ScoreBar({ score, threshold })` — text `"—"` when null, else `percent` in ok tone when ≥ threshold, warn below; an 84 px bar (`role="img"`, `aria-label="Holdout score 86%, publish threshold 90%"`, or `"No holdout score; publish threshold 90%"`) with a 2 px tick at the threshold.
  - `ProjectTable({ items, pinned: Set<string>, onTogglePin, now })` — `section aria-label="Projects"` with a `table` (sticky header) and, for phones, a `ul aria-label="Projects as cards"` of `ProjectCard`s (CSS shows one or the other).
  - `ProjectCard({ item, pinned?, onTogglePin?, now })` — used by the phone list and the pinned/recent cards: a card whose name links to the project; star (when `onTogglePin`), name, relative activity, strip + phase line, next action.

- [ ] **Step 1: Write the failing tests** — `apps/web/test/ProjectTable.test.tsx`:

```tsx
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { PinButton, ProjectTable, ScoreBar } from '../src/workbench/ProjectTable.js';
import { projectListItem } from './fake-api.js';

const now = Date.parse('2026-10-13T12:00:00Z');

describe('PinButton', () => {
  it('toggles with a pressed state and the project name', async () => {
    const onToggle = vi.fn();
    render(<PinButton name="Supplier invoice" pinned={false} onToggle={onToggle} />);
    const star = screen.getByRole('button', { name: 'Pin Supplier invoice' });
    expect(star).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(star);
    expect(onToggle).toHaveBeenCalled();
  });
});

describe('ScoreBar', () => {
  it.each([
    [0.97, 0.9, '97%', 'ok', 'Holdout score 97%, publish threshold 90%'],
    [0.86, 0.9, '86%', 'warn', 'Holdout score 86%, publish threshold 90%'],
    [null, 0.9, '—', null, 'No holdout score; publish threshold 90%'],
  ] as const)('%s against %s', (score, threshold, text, tone, label) => {
    const { container } = render(<ScoreBar score={score} threshold={threshold} />);
    expect(container).toHaveTextContent(text);
    expect(screen.getByRole('img', { name: label })).toBeInTheDocument();
    if (tone) expect(container.querySelector('.score-value')).toHaveAttribute('data-tone', tone);
  });
});

describe('ProjectTable', () => {
  const items = [
    projectListItem({ id: 'letter', name: 'Letter', dataPolicy: 'external' }),
    projectListItem({ id: 'invoice', name: 'Invoice', draft: null, published: 3, phase: 'published', done: 10, next: { kind: 'start_version', stage: null, label: 'Start v4' }, holdoutScore: 0.95 }),
  ];

  it('shows one row per project with every column', () => {
    render(<ProjectTable items={items} pinned={new Set(['letter'])} onTogglePin={vi.fn()} now={now} />);
    const table = within(screen.getByRole('region', { name: 'Projects' })).getByRole('table');
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual([
      'Pin', 'Document type', 'Progress', 'Next action', 'Versions', 'Holdout score', 'Samples', 'Activity',
    ]);
    const [, first, second] = within(table).getAllByRole('row');
    expect(within(first!).getByRole('link', { name: 'Letter' })).toHaveAttribute('href', '#/workbench/letter');
    expect(within(first!).getByText('EXT')).toBeInTheDocument();
    expect(within(first!).getByRole('button', { name: 'Pin Letter' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(first!).getByText('Draft · 5 of 10 done')).toBeInTheDocument();
    expect(within(first!).getByRole('link', { name: 'Decide on Steps' })).toHaveAttribute('href', '#/workbench/letter/steps');
    expect(within(first!).getByText('Draft v2')).toBeInTheDocument();
    expect(within(first!).getByText('Live v1')).toBeInTheDocument();
    expect(within(first!).getByText('4 dev · 2 hold')).toBeInTheDocument();
    expect(within(first!).getByText('4 h ago')).toBeInTheDocument();
    expect(within(first!).getByRole('img', { name: /^Progress: / })).toBeInTheDocument();
    expect(within(second!).getByText('Published · no open draft')).toBeInTheDocument();
    expect(within(second!).getByText('Start v4')).toBeInTheDocument();
    expect(within(second!).queryByText('EXT')).toBeNull();
  });

  it('also lists the projects as cards for phones', () => {
    render(<ProjectTable items={items} pinned={new Set()} onTogglePin={vi.fn()} now={now} />);
    const cards = screen.getByRole('list', { name: 'Projects as cards' });
    expect(within(cards).getAllByRole('listitem')).toHaveLength(2);
    expect(within(cards).getByRole('link', { name: 'Letter' })).toHaveAttribute('href', '#/workbench/letter');
  });
});
```

(`'4 h ago'` follows from the fixture's `lastActivityAt` 08:00 and `now` 12:00 with the existing `relativeTime`; if the fixture differs, assert what `relativeTime` returns for it.)

- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the four components per the interfaces. Versions cell: `Draft v{draft}` (500) or `—`, over `Live v{published}` or `Not published` (muted). Samples cell: `{samples}` over `{devSamples} dev · {holdoutSamples} hold`. The star uses an inline SVG star path (24×24, `M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z`), `fill: var(--ih-warn-fg)` when pinned, `none` with `stroke: var(--ih-muted)` otherwise. CSS (append to `stages.css`): `.projects-scroll { overflow: auto; max-height: 70vh; border: 1px solid var(--ih-border); border-radius: var(--ih-radius-lg); }`, `.projects-table { min-width: 1060px; border-collapse: collapse; width: 100%; }`, `.projects-table thead th { position: sticky; top: 0; background: var(--ih-surface); }`, `.score-bar` 84 px wide 6 px high with `background: var(--ih-border-soft)`, the fill `width: score%` in the tone colour, the tick an absolutely positioned 2 px `--ih-text` line at `left: threshold%`; `.project-cards { display: none; }` and under `@media (max-width: 640px)` hide `.projects-scroll` and show `.project-cards` as a grid; `.ext-tag` warn tone pill.
- [ ] **Step 4: Run** → PASS; web project, typecheck, lint, prettier.
- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/ProjectTable.tsx apps/web/src/styles/stages.css apps/web/test/ProjectTable.test.tsx
git commit -m "Workbench list web: projects table, phone cards, score bar and pin star"
```

---

### Task 3: The Workbench page

**Files:**
- Modify: `apps/web/src/workbench/WorkbenchPage.tsx` (rewrite), `apps/web/src/workbench/ProjectPage.tsx` (call `rememberProject(projectId)` once on mount), `apps/web/src/styles/stages.css`, `CLAUDE.md`, `docs/design/workbench.md`
- Test: `apps/web/test/WorkbenchPage.test.tsx` (rewrite deliberately: the page changed by design), `apps/web/test/ProjectPage.test.tsx` (one test for `rememberProject`)

**Interfaces:**
- Consumes: Tasks 1–2, `FilterChips`, `Dialog`, `ImportBundle`, `StageLegend` is **not** used here (the footer legend shows the strip segment colours: a small `.seg` swatch per state with its label — Done, Needs you, Running, Stale, Skipped, Ready, Locked, Not started — plus "Score tick = publish threshold").
- Produces: `WorkbenchPage({ api, onNavigate, query? })` (same props as today). `query` (the top-bar search) seeds and follows the page's search box.

Behaviour:
- State: `q` (debounced 250 ms into the request), `filter`, `phase`, `policy`, `sort`, `page`, `size` (from `loadPageSize()`). Any change except `page` resets `page` to 1. Requests carry a sequence number; a response older than the newest request is dropped.
- Loads `listPins()` once; the cards request `listProjectPage({ ids: [...pins, ...recentProjects()] de-duplicated, first 3 })` (skip the request and the section when there are no ids); toggling a pin calls `pin`/`unpin` optimistically, reverts and shows `role="alert"` on failure, and refreshes the cards.
- Chips: All, Needs you (tone warn), Running, Ready to publish, In progress, Published, no draft — counts `formatCount(facets[x])`.
- Selects: labelled "Phase", "Models", "Sort" with the option texts from the Global Constraints (values `''`/`prepare`/`draft`/`verify`/`published`; `''`/`local`/`external`; `activity`/`name`/`score`/`samples`).
- Range text: `Showing {from}–{to} of {formatCount(total)}` (`Showing 0 of 0` when empty).
- Empty: the no-match sentence instead of the table.
- Footer: rows-per-page select (saves with `savePageSize`), legend, pager (`nav aria-label="Pages"`; ‹ previous / › next buttons labelled "Previous page" / "Next page", disabled at the ends; page buttons `aria-current="page"` on the current; '…' as plain text).
- Header buttons open `Dialog`s: "Import bundle" (the existing `ImportBundle` inside; on import navigate to the project), "New project" (the existing create form inside; the dialog's primary action submits it).

- [ ] **Step 1: Write the failing tests** — rewrite `apps/web/test/WorkbenchPage.test.tsx` to cover (use `fakeApi`, fake timers where noted):
  - first load requests `listProjectPage` with `{ page: 1, size: 25, sort: 'activity', filter: 'all' }` (or the minimal defaults your client omits — assert the call's argument object), renders the table and "Showing 1–1 of 1";
  - chips show server counts formatted (`facets.all: 1000` → "1,000") and clicking "Needs you" requests `filter: 'attention'`, `page: 1`;
  - typing "inv" quickly → exactly one more request with `q: 'inv'` after 250 ms (`vi.useFakeTimers({ shouldAdvanceTime: true })`, `advanceTimersByTimeAsync`);
  - out-of-order responses: the second request resolves first, the first resolves later — the table shows the second's rows;
  - on page 3, changing Sort requests page 1;
  - the pager: with `total: 1000` and size 25 shows `1 2 3 … 40`, the current page has `aria-current="page"`, "Next page" requests page 2;
  - rows per page 50 → request with `size: 50` and `localStorage['ih.wbPageSize'] === '50'`;
  - no match → the no-match sentence, no table;
  - pinned and recent: with `listPins` → `['invoice']` and a recent `letter` (call `rememberProject('letter')` before render), the cards request `ids: ['invoice', 'letter']` and the section "Pinned and recent" shows two cards, pinned first; with neither, there is no such section and no ids request;
  - pin failure: `pin` rejects → the star returns to unpressed and an alert shows;
  - "New project" opens a dialog with Id and Name; submitting calls `createProject` and navigates; "Import bundle" opens a dialog containing the import form.
  In `ProjectPage.test.tsx`: rendering a project stores it first in `ih.wbRecent`.
  Run → FAIL.

- [ ] **Step 2: Implement** the page per the behaviour above, composing `FilterChips`, the toolbar, `ProjectTable`, the footer and the two dialogs; `rememberProject` in `ProjectPage` (`useEffect(() => rememberProject(projectId), [projectId])`). CSS for the header, cards grid (`grid-template-columns: repeat(auto-fit, minmax(280px, 1fr))`), toolbar (wraps), footer and legend swatches, with the < 640 px rules (cards stack, toolbar wraps).

- [ ] **Step 3: Docs** — CLAUDE.md (Workbench bullet): the Workbench page is the paged project list (`listProjectPage`, chips from facets, debounced search, pins via `/api/workbench/pins`, recents in `ih.wbRecent`, rows per page in `ih.wbPageSize`); `docs/design/workbench.md` "Project list (redesign)": two sentences on the UI.

- [ ] **Step 4: Run** `npx vitest run --project web`, `npm run check`, `npm run format:check` → green.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/WorkbenchPage.tsx apps/web/src/workbench/ProjectPage.tsx apps/web/src/styles/stages.css apps/web/test/WorkbenchPage.test.tsx apps/web/test/ProjectPage.test.tsx CLAUDE.md docs/design/workbench.md
git commit -m "Workbench list web: the project list for hundreds of document types"
```
