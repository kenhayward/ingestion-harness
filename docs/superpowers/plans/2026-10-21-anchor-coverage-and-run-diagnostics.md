# Anchor coverage, recipe checks and run diagnostics: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Catch what made the long stability recipe slow and wrong (repeating-section anchors that
miss headings, many steps re-reading one repeating section, values that do not fit their column
type, a check that could never match) automatically, and hand what test runs observed to the
revise stage as proposals.

**Architecture:** Three parts, each shippable alone (one PR each, in order). **A** adds a
deterministic *anchor coverage* rule (`segment.missed_keys`) used by the anchor preview grid, the
sections stage's anchor round and every job's `segmented` event. **B** fixes the check engine (list
references, dash folding) and adds editor warnings plus drafting guidance. **C** records how many
occurrence calls came back empty, builds `RunDiagnostics` in the API from the latest dev test runs
of the open draft, and sends them to revise next to feedback and evaluation failures.

**Tech Stack:** Python 3.14 worker (pytest, mypy --strict, ruff), TypeScript (Zod, Fastify,
React, vitest), no migrations.

**Spec:** [docs/design/long-recipe-speed.md](../../design/long-recipe-speed.md), "Stopping it
happening again", and the conversation's diagnosis of job `c6bc2ce4…` (30 of 60 titles matched,
1,610 of 1,800 occurrence calls empty, `<0.05` in decimal columns, a list-field check reference).

## Global Constraints

- Red first: every behaviour change starts with a failing test (CLAUDE.md, TDD).
- Cross-language contracts change on both sides in the same PR; update the CLAUDE.md contract rows
  named in each task.
- No real LLM calls in tests; worker tests use `FakeProvider`/`FakeQueue`, API tests `MemoryRepo`.
- Holdout rule: diagnostics come only from **dev** samples' runs; holdout runs are never read.
- Advisory only: nothing in Part A or C changes a job's status or sends one to review.
- Optional fields stay absent when empty, so older grids, events and recipes parse and hash as
  before; `tests/test_equivalence.py` goldens change only where a scenario has a repeating section
  (Task C1), rewritten deliberately with `IH_UPDATE_GOLDEN=1`.
- New user-facing text says *recipe*, not template; help changes go in the existing topics.
- Done = `npm run check` and `npm run worker:lint` + `npm run worker:test` green.

## Review Focus

1. A key that only the table of contents lists (the body table is missing) is reported as missed: the rule cannot tell, and saying so is right. Test in Task A1.
2. Several repeating sections sharing one key pattern (the five kind sections of Fix A) are judged together, so one kind's keys are never "missed" by another. Test in Task A1.
3. A key pattern that is not anchored to a line start (`(\d+)`) is skipped instead of flooding the grid with every number. Test in Task A1.
4. A step served from the step cache made no calls and must never be flagged as mostly empty. Test in Task C2.
5. Diagnostics from runs of an older draft (before its latest save) are not sent: they describe a recipe that no longer exists. Test in Task C3.

---

## Part A: anchor coverage

### Task A1: `missed_keys` in segmentation

**Files:**
- Modify: `worker/src/ingest_worker/segment.py` (after `key_issues`)
- Test: `worker/tests/test_segment_coverage.py` (new)

**Interfaces:**
- Produces:
  - `@dataclass(frozen=True) class MissedKey: sections: tuple[str, ...]; key: str; line: str`
  - `def missed_keys(text: str, sections: list[Section], spans: list[SectionSpan]) -> list[MissedKey]`
  - `MAX_MISSED_KEYS = 20` (callers cap what they show; the function returns all)

Rule: group the repeating sections that have their own `key` by the exact key pattern. Skip a
group whose pattern is not line-anchored (after optional inline flags such as `(?i)`, it must
start with `^`). Candidates are the distinct key values the pattern finds anywhere in `text`
(`re.finditer`, MULTILINE, value read as `occurrence_key` reads it: named group `key`, else group
1, else the match). Covered keys are the `key`s of the group's spans. Return the candidates not
covered, in document order of their **last** match (the body title, not the contents entry), with
`line` = the stripped line of that last match, cut at 120 characters. A group whose spans cover no
key returns nothing (the anchor-matched-nothing problem is reported elsewhere). Sections with only
`keyFrom` are not in any group.

- [ ] **Step 1: Write the failing tests** (parametrised)
  - `test_wrapped_titles_are_missed`: text with a contents list (`Table 1: Study A ... HDPE`,
    `bottle - X Results.....25`) and body titles where Tables 1 and 3 wrap `Results` onto the
    next line and Table 2 does not; section anchor `^\s*Table\s+\d+:\s.*Results\s*$`, key
    `^\s*Table\s+(\d+):` → `[MissedKey(("result_tables",), "1", "Table 1: Study A …"), MissedKey(…, "3", …)]`, and each `line` is the body title line, not the contents one.
  - `test_shared_key_pattern_is_one_group`: two sections `kind_a`, `kind_b` with the same key,
    together covering 1-4 → `[]`; drop the anchor match of 4 → one MissedKey with
    `sections == ("kind_a", "kind_b")`, `key == "4"`.
  - `test_listed_only_in_contents_is_missed`: Table 5 only in the contents list → missed `"5"`.
  - `test_unanchored_key_is_skipped`: key `(\d+)` → `[]`.
  - `test_keyfrom_only_and_unmatched_groups_report_nothing`.
- [ ] **Step 2: Run** `cd worker && uv run pytest tests/test_segment_coverage.py -v` → FAIL (`missed_keys` not defined).
- [ ] **Step 3: Implement `missed_keys`** in `segment.py` as specified.
- [ ] **Step 4: Run** the same command → PASS; `uv run pytest tests/test_segment.py tests/test_segment_repeat.py` still pass.
- [ ] **Step 5: Commit** `feat(worker): missed_keys reports repeating-section keys no anchor caught`

### Task A2: missed keys in the anchor preview grid (both sides)

**Files:**
- Modify: `worker/src/ingest_worker/workbench.py:183-317` (`segment_samples`)
- Modify: `packages/shared/src/workbench.ts:220-231` (`SegmentedSampleSchema`)
- Test: `worker/tests/test_workbench_segment.py`, `packages/shared/test/workbench.test.ts`

**Interfaces:**
- Consumes: `missed_keys`, `MAX_MISSED_KEYS` (Task A1).
- Produces: grid row key `missedKeys: [{sections: string[], key: string, line: string}]`, present
  only when non-empty, at most `MAX_MISSED_KEYS`; plus `missedKeysTotal: number` when capped.
  TS: `MissedKeySchema`, `SegmentedSampleSchema.missedKeys` and `.missedKeysTotal` optional.

- [ ] **Step 1: Failing tests:** `test_grid_reports_missed_keys` (the A1 wrapped-title text as one prepared sample: row `missedKeys == [{"sections": ["result_tables"], "key": "1", "line": …}, …]`), `test_grid_omits_missed_keys_when_covered` (key absent), `test_grid_caps_missed_keys` (25 misses → 20 rows, `missedKeysTotal == 25`); TS: the schema parses a row with and without `missedKeys`.
- [ ] **Step 2: Run** `uv run pytest tests/test_workbench_segment.py -k missed` and `npx vitest run packages/shared/test/workbench.test.ts` → FAIL.
- [ ] **Step 3: Implement:** call `missed_keys(text, valid, spans)` per sample in `segment_samples` (inside the capped child, like the suggestions); add the schema fields.
- [ ] **Step 4: Run** both → PASS.
- [ ] **Step 5:** Update the CLAUDE.md row *Workbench prepared text and segmentation* (`SegmentedSample.missedKeys`, `segment.missed_keys`). Commit `feat: anchor preview grid lists keys no anchor caught`.

### Task A3: the sections stage feeds missed keys back

**Files:**
- Modify: `worker/src/ingest_worker/drafting.py:796-843` (`anchor_check`), next to `repeated_blocks`
- Test: `worker/tests/test_drafting.py`

**Interfaces:**
- Produces: `def missed_key_feedback(rows: list[dict[str, Any]], put_ids: set[str], names: dict[str, str]) -> list[str]`

One line per sample and group whose sections include a proposed (`put_ids`) section, worded:
`sections "a", "b" have key ^\s*Table\s+(\d+):, which finds keys 1, 2, 3, 9 (and 26 more) in <file> that no anchor matched, e.g. "Table 1: Study…". An anchor must match every heading of its kind: headings may wrap over several lines, so look ahead across them (for example (?=(?:(?!Header)[\s\S]){0,400}?Results[ \t]*$)) rather than requiring the whole title on one line; keep contents entries out.` (at most 10 keys named, then `(and N more)`).

- [ ] **Step 1: Failing test** `test_anchor_check_feeds_back_missed_keys`: a sections proposal with the narrow anchor over the A1 text → `misses` contains a line starting `sections "result_tables" have key` naming `1, 3`; with a covering anchor → no such line.
- [ ] **Step 2: Run** `uv run pytest tests/test_drafting.py -k missed_keys` → FAIL.
- [ ] **Step 3: Implement** `missed_key_feedback` and append it in `anchor_check` after `repeated_blocks`.
- [ ] **Step 4: Run** → PASS; the whole `tests/test_drafting.py` passes.
- [ ] **Step 5: Commit** `feat(worker): sections stage gets missed headings as anchor feedback`

### Task A4: the Sections tab shows missed headings

**Files:**
- Modify: `apps/web/src/workbench/SegmentationGrid.tsx`, `apps/web/src/workbench/segmentation.ts`
- Modify: `apps/web/src/help/SectionsHelp.tsx` (one paragraph: what *Missed headings* means and the look-ahead fix)
- Test: `apps/web/test/SegmentationGrid.test.tsx`, `apps/web/test/segmentation.test.ts`

**Interfaces:**
- Consumes: `SegmentedSample.missedKeys`, `.missedKeysTotal` (Task A2).
- Produces: `function missedKeysText(row: SegmentedSample): string | null` in `segmentation.ts`:
  `Missed headings: 1, 2, 3, 9 (+26)` (first 10 keys), null when none.

- [ ] **Step 1: Failing tests:** `missedKeysText` table test (none → null; 4 keys → `Missed headings: 1, 2, 3, 9`; capped with total 30 → `… (+26)`); grid test: a row with `missedKeys` renders a warn note with that text, its section chips and the first `line` as `title`-free visible text under the note; a row without renders none.
- [ ] **Step 2: Run** `npx vitest run apps/web/test/segmentation.test.ts apps/web/test/SegmentationGrid.test.tsx` → FAIL.
- [ ] **Step 3: Implement** the helper and the note (existing warn tone; under the sample's row).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): Sections tab shows headings no anchor caught`

### Task A5: missed keys on every job's `segmented` event

**Files:**
- Modify: `worker/src/ingest_worker/pipeline.py:437-453` (`segment_pages`)
- Modify: `worker/src/ingest_worker/segment.py` (`Segmented` gains `missed: list[MissedKey]`, filled in `segment_occurrences`)
- Test: `worker/tests/test_segment_coverage.py`, `worker/tests/test_pipeline.py`

**Interfaces:**
- Produces: `segmented` event data key `missedKeys` (same row shape as A2, capped, plus `missedKeysTotal` when capped), present only when non-empty. TS `JobProgress` ignores it (no schema change).

- [ ] **Step 1: Failing tests:** `test_segment_occurrences_lists_missed` (A1 text → `Segmented.missed` has keys 1 and 3); `test_segmented_event_carries_missed_keys` (a `process` job through `FakeQueue` whose sample text misses a heading → the `segmented` event's data has `missedKeys`; the job's status and reasons are unchanged).
- [ ] **Step 2: Run** `uv run pytest tests/test_segment_coverage.py tests/test_pipeline.py -k missed` → FAIL.
- [ ] **Step 3: Implement** both.
- [ ] **Step 4: Run** → PASS; `uv run pytest tests/test_equivalence.py` passes unchanged (no scenario misses a key).
- [ ] **Step 5: Commit** `feat(worker): segmented event lists missed headings (advisory)`

## Part B: recipe checks

### Task B1: a check's reference can be a list field

**Files:**
- Modify: `worker/src/ingest_worker/checks.py:70-87` (`run_check`)
- Test: `worker/tests/test_checks.py`

Today a reference path ending in `[*]` (a list field: `extract_summary_fields.studies.value[*]`)
leaves `ref_rest` empty, so no reference values are read and every value is `unmatched`. When
`ref_rest` is empty, each selected item is itself a reference value (no aliases).

- [ ] **Step 1: Failing test** `test_list_field_reference`: results `{"summary": {"studies": {"value": ["Study-1", "Study-2"]}}, "t": {"rows": [{"s": "Study-1"}, {"s": "Study-9"}]}}`, check values `t.rows[*].s`, reference `summary.studies.value[*]` → rows `Study-1` `match`, `Study-9` `unmatched`, `Study-2` `unused`.
- [ ] **Step 2: Run** `uv run pytest tests/test_checks.py -k list_field` → FAIL (`Study-1` unmatched).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; whole file passes.
- [ ] **Step 5: Commit** `fix(worker): checks read list-field references`

### Task B2: checks treat dash and space variants as equal

**Files:**
- Modify: `worker/src/ingest_worker/checks.py:66-67` (`norm`)
- Test: `worker/tests/test_checks.py`
- Docs: CLAUDE.md (check steps: "compared ignoring case, spaces and dash variants")

`norm(value)`: NFKC, then map U+2010-U+2015, U+2212 and U+FE63/U+FF0D to `-`, drop all
whitespace (U+00A0 included), upper-case.

- [ ] **Step 1: Failing test** parametrised `test_norm_folds_dashes_and_spaces`: `"Study‑201580"` (U+2011) and `"study-201580"` and `"Study - 201580"` all equal `norm("STUDY-201580")`; `"Study_201580"` does not.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `uv run pytest tests/test_checks.py tests/test_plugins.py` → PASS (check plugins share `norm`).
- [ ] **Step 5: Commit** `fix(worker): checks fold Unicode dashes and spaces`

### Task B3: editor warnings for shared repeating sections and same-shape tables

**Files:**
- Modify: `apps/web/src/templates/checks.ts` (`templateChecks`)
- Test: `apps/web/test/template-checks.test.ts`

**Interfaces:**
- Produces (exported for the test): `function sharedRepeatSteps(definition: Record<string, unknown>): { section: string; steps: string[] }[]` (table steps, extract or plugin, reading the same repeating section, 3 or more) and `function sameShapeTables(definition: Record<string, unknown>): string[][]` (groups of 3 or more tables with the same column ids in order).

Warnings (tone `warn`, never blocking):
- `{n} steps read the repeating section {id}: each runs once per occurrence, so a step meant for one block reads them all. Give each kind of block its own repeating section.` → link Sections, sub-tabs `sections`, `pipeline`.
- `{n} tables have the same columns ({first}, …): one table with columns telling them apart (study, batch) is usually better.` → link Outputs, sub-tab `outputs`.

- [ ] **Step 1: Failing tests:** 60 table steps on `result_tables` → one shared-repeat warning naming 60; 2 steps → none; Fix A's five sections → none; 60 tables of 5 shapes → 5 same-shape warnings; 2 same-shape tables → none.
- [ ] **Step 2: Run** `npx vitest run apps/web/test/template-checks.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(web): recipe checks warn about shared repeating sections and same-shape tables`

### Task B4: drafting guidance

**Files:**
- Modify: `worker/src/ingest_worker/draft_stages.py` (`OUTPUTS`, `STEPS` instructions)
- Test: `worker/tests/test_draft_stages.py`

Add to OUTPUTS: `When the document repeats tables of the same shape (per study, batch or item), propose one table per shape with columns telling the blocks apart, not one table per printed block.` Add to STEPS: `A table step reading a repeating section runs once per occurrence. Never write several steps that each want one occurrence of the same repeating section: one step per section, and one repeating section per kind of block.`

- [ ] **Step 1: Failing test** `test_stage_guidance` asserts both sentences are in `OUTPUTS.instructions` / `STEPS.instructions`.
- [ ] **Step 2-4:** run → FAIL, add the text, run → PASS.
- [ ] **Step 5: Commit** `feat(worker): drafting guidance for repeated blocks`

## Part C: run diagnostics to revise

### Task C1: record empty occurrence calls

**Files:**
- Modify: `worker/src/ingest_worker/extract.py:30-37` (`ExtractionResult`)
- Modify: `worker/src/ingest_worker/pipeline.py:724-…` (`run_step_extraction`)
- Modify: `worker/src/ingest_worker/template_pipeline.py:570-679` (`run_step`, its `extracted` event)
- Test: `worker/tests/test_template_pipeline.py`; goldens `worker/tests/fixtures/equivalence/*` rewritten

**Interfaces:**
- Produces: `ExtractionResult.call_rows: tuple[int, ...] = ()` (rows each model call returned, in call order; empty for a cache hit and for non-table steps); the `extracted <step>` / `re-ran <step>` event data gains `calls` and `emptyCalls` **only for a step reading a repeating section** (`repeat` plan present).

- [ ] **Step 1: Failing test** `test_extracted_event_counts_empty_occurrences`: a table step on a repeating section with 3 occurrences whose `FakeProvider` replies `{"rows": []}`, `{"rows": [r]}`, `{"rows": []}` → event data `calls == 3`, `emptyCalls == 2`; a step on a plain section → neither key.
- [ ] **Step 2: Run** `uv run pytest tests/test_template_pipeline.py -k empty_occurrences` → FAIL.
- [ ] **Step 3: Implement**; then `IH_UPDATE_GOLDEN=1 uv run pytest tests/test_equivalence.py` and review that only repeating-step `extracted` events changed.
- [ ] **Step 4: Run** `npm run worker:test` → PASS.
- [ ] **Step 5: Commit** `feat(worker): extracted events count empty occurrence calls`

### Task C2: `RunDiagnostics` (shared, pure)

**Files:**
- Create: `packages/shared/src/run-diagnostics.ts` (export from `packages/shared/src/index.ts`)
- Test: `packages/shared/test/run-diagnostics.test.ts`

**Interfaces:**
- Produces:
  - `DiagnosticRunSchema`/`DiagnosticRun`: `{ jobId, sample (file name), events: {message, data}[], stepRuns: {stepId, startedAt, finishedAt, cached}[], issues: {step, target, column, raw}[] }`
  - `RunDiagnosticsSchema`/`RunDiagnostics`: `{ from: { draftVersion: number; jobIds: string[]; at: string }, steps: { step, sample, calls, emptyCalls, seconds }[], columns: { step, target, column, issues, examples: string[] }[], missedKeys: { sample, sections: string[], keys: string[], total: number }[] }`
  - `function runDiagnostics(runs: DiagnosticRun[], draftVersion: number): RunDiagnostics | null` (null when nothing is flagged)
  - `function diagnosticsCount(d: RunDiagnostics | null): number` (flagged rows)
  - constants `MIN_FLAGGED_CALLS = 4`, `EMPTY_SHARE = 0.5`, `MAX_EXAMPLES = 3`, `MAX_DIAGNOSTIC_ROWS = 20`

Flag a step when `calls >= MIN_FLAGGED_CALLS` and `emptyCalls / calls >= EMPTY_SHARE` (from the
`extracted`/`re-ran` events; `seconds` from its step run; cached runs never flagged). Columns: one
row per (step, target, column) with normalisation issues, `examples` = up to 3 distinct `raw`.
Missed keys: from each run's `segmented` event. Each list sorted worst first, capped at 20.

- [ ] **Step 1: Failing tests:** the c6bc2ce4 shape (60 steps, 30 calls, mostly empty) → flagged; 3 calls all empty → not flagged; a cached run → not flagged (Review Focus 4); 28 issues over 6 columns → 6 rows with ≤3 examples; nothing flagged → `null`.
- [ ] **Step 2: Run** `npx vitest run packages/shared/test/run-diagnostics.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(shared): run diagnostics from test runs`

### Task C3: the API gathers diagnostics for revise and its preview

**Files:**
- Create: `apps/api/src/workbench/diagnostics.ts`
- Modify: `apps/api/src/routes/workbench.ts:2490-2550` (`reviseInputs`), the revise start's 409 (around `add feedback before asking for a revision`), the preview route (around 2690-2730)
- Modify: `packages/shared/src/evaluation.ts:415` (`RevisePreviewSchema.diagnostics: RunDiagnosticsSchema.nullable()`)
- Test: `apps/api/test/workbench-revise.test.ts`

**Interfaces:**
- Consumes: `runDiagnostics`, `diagnosticsCount` (C2).
- Produces: `async function draftDiagnostics(app: FastifyInstance, projectId: string, draft: TemplateRecord, dev: {sampleId: string; filename: string}[]): Promise<RunDiagnostics | null>`; `reviseInputs(...).params.diagnostics?: RunDiagnostics` (absent when null).

Runs read: per ready **dev** sample, the newest `process` test job of the project at the open
draft's version, `awaiting_review` or `succeeded`, created at or after the draft's `updatedAt`.
Issues come from that job's draft `document.json` (the store, as the review route reads it);
events and step runs from the repo. Revise may start with open feedback **or**
`diagnosticsCount > 0`; the 409 becomes `add feedback or run the dev samples before asking for a revision`.

- [ ] **Step 1: Failing tests:** `revise preview carries diagnostics from the latest dev run`; `diagnostics ignore runs from before the draft's last save` (Review Focus 5); `diagnostics never read holdout runs`; `revise starts with diagnostics and no feedback` (202, job params carry `diagnostics`); `revise without feedback or diagnostics is 409` with the new message; the OpenAPI conformance check passes for the preview.
- [ ] **Step 2: Run** `npx vitest run apps/api/test/workbench-revise.test.ts` → FAIL.
- [ ] **Step 3: Implement**; update the startStage route's `description` and 409 text.
- [ ] **Step 4: Run** → PASS; `npm run openapi` regenerates `docs/openapi.json`.
- [ ] **Step 5: Commit** `feat(api): revise gets run diagnostics of the latest dev runs`

### Task C4: the worker sends diagnostics to the model

**Files:**
- Modify: `worker/src/ingest_worker/drafting.py:494-597` (`build_context`, `DraftParams`, the revise call site)
- Modify: `worker/src/ingest_worker/draft_stages.py:816-…` (`REVISE` instructions)
- Test: `worker/tests/test_drafting.py`

**Interfaces:**
- Consumes: job params `diagnostics` (C3's JSON, read as `dict[str, Any] | None`).
- Produces: `DraftParams.diagnostics: dict[str, Any] | None = None`; `build_context(..., diagnostics=...)` adds a `<run_diagnostics draftVersion="N">` block (pretty JSON) after `<evaluation_failures>`.

REVISE instructions gain: `run_diagnostics are what the dev test runs of this draft showed: steps whose occurrence calls mostly returned no rows (give each kind of block its own repeating section, or narrow the anchor), columns whose values did not fit their type (examples given: make the column text or fix its description), and headings no anchor matched (fix the anchor). Fix what they show; reason names the diagnostic.`

- [ ] **Step 1: Failing tests:** `test_context_includes_run_diagnostics` (block present with the version; absent when None); `test_draft_params_accept_diagnostics` (extra=forbid still refuses unknown keys).
- [ ] **Step 2: Run** `uv run pytest tests/test_drafting.py -k diagnostics` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm run worker:lint`.
- [ ] **Step 5:** CLAUDE.md row *Data policy and drafting* (`DraftParams.diagnostics`, `RevisePreview.diagnostics`, `run-diagnostics.ts`). Commit `feat(worker): revise reads run diagnostics`

### Task C5: the Revise tab shows what diagnostics are sent

**Files:**
- Modify: `apps/web/src/workbench/ReviseTab.tsx`, `apps/web/src/workbench/revise.ts`
- Modify: `apps/web/src/help/WorkbenchTabsHelp.tsx` (`wbRevise`: one paragraph on diagnostics)
- Test: `apps/web/test/ReviseTab.test.tsx`, `apps/web/test/revise-derive.test.ts`

**Interfaces:**
- Consumes: `RevisePreview.diagnostics`, `diagnosticsCount`.
- Produces: `function diagnosticLines(d: RunDiagnostics): string[]` in `revise.ts`, e.g. `extract_table_8 on <file>: 29 of 30 calls returned no rows (2 min 49 s)`, `assay_purity_results.impurity_1_pct: 3 values did not fit (e.g. <0.05)`, `<file>: headings 1, 2, 3 (+27) matched no anchor`.

The *What the model will see* card gets a *Run diagnostics* section (between the failures and
*Not sent*) listing `diagnosticLines`; Ask is enabled with feedback **or** diagnostics; without a
run of the current draft the section says `Run the dev samples to add what they show.`

- [ ] **Step 1: Failing tests:** `diagnosticLines` table test; the card lists the lines from a `fakeApi` preview; Ask enabled with diagnostics and no feedback; the empty-state text without diagnostics.
- [ ] **Step 2: Run** `npx vitest run apps/web/test/revise-derive.test.ts apps/web/test/ReviseTab.test.tsx` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS; `npm run check` green.
- [ ] **Step 5: Commit** `feat(web): Revise tab shows the run diagnostics it sends`

### Task C6: docs and the full check

**Files:** `docs/design/long-recipe-speed.md` (mark the guards built), CLAUDE.md rows touched above.

- [ ] **Step 1:** Run `npm run check`, `npm run worker:lint`, `npm run worker:test` → all green.
- [ ] **Step 2:** Commit `docs: anchor coverage and run diagnostics`.
