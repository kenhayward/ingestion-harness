# Results page: one line a result, by day, paged to fit the window: handoff for Claude Code

Repo: `kenhayward/ingestion-harness`. **Implemented, tested and committed**; this handoff applies it,
runs the full check and raises the PR. It follows the Jobs page's design
([jobs-compact handoff](../jobs-compact/JOBS-COMPACT-HANDOFF.md)).

- Branch `claude/results-compact`, one commit on `main` at `ca9ef16` (Merge pull request #308).
  This file is in it as `docs/design/results-compact/RESULTS-COMPACT-HANDOFF.md`.

## Contents

| File | What it is |
| --- | --- |
| `results-compact.bundle` | Git bundle of the branch (preferred) |
| `0001-Results-….patch` | The same commit for `git am` |
| `screenshots/{light,dark}/00-before.png` | Today: two lines a result, 44 results make the page ~3,200 px tall |
| `01-page-1` | The new page: one line a result under day headings, the pager above, nothing scrolls |
| `02-page-2` | **Older ›**: the page starts inside Tue, Oct 20, so its heading reads *(continued)* |
| `screenshots/light/03-keyboard.png` | ↓ from a row: the next result selected, focused and previewed |
| `screenshots/light/04-window-1280x800.png` | A narrow list: the type and file count give way to the file name |

Real app (Vite, `/api` mocked) at 1,600 × 960 unless named; sample data.

## Steps

1. Clean tree, `git fetch origin`.
2. Apply: `git fetch <path>/results-compact.bundle claude/results-compact:claude/results-compact`
   then `git switch claude/results-compact`; or `git switch -c claude/results-compact origin/main`
   and `git am <path>/0001-*.patch`. If `main` moved, rebase; conflicts are likely only in
   `apps/web/src/styles.css` (the Results block), `CLAUDE.md` (the **Results** bullet) and today's
   release note.
3. `npm ci` if your checkout predates `main`.
4. `npm run check`. Already run: lint, typecheck and Prettier clean, web suite green (2,783 tests).
   Not run here: API and worker suites (web-only change).
5. **Release note:** the entry *A compact Results list* in
   `docs/release-notes/Release-Notes-20261022.html` links PR **#309** and the subtitle says
   *#289 to #309*: put the real PR number in both, and move the entry to that day's note if the
   PR merges on a later day (CLAUDE.md, Release notes).
6. By eye (`npm run dev:web`, Results): resize the window (the page never scrolls, the number of
   lines follows); Older/Newer across a day boundary; change type, Show or the name filter (back to
   page 1); ↑/↓ across a page boundary, PgUp/PgDn, Enter; a long preview scrolls under its head;
   under 1,000 px the preview goes below the list.
7. Push and `gh pr create --base main --head claude/results-compact` with the PR body below.

## What changed

**No API change.** `GET /api/results` already pages from the last row (`before`, `beforeId`) and
takes `limit` (1-200); the web client now sends `limit`.

- **`api/client.ts`:** `listResults` takes `limit` (sent as `limit=`); `client.test.ts` pins it.
- **`results/paging.ts` (new):** `layOutPage(rows, lines, dayOf, continuedDay)` lays a page out in
  `lines` lines: a heading before each day (a line), as many rows as fit, never ending on a
  heading, at least one row; the first heading is `continued` when the page starts inside the day
  the previous page ended in. Returns `{ lines, shown }`.
- **`results/ResultsPager.tsx` (new):** the Jobs pager's look (`jobs-pager` classes) —
  `nav "Pages of results"`, **‹ Newer** (`Newer results`), *Page n*, **Older ›** (`Older results`).
  The API does not count results, so there is no "of m"; the footer says *Showing a–b · newest
  first*.
- **`jobs/usePageSize.ts`:** optional `rowSelector` (default `tbody tr`); Results measures
  `tbody tr.result-row`, not a shorter day heading.
- **`results/ResultsPage.tsx`:**
  - Header: title and description on one line. The filters (type select, its label now visually
    hidden; Show; name filter) and the pager are the list card's top bar; *n results so far* and
    **Load more** are gone.
  - Paging: `lines` = `usePageSize(25, 'tbody tr.result-row')`; each request asks
    `limit: lines` from `cursor`; `layOutPage` decides how many of them show; **Older ›** pushes
    `{cursor, shown}` on a trail and starts from the last row shown; **‹ Newer** pops it.
    `hasOlder` = fewer shown than fetched (a page always holds a heading, so a full fetch is never
    all shown). A new type, Show or name filter resets cursor and trail; a resize re-asks from the
    same cursor.
  - Rows (`ResultRow`): badge, file name (the `Show preview of …` button, `title` = name), document
    type and version, reviewer, time, issues, files, ›; `data-job-id`, class `result-row`. Day
    headings stay `th scope="row"` with *(continued)*. The header row is `thead.visually-hidden`.
  - Keyboard on the list section: ↑/↓ select and focus the next result, turning the page at either
    end (the new page's first or last result once it has loaded, `fetchedAt`); PgUp/PgDn turn the
    page and select its first result; Enter on a file name opens `#/results/<id>`.
- **`results/ResultPreview.tsx`:** head, summary line and actions wrapped in `.preview-top`.
- **`styles.css`:** the card is a flex column (bar, `.result-list-rows`, footer); rows 36 px,
  `table-layout: fixed` with `col` widths (badge 56, type 22%, reviewer 150, time 88, issues 60,
  files 78, › 30), ellipsis everywhere, small inline file badge; day headings 28 px. A container
  query on `.result-list-rows` (≤ 760 px) zeroes the type and files columns and hides their cells
  (the preview has both). From 1,000 px the page is `100vh − top bar − 32px` like Jobs, the list
  card and rows area take the rest, the preview is static, scrolls on its own, `.preview-top`
  sticky. Below 1,000 px the rows area is `min(70vh, 900px)`.
- **Help** (`ResultsHelp`): the list section covers one line a result, the pager, *(continued)*,
  the narrow-window columns and the keys.
- **`CLAUDE.md`:** the **Results** bullet; **release note** entry (step 5).

## Tests

- `test/results-paging.test.ts` (new): headings counted, stopping without a trailing heading,
  *(continued)*, at least one row, empty.
- `test/ResultsPage.test.tsx`: calls now carry `limit: 25`; the two Load more tests are replaced
  by **pages** (size from the box, headings counted, Newer disabled; Older from the last row shown
  with the filter kept, *(continued)*, Older disabled at the end, Newer back; a filter resets to
  page 1) and **keyboard** (↑/↓ across pages with focus and preview, PgUp/PgDn, Enter, the hint).
- `test/AppShell.test.tsx`, `test/client.test.ts`: `limit` in the expected calls.

## PR body

```
Results: one line a result, by day, paged to fit the window

- Each result is one line (kind, file, document type, reviewer, time, issues, files), still under
  its day heading; in a narrow list the type and file count give way to the file name
- From 1,000 px the page is the window's height: the list shows as many lines as fit, headings
  counted, paged with ‹ Newer / Older › above it (replacing Load more); a page starting inside a day
  repeats its heading "(continued)"; the preview scrolls under its head
- Keyboard: ↑/↓ across pages, PgUp/PgDn, Enter opens the result

No API change (the existing before/beforeId cursor and limit). Tests for the layout, paging and
keys; help and release note updated. Light and dark screenshots in the handoff.
```
