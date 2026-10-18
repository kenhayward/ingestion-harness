# Results list and result detail (option A for both): handoff for Claude Code

Repo: `kenhayward/ingestion-harness`. The change is **implemented, tested and committed**. This
handoff applies it, runs the full check and raises the PR.

- Branch: `claude/results-list`
- Base: `main` at `223a4e3` (Merge pull request #249)
- One commit on top of `main`; this file is in it as `docs/design/results/RESULTS-HANDOFF.md`.

## Contents

| File | What it is |
| --- | --- |
| `results-redesign.bundle` | A git bundle with the branch (the preferred way to apply it) |
| `0001-Results-grouped-list-….patch` | The same commit as a patch, for `git am` (fallback) |
| `screenshots/{light,dark}/00-before-list.png` | The list today: the preview's table pushes past the page (1,476 px wide in a 1,440 px window) |
| `00-before-detail` | A result today: about 3,800 px tall, every table drawn in full, 14 file links at the top |
| `01-list-preview` | The list grouped by day, with the first row's preview |
| `02-list-other-selected` | Another row picked (a PDF: the preview offers **PDF**, not **Original**) |
| `03-list-with-issues-filter` | **Show: With issues**, filtered on the server |
| `04-detail-opens-on-fields` | A result opens on Fields; the edited value is marked |
| `05-detail-table-with-edits` | A table: sticky headings, number columns right-aligned, edited cells, Filter rows, CSV, ‹ › |
| `06-detail-check-near-match` | A check: values found, the result, what each matched, and the edit distance |
| `07-detail-published-files` | The published files with their row counts |
| `screenshots/light/08-list-narrow-1100.png` | A 1,100 px window: the preview goes below the list |
| `screenshots/light/09-detail-narrow-1100.png` | A 1,100 px window: the header's meta wraps and the table scrolls sideways |

The screenshots are of the real app (Vite with a mocked `/api`) at 1,440 px, full page, in an
en-US browser. The results, documents and reviewers are sample data.

## Steps

1. From the repo root, on a clean tree, run `git fetch origin`.
2. Apply the commit:
   - **Bundle:** `git fetch <path>/results-redesign.bundle claude/results-list:claude/results-list`, then `git switch claude/results-list`.
   - **Patch:** `git switch -c claude/results-list origin/main`, then `git am <path>/0001-*.patch`.
   - If `main` has moved, rebase. Conflicts are most likely in `styles.css` (the list block
     replaces the old one before `/* Document types`; the old `/* Results */` block near
     `/* Jobs: bulk clean-up` is removed), `docs/openapi.json` (rerun `npm run openapi`) and
     `CLAUDE.md` (one sentence added to the **Results** bullet).
3. Run `npm run check`.
   - Already run on this commit: lint, typecheck and Prettier are clean; the web suite (2,441
     tests) and the API suite (1,601 tests) pass.
   - Not run here: the worker suite (untouched) and the Postgres side of the new filter. Please
     check the `show` filter against a dev database (step 4).
4. Check it by eye with `npm run dev:web`:
   - **Results:** pick rows, try each **Show** button, a document type and the file name filter,
     then **Load more** with more than 50 results.
   - **A result:** open one, step through its tables, filter rows, and open a check and Published
     files.
   - **The `show` filter on Postgres** (it changes SQL): `GET /api/results?show=reviewed`,
     `?show=auto` and `?show=issues` should return only approved, only auto-approved, and only
     results whose `issues` output has rows. Combine one with `templateId`, `q` and a `before`
     cursor.
5. Push, then run `gh pr create --base main --head claude/results-list` with the PR body below.

## What changed

### API: `GET /api/results?show=`

- `RESULT_SHOWS = ['reviewed', 'auto', 'issues']` and `ResultShow` are new in
  `packages/shared/src/results.ts`.
- The route's `ListQuery` takes an optional `show` (400 for any other value) and documents it.
  `docs/openapi.json` is regenerated.
- What each value means:
  - `reviewed`: `jobs.reviewed_at IS NOT NULL`;
  - `auto`: `jobs.reviewed_at IS NULL`;
  - `issues`: the published `issues` output has `row_count > 0`. A result with an empty
    `issues.csv` is not included.
- `ListPublishedQuery.show` is implemented in `MemoryRepo` and `PgRepo`:
  - `reviewed` and `auto` are `WHERE` conditions on `$6`.
  - `issues` is a `HAVING` condition on the same `max(row_count) FILTER (WHERE output_id = 'issues')`
    the row already computes.
  - The cursor's `HAVING` clause is now in parentheses, so it combines with the `issues`
    condition.
- `apps/web/src/api/client.ts` `listResults` sends `show` when it is set.

### Results list: `apps/web/src/results/ResultsPage.tsx`

**Toolbar:**
- **Document type** is a `<select>` labelled "Document type", replacing the chips. There are as
  many options as before; retired types are still included.
- **Show** is a `role="group"` `.segmented` control with All, Reviewed, Auto-approved and With
  issues (`aria-pressed`). Picking one reloads the list from the server.
- The file name search now has a search icon.
- A count sits at the right, e.g. "8 results", or "50 results so far" while more can be loaded.

**Table:** `aria-label="Published results"`, with fixed columns: a badge, Document, Reviewed by,
Published, Issues, Files and ›.
- **Day groups:** each new publish day starts with a `th scope="row"` heading: Today, Yesterday,
  or "Fri, Oct 16" (the year is added when it is not this one).
- **Badge:** `FileBadge` shows PDF or DOCX.
- **Document cell:** the existing `Show preview of <file>` button now holds the file name and,
  under it, "<document type> vN". Both are cut short with "…", and the button's `title` gives the
  full name.
- **Reviewed by:** `Reviewer` shows the reviewer's initials and name, "Auto-approved" (muted), or
  "Unnamed reviewer".
- **Published:** the time only; the day is the group heading.
- **Issues:** a warning icon and the count, or "—".
- **Files:** "n files".
- **Rows:** clicking anywhere on a row selects it, and the selected row has an accent bar. The
  per-row action buttons are gone; they are in the preview.
- **Footer:** **Load more**, or "Showing n results · newest first" when there is nothing more to
  load.

**Empty states:**
- A file name filter that matches nothing: "No results match “q”." (as before).
- Each Show filter has its own message, e.g. "No published results with issues.".
- A document type with nothing published: "No published results for this document type." (as
  before).

**Layout:** `.results-layout` is a grid, `minmax(0, 1fr) 420px`, so the list and the preview can
no longer overlap.
- Below 1,180 px the preview moves under the list.
- Below 720 px the Reviewed by and Files columns are hidden.

### Preview panel: `apps/web/src/results/ResultPreview.tsx`

`aside aria-label="Result preview"`, sticky beside the list. From top to bottom:
1. **Header:** the badge and the file name as an `h2`.
2. **Sub-line:** the type and version as a tag, "Published …", "· Reviewed by X" or
   "· Auto-approved", and "· n issues" or "· No issues" (left out when the result has no issues
   output).
3. **Actions:** `ResultActions` (exported, and reused by the detail page) is a `role="group"
   aria-label="Actions"` with the same link names as the old row buttons:
   - **Open full result** (`Open full result for <file>`, the primary button);
   - **PDF** (`View PDF of <file>`, opens in a new tab) or **Original**
     (`Download original of <file>`, a `.docx` download);
   - **ZIP** (`Download <file> results as ZIP`).
4. **Fields:** the first `PREVIEW_FIELDS` (6), with "6 of N" when there are more.
5. **First table:** its first `PREVIEW_TABLE_ROWS` (3) rows, inside `.preview-scroll`, which
   scrolls sideways within the panel. This fixes the reported overlap. Cells are cut short with
   the full text in their `title`. The heading says "first 3 rows", or "1 row" when the table is
   shorter.
6. **Published files:** from the list row's `outputs`, the first `PREVIEW_FILES` (8), each with
   its format, name and row count, then "and N more in the full result".

The loading, error, legacy-spec and no-document messages are unchanged.

### Result detail: `apps/web/src/results/ResultDetail.tsx`

**Header:**
- A `‹ Results` crumb (link name "Results").
- The badge, and the file name as the page's `h1`.
- A meta `dl`:
  - a type tag with the document type's **name** and version. It comes from `listSpecs`
    (retired types included); the id is shown until the name loads.
  - **Published** (`fullWhen`: e.g. "Oct 18, 2026, 04:18 PM"), **Review** and **Publishing
    target** (label plus `bucket/prefix`). The `dt`/`dd` pairs are kept, so `valueOf` in the tests
    still works.
- On the right: `ResultActions` (**PDF** or **Original**, and **Download all · ZIP** as the
  primary button), then the help button.

**Summary tiles:** `ul aria-label="Summary"`, four tiles:
- **Fields:** the count, and "n edited in review".
- **Tables:** the count, the total rows, and "n cells edited".
- **Checks:** the count, and "n to look at" or "all matched".
- **Issues:** the count, and "n to look at" or "nothing flagged".

Edits and things to look at are shown in amber.

**Outline:** `nav aria-label="Result contents"`, 280 px wide. One button per item
(`aria-label` is the item's name, `aria-current` marks the open one), with a count on the right
that is amber when it is something to look at.
- **Document:** Fields.
- **Tables:** each table with its rows and "· n edited". The group head shows the total rows.
- **Checks:** each check, with "n to look at" or "all matched". The group head shows
  "k of n clean".
- **More:** Issues and Published files.
- It opens on Fields, or on the first table when there are no fields. Items with nothing in them
  are left out (no Fields item without fields).

**Open item:** a `section` named after the item.
- **Fields:** a two-column `dl` of label and value. An edited field has its row tinted, with an
  "EDITED" tag.
- **Table** (`TableView`):
  - Toolbar: the name, "n rows · n columns", an edited-cells legend, a **Filter rows** search
    (rows with a cell containing the text; it never changes the row numbers), and
    **CSV** (`Download <table> as CSV`, the table's published output).
  - The table: row numbers, headings that stay put while scrolling (it scrolls within
    `max-height: calc(100vh - 300px)`), and right alignment for numbers and for the values of
    `integer`/`decimal` columns.
  - Edited cells are tinted with an "edited" tag (the `edited-cell` class and the text marker are
    kept).
  - Footer: "n rows" or "k of n rows", and ‹ previous / next › buttons. From the last table, next
    goes to the first check.
- **Check** (`CheckView`):
  - When every row has the worker's `value`, `status`, `matched`, `distance` and `count` keys
    (`checks.run_check`), the columns are **Value found**, **Result** (Exact match / Alias /
    Near match / Not found / Not used, each a coloured dot), **Matched to**, **Edit distance** and
    **Times seen**. The footer reads "n exact · n near · n not found · n not used".
  - A row is something to look at when it is near, unmatched or unused.
  - Other check shapes keep the plain table of every column.
- **Issues:** the same six columns as before, or "No issues were flagged for this document."
- **Published files:** a grid of each output: format, a download link named
  `<outputId>.<extension>`, and its row count.

**Without a document** (a legacy spec result, or a document error): the header, the alert if
there is one, the Published files card, and the legacy CSV and JSON previews, all as before.

**Narrow:** below 900 px the tiles go two to a row and the header wraps. Under 640 px of content
width (a container query), the outline sits above the open item.

### Shared bits

- `apps/web/src/results/FileBadge.tsx`: `FileBadge` (PDF in alert colours, DOCX in info colours)
  and `initials`.
- `apps/web/src/results/format.ts` adds `fullWhen`, `timeOf`, `dayLabel(iso, now)` and
  `plural`.
- `styles.css`:
  - The old `/* Results */` block and the old list and preview blocks are replaced by one block
    (list, preview, detail). `.list-box` and `.table-outputs .doc-button` are kept for other
    pages.
  - Every colour is an existing token, so light and dark both work.

### Help and docs

- `ResultsHelp` and `ResultHelp` describe the new filters, the preview, the tiles and the
  outline.
- `CLAUDE.md`'s **Results** bullet names the `show` filter and the new structure.

### Unchanged

- `GET /api/results/:jobId`, the archive route and the output URLs.
- The paging cursor, the 250 ms file name debounce and the top-bar search.
- Legacy output previews.

## Tests

- **API:** `apps/api/test/results.test.ts` has a new test for `show=reviewed|auto|issues`, which
  also checks that an `issues` output with 0 rows is not included, that `show` combines with
  `q`, and that a bad value is a 400.
- **`ResultsPage.test.tsx`:**
  - Updated:
    - row text is checked as `pvp v3`, Auto-approved and Unnamed reviewer;
    - the actions are checked in the preview's Actions group;
    - the type filter is driven through the select;
    - the out-of-order and empty-type tests pick from the select.
  - New:
    - the Show group calls `listResults` with `show` and shows its empty message;
    - rows are grouped by day (Today, Yesterday, a date) with the time, and the count is shown.
- **`ResultPreview.test.tsx`:**
  - Updated: the sub-line checks the type and version, "Reviewed by", "1 issue" and
    "Auto-approved"; the table is checked to sit inside the panel's scroll box.
  - New: the fields are capped at 6 with "6 of 8"; the published files list shows formats,
    names and rows.
- **`ResultDetail.test.tsx`:**
  - Updated: the header is checked as an `h1` with the type, the Actions links, and the
    published files under the Published files item; tables and checks are opened from the outline
    first.
  - New:
    - the summary tiles;
    - the outline's order, its opening item, and next ›;
    - Filter rows;
    - a matching check's columns and summary.

`Help` and `HelpCenter` pass unchanged.

## PR body

```
Redesigns the last two legacy screens, Results and a published result.

Results list
- One line per result, grouped by publish day (Today, Yesterday, date), with a PDF/DOCX badge,
  the document type under the name, reviewer, time, issues and file count
- A fixed-width preview panel that can no longer overlap the list: its table scrolls inside it;
  Open full result, PDF/Original and ZIP move from every row into the panel; first fields, first
  table rows and the published files
- Document type becomes a select; new Show filter (All / Reviewed / Auto-approved / With issues),
  applied on the server: GET /api/results?show=reviewed|auto|issues (Memory and Pg repos, OpenAPI)

Result detail
- Header with the document type's name, publish time, review and target, PDF/Original and
  Download all · ZIP
- Summary tiles: fields, tables, checks and issues, with what was edited or needs a look
- An outline of the contents (fields, each table, each check, issues, published files) beside the
  one item open: tables with sticky headings, Filter rows, CSV and ‹ ›; checks as value found,
  result, matched to, edit distance, times seen

Help for both pages updated. Light and dark screenshots in the handoff.
```
