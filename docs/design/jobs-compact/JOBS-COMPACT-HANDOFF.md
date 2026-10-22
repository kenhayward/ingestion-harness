# Jobs page: one line a job, paged to fit the window (option B): handoff for Claude Code

Repo: `kenhayward/ingestion-harness`. This change is **implemented, tested and committed**. Use
this handoff to apply it, run the full check and raise the PR.

- Branch: `claude/jobs-compact`
- Base: `main` at `f7c21ea` (Merge pull request #304)
- One commit on top of `main`. This file is in it, as
  `docs/design/jobs-compact/JOBS-COMPACT-HANDOFF.md`.

## Contents

| File | What it shows |
| --- | --- |
| `jobs-compact.bundle` | A git bundle with the branch. This is the preferred way to apply it. |
| `0001-Jobs-….patch` | The same commit as a patch, for `git am` (fallback) |
| `screenshots/{light,dark}/00-before.png` | The page today: two-line rows, with the model and a button on each row. 34 jobs make the page 2,400 px tall. |
| `01-list` | The new page: 20 one-line rows fill the window, the pager is above them, and the page does not scroll |
| `02-menu` | A row's ⋯ menu, with the main action first (Review), then Open PDF and Copy link |
| `03-confirm` | Delete from the menu: the confirmation opens where the menu was, and the row stays one line |
| `04-page-2` | **Older ›** pressed: jobs 21–34. The panel keeps the selected job. |
| `screenshots/light/05-window-1280x800.png` | A 1,280 × 800 window: 14 rows, with the file names cut off with an ellipsis |
| `screenshots/light/06-keyboard.png` | ↓ from a row: the next job is selected and focused |

The screenshots come from the real app (Vite with `/api` mocked) at 1,600 × 960, except where
another size is named. The jobs are sample data.

## Steps

1. From the repo root, on a clean tree, run `git fetch origin`.
2. Apply the commit:
   - **Bundle:** `git fetch <path>/jobs-compact.bundle claude/jobs-compact:claude/jobs-compact`,
     then `git switch claude/jobs-compact`.
   - **Patch:** `git switch -c claude/jobs-compact origin/main`, then `git am <path>/0001-*.patch`.
   - If `main` has moved, rebase. Conflicts are most likely in `apps/web/src/styles.css` (the
     Jobs block, `.job-list-box` to `.list-footer`, and the new `@media (min-width: 1000px)` block
     after it) and in `CLAUDE.md` (the **Home and nav** bullet, at "Jobs is `#/jobs`").
3. Run `npm ci` if your checkout is older than `main`.
4. Run `npm run check`.
   - Already run on this commit: lint, typecheck and Prettier are clean, and the web suite passes
     (2,775 tests).
   - Not run here: the API and worker suites. The change is web-only.
5. Check it by eye with `npm run dev:web`. Open Jobs, then:
   - resize the window: the number of rows changes and the page never scrolls;
   - page with ‹ Newer / Older ›, and change a filter, which goes back to page 1;
   - in the list, try ↑/↓ (across a page boundary), PgUp/PgDn, and Enter on a job awaiting
     review;
   - in a row's ⋯ menu, try Cancel or Delete (the confirmation opens over the list) and Copy
     link;
   - open **Clean up finished jobs…**: the list gets shorter and shows fewer rows;
   - open a `#/jobs/<id>` link to a job on page 2: it opens on page 2;
   - try a window under 1,000 px wide, where the panel goes below the list and the list is 70vh.
6. Push, then run `gh pr create --base main --head claude/jobs-compact` with the PR body below.

## What changed

**No API change.** The list is the one `GET /api/jobs` already returns. It is paged in the
browser.

### `apps/web/src/jobs/derive.ts`

- **`statusIcon(status)`** maps each status to an icon:
  - `queued` → queued (a dashed clock);
  - `running` and `delivering` → spinner;
  - `awaiting_review` → review (an eye);
  - `needs_review` → warning (a triangle);
  - `failed` → failed (✕ on a filled circle);
  - `succeeded` → done (✓ on a filled circle);
  - `rejected` → rejected (a slashed circle);
  - `cancelled` → cancelled (a minus in a circle).
- **`rowsThatFit(height, rowHeight)`** returns at least 5 rows.
- **`pageRange(total, size, page)`** returns `{ page, pages, from, to }`. It clamps the page, so
  a list that shrinks still has a page to show.
- **`MENU.height`** goes from 160 to 200: the menu has one more item, so it flips above the button
  sooner.

### `apps/web/src/jobs/JobStatusIcon.tsx` (new)

- An 18 px SVG with `role="img"`; its `aria-label` and `title` are the status label.
- It is coloured by the status tone. Every status has its own shape, so colour is never the only
  cue.
- The spinner turns, except under `prefers-reduced-motion`.

### `apps/web/src/jobs/JobList.tsx`

- **One row per job, with fixed columns:**
  - the status icon;
  - **Document:** the file name button, then the job's note after `·`, only when the note is
    `warn` or `danger` (awaiting review, needs review, failed);
  - the document type with its version;
  - created (relative time, with the full date in `title`);
  - **Took:** a clock and the duration, now in its own column;
  - ⋯.
- **Removed:** the model, the "Published" / "Extracting…" notes and the visible header row. The
  header is still there for screen readers, as `thead.visually-hidden`.
- **Long text:** the cells cut off with an ellipsis. The note gives way before the file name
  (`.doc-line`). Both cells carry the full text in `title`.
- **The table only:** `JobList` no longer draws the box around itself. Each `tr` carries
  `data-job-id`.

### `apps/web/src/jobs/JobActions.tsx` (`variant="row"`)

- **The row shows only ⋯.** The menu holds every action, with the main one first:
  - Review or View (links), Retry… or Cancel;
  - then Re-process…, Open PDF / Download original, Copy link and Delete, as before.
- **Popovers instead of inline text:** a Cancel or Delete confirmation, "Link copied", the link to
  copy by hand and an action error now open in a `.menu.row-popover`, where the menu was, instead
  of inside the row. The row stays one line.
- **Closing them:** opening the menu again clears them. A click outside closes the link to copy
  by hand.
- **Focus** always returns to the row's ⋯ button.
- **The panel variant is unchanged.** Every action is still a button in the details card.

### `apps/web/src/jobs/JobsPager.tsx` (new)

- `nav aria-label="Pages of jobs"` holds the range ("1–20 of 34"), **‹ Newer** (named "Newer
  jobs"), "Page 1 of 2" (`aria-live="polite"`) and **Older ›** ("Older jobs").
- At either end, the matching button is disabled.

### `apps/web/src/jobs/usePageSize.ts` (new)

- A `ResizeObserver` watches the rows area.
- Page size = the area's height ÷ a drawn row's height (36 px when no row is drawn).
- `FALLBACK_PAGE_SIZE` (25) applies until the area is measured, and in tests.

### `apps/web/src/jobs/JobsPage.tsx`

- **Header:** the subtitle is gone. It is "Jobs", then the live indicator and help.
- **The list box**, from top to bottom:
  - the status chips, **My jobs** and the pager;
  - the rows area (`.job-list-rows`, measured by `usePageSize`);
  - a footer with the keys hint, "Showing n of m jobs" and **Clean up finished jobs…**.
- **Paging:**
  - a new chip, My jobs or search goes back to page 1;
  - a resize keeps the first row on screen in view;
  - a linked job (`#/jobs/<id>`) opens on its own page once the list holds it.
- **Paging leaves the selection alone:** the pager doesn't change which job the panel shows.
- **Keyboard**, from a row's file name only (never inside the menu, a popover or a dialog):
  - ↑/↓ select the next or previous job and focus it, crossing pages;
  - PgUp/PgDn move a page and select its first job;
  - Enter on the selected job opens `#/review/<id>` when its main action is Review or View.
    Otherwise it selects, as before.

### `apps/web/src/styles.css`

- **The list box** is a flex column: the filters bar (with a bottom border), the rows area and
  the footer (with a top border).
- **The pager** is one bordered group.
- **Rows** are 36 px with `table-layout: fixed`. Column widths:
  - status 44 px;
  - type 26%;
  - created 104 px;
  - took 96 px;
  - actions 52 px.
- **The selected row** gets an accent bar on its left edge.
- **Status icons** have their own styles (`.status-icon*`), and there are `.row-popover` styles.
- **From 1,000 px:**
  - the page is `100vh − top bar − 32px` (and at least 480 px);
  - the list box and its rows area take what is left;
  - the panel scrolls on its own;
  - the page itself never scrolls.
- **Under 1,000 px:** the rows area is `min(70vh, 900px)`.
- Every colour is an existing token, so light and dark both work.

### Help and docs

- **`JobsHelp`:**
  - a new **Reading the list** section covers the icons, pages and keys;
  - **Acting on a job** now says that every action is in the panel and the ⋯ menu.
- **`CLAUDE.md`:** the **Home and nav** bullet describes the new list.

## Tests

- **`test/jobs-derive.test.ts`:** `statusIcon` for every status; `rowsThatFit` (minimum 5, a zero
  height or row height); `pageRange` (clamping, empty list, exact fit).
- **`test/JobList.test.tsx`:**
  - the row has only the file name button and ⋯;
  - the menu holds every action, main one first, for each status;
  - Review and View links;
  - the status icon's name and `title`;
  - a note only when the job needs attention;
  - no model;
  - the created date in `title`;
  - Took in its own cell;
  - the existing confirmation, retry and copy-link tests now go through the menu, and focus
    returns to ⋯.
- **`test/JobsPage.test.tsx`:**
  - paging: 30 jobs at 25 a page, both buttons, paging leaving the selection alone;
  - a filter going back to page 1;
  - clamping when the list shrinks;
  - a linked job's page;
  - keys: ↑/↓ across pages with focus, PgUp/PgDn, Enter on a reviewable job (and not on a
    failed one), and the keys hint.
- **`test/App.test.tsx`:** the three tests that clicked a row's Retry or Review now open its ⋯
  menu first.

## PR body

```
Jobs: one line a job, paged to fit the window

- Each job is one line: a status icon (a spinner while under way, its name on hover), the file
  name, why it needs you when it does, document type, created and how long it took; the model is
  left to the details panel
- Every action is in the details panel and the row's ⋯ menu (the main one first); confirmations,
  a copied link or an error open where the menu was, so rows stay one line
- From 1,000 px the page is the window's height: the list shows as many jobs as fit and pages
  with ‹ Newer / Older › above it; the page no longer scrolls
- Keyboard: ↑/↓ move the selection (across pages), PgUp/PgDn change page, Enter opens the
  selected job to review or view

No API change: the list is paged in the browser. Tests for icons, paging, keys and the menu;
help updated. Light and dark screenshots in the handoff.
```
