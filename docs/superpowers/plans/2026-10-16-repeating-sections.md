# Repeating sections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A recipe section can repeat (`repeat: true`, an optional `key` regex, and an optional `keyFrom` naming the repeating heading whose key it falls back to and is checked against). Segmentation yields every occurrence; a table step reading a repeating section runs once per occurrence, and the worker fills its `keyColumn` with the occurrence's key. With this, `covalidation` (3 batches × 5 tables) gets every batch's rows with the right batch number, and a table missed for one batch sends the job to review.

**Architecture:** In `segment.py`, `section_spans` returns every occurrence, with keys resolved through `keyFrom`. A pure `key_issues` checks each `keyFrom` section against its source, and `segment_occurrences` bundles the per-section text, the occurrences and the issues. `pipeline.Prepared` carries these to `template_pipeline`. That passes a `RepeatPlan` to `run_step_extraction`, which plans occurrences × chunks, renders an `occurrence` block in the built-in prompt, removes `keyColumn` from each call's schema and sets it on the rows before merging. The preview grid reports occurrences, repeated matches and key issues. The drafting stages and both editors learn the four keys. No migration, no new route.

**Tech Stack:** Python 3.13 worker (pydantic, jinja2, pytest), Zod in `@ih/shared`, React web (Vitest, Testing Library).

**Spec:** `docs/superpowers/specs/2026-10-16-repeating-sections-design.md`

## Global Constraints

- New keys:
  - `Section.repeat` (boolean).
  - `Section.key` (regex; needs `repeat`).
  - `Section.keyFrom` (section id; needs `repeat`).
  - `ExtractStep.keyColumn` (column id).
- TypeScript: each is `.optional()` with **no `.default`**, so a parsed definition never gains `repeat: false`.
- Python: `repeat: bool = False`, `key: str | None = Field(None, min_length=1)`, `key_from: Id | None = Field(None, alias="keyFrom")`, `key_column: Id | None = Field(None, alias="keyColumn")`. `draft_stages._dump` already omits defaults.
- Format errors: TypeScript quotes ids with `"…"`, Python with `!r`. The shared fixture stores the quote-free tail as `error`, and both sides assert it is a substring of the message.
  - `section "<id>": key needs repeat`
  - `section "<id>": keyFrom needs repeat`
  - `section "<id>": key must have at most one group, or a group named key`
  - `section "<id>": keyFrom "<s>" must be a repeating section with a key and no keyFrom`
  - `section "<id>": repeat is supported in recipes only` (legacy `spec.yaml`)
  - `step "<id>": a field step cannot read a repeating section (<section>); fill a table instead`
  - `step "<id>": reads more than one repeating section (<a>, <b>)`
  - `step "<id>": keyColumn needs a repeating section with a key or keyFrom`
  - `step "<id>": keyColumn "<c>" is not a column of <table>`
- A key that does not compile is not a format error, the same as an anchor. The preview reports it under `anchorErrors["<id>.key"]`, and the drafting `check_sections` refuses it.
- Key resolution: the named group `key`, else group 1, else the whole match; stripped; `""` means no key. It is searched (multiline) in the occurrence's own text. When it finds nothing, the key is inherited from the latest preceding occurrence of the `keyFrom` section. An own key wins.
- An occurrence ends at the next start of any section's occurrence. Starts sort by `(position, declaration order, index)`, so the tie rule is unchanged.
- Key issue messages, plain text, produced by the worker only:
  - `<R>: no occurrence for <S> <key>`
  - `<R> occurrence <n>: key <key> is not a <S> key`
  - `<R> occurrence <n>: key <own> differs from <S> <inherited> above it`
  - `<R> occurrence <n>: no key`
- Key issues in a job are issues with `step: "segment"`, `target: <R>`, `row`/`column`/`raw` null. They add the review reason `n section key issue(s)`, counted apart from normalisation issues. They never fail a job.
- A row with no key gets an issue with `step: <step>`, `target: <table>`, `row: n`, `column: <keyColumn>`, `raw: None`, `message: "no key found in this row's occurrence of <section>"`.
- A recipe without `repeat` must render byte-identical prompts, segment identically and keep its step-cache keys. No `CACHE_VERSION` bump.
- The legacy `Extraction`/`ExtractionSchema` stay unchanged.
- Step progress gains `occurrence: {n, of, key} | null`. In Zod it is `.nullable().default(null)`.
- New grid fields: `SectionCell.occurrences` (default `[]`), `SectionCell.matches` (default `0`), `SegmentedSample.keyIssues` (default `[]`).
- Out of scope, as decided 2026-10-16: declared occurrence counts, a single-call mode, per-occurrence fields, an "only after section X" guard, per-occurrence context, re-running one occurrence.
- UI copy says **recipe**, never template; no model refs.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Saving anchors on the Workbench Sections tab keeps `repeat`/`key`/`keyFrom`.** Today `SectionsTab`'s `Row` and `candidate()` copy only `id`/`anchor`/`required`/`description`, so a save would silently drop the new keys. Test: Task 8 `keeps repeat, key and keyFrom when anchors are saved`.
2. **A caption without a batch under batch 2's heading inherits batch 2**, not batch 1 or 3. Test: Task 3 row `key_from_nearest_preceding`.
3. **The page grows a list of tables at the front** that matches the table anchor. The result is one extra short occurrence and the key issue `occurrence 1: no key`, never a crash or a failed job. Test: Task 3 `test_key_issues` row `occurrence_before_first_heading` and Task 5 `test_list_of_tables_is_an_extra_occurrence_and_a_key_issue`.
4. **A step re-run of a repeating step** re-runs every occurrence. It keeps the job's `segment` issues and does not duplicate them. Test: Task 5 `test_rerun_keeps_segment_issues_once`.
5. **A recipe edited in the YAML tab or imported with `keyFrom: unknown`** is refused with the format message on both sides. It never reaches the worker as a `KeyError` in `key_issues`. Test: fixture case `keyFrom unknown section` (Tasks 1 and 2).

---

## File structure

| File | Responsibility |
| --- | --- |
| `packages/shared/test/fixtures/repeating-sections.json` (create) | `base` (trimmed `covalidation` recipe) and the format cases for both suites |
| `worker/tests/covalidation.py` (create) | `RECIPE` (the fixture's base), `PAGES` (4 pages of sample text), `SECTIONS` |
| `worker/src/ingest_worker/specs.py` | `Section` keys and rules, `key_from_errors`, legacy refusal |
| `worker/src/ingest_worker/template.py` | `ExtractStep.key_column`, step rules, `Template.repeating_section`, `compile_step` mergePath |
| `packages/shared/src/spec.ts` | `SectionSchema` keys and rules, `captureGroups`, `keyFromIssues`, legacy refusal |
| `packages/shared/src/template.ts` | `keyColumn`, step rules |
| `packages/shared/src/workbench.ts` | `keyFromIssues` in `SegmentDocumentSchema`; grid cell, occurrence and sample fields |
| `worker/src/ingest_worker/segment.py` | `SectionSpan` fields, `occurrence_key`, `section_spans`, `Occurrence`, `KeyIssue`, `key_issues`, `Segmented`, `segment_occurrences` |
| `worker/src/ingest_worker/pipeline.py` | `Prepared.occurrences/key_issues`, `SEGMENTED` data, `RepeatPlan`, `run_step_extraction(repeat=)` |
| `worker/src/ingest_worker/prompts.py`, `prompt_templates/extract.md.j2` | the `occurrence` variable and block |
| `worker/src/ingest_worker/template_pipeline.py` | `Progress` gains occurrence, plan wiring, key and segment issues, review reason |
| `worker/src/ingest_worker/workbench.py` | grid: spans grouped by id, `occurrences`, `matches`, `keyIssues`, key regex errors |
| `packages/shared/src/jobs.ts`, `packages/shared/test/fixtures/step-progress.json` | `StepProgressSchema.occurrence`, `JobProgressSchema` step arm |
| `worker/src/ingest_worker/draft_stages.py` | sections and steps schemas, converters, checks, prompts |
| `packages/shared/test/fixtures/draft-changes.json` | a repeating-section case |
| `apps/web/src/workbench/SectionsTab.tsx`, `SegmentationGrid.tsx`, `segmentation.ts` | Repeats/Key/Key from, ×N cells, key issues, *Make it repeat* |
| `apps/web/src/templates/TemplateEditor.tsx` | the same three inputs in the recipe editor's Sections sub-tab |
| `apps/web/src/templates/StepForms.tsx`, `editor-derive.ts` | Key column select and disabled reasons |
| `apps/web/src/workbench/StepsView.tsx`, `steps.ts` | the step card's repeat note |
| `apps/web/src/workbench/runs.ts`, `apps/web/src/jobs/derive.ts` | progress text with the occurrence |
| `CLAUDE.md`, `docs/architecture.md` | contract rows, segmentation paragraph |

---

### Task 1: Recipe format on the worker side

**Files:**
- Create: `packages/shared/test/fixtures/repeating-sections.json`
- Create: `worker/tests/covalidation.py`
- Modify: `worker/src/ingest_worker/specs.py` (`Section`, `DocumentLayout`, `DocumentSpec._cross_references`)
- Modify: `worker/src/ingest_worker/template.py` (`ExtractStep`, `Template._consistency`, `compile_step`)
- Modify: `worker/src/ingest_worker/workbench.py` (`SegmentDocument` validator)
- Test: `worker/tests/test_template.py`, `worker/tests/test_specs.py`

**Interfaces:**
- Produces:
  - `Section.repeat: bool`, `Section.key: str | None`, `Section.key_from: str | None` (alias `keyFrom`).
  - `specs.key_from_errors(sections: list[Section]) -> list[str]`.
  - `ExtractStep.key_column: str | None` (alias `keyColumn`).
  - `Template.repeating_section(step: ExtractStep) -> Section | None`.
  - In `worker/tests/covalidation.py`: `FIXTURE` (the parsed JSON), `RECIPE: dict[str, Any]` (= `FIXTURE["base"]`), `PAGES: list[str]`, `SECTIONS: list[Section]`.

- [ ] **Step 1: Write the fixture**

The fixture is `{"base": {...}, "cases": [{"name", "valid", "error", "sections"?, "pipeline"?}]}`. A case's `sections` replaces `base.document.sections` and its `pipeline` replaces `base.pipeline`. `error` is the quote-free tail, or `null` when `valid`.

`base`: id `covalidation`, version 1, name `Co-validation stability report`, and:
- Sections:
  - `front` (`\A`).
  - `batch`: anchor `^\d+\.\s+STUDY-\d+\s+-\s+BATCH\s+\d+`, repeat, key `BATCH\s+(\w+)`.
  - `appearance`: anchor `^Table \d+:.*-\s*Appearance and Water Content Results`, repeat, key `Batch\s+(\w+)`, keyFrom `batch`.
  - `microbial`: anchor `^Table \d+:.*-\s*Microbial Purity Results`, repeat, key `Batch\s+(\w+)`, keyFrom `batch`.
  - `conclusion`: anchor `^\d+\.\s+CONCLUSION`, required false.
- Outputs:
  - Field `study` (text).
  - Tables `batches` (`batch`, `packaging`), `appearance_results` (`batch`, `timepoint`, `result`) and `microbial_results` (`batch`, `timepoint`, `result`).
- Steps:
  - `header` (fields `[study]`, sections `[front]`).
  - `batches` (table `batches`, sections `[batch]`, keyColumn `batch`).
  - `appearance` (table `appearance_results`, sections `[appearance]`, keyColumn `batch`).
  - `microbial` (table `microbial_results`, sections `[microbial]`, keyColumn `batch`).

Cases:

| name | change | error |
| --- | --- | --- |
| covalidation | none | — |
| no repeat anywhere | sections without `repeat`/`key`/`keyFrom`, pipeline without `keyColumn` | — |
| keyFrom without own key | `appearance` drops `key` | — |
| named key group with another group | `batch.key` = `(BATCH|LOT)\s+(?P<key>\w+)` | — |
| chunked repeating step | `appearance` step adds `chunkPages: 1` | — |
| key without repeat | `conclusion` adds `key: "x"` | `key needs repeat` |
| keyFrom without repeat | `conclusion` adds `keyFrom: "batch"` | `keyFrom needs repeat` |
| key with two groups | `batch.key` = `(BATCH)\s+(\w+)` | `key must have at most one group, or a group named key` |
| keyFrom unknown section | `appearance.keyFrom` = `nope` | `must be a repeating section with a key and no keyFrom` |
| keyFrom non-repeating | `appearance.keyFrom` = `front` | `must be a repeating section with a key and no keyFrom` |
| keyFrom without key | `batch` drops `key` | `must be a repeating section with a key and no keyFrom` |
| keyFrom chain | `microbial.keyFrom` = `appearance` | `must be a repeating section with a key and no keyFrom` |
| keyFrom itself | `appearance.keyFrom` = `appearance` | `must be a repeating section with a key and no keyFrom` |
| field step on repeating section | `header` sections `[front, batch]` | `a field step cannot read a repeating section (batch); fill a table instead` |
| two repeating sections | `appearance` step sections `[appearance, microbial]`, `microbial` step removed and `microbial_results` filled by it | `reads more than one repeating section (appearance, microbial)` |
| keyColumn on non-repeating | `batches` step sections `[front]` | `keyColumn needs a repeating section with a key or keyFrom` |
| keyColumn unknown column | `appearance` step keyColumn `lot` | `keyColumn "lot" is not a column of appearance_results` (TypeScript form; Python asserts the tail `is not a column of appearance_results`) |

Store that last case's `error` as `is not a column of appearance_results`.

- [ ] **Step 2: Write `worker/tests/covalidation.py`**

`PAGES` is four pages:
1. `"STABILITY REPORT\nStudy STUDY-202432"`.
2. Batch 4586783: heading `1. STUDY-202432 - BATCH 4586783 (LDLS000) PACKED AS HDPE BOTTLE`, then `Table 1: Study-202432 - Batch 4586783 - Appearance and Water Content Results`, `T0 Complies`, `Table 2: Study-202432 - Batch 4586783 - Microbial Purity Results`, `T0 Complies`.
3. The same for 4586784, tables 3 and 4.
4. The same for 4586785, tables 5 and 6, then `4. CONCLUSION\nAll batches comply.`

`SECTIONS = [Section.model_validate(s) for s in RECIPE["document"]["sections"]]`.

- [ ] **Step 3: Write the failing tests**

```python
# worker/tests/test_template.py
from .covalidation import FIXTURE

def _definition(case: dict[str, Any]) -> dict[str, Any]:
    base = copy.deepcopy(FIXTURE["base"])
    if "sections" in case:
        base["document"]["sections"] = case["sections"]
    if "pipeline" in case:
        base["pipeline"] = case["pipeline"]
    return base

@pytest.mark.parametrize("case", FIXTURE["cases"], ids=[c["name"] for c in FIXTURE["cases"]])
def test_repeating_sections_match_the_shared_fixture(case: dict[str, Any]) -> None:
    if case["valid"]:
        Template.model_validate(_definition(case))
    else:
        with pytest.raises(ValidationError, match=re.escape(case["error"])):
            Template.model_validate(_definition(case))

def test_repeating_section_of_a_step() -> None:
    t = Template.model_validate(FIXTURE["base"])
    steps = {s.id: s for s in t.extract_steps()}
    assert t.repeating_section(steps["header"]) is None
    assert t.repeating_section(steps["appearance"]).id == "appearance"

def test_compile_step_merges_rows_for_a_repeating_step() -> None:
    t = Template.model_validate(FIXTURE["base"])
    assert compile_step(t, t.extract_steps()[2]).merge_path == "rows"
```

```python
# worker/tests/test_specs.py
def test_a_legacy_spec_cannot_repeat() -> None:
    raw = copy.deepcopy(<the smallest valid spec dict already used in this file>)
    raw["document"]["sections"][0]["repeat"] = True
    with pytest.raises(ValidationError, match="repeat is supported in recipes only"):
        DocumentSpec.model_validate(raw)

def test_a_segment_preview_checks_key_from() -> None:
    sections = copy.deepcopy(FIXTURE["base"]["document"]["sections"])
    sections[2]["keyFrom"] = "nope"
    with pytest.raises(ValidationError, match="must be a repeating section with a key"):
        SegmentDocument.model_validate({"sections": sections})
```

- [ ] **Step 4: Run them to verify they fail**

Run: `cd worker && uv run pytest tests/test_template.py tests/test_specs.py -k "repeating or repeat or key_from" -q`
Expected: FAIL, `Extra inputs are not permitted` for `repeat`/`key`/`keyFrom`/`keyColumn`.

- [ ] **Step 5: Implement**

- `Section`: add the three keys and a `model_validator(mode="after")` for the section rules. For the group count, wrap `re.compile(self.key, re.MULTILINE)` in `try`. On `re.error`, skip the check. Otherwise refuse when `groups > 1 and "key" not in groupindex`.
- `key_from_errors(sections)` in `specs.py`: for each section with `key_from`, the target must exist, `repeat`, have `key`, have no `key_from`. Call it from a validator on `DocumentLayout` (so `TemplateDocument` inherits it) and from `workbench.SegmentDocument._unique_section_ids`.
- `DocumentSpec._cross_references` adds the legacy message for any `section.repeat`.
- `ExtractStep.key_column`.
- In `Template._consistency`, append the step rules, using `Template.repeating_section` (the first read section with `repeat`, or `None`).
- In `compile_step`, use `"mergePath": "rows" if step.chunk_pages or template.repeating_section(step) else None`.

- [ ] **Step 6: Run the tests to verify they pass, then the contract and lint**

Run: `cd worker && uv run pytest tests/test_template.py tests/test_specs.py -q && cd .. && npm run worker:lint`
Expected: PASS. `test_specs.py` still loads every spec under `specs/`.

- [ ] **Step 7: Commit**

```bash
git add packages/shared/test/fixtures/repeating-sections.json worker/tests/covalidation.py worker/src/ingest_worker/specs.py worker/src/ingest_worker/template.py worker/src/ingest_worker/workbench.py worker/tests/test_template.py worker/tests/test_specs.py
git commit -m "Recipe format: repeating sections, keyFrom and keyColumn (worker)"
```

### Task 2: Recipe format on the TypeScript side

**Files:**
- Modify: `packages/shared/src/spec.ts` (`SectionSchema`, `DocumentSpecSchema` superRefine)
- Modify: `packages/shared/src/template.ts` (`ExtractStepSchema`, `TemplateSchema` superRefine)
- Modify: `packages/shared/src/workbench.ts` (`SegmentDocumentSchema` superRefine)
- Test: `packages/shared/test/spec.test.ts`, `packages/shared/test/template.test.ts`

**Interfaces:**
- Consumes: the fixture from Task 1.
- Produces:
  - `captureGroups(pattern: string): { count: number; names: string[] }`.
  - `keyFromIssues(sections: readonly Section[]): { index: number; message: string }[]`.
  - `Section.repeat?: boolean`, `Section.key?: string`, `Section.keyFrom?: string`, `ExtractStep.keyColumn?: string`.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/shared/test/template.test.ts
describe('repeating sections (shared with the worker)', () => {
  const fx = JSON.parse(readFileSync(new URL('./fixtures/repeating-sections.json', import.meta.url), 'utf8'));
  const definition = (c: Case) => ({
    ...fx.base,
    document: { ...fx.base.document, ...(c.sections ? { sections: c.sections } : {}) },
    ...(c.pipeline ? { pipeline: c.pipeline } : {}),
  });
  it.each(fx.cases.map((c: Case) => [c.name, c] as const))('%s', (_, c) => {
    const result = TemplateSchema.safeParse(definition(c));
    expect(result.success, JSON.stringify(result.error?.issues)).toBe(c.valid);
    if (!c.valid) expect(result.error!.issues.map((i) => i.message).join('\n')).toContain(c.error);
  });
  it('parses a recipe without repeat to itself', () => {
    const plain = TemplateSchema.parse(definition(fx.cases.find((c: Case) => c.name === 'no repeat anywhere')));
    for (const s of plain.document.sections) expect(Object.keys(s)).not.toContain('repeat');
    for (const s of plain.pipeline) expect(Object.keys(s)).not.toContain('keyColumn');
  });
});
```

```ts
// packages/shared/test/spec.test.ts
it.each([
  ['BATCH\\s+(\\w+)', 1, []],
  ['(?:BATCH|LOT)\\s+(\\w+)', 1, []],
  ['(?P<key>\\w+)', 1, ['key']],
  ['(?<key>\\w+)', 1, ['key']],
  ['\\(not a group\\)', 0, []],
  ['[(]x', 0, []],
  ['(a)(b)', 2, []],
])('captureGroups(%s)', (pattern, count, names) => {
  expect(captureGroups(pattern)).toEqual({ count, names });
});
it('refuses repeat in a legacy spec', () => {
  // the smallest valid spec already used in this file, with sections[0].repeat = true
  expect(messages(DocumentSpecSchema.safeParse(spec))).toContain('repeat is supported in recipes only');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project shared spec template`
Expected: FAIL, `Unrecognized key(s) in object: 'repeat'` and `captureGroups is not a function`.

- [ ] **Step 3: Implement**

- `captureGroups` scans the pattern once. It skips escaped characters and character classes. A `(` not followed by `?` counts. `(?P<name>` and `(?<name>` count and record the name; any other `(?` does not count.
- `SectionSchema` gains the three optional keys and a `.superRefine` with the section-level rules (it stays usable inside `z.object`/`z.array`, as in `drafting.ts`).
- `keyFromIssues` mirrors `key_from_errors`. It is called from the `document` checks of `DocumentSpecSchema`, `TemplateSchema` and `SegmentDocumentSchema`.
- `DocumentSpecSchema` adds the legacy refusal.
- `ExtractStepSchema` gains `keyColumn: Id.optional()`. The `TemplateSchema` superRefine adds the step rules with the messages from the global constraints.

- [ ] **Step 4: Run them to verify they pass, then the contract test and typecheck**

Run: `npx vitest run --project shared && npx vitest run apps/api/test/spec-registry.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/spec.ts packages/shared/src/template.ts packages/shared/src/workbench.ts packages/shared/test/spec.test.ts packages/shared/test/template.test.ts
git commit -m "Recipe format: repeating sections, keyFrom and keyColumn (shared)"
```

### Task 3: Segmentation yields occurrences, keys and key issues

**Files:**
- Modify: `worker/src/ingest_worker/segment.py`
- Test: `worker/tests/test_segment.py`

**Interfaces:**
- Consumes: `Section.repeat/key/key_from` (Task 1), `covalidation.PAGES/SECTIONS`.
- Produces:
  - `SectionSpan(id, start, end, index=0, key=None, own_key=None, key_source=None)`, with `key_source: Literal["own", "inherited"] | None`.
  - `occurrence_key(pattern: str, text: str) -> str | None`.
  - `section_spans(text, sections) -> tuple[list[SectionSpan], list[str]]` (signature unchanged).
  - `Occurrence(index: int, count: int, key: str | None, key_source: … | None, page: int | None, text: str)`, 1-based.
  - `KeyIssue(section: str, occurrence: int | None, message: str)`.
  - `key_issues(sections: list[Section], spans: list[SectionSpan]) -> list[KeyIssue]`.
  - `Segmented(sections: dict[str, str], occurrences: dict[str, list[Occurrence]], key_issues: list[KeyIssue])`.
  - `segment_occurrences(pages: list[str], sections: list[Section], page_marker: str | None = None) -> Segmented`.
  - `segment(...)` keeps returning `segment_occurrences(...).sections`.

- [ ] **Step 1: Write the failing tests**

```python
def _text() -> str:
    return PAGE_BREAK.join(PAGES)

@pytest.mark.parametrize(
    ("name", "sections", "expected"),  # expected: (id, index, key, key_source) in document order
    [
        ("non_repeating_unchanged", [Section(id="a", anchor="^Table")], [("a", 0, None, None)]),
        ("covalidation", SECTIONS, [
            ("front", 0, None, None),
            ("batch", 0, "4586783", "own"), ("appearance", 0, "4586783", "own"), ("microbial", 0, "4586783", "own"),
            ("batch", 1, "4586784", "own"), ("appearance", 1, "4586784", "own"), ("microbial", 1, "4586784", "own"),
            ("batch", 2, "4586785", "own"), ("appearance", 2, "4586785", "own"), ("microbial", 2, "4586785", "own"),
            ("conclusion", 0, None, None)]),
        ("key_from_nearest_preceding", <SECTIONS with appearance.key removed>,
            <as covalidation, appearance rows ("appearance", n, batch key, "inherited")>),
        ("key_group_named", [Section(id="b", anchor="^1\\.", repeat=True, key="(BATCH|LOT)\\s+(?P<key>\\w+)")], [("b", 0, "4586783", "own")]),
        ("key_whole_match", [Section(id="b", anchor="^1\\.", repeat=True, key="\\d{7}")], [("b", 0, "4586783", "own")]),
        ("key_no_match_is_none", [Section(id="b", anchor="^1\\.", repeat=True, key="LOT (\\w+)")], [("b", 0, None, None)]),
        ("zero_width_anchor", [Section(id="z", anchor="^(?=Table)", repeat=True)], <6 spans, one per caption>),
    ],
)
def test_section_spans_repeats(name, sections, expected) -> None:
    spans, _ = section_spans(_text(), sections)
    assert [(s.id, s.index, s.key, s.key_source) for s in spans] == expected

def test_an_occurrence_ends_at_the_next_start_of_any_section() -> None:
    spans, _ = section_spans(_text(), SECTIONS)
    first_microbial = next(s for s in spans if s.id == "microbial")
    assert "BATCH 4586784" not in _text()[first_microbial.start:first_microbial.end]

def test_own_key_wins_over_key_from() -> None:
    # appearance caption of batch 2 edited to say Batch 9999999
    spans, _ = section_spans(<text with that edit>, SECTIONS)
    s = [s for s in spans if s.id == "appearance"][1]
    assert (s.key, s.own_key, s.key_source) == ("9999999", "9999999", "own")

@pytest.mark.parametrize(
    ("name", "text_edit", "messages"),
    [
        ("clean", None, []),
        ("missing_for_one_batch", "batch 3 appearance caption reads 'Apperance'",
            ["appearance: no occurrence for batch 4586785"]),
        ("key_not_a_source_key", "batch 2 appearance caption says Batch 9999999",
            ["appearance occurrence 2: key 9999999 is not a batch key",
             "appearance occurrence 2: key 9999999 differs from batch 4586784 above it",
             "appearance: no occurrence for batch 4586784"]),
        ("occurrence_before_first_heading", "page 1 gains 'Table 1: ... Appearance and Water Content Results' without a batch",
            ["appearance occurrence 1: no key"]),
    ],
)
def test_key_issues(name, text_edit, messages) -> None:
    spans, _ = section_spans(<_text() with text_edit applied>, SECTIONS)
    assert [i.message for i in key_issues(SECTIONS, spans)] == messages

def test_sections_without_key_from_are_never_checked() -> None:
    plain = [s.model_copy(update={"key_from": None}) for s in SECTIONS]
    spans, _ = section_spans(<missing_for_one_batch text>, plain)
    assert key_issues(plain, spans) == []

def test_segment_occurrences_marks_pages_and_joins_text() -> None:
    result = segment_occurrences(mark_pages(PAGES, 1), SECTIONS, page_marker=PAGE_MARKER)
    occ = result.occurrences["appearance"]
    assert [(o.index, o.count, o.key, o.page) for o in occ] == [(1, 3, "4586783", 2), (2, 3, "4586784", 3), (3, 3, "4586785", 4)]
    assert all(o.text.startswith("[page ") for o in occ)
    assert result.sections["appearance"] == "\n\n".join(o.text for o in occ)
    assert "batch" in result.occurrences and "front" not in result.occurrences
    assert result.key_issues == []

def test_a_required_repeating_section_without_occurrences_is_missing() -> None:
    with pytest.raises(MissingSectionsError):
        segment_occurrences(["no tables here"], [Section(id="t", anchor="^Table", repeat=True)])
```

Sort the expected issue list as `key_issues` returns it: per `keyFrom` section in declaration order; per occurrence in document order (not a source key, then differs, then no key); then missing source keys in source order. Write that order into the docstring.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd worker && uv run pytest tests/test_segment.py -q`
Expected: FAIL, `ImportError: cannot import name 'segment_occurrences'`.

- [ ] **Step 3: Implement**

- `section_spans`: use `re.finditer` for repeating sections. Sort by `(start, order, index)`. Compute `own_key` with `occurrence_key(section.key, text[start:end])`. Then one pass in document order with `latest: dict[str, str]` sets `key = own_key or latest.get(key_from)` and `key_source`.
- `occurrence_key`: `m.group("key") if "key" in m.re.groupindex else m.group(1) if m.re.groups else m.group(0)`, stripped, `""` → `None`.
- `segment_occurrences`: keep `segment`'s body and page-marker prefixing per span. Occurrence `page` = the integer in the span's marker. Text of a repeating section = occurrences joined by `"\n\n"`.

- [ ] **Step 4: Run them to verify they pass, then the whole worker suite**

Run: `cd worker && uv run pytest -q`
Expected: PASS. The existing segment, pipeline and workbench tests are unchanged.

- [ ] **Step 5: Commit**

```bash
git add worker/src/ingest_worker/segment.py worker/tests/test_segment.py
git commit -m "Segmentation yields every occurrence of a repeating section, with keys and key issues"
```

### Task 4: Extraction plan per occurrence (pipeline layer)

**Files:**
- Modify: `worker/src/ingest_worker/pipeline.py` (`Prepared`, `prepare_document`, `RepeatPlan`, `run_step_extraction`, `_attempt_reporter`)
- Modify: `worker/src/ingest_worker/prompts.py`, `worker/src/ingest_worker/prompt_templates/extract.md.j2`
- Create: `worker/tests/test_prompts.py`, `worker/tests/fixtures/prompts/` (golden files)
- Test: `worker/tests/test_pipeline_repeat.py` (create)

**Interfaces:**
- Consumes: `segment_occurrences`, `Occurrence`, `KeyIssue` (Task 3).
- Produces:
  - `Prepared.occurrences: dict[str, list[Occurrence]] = field(default_factory=dict)`.
  - `Prepared.key_issues: list[KeyIssue] = field(default_factory=list)`.
  - `RepeatPlan(section_id: str, occurrences: list[Occurrence], key_column: str | None)`.
  - `run_step_extraction(job, deps, directory, ex, provider, model_id, sections, images, *, cache=None, progress=None, repeat: RepeatPlan | None = None) -> ExtractionResult`.
  - `progress(attempt: int, chunk: dict[str, int] | None, occurrence: dict[str, Any] | None)`, where `occurrence = {"n", "of", "key"}`.
  - `render_prompt(..., occurrence: dict[str, Any] | None = None)`, where `occurrence = {"index", "count", "key", "section"}`.

- [ ] **Step 1: Write the golden prompt test and capture the goldens before touching the template**

```python
# worker/tests/test_prompts.py
GOLDEN = Path(__file__).parent / "fixtures" / "prompts"

@pytest.mark.parametrize("step_id", ["header", "data"])  # a fields step, and the chunked table step of TEMPLATE
def test_builtin_prompt_unchanged_without_occurrence(step_id: str) -> None:
    from .test_template_pipeline import TEMPLATE
    t = Template.model_validate(TEMPLATE)
    ex = compile_step(t, next(s for s in t.extract_steps() if s.id == step_id))
    context = {**(ex.prompt_context or {}), "source_file": "doc.pdf"}
    sections = {"head": "[page 1]\nProduct: X", "body": "[page 2]\nBODY\nG1 1"}
    chunk = {"index": 1, "count": 2} if step_id == "data" else None
    prompt = render_prompt(None, ex.prompt, sections, ex.sections, chunk, context)
    path = GOLDEN / f"{step_id}.md"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(prompt, encoding="utf-8")
        pytest.fail(f"golden written to {path}; re-run")
    assert prompt == path.read_text(encoding="utf-8")
```

Run it twice (`cd worker && uv run pytest tests/test_prompts.py -q`). The first run writes the goldens and fails; the second passes. Commit the goldens on their own:

```bash
git add worker/tests/test_prompts.py worker/tests/fixtures/prompts
git commit -m "Golden built-in prompts before repeating sections"
```

- [ ] **Step 2: Write the failing pipeline tests**

In `worker/tests/test_pipeline_repeat.py`, call `run_step_extraction` directly with a `FakeProvider`, a `MemoryObjectStore` in `PipelineDeps` and `ex = compile_step(Template(RECIPE), step)`. Use the occurrences from `segment_occurrences(mark_pages(PAGES, 1), SECTIONS, PAGE_MARKER)`.

```python
def test_one_call_per_occurrence_with_the_key_filled_by_the_worker() -> None:
    provider = FakeProvider("local", responses=[{"rows": [{"timepoint": "T0", "result": "Complies"}]}] * 3)
    result = run_step_extraction(..., repeat=RepeatPlan("appearance", occ["appearance"], "batch"))
    assert len(provider.calls) == 3
    requests = [r for _, r in provider.calls]
    assert "occurrence 2 of 3" in requests[1].prompt and "key: 4586784" in requests[1].prompt
    assert '<section id="appearance" occurrence="2" key="4586784">' in requests[1].prompt
    assert "batch" not in requests[0].json_schema["properties"]["rows"]["items"]["properties"]
    assert "batch" not in requests[0].json_schema["properties"]["rows"]["items"]["required"]
    assert [r["batch"] for r in result.data["rows"]] == ["4586783", "4586784", "4586785"]

def test_occurrences_times_chunks() -> None:
    ex = ex.model_copy(update={"chunk_pages": 1, "merge_path": "rows"})  # 1 page per occurrence here: 3 calls
    # audit ids: runs bucket keys contain "appearance.occ-2.chunk-1"

def test_no_occurrences_makes_no_call_and_no_cache_entry() -> None:
    result = run_step_extraction(..., cache=<MemoryStepCache>, repeat=RepeatPlan("appearance", [], "batch"))
    assert provider.calls == [] and result.data == {"rows": []} and <cache is empty>

def test_progress_reports_the_occurrence() -> None:
    seen = []
    run_step_extraction(..., progress=lambda a, c, o: seen.append(o), repeat=...)
    assert seen == [{"n": 1, "of": 3, "key": "4586783"}, {"n": 2, "of": 3, "key": "4586784"}, {"n": 3, "of": 3, "key": "4586785"}]

def test_step_cache_round_trip_with_key_column() -> None:
    # first run stores, second run with the same occurrences hits (no calls, rows with batch),
    # changing one occurrence's text misses
```

Use the step-cache fake the existing step-cache tests use (`grep -n "StepCache" worker/tests/*.py`).

- [ ] **Step 3: Run them to verify they fail**

Run: `cd worker && uv run pytest tests/test_pipeline_repeat.py -q`
Expected: FAIL, `TypeError: run_step_extraction() got an unexpected keyword argument 'repeat'`.

- [ ] **Step 4: Implement**

- `prepare_document` calls `segment_occurrences`, fills `Prepared.occurrences`/`key_issues`, and adds `"occurrences": {id: len(list)}` to the `SEGMENTED` event only when non-empty.
- `render_prompt` passes `occurrence` (default `None`).
- In `extract.md.j2`, the occurrence paragraph (spec section 3) goes after the chunk paragraph, inside `{% if occurrence %}`. The section tag becomes `<section id="{{ section.id }}"{% if occurrence and section.id == occurrence.section %} occurrence="{{ occurrence.index }}"{% if occurrence.key %} key="{{ occurrence.key }}"{% endif %}{% endif %}>`.
- `run_step_extraction` builds `plan` as a list of `(audit_id, sections, chunk, occurrence)` over occurrences × chunks. It uses a per-call schema equal to `ex.schema_` with `key_column` removed from the row `properties` and `required`, and sets `row[key_column] = occurrence.key` on each call's rows before merging. Validation of a cache hit and the merged result keep using `ex.schema_`. When `repeat.occurrences` is empty it returns `ExtractionResult({"rows": []}, f"{provider.name}/{model_id}", [])` before any cache lookup.

- [ ] **Step 5: Run the tests to verify they pass, plus the goldens and the whole suite**

Run: `cd worker && uv run pytest -q && cd .. && npm run worker:lint`
Expected: PASS, with `test_prompts.py` unchanged.

- [ ] **Step 6: Commit**

```bash
git add worker/src/ingest_worker/pipeline.py worker/src/ingest_worker/prompts.py worker/src/ingest_worker/prompt_templates/extract.md.j2 worker/tests/test_pipeline_repeat.py
git commit -m "Extraction runs once per occurrence of a repeating section"
```

### Task 5: Template jobs: plan wiring, issues, review reason, progress events

**Files:**
- Modify: `worker/src/ingest_worker/template_pipeline.py` (`Progress`, `step_reporter`, `_run_step`, `process_template_job`, `rerun_template_job`, `_normalise_step` caller, `_review_reasons`)
- Modify: `packages/shared/src/jobs.ts` (`StepProgressSchema`, `JobProgressSchema` step arm), `packages/shared/test/fixtures/step-progress.json`
- Test: `worker/tests/test_template_pipeline.py`, `packages/shared/test/jobs.test.ts`

**Interfaces:**
- Consumes: `RepeatPlan`, `run_step_extraction(repeat=)`, `progress(attempt, chunk, occurrence)` (Task 4); `Template.repeating_section` (Task 1); `Prepared.key_issues`.
- Produces:
  - Step progress event data gains `occurrence: {"n", "of", "key"} | None`.
  - `StepProgress.occurrence: { n: number; of: number; key: string | null } | null`.
  - The review reason `f"{n} section key issue(s)"`.

- [ ] **Step 1: Write the failing tests**

Add a `run_covalidation(tmp_path, pages=PAGES, responses=None)` helper beside `run_job`, using `RECIPE` and `PAGES` from `covalidation.py`. The default responses are one per call, in plan order: `header`, 3 × `batches`, 3 × `appearance`, 3 × `microbial`.

```python
def test_covalidation_rows_carry_the_batch(tmp_path: Path) -> None:
    provider, store, queue = run_covalidation(tmp_path)
    assert len(provider.calls) == 10
    doc = json.loads(store.get("outputs", "covalidation/v1/document/doc-1.json"))
    assert [r["batch"] for r in doc["tables"]["appearance_results"]] == ["4586783", "4586784", "4586785"]
    assert [r["batch"] for r in doc["tables"]["batches"]] == ["4586783", "4586784", "4586785"]
    assert not [i for i in doc["issues"] if i["step"] == "segment"]

def test_inherited_key_fills_the_key_column(tmp_path: Path) -> None:
    pages = <PAGES with "Batch 4586784 - " removed from batch 2's appearance caption>
    _, store, _ = run_covalidation(tmp_path, pages=pages)
    doc = json.loads(...)
    assert doc["tables"]["appearance_results"][1]["batch"] == "4586784"

def test_a_table_missed_for_one_batch_goes_to_review(tmp_path: Path) -> None:
    pages = <PAGES with batch 3's microbial caption misspelt "Microbal">  # 9 calls: microbial ×2
    _, store, queue = run_covalidation(tmp_path, pages=pages, responses=<9 responses>)
    doc = json.loads(...)
    assert {"step": "segment", "target": "microbial", "row": None, "column": None, "raw": None,
            "message": "microbial: no occurrence for batch 4586785"} in doc["issues"]
    assert "1 section key issue(s)" in doc["review_reasons"] and queue.awaiting

def test_list_of_tables_is_an_extra_occurrence_and_a_key_issue(tmp_path: Path) -> None:
    pages = <page 1 gains "Table 1: Study-202432 - Appearance and Water Content Results">  # no batch, before any heading
    _, store, queue = run_covalidation(tmp_path, pages=pages, responses=<appearance gets 4 calls; the first returns no rows>)
    doc = json.loads(...)
    assert "appearance occurrence 1: no key" in [i["message"] for i in doc["issues"]]
    assert queue.awaiting and not queue.failed

def test_a_row_without_a_key_is_an_issue(tmp_path: Path) -> None:
    # batch 2 heading and caption both lose the number: own key None, inherited None
    ...
    assert {"step": "appearance", "target": "appearance_results", "row": 2, "column": "batch", "raw": None,
            "message": "no key found in this row's occurrence of appearance"} in doc["issues"]

def test_step_progress_events_carry_the_occurrence(tmp_path: Path) -> None:
    _, _, queue = run_covalidation(tmp_path)
    progress = [d for _, _, m, d in <queue.events with data> if m == STEP_PROGRESS]
    assert [p["occurrence"] for p in progress if p["step"] == "appearance"] == [
        {"n": 1, "of": 3, "key": "4586783"}, {"n": 2, "of": 3, "key": "4586784"}, {"n": 3, "of": 3, "key": "4586785"}]
    assert all(p["occurrence"] is None for p in progress if p["step"] == "header")

def test_rerun_keeps_segment_issues_once(tmp_path: Path) -> None:
    # run the missed-table case, then rerun_template_job for "appearance": 3 calls,
    # the segment issue still appears exactly once
```

Look up how the existing tests read event data (`FakeQueue.events` shape) and match it.

```ts
// packages/shared/test/jobs.test.ts
it('reads step progress with and without an occurrence', () => {
  for (const c of stepProgressFixture.cases) expect(StepProgressSchema.parse(c.event)).toEqual(c.parsed);
});
```

Add to `step-progress.json` a case without `occurrence` (parsed `occurrence: null`) and one with `{"n": 2, "of": 3, "key": "4586784"}`. If the fixture's current shape differs, extend it in its own shape and keep the Python reader of that fixture passing.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd worker && uv run pytest tests/test_template_pipeline.py -k "covalidation or key or occurrence or rerun_keeps" -q` and `npx vitest run --project shared jobs`
Expected: FAIL. The worker sends `batch` unset (no plan wired), and Zod reports an unknown key or missing `occurrence`.

- [ ] **Step 3: Implement**

- `Progress = Callable[[int, dict[str, Any] | None, dict[str, Any] | None], None]`, and `step_reporter` writes `"occurrence"`.
- `_run_step` builds `RepeatPlan(section.id, doc.occurrences.get(section.id, []), step.key_column)` when `loaded.template.repeating_section(step)` is set.
- After `_normalise_step`, a table step with `key_column` adds the "no key found" issue for every row whose key column is `None`.
- `process_template_job` extends `issues` once with `doc.key_issues` in the segment issue shape. `rerun_template_job` keeps the job's existing `segment` issues and never re-adds them.
- `_review_reasons` counts `step == "segment"` issues apart: `normalisation issue(s)` counts the others, and `section key issue(s)` counts these.
- `StepProgressSchema.occurrence` is `z.object({ n, of, key: z.string().nullable() }).nullable().default(null)`. The `JobProgressSchema` step arm gets the same field.

- [ ] **Step 4: Run the tests to verify they pass, plus both suites**

Run: `npm run worker:test && npx vitest run --project shared`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/ingest_worker/template_pipeline.py worker/tests/test_template_pipeline.py packages/shared/src/jobs.ts packages/shared/test/jobs.test.ts packages/shared/test/fixtures/step-progress.json
git commit -m "Template jobs: per-occurrence steps, key issues and occurrence progress"
```

### Task 6: Preview grid

**Files:**
- Modify: `worker/src/ingest_worker/workbench.py` (`segment_samples`)
- Modify: `packages/shared/src/workbench.ts` (`OccurrenceCellSchema`, `SectionCellSchema`, `SegmentedSampleSchema`)
- Test: `worker/tests/test_workbench_segment.py`, `packages/shared/test/workbench.test.ts`

**Interfaces:**
- Consumes: `section_spans`, `key_issues` (Task 3).
- Produces:
  - `OccurrenceCell { page: number | null; line: string | null; chars: number; key: string | null; keySource: 'own' | 'inherited' | null }`.
  - `SectionCell.occurrences: OccurrenceCell[]`, `SectionCell.matches: number`.
  - `SegmentedSample.keyIssues: string[]`.

- [ ] **Step 1: Write the failing tests**

```python
def test_segment_samples_reports_occurrences_matches_and_key_issues() -> None:
    sections = [*SECTIONS, Section(id="tables", anchor="^Table", required=False)]  # non-repeating, 6 matches
    grid = segment_samples([("s1", PAGES), ("s2", <PAGES with batch 3 microbial caption misspelt>)],
                           SegmentDocument(sections=sections))
    s1 = {c["id"]: c for c in grid["samples"][0]["sections"]}
    assert [(o["page"], o["key"], o["keySource"]) for o in s1["appearance"]["occurrences"]] == [
        (2, "4586783", "own"), (3, "4586784", "own"), (4, "4586785", "own")]
    assert s1["appearance"]["page"] == 2 and s1["appearance"]["chars"] == sum(o["chars"] for o in s1["appearance"]["occurrences"])
    assert s1["tables"]["matches"] == 6 and s1["front"]["matches"] == 1 and s1["appearance"]["matches"] == 0
    assert s1["front"]["occurrences"] == []
    assert grid["samples"][0]["keyIssues"] == []
    assert grid["samples"][1]["keyIssues"] == ["microbial: no occurrence for batch 4586785"]

def test_an_invalid_key_is_an_anchor_error() -> None:
    sections = copy.deepcopy(RECIPE["document"]["sections"]); sections[1]["key"] = "BATCH (\\w+"
    grid = segment_samples([("s1", PAGES)], SegmentDocument.model_validate({"sections": sections}))
    assert "batch.key" in grid["anchorErrors"]
```

```ts
it('reads a grid stored before repeating sections', () => {
  const parsed = SegmentationResultSchema.parse(<an existing stored-grid literal from this file>);
  expect(parsed.samples[0].keyIssues).toEqual([]);
  expect(parsed.samples[0].sections[0]).toMatchObject({ occurrences: [], matches: 0 });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd worker && uv run pytest tests/test_workbench_segment.py -q` and `npx vitest run --project shared workbench`
Expected: FAIL, `KeyError: 'occurrences'` and `undefined` instead of `[]`.

- [ ] **Step 3: Implement**

- Group spans by id; the first span gives `page`/`line`, and `chars` sums all spans.
- `matches = len(re.findall(section.anchor, text, re.MULTILINE))` for non-repeating sections, `0` for repeating ones.
- Before segmenting, `_regex_error(section.key)` on each section with a key adds `anchorErrors[f"{id}.key"]`, and that key is dropped from the section for this preview (`model_copy(update={"key": None})`).
- `keyIssues = [i.message for i in key_issues(valid, spans)]`.
- Zod defaults as in the global constraints.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm run worker:test && npx vitest run --project shared`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add worker/src/ingest_worker/workbench.py worker/tests/test_workbench_segment.py packages/shared/src/workbench.ts packages/shared/test/workbench.test.ts
git commit -m "Segmentation preview shows occurrences, repeated matches and key issues"
```

### Task 7: Drafting stages

**Files:**
- Modify: `worker/src/ingest_worker/draft_stages.py` (`SECTIONS_SCHEMA`, `convert_sections`, `check_sections`, `SECTIONS` prompt, `STEPS_SCHEMA`, `convert_steps`, `STEPS` prompt)
- Modify: `packages/shared/test/fixtures/draft-changes.json`
- Test: `worker/tests/test_draft_stages.py`, `worker/tests/test_draft_changes.py`, `packages/shared/test/drafting.test.ts`

**Interfaces:**
- Consumes: the `Section`/`ExtractStep` keys (Task 1), the TypeScript schemas (Task 2).
- Produces:
  - Sections stage items gain `repeat: boolean|null`, `key: string|null`, `keyFrom: string|null`.
  - Steps stage items gain `keyColumn: string|null`.
  - The revise schema derives from these with sentinels (`false`, `""`).

- [ ] **Step 1: Write the failing tests**

```python
def test_convert_sections_carries_repeat_key_and_key_from() -> None:
    body, errors = SECTIONS.convert({"notes": "", "changes": [
        {"op": "putSection", "id": "appearance", "anchor": "^Table \\d+:.*Appearance", "required": None,
         "description": None, "copiesSelect": None, "repeat": True, "key": "Batch\\s+(\\w+)", "keyFrom": "batch", "reason": "r"}]})
    assert errors == []
    assert body["changes"][0]["section"] == {"id": "appearance", "anchor": "^Table \\d+:.*Appearance",
        "repeat": True, "key": "Batch\\s+(\\w+)", "keyFrom": "batch"}

def test_convert_sections_leaves_out_nulls() -> None:
    # repeat/key/keyFrom None -> section has none of the three keys

def test_check_sections_refuses_an_invalid_key() -> None:
    errors = SECTIONS.check(<body with key "Batch (\\w+">, <draft>)
    assert any("invalid regular expression" in e and "key" in e for e in errors)

def test_convert_steps_carries_key_column() -> None:
    # putStep extract with keyColumn "batch" -> step["keyColumn"] == "batch"

def test_revise_sentinels_mean_absent() -> None:
    # a revise putSection payload with repeat False, key "", keyFrom "" -> section without the keys;
    # a putStep with keyColumn "" -> step without keyColumn

def test_sections_prompt_mentions_repeat_and_key_from() -> None:
    assert "repeat true" in SECTIONS.prompt and "keyFrom" in SECTIONS.prompt
    assert "keyColumn" in STEPS.prompt
```

`test_schemas_stay_under_the_anthropic_union_type_limit` needs no change: sections go from 4 to 7 unions and steps from 13 to 14. Run it.

Add a `draft-changes.json` case, "put a repeating section and a keyColumn step": `putSection` `batch` and `appearance` (with `keyFrom`), then `putStep` `appearance` with `keyColumn`, plus the expected definition. It runs in `drafting.test.ts` and `test_draft_changes.py` through the existing fixture loops.

- [ ] **Step 2: Run them to verify they fail**

Run: `cd worker && uv run pytest tests/test_draft_stages.py tests/test_draft_changes.py -q` and `npx vitest run --project shared drafting`
Expected: FAIL, because the converted section lacks `repeat`.

- [ ] **Step 3: Implement**

- `SECTIONS_SCHEMA` items gain `"repeat": {"type": ["boolean", "null"]}`, `"key": _NS`, `"keyFrom": _NS`. `convert_sections` reads `("id", "anchor", "required", "description", "repeat", "key", "keyFrom")`.
- `check_sections` applies `_regex_error` to `section.get("key")` with the message `section {id!r}: key: invalid regular expression: {error}`.
- `STEPS_SCHEMA` gains `"keyColumn": _NS`.
- Prompts: the sections prompt adds the two sentences from spec section 4. If option 1's "one big section" steer is present, replace it, and make its repeated-match feedback name non-repeating sections only. The anchor-round feedback appends each sample's `keyIssues`. The steps prompt adds the `keyColumn` sentence.

- [ ] **Step 4: Run them to verify they pass**

Run: `npm run worker:test && npx vitest run --project shared`
Expected: PASS, including the union-limit test.

- [ ] **Step 5: Commit**

```bash
git add worker/src/ingest_worker/draft_stages.py worker/tests/test_draft_stages.py worker/tests/test_draft_changes.py packages/shared/test/fixtures/draft-changes.json packages/shared/test/drafting.test.ts
git commit -m "Drafting proposes repeating sections, keyFrom and key columns"
```

### Task 8: Sections editing (Workbench Sections tab and recipe editor)

**Files:**
- Modify: `apps/web/src/workbench/SectionsTab.tsx` (`Row`, `candidate`, row loading at lines ~100 and ~123, the section form)
- Modify: `apps/web/src/workbench/SegmentationGrid.tsx`, `apps/web/src/workbench/segmentation.ts`
- Modify: `apps/web/src/templates/TemplateEditor.tsx` (the sections list near line 671)
- Test: `apps/web/test/SectionsTab.test.tsx`, `apps/web/test/SegmentationGrid.test.tsx`, `apps/web/test/segmentation.test.ts`

**Interfaces:**
- Consumes: `Section` keys (Task 2), `SectionCell.occurrences/matches`, `SegmentedSample.keyIssues` (Task 6).
- Produces:
  - `occurrenceSummary(cell: SectionCell): string | null` (`"×3 · 4586783 · 4586784 · 4586785"`, null without occurrences).
  - `repeatHint(cell: SectionCell): string | null` (`"matches 3×, only the first is used"` when `matches > 1`).
  - `keyFromOptions(sections: readonly { id: string; repeat?: boolean; key?: string; keyFrom?: string }[], self: string): string[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// segmentation.test.ts
it.each([
  [{ occurrences: [] }, null],
  [{ occurrences: [{ key: '4586783' }, { key: '4586784' }, { key: null }] }, '×3 · 4586783 · 4586784 · no key'],
])('occurrenceSummary', (cell, text) => expect(occurrenceSummary(cell as SectionCell)).toBe(text));
it.each([[0, null], [1, null], [3, 'matches 3×, only the first is used']])('repeatHint(%i)', (matches, text) =>
  expect(repeatHint({ matches, occurrences: [] } as unknown as SectionCell)).toBe(text));
it('offers repeating sections with their own key, not itself or chained ones', () => {
  expect(keyFromOptions(RECIPE_SECTIONS, 'appearance')).toEqual(['batch']);
});
```

```tsx
// SectionsTab.test.tsx
it('keeps repeat, key and keyFrom when anchors are saved', async () => {
  // draft with the covalidation sections; edit batch's anchor; Save
  // expect the saved definition's sections to keep repeat/key/keyFrom on every section
});
it('shows Key and Key from once Repeats is ticked, and previews them', async () => {
  // tick "Repeats" on conclusion -> textbox "Key" and combobox "Key from" appear;
  // the preview request's candidate document carries repeat: true
});
it('Make it repeat sets Repeats on a section whose anchor matches 3 times', async () => {
  // grid cell with matches: 3 -> button "Make it repeat" -> checkbox "Repeats" checked, unsaved bar shown
});
// SegmentationGrid.test.tsx
it('shows occurrences with keys and an inherited key marked', ...);  // "×3", "from batch"
it('lists a sample’s key issues', ...);  // text "microbial: no occurrence for batch 4586785"
```

Add a `TemplateEditor` test in its existing test file: on the Sections sub-tab, ticking *Repeats* on section 2 sets `document.sections[1].repeat` in the YAML view.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project web segmentation SectionsTab SegmentationGrid TemplateEditor`
Expected: FAIL, with no "Repeats" checkbox and the saved sections lacking `repeat`.

- [ ] **Step 3: Implement**

- `Row` gains `repeat?`, `key?`, `keyFrom?`. Row loading and `candidate()` copy them (only when set). The form adds *Repeats* (checkbox); when it is ticked, *Key* (text, with the `anchorErrors["<id>.key"]` message inline) and *Key from* (select: *None*, then `keyFromOptions`). Unticking *Repeats* clears `key` and `keyFrom`.
- In the grid cell, show `occurrenceSummary`, expanding to one line per occurrence. An inherited key is shown in italics with "from <keyFrom>". `repeatHint` gets a *Make it repeat* button wired like an anchor suggestion. Each sample row with `keyIssues` gets a warn list.
- `TemplateEditor`'s sections list gets the same three inputs through `update(['document', 'sections', i, …])`. Unticking deletes the keys rather than writing `false`.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run --project web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/workbench/SectionsTab.tsx apps/web/src/workbench/SegmentationGrid.tsx apps/web/src/workbench/segmentation.ts apps/web/src/templates/TemplateEditor.tsx apps/web/test/SectionsTab.test.tsx apps/web/test/SegmentationGrid.test.tsx apps/web/test/segmentation.test.ts
git commit -m "Sections editing: repeating sections, keys and occurrence cells"
```

### Task 9: Step form, Steps tab and progress text

**Files:**
- Modify: `apps/web/src/templates/StepForms.tsx` (`ExtractStep`), `apps/web/src/templates/PipelineEditor.tsx` (pass the section definitions), `apps/web/src/templates/editor-derive.ts`
- Modify: `apps/web/src/workbench/StepsView.tsx`, `apps/web/src/workbench/steps.ts`
- Modify: `apps/web/src/workbench/runs.ts` (`progressText`), `apps/web/src/jobs/derive.ts` (`stepText`)
- Test: `apps/web/test/editor-derive.test.ts`, `apps/web/test/steps-derive.test.ts`, `apps/web/test/runs-derive.test.ts`, `apps/web/test/jobs-derive.test.ts`, `apps/web/test/StepsTab.test.tsx`

**Interfaces:**
- Consumes: `Section` and `ExtractStep` keys (Task 2), `StepProgress.occurrence` (Task 5).
- Produces:
  - `repeatNote(step: { sections: string[]; table?: string; fields?: string[] }, sections: readonly Section[]): { note: string | null; disabled: Record<string, string>; keyColumnReason: string | null }` in `editor-derive.ts`.
  - `ExtractStep` takes `sectionDefs: readonly Section[]` in place of `sections: string[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// editor-derive.test.ts
it.each([
  ['table step on a repeating section', { table: 'appearance_results', sections: ['appearance'] },
    { note: 'Runs once per occurrence of appearance', disabled: {}, keyColumnReason: null }],
  ['field step', { fields: ['study'], sections: ['front'] },
    { note: null, disabled: { batch: "a field step can't read a repeating section", appearance: "a field step can't read a repeating section", microbial: "a field step can't read a repeating section" }, keyColumnReason: 'reads no repeating section' }],
  ['repeating section without key or keyFrom', { table: 't', sections: ['plain_repeat'] },
    { note: 'Runs once per occurrence of plain_repeat', disabled: {}, keyColumnReason: 'plain_repeat has no key' }],
])('repeatNote: %s', (_, step, expected) => expect(repeatNote(step, SECTIONS)).toEqual(expected));
// runs-derive.test.ts
it('progressText names the occurrence', () => expect(progressText({ step: 'appearance', index: 3, of: 4, attempt: 1,
  chunk: null, occurrence: { n: 2, of: 3, key: '4586784' } })).toBe('Step 3 of 4 · appearance · occurrence 2 of 3 (4586784)'));
// jobs-derive.test.ts
it('stepText names the occurrence', ...);  // 'Step 3 of 4 · occurrence 2 of 3 (4586784)'; with a chunk too: '… · part 1 of 2'
// StepsTab.test.tsx
it('a step card names its repeating section and key column', ...);  // 'Once per appearance · batch from its key'
```

Add a `PipelineEditor`/`StepForms` test (in the file that already covers the step form): a table step with `appearance` ticked shows the combobox *Key column* with *None* first and then the table's columns, and choosing `batch` sets `keyColumn`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run --project web editor-derive steps-derive runs-derive jobs-derive StepsTab`
Expected: FAIL, `repeatNote is not a function` and text without the occurrence.

- [ ] **Step 3: Implement**

- Implement `repeatNote` per the tests. `ExtractStep` renders the note, disables the sections listed in `disabled` (with the reason in the label's `title`), and shows *Key column* only for a table step reading a repeating section. The select is disabled with `keyColumnReason` when one is set, and choosing *None* deletes `keyColumn`.
- `progressText` and `stepText` add `occurrence n of m (key)` before the chunk/part segment (no `(key)` when the key is null).
- `StepsView` uses the new `steps.ts` helper text.

- [ ] **Step 4: Run them to verify they pass**

Run: `npx vitest run --project web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/templates apps/web/src/workbench/StepsView.tsx apps/web/src/workbench/steps.ts apps/web/src/workbench/runs.ts apps/web/src/jobs/derive.ts apps/web/test
git commit -m "Recipe step form, Steps tab and run progress know repeating sections"
```

### Task 10: Docs and the full check

**Files:**
- Modify: `CLAUDE.md`, `docs/architecture.md`, `docs/superpowers/specs/2026-10-16-repeating-sections-design.md` (status line)

- [ ] **Step 1: Update the docs**

In `CLAUDE.md`'s contract table:
- Spec format row: add `repeat`, `key`, `keyFrom` on sections, `keyColumn` on template steps, `captureGroups`/`keyFromIssues` (TypeScript) and `key_from_errors`/`segment.key_issues` (Python).
- Test-run step progress row: add `occurrence`.
- Workbench prepared text and segmentation row: add `occurrences`, `matches`, `keyIssues`, `anchorErrors["<id>.key"]`.

In `docs/architecture.md`, add one paragraph on repeating sections to the segmentation description. In the spec, set `Status: implemented`.

- [ ] **Step 2: Run everything CI runs**

Run: `npm run check && npm run worker:test && npm run worker:lint`
Expected: all green.

- [ ] **Step 3: Check it by hand in the Workbench with real `covalidation` samples**

Expected:
- The Sections preview shows ×3 on every table section and no key issues.
- A dev test run gives 3 batches per table with the right `batch`.
- Breaking one caption anchor so batch 3 is missed shows the key issue in the grid and sends a test run to review with `1 section key issue(s)`.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/architecture.md docs/superpowers/specs/2026-10-16-repeating-sections-design.md
git commit -m "Docs: repeating sections"
```

## Order and parallelism

1 → 2 (Task 2 reads Task 1's fixture) → 3 → 4 → 5. Task 6 needs 3 and can run beside 4–5. Task 7 needs 1–2. Task 8 needs 2 and 6; Task 9 needs 2 and 5. Tasks 8 and 9 touch disjoint files and can run in parallel. Task 10 is last.
