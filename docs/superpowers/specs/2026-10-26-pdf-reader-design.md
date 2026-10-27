# The PDF reader: decomposing PDFs

**Status:** design, for review · 2026-10-26 · agreed with the owner in conversation. **5a
implemented (2026-10-27)**; results in §13.

- Start the layout service: `docker compose -f deploy/docker-compose.yml --profile pdf up -d --build layout`
  (opt-in; see `deploy/layout/README.md`).
- Decompose one PDF: `uv run --directory worker python scripts/decompose.py <file.pdf> <out-dir> --layout-url URL`
- Score Word/PDF twins: `uv run --directory worker python scripts/pdf_twins.py <docx-folder> <out-dir> --converter-url URL --layout-url URL [--pdfs <pdf-folder>]`

This is phase 5 of document decomposition
([2026-10-23-document-decomposition-design.md](2026-10-23-document-decomposition-design.md), "the
decomposition spec"). It says how a PDF becomes the same decomposed document (§5 there) that a
Word file does. Everything after the reader is unchanged: the fidelity checks' place in the flow,
the register, the bridge, the contract and the sink.

**[owner]** marks what the owner decided, **[call]** a call made in the design conversation that
the owner can still overturn, as in the decomposition spec.

## 1. Why this is different from Word

A Word file states its structure: headings have outline levels, tables have a grid and merges.
A PDF mostly doesn't. It holds positioned glyphs, lines and images, and the structure has to be
inferred from layout. So the PDF route is **less deterministic** than Word's, and the owner wants
to try it anyway. **[owner]**

The anti-goal stays: **content is never silently changed, lost or moved** (decomposition spec §2).
What changes is what can be proven:

- **Text can still be proven** on pages with a text layer: every word on the page is accounted
  for exactly once (§6).
- **Structure can't be proven** (heading levels, table grids, merges), so it is flagged as
  inferred wherever it was inferred, and its quality is measured instead (§7).

## 2. What the spike found

A spike on 2026-10-26 scored the candidate readings of PDFs against the Word decomposition of the
same documents. Three of the owner's Word samples were converted to PDF through CT Studio's own
converter (Gotenberg/LibreOffice, as production does), both plain and tagged. Two real PDFs, with
no Word source, were read by eye. The samples:

- doc1: a 13-page validation report, numbered headings, 7 tables;
- doc2: a 102-page stability report, 31 headings (many unnumbered), 72 tables;
- doc3: a 16-page stability report, 15 tables with heavy vertical merges;
- two real validation reports printed with a "Print to PDF" driver: no tags and no bookmarks.

| | doc1 | doc2 | doc3 |
|---|---|---|---|
| **Bookmarks:** headings and levels right | 32/32 | 31/31 | 13/13 |
| **Tag tree:** headings | 32/32 | reader crashed | 12/13 |
| **Tag tree:** table cells right | 94% | – | 36% |
| **Docling:** headings found | 30/32 | 9/31 | 13/13 |
| **Docling:** levels right, from the typed numbering | 27/30 | – | 13/13 |
| **Docling:** table cells right, before any clean-up | 56% | 73% | 65% |
| **Docling:** words found | 99.8% | 98.3% | 88.1% |

What it showed:

- **Bookmarks give the heading tree exactly**, when the PDF has them. The real PDFs had none.
- **The tag tree isn't reliable for tables.** LibreOffice's tags carry no row spans, so cells after
  a vertical merge shift left, and a common parser crashed on the large document. For headings it
  adds nothing that bookmarks don't.
- **Docling's text is trustworthy.** It added no words on doc1 or on either real PDF. What it
  left out was what the decomposed document drops anyway: typed heading numbers, bullet glyphs,
  page numbers. doc3's shortfall is symbol-font characters and footnote markers (below).
- **Docling's heading levels are flat**, but the typed numbers give the levels (10/30 right
  becomes 27/30). It misses unnumbered subheadings in doc2, and takes the table of contents for
  headings.
- **Docling's table content is mostly right but its shape rarely matches**, for systematic
  reasons:
  - note rows that Word keeps as a table's last row and the PDF reading puts after the table (35
    of 71 tables in doc2);
  - tables split at page breaks, with their header rows repeated on each page;
  - merges guessed visually in borderless blocks ("5 °C" merged down over cells that Word holds as
    separate, empty cells);
  - a column lost in some 11-column tables;
  - symbol-font characters (° as U+F0B0) and superscript note markers read as separate text
    ("3 b").
- **Speed:** about 2.4 s a page on CPU (16 threads); about 1.1 s a page on the simpler real PDFs.
  Scanned pages were not tried; the OCR benchmark ([ocr-engines.md](../../design/ocr-engines.md))
  covers them.

## 3. The reader, page by page

A PDF is a mixture of born-digital and scanned pages, so each page is classified first.
**[owner]** (a mixture, decided per page)

- **Born-digital:** the page has a visible text layer. Read from the text layer and its layout
  (§4).
- **Scanned:** the page has no text layer, or only an invisible one over a page-sized image (an
  earlier OCR's). It goes to the vision model CT Studio already uses for OCR (§5), and is flagged
  `page_recognised`. An invisible text layer is not trusted, because nothing shows it was right.
  **[call]**

A page that is mostly a large image with a little visible text (a figure page with a caption) is
born-digital: the image is a figure.

A PDF that needs a password is rejected, as is one that can't be parsed. One that opens with an
empty password (permissions only) is read. A rotated page (`/Rotate`) is read upright. **[call]**

## 4. Born-digital pages

### 4.1 Layout analysis: Docling

Layout analysis is done by **Docling** (MIT), with its layout model and its table-structure model
(TableFormer, accurate mode). **[call]** It was the best local option in the OCR benchmark and the
spike, and it gives reading order, headings, paragraphs, lists, tables with spans, captions,
footnotes, pictures and page furniture. Writing our own layout heuristics would take far longer
and do worse.

Docling's OCR is off: born-digital pages don't need it, and scanned pages use the vision model.

CT Studio does its own work on top of Docling's output (§4.2 to §4.8). That is where most of the
accuracy comes from, and it is plain code that can be tested without Docling, from saved Docling
output.

### 4.2 The text layer

The text layer is read independently of Docling, with each character's font name, size, position
and baseline. It is used for:

- **text accounting** (§6);
- **character formatting:** bold and italic from the font (its name or weight), superscript and
  subscript from a raised or lowered baseline and a smaller size. Underline is not in the text
  layer (it is a drawn line) and is dropped for PDFs. **[call]**
- **symbols:** characters in a symbol font's private-use range are mapped to Unicode with the Word
  reader's symbol table (°, ±, µ, ≤, ≥), and flagged `symbol_unmapped` when they can't be;
- **superscript note markers**, so "3 b" is read as "3" with a superscript "b" note reference.

Docling's items are matched to the text layer by page and position, and Docling's own text for an
item is replaced by the text layer's characters inside it, in Docling's reading order. So the text
comes from the PDF, and the structure from Docling.

**Text Docling missed.** Text-layer lines inside no Docling item (and not furniture, §4.3) are
not lost. They become paragraphs at their place: after the last item above them in the same
column on that page. Each is flagged `structure_inferred` ("text the layout analysis missed").
**[call]** Text accounting (§6) can't see such a gap, because it compares the text layer with
itself. It checks what CT Studio's own mapping does: dropping, joining, moving into tables and
notes. So this rule is what keeps missed text from going quietly.

### 4.3 Page furniture, contents and lists

Dropped, as for Word:

- running headers and footers, and page numbers: Docling's page furniture, plus any line repeated
  at the same place on most pages;
- tables of contents and lists of tables and figures: Docling's document index, plus headings such
  as "Table of contents" with the dot-leader lines under them.

Each counts as dropped text in text accounting (§6). Header and footer fields still become
`header-field` properties where they are name and value pairs, as for Word. **[call]**

Dropping is where body text could go silently, so it is guarded: **[call]**

- A line is furniture only when it is in the page's top or bottom margin band, and either Docling
  labels it furniture or it repeats (digits aside) at the same place on at least half the pages.
  A furniture label outside the margin bands is ignored.
- A contents list is dropped only as a block: lines ending in a page number, most with dot leaders,
  under a contents heading or forming a run of them. A single such line in the body is kept.
  A run without a contents heading starts on a line with a dot leader, and a run's page numbers
  never go back nor past the document's last page, so body lines ending in numbers and a "Max
  load ........ 250" line are kept. (2026-10-27)
- What was dropped is listed in one `info` flag, by page: how many furniture lines, and which pages
  held contents or lists. A reviewer can see that nothing else was dropped.

### 4.4 Headings and their levels

The heading tree comes from the best source the PDF has, in this order: **[call]**

1. **Bookmarks.** When the PDF has an outline, its entries are the headings and their levels.
   - Each entry is matched to a line of its title's text on its target page, nearest the
     destination's position when it gives one (`/XYZ` top). The match ignores case, spaces and
     the typed number.
   - The line becomes the heading, whatever Docling labelled it. A Docling heading with no
     bookmark becomes a paragraph.
   - An entry whose text isn't found on its page is left out and flagged. So is one that names a
     table or figure caption, or a cover, and isn't a heading.
   - When fewer than half the entries match, the outline is not trusted, and typed numbering is
     used instead.
2. **Typed numbering.** Without bookmarks, a heading that starts with a number ("2.1 Scope", "2.1.
   Scope", "2.1.Scope") takes its level from the number's parts.
3. **Inference.** An unnumbered heading without bookmarks sits one level below the numbered
   heading before it (or at level 1 when there is none), and is flagged `structure_inferred`.

Heading text follows the decomposition spec's rules: typed numbers left out, only superscript and
subscript kept, section ids from the whole heading text.

The tag tree is not read in this version: where it was right, bookmarks were too, and its tables
were wrong. **[call]**

### 4.5 Paragraphs and lists

- A paragraph that Docling split at a line or page break is joined again when the first part
  doesn't end a sentence and the next part continues it (no heading, list, table or figure between,
  and the same column).
- List items keep their nesting from their indentation. Bullets are dropped, as for Word, and so
  are numbers when a list's markers count from the start (1, 2, 3; a, b, c; i, ii, iii). A list
  whose numbers don't (one continued from the page before, "4." "5.") keeps each number as text
  in its item. **[call]** (2026-10-27)

### 4.6 Tables

Docling's table grid and spans are the starting point, then:

- **Tables split across pages are joined.** A table that ends a page and one that starts the next
  page, with the same columns and nothing between them but furniture, are one table. Header rows
  repeated at the top of the continuation are removed.
- **Captions** above or below a table are recognised as for Word ("Table 13:" removed, the target
  numbers it), including a caption read as a spanning first row.
- **Notes** after a table, starting with a marker (a, b, 1, *), become its notes, matched by
  their markers, as for Word. A note row read inside the grid is moved to the notes in the same
  way.
- **Header rows** are Docling's column headers.
- **Merges** are Docling's. They can't be proven from the PDF.

Every PDF table is flagged `structure_inferred`, with what was inferred: its grid, a join across
pages, notes. **[call]**

### 4.7 Images, figures and equations

- **Pictures** are cropped from the page, rendered at print resolution, with their captions.
  Vector drawings are rendered the same way and flagged `drawing_rendered`.
- **Text inside a picture's region** (a chart's axis labels, say) becomes the image's alt text, in
  reading order, as a Word drawing's text does. It is counted there in text accounting. **[call]**
- **Equations** are kept as images and flagged `equation_image_only` in this version. **[call]**
  Docling can recognise formulas as LaTeX, but that was not tried.

### 4.8 Footnotes, links and properties

- **Footnotes** at a page's foot are matched to their superscript markers in that page's body and
  become notes. A footnote with no marker found stays a paragraph where it was, flagged. A
  superscript right after a digit, a closing bracket, a lone letter or a unit ("10²", "(a+b)²",
  "R²", "kg/m²") is a power, never a marker. When more than one superscript could be a
  footnote's marker, none is taken: the footnote stays a paragraph, flagged "Footnote marker
  ambiguous". **[call]** (2026-10-27)
- **Links** come from the PDF's link annotations over the text.
- **Properties** come from the information dictionary and XMP metadata (`pdf-info`).
- **Cross-references** stay plain text: a PDF has no reference fields. **[call]**

### 4.9 Flags

The flag codes stay those of contract version 2, so the contract and the sink don't change.
**[call]** Every inference is a `structure_inferred` flag at the element, and its message says
which: an inferred heading level, a table's grid, a join across pages, notes moved out of a grid,
text the layout analysis missed, a footnote with no marker or an ambiguous one, a bookmark left
out. The dropped-text summary (§4.3) is a `structure_inferred` flag too, at no element, with
severity `info`, and so is a count of the visible glyphs on a page that the text layer gives no
text (or no box) and that are therefore left out. (2026-10-27)

A PDF's structure flags are many by nature. The batch row and the report show their count, so a
reviewer sees at a glance which documents have the most.

## 5. Scanned pages

A scanned page is rendered and sent to the OCR vision model, as the extraction pipeline does
(olmOCR 2 by default; [ocr-engines.md](../../design/ocr-engines.md)). It returns the page's text,
with headings and HTML tables, merged cells kept. CT Studio maps that onto the decomposed document:
headings by the same rules as §4.4, tables from the HTML grid, figures cropped from the page image
using the layout model's picture regions.

Every scanned page is flagged `page_recognised`. Its tables are flagged `structure_inferred`, too.
The layout model runs on the scanned page's image (Docling's layout works from the rendered page,
with its OCR still off), only for the picture regions.

Paragraphs and tables are not joined across a boundary between a born-digital and a scanned page.
**[call]**

## 6. Fidelity checks for PDFs

The decomposition spec's §7 checks apply, adapted to what a PDF can prove. **[call]**

- **Text accounting, per page.** The words of each born-digital page's text layer, minus what is
  dropped on purpose (furniture, contents and lists, typed heading numbers, list bullets and
  numbers, caption numbers, and header rows repeated on a table's continuation pages), must equal the words of the decomposed document's blocks from that
  page. They are compared as **counts, not in order**: the text layer's order is the order the
  content was drawn in, not reading order. (The spike found a heading whose words were drawn out
  of order.) A missing, extra or duplicated word fails the document, naming the page and the word.
  The normalisation is the Word check's, plus ligatures split (ﬁ to fi) and the non-breaking
  hyphen read as a hyphen.
- **Tables, per table.** The words inside each table's region of the page must be exactly the
  words in its cells, so a cell's text can't move out of its table, or into another. The grid's
  shape and merges can't be checked against the PDF; they are flagged instead (§4.6).
- **Dropped on purpose, as well** (added in 5a): note separators after a table note's marker, and
  footnote markers, which become note references. **[call]** (2026-10-27)
- **An image-only equation's text** is accounted to its image, as for Word. **[call]**
  (2026-10-27)
- **Ownership is checked per top-level block.** A word moved within one list or table isn't
  caught. **[call]** (2026-10-27)
- **References** must resolve, as for Word.
- **Scanned pages** have no independent text to compare with, so they are flagged, not checked.

The PDF checks are their own module beside the Word one. They share its normalisation and the
contract's text and grid forms (decomposition spec §9). **[call]**

Read-back in the sink is unchanged: it compares with what it was sent.

## 7. Measuring quality: Word/PDF twins

Because structure can't be proven, it is **measured**. A **twin** is a Word document and its PDF
made by CT Studio's own converter. The Word decomposition is the right answer for its twin, so the
PDF reader can be scored against it:

- headings found, and with the right level;
- tables found, with the right shape, and cells right;
- words found, and extra words;
- for real PDFs with no Word source: text accounting only.

A dev tool scores a folder of Word documents this way, and prints one row per document and a
total. The owner runs it over the private corpus (decomposition spec §7). It is also how a change
to Docling, its models or the mapping is judged before release: the scores mustn't fall.

Twins made by LibreOffice are not the only PDFs there are. Word's own "Save as PDF" and "Print to
PDF" make different files, so the corpus should have some of each. The two real PDFs in the spike
were "Print to PDF".

## 8. Whether PDFs need review in CT Studio

The decomposition spec runs every document straight through, with review in the target. **[owner]**
Whether inferred PDF structure should instead stop for a person to check the heading outline
against the page images, before delivery, is **left open until the owner has seen the twin scores
after the clean-up of §4**. **[owner]** (2026-10-26)

So PDFs don't reach CT Studio's Conversion tab until then. Step 5a builds the reader and the twin
scores, and its dev tool decomposes PDFs outside CT Studio. Step 5b, which lets the tab take PDFs,
follows the owner's decision, with or without a review step. **[call]** No score threshold is set
in advance: the owner judges the scores.

## 9. Repeatable runs

The same PDF must give the same decomposed document, so that re-runs update in place (decomposition
spec §8):

- Docling, its model weights and the OCR model are pinned to exact versions, and the weights are
  baked into the image: nothing is downloaded at run time;
- the OCR model runs at temperature 0, as it does for extraction;
- the reader's version is part of the decomposer version, and so of the idempotency key.

A new reader version can infer headings differently, and so change section ids, which come from
heading paths. A re-run is then an ordinary update behind the version check (decomposition spec
§8). The twin scores, and the reader's tests on saved Docling output, are what catch such a change
before release.

## 10. Where it lives

- **A new `layout` service**, beside the converter: an image with Docling and its pinned weights,
  taking a PDF and returning Docling's document. **[call]** It keeps Docling's heavy dependencies
  (PyTorch, about 1 GB) out of the worker image. And it parses untrusted PDFs, so, like the
  converter, it sits on an internal network with no route out and publishes no ports.
  - The worker sends the whole PDF with a page range, in chunks of pages, so a long report never
    meets one long timeout. The joins of §4 happen in the worker, across chunks.
  - Above a page limit (500 pages to start), the document fails with a clear reason. **[call]**
- **The worker:** page classification, the text layer, the mapping of §4 and §5, the fidelity
  checks of §6, and the scanned-page route through the existing OCR client. A decomposition job
  takes a `.docx` or a `.pdf`, by its bytes.
- **The API and the Conversion tab** accept PDFs beside Word files.
- **The contract** doesn't change: the decomposed document, the flag codes (`structure_inferred`,
  `page_recognised`) and the `pdf-info` origin are already in version 2.

## 11. Phasing

| # | Work | Done when |
|---|---|---|
| 5a | **Born-digital PDFs:** the layout service, the text layer, the mapping, the fidelity checks, a dev tool, the twin scorer | Twins and the owner's real PDFs decompose with no text-accounting failure, and the twin scores are reported to the owner |
| — | **The owner's decision** on review (§8) | — |
| 5b | **PDFs in CT Studio:** the job, the API and the Conversion tab, with a review step if decided | A PDF goes through to the fake sink, and to the real sink in the owner's run |
| 5c | **Scanned pages** through the OCR model | A scanned sample decomposes with every scanned page flagged |

## 12. Left to the builder

- The text-layer library (pypdfium2 is already in the worker; pdfplumber worked in the spike), and
  how characters are matched to Docling's items.
- The layout service's request and response shape, chunk size and timeouts, within §10.
- Thresholds for the paragraph joins, baseline shifts and repeated-line detection, as long as the
  twin scores show them.
- **Licences.** Docling and its packages are MIT. The layout weights are Apache-2.0, and the
  table-structure weights are CDLA-Permissive-2.0. The builder confirms these at the pinned
  revisions before the image ships, since CT Studio must be able to redistribute them.

## 13. Results of step 5a (2026-10-27)

The twins are scored against the Word decomposition, using a CT Studio converter's PDF. The
documents are described generically: doc1 is a 13-page validation report; doc2 a 102-page
stability report, with doc4 a near-duplicate; doc3 a 16-page stability report with heavy vertical
merges. The scores are after the step's fixes.

| | doc1 | doc2 (and doc4) | doc3 | total (4 twins) |
|---|---|---|---|---|
| Headings found, level right | 32/32, 32 | 31/31, 31 | 13/13, 13 | 107/107, 107 |
| Tables found | 7/7 | 68/72 | 12/15 | 155/166 |
| Table shape right | 4/7 | 50/68 | 8/12 | 112/155 |
| Extra PDF tables | 4 | 4 | 3 | 15 |
| Cells right | 86/144 | 6727/7779 | 1222/1550 | 14762/17252 (86%) |
| Words recall / precision | 0.993 / 0.991 | 0.999 / 0.994 | 0.897 / 0.995 | 0.991 / 0.994 |

- Both real "Print to PDF" validation reports (no bookmarks) decompose and pass the text check.
- Every document passes the fidelity check.
- The fidelity check caught, and drove the fix of, three real reader defects during the step: a
  header word split across overlapping cell boxes, a space given to the cell below so two words
  merged, and typed heading numbers kept in titles when numbered chapters sat below unnumbered top
  entries.

**What is weakest.** Table shape and cells on small, borderless or heavily merged tables (doc1,
doc3); and extra tables.

**doc3's word recall (0.897) is the PDF lacking what Word has, not the reader losing text.**
Of its 676 missing words (of 6535), 640 are the cells of the last two columns of its three widest
tables: Word sets them 9 inches wide on a page 8.5 inches wide, the converter's PDF draws them
past the page's right edge and stops, and the PDF's text layer never holds those cells (the few
characters it does hold past the edge are read). 30 are three level-1 headings whose Word style
is all capitals: the PDF draws capitals, Word stores mixed case, and the word comparison is
case-sensitive. The other 6 are "Table" and ":" of three captions whose Word paragraph starts
with the heading's text, so the Word reading keeps "Table N:" in the caption, where the PDF
reading drops it as the caption's number. (2026-10-27)

The owner's decision on review (§8) waits on these scores.
