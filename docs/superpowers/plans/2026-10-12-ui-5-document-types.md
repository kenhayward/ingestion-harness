# UI redesign PR 5: Document types. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Document types table with the handoff's card grid. Each card shows its versions, its shape, a quality line and quick actions. New document type and Import YAML move into dialogs.

**Architecture:**
- **API addition A5:** `GET /api/templates` gains a per-type `summary`, so the grid needs no request per card.
  - **Shape** is counted from the latest definition (draft, else published).
  - **The reference count** comes from `repo.listReferences`.
  - **Draft validation issues** come from `validateTemplate`.
  - **The last regression** comes from the existing per-version regression report.
- **Shared report helper:** the report logic moves into `apps/api/src/regression/report.ts`, so the `/regression` route and the summary share it.
- **Web:**
  - `TemplatesPage` renders `TemplateCard`s and two dialogs built on a new `ui/Dialog.tsx` primitive.
  - Card quality copy comes from a pure `qualityLine(summary, draft)`.

**Tech Stack:** Fastify, Zod, React 19, Vitest.

**Spec:** `docs/design/ui-redesign/SPEC.md` §4, `FEATURES_AND_API.md` A5 and rows 18–19. Screenshot: the handoff's `04-document-types.png`.

## Global Constraints

- **`summary` shape:** `{ sections: number; fields: number; tables: number; references: number; draftIssues: number | null; lastRegression: { version: number; matched: number; total: number; at: string } | null }`.
  - **Counts:** shape counts are 0 when the definition lacks that part.
  - **`draftIssues`:** null when there's no draft.
  - **`lastRegression`:** reported for the card's version (draft ?? published).
    - It is null when that version has no finished regression job.
    - `matched` = references whose comparison score is 1.
    - `total` = references.
    - `at` = the newest finished regression job's `updatedAt`.
- **Header:** "Document types" + "What each PDF looks like and what to extract. Published versions are immutable; edit a draft." Actions: **Import YAML** and **New document type**. Each opens a `role="dialog"` that's `aria-modal` and labelled. Escape and Cancel close it, and focus returns to the opener.
- **Card** (an `article` labelled by its name):
  - **Header:** icon, name (H2), id in mono.
  - **Pills:** "Published vN" (ok) or "Not published" (neutral), plus "Draft vN" (info) when there's a draft.
  - **Shape line:** "5 sections · 9 fields · 1 table", pluralised.
  - **Quality line**, the first that applies:
    1. Draft issues > 0: "Draft vN has k validation issue(s)" (amber).
    2. Last regression: "x of n references match (vN)" (ok when x = n, else amber).
    3. No references: "No reference documents yet" (muted).
    4. Otherwise: "n reference(s) · no regression run yet" (muted).
- **Card actions:**
  - **Primary:** **Edit draft vN** (link to `#/templates/<id>/<draft>`), or **New draft from vN** (`newDraft`, then navigate) when there's no draft.
  - **Test run:** a file picker that calls `testRun(file, id, draft ?? published)` and then shows "Test run queued — see Jobs" as a status, or the error.
  - **Export YAML:** an icon link (`exportUrl(id, draft ?? published)`, `aria-label="Export <name> YAML"`).
  - **Published version link:** "Published vN" also links to the read-only published version.
- **Grid:** `repeat(auto-fit, minmax(min(340px, 100%), 1fr))`.
- **Top-bar search:** still filters the cards (PR 1 behaviour).

## Review Focus

1. **A type with only a published version and no draft.** It shows New draft from vN and no draft issues line. Test in Task 3.
2. **A malformed draft definition** (no outputs, or sections not an array). The summary counts 0 instead of failing the whole list. Test in Task 1.
3. **A regression report whose reading fails** (store unreachable). The summary's `lastRegression` is null for that type and the list still returns. Test in Task 1.
4. **The Test run file picker cancelled, or a non-PDF chosen.** Nothing is sent. Test in Task 3.
5. **A dialog closed with Escape.** Focus returns to the button that opened it, and the typed values are kept until the page changes (not required to clear). Test in Task 2.

---

### Task 1: API summary on GET /api/templates

**Files:**
- Create: `apps/api/src/regression/report.ts` (moved from the route: `regressionReport(app, templateId, version)`)
- Modify: `apps/api/src/routes/references.ts` (uses the helper), `apps/api/src/routes/templates.ts` (adds the summary), `apps/web/src/api/client.ts` (the `TemplateListItem.summary` type) and the `fakeApi` fixtures
- Test: `apps/api/test/templates.test.ts`, `apps/api/test/regression.test.ts` (the existing regression route tests stay green)

- [ ] **Step 1: Write the failing tests** in `templates.test.ts`:
  - `summarises each type: shape, references, draft issues, last regression`. Use the existing helpers that create a type, publish it, save a reference and finish a regression job. Adapt them from `regression.test.ts` and `references.test.ts`.
  - `counts 0 for a malformed draft instead of failing`, with a draft definition of `{ id, version, name }` only.
  - `leaves lastRegression null when the regression documents can't be read`, using `UnreachableStore` as `store`.
- [ ] **Step 2: Run it.** Expected: FAIL (there's no `summary` yet).
- [ ] **Step 3: Implement**
  - **The helper:** move the report computation into `regressionReport`, unchanged in behaviour, and call it from the route.
  - **The summary** in `/templates`: for each type, use `latest = draft ?? published`.
    - **Counts:** `const d = latest.definition as Partial<…>`; take array lengths, defaulting to 0 when a value isn't an array.
    - **References:** `(await repo.listReferences(id)).length`.
    - **`draftIssues`:** `draft ? validateTemplate(draft.definition).length : null`.
    - **`lastRegression`:** wrap the report in try/catch, falling back to null.
      - Take the jobs from `listRegressionJobs(id, latest.version)`. If none has finished (`succeeded` or `awaiting_review`), the value is null.
      - Otherwise `{ version: latest.version, matched: items.filter(i => i.comparison?.score === 1).length, total: report.summary.references, at: max(updatedAt of the finished jobs) }`.
- [ ] **Step 4: Run it.** Run `npx vitest run --project api`. Expected: PASS, including the access sweep.
- [ ] **Step 5: Commit.** `git commit -m "API: document type list carries a summary (shape, references, draft issues, last regression)"`

### Task 2: Dialog primitive

**Files:**
- Create: `apps/web/src/ui/Dialog.tsx`
- Test: `apps/web/test/ui.test.tsx`

- [ ] **Step 1: Write the failing test.** Render a button that opens `<Dialog title="New document type" onClose>` containing an input.
  - The dialog has role `dialog`, is named "New document type", and has `aria-modal="true"`.
  - The first input is focused.
  - Escape calls `onClose`.
  - A Cancel button inside calls `onClose`.
  - The opener is focused again after close. The parent keeps an opener ref, and the Dialog restores focus to `document.activeElement` as it was at mount.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The structure: an overlay (`div.dialog-backdrop`) containing `div role=dialog aria-modal aria-labelledby` with an H2.
  - On mount, remember `document.activeElement`, then focus the first focusable element.
  - On unmount, restore focus.
  - Escape (keydown on the dialog) calls `onClose`.
  - A click on the backdrop calls `onClose`.
  - Focus stays inside: Tab from the last focusable element wraps to the first.
- [ ] **Step 4: Run it.** Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Web: Dialog primitive (modal, labelled, Escape, focus return)"`

### Task 3: Cards and dialogs

**Files:**
- Create: `apps/web/src/templates/TemplateCard.tsx`, `apps/web/src/templates/quality.ts`
- Modify: `apps/web/src/templates/TemplatesPage.tsx`
- Test: `apps/web/test/TemplatesPage.test.tsx` (rewritten: the old table and inline forms are gone, deliberately), `apps/web/test/template-quality.test.ts`

- [ ] **Step 1: Write the failing tests**
  - **`template-quality.test.ts`** is a table test of `qualityLine(item)`, returning `{ text, tone: 'ok' | 'warn' | 'muted' }`, for the four rules plus pluralisation. Also `shapeLine(summary)`: "1 section · 1 field · 0 tables", "5 sections · 9 fields · 1 table".
  - **`TemplatesPage.test.tsx`:**
    - **Header:** an h1 "Document types" and the description.
    - **Cards:** an `article` for each type, named after the type.
      - Pills: "Published v3" links to `#/templates/pvp/3`; "Draft v4".
      - The shape line and the quality line.
      - "Edit draft v4" links to `#/templates/pvp/4`.
      - An Export link named "Export Process Validation Protocol YAML", whose `href` is `exportUrl(pvp, 4)`.
    - **Published-only type:** a "New draft from v2" button calls `newDraft('coa', 2)`, then `onNavigate('#/templates/coa/<new version>')`.
    - **Test run:** uploading a PDF via the card's "Test run" file input (labelled "Test run <name> with a PDF") calls `testRun(file, 'pvp', 4)` and shows "Test run queued — see Jobs".
      - Choosing nothing sends nothing.
      - A non-PDF dropped via `fireEvent.change` with a txt file isn't sent and shows "Choose a PDF".
    - **New document type dialog:** the button opens a dialog with Id and Name fields. Create calls `createTemplate` and navigates, as the old test did.
    - **Import YAML dialog:** the button opens a dialog with "Template YAML" and "Publish if valid". Import calls `importTemplate(yaml, true)`, as the old test did.
    - **Search:** the top-bar query still filters cards; the existing AppShell test is updated to look for an article name.
- [ ] **Step 2: Run it.** Expected: FAIL.
- [ ] **Step 3: Implement**
  - **`quality.ts`:** `shapeLine`, `qualityLine` and a `plural(n, word)` helper.
  - **`TemplateCard`:** as specified above. The Test run input is visually hidden behind a button-styled label.
  - **`TemplatesPage`:** the header, actions, grid and the two dialogs.
- [ ] **Step 4: Run it.** Run `npx vitest run --project web`. Expected: PASS.
- [ ] **Step 5: Commit.** `git commit -m "Web: document type cards (versions, shape, quality, quick actions) and dialogs"`

### Task 4: Styles and visual check

- [ ] **Step 1: CSS.**
  - `.type-grid`: the grid columns from the Global Constraints.
  - `.type-card`: surface, 12 px radius, 20 px padding, flex column.
  - `.type-card .pills`.
  - `.shape-line`, muted.
  - `.quality.tone-*` text colours.
  - `.card-actions`.
  - `.dialog-backdrop`: fixed, a dark translucent overlay.
  - `[role=dialog]`: a surface card, 480 px wide, with a max-height and its own scroll.
- [ ] **Step 2: Visual check** against `04-document-types.png`, in light and dark at 1440 px and 390 px. Use screenshots where the pane renders, otherwise DOM geometry. Extend the mock API's `/api/templates` with `summary`.
- [ ] **Step 3: Full check.** Run `npm run check` (worker via `python -m uv`) and `format:check`.
- [ ] **Step 4: Commit.** `git commit -m "Web: Document types styles"`
