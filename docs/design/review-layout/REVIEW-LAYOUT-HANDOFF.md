# Review page: resizable workspace and outline (option A, with thumbnails and side swap): handoff for Claude Code

Repo: `kenhayward/ingestion-harness`. The change is **implemented, tested and committed**. This
handoff applies it, runs the full check and raises the PR.

- Branch: `claude/review-layout`
- Base: `main` at `22690f0` (Merge pull request #296)
- One commit on top of `main`. This file is in it, as
  `docs/design/review-layout/REVIEW-LAYOUT-HANDOFF.md`.

Jobs › View and Jobs › Review are the same component (`ReviewPage`, `#/review/<id>`), so both
change.

## Contents

| File | What it is |
| --- | --- |
| `review-layout.bundle` | A git bundle with the branch (the preferred way to apply it) |
| `0001-Review-a-resizable-workspace-….patch` | The same commit as a patch, for `git am` (fallback) |
| `screenshots/{light,dark}/00-before.png` | The page today: 17 tables wrap into about eight lines of tabs, and the page is about 1,800 px tall |
| `01-flagged-value-explained` | **Next flagged** has landed on row 3 of a table. The strip under the table explains the flag, the thumbnail for page 14 has a flag dot, and the 40/60 layout is selected |
| `02-fields` | The Fields item: a flagged field, its evidence and page links |
| `03-document-hidden` | The document folded to a rail on the left; the data takes the width |
| `04-data-hidden` | The data folded to a rail on the right; the page takes the width |
| `05-swapped-sides` | **Swap sides**: the data on the left, the document on the right |
| `06-document-60-percent` | The divider dragged to give the document 60% |
| `screenshots/light/07-window-1280.png` | A 1,280 px window |

The screenshots are of the real app (Vite with a mocked `/api`, so page images are drawn SVGs) at
1,600 × 960. The document, tables and flags are sample data modelled on your AQN1 stability
report.

## Steps

1. From the repo root, on a clean tree, run `git fetch origin`.
2. Apply the commit:
   - **Bundle:** `git fetch <path>/review-layout.bundle claude/review-layout:claude/review-layout`, then `git switch claude/review-layout`.
   - **Patch:** `git switch -c claude/review-layout origin/main`, then `git am <path>/0001-*.patch`.
   - If `main` has moved, rebase. Conflicts are most likely in `styles.css` (the Review block
     between `.why ul` and `.fields-grid th`), `review/ReviewPage.tsx` and `CLAUDE.md` (one
     sentence after the **Review** bullet's last line).
3. Run `npm ci`. `main` added `n3` since some earlier checkouts, and the web tests need it.
4. Run `npm run check`.
   - Already run on this commit: lint, typecheck and Prettier are clean, and the web suite passes
     (2,685 tests).
   - Not run here: the API and worker suites. The change is web-only.
5. Check it by eye with `npm run dev:web`. Open a document awaiting review, then:
   - drag the divider, and use the arrow keys on it;
   - fold each panel and bring it back, and swap sides;
   - reload the page: the arrangement stays;
   - use **Next flagged** and **Edit value**, and filter the outline;
   - open a finished job (read-only), where **Edit value** is not offered.
6. Push, then run `gh pr create --base main --head claude/review-layout` with the PR body below.

## What changed

### `apps/web/src/review/layout.ts` (new)

- **`ReviewLayout`:** `{ docWidth, hidden: 'doc' | 'data' | null, docSide: 'left' | 'right' }`.
  The default is 45%, nothing hidden, the document on the left.
- **Limits:**
  - `clampWidth` keeps the width between 20% and 80%;
  - `DOC_WIDTH_PRESETS` is 30, 40 and 50;
  - `DOC_WIDTH_STEP` is 5% per arrow key.
- **`loadLayout` / `saveLayout`:** read and write `localStorage['ih.reviewLayout']`, inside
  try/catch. A damaged value falls back field by field.
- **`splitName`:** turns "Test Parameters (Table IX)" into `{ title: 'Test Parameters',
  ref: 'Table IX' }`. A name without a trailing bracket stays whole.

### `apps/web/src/review/PageViewer.tsx`

The toolbar is unchanged, plus an `actions` slot on the right for **Swap sides** and **Hide the
document**.

**New: page thumbnails.** A `nav aria-label="Pages"` with one button per page:
- each is named `Page n`, or `Page n (flagged values)`, with `aria-current="page"` on the open
  one;
- the image is the page's own image, `loading="lazy"`, so a 33-page document fetches only the
  thumbnails in view;
- a dot marks pages a flagged **field** was found on. Table cells carry no page in the document,
  so their pages get no dot.

The strip shows only for documents with more than one page.

### `apps/web/src/review/ReviewPage.tsx`

**Workspace:** `.review-workspace` sets `--doc-width` from the layout. Its children are the
document pane, the divider and the data pane, swapped in the DOM when the document is on the
right, so the reading order follows what you see.

**Divider:** `role="separator"`, `aria-orientation="vertical"`, named "Resize the document and
the data", with `aria-valuenow`, `aria-valuemin` and `aria-valuemax`, and focusable.
- Pointer dragging uses pointer capture and works out the share of the workspace's width.
- The arrow keys move it 5% towards either side, and Home/End jump to 20% and 80%.
- It is hidden while a panel is folded.

**Rails:** a folded panel becomes a 44 px rail with **Show the document** or **Show the data**
and vertical text: "Document · page 14 of 33", or "Extracted data · 64 flagged".

**Data header:** "Extracted data · 6 fields · 17 tables · 64 flagged". Next to it:
- the **Document width** group, with buttons named `Document 30%`, `Document 40%` and
  `Document 50%` that show 30 / 70, 40 / 60 and 50 / 50 (`aria-pressed`);
- **Hide the data**.

**Outline:** the old tab strip becomes a vertical tablist (`aria-orientation="vertical"`, still
named "Extracted data"), with group heads Document, Tables (with "n flagged" tables) and Review.
- Above it: **Next flagged (N)** (name unchanged), then **Find a table or field**, which filters
  the items by name.
- Each item is a `role="tab"`:
  - its accessible name is `<label> <count>`, plus ` (k flagged)` when it has flags. That used to
    be ` (flagged)`, so the two tests that named it now include the count;
  - it shows the name, and the trailing reference on a second line for tables;
  - an amber flag chip with the number of flagged cells (fields: flagged fields; Graph: SHACL
    reasons), then the count.

**Open table:**
- **Header:** the table's name, "n rows", "k flagged", a **Rows** group (**All rows** /
  **Flagged only**, replacing the "Flagged rows only" checkbox), and ‹ › buttons named
  `Previous table: X` / `Next table: Y` (just "Previous table" / "Next table" when disabled).
- **Table:** the heading row stays in place while you scroll; the table scrolls inside the pane.
- **Flagged value strip:** `section aria-label="Flagged value"`, for the flagged cell that
  **Next flagged** landed on or that has focus. It shows "Row 3 · Assay (%)", the flag
  messages, and **Edit value** (only while the job awaits review), which opens that cell's
  editor.

**Unchanged:** fields, Steps (re-run, model log), Edits, Graph, the header, the decision bar,
and every edit and decision call.

### `apps/web/src/styles.css` (Review block)

- **Workspace:** `max(520px, 100vh − top bar − 340 px)` tall, so it ends above the sticky
  decision bar; each pane scrolls on its own.
- **Divider:** 10 px with a grip, highlighted on hover and focus. **Rails:** 44 px.
- **Thumbnails:** 76 px wide. **Outline:** 270 px, with rows that match the Results and Mapping
  outlines.
- **Below 1,000 px** the panes stack, at 70vh and 80vh, with no divider and no width presets; a
  rail becomes a bar.
- **Below 640 px** the outline goes above the open item.
- `.fields-grid` inside the data view uses fixed columns, so Evidence stays visible at 40/60.
- `.tab-count.tone-warn` and the old `.data-tabs` rules are removed (nothing else used them).
- Every colour is an existing token, so light and dark both work.

### Also changed

- **`apps/web/src/ui/Icon.tsx`:** a new `swap` icon.
- **Help** (`ReviewHelp` in `help/WorkbenchTabsHelp.tsx`): new sections **Arranging the page**
  and **Finding a value**.
- **`CLAUDE.md`:** one sentence after the **Review** bullet.

## Tests

**`apps/web/test/ReviewPage.test.tsx`:**
- Updated:
  - the tab names now carry the flag count: `results 3 (2 flagged)` and `Graph 1 (1 flagged)`;
  - the flagged-rows filter is now the **Rows** group.
- New, in `ReviewPage layout`:
  - the outline: vertical, the Tables head with "1 flagged", and **Find** narrowing it;
  - a long table name split onto two lines;
  - ‹ › between tables;
  - the **Flagged value** strip after Next flagged, for a check message and for an issue, with
    **Edit value** focusing the cell's editor;
  - the divider: 45 by default, → to 50, the 30% preset, and remembered after a remount;
  - hiding and showing each panel, with the divider gone while hidden;
  - **Swap sides** changing the DOM order;
  - thumbnails: three pages, `aria-current`, the flag dot on page 3, and opening page 2.

**`apps/web/test/review-layout.test.ts` (new):** `splitName` cases, `clampWidth`, and
save/load, including damaged storage.

All the other Review tests (edits, approve, reject, re-runs, model log, references, graph,
Next document, help) pass unchanged.

## PR body

```
The Review page (and the read-only view of a finished job) becomes a resizable workspace.

- The document and the data side by side, split by a draggable divider (arrow keys, Home/End;
  20–80%; 30/70, 40/60 and 50/50 buttons); either panel folds to a rail at its side, and Swap
  sides puts the document on the right; remembered per browser
- Page thumbnails beside the page, with a dot on pages holding flagged fields
- The wrapping tab strip becomes an outline: Fields, each table (its "(Table IX)" on a second
  line, its flagged-cell count), Edits, Steps, Graph; Find a table or field; Next flagged
- The open table: All rows / Flagged only, previous/next table, sticky headings, and a strip that
  says why the flagged cell in focus was flagged, with Edit value

Tests for the layout, outline, thumbnails, divider and flag strip; help updated. Light and dark
screenshots in the handoff.
```
