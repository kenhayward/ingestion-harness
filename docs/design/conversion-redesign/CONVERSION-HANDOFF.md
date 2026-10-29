# Conversion tab redesign, and re-running failed documents: handoff for Claude Code

Repo: `kenhayward/ingestion-harness`. **Implemented, tested and committed**; this handoff applies it,
runs the full check and raises the PR. It is option A of the Conversion proposals and the batch view
designed after it (re-run failures), built with the two API routes that design needed.

- Branch `claude/conversion-redesign`, one commit on `main` at `f89d34e` (Merge pull request #331).
  This file is in it as `docs/design/conversion-redesign/CONVERSION-HANDOFF.md`.

## Contents

| File | What it is |
| --- | --- |
| `conversion-redesign.bundle` | Git bundle of the branch (preferred) |
| `0001-….patch` | The same commit for `git am` |
| `screenshots/{light,dark}/00-before-page.png` | Today: Target select, drop box, a list, a checkbox, **Start**; earlier batches a plain list |
| `00-before-batch.png` | Today's batch: two-line rows, every action a button on its row, the page ~2,500 px tall |
| `01-page.png` | New batch as three numbered steps, the file list's counts, **Convert 6 documents**; Earlier batches as a table |
| `02-batch.png` | A batch: header, totals and bar, one line a document, the first failed one in the panel |
| `03-rerun-dialog.png` | **Re-run 3 failed**: every failed document ticked, *Keep Force-load* |
| `04-row-menu.png` | A failed line's `⋯` menu: Re-run, View report, Download original |
| `screenshots/light/05-batch-800.png` | Under 1,000 px: the header's buttons wrap, the panel goes below the list |

Real app (Vite, `/api` mocked) at 1,600 × 1,000 unless named; sample data.

## Steps

1. Clean tree, `git fetch origin`.
2. Apply: `git fetch <path>/conversion-redesign.bundle claude/conversion-redesign:claude/conversion-redesign`
   then `git switch claude/conversion-redesign`; or `git switch -c claude/conversion-redesign origin/main`
   and `git am <path>/0001-*.patch`. If `main` moved, rebase; conflicts are likely only in
   `apps/web/src/styles.css` (the Conversion block, which this replaces), `CLAUDE.md` (the
   **Document decomposition** bullet), `docs/openapi.json` (regenerate with `npm run openapi`) and
   today's release note.
3. `npm ci` if your checkout predates `main`.
4. `npm run check`. Already run here: lint, typecheck and Prettier clean; TS suites green; the Pg
   contract for `retryItems` green against a throwaway Postgres (see Tests). Run the worker suites
   too (no worker change, so they should be untouched).
5. **Release note:** the entry *Conversion redesigned, and failed documents re-run* in
   `docs/release-notes/Release-Notes-20261026.html` says **PR to follow**: replace it with the PR
   link (`<a href="https://github.com/kenhayward/ingestion-harness/pull/N">#N</a>`, like the
   entries above it), and move the entry, with its *Watch out for* bullet on the two routes, to
   that day's note if the PR merges on a later day (CLAUDE.md, Release notes).
6. By eye (`npm run dev:web`, Conversion, with a document target): pick files and a folder (the
   counts; *Clear all*); convert; open a batch with failures; **Re-run N failed**, untick one,
   switch *Keep Force-load*, confirm (the new batch opens; the old one keeps its record); try again
   at once (409: *a re-run of … is still running* stays in the dialog); a line's `⋯` menu;
   *Download original*; resize the window (the list never scrolls, the line count follows);
   under 1,000 px the panel goes below.
7. Push and `gh pr create --base main --head claude/conversion-redesign` with the PR body below.

## What changed

### API: two routes, one repository method (operators may use both)

- **`POST /api/conversions/batches/{id}/retry`** (`retryConversionItems`): body
  `RetryItemsSchema` `{ itemIds: uuid[] (1 to MAX_RETRY_ITEMS 1000, each once), force? }`
  (`packages/shared/src/conversions.ts`). 404 unknown batch; 400 bad body; 409 `not_finished`
  when the batch never started, or while an earlier re-run of one of the items is unfinished;
  422 `not_failed` (an id not in the batch, or an item that did not fail) or
  `target_takes_no_documents`; 201 `{ batch, items }`. `force` left out = the batch's own. The
  new batch is created started, its creator the caller; each item is a new `decompose` job from the
  item's stored `objectKey`, `redeliverOf` the old item. Nothing is uploaded again.
- **`GET /api/conversions/items/{id}/source`** (`getConversionSource`): the stored Word file as an
  attachment (`contentDisposition` from `routes/jobs.ts`, the item's file name); 404, 502 when the
  store fails.
- **`ConversionRepo.retryItems(retry)`** (`apps/api/src/conversions/repo.ts`, `Retry`,
  `RetryResult`): one transaction on Pg (`apps/api/src/repositories/pg.ts`): lock the items
  (`FOR UPDATE`, ordered by id), refuse with the first busy id when any has a re-run in
  `RUNNING_OUTCOMES`, insert the batch, then per item a `decompose` job (`BACKGROUND_JOBS.decompose`
  priority and attempts, params `{batchId, itemId, targetId, sourceKey, force}`) and the item. The
  memory repo does the same. Locking makes two concurrent re-runs of one item queue one batch.
- `OPERATOR_CALLS` (`packages/shared/src/roles.ts`) lists both routes; `docs/openapi.json`
  regenerated.

### Web

- **Client:** `retryConversionItems(batchId, body)`, `conversionSourceUrl(itemId)`
  (`client.test.ts` pins both; `fakeApi` stubs them).
- **`ConversionPage`:** with a batch id it renders only `BatchView` (keyed by the id, so opening the
  re-run's batch starts fresh), which has its own header. The page header is one line.
- **`NewBatch`:** one card of numbered steps (`h2` *1 Target*, *2 Word files*, *3 Options*; the
  select keeps the name *Target*). Force-load is a `role="switch"` checkbox (`conv-switch`). The
  button reads **Convert N documents** (*Convert documents* disabled with none ready,
  *Converting…* while busy), with *to target · sink* under it. The file list's head counts files,
  ready, skipped (refused keys, repeats) and left out (not `.docx`, hidden, lock files; this
  replaces the old paragraph) and has **Clear all**. Upload, cancel and start logic is unchanged.
- **Earlier batches:** a table (`aria-label "Earlier batches"`), `BATCHES_PER_PAGE` 10 a page with
  the Jobs pager's look (`Pages of batches`, *‹ Newer* / *Older ›*). Each row: a glyph from
  `batchState` (*Under way*, *Some failed*, *Needs attention*, *Nothing new*, *Done*,
  *Never started*, *Discarded*), the date as the link (*Today, 11:00*, else *Fri, Oct 23*; the full
  time on hover), target · sink, a *Force-load* tag, *N docs*, a chip per outcome, who started it.
  The whole row opens the batch.
- **`BatchView`:**
  - Header: *‹ Conversion*, `h1` *Batch · date*, target and sink tag, *started by* (avatar and
    name), *took* (start to the last finish, once all are final), *Force-load* tag; **New batch**,
    **Re-run N failed** (a started batch with failures), help.
  - `Totals`: documents, created or updated, already loaded, need attention (not failed), failed;
    a bar by tone and the progress sentence.
  - The list: All / Needs attention / **Failed** / Done, **Find a document** (path contains, any
    case), the pager (`Pages of documents`, *Previous page* / *Next page*). One line a document:
    `OUTCOME_ICON` glyph, the path (a button that selects the line), the outcome pill, the detail
    (resolution and note first), the time alone (*1 min 12 s*; the words in `title`), *Open ↗*
    (`aria-label "Open in the target"`), the `⋯` menu. Rows per page come from `usePageSize`
    (`rowsPerPage` prop, default `DOCUMENTS_PER_PAGE` 50 until measured); from 1,000 px the page is
    the window's height and only the panel scrolls.
  - `RowMenu` (`Actions for <path>`): Re-run (failed, started batch), View report, Download original
    (`<a download>`), then the item's own actions as menu items (`ItemActions menu`, named by their
    words alone).
  - `DocumentPanel` (`aside "Document"`), keyed by item: file name, folder · size, pill, the
    resolution, *Why it failed* / *Why it needs attention* box, Started, Finished · took, Report
    (*View report*, `aria-label "Report for <path>"`), In target, then **Re-run this document**,
    the existing `ItemActions` (unchanged names: `Force-load <path>`, …) and **Download original**.
    Until a line is picked it shows the first document needing attention, else the first.
  - The polling, progress announcement, open/discarded callouts and action notice are unchanged.
- **`RetryDialog` (new):** title *Re-run N failed documents* (header) or *Re-run <path>* (one);
  every listed document ticked with its reason; *Keep Force-load* switch, starting as the batch
  was; **Re-run N documents** (disabled at none). Success navigates to the new batch; a refusal
  stays in the dialog as an alert.
  (2026-10-29, owner's call) Re-runs now stay in their batch: the route resets each failed item in
  place (queued, a new job, its last run's detail, report, link, times and review cleared) and
  answers 200 with the batch as now, so the dialog hands that to `BatchView` and closes, and the
  list polls while they run. The header's **Re-run N failed** became **Re-run Failures** on the
  list's bar after *Find a document*, and the dialog has an **Auto approve** switch under *Keep
  Force-load*, starting off (`RetryItems.autoApprove`; absent is off, whatever the batch). A
  document is re-run in place as often as it fails; one run again in a batch of its own
  (`rerunIn`, force-load, redeliver, reload) is still re-run from there.
- **Shared bits:** `StatusGlyph` exported from `jobs/JobStatusIcon.tsx` (`JobStatusIcon` uses it);
  `outcomes.ts` adds `OUTCOME_ICON`, `isDelivered`, `isFailed`, `batchState`, `spokenSize`.
- **Styles:** the Conversion block of `styles.css` is replaced (new batch, earlier batches,
  batch view, panel, re-run dialog, `conv-switch`, `sink-tag`, `force-tag`, `tone-text-*`,
  `tone-bg-*`); the narrow-screen table rule skips `.batch-list` and `.batch-table`.
- **Help:** `ConversionHelp` describes the steps, the batch view, re-running and the original.

### Not built (not asked for)

Re-run with a replacement file for a failed document (redeliver needs a register entry, which a
failed item lacks), an attempts count in the panel (attempts are not on the item), and the
*Needs attention* / *Mine* filters and totals on Earlier batches shown in the option A mockup.

## Tests

- API: `apps/api/test/conversions-contract.ts` (three `retryItems` cases, run on memory and, with
  `IH_TEST_DATABASE_URL`, on Pg: `npx vitest run --config apps/api/vitest.integration.config.ts
  conversions-pg`), `apps/api/test/conversion-actions.test.ts` (*re-running failed documents*: 5,
  *a document's original file*: 3; every response checked against the docs), roles and OpenAPI
  sweeps.
- Web: `apps/web/test/conversion-redesign.test.tsx` (new, 14), `conversion-batch.test.tsx` and
  `conversion-new-batch.test.tsx` updated where the design moved things, never loosened: the row's
  actions are asserted on the panel of the picked row (`panelFor`), *Start* is *Convert N
  documents*, Force-load a switch, the time on a line is the time alone (its words on the panel),
  Earlier batches a table. One update caught a real bug, fixed: the panel's actions kept a pending
  action's disabled state when another line was picked (now keyed by item).

## PR body

```
Conversion tab redesign (option A) and re-running failed documents.

New batch: one card in three numbered steps, Force-load a switch, "Convert N documents", the file
list's counts and Clear all. Earlier batches: a table with a state icon, outcome chips and who
started it, ten a page.

A batch: header with Re-run N failed, totals and a bar, one line a document paged to the window,
Failed filter and Find a document, a ⋯ menu per line, and the picked document beside the list
(why it failed, times, report, actions, Download original).

API: POST /api/conversions/batches/{id}/retry re-runs chosen failed documents from their stored
files as one new batch (409 while an earlier re-run is unfinished); GET
/api/conversions/items/{id}/source downloads the original. Both open to operators, documented.

Handoff: docs/design/conversion-redesign/CONVERSION-HANDOFF.md
```
