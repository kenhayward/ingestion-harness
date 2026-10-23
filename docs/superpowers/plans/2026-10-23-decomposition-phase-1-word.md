# Decomposition phase 1: Word into the decomposed document

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A worker module that reads a `.docx` and returns a checked **decomposed document**
(sections, blocks, tables, images, equations, notes, properties and a report), or refuses it with
the place a fidelity check failed. A CLI runs it on one file.

**Architecture:** A new package `ingest_worker.decompose` reads the OOXML parts directly, with
`defusedxml` over a size-capped zip. It builds Pydantic models, and renders drawings, EMF/WMF
images and equation fallbacks through the worker's existing `DocumentConverter` (Gotenberg) and
`pypdfium2`. Fidelity checks compare the model with an independent walk of the source. The
comparison forms are pinned by test vectors that live in the contract package, so phase 2's
TypeScript copy must agree with them.

**Tech Stack:** Python 3.13, Pydantic 2, defusedxml (new), pypdfium2, Pillow, httpx, pytest, ruff,
mypy (`worker/`).

**Spec:** `docs/superpowers/specs/2026-10-23-document-decomposition-design.md`. Sections cited as
§n below.

## Global Constraints

- No vendor name of the first target anywhere in this repository (code, tests, fixtures, docs,
  commit messages).
- Never `git add -A`; stage files by name.
- Before calling anything done: `npm run check`, `npm run format:check`, `npm run worker:test`,
  `npm run worker:lint`, all green. Ask the owner before pushing or opening a PR.
- Marks are only `bold`, `italic`, `underline`, `superscript`, `subscript` (§5.3).
- Everything runs locally. Every library must be redistributable by CT Studio, so no Microsoft
  `OMML2MML.XSL` (§5.7).
- Ids are deterministic. Section ids come from the title path plus the occurrence among
  same-titled siblings; other ids come from the section id plus an ordinal. The decomposer
  version never feeds ids (§5).
- A fidelity failure refuses the document. It is never downgraded to a flag (§2 anti-goals, §7).
- Test documents are synthetic, built in the tests. No real report is committed (§7).
- Sources are untrusted: no XML entity expansion, capped zip sizes, no paths taken from the
  package written to disk.

## Rulings made while planning

- **The shared comparison code** is in the contract package, per spec §9. The contract package is
  TypeScript and the decomposer is Python, so it is shared as **test vectors**
  (`packages/bridge-contract/vectors/comparison-forms.json`) that both implementations must
  reproduce. Phase 1 writes the Python forms and the vectors, and phase 2 writes the TypeScript
  forms against them. If this is wrong, it costs a port of `forms.py`, no more.
- **PNG only for rendered drawings in phase 1.** The SVG copy (spec §4, "where it converts
  cleanly") is left out. PNG alone meets every check, and SVG can be added without changing the
  model, because `Image.content_type` already allows it.
- **The OMML converter is written here,** for a defined subset (Task 8). No redistributable
  library covering OMML was assumed. Anything outside the subset falls back to the image only,
  with a flag, as spec §5.7 allows.
- **The decomposed document is a Pydantic model in the worker** in phase 1. Phase 2 writes the zod
  schema in the contract package, to the same shape, checked by the same vectors.

## Review Focus

1. **Rows shorter than the grid** (`w:gridBefore` / `w:gridAfter`, or a row with fewer cells):
   the grid must still resolve to a rectangle, with filler slots that are empty cells and not
   invented content. Pinned in Task 4 (`test_grid_before_after_fills_empty_slots`).
2. **A hostile or broken package** (a zip bomb, a 200 MB part, a missing `document.xml`, a DTD
   with entities): refused with `DecompositionRejected`, never a crash or a hang. Pinned in Task 1
   (`test_rejects_oversize_part`, `test_rejects_entity_declaration`).
3. **Whitespace and special characters**: no-break spaces, soft hyphens (`w:softHyphen`),
   no-break hyphens (`w:noBreakHyphen`), tabs, and `w:cr`. Text accounting must treat them the
   same on both sides. Pinned in Task 2 (`test_special_characters_round_trip_through_accounting`).
4. **Fields spanning paragraphs and nested fields**: a TOC field over 30 paragraphs, and a REF
   inside an IF. Pinned in Task 9 (`test_toc_spanning_paragraphs_is_dropped_whole`,
   `test_nested_field_keeps_outer_result`).
5. **Tracked changes inside tables**: a deleted row (`w:trPr/w:del`) and an inserted cell
   paragraph. Pinned in Task 4 (`test_deleted_row_is_dropped`).

## File structure

All new files are under `worker/src/ingest_worker/decompose/`, and their tests under
`worker/tests/decompose/`.

| File | Responsibility |
|---|---|
| `model.py` | Pydantic models of §5 (the decomposed document's shape) and `Flag` |
| `package.py` | Opening the zip safely, reading parts and relationships, `parse_xml` |
| `ids.py` | Section ids from title paths; child ids |
| `styles.py` | Outline levels per paragraph style (following `basedOn`); list detection from `numbering.xml` |
| `inline.py` | Runs to inline content: marks, symbols, breaks, tracked changes, hidden text, the field state machine |
| `body.py` | The body walker: sections tree, paragraphs, lists, content controls, leading blocks |
| `tables.py` | Grid resolution, alignment, header rows, caption rows, note rows, wide hint |
| `media.py` | Drawings and pictures: extents, alignment, alt text, anchored images, figures |
| `render.py` | `Renderer` protocol and `ConverterRenderer` (one-object document → PDF → cropped PNG) |
| `equations.py` | OMML to MathML, MathML to LaTeX |
| `references.py` | Footnotes, endnotes, bookmarks, REF fields, hyperlinks, typed references |
| `properties.py` | Core, custom and header-field properties |
| `forms.py` | The shared comparison forms (`text_form`, `grid_forms`) and their normalisation |
| `fidelity.py` | Independent source accounting, grid check, reference check |
| `__init__.py` | `decompose_docx`, `Decomposition`, `DecompositionRejected`, `DecompositionFailed`, `DECOMPOSER_VERSION` |
| `worker/scripts/decompose.py` | CLI: one `.docx` to a folder (`document.json`, `report.json`, `images/`) |
| `worker/tests/decompose/docx.py` | Test helper that builds synthetic `.docx` files from XML fragments |
| `packages/bridge-contract/vectors/comparison-forms.json` | Shared test vectors for the forms |

---

### Task 1: Model, safe package reader, ids

**Files:**
- Create: `worker/src/ingest_worker/decompose/{__init__,model,package,ids}.py`
- Create: `worker/tests/decompose/{__init__,docx,test_package,test_ids,test_model}.py`
- Modify: `worker/pyproject.toml` (add `defusedxml>=0.7`, and `types-defusedxml` to dev), `worker/uv.lock`

**Interfaces:**
- Produces, in `model.py`, Pydantic models with `model_config = ConfigDict(extra="forbid", frozen=True)`:
  - `Marks = frozenset[Literal["bold","italic","underline","superscript","subscript"]]`.
  - `Inline`, a discriminated union on `kind`:
    - `Text(text: str, marks: Marks)`
    - `NoteRef(note_id: str)`
    - `XRef(target_id: str, text: str)`
    - `Link(href: str, inlines: list[Inline])`
    - `InlineEquation(equation_id: str)`
    - `InlineImage(image_id: str)`
    - `Break()`
  - `Block`, a discriminated union on `kind`:
    - `Paragraph(id, inlines)`
    - `ListBlock(id, ordered: bool, items: list[ListItem])`, where `ListItem(blocks: list[Block])`
    - `Table(...)`, from Task 4
    - `Figure(id, image_id, numbered: bool, caption: list[Inline], caption_position: Literal["above","below"])`
    - `EquationBlock(id, equation_id)`
    - `ImageBlock(id, image_id)`
  - `Section(id: str, title: list[Inline], blocks: list[Block], sections: list[Section])`.
  - `Image(id, content_type: Literal["image/png","image/jpeg","image/svg+xml"], width_mm: float, height_mm: float, align: Literal["left","center","right","inline"], alt: str | None, origin: Literal["embedded","converted","rendered","cropped"], original_content_type: str | None)`.
  - `Equation(id, mathml: str | None, latex: str | None, image_id: str)`.
  - `Note(id, blocks: list[Block])`.
  - `Property(name, value: str, origin: Literal["core","custom","header-field","pdf-info"])`.
  - `Flag(code: FlagCode, severity: Literal["info","warning"], at: str | None, message: str)`, where `FlagCode` is the §5.9 list plus `heading_empty`.
  - `DecomposedDocument(blocks: list[Block], sections: list[Section], images: list[Image], equations: list[Equation], notes: list[Note], properties: list[Property], report: list[Flag])`.
- Produces, in `package.py`:
  - `class DecompositionRejected(Exception)`, for an unreadable or unsafe source;
  - `class Package` with `part(name: str) -> bytes | None`, `xml(name: str) -> Element | None`, `rels(part: str) -> dict[str, Rel]`, `target(part: str, rel_id: str) -> str | None`;
  - `open_package(data: bytes) -> Package`;
  - `parse_xml(data: bytes) -> Element`, using defusedxml, which forbids DTDs and entities;
  - limits `MAX_PART_BYTES = 64 << 20`, `MAX_TOTAL_BYTES = 512 << 20`, `MAX_PARTS = 4000`.
- Produces, in `ids.py`:
  - `normalise_title(text: str) -> str`: NFKC, casefolded, whitespace collapsed, non-alphanumerics to `-`, at most 60 characters, `untitled` if empty;
  - `section_id(parent_id: str | None, title: str, occurrence: int) -> str`: for example `s-results/s-dissolution-results~2`;
  - `child_id(section_id: str, kind: str, ordinal: int) -> str`: for example `s-results#table-3`.

- [ ] **Step 1: Write the failing tests.**
  - `test_docx.py::test_builder_round_trips`: `build_docx(body='<w:p><w:r><w:t>Hi</w:t></w:r></w:p>')` opens with `open_package`, and `xml('word/document.xml')` finds one `w:t` with text `Hi`.
  - `test_rejects_oversize_part`: a zip whose `word/document.xml` declares 200 MB raises `DecompositionRejected`, and memory stays bounded (read through `ZipFile.open` with a counted read).
  - `test_rejects_entity_declaration`: a `document.xml` with `<!DOCTYPE x [<!ENTITY a "b">]>` raises `DecompositionRejected`.
  - `test_rejects_not_a_docx`: a PDF's bytes and a zip without `word/document.xml` both raise.
  - `test_ids.py`: `section_id(None, "Dissolution Results", 1) == "s-dissolution-results"`; occurrence 2 gives the `~2` suffix; a title of `""` gives `s-untitled`; a child id of a nested section keeps its parent's path.
  - `test_model.py::test_extra_fields_forbidden` and `test_marks_reject_unknown`, where `{"strike"}` fails validation.

  The builder `worker/tests/decompose/docx.py` provides:
  - `build_docx(body: str, *, styles: str | None = None, numbering: str | None = None, footnotes: str | None = None, endnotes: str | None = None, headers: dict[str, str] | None = None, core: str | None = None, custom: str | None = None, media: dict[str, bytes] | None = None, rels: list[tuple[str, str, str]] | None = None, sect_pr: str | None = None) -> bytes`
  - It writes a minimal valid package: `[Content_Types].xml`, `_rels/.rels`, `word/document.xml` (wrapping `body` in `w:body` with the standard namespaces), `word/_rels/document.xml.rels`, and default styles with `Heading1`–`Heading3` (outline levels 0–2) and `Caption`.
- [ ] **Step 2: Run.** `uv run --directory worker pytest tests/decompose -q`. Expected: FAIL, with an import error for `ingest_worker.decompose`.
- [ ] **Step 3: Implement** `model.py`, `package.py`, `ids.py`, and empty `__init__.py` exports. Add `defusedxml` with `uv add --directory worker defusedxml` and `uv add --directory worker --dev types-defusedxml`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit.**

```bash
git add worker/pyproject.toml worker/uv.lock worker/src/ingest_worker/decompose/__init__.py worker/src/ingest_worker/decompose/model.py worker/src/ingest_worker/decompose/package.py worker/src/ingest_worker/decompose/ids.py worker/tests/decompose/__init__.py worker/tests/decompose/docx.py worker/tests/decompose/test_package.py worker/tests/decompose/test_ids.py worker/tests/decompose/test_model.py
git commit -m "feat(worker): decomposed-document model and safe .docx reader"
```

### Task 2: Inline content

**Files:**
- Create: `worker/src/ingest_worker/decompose/inline.py`, `worker/tests/decompose/test_inline.py`

**Interfaces:**
- Consumes: `model.Inline` types; `package.parse_xml`; `ingest_worker.symbol_fonts.SYMBOL` and its Wingdings table.
- Produces:
  - `class InlineContext`: the field stack, the bookmark map from Task 9 (empty until then), and `flags: list[Flag]`.
  - `inlines_of(p: Element, ctx: InlineContext, *, at: str) -> list[Inline]`.
  - `plain_text(inlines: list[Inline]) -> str`.
  - `merge_runs(inlines) -> list[Inline]`, which joins adjacent `Text` with equal marks.

Rules (§4 and §5.3):
- **Marks.** `w:b`, `w:i`, `w:u` (any `w:val` except `none`), and `w:vertAlign` `superscript` or `subscript`. `w:val="0"` or `"false"` turns a mark off. A mark comes from the run's direct `rPr`, then its character style, then the paragraph style's run properties, following `basedOn`.
- **Characters.**
  - `w:sym` with font Symbol or Wingdings maps through `symbol_fonts`. Text in runs whose `rFonts` is Symbol or Wingdings, and private-use code points U+F020–U+F0FF, are mapped too.
  - A character with no mapping becomes U+FFFD, flagged `symbol_unmapped`, with the code in the message.
- **Whitespace.**
  - `w:tab` and `w:ptab` become one space.
  - `w:br` with no type, or `textWrapping`, and `w:cr` become `Break()`. `w:br type="page"` or `"column"` is dropped.
  - `w:noBreakHyphen` becomes U+2011. `w:softHyphen` is dropped.
  - A no-break space is kept as U+00A0.
- **Tracked changes.** Text inside `w:ins` is kept. `w:del`, `w:delText` and `w:moveFrom` are dropped, and `w:moveTo` is kept. Each `w:ins`, `w:del`, `w:moveFrom`, `w:moveTo` and `w:rPrChange` counts toward one `changes_accepted` flag per document, added in Task 12.
- **Dropped:** comments (`w:commentRangeStart`, `w:commentReference`, the annotation runs) and hidden text (`w:vanish`, `w:specVanish`).
- **Fields.** A stack over `w:fldChar` begin, separate and end, and `w:fldSimple`. The result text is kept. Instruction text is never output. The field kinds `TOC`, `SEQ`, `REF`, `PAGEREF`, `NOTEREF` and `HYPERLINK` are exposed to callers through `ctx`, so Tasks 5 and 9 can act on them. Until then, all keep their result.

- [ ] **Step 1: Write the failing tests** (each builds a one-paragraph docx and calls `inlines_of`):
  - `test_marks_from_direct_and_style`: a bold run, a run styled with a character style whose `rPr` has `w:i`, and `w:b w:val="0"` inside a bold paragraph style. The marks are `{bold}`, `{italic}` and `{}`.
  - `test_super_and_subscript`: `x` + sup `2` + `H` + sub `2` + `O` gives `[Text("x",{}),Text("2",{superscript}),Text("H",{}),Text("2",{subscript}),Text("O",{})]`.
  - `test_symbol_font_characters`: `<w:sym w:font="Symbol" w:char="F0B0"/>` gives `°`, and `F0B1` gives `±`. An unknown Wingdings code gives U+FFFD and one `symbol_unmapped` flag.
  - `test_special_characters_round_trip_through_accounting`: a tab, a no-break space, a soft hyphen, a no-break hyphen and `w:cr` give `plain_text == "a b cd‑e\nf"`. A `Break` renders as `\n` in `plain_text`.
  - `test_tracked_changes_accepted`: `<w:ins>` text kept, `<w:del><w:r><w:delText>gone</w:delText></w:r></w:del>` absent.
  - `test_comments_and_hidden_dropped`.
  - `test_field_result_kept_instruction_dropped`: a complex DATE field shows its result `23 October 2026` only.
- [ ] **Step 2: Run** `uv run --directory worker pytest tests/decompose/test_inline.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** `inline.py`.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** `inline.py` and `test_inline.py`: `feat(worker): inline content of decomposed paragraphs`.

### Task 3: Sections, paragraphs, lists

**Files:**
- Create: `worker/src/ingest_worker/decompose/{styles,body}.py`, `worker/tests/decompose/{test_styles,test_body}.py`

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:
  - `class Styles` with `outline_level(p: Element) -> int | None` (0-based; `None` for body text) and `list_info(p: Element) -> tuple[str, int, bool] | None`, which returns `(numId, ilvl, ordered)`. "Ordered" is false when the level's `numFmt` is `bullet` or `none`.
  - `walk_body(pkg: Package, ctx: InlineContext) -> tuple[list[Block], list[Section]]`: the document's leading blocks and its top-level sections.
- Rules:
  - The outline level comes from the paragraph's `w:outlineLvl` first, then its style chain.
  - Level 9 means body text.
  - A heading paragraph that has list numbering is still a heading, and its number is dropped.
  - A heading opens a section at its level. The next heading at the same or a higher level closes it.
  - A skipped level nests directly under the nearest open lower level, with `heading_skipped_level` flagged.
  - An empty heading gives a section titled `[]`, flagged `heading_empty`.
  - Consecutive list paragraphs with the same `numId` form one `ListBlock`. A higher `ilvl` nests a `ListBlock` inside the previous item. A paragraph between list paragraphs with the same `numId` ends the list (§5.2: the target numbers it).
  - `w:sdt` block content controls are unwrapped.
  - Empty paragraphs (no inline content after Task 2's rules) are dropped. Text accounting is unaffected, because they hold no text.
  - Ids come from `ids.section_id` and `child_id(section, "p"|"list", n)`. Leading blocks use section id `s-0`.

- [ ] **Step 1: Write the failing tests:**
  - `test_hierarchy_from_styles`: H1 A, p, H2 B, p, H2 C, H1 D gives sections `[A[B,C], D]` with blocks in place.
  - `test_custom_heading_style_by_outline_level`: a style `ReportHead` based on `Heading2`.
  - `test_repeated_titles_get_occurrence_ids`: two H2 `Dissolution Results` under one H1 give `…/s-dissolution-results` and `…~2`.
  - `test_ids_survive_an_inserted_section`: decompose, insert a new H1 at the top, decompose again. Every original section's id is unchanged.
  - `test_empty_heading_kept_and_flagged`.
  - `test_skipped_level_nests_and_flags`.
  - `test_leading_blocks_before_first_heading`.
  - `test_nested_lists_and_bullets`: bullet, bullet at ilvl 1, ordered list. This checks the nesting and the `ordered` flags.
  - `test_content_control_unwrapped`.
- [ ] **Step 2: Run** `pytest tests/decompose/test_styles.py tests/decompose/test_body.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** `styles.py` and `body.py`. Tables are walked as an opaque `Table` placeholder until Task 4, by calling `tables.table_of`. Create that as a stub that raises `NotImplementedError` only when a table is present.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit**: `feat(worker): section tree, paragraphs and lists`.

### Task 4: Table grids

**Files:**
- Create: `worker/src/ingest_worker/decompose/tables.py`, `worker/tests/decompose/test_tables.py`
- Modify: `model.py`, adding the `Table` model

**Interfaces:**
- Produces in `model.py`:
  - `Cell(row_span: int, col_span: int, h_align: Literal["left","center","right","justify"], v_align: Literal["top","middle","bottom"], header: bool, blocks: list[Block])`
  - `Row(cells: list[Cell])`
  - `TableNote(marker: str, inlines: list[Inline])`
  - `Table(id, numbered: bool, caption: list[Inline], caption_position: Literal["above","below"], column_widths: list[float], header_rows: int, rows: list[Row], notes: list[TableNote], wide: bool, key: str | None)`
  - `column_widths` are relative and sum to 1.0.
- Produces in `tables.py`:
  - `source_grid(tbl: Element) -> list[list[GridSlot]]`, where `GridSlot(origin: tuple[int,int], text: str)`. This is the independent source grid that Task 11 uses.
  - `table_of(tbl: Element, ctx, *, id: str, walk_blocks: Callable[[Element], list[Block]]) -> Table`.
- Rules:
  - Columns come from `w:tblGrid/w:gridCol`.
  - `w:gridSpan` gives the column span.
  - `w:vMerge="restart"`, followed by `w:vMerge` (no value, or `continue`) in the same grid column on later rows, gives the row span. A continue cell contributes no cell.
  - `w:gridBefore` / `w:gridAfter`, and rows short of the grid, get empty filler cells, one per missing slot.
  - Horizontal alignment comes from the cell's first paragraph's `w:jc` (`both` means `justify`; `start` and `end` map to left and right). Vertical alignment comes from `w:tcPr/w:vAlign` (`center` means `middle`), defaulting to `top`.
  - `w:tblHeader` rows at the top give `header_rows`, and their cells get `header=True`.
  - A row deleted by a tracked change (`w:trPr/w:del`) is dropped.
  - Nested tables become `Table` blocks inside cell blocks, through `walk_blocks`.
  - `caption`, `notes`, `numbered` and `wide` are left at their defaults until Task 5.

- [ ] **Step 1: Write the failing tests:**
  - `test_spans_resolve`: a 4×4 table with a gridSpan=2 cell in row 1, a vMerge restart in column 0 rows 2–3, and a cell spanning both. The resulting spans are exact, and every grid slot is covered once.
  - `test_grid_before_after_fills_empty_slots`.
  - `test_alignment_mapping` (`both`, `center` and `end`, plus `vAlign center`).
  - `test_header_rows`.
  - `test_deleted_row_is_dropped`.
  - `test_nested_table_in_cell`.
  - `test_cell_holds_paragraphs_and_list`.
- [ ] **Step 2: Run** `pytest tests/decompose/test_tables.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS. The Task 3 tests still pass.
- [ ] **Step 5: Commit**: `feat(worker): table grids with merges and alignment`.

### Task 5: Table and figure captions, notes, wide tables

**Files:**
- Modify: `tables.py`, `body.py`
- Create: `worker/tests/decompose/test_captions.py`

**Interfaces:**
- Produces:
  - `CAPTION_PREFIX = re.compile(r"^\s*(Table|Figure)\s*(\d+)\s*[:.\-–—]?\s*", re.I)`.
  - `caption_number_map: dict[tuple[str, int], str]`, on `InlineContext`, which maps `("table", 13)` to that table's id. Task 9 consumes it.
- Rules (§5.4):
  - **Caption row.** A first row of one cell spanning the whole grid, whose text matches `CAPTION_PREFIX` or holds a `SEQ Table` field, is the caption. The prefix and the field result are removed, `numbered=True`, the position is `above`, and the row leaves the grid.
  - **Caption paragraph.** A `Caption`-style paragraph, or one holding a `SEQ` field, directly before or after a table or figure, is its caption. The position follows where it was.
  - **Notes.** Trailing rows of one full-width cell whose text matches `^\s*([a-z]|\d{1,2}|[*†‡§])\s*[:.)]\s+`, and a one-cell table directly after the table whose paragraphs all match it, become `TableNote`s. Their rows leave the grid.
  - **Markers.** Each note's marker must appear as a superscript run somewhere in the table. If not, the note stays as a row, flagged `table_notes_unrecognised`.
  - **No caption.** A table with no caption gets `caption_not_found`, at `info` severity.
  - **Key.** `key` is `normalise_title(caption text)`, or `None` when there is no caption.
  - **Wide.** `wide=True` when the table lies in a section whose `w:sectPr/w:pgSz` has `w:orient="landscape"`, or width greater than height.

- [ ] **Step 1: Write the failing tests:**
  - `test_merged_first_row_caption` (typed `Table 13: Dissolution`, and a SEQ field variant). Each gives `caption` text `Dissolution`, `numbered`, and the grid without the row.
  - `test_caption_paragraph_after_figure_is_below`.
  - `test_note_rows_attached_by_marker`: superscript `a` in a cell, with last rows `a: Samples at infinity` and `b: …`.
  - `test_note_in_following_one_cell_table`.
  - `test_unmatched_note_row_stays_and_flags`.
  - `test_landscape_section_marks_wide`.
- [ ] **Step 2: Run** `pytest tests/decompose/test_captions.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole `tests/decompose`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(worker): table and figure captions and table notes`.

### Task 6: Renderer

**Files:**
- Create: `worker/src/ingest_worker/decompose/render.py`, `worker/tests/decompose/test_render.py`

**Interfaces:**
- Consumes: `ingest_worker.convert.DocumentConverter` (`to_pdf(docx) -> bytes`), `pypdfium2`, Pillow.
- Produces:
  - `class Renderer(Protocol)` with `render(fragment: RenderFragment) -> bytes | None`, which returns PNG bytes, or `None` when rendering failed.
  - `RenderFragment(body_xml: str, page_width_twips: int, styles_xml: bytes | None, parts: dict[str, bytes], rels: list[tuple[str,str,str]])`.
  - `class ConverterRenderer(Renderer)`, constructed as `ConverterRenderer(converter: DocumentConverter, dpi: int = 300)`.
  - `class FakeRenderer`, for tests: it returns a fixed 10×10 PNG and records the fragments.
- Approach (§4):
  1. Build a one-object `.docx` from the fragment: the source page width, margins of 0, and the same styles and the referenced media parts.
  2. Convert it to PDF.
  3. Render page 1 at `dpi`.
  4. Crop to the bounding box of non-white pixels plus 2 px.
  5. Return the PNG.

  Any `ConversionRejected` or empty crop returns `None`. `ConverterUnavailable` propagates, because the whole job is retryable.

- [ ] **Step 1: Write the failing tests:**
  - `test_crops_to_content`: a fake `DocumentConverter` returns a one-page PDF (made with Pillow's PDF writer) with a black 100×50 box. The PNG is about 104×54 at 72 dpi.
  - `test_rejected_conversion_returns_none`.
  - `test_unavailable_propagates`.
  - `test_fragment_document_is_valid_package`: the built `.docx` opens with `open_package`, and its `document.xml` holds the fragment.
- [ ] **Step 2: Run** `pytest tests/decompose/test_render.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit**: `feat(worker): render drawings and fallbacks through the converter`.

### Task 7: Images, figures and drawings

**Files:**
- Create: `worker/src/ingest_worker/decompose/media.py`, `worker/tests/decompose/test_media.py`
- Modify: `inline.py` and `body.py`, to call into `media.py` for `w:drawing`, `w:pict` and `w:object`

**Interfaces:**
- Consumes: Tasks 2, 3, 5 and 6.
- Produces:
  - `MediaContext`, holding `images: list[Image]`, `image_bytes: dict[str, bytes]`, `originals: dict[str, bytes]` and the `Renderer`.
  - `media_of(run_child: Element, ctx, *, at: str, in_text: bool) -> Inline | Block | None`.
- Rules (§4, §5.5):
  - **Pictures.** `wp:inline` or `wp:anchor` holding a `pic:pic` with an `a:blip r:embed` is a picture.
    - The content type is PNG or JPEG by the file's magic bytes, never its extension.
    - `wp:extent` cx and cy are EMU; `mm = emu / 36000`.
    - `wp:docPr/@descr`, else `@title`, gives the alt text.
  - **Placement.**
    - A picture alone in its paragraph is an `ImageBlock`, or a `Figure` when Task 5 finds a caption. Its alignment is the paragraph's `w:jc` (left, center or right).
    - A picture with text in the same paragraph is an `InlineImage` with `align="inline"`.
    - In a table cell, the same rules apply within the cell's blocks.
  - **Anchored pictures** (`wp:anchor`) are placed at their paragraph, using the same rules, and flagged `image_floating_anchored`.
  - **EMF and WMF** (by magic bytes) are wrapped in a fragment and rendered to PNG. `origin` is `converted`, the original is kept in `originals`, and `image_converted` is flagged. If rendering fails, the document fails with `DecompositionFailed("image <id> could not be converted")`.
  - **Drawings.** `wps:wsp`, `wpg:wgp`, `wpc:wpc`, a SmartArt `dgm:relIds`, a chart `c:chart`, `w:pict` (VML) and `w:object` are drawings.
    - Each is rendered from a fragment holding its paragraph's drawing element, with origin `rendered`, and flagged `drawing_rendered`.
    - If rendering returns `None`, the stored fallback picture is used: `mc:Fallback`'s blip, or the VML `v:imagedata`.
    - The alt text is the drawing's own text in reading order: `w:txbxContent` paragraphs, SmartArt `dgm:t` from its data part, the chart's `c:tx`, `c:v` and title text, and `a:t` in shapes, joined by `\n`. **[owner]**, design §4.
    - If there is neither a rendering nor a fallback, the document fails with `DecompositionFailed("drawing at <id> could not be rendered")`.

- [ ] **Step 1: Write the failing tests:**
  - `test_inline_picture_size_and_alt`: a 3448050×4876800 EMU picture is 95.78 × 135.47 mm, with `alt` from `descr`.
  - `test_centered_picture_alone_is_block`.
  - `test_picture_with_text_is_inline`.
  - `test_picture_in_table_cell`.
  - `test_anchored_picture_placed_at_paragraph_and_flagged`.
  - `test_emf_converted_and_original_kept`.
  - `test_text_box_rendered_with_text_as_alt`: `FakeRenderer` is called once, and `alt == "Line one\nLine two"`.
  - `test_render_failure_uses_fallback_picture`.
  - `test_render_failure_without_fallback_fails_document`.
  - `test_figure_with_caption`: a picture paragraph followed by `Caption` `Figure 1- Container Closure` gives `Figure(numbered=True, caption=[Text("Container Closure")], caption_position="below")`.
- [ ] **Step 2: Run** `pytest tests/decompose/test_media.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole `tests/decompose`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(worker): images, figures and rendered drawings`.

### Task 8: Equations

**Files:**
- Create: `worker/src/ingest_worker/decompose/equations.py`, `worker/tests/decompose/test_equations.py`
- Modify: `inline.py` and `body.py`, for `m:oMath` (inline) and `m:oMathPara` (display)

**Interfaces:**
- Produces:
  - `omml_to_mathml(o: Element) -> str | None`, which returns a `<math xmlns="http://www.w3.org/1998/Math/MathML">…</math>` string, or `None` for an unsupported construct;
  - `mathml_to_latex(mathml: str) -> str | None`.
- Supported OMML, with its MathML (anything else gives `None`):

  | OMML | MathML |
  |---|---|
  | `m:r` (text) | `mi` for letters, `mn` for digit runs, `mo` for operators |
  | `m:f` | `mfrac` |
  | `m:sSup` | `msup` |
  | `m:sSub` | `msub` |
  | `m:sSubSup` | `msubsup` |
  | `m:rad` (with `m:degHide`) | `msqrt`, or `mroot` |
  | `m:d` (with `begChr`/`endChr`) | `mrow` with fence `mo`s |
  | `m:nary` (∑, ∫ and others) | `munderover` / `msubsup` on the `mo` |
  | `m:bar`, `m:acc` | `mover` |
  | `m:func` | `mi` + `mo`(U+2061) + argument |
  | `m:eqArr` | `mtable` |
  | `m:box`, `m:sPre` | not supported |

- The LaTeX mapping covers the same set:
  - `\frac{}{}`, `^{}`, `_{}`, `\sqrt[]{}`, `\left( … \right)`;
  - `\sum` and `\int` with limits;
  - `\bar{}`, `\hat{}`, `\operatorname{}`, `\begin{aligned}`.
- Every equation is also rendered by the `Renderer` from a fragment holding the `m:oMath`, which gives its `image_id`.
  - If MathML is `None`: `equation_image_only` is flagged, and `mathml` and `latex` stay `None`.
  - If rendering fails too: `DecompositionFailed`.

- [ ] **Step 1: Write the failing tests:**
  - `test_fraction_and_superscript`: OMML for `(a^2)/(b)` gives MathML `<mfrac><msup><mi>a</mi><mn>2</mn></msup><mi>b</mi></mfrac>` (compared after whitespace stripping), and LaTeX `\frac{a^{2}}{b}`.
  - `test_nary_sum_with_limits` gives `\sum_{i=1}^{n} x_{i}`.
  - `test_unsupported_box_is_image_only_and_flagged`.
  - `test_inline_vs_display`: `m:oMath` in a run gives `InlineEquation`; `m:oMathPara` gives `EquationBlock`.
- [ ] **Step 2: Run** `pytest tests/decompose/test_equations.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit**: `feat(worker): equations as MathML, LaTeX and image`.

### Task 9: Notes and references

**Files:**
- Create: `worker/src/ingest_worker/decompose/references.py`, `worker/tests/decompose/test_references.py`
- Modify: `inline.py` (field kinds, bookmarks), `body.py`

**Interfaces:**
- Consumes: `caption_number_map` (Task 5), the field stack (Task 2).
- Produces:
  - `notes_of(pkg, ctx) -> list[Note]`, from `footnotes.xml` and `endnotes.xml`. The separator and continuation notes are skipped. Ids are `fn-<w:id>` and `en-<w:id>`.
  - `resolve_references(doc: DecomposedDocument, ctx) -> DecomposedDocument`, the last pass.
- Rules (§5.6, §4):
  - `w:footnoteReference` and `w:endnoteReference` become `NoteRef`.
  - **Bookmarks.** `w:bookmarkStart` names map to the id of the block, or the section heading, they start in.
  - **Cross-reference fields.** `REF` / `PAGEREF` / `NOTEREF` with a bookmark become `XRef(target_id, text=<result>)`. An unknown bookmark keeps the result text and is flagged `xref_unmatched`.
  - **Hyperlinks.**
    - `w:hyperlink` with `r:id` (external) becomes `Link`.
    - `w:hyperlink` with `w:anchor`, and a `HYPERLINK \l` field, become `XRef`.
    - A `HYPERLINK "url"` field becomes `Link`.
  - **Dropped fields.** `TOC` fields are dropped whole, result paragraphs included, even across paragraphs. `TOC \c "Table"`, `TOC \c "Figure"` and paragraphs in `TOC n` / `TableofFigures` styles are dropped the same way. `SEQ` results are dropped, since Task 5 already took them out of captions.
  - **Nested fields.** The outer field's result is kept, and the inner one's instruction is never output.
  - **Typed references.** In `Text` outside captions, `\b(Table|Figure)\s+(\d+)\b` is matched against `caption_number_map` using the source's displayed numbers. A match is split into an `XRef` with the matched text. No match leaves the text, flagged `xref_unmatched`, at `info` severity.

- [ ] **Step 1: Write the failing tests:**
  - `test_footnote_and_endnote_become_notes`.
  - `test_ref_field_to_table_bookmark`.
  - `test_internal_and_external_hyperlinks`.
  - `test_toc_spanning_paragraphs_is_dropped_whole` (a 30-paragraph TOC).
  - `test_list_of_tables_dropped`.
  - `test_nested_field_keeps_outer_result`.
  - `test_typed_reference_matched` ("see Table 13" gives an `XRef` to the table whose source caption said 13).
  - `test_typed_reference_unmatched_flags`.
- [ ] **Step 2: Run** `pytest tests/decompose/test_references.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the whole `tests/decompose`. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(worker): notes, cross-references and dropped generated lists`.

### Task 10: Properties

**Files:**
- Create: `worker/src/ingest_worker/decompose/properties.py`, `worker/tests/decompose/test_properties.py`

**Interfaces:**
- Produces: `properties_of(pkg: Package) -> list[Property]`.
- Rules (§5.8):
  - `core`: `docProps/core.xml` `dc:title`, `dc:subject`, `dc:creator`, `cp:keywords`, `dcterms:created` and `dcterms:modified`, named `title`, `subject`, `author`, `keywords`, `created` and `modified`. Empty values are skipped.
  - `custom`: each `docProps/custom.xml` property with its name, as text.
  - `header-field`:
    - from every header and footer part, each `DOCVARIABLE <name>` field becomes `(name, result)`;
    - each header table row of exactly two non-empty cells, whose first cell ends with `:` or is shorter than 40 characters, becomes `(label without the colon, value)`.
  - Headers and footers contribute nothing to content.

- [ ] **Step 1: Write the failing tests:**
  - `test_core_and_custom`.
  - `test_header_docvariables_and_label_rows`: a header with a table of `Document Type: Subtype` | `Technical Document: Stability Report` and a `DOCVARIABLE owning_facility` field gives both properties with origin `header-field`.
  - `test_header_text_not_in_content`.
- [ ] **Step 2: Run** `pytest tests/decompose/test_properties.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit**: `feat(worker): document properties offered to the target`.

### Task 11: Comparison forms and fidelity checks

**Files:**
- Create: `worker/src/ingest_worker/decompose/{forms,fidelity}.py`, `worker/tests/decompose/{test_forms,test_fidelity}.py`
- Create: `packages/bridge-contract/vectors/comparison-forms.json`, `packages/bridge-contract/vectors/README.md`

**Interfaces:**
- Produces, in `forms.py` (§7, §9 "shared comparison code"):
  - `normalise(s: str) -> str`: NFC, every run of whitespace (including U+00A0 and `\n`) collapsed to one space, and trimmed.
  - `text_form(doc: DecomposedDocument) -> list[str]`: one string per text unit, in document order. The units are:
    - each section title;
    - each paragraph;
    - each list item's paragraphs;
    - each table, as its caption, then its cells row by row, then its notes as `marker: text`;
    - each figure caption;
    - each image's alt text, at its place;
    - each note, at the end in id order.

    In this form:
    - an `XRef` contributes `⟦xref:<target_id>⟧`, not its text;
    - an equation contributes `⟦eq:<mathml or image_id>⟧`;
    - a `Break` contributes a space.
  - `grid_forms(doc) -> dict[str, list[list[str]]]`: per table id, the grid of slot origins and texts, each slot as `"r,c|text"`.
- Produces, in `fidelity.py`:
  - `class DecompositionFailed(Exception)`, carrying `.at` and `.detail`;
  - `source_text_units(pkg, ctx) -> list[str]`: an independent walk of the source in the same order and with the same units. It applies only the documented drops and conversions:
    - accepted changes;
    - drop: TOC and lists, hidden text, comments, headers and footers, SEQ results, caption prefixes, note-row markers' rows moved to notes;
    - symbols to Unicode, tabs to spaces;
    - drawing text at its place.

    Cross-reference fields and typed references are tokenised by the same rule as `text_form`, from the same bookmark resolution.
  - `check(doc, pkg, ctx) -> None`. It raises `DecompositionFailed` on:
    - the first differing unit, with its index, both texts truncated to 120 characters, and the nearest section id;
    - any table whose `grid_forms` differs from `tables.source_grid`;
    - any `NoteRef`, `XRef`, `InlineImage`, `ImageBlock` / `Figure` image, or equation reference that doesn't resolve.
- The vectors file holds an array of `{name, document, text_form, grid_forms}`, built from at least: a merged-cell table, a captioned table with notes, an `XRef`, an image-only equation, and a no-break space and line break case. Phase 2's TypeScript forms must reproduce them exactly. The README says so.

- [ ] **Step 1: Write the failing tests:**
  - `test_forms.py::test_vectors_match`: each vector's `document` (validated as `DecomposedDocument`) gives its `text_form` and `grid_forms`.
  - `test_fidelity.py`:
    - `test_clean_document_passes`;
    - `test_lost_paragraph_fails_with_place`: monkeypatch `body` to drop one paragraph, then `check` raises, naming its section;
    - `test_wrong_merge_fails`: mutate one cell's `row_span`, then raise naming the table id;
    - `test_dangling_reference_fails`;
    - `test_drawing_text_accounted_via_alt`.
- [ ] **Step 2: Run** `pytest tests/decompose/test_forms.py tests/decompose/test_fidelity.py -q`. Expected: FAIL.
- [ ] **Step 3: Implement** `forms.py`, `fidelity.py` and the vectors. Generate the vectors' expected values once with the implementation, then review them by hand against the rules above before committing. The review is a step: read each vector's `text_form` and confirm every unit.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit**: `feat(worker): fidelity checks and shared comparison vectors`, staging the two packages files by name.

### Task 12: Entry point, report and CLI

**Files:**
- Modify: `worker/src/ingest_worker/decompose/__init__.py`
- Create: `worker/scripts/decompose.py`, `worker/tests/decompose/test_decompose.py`, `worker/tests/decompose/test_cli.py`
- Modify: `docs/superpowers/specs/2026-10-23-document-decomposition-design.md`, adding "Phase 1 status" in §11 (one line: done, with the CLI usage)

**Interfaces:**
- Produces:
  - `DECOMPOSER_VERSION = 1`.
  - `@dataclass(frozen=True) class Decomposition`, with `document: DecomposedDocument`, `image_bytes: dict[str, bytes]` and `originals: dict[str, bytes]`.
  - `decompose_docx(data: bytes, *, renderer: Renderer) -> Decomposition`. It raises `DecompositionRejected` (from `open_package`) or `DecompositionFailed`.
  - The pipeline:
    1. `open_package`;
    2. styles;
    3. `walk_body`;
    4. `notes_of`;
    5. `properties_of`;
    6. `resolve_references`;
    7. one `changes_accepted` flag (`info`, with the count) if the count is above 0;
    8. `fidelity.check`;
    9. return.
  - Flags are ordered by document position.
- CLI: `uv run --directory worker python scripts/decompose.py <file.docx> <out-dir> [--converter-url URL]`.
  - It writes `document.json` (`model_dump(mode="json")`, sorted keys, 2-space indent), `report.json` (the flags), and `images/<id>.<ext>`, with originals as `images/<id>.orig.<ext>`.
  - It exits 0 on success; 2 on `DecompositionFailed`, printing `at` and `detail`; 3 on `DecompositionRejected`.
  - Without `--converter-url`, any rendering need fails the document, with the message `rendering needs --converter-url`.
  - `out-dir` must not exist, or must be empty. Image file names come from ids, which are sanitised to `[a-z0-9._~-]`, never from package paths.

- [ ] **Step 1: Write the failing tests:**
  - `test_decompose.py::test_sample_like_report`: a synthetic document mirroring the sample's shape. It has:
    - two heading levels with repeated titles, and an empty heading;
    - a 5-column table with a merged caption row `Table 1:` and superscript markers with `a:` note rows;
    - an 11-column table on a landscape section;
    - an inline picture with a `Figure 1-` caption;
    - a Symbol-font `°`;
    - a header with DOCVARIABLE fields.

    It asserts the section tree, the table captions without numbers, the notes, `wide`, the figure, `°`, the properties, the flags `{heading_empty}`, and that `check` passed.
  - `test_changes_accepted_flag_counts`.
  - `test_cli.py::test_writes_outputs_and_exit_codes`, using `FakeRenderer` through an internal `main(argv, renderer=...)`, plus `test_refuses_non_empty_out_dir`.
- [ ] **Step 2: Run** `pytest tests/decompose -q`. Expected: FAIL (the new tests).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npm run worker:test` and `npm run worker:lint`, then `npm run check` and `npm run format:check`. Expected: all green.
- [ ] **Step 5: Owner run (a stop point).** Ask the owner to run the CLI on their private samples with `--converter-url` pointing at the deployed Gotenberg. Record the outcome (fidelity failures, flags per document) in the PR description, never the documents' content.
- [ ] **Step 6: Commit**: `feat(worker): decompose_docx and its CLI`.

---

**Phase 1 is done when** (§11): the synthetic corpus decomposes and passes its checks, and the
owner's private samples decompose with no fidelity failure.
