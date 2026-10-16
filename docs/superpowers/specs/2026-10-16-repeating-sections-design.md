# Repeating sections in the recipe format

Date: 2026-10-16 · Status: proposed (design only, not built) · Follows the short-term fix
("option 1": the sections drafting stage counts repeated anchor matches and steers to one big
section; the Steps prompt tells table steps to take batch ids from captions)

## Problem

Segmentation (`worker/src/ingest_worker/segment.py`, `section_spans`) starts each section at the
**first** match of its anchor and runs it to the next matched anchor. It is shared by production
(`pipeline.prepare_document` → `segment`) and the Workbench preview grid
(`workbench.segment_samples`). Documents whose blocks repeat per entity break this.

The motivating document type is `covalidation`, a stability report. For each of 3 batches it has
a heading and the same five tables:

```
[page 4]
1. STUDY-202432 - BATCH 4586783 (LDLS000) PACKED AS HDPE BOTTLE 30 CT
Table 1: Study-202432 - Batch 4586783 - Appearance and Water Content Results
  … rows …
Table 2: Study-202432 - Batch 4586783 - Assay and Chromatographic Purity Results
  … rows …
Table 3: Study-202432 - Batch 4586783 - Dissolution Results
Table 4: Study-202432 - Batch 4586783 - Solid State by NIR Results
Table 5: Study-202432 - Batch 4586783 - Microbial Purity Results
[page 9]
2. STUDY-202432 - BATCH 4586784 (LDLS000) PACKED AS …
Table 6: Study-202432 - Batch 4586784 - Appearance and Water Content Results
  … (tables 6-10) …
3. STUDY-202432 - BATCH 4586785 (LDLS000) PACKED AS …
  … (tables 11-15) …
4. CONCLUSION
```

With one section per table (`appearance`, `assay`, `dissolution`, `nir`, `microbial`), today's
segmentation gives `appearance`…`nir` batch 1's table only, and `microbial` runs from Table 5 to
`conclusion`, swallowing batches 2 and 3 whole (tables 6-15). Four of five tables lose two
thirds of their rows; the fifth gets the other tables' rows mixed in. Option 1 works around this
with one big section per document and a prompt that reads batch ids from captions; it depends on
the model keeping 15 tables apart in one call and on the output budget.

## Goal

A section can say that it **repeats**. Segmentation yields every occurrence instead of the first;
an extract step reading a repeating section runs once per occurrence, told which occurrence it
reads; and a table step can have the worker fill one column of every row with that occurrence's
**key** (the batch, read from the caption or heading by a regex), so the batch column is exact
rather than the model's reading.

Success, on `covalidation`: five table steps, each reading one repeating section, produce
3 batches × rows each, every row carrying the right batch number, without a big catch-all
section and without the model choosing the batch.

## Decisions

1. **Flat repeats, no nesting** in this design. Each repeating section matches every
   occurrence itself, and its key is read from its own occurrence text. `covalidation`'s
   captions all carry the batch, so five repeating table sections (plus an optional repeating
   `batch` heading section) cover it. A nested form (a repeating `batch` parent whose children
   are the tables, segmented inside each parent occurrence) is a bigger change to the format
   (sections become a tree), to `section_spans`, to the grid and to the drafting schemas, and
   adds little for documents whose child anchors carry the key. A cheap follow-up covers the
   remaining case (children whose text lacks the key) without a tree: `keyFrom` (see Open
   questions).
2. **One model call per occurrence**, like `chunkPages` (one call per chunk), not one call with
   labelled blocks. The occurrence's rows are attributed by construction, the key column is
   filled by the worker, each call's output stays within budget, and a failure names the
   occurrence. Cost grows with occurrences (15 calls for `covalidation` instead of 5); a
   labelled single call is listed as an open question.
3. **Field steps cannot read a repeating section** (a field is one value per document). A
   per-batch heading becomes a table (one row per occurrence) instead.
4. **A step reads at most one repeating section.** Other (non-repeating) sections it reads are
   sent with every occurrence, as `chunkPages` sends the other sections with every chunk.
5. **Templates only.** Legacy `spec.yaml` (`pipeline.py`) refuses `repeat`.
6. **Absent means today's behaviour, byte for byte.** The new keys are optional on both sides,
   never defaulted into a stored definition, so published recipes, their `stableJson`
   snapshots (publish gate, iterations), YAML exports and prompts are unchanged.

## 1. Format

### Section (`SectionSchema` in `packages/shared/src/spec.ts`, `Section` in `specs.py`)

```yaml
- id: appearance
  anchor: '^Table \d+:.*-\s*Appearance and Water Content Results'
  repeat: true          # optional, absent = false: every match starts an occurrence
  key: 'Batch\s+(\w+)'  # optional, needs repeat: names each occurrence
  required: true        # a required repeating section needs at least one occurrence
  description: Appearance and water content table, one per batch.
```

| Key | TS (Zod, `.strict()`) | Python (Pydantic, `extra="forbid"`) |
| --- | --- | --- |
| `repeat` | `z.boolean().optional()` (no `.default`: a parsed definition must not gain `repeat: false`) | `repeat: bool = False` (`_dump` already uses `exclude_defaults`, so it is never written back) |
| `key` | `z.string().min(1).optional()` | `key: str \| None = Field(default=None, min_length=1)` |

Validation (both sides, same messages, held in step by a shared fixture):

- `key` without `repeat: true` → `section "<id>": key needs repeat`.
- `key` must compile as a multiline regex and have at most one capturing group, or a named
  group `key` → `section "<id>": key must have at most one group, or a group named key`.
  The key is the named group `key`, else group 1, else the whole match; stripped; an empty
  string reads as no key.
- `anchor` is unchanged (a multiline regex); for a repeating section **every** non-overlapping
  match (`re.finditer`) starts an occurrence.
- Legacy specs (`DocumentSpec`, TS `DocumentSpecSchema`): any section with `repeat` →
  `section "<id>": repeat is supported in recipes only`.

### Extract step (`template.ts` step schema, `ExtractStep` in `template.py`)

```yaml
- type: extract
  id: appearance
  table: appearance_results
  sections: [appearance]
  keyColumn: batch       # optional: the worker fills this column with the occurrence key
```

| Key | TS | Python |
| --- | --- | --- |
| `keyColumn` | `Id.optional()` | `key_column: Id \| None = Field(default=None, alias="keyColumn")` |

Validation (in the template-level consistency check, since it needs the sections and tables):

- A step whose `fields` is set reads no repeating section →
  `step "<id>": a field step cannot read a repeating section (<section>); fill a table instead`.
- A step reads at most one repeating section →
  `step "<id>": reads more than one repeating section (<a>, <b>)`.
- `keyColumn` needs a `table`, a repeating section read by the step, and that section's `key`;
  it names a column of the table →
  `step "<id>": keyColumn needs a repeating section with a key` /
  `step "<id>": keyColumn "<c>" is not a column of <table>`.
- `chunkPages` with a repeating section is allowed (chunks within each occurrence); the
  existing rule "chunked steps need exactly one section" still holds.

`compile_step` sets `mergePath: "rows"` when the step reads a repeating section (as it does for
`chunkPages`). The legacy `Extraction` model is **not** changed: occurrence handling lives in
`template_pipeline`/`run_step_extraction` arguments (section 3), so the spec-format contract only
gains `repeat`/`key` on `Section`.

### `copies`, `required`, `pageMarkers`

- **copies** runs first, as today (`select_copy` on pages); occurrences are found in the kept
  copy only. A repeating section is not a copy selector, and `copies` is not a repeat: a blank
  protocol followed by its executed copy stays `copies`.
- **required**: a required repeating section needs at least one occurrence; zero is the same
  `MissingSectionsError` as today. There is no minimum or exact count (open question).
- **pageMarkers**: each occurrence starting mid-page is prefixed with that page's marker, the
  rule `segment` already applies per span.

### Worked example: the `covalidation` recipe

```yaml
document:
  sections:
    - id: front
      anchor: '\A'
      required: true
    - id: batch
      anchor: '^\d+\.\s+STUDY-\d+\s+-\s+BATCH\s+\d+'
      repeat: true
      key: 'BATCH\s+(\w+)'
    - id: appearance
      anchor: '^Table \d+:.*-\s*Appearance and Water Content Results'
      repeat: true
      key: 'Batch\s+(\w+)'
    - id: assay
      anchor: '^Table \d+:.*-\s*Assay and Chromatographic Purity Results'
      repeat: true
      key: 'Batch\s+(\w+)'
    - id: dissolution
      anchor: '^Table \d+:.*-\s*Dissolution Results'
      repeat: true
      key: 'Batch\s+(\w+)'
    - id: nir
      anchor: '^Table \d+:.*-\s*Solid State by NIR Results'
      repeat: true
      key: 'Batch\s+(\w+)'
    - id: microbial
      anchor: '^Table \d+:.*-\s*Microbial Purity Results'
      repeat: true
      key: 'Batch\s+(\w+)'
    - id: conclusion
      anchor: '^\d+\.\s+CONCLUSION'
      required: false
outputs:
  fields: [ { id: study, … }, { id: product, … } ]
  tables:
    - id: batches            # one row per batch heading
      columns: [ batch, lot_code, packaging ]
    - id: appearance_results
      columns: [ batch, timepoint, condition, appearance, water_content ]
    - … assay_results, dissolution_results, nir_results, microbial_results (each with batch)
pipeline:
  - { type: extract, id: header, fields: [study, product], sections: [front] }
  - { type: extract, id: batches, table: batches, sections: [batch], keyColumn: batch }
  - { type: extract, id: appearance, table: appearance_results, sections: [appearance], keyColumn: batch }
  - … one step per table, each with keyColumn: batch
  - { type: check, id: batch_ids, values: appearance_results.batch, reference: batches.batch }
```

Segmentation of the sample: `batch` ×3 (keys 4586783, 4586784, 4586785), each from its heading
to the next caption (so it holds "PACKED AS …"); `appearance`…`microbial` ×3 each; the third
`microbial` runs to `conclusion`. Batch 1's `microbial` ends at batch 2's heading, because an
occurrence ends at the next start of **any** section's occurrence.

## 2. Segmentation

### `section_spans` (one implementation for production and preview)

```python
@dataclass(frozen=True)
class SectionSpan:
    id: str
    start: int
    end: int
    index: int = 0            # 0-based occurrence number within its section (0 for non-repeating)
    key: str | None = None    # the occurrence key (repeating sections with `key` only)
```

- Non-repeating section: `re.search`, as today.
- Repeating section: `re.finditer(anchor, text, re.MULTILINE)`; a zero-width match at the same
  position as the previous one is skipped (an anchor such as `^` would otherwise match every
  line; `finditer` already advances, this only states the intent and gets a test).
- All starts sort by `(position, declaration order, index)`; each span ends at the next start,
  the last at the end of text: the tie rule (earlier declared section gets the empty span) is
  unchanged.
- The key is searched in the span's text (`text[start:end]`) with the section's `key`
  (multiline), so a key on the caption line or just below it is found; group selection as in
  section 1.
- Return type unchanged (`(spans, unmatched)`); callers that indexed spans by id
  (`workbench.segment_samples`'s `by_id`) group them by id instead.

### `segment` and `Prepared`

`segment` keeps returning `dict[str, str]` (each section's text; a repeating section's is all of
its occurrences joined by a blank line, so custom Jinja prompts that read `sections` keep
working) and gains a sibling:

```python
@dataclass(frozen=True)
class Occurrence:
    index: int          # 1-based
    count: int
    key: str | None
    page: int | None    # from the page marker, when page markers are on
    text: str           # stripped, page marker prefixed as for sections

def segment_occurrences(pages, sections, page_marker=None) -> tuple[dict[str, str], dict[str, list[Occurrence]]]
```

`segment` becomes `segment_occurrences(...)[0]`. `pipeline.Prepared` gains
`occurrences: dict[str, list[Occurrence]]` (repeating sections only; empty for every recipe
today). The `segmented` job event adds `occurrences: {section id: count}` for repeating sections
(absent otherwise; `JobProgressSchema`'s `segmented` arm ignores extra data, so no TS change is
required, but Home may show it later).

### Preview grid (`segment_samples`, `SegmentationResultSchema`, `SegmentationGrid`)

`SectionCellSchema` gains two optional fields (defaulted on read, so stored grids from before
parse):

- `occurrences: z.array(OccurrenceCellSchema).default([])`, each `{ page, line, chars, key }`,
  filled for repeating sections only; `found`/`page`/`line` stay the first occurrence's and
  `chars` the total.
- `matches: z.number().int().nonnegative().default(0)`: for a **non-repeating** section, how
  many times its anchor matches the sample (so the grid can say "matches 3×, only the first is
  used"). This reuses option 1's count and is what makes the problem visible in the UI.

`segment_samples` also drops suggestions that would break a sample (unchanged) and adds no new
suggestion type; `anchor_hints.suggest_anchor` works on the anchor only and needs no change
(it is called only for required sections that miss a sample; a repeating one that never matches
is the same case).

The grid runs in the existing capped child (`segment_with_timeout`, `SEGMENT_TIMEOUT_S`);
`finditer` over a runaway regex is caught by the same cap. Production segmentation is still
uncapped, so the Sections tab's existing rule (no save of an anchor whose preview timed out)
also covers `key`.

## 3. Extraction

### Plan per step

`template_pipeline._run_step` finds the step's repeating section (at most one) and passes a
`RepeatPlan(section_id, occurrences, key_column)` to `run_step_extraction`, which builds its
plan as **occurrences × chunks**:

- Without a repeating section: today's plan, unchanged.
- With one: one entry per occurrence, `sections` with that section's text replaced by the
  occurrence's text (other sections as they are), audit id `<step>.occ-<n>`; with `chunkPages`
  each occurrence is chunked, audit id `<step>.occ-<n>.chunk-<m>`.
- Zero occurrences (optional section absent): no model call, `{"rows": []}`, no step-cache
  entry, the step run recorded as succeeded with 0 attempts (today an absent optional section
  is sent as an empty string; for a repeating step "no occurrence" means "no rows").

### Prompt

`render_prompt` gets `occurrence` (`{index, count, key, section}` or `None`, always passed so
`StrictUndefined` custom prompts are safe). The built-in `extract.md.j2` adds, only when it is
set:

```
You are given occurrence {{ occurrence.index }} of {{ occurrence.count }} of the repeating part
"{{ occurrence.section }}"{% if occurrence.key %} (key: {{ occurrence.key }}){% endif %}; the
other occurrences are extracted separately. Only return rows from this occurrence.
```

and labels the section tag `<section id="appearance" occurrence="2" key="4586784">`. With no
repeating section the rendered prompt is **byte-identical** to today's, so the step cache (whose
key covers the rendered prompts) of every existing recipe stays valid. A golden test holds this.

### The key column

With `keyColumn`, the column is removed from the schema each call sends (the model does not
guess it), and the worker sets it on every row of that occurrence before merging, then
normalises rows as today (`_normalise_step`, so a `batch` of type `integer` is parsed). An
occurrence without a key (the regex did not match) leaves the column null and adds an issue
`{step, target: <table>, row, column: <keyColumn>, message: "no key found in occurrence n of <section>"}`
for each of its rows (review policy decides as for any issue). The merged result is validated
against the full table schema (with the key column), which is also what the step cache stores
and checks a hit against.

### Step cache, progress, context

- **Step cache** (`step_cache_key`): unchanged code; the key already covers the list of rendered
  prompts, so occurrences (and their keys, which appear in the prompt) are in it. The full schema
  including `keyColumn` is in it too. No `CACHE_VERSION` bump: existing entries stay valid
  because non-repeating prompts are unchanged.
- **Step progress** (`STEP_PROGRESS`, `StepProgressSchema`): adds
  `occurrence: { n, of, key } | null`, optional in Zod (`.nullable().default(null)`, older events
  lack it); `step_reporter` reports it with the chunk. Test runs and Home show
  "Step 3 of 7 · occurrence 2 of 3 (4586784) · try 1". Shared fixture `step-progress.json` gains
  a case.
- **Per-step context** (`context_values`): unchanged: a later step can read
  `appearance_results.batch` as distinct values with counts. Per-occurrence context ("only this
  batch's values") is an open question.
- **Step re-runs** (`rerun_template_job`) re-run every occurrence; re-running one occurrence is
  out of scope.
- **Audit**: `runs/{job}/…` audit files per `<step>.occ-<n>[.chunk-<m>]`.
- **Checks, review, outputs, RDF**: unchanged; rows are rows. Review row numbers run across
  occurrences in document order.

## 4. Drafting

- **Sections stage** (`draft_stages.SECTIONS`): `SECTIONS_SCHEMA` gains `repeat`
  (`boolean|null`) and `key` (`string|null`); `convert_sections` passes them to `Section`. The
  prompt replaces option 1's "one big section" steer with: "When the same block repeats per
  entity (per batch, per site), give it one section with repeat true and key a regex reading the
  entity id from the occurrence's first lines; every match starts an occurrence." The anchor
  round's feedback (option 1's repeated-match count) says "matched 3 times in <sample>; set
  repeat if this block repeats" for non-repeating sections only. `check_sections` validates `key`
  like `anchor`.
- **Steps stage** (`STEPS_SCHEMA`): adds `keyColumn` (`string|null`); the prompt says "a table
  step reading a repeating section runs once per occurrence; set keyColumn to the column the
  occurrence key fills (for example batch); a field step must not read a repeating section".
  `check_steps` reports the new template validation errors as feedback (it already validates the
  whole template).
- **Union budget**: the stage schemas stay within Anthropic's 16 union-typed parameters; the
  existing guard test (`test_draft_stages.py`, `_union_count`) covers the new keys.
- **`applyChanges` / `draft_changes.apply_changes`**: no new op. `putSection` and `putStep`
  carry whole objects, so `repeat`, `key` and `keyColumn` pass through. The shared fixture
  `draft-changes.json` gains a case putting a repeating section and a `keyColumn` step, run on
  both sides with `toStrictEqual`.
- **Revise** (no unions): `REVISE_SCHEMA` gains `repeat` (`false` = absent) and `key`/
  `keyColumn` (`""` = absent), mapped back to absent like its other sentinels.
- **Survey**: unchanged (it may mention repeated blocks in the anatomy; no schema change).

## 5. UI

- **Sections tab** (`SectionsTab`, section editor): a *Repeats* tick box per section and, when
  ticked, a *Key* regex input with its compile error inline. `SegmentationGrid`: a repeating
  section's cell shows `×3` and the keys (`4586783 · 4586784 · 4586785`), expanding to one line
  per occurrence (page, first line, characters); a non-repeating cell with `matches > 1` shows a
  warn note "matches 3×, only the first is used" with *Make it repeat* (sets Repeats, unsaved,
  previewed live, like an anchor suggestion).
- **Pipeline step form** (`PipelineEditor`/`StepForms`): in the Reads sections list a repeating
  section is tagged *repeats*; when one is ticked on a table step the form says "Runs once per
  occurrence of <section>" and shows *Key column* (a select of the table's columns, *None*
  first), disabled with a reason when the section has no key. On a field step repeating
  sections are disabled with the reason "a field step can't read a repeating section".
- **Steps tab** (`StepsView`, Workbench drafting): the step card names the repeating section and
  key column; the coverage strip is unchanged.
- **Checks panel** (`templateChecks`): the new validation issues appear like any other.
- Copy uses **recipe**, never template.

## 6. Compatibility and rollout

- Published recipes are immutable and contain no `repeat`, so they segment, prompt, cache and
  deliver exactly as before. Tests pin this: every spec and recipe under `specs/` loads on both
  sides and a non-repeating step's rendered prompt is byte-identical.
- No database migration: the format lives in `templates.definition` (JSON).
- **Version skew**: a recipe with `repeat` read by an older worker fails Pydantic
  (`extra="forbid"`) and the job goes to `needs_review`; an older API refuses it on save. Deploy
  worker and API together (one compose deploy does). Bundles carrying such a recipe are refused
  by older deployments, as with other format additions.
- Option 1 recipes (one big section) keep working; moving one to repeats is an ordinary draft
  edit (or a Sections re-run).

## 7. Tests to write first (table-driven)

Python (`worker/tests/`):

- `test_segment.py::test_section_spans_repeats` (parametrised): non-repeating unchanged; a
  repeating section with 3 matches; interleaved repeating sections (the `covalidation` text,
  `front`, 3 `batch`, 5 tables × 3 batches and `conclusion` → 20 spans in order with keys); ties at the same
  position; a key in group 1, a named `key` group, no group, no match (None); zero-width
  anchors; copies then repeats.
- `test_segment.py::test_segment_occurrences`: page markers prefixed per occurrence; `segment`
  text of a repeating section = occurrences joined; required repeating section with zero
  occurrences → `MissingSectionsError`.
- `test_template.py` (parametrised over the shared fixture `repeating-sections.json`): every
  validation rule above, valid and invalid, with the exact message.
- `test_specs.py`: a legacy spec with `repeat` is refused.
- `test_template_pipeline.py`: `covalidation`-shaped run with `FakeProvider` → 3 calls per
  table step, prompts carry occurrence and key, key column filled by the worker and absent from
  the sent schema, rows in document order, missing key → issue; zero occurrences → no call;
  occurrences × chunks; step progress events carry `occurrence`; step cache hit on the second
  run and miss when one occurrence's text changes.
- `test_prompts.py` (new): golden byte-identical prompt for a non-repeating step.
- `test_workbench_segment.py::test_segment_samples_repeats`: cells' `occurrences` and `matches`.
- `test_draft_stages.py`: `convert_sections`/`convert_steps` with the new keys; union counts;
  revise sentinels.

TypeScript:

- `packages/shared/test/template.test.ts` and `spec.test.ts` over the same fixture
  (`it.each`), plus "a definition without repeat parses to itself" (`toStrictEqual`, no
  `repeat: false` added).
- `packages/shared/test/drafting.test.ts`: the new `draft-changes.json` case.
- `packages/shared/test/jobs.test.ts`: `StepProgressSchema` with and without `occurrence`.
- `packages/shared/test/workbench.test.ts`: a stored grid without `occurrences`/`matches` parses.
- Web: `SectionsTab`/`SegmentationGrid` (×3 and keys, *Make it repeat*), `PipelineEditor`
  (key column select, field-step disabled reason), run progress text.

## Open questions

1. **Nesting / `keyFrom`.** Flat repeats need each child's own text to carry the key.
   `keyFrom: batch` on a section (take the key of the nearest preceding occurrence of the named
   repeating section when its own `key` finds none) would cover documents whose tables do not
   repeat the batch, without a section tree. In now, or later when a document needs it?
2. **One call per occurrence vs one labelled call.** 15 calls instead of 5 for `covalidation`.
   Add a step option (`occurrences: each | together`) for short occurrences, with `together`
   using labelled blocks and a model-filled key column?
3. **Occurrence counts.** Should a section declare `minCount`/`count` (for example "exactly as
   many as `batch`"), checked at segmentation and sending the job to review when it differs?
4. **Spurious matches** (a list of tables at the front matching the table anchors): accept them
   (short occurrences, usually no rows) or add a guard such as "occurrences only after section
   X"? Anchors can usually avoid them.
5. **Per-occurrence context**: should `context` on a repeating step show only the values of rows
   with the same key (for example the batch's lot code from `batches`)?
6. **Field steps per occurrence**: is "use a table" acceptable for per-batch single values, or do
   we want per-occurrence fields?
