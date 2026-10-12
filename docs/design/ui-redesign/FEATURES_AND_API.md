# New features and the API calls they need

Baseline: the `Api` port in `apps/web/src/api/client.ts` as of this handoff. Each feature is
tagged:

- **Client only** — existing calls are enough; pure UI/derived state.
- **API change** — new endpoint, param or DTO field (update `packages/shared` Zod + API route +
  `fakeApi()`; Python side too where the contract table in CLAUDE.md says so).
- **Worker change** — the worker must record new data (and usually a forward-only migration).

## Summary

| # | Feature | Screen | Type | Calls |
| --- | --- | --- | --- | --- |
| 1 | Light / Dark / System theme switch, persisted | Shell, Sign in | Client only | — (`localStorage` `ih.theme`) |
| 2 | User chip + sign out | Shell | Client only | `me()`, `logout()` |
| 3 | "Needs attention" nav badge + Jobs filter chips with counts | Shell, Jobs | Client only | `listJobs()` (already polled) |
| 4 | Live/reconnecting indicator | Jobs | Client only | `listJobs()` poll result |
| 5 | Multi-file upload with per-file status | Jobs | Client only | `upload()` × n |
| 6 | One primary action per status + ⋯ menu | Jobs | Client only | `retryJob`, `cancelJob`, `deleteJob` |
| 7 | Job detail panel (meta, outputs, actions) | Jobs | Client only | `getJob(id)` (outputs + rowCount) |
| 8 | Pipeline progress list (status-derived) | Jobs | Client only (v1) | `getStepRuns(id)` for extract steps |
| 9 | Live progress text ("Step 3 of 5 · extracting results table") | Jobs | **API + Worker** (phase 2) | see A1 |
| 10 | Next document in review queue | Review | Client only | `listJobs()` filtered `awaiting_review` |
| 11 | Next flagged value | Review | Client only | `getReview()` → `effectiveView` flags |
| 12 | Click value → jump to its page | Review | Client only | `getReview()` page numbers, `pageUrl()` |
| 13 | Evidence highlight box on the page image | Review | **API + Worker** (phase 2) | see A2 |
| 14 | Reject with inline required reason | Review | Client only | `reject()` |
| 15 | Per-row CSV/JSON downloads | Results | **API change** | see A3 |
| 16 | Filename filter | Results | **API change** | see A4 |
| 17 | Result preview panel | Results | Client only | `getResult()`, `getOutputText()` |
| 18 | Document type cards (shape + quality line) | Document types | **API change** | see A5 |
| 19 | Card "Test run" | Document types | Client only | `testRun(file, id, version)` |
| 20 | Unsaved indicator, Publish disabled with reason | Editor | Client only | — |
| 21 | Pipeline step cards (collapse/expand, reorder) | Editor | Client only | `saveTemplate()` |
| 22 | Test rail: recent test runs | Editor | Client only (v1) | `listJobs()` filtered `test && specId===id` |
| 23 | Test rail: "Run test on <last sample>" | Editor | **API change** (phase 2) | see A6 |
| 24 | Quality tab restyle | Editor | Client only | `getMetrics`, `diffVersions`, `listReferences`, `runRegression`, `getRegression` |
| 25 | Token expiry presets as one-click buttons | Access | Client only | `createToken(label, days)` |
| 26 | Token status filter chips, expiring-soon highlight (≤ 7 days) | Access | Client only | `listTokens()` (`expiresAt`, `status`) |
| 27 | Show/hide token on sign-in | Sign in | Client only | `login()` |
| 28 | Global search (Ctrl K) | Shell | Client only (v1) / **API** (phase 2) | see A7 |

Everything else (routes, review edits, re-run, approve, references, import/export, cleanup)
is restyling of existing behaviour with no API change.

## API additions

### A3 — `ResultSummary.outputs` (needed for #15, phase 1)

Today `ResultSummary` has `outputCount` only, so a row can't link to its files without a
`getResult()` call per row.

```ts
// packages/shared — ResultSummary
outputs: { outputId: string; format: 'csv' | 'json'; name: string; rowCount: number | null }[];
```

`GET /api/results` includes it (join published outputs). Web: links via
`api.outputUrl(jobId, outputId, { stage: 'published' })`. Keep `outputCount` for compatibility.

### A4 — filename filter on results (#16, phase 1)

```
GET /api/results?templateId=&q=<substring>&before=&beforeId=
```

`q`: case-insensitive filename substring (`ILIKE '%' || $q || '%'`, escaped), max 100 chars,
validated by Zod. Client: `listResults({ templateId, q, before, beforeId })`, debounce 250 ms.

### A5 — summary on `GET /api/templates` (#18, phase 1)

Avoids N+1 `getTemplate` / `getRegression` calls for the card grid.

```ts
// TemplateListItem
summary: {
  sections: number; fields: number; tables: number;     // from the latest version shown on the card (draft ?? published)
  references: number;
  draftIssues: number | null;                           // validation issues of the draft, null when no draft
  lastRegression: { version: number; matched: number; total: number; at: string } | null;
};
```

### A1 — job progress (#9, phase 2; API + worker + migration)

```sql
-- db/migrations/NNNN_job_progress.sql
ALTER TABLE jobs ADD COLUMN progress jsonb;
```

```ts
// JobSummary (packages/shared/src/jobs.ts) + queue.py
progress: {
  stage: 'ocr' | 'sections' | 'extract' | 'validate' | 'review' | 'publish';
  step: number | null; steps: number | null;  // extract step index / count
  stepId: string | null;
  page: number | null; pages: number | null;  // OCR / chunk progress
} | null;
```

Worker writes it at each stage transition (guarded `AND status='running'` like other writes).
Until then the UI derives the progress list from `status` + `getStepRuns()`.

### A2 — evidence bounding boxes (#13, phase 2; worker + API)

`ReviewData` values carry `page` and `evidence` today. Add an optional normalized box:

```ts
bbox?: { page: number; x: number; y: number; w: number; h: number } // 0–1 of page width/height
```

Worker: for text-layer pages, locate the evidence string with pypdfium2 text search
(`textpage.search`) and store the char boxes' union; for OCR'd pages, leave `bbox` unset
(olmOCR returns no geometry) — the UI falls back to page jump only. Cache with the OCR cache key.

### A6 — re-run a test on a stored sample (#23, phase 2)

```
POST /api/templates/:id/:version/test-runs   { documentId: string }   → JobSummary
```

Re-uses an already-uploaded document (no re-upload). The rail's primary button uses the most
recent test run's `documentId`.

### A7 — global search (#28)

Phase 1: the search box filters the current screen's list client-side.
Phase 2:

```
GET /api/search?q=<text>&limit=10
→ { jobs: JobSummary[]; results: ResultSummary[]; templates: TemplateListItem[] }
```

Opens a Ctrl/Cmd+K popover grouped by type; Enter opens the first hit.

## Derived client logic (put in pure, table-tested functions)

| Function | Input → output |
| --- | --- |
| `statusGroup(status)` | → `attention` (awaiting_review, needs_review, failed) / `active` (queued, running) / `done` |
| `statusTone(status)` | → neutral / info / warn / alert / danger / ok |
| `primaryAction(job)` | → `review` / `view` / `retry` / `cancel` / null |
| `progressSteps(job, stepRuns)` | → 5 entries `{label, state: done/current/wait/fail/todo}` |
| `nextAwaitingReview(jobs, currentId)` | → job id or null (createdAt order, wraps) |
| `nextFlagged(view, cursor)` | → `{tab, field?, row?, column?}` |
| `expiresSoon(token, now, days = 7)` | → boolean |
| `themeAttr(pref)` | `light`/`dark` → that; `system` → remove attribute |
