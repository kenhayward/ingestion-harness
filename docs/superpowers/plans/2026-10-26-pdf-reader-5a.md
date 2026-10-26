# PDF reader, step 5a (born-digital PDFs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose born-digital PDFs into the same checked decomposed document as Word files.
The decomposition runs from a dev tool, with a scorer that measures the result against
Word/PDF twins.

**Architecture:**
- **A `layout` service** (Docling, pinned, its weights baked in) returns Docling's document JSON
  for a page range.
- **The worker:**
  - reads the PDF's text layer itself, with pypdfium2;
  - takes the text from the PDF, and the structure from Docling;
  - drops furniture under guards;
  - builds headings, tables, paragraphs, figures and notes;
  - runs a per-page, count-based text-accounting check before returning a `Decomposition`.
- **Not in 5a:**
  - CT Studio's job, API and Conversion tab (5b, after the owner's review decision);
  - scanned pages (5c).

**Tech Stack:**
- the worker: Python 3.12, pydantic, pypdfium2 and pypdf (both already dependencies), httpx;
- the layout service: FastAPI and uvicorn, with Docling 2.142.1 on CPU PyTorch;
- tests: pytest, ruff, mypy.

**Spec:** `docs/superpowers/specs/2026-10-26-pdf-reader-design.md` ("the PDF spec"). It extends
`docs/superpowers/specs/2026-10-23-document-decomposition-design.md` ("the decomposition spec").

## Global Constraints

- **Public repo:** no vendor, product or customer names in code, tests, fixtures or docs. Test
  PDFs are synthetic, built in the tests.
- **The worker never imports Docling.** It reads the service's JSON through its own typed subset.
- **Pinned versions:**
  - Docling `2.142.1`, the only Docling version the layout service installs;
  - the layout weights `docling-project/docling-layout-heron` at revision
    `8f39ad3c0b4c58e9c2d2c84a38465abf757272d8`;
  - the table weights `docling-project/docling-models` at revision
    `fc0f2d45e2218ea24bce5045f58a389aed16dc23`.

  The weights are baked into the image, and nothing is downloaded at run time
  (`HF_HUB_OFFLINE=1`).
- **Licences:**
  - Docling and its packages: MIT;
  - the layout weights: Apache-2.0;
  - the table weights: CDLA-Permissive-2.0.

  Confirm each at the pinned revision, and record it in `deploy/layout/README.md`.
- **The layout service** sits on an internal compose network shared only with the worker, and
  publishes no ports.
- **Docling options:** OCR off, table structure on, TableFormer `ACCURATE`, cell matching on.
- **Text comes from the text layer**, never from Docling's `text`.
- **Flag codes:** only existing codes (`model.py` `FlagCode`). Every inference is
  `structure_inferred`. The bridge contract does not change.
- **Limits:** a page limit of `500`, and a default chunk of `20` pages per layout request.
- **Committing:** stage files by name; never `git add -A`.
- **The gate**, before a task is complete:
  - `uv run --directory worker pytest -q`;
  - `uv run --directory worker ruff check . && uv run --directory worker ruff format --check .`;
  - `uv run --directory worker mypy`;
  - for the final task, also `npm run check` and `npm run format:check` from the repo root.

## Review Focus

- **Two-column pages.** A paragraph join, or an orphan line's placement, never crosses a column.
  Pinned in Task 4 (`test_orphan_line_stays_in_its_column`) and Task 8
  (`test_no_join_across_columns`).
- **A table split exactly at a layout-chunk boundary** still joins. Pinned in Task 7
  (`test_table_split_at_chunk_boundary_joins`, with `chunk=1`).
- **A heading's text repeated in the running header** on every page. The header copy is dropped,
  and the body heading stays. Pinned in Task 5 (`test_header_copy_of_a_heading_keeps_the_heading`).
- **A rotated landscape page with a wide table.** It reads upright, and the table is `wide`.
  Pinned in Task 1 (`test_rotated_page_reads_upright`) and Task 7 (`test_landscape_table_is_wide`).
- **A blank page in the middle of the document** is read as born-digital, with no failure. Tables
  on either side of it are not joined. Pinned in Task 1 (`test_blank_page_is_born_digital`) and
  Task 7 (`test_no_join_across_a_blank_page`).

## Out of scope (5b and 5c; carry these notes forward)

- Accepting PDFs in `run_decompose`, the API's conversion upload (`NOT_A_WORD_DOCUMENT`) and the
  Conversion tab.
- The idempotency key: it should take the PDF reader's version for PDFs. Today `deliver.py` passes
  `DECOMPOSER_VERSION`.
- Scanned pages. In 5a, a scanned page fails the document with
  `page N is scanned; scanned pages are not read yet`.

## File structure

```
deploy/layout/                      the layout service (own uv project)
  pyproject.toml  Dockerfile  README.md
  layout_service/app.py             FastAPI app, analyser injected
  layout_service/docling_analyser.py
  tests/test_app.py                 fake analyser; never imports docling
deploy/docker-compose.yml           + layout service, + layout network, worker LAYOUT_URL
.github/workflows/ci.yml            + layout service test job
worker/src/ingest_worker/decompose/pdf/
  __init__.py      decompose_pdf, PDF_READER_VERSION, MAX_PAGES
  textlayer.py     chars, pages, page kind, symbols
  layout.py        Docling JSON subset, analyser protocol, HTTP client, chunking
  pieces.py        Piece, Ledger, attach_text (text into layout items; orphans)
  furniture.py     furniture, contents, header fields, dropped summary
  outline.py       bookmarks, typed numbers, heading levels
  tables.py        PDF tables: grid, joins, captions, notes, alignment
  build.py         sections, paragraphs, lists, figures, equations, notes, links, properties
  crop.py          PageCropper: page regions to PNG
  fidelity.py      per-page and per-table accounting
  scoring.py       twin scores
worker/src/ingest_worker/decompose/fidelity.py   expose check_references (shared)
worker/scripts/decompose.py         accepts PDFs (--layout-url)
worker/scripts/pdf_twins.py         twin scorer CLI
worker/tests/decompose/pdf/
  make_pdf.py      synthetic PDF builder        docling.py   Docling-shaped dict builder
  fakes.py         FakeLayout, FakeCropper      fixtures/    one captured real response
  test_*.py
```

---

### Task 1: Synthetic PDFs and the text layer

**Files:**
- Create: `worker/tests/decompose/pdf/__init__.py`, `worker/tests/decompose/pdf/make_pdf.py`,
  `worker/src/ingest_worker/decompose/pdf/__init__.py` (empty for now),
  `worker/src/ingest_worker/decompose/pdf/textlayer.py`,
  `worker/tests/decompose/pdf/test_textlayer.py`

**Interfaces:**
- Produces (the test builder):
  - `Run(text: str, x: float, y: float, size: float = 11, font: str = "Helvetica", invisible: bool = False, rise: float = 0)`;
  - `Img(x: float, y: float, w: float, h: float)`;
  - `Page(runs: list[Run], images: list[Img] = [], size: tuple[float, float] = (595, 842), rotate: int = 0, lines: list[tuple[float, float, float, float]] = [])`;
  - `make_pdf(pages: list[Page], *, outline: list[tuple[int, str, int, float | None]] = (), password: str | None = None, info: dict[str, str] = {}, links: list[tuple[int, tuple[float, float, float, float], str]] = ()) -> bytes`.

  The builder's details:
  - y is from the top, in points;
  - fonts are the standard 14 (Helvetica, Helvetica-Bold, Helvetica-Oblique, Symbol);
  - an outline entry is `(level, title, page index, top or None)`;
  - `lines` draws ruling lines, `rise` raises a run (superscript), and `invisible` uses render
    mode 3.
- Produces (the text layer):
  - `Char(index: int, text: str, font: str, size: float, bold: bool, italic: bool, x0: float, y0: float, x1: float, y1: float, baseline: float, visible: bool)`;
  - `PageText(index: int, width: float, height: float, chars: tuple[Char, ...], image_area: float)`,
    with the property `kind -> Literal["born_digital", "scanned"]`;
  - `TextLayer(pages: tuple[PageText, ...], unmapped_symbols: tuple[tuple[int, str, str], ...])`,
    where an unmapped symbol is `(page, font, char)`;
  - `read_text_layer(data: bytes) -> TextLayer`.

  The text layer's details:
  - every coordinate is in points, top-left origin, on the page as displayed (`/Rotate`
    applied);
  - `image_area` is the fraction of the page covered by image objects.

- [ ] **Step 1: Write the failing tests** in `test_textlayer.py`:
  - `test_chars_carry_font_size_and_position`: `Run("Hello", 72, 100)` gives 5 chars "H…o".
    Their font is "Helvetica", their size is 11, `x0 ≈ 72` within 1, and the baseline is about
    100 within 2.
  - `test_bold_and_italic_from_font_name`: Helvetica-Bold gives `bold`; Helvetica-Oblique gives
    `italic`.
  - `test_symbol_font_mapped`: the Symbol code 0xB0 (written as `°` in a Symbol run) reads
    as "°". A private-use char with no table entry is kept and listed in `unmapped_symbols`.
  - `test_invisible_text_is_not_visible`: an `invisible=True` run gives `visible == False`.
  - `test_page_kinds`:
    - a page with visible text is `born_digital`;
    - a page with only an invisible run over an `Img(0, 0, 595, 842)` is `scanned`;
    - a page with only a full-page image is `scanned`.
  - `test_blank_page_is_born_digital`: no runs and no images give `born_digital`.
  - `test_rotated_page_reads_upright`: on `Page(size=(595, 842), rotate=90)`, the page's
    `width == 842`, and a run's chars run left to right in increasing `x0`.
  - `test_password_protected_is_rejected`: `make_pdf(..., password="x")` raises
    `DecompositionRejected`.
  - `test_unparseable_is_rejected`: `b"%PDF-1.7 garbage"` raises `DecompositionRejected`.
- [ ] **Step 2: Run** `uv run --directory worker pytest tests/decompose/pdf/test_textlayer.py -q`.
  Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `make_pdf`, then `read_text_layer`, in `textlayer.py`:
  - **Chars:** use pypdfium2's text page with its raw API for each char's font name, size,
    origin, box and render mode (`FPDFText_GetTextObject`, then `FPDFTextObj_GetTextRenderMode`;
    render mode 3 is invisible).
  - **Bold and italic:** from the font name. Bold matches `(?i)bold|black|heavy|semibold|demi`;
    italic matches `(?i)italic|oblique`.
  - **Symbols:** map a private-use code with `symbol_fonts.font_family` and `TABLES` (`FIRST`
    to `LAST`).
  - **Image area:** from the image page objects' bounds, clipped to the page.
  - **Rejection:** any pdfium load error, a password error included, raises
    `DecompositionRejected`. A PDF that opens with an empty password is read.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(pdf): the text layer and page kinds`.

### Task 2: The layout service

**Files:**
- Create: `deploy/layout/pyproject.toml`, `deploy/layout/Dockerfile`, `deploy/layout/README.md`,
  `deploy/layout/layout_service/__init__.py`, `deploy/layout/layout_service/app.py`,
  `deploy/layout/layout_service/docling_analyser.py`, `deploy/layout/tests/test_app.py`
- Modify: `deploy/docker-compose.yml` (the `layout` service and the `layout` network, and on the
  worker `LAYOUT_URL: ${LAYOUT_URL-http://layout:8000}`, `networks: [..., layout]` and
  `depends_on.layout: service_healthy`); `.github/workflows/ci.yml` (job `layout`:
  `uv run --project deploy/layout pytest -q`, with no docling extra)

**Interfaces:**
- Produces, over HTTP:
  - `POST /layout`: a multipart `file` (the PDF) with form fields `first` and `last` (1-based,
    inclusive). It returns 200 with `{"pages": <page count of the whole PDF>, "document": <Docling export_to_dict>}`.
  - Errors:
    - 400 `not a PDF` when the body doesn't start with `%PDF-`;
    - 413 above `MAX_BYTES` (256 MiB) or above `MAX_PAGES` (500) pages;
    - 422 for a bad range.
  - `GET /health`: `{"status": "ok", "fingerprint": "docling 2.142.1; layout 8f39ad3c; tables fc0f2d45"}`.
- Produces, in Python:
  - `create_app(analyser: Analyser, *, max_pages: int = 500, max_bytes: int = 256 * 2**20) -> FastAPI`;
  - `Analyser` Protocol: `page_count(pdf: bytes) -> int`, `analyse(pdf: bytes, first: int, last: int) -> dict`, `fingerprint() -> str`;
  - `DoclingAnalyser` with the Global Constraints' options, using `convert(..., page_range=(first, last))`;
  - `app:main` builds `DoclingAnalyser`, which is imported only there.

- [ ] **Step 1: Write the failing tests** in `deploy/layout/tests/test_app.py`. They use a
  `FakeAnalyser` and httpx's `TestClient`:
  - `test_layout_returns_document_and_page_count`: the fake returns `{"body": {}}` and 3 pages;
    the response is `{"pages": 3, "document": {"body": {}}}`, and the fake was called with
    `(first=1, last=2)`.
  - `test_not_a_pdf_is_400`.
  - `test_too_many_pages_is_413`: `max_pages=2` and 3 pages.
  - `test_bad_range_is_422`: `first=3, last=2`, and `last` above the page count.
  - `test_health_reports_fingerprint`.
- [ ] **Step 2: Run** `uv run --project deploy/layout pytest -q`. Expected: FAIL.
- [ ] **Step 3: Implement** `app.py` and `docling_analyser.py`. The Dockerfile:
  - Base it on `python:3.12-slim` and install with uv.
  - Install CPU torch from `https://download.pytorch.org/whl/cpu`, then the project with its
    `docling` extra, pinned to `docling==2.142.1`.
  - Download both weights at their pinned revisions in a build step (`huggingface_hub.snapshot_download(repo, revision=...)` into `/models`), and point Docling's `artifacts_path` at `/models`.
  - Set `ENV HF_HUB_OFFLINE=1`.
  - Run as a non-root user: `uvicorn layout_service.app:main --factory --port 8000`.
  - The healthcheck is `GET /health`.

  The compose service gets `mem_limit: 6g` and `read_only: true` with a `/tmp` tmpfs. The
  `layout` network is `internal: true`, like `converter`. Document the service, its licences and
  its pins in `README.md`.
- [ ] **Step 4: Run the tests.** Expected: PASS. Then
  `docker compose -f deploy/docker-compose.yml build layout`. Expected: the build succeeds.
  Report the image size in the task report.
- [ ] **Step 5: Commit** `feat(layout): a Docling layout service on an internal network`.

### Task 3: The worker's layout client and Docling subset

**Files:**
- Create: `worker/src/ingest_worker/decompose/pdf/layout.py`, `worker/tests/decompose/pdf/docling.py`,
  `worker/tests/decompose/pdf/fakes.py`, `worker/tests/decompose/pdf/test_layout.py`,
  `worker/tests/decompose/pdf/fixtures/two-pages.pdf`, `worker/tests/decompose/pdf/fixtures/two-pages.docling.json`
- Modify: `worker/src/ingest_worker/config.py` (`layout_url: str | None` from `LAYOUT_URL`)

**Interfaces:**
- Consumes: Task 2's HTTP API.
- Produces:
  - `BBox = tuple[float, float, float, float]`: x0, y0, x1, y1, in points, top-left origin. Docling's bottom-left boxes are converted with its `pages[n].size.height`.
  - `LayoutText(ref: str, label: str, page: int, bbox: BBox, level: int | None, layer: Literal["body", "furniture"], group: str | None)`;
    the label is Docling's (`text`, `section_header`, `title`, `list_item`, `caption`,
    `footnote`, `page_header`, `page_footer`, `formula`, `document_index`, …), and the page is
    0-based.
  - `LayoutCell(row: int, col: int, row_span: int, col_span: int, bbox: BBox | None, header: bool)`;
  - `LayoutTable(ref: str, page: int, bbox: BBox, rows: int, cols: int, cells: tuple[LayoutCell, ...], captions: tuple[str, ...])`;
  - `LayoutPicture(ref: str, page: int, bbox: BBox, captions: tuple[str, ...])`;
  - `LayoutItem = LayoutText | LayoutTable | LayoutPicture`;
  - `LayoutDoc(items: tuple[LayoutItem, ...])`, in Docling's reading order, with groups
    flattened;
  - `parse_docling(doc: Mapping[str, Any], *, page_offset: int = 0) -> LayoutDoc`;
  - `class LayoutAnalyser(Protocol)`: `analyse(pdf: bytes, first: int, last: int) -> Mapping[str, Any]` and `fingerprint() -> str`;
  - `HttpLayoutAnalyser(base_url: str, client: httpx.Client | None = None, timeout_s: float = 600.0)`;
  - `class LayoutUnavailable(Exception)`, for the retryable cases: unreachable, 5xx, or a
    timeout. A 4xx raises `DecompositionRejected`.
  - `analyse_document(analyser: LayoutAnalyser, pdf: bytes, page_count: int, *, chunk: int = 20) -> LayoutDoc`
    concatenates the chunks in page order.
  - Test helpers:
    - `docling.py` builds Docling-shaped dicts: `doc(pages=[(w, h)], items=[...])`, with item
      helpers `text(label, page, bbox, level=None)`, `table(page, bbox, cells)`,
      `picture(page, bbox)` and `group(children)`;
    - `fakes.py`: `FakeLayout(responses: Callable[[int, int], dict])`, which records its calls.

- [ ] **Step 1: Capture the fixture.**
  - Build `two-pages.pdf` with `make_pdf`: a numbered heading, two paragraphs, a 3×3 ruled
    table, a footer "Page n" and a picture.
  - Run it through the Task 2 service locally (`docker run` on the built image with
    `-p 127.0.0.1:8099:8000`, stopped after).
  - Save the response's `document` as `two-pages.docling.json`.
  - Commit the script lines used, as a module docstring in `test_layout.py`.
- [ ] **Step 2: Write the failing tests:**
  - `test_parses_the_captured_fixture`:
    - the labels include `section_header`, `text`, `table` and `page_footer`;
    - the table has `rows == 3`, `cols == 3` and 9 cells;
    - the footer is `layer == "furniture"`;
    - every bbox lies within its page, top-left origin (y0 < y1).
  - `test_bottom_left_boxes_are_flipped`: a builder item at a bottom-left `(10, 800, 50, 790)`
    on an 842-high page becomes `(10, 42, 50, 52)`.
  - `test_groups_flatten_in_order`: list items in a group keep their order and carry `group`.
  - `test_chunks_cover_all_pages_and_offset`: 45 pages with `chunk=20` make the calls `(1,20)`,
    `(21,40)` and `(41,45)`; the second chunk's items have `page` offset by 20.
  - `test_unreachable_is_layout_unavailable` and `test_4xx_is_rejected`, through
    `httpx.MockTransport`.
- [ ] **Step 3: Run** `uv run --directory worker pytest tests/decompose/pdf/test_layout.py -q`.
  Expected: FAIL.
- [ ] **Step 4: Implement** `layout.py`, then add `LAYOUT_URL` to `config.py`. Unknown labels
  parse as `text`.
- [ ] **Step 5: Run the tests.** Expected: PASS.
- [ ] **Step 6: Commit** `feat(pdf): the worker's layout client`.

### Task 4: Text into layout items

**Files:**
- Create: `worker/src/ingest_worker/decompose/pdf/pieces.py`, `worker/tests/decompose/pdf/test_pieces.py`

**Interfaces:**
- Consumes: `TextLayer` and `PageText` (Task 1); `LayoutDoc` and its items (Task 3).
- Produces:
  - `Line(page: int, chars: tuple[Char, ...], bbox: BBox)`, with `.text: str`;
  - `Piece(ref: str, label: str, page: int, bbox: BBox, lines: list[Line], level: int | None, group: str | None, orphan: bool = False, table: LayoutTable | None = None, cells: dict[tuple[int, int], list[Line]] | None = None, picture: LayoutPicture | None = None, heading_level: int | None = None)`;
  - `Piece.inlines() -> list[Text]`: the lines joined with single spaces, with runs merged by
    marks (`merge_runs` from `decompose/inline.py`);
  - `Ledger`:
    - `own(page: int, char_index: int, owner: str) -> None`, where the owner is a piece ref,
      later a block id;
    - `drop(page: int, char_index: int, reason: DropReason) -> None`;
    - `entries(page: int) -> dict[int, list[str]]`;
    - `rename(old: str, new: str) -> None`.
  - `DropReason = Literal["furniture", "contents", "heading-number", "list-marker", "caption-number", "repeated-header"]`;
  - `attach_text(layout: LayoutDoc, text: TextLayer) -> tuple[list[Piece], Ledger]`.

**Rules (spec §4.2):**
- **Which chars belong to an item:** a char belongs to the item whose bbox contains its centre.
  When there are several, the smallest box wins, and a table cell beats its table. Invisible
  chars are ignored.
- **Lines:** chars group into lines by baseline, within `0.5 × size`. Lines run top to bottom,
  and chars left to right. A space is inserted where the gap is over `0.25 × size` and no space
  char is there.
- **Marks:**
  - superscript when `size ≤ 0.85 ×` the line's most common size and the baseline is at least
    `0.2 ×` that size above the line's baseline;
  - subscript when it is that far below;
  - bold and italic from the chars.
- **Orphans:** visible chars on a born-digital page in no item become orphan pieces, labelled
  `text`, one per line run (consecutive lines less than `1.5 ×` line height apart). Each is
  placed after the last item above it whose x-range overlaps it on that page, or first on the
  page when there is none.
- **Items with no chars:** a Docling item with no chars is dropped. Its text is never used.
- **Ownership:** every char a piece holds is owned by its ref.

- [ ] **Step 1: Write the failing tests:**
  - `test_text_comes_from_the_text_layer`: the Docling item's `text` is "WRONG"; the piece's text
    is the PDF's "Right text".
  - `test_superscript_marker`: `Run("3", …)` then `Run("b", size=7, rise=3)` give inlines
    `[Text("3"), Text("b", marks={"superscript"})]`.
  - `test_cells_get_their_own_lines`: a 2×2 table's cell texts, by `(row, col)`.
  - `test_orphan_line_is_kept_and_placed`: a line outside every item comes after the item above
    it, with `orphan=True`, and the ledger owns its chars.
  - `test_orphan_line_stays_in_its_column`: on a two-column page, an orphan in the right column
    comes after the right column's item above it, not the left's.
  - `test_every_visible_char_is_owned_once`: on the fixture page, every visible char has exactly
    one ledger entry.
- [ ] **Step 2: Run** `uv run --directory worker pytest tests/decompose/pdf/test_pieces.py -q`.
  Expected: FAIL.
- [ ] **Step 3: Implement** `pieces.py`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(pdf): text from the text layer into layout items`.

### Task 5: Furniture, contents and header fields

**Files:**
- Create: `worker/src/ingest_worker/decompose/pdf/furniture.py`, `worker/tests/decompose/pdf/test_furniture.py`

**Interfaces:**
- Consumes: `Piece` and `Ledger` (Task 4); `TextLayer` (Task 1).
- Produces:
  - `Dropped(furniture: dict[int, int], contents_pages: tuple[int, ...])`, where `furniture` maps
    a page to its line count;
  - `drop_furniture(pieces: list[Piece], text: TextLayer, ledger: Ledger) -> tuple[list[Piece], Dropped, list[Property]]`;
  - `dropped_flag(d: Dropped) -> Flag | None`.

**Rules (spec §4.3), with these values:**
- **The margin bands** are the top and bottom `0.1` of the page's height.
- **Furniture:** a line is furniture only if it lies in a band, and either Docling put it in the
  `furniture` layer, or its key repeats within 3 pt of the same y on at least `max(3, ceil(n / 2))`
  of the `n` pages. The key is its text with digits as `#`, lowercased, with whitespace
  collapsed. A furniture label outside the bands is ignored, and the line stays body text.
- **Contents:**
  - The pattern for a contents line is
    `^(?P<title>.*\S)\s*(?:\.{2,}|…+)?\s+(?P<page>\d{1,4})$`. A dot leader is `\.{2,}` or `…`.
  - These are dropped:
    - a `document_index` item, whole;
    - a heading matching `(?i)^(table of contents|contents|list of (tables|figures))$`, with the
      run of contents lines after it;
    - any run of at least 3 consecutive contents lines, at least half of them with dot leaders.
  - A single contents-like line in the body is kept.
- **Ledger:** dropped chars get the reason `furniture` or `contents`.
- **Header fields:** a dropped furniture line matching
  `^(?P<name>[A-Z][\w /&-]{1,40}):\s*(?P<value>\S.*)$` becomes
  `Property(name, value, origin="header-field")`, kept once per name and value.
- **The flag:** `dropped_flag` gives `Flag(code="structure_inferred", severity="info", at=None, message=...)`.
  The message is `"Dropped as page furniture: 14 lines on 7 pages"`, followed by
  `"; contents and lists on pages 2–3"` when there are contents. It gives `None` when nothing was
  dropped.

- [ ] **Step 1: Write the failing tests:**
  - `test_repeated_footer_is_dropped`: "Page 1" … "Page 4" at the foot of 4 pages are dropped.
    The summary is `{0: 1, 1: 1, 2: 1, 3: 1}`.
  - `test_furniture_label_in_the_body_is_kept`: a body line Docling labels `page_header` at
    `y = 400` stays.
  - `test_header_copy_of_a_heading_keeps_the_heading`: "Stability Report" in the top band on 4
    pages is dropped, and a body heading "Stability Report" on page 1 stays.
  - `test_contents_block_is_dropped`: "Contents" plus 4 dot-leader lines are dropped, and the
    flag message names the page.
  - `test_single_contents_like_line_is_kept`: "Results 12" alone in the body stays.
  - `test_header_field_becomes_property`: a top-band line "Document Type: Report" on every page
    gives one `Property("Document Type", "Report", "header-field")`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** `furniture.py`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(pdf): drop furniture and contents, under guards`.

### Task 6: Headings and their levels

**Files:**
- Create: `worker/src/ingest_worker/decompose/pdf/outline.py`, `worker/tests/decompose/pdf/test_outline.py`

**Interfaces:**
- Consumes: `Piece` and `Ledger` (Task 4).
- Produces:
  - `Bookmark(level: int, title: str, page: int | None, top: float | None)`, with a 1-based
    level, a 0-based page, and `top` from the `/XYZ` destination, top-left origin;
  - `read_bookmarks(data: bytes) -> list[Bookmark]`, through pypdf;
  - `typed_number(text: str) -> tuple[int, int] | None`: `(level, length)`, matching
    `^\s*(\d{1,3}(?:\.\d{1,3})*)(?:\.\s*|\s+)(?=[^\d\s.])`;
  - `assign_headings(pieces: list[Piece], bookmarks: list[Bookmark], ledger: Ledger) -> tuple[list[Piece], list[Flag]]`.
    It sets `heading_level` on heading pieces; every other piece keeps `None`.

**Rules (spec §4.4):**
- **Bookmarks first.**
  - An entry's key is its title, lowercased, with whitespace removed and the typed number
    removed.
  - The entry matches the line on its page with the same key (the line's own typed number
    removed) whose y is nearest `top`, or the first such line when there is no `top`.
  - That line becomes a heading piece. If it was inside a larger piece, the piece is split:
    lines before it, the heading, then lines after it.
  - Docling headings with no entry become `text`.
  - An entry that matches nothing, or matches `CAPTION_PREFIX` (`decompose/tables.py`), is left
    out, with `Flag(structure_inferred, warning, at=None, message="Bookmark left out: <title>")`.
  - When fewer than half the entries match, the bookmarks are ignored and the next rule applies.
- **Numbering.** Without trusted bookmarks, `section_header` pieces are headings, and the typed
  number gives the level.
- **Inference.** An unnumbered `section_header` takes the previous numbered heading's level plus
  one, or level 1 when there is none. Its flag message is `"Heading level inferred"`, at the
  section; Task 8 sets `at` once ids exist.
- **The title.** A Docling `title` piece stays a paragraph.
- **The ledger.** A heading's typed-number chars are dropped with the reason `heading-number`:
  with bookmarks, only when the number's parts equal the bookmark's level (as Word does);
  otherwise, always.

- [ ] **Step 1: Write the failing tests:**
  - `test_typed_number_forms`: `"2.1 Scope"` gives `(2, 4)`; `"2.1. Scope"` gives `(2, 5)`;
    `"1.4.Microbial"` gives `(2, 4)`; `"2023 Results"` gives `None`; `"1.5mg Dose"` gives `None`.
  - `test_bookmarks_set_headings_and_levels`: a three-entry outline gives three headings at
    levels 1, 2 and 2, and a Docling heading that isn't in the outline becomes `text`.
  - `test_bookmark_line_inside_a_paragraph_is_split_out`.
  - `test_bookmark_without_a_match_is_flagged`.
  - `test_untrusted_bookmarks_fall_back_to_numbering`: 1 of 3 entries matches.
  - `test_unnumbered_heading_goes_one_below`: "3 Method" then "Conditions" gives levels 1 and 2,
    and one flag.
  - `test_heading_number_chars_are_dropped_in_the_ledger`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** `outline.py`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(pdf): headings from bookmarks, numbering or inference`.

### Task 7: Tables

**Files:**
- Create: `worker/src/ingest_worker/decompose/pdf/tables.py`, `worker/tests/decompose/pdf/test_pdf_tables.py`

**Interfaces:**
- Consumes: `Piece` and `Ledger` (Task 4); `CAPTION_PREFIX`, `NOTE_PREFIX`, `caption_number`
  and `caption_key` (`decompose/tables.py`).
- Produces:
  - `join_split_tables(pieces: list[Piece], text: TextLayer, ledger: Ledger) -> list[Piece]`.
    A joined piece keeps the first's ref, and its `cells` gain the continuation's rows.
  - `build_table(piece: Piece, table_id: str, pieces_after: list[Piece], pieces_before: list[Piece], ledger: Ledger, page: PageText) -> tuple[Table, set[str], list[Flag]]`.
    The middle element is the refs of the pieces it consumed, as its caption and its notes.

**Rules (spec §4.6):**
- **Joining.**
  - A table that is the last body piece on page p joins a table that is the first body piece on
    page p + 1 when:
    - they have the same `cols`;
    - each column's x0 lies within `0.05 ×` the table's width of the other's.
  - A page with no body pieces between them blocks the join.
  - **Repeated headers:** the continuation's leading rows whose cell keys equal the first
    table's first rows are removed, and their chars are dropped as `repeated-header`. A cell key
    is its text, normalised, with whitespace removed.
  - Joins work across chunk boundaries, since pieces carry absolute pages.
- **The grid.**
  - Spans come from `LayoutCell`.
  - A cell holds one `Paragraph` of its lines joined with spaces, or no blocks when it is empty,
    the same form as the Word reader's empty cell.
  - `header` and `header_rows`: the count of leading rows whose cells are all Docling column
    headers.
- **Alignment.**
  - Horizontal: the cell's text box against its cell box. Both side gaps within `0.15 ×` the
    cell width of each other give `center`. A right gap under a third of the left gap gives
    `right`. Otherwise `left`.
  - Vertical: `middle` when the text's centre is in the middle third and the free height is at
    least 1.5 lines; `bottom` likewise; otherwise `top`.
- **Columns.** `column_widths` come from the x boundaries of the span-1 cells, normalised to sum
  to 1. `wide` is set when the page is wider than it is tall.
- **The caption.** The caption is, in this order: Docling's caption refs; the piece just above
  (or just below) matching `CAPTION_PREFIX` with the table label; or a first row that is one
  full-width cell matching `CAPTION_PREFIX`.
  - The caption number is removed, and its chars dropped as `caption-number`.
  - `numbered=True`, the `caption_position` is set, and `key=caption_key(...)`.
- **Notes.**
  - The consecutive pieces just after the table that match `NOTE_PREFIX` become `TableNote`s,
    with marker and inlines.
  - Last rows that are one full-width cell matching `NOTE_PREFIX` move out of the grid into the
    notes.
- **The flag.** One `Flag(structure_inferred, warning, at=table_id)`. Its message is
  `"Table grid inferred from layout"`, plus `"; joined across pages 3–4"` and/or
  `"; notes moved out of the grid"` when those happened.

- [ ] **Step 1: Write the failing tests:**
  - `test_grid_and_spans`: a 3×3 table with a 2-row span gives `row_span == 2`, and the covered
    slot is absent.
  - `test_split_table_joins_and_drops_repeated_header`: pages 1 and 2 each start with the header
    row "A | B". The result has one table with the header once, and the ledger drops page 2's
    header chars as `repeated-header`. The flag names pages 1–2.
  - `test_table_split_at_chunk_boundary_joins`: as above, through `analyse_document` with
    `chunk=1`.
  - `test_no_join_across_a_blank_page`.
  - `test_no_join_when_columns_differ`.
  - `test_caption_above_is_taken_and_numbered`: "Table 3: Results" gives caption "Results",
    `numbered=True`, `caption_position="above"`, and the "Table 3:" chars are dropped.
  - `test_caption_in_first_row`.
  - `test_notes_after_the_table`: "a: measured at 25 °C" gives `TableNote("a", ...)`.
  - `test_note_row_moves_out_of_grid`.
  - `test_alignment`: a right-aligned number gives `right`; a centred header gives `center`.
  - `test_landscape_table_is_wide`: on a rotated page, `wide=True`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** `pdf/tables.py`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(pdf): tables, joined across pages, with captions and notes`.

### Task 8: The document: sections, paragraphs and lists

**Files:**
- Create: `worker/src/ingest_worker/decompose/pdf/build.py`, `worker/src/ingest_worker/decompose/pdf/crop.py` (the protocol only),
  `worker/tests/decompose/pdf/test_build.py`

**Interfaces:**
- Consumes: Tasks 4 to 7; `section_id` and `child_id` (`decompose/ids.py`).
- Produces:
  - `Provenance(pages: dict[str, set[int]], regions: dict[str, list[tuple[int, BBox]]])`: the
    pages behind each block id, and each table's region on each page;
  - `build_document(pieces: list[Piece], *, text: TextLayer, ledger: Ledger, cropper: PageCropper, properties: list[Property], flags: list[Flag]) -> tuple[DecomposedDocument, dict[str, bytes], Provenance]`.
    The middle element maps image ids to PNG bytes.
  - `class PageCropper(Protocol)` in a new `pdf/crop.py`: `crop(page: int, bbox: BBox) -> bytes`,
    returning a PNG. This task's tests use `FakeCropper` from `fakes.py`, which returns a 10×10
    PNG. Task 9 adds the real cropper.

**Rules:**
- **Sections.**
  - Sections nest by `heading_level`. A skipped level is flagged `heading_skipped_level`, as in
    `body.py`.
  - A section's id is `section_id(parent, full heading text, occurrence)`, and its title is the
    inlines without the typed number, keeping only superscript and subscript (as `_heading_title`
    in `body.py` does).
  - Blocks before the first heading are the document's leading blocks.
- **Block ids** follow `body.py`'s scheme (`child_id(section, kind, n)`, with the kinds `p`,
  `list`, `table`, `figure`, `image` and `equation`). `Ledger.rename` moves each piece ref to its
  block id.
- **Paragraph joins (spec §4.5).** Two consecutive `text` pieces are joined when:
  - the first doesn't end in `[.!?:;]`;
  - their x-ranges overlap (the same column);
  - and either the gap is at most `1.5 ×` the line height on the same page, or the first is the
    last body piece of its page and the second the first body piece of the next.
- **Lists.**
  - Consecutive `list_item` pieces in one Docling group form a `ListBlock`.
  - Nesting comes from x0 steps of more than 6 pt.
  - `ordered` when the leading marker matches `^\(?(\d+|[a-z]|[ivx]+)[.)]`.
  - A marker made of bullet glyphs (`•●○▪■–-`) or ordered markers is removed, and its chars
    dropped as `list-marker`.
- **Flags.** Orphan pieces get `Flag(structure_inferred, warning, at=block_id, message="Text the layout analysis missed")`.
  Heading flags from Task 6 get their `at`.
- **The report** is ordered with `in_document_order` (`decompose/__init__.py`).

- [ ] **Step 1: Write the failing tests:**
  - `test_sections_nest_by_level`: headings at levels 1, 2, 2 and 1 give that tree, with ids
    from the full heading text.
  - `test_title_has_no_typed_number_and_no_bold`.
  - `test_paragraph_split_at_a_line_is_joined`: "Analytical Method for the Drug" and "Substance
    used" give one paragraph.
  - `test_paragraph_split_at_a_page_break_is_joined`.
  - `test_sentence_end_is_not_joined`.
  - `test_no_join_across_columns`.
  - `test_list_nesting_and_markers_dropped`: two levels of bullets give a nested `ListBlock`
    with no "•" in its text, and the "•" chars are dropped as `list-marker`.
  - `test_orphan_is_flagged_at_its_block`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** `build.py`, for sections, paragraphs and lists. Pictures, formulas
  and footnotes are skipped for now, and are added in Task 9.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(pdf): sections, paragraphs and lists`.

### Task 9: Figures, equations, footnotes, links and properties

**Files:**
- Create: `worker/tests/decompose/pdf/test_build_media.py`
- Modify: `worker/src/ingest_worker/decompose/pdf/build.py`, `worker/src/ingest_worker/decompose/pdf/crop.py`

**Interfaces:**
- Consumes: `PageCropper` (Task 8).
- Produces:
  - `PdfiumCropper(data: bytes, dpi: int = 300)`, implementing `PageCropper`;
  - `pdf_properties(data: bytes) -> list[Property]`: the info dictionary's Title, Author,
    Subject, Keywords, CreationDate and ModDate, under the names `properties.py`'s `_CORE` uses,
    with `origin="pdf-info"`.

**Rules (spec §4.7, §4.8):**
- **Pictures.** A picture is cropped to an `Image`:
  - `origin="cropped"`;
  - `width_mm` and `height_mm` from the bbox (pt × 25.4 / 72);
  - `align="center"` when the box's centre is within 5% of the page's centre, else `left`;
  - `alt` from the text of the chars inside the box, owned by the image's block.

  It is a `Figure` when it has a caption (Docling's caption refs, or the piece just above or
  below matching `CAPTION_PREFIX` with the figure label, with its number dropped), and an
  `ImageBlock` otherwise. When no single image object covers at least 80% of the box, it is
  flagged `drawing_rendered`.
- **Formulas.** A `formula` piece is cropped to an image, giving `Equation(image_id, mathml=None)`
  and an `EquationBlock`. Its chars are owned by the block, and it is flagged
  `equation_image_only`.
- **Footnotes.**
  - A `footnote` piece whose leading marker matches `^(\d{1,2}|[a-z]|[*†‡§])\s` is linked to a
    superscript run with the same text on the same page. It becomes a `Note`, and that run
    becomes a `NoteRef`.
  - Unmatched, it stays a paragraph, with `Flag(structure_inferred, warning, message="Footnote with no marker found")`.
- **Links.** The PDF's `/Link` annotations with a `/URI` wrap the inlines whose chars lie under
  their rect in a `Link`.
- **Unmapped symbols** are flagged `symbol_unmapped`, as in the Word reader.

- [ ] **Step 1: Write the failing tests:**
  - `test_captioned_picture_is_a_figure`;
  - `test_uncaptioned_picture_is_an_image_block`;
  - `test_text_inside_a_picture_is_its_alt`;
  - `test_drawing_is_flagged`: a picture box over ruling lines with no image object;
  - `test_formula_is_an_image_equation`;
  - `test_footnote_links_to_its_marker`;
  - `test_unmatched_footnote_stays_and_is_flagged`;
  - `test_link_annotation_wraps_text`;
  - `test_info_dictionary_properties`: `make_pdf(info={"/Title": "T"})` gives
    `Property("title", "T", "pdf-info")`, with the name as `_CORE` spells it.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** `crop.py`, then extend `build.py` and add `pdf_properties`.
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(pdf): figures, equations, footnotes, links and properties`.

### Task 10: The PDF fidelity checks and `decompose_pdf`

**Files:**
- Create: `worker/src/ingest_worker/decompose/pdf/fidelity.py`, `worker/tests/decompose/pdf/test_pdf_fidelity.py`,
  `worker/tests/decompose/pdf/test_decompose_pdf.py`
- Modify: `worker/src/ingest_worker/decompose/pdf/__init__.py`; `worker/src/ingest_worker/decompose/fidelity.py`
  (extract `check_references(doc: DecomposedDocument) -> None` from `check`, with no change in
  behaviour; the Word tests stay green)

**Interfaces:**
- Produces:
  - `check_pdf(doc: DecomposedDocument, ledger: Ledger, text: TextLayer, prov: Provenance) -> None`.
    It raises `DecompositionFailed(detail, at)`.
  - `PDF_READER_VERSION = 1` and `MAX_PAGES = 500`.
  - `decompose_pdf(data: bytes, *, layout: LayoutAnalyser, cropper: PageCropper | None = None, chunk: int = 20) -> Decomposition`.
    It returns `Decomposition` from `decompose/__init__.py`. It raises `DecompositionRejected`,
    `DecompositionFailed` or `LayoutUnavailable`.

**Rules (spec §6):**
1. **Every char is accounted for.** Every visible char on a born-digital page has exactly one
   ledger entry, an owner or a drop reason. A char with none fails with
   `"word '<word>' not accounted for"`, and a char with two or more with
   `"word '<word>' read twice"`, at `page N` (1-based).
2. **Pages.** For each page, the word counts of the doc's text units whose block's pages include
   it (`located_text_form` with `Provenance.pages`) must equal the word counts of the chars owned
   by those blocks.
   - The comparison runs after `forms.normalise`, with ligatures U+FB00 to U+FB06 split (NFKC on
     those only) and U+2011 read as `-`.
   - A difference fails with `"page N: '<word>' missing"` or `"page N: '<word>' extra"`, naming
     the first differing word in sorted order.
3. **Tables.** For each table and each of its regions, the words of the owned chars inside the
   region must equal the words in its cells on that page.
4. **References:** `check_references(doc)`.

**The order inside `decompose_pdf`:**
1. `read_text_layer`;
2. fail on more than `MAX_PAGES` pages, with `"the PDF has N pages; the limit is 500"`;
3. fail on any scanned page, with `"page N is scanned; scanned pages are not read yet"`;
4. `analyse_document`;
5. `attach_text`;
6. `drop_furniture`;
7. `read_bookmarks`, then `assign_headings`;
8. `join_split_tables`;
9. `build_document`;
10. the report, with the dropped flag first and then in document order;
11. `check_pdf`;
12. return.

- [ ] **Step 1: Write the failing tests:**
  - in `test_pdf_fidelity.py`, each with a hand-made doc, ledger and text layer:
    - `test_unowned_char_fails_with_page_and_word`;
    - `test_char_read_twice_fails`;
    - `test_block_missing_a_word_fails`;
    - `test_extra_word_fails`;
    - `test_word_moved_out_of_its_table_fails`;
    - `test_words_compare_as_counts_not_order`: the same words in another order pass;
    - `test_ligature_and_nb_hyphen_normalise`;
  - in `test_decompose_pdf.py`, through `FakeLayout` responses built with `docling.py` over
    `make_pdf` pages:
    - `test_end_to_end_small_report`: a heading, a paragraph, a table with a caption and a note,
      a footer and a bookmark outline. The doc has one section, the table is captioned with one
      note, the footer is gone, the check passes, and the report holds the dropped flag and the
      table flag.
    - `test_scanned_page_fails_for_now`;
    - `test_page_limit`: with `MAX_PAGES` monkeypatched to 2, 3 pages fail;
    - `test_layout_unavailable_propagates`;
    - `test_same_pdf_same_document`: two runs give equal `document.model_dump()`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** `pdf/fidelity.py`, then `check_references` in `decompose/fidelity.py`,
  then `decompose_pdf`.
- [ ] **Step 4: Run the whole worker suite** (`uv run --directory worker pytest -q`). Expected:
  PASS, with the Word tests unchanged.
- [ ] **Step 5: Commit** `feat(pdf): the PDF fidelity checks and decompose_pdf`.

### Task 11: The dev tool takes PDFs

**Files:**
- Modify: `worker/scripts/decompose.py`, `worker/tests/decompose/test_cli.py`

**Interfaces:**
- Consumes: `decompose_pdf`, `HttpLayoutAnalyser` and `LayoutUnavailable`.
- Produces: `main(argv, *, renderer=None, layout: LayoutAnalyser | None = None) -> int`.
  - The source is chosen by its bytes: `%PDF-` means PDF.
  - The new option is `--layout-url URL`. A PDF without it exits 2 with
    `"a PDF needs --layout-url"`.
  - `LayoutUnavailable` exits 4, like the converter.
  - The output files are the same as for Word. The docstring's usage gains the PDF form.

- [ ] **Step 1: Write the failing tests:**
  - `test_pdf_is_decomposed`, through an injected `FakeLayout`;
  - `test_pdf_without_layout_url_exits_2`;
  - `test_layout_unavailable_exits_4`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run the tests.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(pdf): the decompose dev tool reads PDFs`.

### Task 12: The twin scorer

**Files:**
- Create: `worker/src/ingest_worker/decompose/pdf/scoring.py`, `worker/scripts/pdf_twins.py`,
  `worker/tests/decompose/pdf/test_scoring.py`

**Interfaces:**
- Produces:
  - `Score(headings_total: int, headings_found: int, levels_right: int, tables_total: int, tables_found: int, shape_right: int, cells_total: int, cells_right: int, words_recall: float, words_precision: float)`;
  - `score(truth: DecomposedDocument, pdf: DecomposedDocument) -> Score`;
  - `total(scores: Sequence[Score]) -> Score`, which sums the counts and weights the word rates
    by the truth's word count.
  - The CLI is
    `uv run --directory worker python scripts/pdf_twins.py <docx-folder> <out-dir> --converter-url URL --layout-url URL [--pdfs <pdf-folder>]`.
    - For each `.docx`: convert it to PDF (`GotenbergConverter.to_pdf`), then decompose both
      (`decompose_docx`, `decompose_pdf`).
    - Print one row per document and a total, and write `scores.json`.
    - A failure is a row with its reason.
    - `--pdfs` adds rows for real PDFs: pages, text check passed or failed, flag counts.

**Rules (as in the spike):**
- **Headings** are keyed by title text, lowercased, with whitespace removed. They are aligned
  with `difflib.SequenceMatcher(autojunk=False)` over the heading sequences, and levels compare
  as depth in the section tree.
- **Tables** are compared through `forms.grid_forms`.
  - Each truth table is paired with the best of the next 4 unpaired PDF tables, by
    cell-text-multiset Jaccard of at least 0.3.
  - The shape is right when the rows and columns are equal.
  - A cell is right when its slot text is equal after whitespace removal.
  - Notes are compared apart from the grid: a truth row that the Word reader kept as notes text
    and the PDF moved to notes is not a missing row. To do that, the truth's last rows matching
    `NOTE_PREFIX` are removed before shapes are compared.
- **Words** are compared as `forms.text_form` words (`\w+|[^\w\s]`), with recall and precision by
  counts.

- [ ] **Step 1: Write the failing tests:**
  - `test_identical_documents_score_full`;
  - `test_missing_heading_and_wrong_level_count`;
  - `test_table_shape_and_cells`;
  - `test_trailing_note_row_in_truth_is_not_a_missing_row`;
  - `test_total_weights_words`.
- [ ] **Step 2: Run the tests.** Expected: FAIL.
- [ ] **Step 3: Implement** `scoring.py`, then the CLI.
- [ ] **Step 4: Run the tests.** Expected: PASS. Then run the CLI on one synthetic `.docx` from
  `tests/decompose/docx.py`'s `build_docx`, against a local converter and layout service, and
  paste the output into the task report.
- [ ] **Step 5: Commit** `feat(pdf): the Word/PDF twin scorer`.

### Task 13: Docs and the gate

**Files:**
- Modify:
  - `docs/superpowers/specs/2026-10-26-pdf-reader-design.md`: a status line saying "5a
    implemented", with the dev tool and scorer commands;
  - `docs/superpowers/specs/2026-10-23-document-decomposition-design.md`: a §11 "Phase 5a
    status" paragraph;
  - `deploy/README.md`: the layout service;
  - the day's release note under `docs/release-notes/`, created if absent, following the last
    one's format. Its entry says "PR to follow" until the PR exists.

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run the full gate** from the repo root: `npm ci`, `npm run check`,
  `npm run format:check`, plus the layout service's tests. Expected: all green. Run
  `npx prettier --write` on changed Markdown or HTML if the format check fails.
- [ ] **Step 3: Commit** `docs: the PDF reader, step 5a`.
