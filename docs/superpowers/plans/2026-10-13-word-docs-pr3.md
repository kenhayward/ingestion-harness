# Word documents PR 3: the web accepts Word documents

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every upload input in the web app takes `.docx` as well as PDF; labels say "PDF or
Word"; jobs and results whose document is a Word file offer "Download original (.docx)" instead
of "Open PDF"; the page hints say that pages of a Word document are those of its converted PDF.

**Architecture:**
- **One module for the rule:** `apps/web/src/documents.ts` exports `SOURCE_ACCEPT` (the `accept`
  attribute), `isSourceFile(file)` (by type or extension) and `isWordDocument(contentType)`.
- **Callers:** the three copies of `isPdf` (`UploadStrip`, `TemplateCard`, `TestRail`) and
  `SamplesTab` use it.
- **Links:** they read `contentType` from `JobSummary` and `ResultSummary` (PR 2).

**Tech Stack:** React 19, Testing Library, Vitest.

**Spec:** [docs/design/word-documents.md](../../design/word-documents.md) (PRs 1–2 merged).

## Global Constraints

- **`accept`:**
  `application/pdf,.pdf,.docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document`.
- **The client-side filter is a convenience;** the API's `checkSource` decides. A file is
  offered when its type is PDF or DOCX, or its name ends `.pdf` or `.docx` (any case).
- **Labels:**
  - Top bar: "Upload document".
  - Upload strip:
    - Input: "PDF or Word files".
    - Drop target: "Drop PDF or Word files here".
    - Skipped file: "Not a PDF or Word document".
  - Template card: input "Test run {name} with a PDF or Word document"; wrong file "Choose a
    PDF or Word document".
  - Test rail: input "Sample document"; drop target "Drop a sample PDF or Word document".
  - Samples tab: "Add sample documents".
  - Overview next action: "Next: add sample documents" (`packages/shared/src/overview.ts`).
- **Word document links:**
  - Job actions and job detail: "Download original (.docx)". It is the same `documentUrl` (the
    API serves an attachment), with no `target=_blank`.
  - Results row: aria-label "Download original of {filename}", title "Download original
    (.docx)".
  - PDFs keep "Open PDF" and "View PDF".

## Review Focus

1. A file named `REPORT.DOCX` with an empty browser type is offered (Windows often sends no type
   for .docx); a `.doc` or `.docm` is skipped client-side.
2. A Word job's link must not open a blank tab that downloads; it downloads in place.
3. Existing PDF flows keep their labels: "Open PDF" and "View PDF".

---

### Task 1: `documents.ts` and the upload inputs

- [ ] **Step 1:** Write the failing tests:
  - `test/documents.test.ts`: a table for `isSourceFile` (PDF by type, by name; DOCX by type, by
    upper-case name with no type; `.doc`, `.docm`, `.txt` refused) and `isWordDocument`.
  - Change the existing label assertions in `AppShell`, `SamplesTab`, `TemplateEditor` (test
    rail) and `ProjectPage` to the new labels (a deliberate rename).
  - Add one case per input that a `.docx` is accepted (UploadStrip lists it Ready; TemplateCard
    and TestRail call `uploadDocument`; SamplesTab calls `uploadSample`).
- [ ] **Step 2:** Implement `documents.ts`, then switch each input to it and rename the labels.
  Expect green, then commit.

### Task 2: links, page hints, copy

- [ ] **Step 1:** Write the failing tests:
  - A Word job in `JobList` / `JobDetailPanel` shows "Download original (.docx)", linked to the
    document URL with no `target`, and no "Open PDF".
  - A Word result row shows "Download original of report.docx".
- [ ] **Step 2:** Implement. Then update the copy: `JobsPage` intro, `TemplatesPage` intro,
  `WorkbenchPage` intro, the `ExportPanel` text, the `index.html` description, the
  `TemplateEditor` copies hint and page-count hint ("a Word document counts the pages of its
  converted PDF"), and `SectionsTab`'s "Several copies in one document".
- [ ] **Step 3:** Update the design status (implemented, PRs 1–3), run `npm run check`, push,
  open the PR, and turn on auto-fix and auto-merge.
