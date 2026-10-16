# Repeating sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A recipe section can repeat (`repeat: true`, optional `key` regex). Segmentation yields every occurrence; a table step reading a repeating section runs once per occurrence and can have the worker fill one column (`keyColumn`) with the occurrence key, so `covalidation` (3 batches × 5 tables) extracts every batch's rows with the right batch number.

**Architecture:** `section_spans` gains occurrences (`SectionSpan.index`/`key`), `segment_occurrences` returns per-occurrence text next to today's per-section text, `Prepared.occurrences` carries it to `template_pipeline`, which passes a `RepeatPlan` to `run_step_extraction`; that plans occurrences × chunks, renders an `occurrence` block in the built-in prompt, strips `keyColumn` from each call's schema and sets it on the rows before merging. The preview grid reports occurrences and repeated matches; drafting stages and the editors learn the three keys. No migration.

**Tech Stack:** Python 3.13 worker (pydantic, jinja2), Zod shared package, Fastify API (no route changes), React web (Testing Library), Vitest, pytest.

**Spec:** `docs/superpowers/specs/2026-10-16-repeating-sections-design.md`

## Global Constraints

- New keys: `Section.repeat` (bool), `Section.key` (regex, needs `repeat`), `ExtractStep.keyColumn` (column id). TS: `.optional()` with **no `.default`** (a parsed definition must not gain `repeat: false`); Python: `repeat: bool = False`, `key: str | None = None`, `key_column: str | None = Field(None, alias="keyColumn")`.
- Error messages are identical on both sides and listed in the shared fixture `packages/shared/test/fixtures/repeating-sections.json`:
  - `section "<id>": key needs repeat`
  - `section "<id>": key must have at most one group, or a group named key`
  - `section "<id>": repeat is supported in recipes only` (legacy `spec.yaml`)
  - `step "<id>": a field step cannot read a repeating section (<section>); fill a table instead`
  - `step "<id>": reads more than one repeating section (<a>, <b>)`
  - `step "<id>": keyColumn needs a repeating section with a key`
  - `step "<id>": keyColumn "<c>" is not a column of <table>`
- Key = named group `key`, else group 1, else the whole match; stripped; `""` = no key. Searched (multiline) in the occurrence's own text.
- An occurrence ends at the next start of **any** section's occurrence; the tie rule (earlier declared section gets the empty span) is unchanged.
- A recipe without `repeat` must render byte-identical prompts, segment identically and keep its step-cache keys. No `CACHE_VERSION` bump.
- Legacy `Extraction`/`ExtractionSchema` is not changed.
- Step progress `occurrence: {n, of, key} | null`, optional in Zod (`.nullable().default(null)`).
- Grid cell additions `occurrences` (default `[]`) and `matches` (default `0`) are defaulted on read.
- Drafting stage schemas stay within 16 union-typed parameters; revise uses sentinels (`false`, `""`).
- UI copy says **recipe**; never shows model refs.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. A recipe with no `repeat` anywhere → identical `segment` output, identical rendered prompts (golden), identical parsed definition on the TS side (`toStrictEqual`) (Tasks 1-4).
2. `covalidation` text: batch 1's `microbial` occurrence ends at batch 2's heading, not at the next `microbial` caption (Task 3 table row `interleaved_ends_at_any_next_start`).
3. A repeating step whose optional section has no occurrence → no model call, empty rows, no cache write (Task 4 `test_repeating_step_without_occurrences_makes_no_call`).
4. Cache hit validated against the **full** schema (with `keyColumn`), not the per-call schema (Task 4 `test_step_cache_round_trip_with_key_column`).
5. A key regex that never matches one occurrence → that occurrence's rows have `null` keys and one issue per row, job not failed (Task 4).

---

## File structure

| File | Responsibility |
| --- | --- |
| `packages/shared/test/fixtures/repeating-sections.json` (create) | valid/invalid definitions with expected messages, both suites |
| `packages/shared/src/spec.ts` | `SectionSchema.repeat/key`, key regex rule, legacy refusal |
| `packages/shared/src/template.ts` | `keyColumn`, step rules in the template `superRefine` |
| `worker/src/ingest_worker/specs.py` | `Section.repeat/key`, legacy refusal |
| `worker/src/ingest_worker/template.py` | `ExtractStep.key_column`, rules in `_consistency`, `compile_step` mergePath, `Template.repeating_section(step)` |
| `worker/src/ingest_worker/segment.py` | `SectionSpan.index/key`, `occurrence_key`, `Occurrence`, `segment_occurrences` |
| `worker/src/ingest_worker/pipeline.py` | `Prepared.occurrences`, `SEGMENTED` data, `RepeatPlan`, `run_step_extraction(repeat=)` |
| `worker/src/ingest_worker/prompts.py`, `prompt_templates/extract.md.j2` | `occurrence` variable and block |
| `worker/src/ingest_worker/template_pipeline.py` | build `RepeatPlan`, `step_reporter` occurrence, key-column issues |
| `worker/src/ingest_worker/workbench.py` | grid `occurrences`, `matches`; group spans by id |
| `packages/shared/src/workbench.ts` | `OccurrenceCellSchema`, `SectionCellSchema.occurrences/matches` |
| `packages/shared/src/jobs.ts`, `packages/shared/test/fixtures/step-progress.json` | `StepProgressSchema.occurrence` |
| `worker/src/ingest_worker/draft_stages.py` | sections/steps/revise schemas, converters, prompts |
| `packages/shared/test/fixtures/draft-changes.json` | repeating section + keyColumn step case |
| `apps/web/src/workbench/SectionsTab.tsx`, `SegmentationGrid.tsx`, `segmentation.ts` | Repeats/Key inputs, ×N cells, *Make it repeat* |
| `apps/web/src/templates/StepForms.tsx`, `PipelineEditor.tsx`, `editor-derive.ts` | Key column select, disabled reasons |
| `apps/web/src/workbench/StepsView.tsx`, `apps/web/src/workbench/runs.ts`, `apps/web/src/jobs/derive.ts` | step card note, progress text |
| `CLAUDE.md`, `docs/architecture.md` | contract table rows, segmentation paragraph |

---

## Task 1: Format on the Python side

**Files:** `packages/shared/test/fixtures/repeating-sections.json`, `worker/src/ingest_worker/specs.py`, `worker/src/ingest_worker/template.py`, tests `worker/tests/test_template.py`, `worker/tests/test_specs.py`

- [ ] **Step 1: Write the shared fixture.** `{"cases": [{"name", "kind": "template"|"spec", "definition", "error": null | "<message>"}]}`. Base it on a trimmed `covalidation` recipe (sections `front`, `batch`, `appearance`, `microbial`, `conclusion`; tables `batches`, `appearance_results`; steps as in the spec). Cases: valid covalidation; valid without any new key; `key` without `repeat`; key with two groups; key with named group `key` and another group (valid); field step reading `batch`; step reading `appearance` and `microbial`; `keyColumn` on a field step; `keyColumn` with a section without `key`; `keyColumn` naming an unknown column; `keyColumn` with a non-repeating section; `chunkPages` + repeating section (valid); legacy spec with `repeat`.
- [ ] **Step 2: Write the failing tests.** `test_template.py::test_repeating_sections_fixture` parametrised over the fixture (`kind == "template"`): `Template.model_validate` passes, or raises with the message in `str(exc)`. `test_specs.py::test_repeating_sections_fixture_specs` for `kind == "spec"`. Run `cd worker && uv run pytest tests/test_template.py -k repeating tests/test_specs.py -k repeating`; expect failures (`extra fields not permitted`).
- [ ] **Step 3: Implement.** `Section.repeat`, `Section.key` with a validator (`key` needs `repeat`; compile; `re.compile(key).groups <= 1 or "key" in groupindex`). `DocumentSpec._cross_references` refuses `repeat`. `ExtractStep.key_column`. In `Template._consistency`: `Template.repeating_section(step) -> Section | None` (raises the "more than one" error through the collected errors), the field-step, `keyColumn` and column rules. `compile_step`: `mergePath = "rows"` when `chunk_pages` or a repeating section.
- [ ] **Step 4: Run green**, then `npm run worker:test` (contract `test_specs.py` loads every spec) and `npm run worker:lint`.
- [ ] **Step 5: Commit** `Recipe format: repeating sections and keyColumn (worker)`.

## Task 2: Format on the TS side

**Files:** `packages/shared/src/spec.ts`, `packages/shared/src/template.ts`, tests `packages/shared/test/template.test.ts`, `packages/shared/test/spec.test.ts`

- [ ] **Step 1: Failing tests.** `it.each` over the same fixture (template cases through `TemplateDefinitionSchema`, spec cases through `DocumentSpecSchema`): success, or an issue whose message equals the fixture's. Plus `parses a recipe without repeat to itself`: every `specs/*/template.yaml` parsed → `toStrictEqual` the YAML object with only today's defaults (assert no `repeat`/`key`/`keyColumn` keys appear). Run `npx vitest run --project shared`; expect failures.
- [ ] **Step 2: Implement.** `SectionSchema` adds `repeat: z.boolean().optional()`, `key: z.string().min(1).optional()` and a `superRefine` for the key rules (JS `RegExp` with the Python-compatible subset: compile with `new RegExp(key.replace(/\(\?P<key>/g, '(?<key>'), 'm')`; count groups via `new RegExp(key + '|').exec('').length - 1`). Document in a comment that Python's named-group syntax `(?P<key>…)` is accepted, and add a fixture case using it. Legacy refusal in the spec `superRefine`. Template step `keyColumn: Id.optional()` and the step rules in the template `superRefine`.
- [ ] **Step 3: Green**, then `npx vitest run apps/api/test/spec-registry.test.ts` (contract) and `npm run typecheck`.
- [ ] **Step 4: Commit** `Recipe format: repeating sections and keyColumn (shared)`.

## Task 3: Segmentation

**Files:** `worker/src/ingest_worker/segment.py`, `worker/src/ingest_worker/pipeline.py`, test `worker/tests/test_segment.py`

- [ ] **Step 1: Failing tests.** `test_section_spans_repeats` parametrised with `(name, text, sections, expected)` where `expected` is a list of `(id, index, key, first line)`. Rows: `non_repeating_unchanged` (today's behaviour on an existing case), `three_matches`, `covalidation` (the spec's sample text: 1 `front` + 3 `batch` + 3×5 tables + `conclusion` = 20 spans in document order with keys), `interleaved_ends_at_any_next_start`, `tie_earlier_declared_gets_empty`, `key_group_1`, `key_named_group`, `key_whole_match`, `key_no_match_is_none`, `key_empty_is_none`, `zero_width_anchor`. `test_segment_occurrences`: page marker prefixed per occurrence (with `mark_pages`); `segment` text of a repeating section = occurrences joined by `"\n\n"`; required repeating section with zero matches → `MissingSectionsError`; optional → `[]`; copies selected first (`select_copy` then segment, only the kept copy's occurrences).
- [ ] **Step 2: Implement** `SectionSpan.index/key`, `occurrence_key(pattern, text)`, `section_spans` with `finditer` for repeating sections, `Occurrence`, `segment_occurrences`; `segment` delegates. `Prepared.occurrences` (default `{}`), `prepare_document` uses `segment_occurrences` and adds `occurrences: {id: count}` to the `SEGMENTED` event only when non-empty.
- [ ] **Step 3: Green**; run the whole worker suite (existing segment and pipeline tests must not change).
- [ ] **Step 4: Commit** `Segmentation yields every occurrence of a repeating section`.

## Task 4: Extraction per occurrence

**Files:** `worker/src/ingest_worker/pipeline.py`, `prompts.py`, `prompt_templates/extract.md.j2`, `template_pipeline.py`, `packages/shared/src/jobs.ts`, `packages/shared/test/fixtures/step-progress.json`; tests `worker/tests/test_template_pipeline.py`, `worker/tests/test_prompts.py` (create), `packages/shared/test/jobs.test.ts`

- [ ] **Step 1: Golden prompt test first** (`test_prompts.py::test_builtin_prompt_unchanged_without_occurrence`): render a fields step and a chunked table step of an existing recipe and compare to a checked-in expected file captured **before** touching the template. Commit the golden with this step.
- [ ] **Step 2: Failing pipeline tests** (FakeProvider, `MemoryObjectStore`, `TextExtractor` returning the covalidation pages), parametrised where possible:
  - `test_repeating_step_calls_once_per_occurrence`: `appearance` → 3 calls; each prompt contains `occurrence 2 of 3` and `key: 4586784`; the schema sent has no `batch` property; rows carry `batch` from the key in document order.
  - `test_repeating_step_with_chunks`: occurrences × chunks, audit ids `appearance.occ-2.chunk-1`.
  - `test_repeating_step_without_occurrences_makes_no_call`.
  - `test_missing_key_adds_issues`: one occurrence without `Batch …` → null `batch`, one issue per row, message `no key found in occurrence 2 of appearance`.
  - `test_step_progress_reports_occurrence`: events' `occurrence` = `{n, of, key}`, null for other steps.
  - `test_step_cache_round_trip_with_key_column`: second Workbench run hits; changing one occurrence's text misses.
  - `test_rerun_repeats_every_occurrence` (`rerun_template_job`).
- [ ] **Step 3: TS failing test**: `StepProgressSchema` parses the fixture's old case (no `occurrence` → `null`) and a new case with it.
- [ ] **Step 4: Implement.** `render_prompt(occurrence=None)`; `extract.md.j2` adds the occurrence block and the section tag attributes only under `{% if occurrence %}`; run the golden. `RepeatPlan(section_id, occurrences, key_column)`; `run_step_extraction(repeat=)` builds the occurrences × chunks plan, a per-call schema without `key_column`, sets the key on rows per call before merging, validates the merged data against `ex.schema_` (full). `template_pipeline._run_step` builds the plan from `loaded.template.repeating_section(step)` and `doc.occurrences`, records issues for missing keys (before `_normalise_step`); `step_reporter` passes `occurrence`. `StepProgressSchema.occurrence`.
- [ ] **Step 5: Green** both suites; `npm run worker:lint`.
- [ ] **Step 6: Commit** `Extract steps run once per occurrence with a worker-filled key column`.

## Task 5: Preview grid

**Files:** `worker/src/ingest_worker/workbench.py`, `packages/shared/src/workbench.ts`; tests `worker/tests/test_workbench_segment.py`, `packages/shared/test/workbench.test.ts`

- [ ] **Step 1: Failing tests.** `test_segment_samples_repeats` (parametrised): a repeating cell has `occurrences` with page/line/chars/key and `chars` = total; a non-repeating section whose anchor matches 3 times has `matches: 3`, once `matches: 1`, missing `matches: 0`; repeating cells have `matches: 0`. Shared: a stored grid without the new fields parses with `[]`/`0`.
- [ ] **Step 2: Implement** (spans grouped by id; `matches` via `len(re.findall(...))` inside the existing capped child). `OccurrenceCellSchema`, `SectionCellSchema.occurrences/matches` with defaults.
- [ ] **Step 3: Green; commit** `Segmentation preview shows occurrences and repeated matches`.

## Task 6: Drafting

**Files:** `worker/src/ingest_worker/draft_stages.py`, `packages/shared/test/fixtures/draft-changes.json`; tests `worker/tests/test_draft_stages.py`, `packages/shared/test/drafting.test.ts`, `worker/tests/test_draft_changes.py`

- [ ] **Step 1: Failing tests.** `convert_sections` with `repeat: true, key: "Batch\\s+(\\w+)"` → `putSection` with both; `repeat: null` → absent; `key` with `repeat` false → error from `Section`. `convert_steps` with `keyColumn`. `check_sections` reports an invalid `key` regex. `check_steps` reports the template rule for a field step on a repeating section. Union-count test rows stay ≤ 16 (update expected numbers only if the new keys fit). Revise sentinels: `repeat: false`, `key: ""`, `keyColumn: ""` → absent. New `draft-changes.json` case: put the covalidation `appearance` section and step, expected definition; run on both sides.
- [ ] **Step 2: Implement** schema keys, converters, the prompts' wording (spec section 4; replace option 1's "one big section" steer once it has landed, and turn its repeated-match feedback into "set repeat if this block repeats" for non-repeating sections).
- [ ] **Step 3: Green; commit** `Drafting proposes repeating sections and key columns`.

## Task 7: Sections tab

**Files:** `apps/web/src/workbench/SectionsTab.tsx`, `SegmentationGrid.tsx`, `segmentation.ts`; tests in `apps/web/test/` (`SectionsTab.test.tsx`, `SegmentationGrid.test.tsx`, `segmentation.test.ts`; extend or create)

- [ ] **Step 1: Failing tests** (Testing Library, by role/label): ticking *Repeats* shows a *Key* input, an invalid key shows its error, both are sent in the preview's candidate document and kept unsaved (`ih.sectionsDraft…`); a cell with 3 occurrences shows `×3` and the keys, expanding to one row per occurrence; a cell with `matches: 3` shows "matches 3×, only the first is used" and *Make it repeat* sets Repeats (unsaved). Pure helpers (`occurrenceSummary`, `repeatHint`) table-tested in `segmentation.test.ts`.
- [ ] **Step 2: Implement; green; commit** `Sections tab: repeating sections and occurrence cells`.

## Task 8: Pipeline step form, Steps tab, progress text

**Files:** `apps/web/src/templates/StepForms.tsx`, `PipelineEditor.tsx`, `editor-derive.ts`, `apps/web/src/workbench/StepsView.tsx`, `apps/web/src/workbench/runs.ts`, `apps/web/src/jobs/derive.ts`; tests in `apps/web/test/` (extend the existing files for each component)

- [ ] **Step 1: Failing tests.** A table step ticking a repeating section shows "Runs once per occurrence of appearance" and a *Key column* select (*None* first, the table's columns); the select is disabled with "appearance has no key" when the section has none; on a field step repeating sections are disabled with "a field step can't read a repeating section"; `StepsView` names the repeating section and key column; progress text "Step 3 of 7 · occurrence 2 of 3 (4586784) · try 1" (`runs.ts`, `jobs/derive.ts`, table-tested).
- [ ] **Step 2: Implement; green; commit** `Recipe editor and run progress know repeating sections`.

## Task 9: Docs and the full check

- [ ] **Step 1:** `CLAUDE.md` contract table: spec format row gains `repeat`/`key` and `keyColumn`; test-run step progress row gains `occurrence`; workbench segmentation row gains `occurrences`/`matches`. `docs/architecture.md` segmentation paragraph. Mark the spec `Status: implemented`.
- [ ] **Step 2:** `npm run check` and `npm run worker:test`/`worker:lint` green.
- [ ] **Step 3:** Manual check in the Workbench with the `covalidation` samples: Sections preview shows ×3 per table, a dev test run gives 3 batches per table with correct `batch`.
- [ ] **Step 4: Commit** `Docs: repeating sections`.

## Parallelism

Tasks 1 and 2 share only the fixture (write it in Task 1, Task 2 reads it). Task 3 needs Task 1. Tasks 4 and 5 need Task 3 and are independent of each other. Task 6 needs Tasks 1-2. Tasks 7 and 8 need Task 2 (and 5 for the grid fields, 4 for progress) and touch disjoint web files.
