# Output Roles (Constraints, Check Plugins, Transforms) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a recipe constrain an output's values, judge them with a check plugin, and (phase 3, gated) rewrite them with a transform, without breaking the rule that each column has one filling step.

**Architecture:** Three phases, each shippable on its own and each its own PR:
- **Phase 1:** declarative constraints on `ValueDef`, checked wherever values are normalised.
- **Phase 2:** check steps that name a check plugin, a new plugin `kind`, with results in today's check result format.
- **Phase 3:** a `transforms` role on plugin steps, keeping the raw value in a side record. It starts only after a go decision at the end of phase 2.

Every format change lands on both sides, held in step by a shared fixture (CLAUDE.md: cross-language contracts).

**Tech Stack:** Zod (`packages/shared`), Pydantic + mypy strict (`worker`), Fastify (`apps/api`), React + Testing Library (`apps/web`), Vitest, pytest.

**Spec:** `docs/design/output-roles.md` (brainstorm note; the decisions below settle its open questions and must be written back into it in each phase's last task).

## Global Constraints

- **TDD:** red first for every behaviour change, and never weaken a test (CLAUDE.md).
- **Cross-language contracts:** change both sides in the same PR. Hand-edit the shared fixtures in `packages/shared/test/fixtures/` (never re-dump them with `json.dumps`).
- **Hashes:** an absent new key changes nothing. Older recipes parse and hash as before, so add no defaults to TS schemas for the new keys.
- **Migrations:** `db/migrations/YYYYMMDDHHMM_description.sql` with the UTC time of writing; forward-only.
- **Routes:** any schema change that reaches a route needs `npm run openapi`, and `docs/openapi.json` must be committed.
- **Naming:** a `JobModels` variable is never called `models` (the `test_nothing_resolves_a_model_around_the_gate` grep).
- **Plugin registry:** tests replace it with `monkeypatch.setattr(ingest_worker.plugins, "plugins", …)`, and also on any module that imported `plugins` by name (`plugin_preview`).
- **Wording:** user-facing text says "recipe", not "template". Every new help topic gets an entry in `HELP_INDEX`.
- **Staging:** stage files by name, never `git add -A`.
- **Before each commit:** `npm run check` and `npm run format:check` pass.
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions (settling the brainstorm's open questions)

| Question | Decision |
| --- | --- |
| Which constraints | `range: {min?, max?}` (decimal, integer), `pattern` (text; the whole value must match), `length: {min?, max?}` (text, in characters). Nothing for dates, lists, enums or booleans. |
| Severity | Every constraint issue is a normalisation issue, so it is a review reason. No warning level in v1. |
| Constraint messages | `{value} is below {min}`, `{value} is above {max}`, `{value!r} does not match {pattern}`, `{value!r} is shorter than {min} characters`, `{value!r} is longer than {max} characters`. TS never produces these (the worker alone checks values). |
| Pattern syntax | Python `re`, the same as section anchors. TS checks `new RegExp(p.replace(/\(\?P</g, '(?<'), 'u')`, Python checks `re.compile(p)`. The shared fixture holds the cases both must agree on. |
| Constraints and the model | Never compiled into the model's JSON Schema. |
| Constraints and review edits | Checked on reviewer edits too (step `review`), as `apply_edits` already normalises. |
| SHACL | Separate. Constraints emit nothing into shapes. |
| Check plugin contract | A check step names `uses` + optional `with`, and then has no `reference`/`aliases`/`maxDistance`. The plugin gets the distinct values (as `run_check` collects them) plus the rows when `values` is a column. Per value it returns `{value, status: match\|alias\|near\|unmatched, matched: str\|None, message: str\|None}`. |
| Plugin kind | `Plugin.kind: "step" \| "check"`, default `"step"`. The catalogue gains `kind` (migration). A check step must name a `check` plugin; a plugin step must name a `step` plugin. |
| Check plugin egress | `none` only (`check_plugin` refuses others). |
| Built-in check | `list.lookup@1` only (settings `values`, `aliases`, `maxDistance`; the same matching as today's checks). `rule.compare@1` waits for a real case. |
| Check preview | None in v1 (checks re-run on every test run already). |
| Transforms gate | Phase 3 starts only if, at the end of phase 2, the user confirms recipes need code rewrites of a filled column that a second column (P4) cannot serve. |
| Raw values (phase 3) | A side record `document.transforms: [{step, target, row, column, from, to}]`. Cell values keep their shape. |
| Transform scope (phase 3) | Plugin steps only, fields and columns. A value the plugin returns `null` for keeps the raw value and raises an issue. |

## Review Focus

- A `pattern` that Python accepts and JavaScript rejects (or the reverse): the recipe must be refused on both sides, never accepted by one and failing the job on the other. Pin it in the shared fixture (Task 1.1).
- A range bound on a value that failed type normalisation (`"lots"` on an integer column): exactly one issue, the type issue, never two. Pin it in Task 1.2.
- A reviewer correcting an out-of-range value to an in-range one: the constraint issue disappears, and the job no longer counts it as a review reason. Pin it in Task 1.2.
- A check plugin returning a status outside the four, or a value it was not given: a `DocumentError` naming the check, never a silently dropped row. Pin it in Task 2.3.
- A published recipe whose check plugin a worker no longer has: the job goes to review before any model call, like a missing step plugin. Pin it in Task 2.3.

---

## Phase 1: Column constraints

### Task 1.1: Constraint format on both sides

**Files:**
- Modify: `packages/shared/src/template.ts:33-45` (`ValueDefSchema`)
- Modify: `worker/src/ingest_worker/template.py:28-41` (`ValueDef`)
- Create: `packages/shared/test/fixtures/value-constraints.json`
- Test: `packages/shared/test/template.test.ts`, `worker/tests/test_template.py`

**Interfaces:**
- Produces:
  - TS `ValueDef.range?: {min?: number; max?: number}`, `ValueDef.pattern?: string`, `ValueDef.length?: {min?: number; max?: number}`.
  - Python `ValueDef.range: Bound | None`, `ValueDef.pattern: str | None`, `ValueDef.length: Bound | None`, with `class Bound(_Model): min: float | None = None; max: float | None = None`.

- [ ] **Step 1: Write the fixture and both readers.** The fixture follows `plugin-steps.json`'s shape: `base` is a recipe with field `assay` (decimal) and field `batch` (text), and each case replaces `outputs.fields`. Cases:
  - valid: `range {min: 90, max: 110}` on decimal; `range {min: 0}` on integer; `pattern "^[A-Z]{2}\\d{4}$"` on text; `pattern "(?P<x>A)B"` (named group, both syntaxes); `length {max: 12}` on text.
  - invalid:
    - `range` on text → error `range needs a decimal or integer`;
    - `range {min: 5, max: 1}` → `min is above max`;
    - `range {}` → `range needs min or max`;
    - `pattern` on decimal → `pattern needs a text`;
    - `pattern "("` → `is not a valid pattern`;
    - `length` on integer → `length needs a text`;
    - `length {min: -1}` → `length cannot be negative`.

  Readers mirror `test_plugin_steps_match_the_shared_fixture` and the TS `plugin steps (shared with the worker)` block: substring match on `error`.
- [ ] **Step 2: Run both and see them fail.** Run `npx vitest run packages/shared/test/template.test.ts -t constraints` and `cd worker && uv run pytest tests/test_template.py -k constraints`. Expected: the valid cases fail on strict/extra-forbid unknown keys.
- [ ] **Step 3: Add the keys and the refinements.** In TS, add a `.superRefine` on `ValueDefSchema` beside the existing enum refine. In Python, add a `@model_validator` beside `_enum_values`. Messages are prefixed `"{id}": ` in TS and `{id!r}: ` in Python; the fixture's substrings exclude the id.
- [ ] **Step 4: Run both to green**, then `npm run check`.
- [ ] **Step 5: Commit** "Output constraints: range, pattern and length on fields and columns (format)".

### Task 1.2: Constraint issues at normalisation and review

**Files:**
- Modify: `worker/src/ingest_worker/normalize.py` (add `check_value`)
- Modify: `worker/src/ingest_worker/template_pipeline.py:1022,1054` (`normalise_step` calls)
- Modify: `worker/src/ingest_worker/review.py:65,92` (`apply_edits` calls)
- Test: `worker/tests/test_normalize.py`, `worker/tests/test_template_pipeline.py`, `worker/tests/test_review.py`

**Interfaces:**
- Consumes: Task 1.1's `ValueDef` keys.
- Produces: `check_value(raw: Any, definition: ValueDef, date_order: DateOrder) -> tuple[Any, str | None]` in `normalize.py`: `normalize_value`, then, only when that returned no issue and the value is not None, the first failing constraint's message (in the Decisions table's wording).

- [ ] **Step 1: Write the failing tests.**
  - `test_normalize.py`: parametrised `test_check_value_applies_constraints` with these `(raw, definition, expected)` cases:
    - `("87.5", decimal range{min:90}) → (87.5, "87.5 is below 90")`
    - `("111", integer range{max:110}) → (111, "111 is above 110")`
    - `("ab1234", text pattern ^[A-Z]{2}\d{4}$) → ("ab1234", "'ab1234' does not match ^[A-Z]{2}\\d{4}$")`
    - `("lots", integer range{min:0}) → ("lots", "'lots' is not a valid integer")` (only the type issue)
    - `(None, decimal range{min:1}) → (None, None)`
    - `("AB1234", same pattern) → ("AB1234", None)`
  - `test_template_pipeline.py`: `test_an_out_of_range_value_is_a_review_reason` (a field step returns `87.5` for an `assay` with `range {min: 90}`: one issue with step = the step id and target `assay`, and `"1 normalisation issue(s)"` in the reasons).
  - `test_review.py`: `test_a_reviewer_edit_into_range_drops_the_constraint_issue` and `test_a_reviewer_edit_out_of_range_is_an_issue` (step `review`).
- [ ] **Step 2: Run them and see them fail** (`uv run pytest tests/test_normalize.py tests/test_review.py -k "constraint or range"`). Expected: `ImportError` on `check_value`.
- [ ] **Step 3: Implement `check_value`** and replace the four `normalize_value(...)` calls with `check_value(raw, definition, order)`. Use `re.fullmatch` for patterns. Format numbers in messages with `f"{value:g}"`.
- [ ] **Step 4: Run the worker suite to green**, including `tests/test_equivalence.py` (the golden files must not change: no recipe there has constraints).
- [ ] **Step 5: Commit** "Output constraints: values outside them are review issues".

### Task 1.3: Editor, help and docs

**Files:**
- Modify: `apps/web/src/templates/TemplateEditor.tsx:1141-1220` (the output rows: id, name, type, enum, description)
- Modify: `apps/web/src/help/OutputsHelp.tsx`
- Modify: `docs/design/output-roles.md` (§1: decisions taken), `CLAUDE.md` (Template format contract row: `ValueDef` `range`/`pattern`/`length`, fixture `value-constraints.json`)
- Test: `apps/web/test/TemplateEditor.test.tsx`

**Interfaces:**
- Consumes: Task 1.1's keys.

- [ ] **Step 1: Write the failing tests** in `describe('output constraints')`:
  - `sets a range on a decimal column and clears it when emptied`: the inputs are labelled `"{n} min"` and `"{n} max"`, like `"{n} enum"`. Typing `90` into min saves `range: {min: 90}`; emptying it saves no `range` key.
  - `offers a pattern and a max length only for text`: there is no `"{n} pattern"` input on a decimal row.
- [ ] **Step 2: Run them and see them fail** (`npx vitest run apps/web/test/TemplateEditor.test.tsx -t "output constraints"`).
- [ ] **Step 3: Add the inputs** beside the enum input, shown by type: decimal/integer get min/max; text gets pattern and max length. An empty input deletes the key, as `opt()` does elsewhere. Then write the help paragraph in OutputsHelp: what each constraint checks, that a value outside one is kept and flagged, and that the model is never told the limits.
- [ ] **Step 4: Run** `npm run check`, `npm run format:check` and `npm run openapi` (the recipe schema reaches template routes), then commit `docs/openapi.json` if it changed.
- [ ] **Step 5: Commit** "Output constraints: editor, help and docs", then push and open the phase 1 PR.

---

## Phase 2: Check plugins

### Task 2.1: Check steps naming a plugin (format) and the plugin kind

**Files:**
- Modify: `packages/shared/src/template.ts` (`CheckStepSchema`; `superRefine`)
- Modify: `packages/shared/src/plugins.ts` (`PluginInfoSchema.kind`)
- Modify: `worker/src/ingest_worker/template.py:91-100` (`CheckStep`), `_consistency` (check paths are only resolved for `values` when `uses` is set)
- Modify: `worker/src/ingest_worker/plugins.py` (`Plugin.kind`, `Plugin.judge`, `check_plugin`)
- Modify: `worker/src/ingest_worker/plugin_catalogue.py` (`catalogue_rows` adds `kind`)
- Create: `db/migrations/<UTC>_plugin_catalogue_kind.sql`: `ALTER TABLE plugin_catalogue ADD COLUMN kind text NOT NULL DEFAULT 'step' CHECK (kind IN ('step','check'))`
- Modify: `apps/api/src/plugins/catalogue.ts` (the Pg read selects `kind`)
- Modify fixtures: `packages/shared/test/fixtures/plugin-steps.json`, `plugin-catalogue.json` (add `"kind": "step"` to the `text.pattern@1` row)
- Test: both template tests (fixture), `worker/tests/test_plugin_catalogue.py`, `apps/api/test/plugins.test.ts`

**Interfaces:**
- Produces:
  - TS `CheckStep.uses?: string` (regex `PLUGIN_REF`) and `CheckStep.with?: Record<string, unknown>`; `PluginInfo.kind: 'step' | 'check'`.
  - Python `CheckStep.uses: str | None` and `CheckStep.with_: dict[str, Any]` (alias `with`, default `{}`).
  - `Plugin.kind: Literal["step", "check"] = "step"` and `Plugin.judge: Callable[[CheckContext, Any], list[dict[str, Any]]] | None = None`.
  - `check_plugin` errors `a check plugin needs judge`, `a check plugin sends no data out (egress none)`, `a step plugin has no judge`.

- [ ] **Step 1: Write the failing tests.** Add `plugin-steps.json` cases:
  - valid: `{type: check, id: names, uses: list.lookup@1, values: "lines.sku", with: {values: ["A1"]}}`;
  - invalid: `uses` together with `reference` → `a check runs a plugin or compares with a reference, not both`; no `uses` and no `reference` → `a check needs a reference or a plugin`.

  Add `"kind": "step"` to the catalogue fixture row. Add a parametrised `test_check_plugin_rules` covering the three new `check_plugin` errors.
- [ ] **Step 2: Run them and see them fail** (both fixture readers and `uv run pytest tests/test_plugins.py -k check_plugin`).
- [ ] **Step 3: Implement.** Today `reference` is required on both sides; make it optional with the either/or rule. Write the migration, then run `npm run test:integration` only if dev-infra is up. Otherwise, say in the PR that the Pg catalogue read was checked by its unit contract only.
- [ ] **Step 4: Run** `npm run check` **to green.**
- [ ] **Step 5: Commit** "Check plugins: check steps may name a plugin; plugins have a kind".

### Task 2.2: API checks on a check step's plugin

**Files:**
- Modify: `apps/api/src/templates/definitions.ts:230-275` (`pluginIssues`)
- Test: `apps/api/test/plugins.test.ts`

**Interfaces:**
- Consumes: `PluginInfo.kind` (Task 2.1).
- Produces these issues (blocking, as today's plugin issues):
  - `pipeline.N.uses`: `check "x": no plugin acme.y@1 on this deployment's workers`, `check "x": acme.y@1 is not a check plugin`, and, for a plugin step naming a check plugin, `step "x": acme.y@1 is a check plugin: use it in a check step`;
  - `pipeline.N.with`: `check "x": acme.y@1 settings: …`.

- [ ] **Step 1: Write the failing tests:** one per issue above, plus `is fine when a worker has the check plugin and the settings fit`.
- [ ] **Step 2: Run them and see them fail** (`npx vitest run apps/api/test/plugins.test.ts -t "check plugin"`).
- [ ] **Step 3: Extend `pluginIssues`** to visit check steps with `uses`, reusing `settingsProblems`.
- [ ] **Step 4: Run** `npm run check` **and** `npm run openapi`; commit `docs/openapi.json` if it changed.
- [ ] **Step 5: Commit** "Check plugins: the API checks a check step's plugin and settings".

### Task 2.3: Running check plugins, and `list.lookup@1`

**Files:**
- Modify: `worker/src/ingest_worker/checks.py` (extract `classify(values: dict[str, tuple[str, int]], references: list[tuple[str, set[str]]], max_distance: int) -> list[dict[str, Any]]` from `run_check`; `run_check` calls it)
- Modify: `worker/src/ingest_worker/plugins.py`:
  - `CheckContext` (frozen dataclass: `job`, `template`, `step: CheckStep`, `values: list[str]`, `rows: list[dict[str, Any]] | None`);
  - `resolve_checks(template) -> dict[str, ResolvedPlugin]`, which raises `DocumentError` `check 'x': no plugin acme.y@1 on this worker` or the settings error, like `resolve_plugins`;
  - `run_check_plugin(resolved, ctx) -> dict[str, list[dict[str, Any]]]`;
  - the built-in `list.lookup@1` (`LookupSettings`: `values: list[str]` (min 1), `aliases: dict[str, list[str]] = {}`, `max_distance: int = 2` (alias `maxDistance`)), added to `BUILTINS`.
- Modify: `worker/src/ingest_worker/template_pipeline.py:202-210` (the check closure: a check with `uses` runs the plugin) and the job start (call `resolve_checks` beside `resolve_plugins`)
- Modify: `worker/src/ingest_worker/review.py:20-40` (`run_checks` runs check plugins too, with `resolve_checks`)
- Test: create `worker/tests/test_check_plugins.py`; `worker/tests/test_checks.py`; `tests/test_plugin_catalogue.py` (the fixture pins `BUILTINS`, so add the `list.lookup@1` row to `plugin-catalogue.json`)

**Interfaces:**
- Consumes: Task 2.1's `Plugin.judge` and `CheckStep.uses`.
- Produces: the check result `{"rows": [{value, status, matched, distance: None, count, message}]}`. `count` comes from the collected values. `message` is a new optional key, which the web reads in Task 2.4.

- [ ] **Step 1: Write the failing tests** in `test_check_plugins.py`, a full job via `run_once` with a monkeypatched registry like `test_plugin_enrich.py`:
  - `test_a_check_plugin_judges_each_distinct_value_once` (values `["A1", "A1", "B9"]` → the plugin sees `["A1", "B9"]`; the counts are 2 and 1).
  - `test_unmatched_values_are_review_reasons` (`check names: 1 unmatched` in the reasons).
  - `test_the_plugin_gets_the_rows_when_values_is_a_column`.
  - `test_a_status_outside_the_four_is_a_document_error` (`check 'names': acme.bad@1 answered status 'maybe'`).
  - `test_a_value_the_plugin_was_not_given_is_a_document_error`.
  - `test_a_missing_check_plugin_stops_the_job_before_any_model_call` (the provider has no calls; the job is reviewed).
  - `test_checks_rerun_after_a_reviewer_edit` (`apply_edits` re-judges).
  - `test_list_lookup_matches_like_a_check` (parametrised over `match`/`alias`/`near`/`unmatched` with the same inputs as the existing `test_checks.py` cases).
- [ ] **Step 2: Run them and see them fail** (`uv run pytest tests/test_check_plugins.py`). Expected: `ImportError` on `CheckContext`.
- [ ] **Step 3: Implement.** First refactor `classify` out of `run_check`, keeping `test_checks.py` green. Then add `CheckContext`, `resolve_checks` and `run_check_plugin`, which validates statuses and values and raises `DocumentError`. Then `list.lookup@1` calls `classify`.
- [ ] **Step 4: Run the worker suite and** `npm run worker:lint` **to green.** `tests/test_equivalence.py` goldens must be unchanged.
- [ ] **Step 5: Commit** "Check plugins: the worker runs them; built-in list.lookup@1".

### Task 2.4: Editor, review and results, help and docs

**Files:**
- Modify: `apps/web/src/templates/StepForms.tsx:280-320` (`CheckStep` form: a *Compares with* `Segmented`, *a reference* / *a plugin*. A plugin shows a check-plugin picker (`plugins.filter(p => p.kind === 'check')`) and the `SettingsForm` from `PluginForms.tsx`)
- Modify: `apps/web/src/api/client.ts:121-135` (the check row type gains `message?: string | null`), `apps/web/src/results/ResultDetail.tsx:~700` (`CheckView` shows the message), the Review page's check view (where `effective.ts` flags rows: show the message in the flag text, `${step.id}: ${message ?? 'unmatched'}`)
- Modify: `apps/web/src/help/PipelineHelp.tsx` (check steps: comparing with a plugin), `docs/plugins/writing-plugins.md` (a "Check plugins" section: `kind`, `judge`, `CheckContext`, the statuses, egress none), `docs/design/output-roles.md` §2, `CLAUDE.md` (Template format and Plugin catalogue rows: `kind`, migration name, `list.lookup@1`)
- Test: `apps/web/test/TemplateEditor.test.tsx`, `apps/web/test/ReviewPage.test.tsx`, `apps/web/test/ResultDetail.test.tsx`

- [ ] **Step 1: Write the failing tests:**
  - `switches a check to a plugin and back`: saves `uses`/`with` with no `reference`, then `reference` with no `uses`.
  - `offers only check plugins to a check step` and `only step plugins in Add plugin step`.
  - `shows a check plugin's message on a flagged value` (Review).
  - `shows a check plugin's message in the check view` (Results).
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement the form, the type and the two views; write the help and docs.**
- [ ] **Step 4: Run** `npm run check` **and** `npm run format:check`.
- [ ] **Step 5: Commit** "Check plugins: editor, review and results, help and docs", then push and open the phase 2 PR.

### Gate before phase 3

- [ ] Ask the user, quoting the design note's §3 "Why last": do recipes need code rewrites of a column another step fills, which a second column (P4 enriching steps) cannot serve? Stop here on a no.

---

## Phase 3: Transforms (only after the gate)

### Task 3.1: The `transforms` format and its rules

**Files:**
- Modify: `packages/shared/src/template.ts` (`PluginStepSchema.transforms?: string[]`; `superRefine`), `worker/src/ingest_worker/template.py` (`PluginStep.transforms`, `_consistency`, `Template.transforms_of(path) -> list[PluginStep]`)
- Create: `packages/shared/test/fixtures/transform-steps.json`
- Test: both template tests

**Interfaces:**
- Produces: `transforms` is a non-empty list of `<field>` / `<table>.<column>` paths. A transforming step has no `fields`, `table` or `columns` (the "fill either fields or a table" rule exempts it).

- [ ] **Step 1: Write fixture cases:**
  - valid: a transform after the filler of `lines.batch`; two transforms of one column in order; a transform of a field;
  - invalid:
    - before the filler → `transforms lines.batch before step "rows" fills it`;
    - an unknown path → `unknown field or column`;
    - `transforms` together with `fields` → `a step transforms or fills, not both`;
    - a transform reading a repeating section → `a transforming step cannot read a repeating section`.

  Also: a context naming a transformed path is ordered after the last transform of it (`which is not filled by an earlier step` otherwise).
- [ ] **Step 2: Run both readers and see them fail.**
- [ ] **Step 3: Implement both sides.** `outputCoverage` counts transforms nowhere (they fill nothing); `fillerOf` is unchanged.
- [ ] **Step 4: Run** `npm run check`.
- [ ] **Step 5: Commit** "Transforms: format and rules".

### Task 3.2: Running transforms, the raw-value record, re-runs

**Files:**
- Modify: `worker/src/ingest_worker/plugins.py`:
  - `PluginContext.values: list[Any] | None` (the values being transformed, in row order, or one for a field);
  - the reply `{"values": [...]}`, the same length.
- Modify: `worker/src/ingest_worker/template_pipeline.py`:
  - `run_plugin_step` handles transforms;
  - `StepOutcome.transforms: tuple[dict[str, Any], ...]`;
  - `DocState.apply` rewrites values and appends to `DocState.transforms`;
  - `document.transforms` is written by `finalise` and read by `DocState.from_document`.
- Modify: `rerun_template_job`:
  - re-running a filler re-runs every transform of its outputs, in pipeline order;
  - re-running a transform restores the raw values from `document.transforms` first, then runs.
- Modify: `apps/api/src/routes/review.ts` (the reviewer-edit 409 also counts edits of a path a transform rewrites)
- Test: create `worker/tests/test_transforms.py`; `apps/api/test/plugins.test.ts`

**Interfaces:**
- Produces: the record `document.transforms: [{step, target, row: int|None, column: str|None, from, to}]`. A `null` reply keeps the raw value, records no entry, and raises an issue `step 'x' could not transform 'raw'`.

- [ ] **Step 1: Write the failing tests:**
  - `test_a_transform_rewrites_the_filled_values_and_keeps_the_raw_ones`;
  - `test_two_transforms_run_in_order`;
  - `test_checks_and_constraints_see_the_final_value`;
  - `test_a_null_reply_keeps_the_raw_value_with_an_issue`;
  - `test_another_number_of_values_is_a_document_error`;
  - `test_rerunning_the_filler_reruns_its_transforms`;
  - `test_rerunning_a_transform_starts_from_the_raw_values`;
  - API: `refuses a transform's re-run while its column has reviewer edits`.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the worker suite to green.** `tests/test_equivalence.py` goldens must be unchanged: a document without transforms writes no `transforms` key.
- [ ] **Step 5: Commit** "Transforms: run, raw values kept, re-runs".

### Task 3.3: Provenance, review, editor and docs

**Files:**
- Modify: `worker/src/ingest_worker/rdf.py` (evidence of a transformed value adds `ct:transformedBy` with the step id; add `transformedBy` to the `CT` namespace docs and the golden graph test)
- Modify: `apps/web/src/review/` (a transformed cell shows `from → to (step)` from `document.transforms`), `apps/web/src/api/client.ts` (`transforms` on the review document type), `PluginStepForm` (*Transforms*: pick paths, offered only for `kind: 'step'` plugins; it clears `fields`/`table`)
- Modify: help (`PipelineHelp`, `review` topic), `docs/plugins/writing-plugins.md` (`ctx.values`, the reply), `docs/design/output-roles.md` §3, `CLAUDE.md`
- Test: `worker/tests/test_rdf.py`, `apps/web/test/ReviewPage.test.tsx`, `apps/web/test/TemplateEditor.test.tsx`

- [ ] **Step 1: Write the failing tests:** `a transformed value's evidence names the transform` (RDF), `shows a transformed cell's raw value` (Review), `sets a plugin step to transform a column` (editor).
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement; write the help and docs.**
- [ ] **Step 4: Run** `npm run check`, `npm run format:check` **and** `npm run openapi`.
- [ ] **Step 5: Commit** "Transforms: provenance, review, editor and docs", then push and open the phase 3 PR.
