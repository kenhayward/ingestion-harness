# PDF reader step 5c: scanned pages — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A PDF's scanned pages are transcribed by CT Studio's configured OCR model and decomposed
beside its born-digital pages, every scanned page flagged `page_recognised`.

**Architecture:** The reader gets a `PageTranscriber` (page → raw markdown + rotation). Each
scanned page's markdown is parsed into a small block model, then turned into a **synthetic text
layer**: visible `Char`s laid out below the page (so none falls inside a real region), with
bold/italic/super/subscript encoded the way pdfium's chars carry them, and `Piece`s
(headings, paragraphs, list items, tables with synthetic cells) built from those chars. Picture
and formula pieces keep the layout service's real boxes. The synthetic pieces are spliced in page
order among the born-digital ones, so headings, lists, tables, captions, ids and the page map
all reuse the existing stages. `TextLayer.recognised` names the synthetic pages so the checks,
the furniture rule and the left-out counts skip them. In the worker, extraction's OCR loop
(caches, call gates, cancellation) is refactored into a transcriber the decomposition job uses.

**Tech Stack:** Python 3.12 worker (uv, pytest, mypy, ruff), pypdfium2, Pillow, stdlib
`html.parser`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-26-pdf-reader-design.md`, §15 (with §3–§7, §9, §14.8).

## Global Constraints

- The owner's private sample documents, their text and any OCR or Docling output of them are
  never committed. Fixtures are synthetic or made from the repo's existing public fixtures.
- Stage files by name; never `git add -A`. Never read `deploy/.env` or any `.env`.
- Never touch the owner's running Docker stack (ingestion-*, 3ds-sink, alloy-works-* containers,
  their DBs and volumes). Throwaway containers get their own names and are removed.
- Decomposition adds no OCR setting: it uses the worker's `deps.ocr` (`OcrSettings`) and
  `JobModels(...).resolve_ocr(deps.ocr.model, what="OCR model")`, as extraction does.
- Exact messages:
  - fail fast: `page N is scanned and this CT Studio has no OCR model`
  - empty page: `page N: no text was recognised`
  - every scanned page: `page N was read by the OCR model` (code `page_recognised`, severity
    `warning`)
  - stamps: `page N: M words of visible text over the scan were left out` (appended to the
    page's `page_recognised` message with `; `)
- Classification thresholds: `_SCANNED_IMAGE_AREA = 0.5` (kept), `_SCAN_COVER = 0.8` (one
  image), `_SCAN_MAX_WORDS = 20`.
- Scanned furniture: at least `3` scanned pages; a line repeating (digits aside) on at least half
  of them.
- Rasterised twins: `200` dpi.
- `PDF_READER_VERSION = 2` (so a PDF's decomposer version is 1002).
- The gate before claiming done: `npm run check` and `npm run format:check` from the repo root.

## Review Focus

1. A scanned page whose markdown is empty, or only front matter, gives no blocks, its flag says
   no text was recognised, and nothing raises (Task 3 test `test_empty_page_flagged`).
2. Malformed table HTML (an unclosed `<td>`, ragged rows, a span past the edge) still gives a
   rectangular grid and never raises (Task 2 test `test_ragged_table_is_rectangular`).
3. In a mixed PDF, born-digital running headers on half the *born-digital* pages are still
   dropped: scanned pages are left out of the furniture rule's page count (Task 4 test
   `test_furniture_counts_born_digital_pages_only`).
4. A transcription cached by extraction, which has no rotation record, reads as rotation 0
   (Task 5 test `test_cached_without_rotation_reads_upright`).
5. Dollar signs and HTML entities in plain text ("costs $5 and $10", `&amp;`) stay text and are
   unescaped, not read as equations (Task 2 test `test_dollars_are_not_equations`).

---

### Task 1: Probe the layout service on a scanned page (controller, no code)

Docling's layout runs with OCR off. On an image-only page it may drop picture or formula clusters
that hold no text. §15.3 needs their boxes.

- [ ] **Step 1:** Build a rasterised copy of one public twin PDF with a figure and an equation
  (render each page with pypdfium2 at 200 dpi, save as a PDF with Pillow), in the scratchpad.
- [ ] **Step 2:** Start a throwaway layout container from the image built for 5a, with its own
  name, and POST the rasterised PDF as `HttpLayoutAnalyser` does.
- [ ] **Step 3:** Record in the ledger which item kinds come back for the scanned pages
  (pictures with boxes? formulas? text items with no text?). Remove the container.
- [ ] **Step 4:** Rule on the result. Pictures present means §15.3 stands. No pictures means a
  ruling that the scanned pages' figures come from the model's placeholder boxes alone. No
  formulas means every display equation takes §15.3's LaTeX-as-text fallback. Carry the ruling
  into Task 3's dispatch.

### Task 2: Transcript parsing

**Files:**
- Create: `worker/src/ingest_worker/decompose/pdf/transcript.py`
- Modify: `worker/src/ingest_worker/ocr.py` (extract `split_front_matter`, used by `parse_olmocr`)
- Test: `worker/tests/decompose/pdf/test_transcript.py`

**Interfaces:**
- Produces:
  ```python
  @dataclass(frozen=True)
  class Transcript:            # what a transcriber returns for one page
      markdown: str            # the model's raw output, front matter included
      rotation: int            # clockwise degrees the OCR client applied: 0, 90, 180, 270

  class PageTranscriber(Protocol):
      def transcribe(self, pages: Sequence[int]) -> Mapping[int, Transcript]: ...
      # 0-based pages; may raise TranscriptionFailed, or a transient error (the job is retried)

  class TranscriptionFailed(DecompositionFailed): ...   # at = "page N"

  Run = tuple[str, frozenset[Literal["bold", "italic", "superscript", "subscript"]], str | None]
  #     text, marks, link href
  @dataclass(frozen=True) class TxHeading:   level: int; runs: tuple[Run, ...]
  @dataclass(frozen=True) class TxParagraph: runs: tuple[Run, ...]
  @dataclass(frozen=True) class TxListItem:  depth: int; marker: str; runs: tuple[Run, ...]
  @dataclass(frozen=True) class TxCell:      row: int; col: int; row_span: int; col_span: int; header: bool; lines: tuple[tuple[Run, ...], ...]
  @dataclass(frozen=True) class TxTable:     rows: int; cols: int; cells: tuple[TxCell, ...]
  @dataclass(frozen=True) class TxEquation:  latex: str            # display equation
  @dataclass(frozen=True) class TxFigure:    alt: str; box: tuple[float, float, float, float] | None  # rendered-image pixels
  TxBlock = TxHeading | TxParagraph | TxListItem | TxTable | TxEquation | TxFigure

  def parse_transcript(markdown: str) -> list[TxBlock]
  def split_front_matter(raw: str) -> tuple[str, dict[str, Any]]   # in ocr.py
  ```

- [ ] **Step 1: Write the failing tests** in `test_transcript.py`:
  - `test_headings_paragraphs_lists`: `"# A\n\nText **bold** *it*.\n\n- one\n  - two\n1. three"`
    → `[TxHeading(1, …"A"), TxParagraph(runs with "bold" marked bold, "it" italic),
    TxListItem(0, "-", "one"), TxListItem(1, "-", "two"), TxListItem(0, "1.", "three")]`.
  - `test_front_matter_is_dropped`: input starting `---\nprimary_language: en\n---\n` gives the
    same blocks as without it.
  - `test_table_spans_and_headers`: `<table><tr><th colspan="2">H</th></tr><tr><td rowspan="2">a</td><td>b<br>c</td></tr><tr><td>d</td></tr></table>`
    → `TxTable(rows=3, cols=2)`; the header cell spans 2 columns with `header=True`; `a` has
    `row_span=2`; the `b<br>c` cell has two lines.
  - `test_table_without_th_has_no_header`: every cell has `header=False`.
  - `test_ragged_table_is_rectangular`: an unclosed `<td>`, a 3-cell row after a 2-cell row and
    `colspan="9"` give a grid whose cells cover `rows × cols` exactly once, with no exception.
  - `test_display_and_inline_equations`: `"$$x^2$$"` and `"\\[x^2\\]"` → `TxEquation("x^2")`. In
    `"so $a_1$ holds"`, the inline LaTeX stays in the paragraph's text as `$a_1$`.
  - `test_dollars_are_not_equations`: `"costs $5 and $10 &amp; tax"` → one paragraph whose text
    is `costs $5 and $10 & tax`.
  - `test_figure_placeholder`: `"![A pump](page_10_20_300_200.png)"` → `TxFigure("A pump",
    (10, 20, 310, 220))`. A placeholder whose name doesn't parse gives `box=None`.
  - `test_sup_sub_and_links`: `"m<sup>2</sup> H<sub>2</sub>O [site](https://x.example)"` → runs
    with superscript, subscript, and the href on "site".
- [ ] **Step 2:** Run `uv run --directory worker pytest tests/decompose/pdf/test_transcript.py -q`.
  Expected: FAIL (module missing).
- [ ] **Step 3:** Implement it. Hand-written line parser plus an `html.parser.HTMLParser`
  subclass for tables. A display equation is `$$…$$` or `\[…\]` on its own lines. Inline `$…$`
  is never parsed out. List depth is the indent ÷ 2. Normalising heading levels is done in
  Task 3, not here. `split_front_matter` is `parse_olmocr`'s front-matter half, and
  `parse_olmocr` calls it, with its behaviour unchanged.
- [ ] **Step 4:** Run the tests, plus `tests/test_ocr.py` (or wherever `parse_olmocr` is
  tested). Expected: PASS.
- [ ] **Step 5:** Commit: `feat(worker): parse the OCR model's page markdown for the PDF reader`.

### Task 3: Scanned pages into pieces

**Files:**
- Create: `worker/src/ingest_worker/decompose/pdf/scanned.py`
- Modify: `worker/src/ingest_worker/decompose/pdf/pieces.py` (`Piece.latex: str | None = None`)
- Modify: `worker/src/ingest_worker/decompose/pdf/build.py` (`formula`: with `piece.latex`
  set, the `Equation` gets `latex=` and no `equation_image_only` flag)
- Modify: `worker/src/ingest_worker/decompose/pdf/crop.py` (`RotatedCropper`)
- Test: `worker/tests/decompose/pdf/test_scanned.py`

**Interfaces:**
- Consumes: Task 2's `TxBlock`s, `layout.LayoutPicture`, `LayoutText` (label `formula`),
  `textlayer.PageText`, `Char`, `pieces.Piece`, `Line`.
- Produces:
  ```python
  @dataclass(frozen=True)
  class RecognisedPage:
      page: PageText          # synthetic: visible chars, links, the real width/height/images
      pieces: list[Piece]     # in reading order, refs "s{page}-{n}"
      flags: list[Flag]       # page_recognised (+ mismatch flags), at=None

  def normalise_levels(pages: Mapping[int, list[TxBlock]]) -> dict[int, list[TxBlock]]
      # the shallowest heading level across all scanned pages becomes 1
  def drop_scanned_furniture(pages: Mapping[int, list[TxBlock]]) -> tuple[dict[int, list[TxBlock]], dict[int, int]]
      # per page, how many lines were dropped
  def recognise_page(original: PageText, blocks: list[TxBlock], regions: Sequence[LayoutPicture | LayoutText],
                     *, rotation: int, render_px: tuple[int, int], left_out_words: int) -> RecognisedPage
  class RotatedCropper:   # PageCropper: crops through `inner`, then rotates by the page's degrees
      def __init__(self, inner: PageCropper, rotations: Mapping[int, int]) -> None
  ```
  Synthetic geometry: line `n` sits at `y = page.height + 10 + n * 14`, size 10, x from 0, list
  depth × 18 pt of indent, words separated by `space_before=True`. Superscript and subscript
  chars are size 7 with the baseline 3 pt up or down (so `_marks` reads them). Bold and italic go
  in the `Char` fields. A link adds a `(box, href)` to `page.links` around its chars. Table cells
  get synthetic boxes on a grid of 60 pt columns, so `_column_lefts` agrees between two scanned
  tables with the same columns. The OCR model's figure boxes are in rendered-image pixels:
  `render_px` is the size of the image sent (longest side `OcrSettings.longest_dim`), and boxes
  are scaled to points.

- [ ] **Step 1: Write the failing tests** in `test_scanned.py`, building `PageText` and regions by
  hand:
  - `test_blocks_become_pieces_in_order`: heading, paragraph, two list items and a table come
    out as pieces with labels `section_header`, `text`, `list_item` ×2 (same `group`), `table`,
    in that order, every char visible and below `page.height`.
  - `test_marks_survive`: a bold run's chars are `bold=True`; `Line.runs()` of a superscript
    gives a `superscript` mark.
  - `test_figure_matched_by_box`: two picture regions and two placeholders whose boxes overlap
    the regions crosswise come out paired by overlap, not order. The picture piece's text is the
    placeholder's alt.
  - `test_unmatched_region_goes_last_and_flags`: a third region with no placeholder is the
    page's last piece, and a flag names the mismatch. A placeholder with no region is dropped
    and flagged.
  - `test_rotated_page_matches_in_order`: with `rotation=90`, pairing is by reading order (top to
    bottom, then left to right) and ignores the boxes.
  - `test_display_equation_takes_formula_region`: a `TxEquation` and a `formula` region → a
    `formula` piece with the region's box and `latex="x^2"`. With no region, a `text` piece
    reading `$$x^2$$`, plus a `structure_inferred` flag.
  - `test_empty_page_flagged`: no blocks → no pieces, and the flags are the `page_recognised`
    flag with `page 3: no text was recognised`.
  - `test_left_out_words_in_flag`: `left_out_words=4` adds
    `page 3: 4 words of visible text over the scan were left out`.
  - `test_normalise_levels`: pages whose shallowest heading is `###` read that heading as level 1.
  - `test_scanned_furniture`: with 4 scanned pages each ending `Page N of 4`, all four lines are
    dropped and counted. With 2 scanned pages, nothing is dropped.
  - `test_formula_with_latex_builds_equation` (in `test_build.py`'s style): `build_document`
    on a `formula` piece with `latex` gives an `Equation` with that latex, an image, and no
    `equation_image_only` flag.
  - `test_rotated_cropper`: a 10×20 PNG cropped through `RotatedCropper` with 90° comes back
    20×10.
- [ ] **Step 2:** Run `uv run --directory worker pytest tests/decompose/pdf/test_scanned.py tests/decompose/pdf/test_build.py -q`.
  Expected: FAIL.
- [ ] **Step 3:** Implement `scanned.py`, the `Piece.latex` field, the `formula` change and
  `RotatedCropper`. Apply Task 1's ruling.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(worker): scanned pages become pieces on a synthetic text layer`.

### Task 4: The reader reads mixed PDFs

**Files:**
- Modify: `worker/src/ingest_worker/decompose/pdf/textlayer.py` (classification;
  `TextLayer.recognised: frozenset[int] = frozenset()`; `PageText.left_out_words`)
- Modify: `worker/src/ingest_worker/decompose/pdf/__init__.py` (`decompose_pdf`,
  `PDF_READER_VERSION = 2`)
- Modify: `worker/src/ingest_worker/decompose/pdf/furniture.py`, `fidelity.py`, `tables.py`
  (skip `recognised` pages, as below)
- Modify: `worker/src/ingest_worker/decompose/__init__.py` (`decompose_any` passes
  `transcriber`)
- Test: `worker/tests/decompose/pdf/test_textlayer.py`, `test_reader_scanned.py` (new),
  plus the existing version tests

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces:
  ```python
  def decompose_pdf(data: bytes, *, layout: LayoutAnalyser, transcriber: PageTranscriber | None = None,
                    cropper: PageCropper | None = None, chunk: int = 20, ocr_longest_dim: int = 1288) -> Decomposition
  def decompose_any(data, *, renderer, layout, transcriber: PageTranscriber | None = None) -> Decomposition
  ```
  Order inside `decompose_pdf`: read the text layer. Classify. If there are scanned pages and no
  transcriber, raise `DecompositionFailed("page N is scanned and this CT Studio has no OCR
  model")` (N = the first one) before any layout call. Fetch the layout. Transcribe the scanned
  pages in one call. Parse, then `normalise_levels`, then `drop_scanned_furniture`, then
  `recognise_page` per page. Replace those pages in the `TextLayer` and set `recognised`. Run
  `attach_text` on the layout without the scanned pages' items. Splice each page's pieces after
  the last piece of an earlier page. Then the existing stages run, with a `RotatedCropper` when
  any page was rotated. The scanned flags go in the report after the dropped summary.
  - Skips: `drop_furniture` leaves out recognised pages, both as candidates and in its "half the
    pages" count, and their dropped lines join its summary. `left_out_flags` and `check_pdf`
    skip recognised pages. `join_split_tables` doesn't join across a boundary between a
    recognised page and a born-digital one.

- [ ] **Step 1: Write the failing tests:**
  - `test_textlayer.py::test_stamp_over_scan_is_scanned`: a page with one image covering 90% and
    5 visible words is `scanned`, with `left_out_words == 5`. With 30 words it is born-digital.
    With 75% cover it is born-digital. A page with no text and no images is born-digital.
  - `test_reader_scanned.py::test_mixed_pdf`: a fixture PDF made in the test is born-digital page
    1, then `rasterise`d pages 2–3 (use Task 6's `rasterise_pdf` if it is done, else render with
    pypdfium2 + Pillow in the test helper). Use the existing fake layout analyser and a fake
    transcriber returning canned markdown. The document has page 1's heading and text, then the
    scanned pages' heading, paragraph and table. A scanned heading typed `3.2 Scope` gets level 2
    from its typed number, and the number is left out of its title, as on a born-digital page. Every scanned page has a `page_recognised`
    flag. The `page_map` sends the scanned blocks to pages 2 and 3, and `check_pdf` passes.
  - `test_no_transcriber_fails_fast`: the same PDF with `transcriber=None` raises
    `DecompositionFailed` with `page 2 is scanned and this CT Studio has no OCR model`, and the
    fake layout analyser was never called.
  - `test_furniture_counts_born_digital_pages_only`: 4 born-digital pages, 2 of them with the same
    header line, plus 4 scanned pages: the header is dropped.
  - `test_no_join_across_boundary`: a table ending born-digital page 1 and one starting scanned
    page 2, with the same columns, stay two tables.
  - `test_transcription_failed_propagates`: a transcriber raising `TranscriptionFailed` surfaces
    as a `DecompositionFailed` naming the page.
  - Update the version expectations: a PDF's decomposer version is 1002.
- [ ] **Step 2:** Run `uv run --directory worker pytest tests/decompose -q`. Expected: the new
  tests FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run `uv run --directory worker pytest -q` (the whole worker suite: the 5a
  saved-Docling tests must still pass unchanged). Expected: PASS.
- [ ] **Step 5:** Commit: `feat(worker): the PDF reader reads scanned pages through a transcriber`.

### Task 5: The worker's transcriber

**Files:**
- Modify: `worker/src/ingest_worker/pipeline.py` (`JobTranscriber`, `ocr_pages` built on it)
- Modify: `worker/src/ingest_worker/storage.py` (`ocr_rotation_key`)
- Modify: `worker/src/ingest_worker/decompose/job.py` (`DecomposeDeps.transcriber`, `_convert`)
- Test: `worker/tests/test_pipeline_ocr.py` (or the existing `ocr_pages` test file),
  `worker/tests/decompose/test_job*.py`

**Interfaces:**
- Consumes: Task 2's `PageTranscriber`, `Transcript`, `TranscriptionFailed`; Task 4's
  `decompose_any(..., transcriber=)`.
- Produces:
  ```python
  class JobTranscriber:   # PageTranscriber
      def __init__(self, job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, pdf: bytes, *, sha256: str,
                   progress: Callable[[int, int], None] | None = None, failure: type[Exception] = DocumentError) -> None
      def transcribe(self, pages: Sequence[int]) -> dict[int, Transcript]
  def ocr_rotation_key(text_key: str) -> str        # text_key + ".rotation"; body is the degrees, ASCII
  # DecomposeDeps.transcriber: Callable[[ClaimedJob, bytes], PageTranscriber] | None
  ```
  `JobTranscriber` is `ocr_pages`' body, unchanged in what it does: the run-key copy, the shared
  cache, call gate, concurrency, cancellation, the `ocr` event and the error mapping. It returns
  raw markdown and the rotation. A rotation other than 0 is written beside both keys and read
  back; a missing record reads as 0. It raises `failure(message)` where `ocr_pages` raised
  `DocumentError`. For decomposition this is `TranscriptionFailed`, with `at="page N"`.
  `ocr_pages` becomes `JobTranscriber(...).transcribe(targets)` plus `parse_olmocr`, and keeps its
  signature and behaviour. `decompose_deps` sets `transcriber` only when `deps.ocr` is not None.
  It passes the job's own `sha256` of the source bytes.

- [ ] **Step 1: Write the failing tests:**
  - `test_cached_without_rotation_reads_upright`: a shared-cache entry with no rotation record
    → `Transcript(rotation=0)`.
  - `test_rotation_round_trips`: a fake provider whose first answer says
    `rotation_correction: 90` → `rotation == 90`. A second `JobTranscriber` reads it from the
    cache with 90 and makes no model call.
  - `test_refusal_fails_decomposition_page`: with `failure=TranscriptionFailed`, a refusal on
    page 2 raises `TranscriptionFailed` whose `at` is `page 2`.
  - The existing `ocr_pages` tests pass unchanged.
  - `decompose` job test: a PDF item with a scanned page, the fake layout and a fake OCR provider
    in the worker's deps, ends `awaiting_review` with `page_recognised` flags. With `deps.ocr =
    None` it ends `failed` with `page 1 is scanned and this CT Studio has no OCR model`.
- [ ] **Step 2:** Run `uv run --directory worker pytest tests -q -k "ocr or decompose"`.
  Expected: the new tests FAIL.
- [ ] **Step 3:** Implement it.
- [ ] **Step 4:** Run `uv run --directory worker pytest -q` and `uv run --directory worker mypy`.
  Expected: PASS.
- [ ] **Step 5:** Commit: `feat(worker): decomposition reads scanned pages with CT Studio's OCR model`.

### Task 6: Dev tools: OCR for decompose.py, rasterised twins

**Files:**
- Create: `worker/src/ingest_worker/decompose/pdf/rasterise.py`
- Create: `worker/scripts/_dev_ocr.py` (`DiskTranscriber`)
- Modify: `worker/scripts/decompose.py`, `worker/scripts/pdf_twins.py`
- Test: `worker/tests/decompose/pdf/test_rasterise.py`, `worker/tests/scripts/test_dev_ocr.py`
  (follow where the existing script tests live)

**Interfaces:**
- Produces:
  ```python
  def rasterise_pdf(data: bytes, dpi: int = 200) -> bytes   # image-only PDF, same page sizes
  class DiskTranscriber:  # PageTranscriber over an OpenAI-compatible endpoint
      def __init__(self, pdf: bytes, *, base_url: str, model: str, cache_dir: Path,
                   api_key: str | None = None, concurrency: int = 4) -> None
  ```
  Arguments added to both scripts: `--ocr-url`, `--ocr-model` (default `local/olmocr-2-7b-1025`),
  `--ocr-cache` (default `<out-dir>/ocr-cache`). The key comes from the `OCR_API_KEY`
  environment variable. `pdf_twins.py` also gains `--rasterise`, which rasterises each twin's
  PDF before decomposing it, and labels the report "rasterised (OCR route)". The cache is
  keyed by the PDF's SHA-256, the model and the page; a second run makes no model calls. The
  client is built as `scripts/ocr_pdf.py` builds it.

- [ ] **Step 1: Write the failing tests:**
  - `test_rasterise_pdf`: a one-page born-digital PDF → same page count and size (±1 pt), and
    `read_text_layer` classifies every page `scanned`.
  - `test_disk_transcriber_caches`: with a fake OpenAI client, the second `transcribe([0])`
    makes no call and returns the same `Transcript`.
- [ ] **Step 2:** Run them. Expected: FAIL.
- [ ] **Step 3:** Implement it, and update the spec's command lines at the top (the
  `decompose.py` and `pdf_twins.py` lines gain the OCR options).
- [ ] **Step 4:** Run them, and `uv run --directory worker python scripts/pdf_twins.py --help`.
  Expected: PASS, and the help lists `--rasterise`.
- [ ] **Step 5:** Commit: `feat(worker): OCR and rasterised twins in the PDF dev tools`.

### Task 7: Docs and release notes

**Files:**
- Modify: `docs/superpowers/specs/2026-10-26-pdf-reader-design.md` (status line: 5c
  implemented; §11 row)
- Modify: `docs/release-notes/Release-Notes-20261027.html` (a 5c section, listed in the
  contents, with "Watch out for" items: PDF decomposer version 1002; scanned pages need the OCR
  model; scanned pages are flagged, not checked)
- Modify: `CLAUDE.md` (where it describes the PDF reader or the decomposer version, if it does)

- [ ] **Step 1:** Write them. Plain words, matching the existing notes' style.
- [ ] **Step 2:** Run `npm run format:check` and `npm run check` from the repo root. Expected:
  PASS.
- [ ] **Step 3:** Commit: `docs: PDF reader step 5c, scanned pages`.

### Task 8: Rasterised twin scores (controller, after the final review)

Needs the layout service and the owner's OCR endpoint. Ask the owner for the endpoint URL in
chat; never read `.env`.

- [ ] **Step 1:** Run `pdf_twins.py --rasterise` on the twins folder 5a used, with a throwaway
  layout container and the owner's OCR endpoint. The out dir goes to the scratchpad.
- [ ] **Step 2:** Add the scores to the spec as §15.8, beside §13's born-digital ones, without
  any document text. Commit.
- [ ] **Step 3:** Report the scores to the owner, and hand over their own scans' run
  (§15.7's third point).
