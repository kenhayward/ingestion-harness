# The PDF reader: decomposing PDFs

**Status:** design, for review · 2026-10-26 · agreed with the owner in conversation. **5a
implemented (2026-10-27)**; results in §13. **5b implemented (2026-10-27)**: PDFs in CT Studio,
with review, in §14; the owner's run against the real sink is pending. **5c implemented
(2026-10-27)**: scanned pages, in §15, the rasterised twins' scores in §15.8; the owner's run
is pending.

- The layout service starts with the stack (§14.7; see `deploy/layout/README.md`). On its own:
  `docker compose -f deploy/docker-compose.yml up -d --build layout`.
- Decompose one PDF: `uv run --directory worker python scripts/decompose.py <file.pdf> <out-dir> --layout-url URL [--ocr-url URL]` (scanned pages need the OCR model; its key from `OCR_API_KEY`)
- Score Word/PDF twins: `uv run --directory worker python scripts/pdf_twins.py <docx-folder> <out-dir> --converter-url URL --layout-url URL [--pdfs <pdf-folder>] [--rasterise] [--ocr-url URL]` (`--rasterise` scores the OCR route, §15.5)

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

**Glyphs with no text.** A glyph the text layer gives no text (code 0) or no box can't be
accounted for. It is left out, and each page's visible ones are counted in one `info` line (§4.9).
(2026-10-27) So is a glyph whose code XML 1.0 can't hold: a control other than tab, line feed or
carriage return, a lone surrogate, U+FFFE or U+FFFF. A font with no Unicode mapping can give its
raw code, U+0002 say, and a delivered document holding one is refused by the sink.

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
- A printed page number in a margin band is furniture on any page, whatever its form ("8",
  "- 8 -", "A3 8", "Page 8 of 120", "8/120", "iv"), even when it repeats on too few pages for the
  rule above: an annex's own page numbers ("A3 8") don't. A picture region in a margin band is
  dropped, not cropped, when no image object lies under it and every char it overlaps is its own
  page-number text or already dropped as furniture (Docling sometimes takes a footer's page
  number for a picture too). It counts in the flag as a picture. (2026-10-27)
- Printed line numbers are dropped from the start of the lines they number (`line-number` in the
  ledger): on a page, the lines' leading runs of up to five digits that stand in one column (left
  or right edges within 3 points), at least five of them on at least half the page's lines,
  increasing down the page, with every other char on the page at least half an em to their
  right. Once a page's column is found in the body, numbers in the margin bands that line up with
  it and carry on its count go too (the body can start in the top band). A numbered list fails
  the last test against the body text beside it; a table's cells are never looked at, so a first
  column of numbers stays. Only born-digital pages are looked at. (2026-10-27)
  (2026-10-28) Once at least three pages show a column that way, a page with too few numbered
  lines to show it alone (a table or a figure fills it) loses the leading numbers that line up
  with the column of the nearest such page before or after it, numbered above the last line
  number before it and below the first after it, increasing, with every other char on the page
  right of them. A picture on a page whose numbers were dropped is cropped without their column
  when its region reaches into it.
- (2026-10-28) **Line-numbered pages are sent to the layout service without their margin.**
  Docling reads a page of numbered lines as a table of contents (`document_index`) or a table, and
  takes the numbers into its figures: on the ICH Q1 draft it labelled 89 of 108 pages
  `document_index`, and three quarters of the text was dropped as contents. So the column is found
  from the text layer before layout (the rule above, by text-layer lines), and each upright page
  whose leading numbers line up with it, with no other char and no image object left of the text,
  is sent with its CropBox moved right to where the text starts. Docling's boxes on those pages are
  moved back by the same amount. The numbers, in no Docling item, become orphan lines and are
  dropped by the rule above. A PDF pypdf can't rewrite is sent whole.
- (2026-10-28) Cropping is not enough on its own: on that draft Docling still labelled 26 cropped
  body pages `document_index`. **A `document_index` item is contents only if it reads as
  contents:** at least three rows (or lines), and at least half of them a title followed by a page
  number no higher than the document's last page. A table that doesn't is kept as paragraphs:
  its chars in lines, and lines less than 1.5 line heights apart in one paragraph (as orphan lines
  are). Those pages are listed in the dropped-text `info` line ("Kept as paragraphs: text the
  layout analysis took for contents on pages …"); a text item that doesn't stays as it is. Its
  headings come out as paragraphs, since the PDF has no bookmarks to find them by.
- (2026-10-28) The text layer can run a line number into the word after it ("2734indicating"),
  and a word goes whole to the item most of its chars are in, so the number can land in a table's
  cell. In a table's cells, a leading number that lies wholly left of the table's box is looked
  at as a line number too; any other number in a cell never is.
- A contents list is dropped only as a block: lines ending in a page number, most with dot leaders,
  under a contents heading or forming a run of them. A single such line in the body is kept.
  A run without a contents heading starts on a line with a dot leader, and a run's page numbers
  never go back nor past the document's last page, so body lines ending in numbers and a "Max
  load ........ 250" line are kept. (2026-10-27)
- What was dropped is listed in one `info` flag, by page: how many furniture lines and pictures,
  how many line numbers, and which pages held contents or lists. A reviewer can see that nothing
  else was dropped.

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
   heading before it (or at level 1 when there is none). The headings inferred are counted in one
   `structure_inferred` flag at no element, with severity `info` ("Heading levels inferred for 34
   headings"), not flagged one by one: on a real document nearly every heading is inferred, and a
   warning each buried the flags that matter. (2026-10-27)

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

- (2026-10-28) **A ruled table Docling took for a picture is read from its ruling lines.** The
  text layer keeps each path object at most 2 points thick and at least 4 long as a ruling line
  (a stroked line, or a thin filled rectangle as Word draws a border). A picture on a born-digital
  page with no image object under it has its ruling lines put in groups that touch, and each group
  read as a grid: rows and columns where its horizontal and vertical rules are (rules within 2
  points one line), two neighbouring cells one where no rule parts them, the first row a header.
  A group with fewer than two rows or columns, without a border all round (boxes joined by a
  line, as in a flow chart), or with a merged cell that isn't a rectangle, is no
  grid, and then the picture stays as it is. Otherwise each grid where Docling has a table already
  (sharing 80% of the smaller box) is that table, and any other is a table of its own, flagged
  "Table grid read from its ruling lines; the layout analysis took it for a picture"; the text
  items Docling gave inside it are dropped so its chars go to its cells, and the picture is
  dropped. On the ICH Q1 draft, Docling gave table A1-4 both as a table and as a picture of it,
  and one picture over table A1-5, a line of text and the key table under it.
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
which: a table's grid, a join across pages, notes moved out of a grid,
text the layout analysis missed, a footnote with no marker or an ambiguous one, a bookmark left
out. The dropped-text summary (§4.3) is a `structure_inferred` flag too, at no element, with
severity `info`, and so is the count of headings whose level was inferred (§4.4, 2026-10-27), and a
count of the visible glyphs on a page that the text layer gives no
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

**Decided (2026-10-27): PDF decompositions are reviewed in CT Studio before delivery.** **[owner]**
The owner saw the scores of §13, where headings and text are reliable but about 3 tables in 10
have the wrong shape. Word documents still go straight through. How the review works is §14.

## 9. Repeatable runs

The same PDF must give the same decomposed document, so that re-runs update in place (decomposition
spec §8):

- Docling, its model weights and the OCR model are pinned to exact versions, and the weights are
  baked into the image: nothing is downloaded at run time;
- scanned pages' transcriptions are kept in the shared OCR cache, so a re-run reads the same text
  (§15.1; this replaced "the OCR model runs at temperature 0");
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
| 5b | **PDFs in CT Studio:** the job, the API and the Conversion tab, with the review step (§14). **Implemented (2026-10-27)**; the owner's run is pending | A PDF goes through to the fake sink, and to the real sink in the owner's run |
| 5c | **Scanned pages** through the OCR model (§15). **Implemented (2026-10-27)**; scores in §15.8; the owner's run is pending | A scanned sample decomposes with every scanned page flagged |

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

## 14. Step 5b: PDFs in CT Studio, with review

The Conversion tab takes PDFs beside Word files. A PDF is decomposed and checked as in 5a, then
**held for review**: nothing is delivered until a person approves it. A Word file goes straight
through as before. (2026-10-27)

### 14.1 What the reviewer decides

The reviewer **approves or rejects the whole document**. Nothing is edited in CT Studio. **[call]**
Correcting inferred structure (a table's grid, a heading's level) would be an editor of its own,
and the reviewer's job is to keep a wrong reading out of the target. A rejected PDF can be
re-delivered with a replacement file, the Word original when there is one, or decomposed again
after a newer reader.

Rejecting needs a note, so the row says why. **[call]** Approving takes an optional note.

### 14.2 When a PDF is held

- After the PDF is decomposed and passes its fidelity checks (§6). A PDF that fails them fails, as
  before; there is nothing to review.
- Only when the delivery would send something. The worker first asks the register what it would
  decide, without recording anything. If the answer is `already_loaded`, `duplicate`, `in_flight`,
  `changed_in_target` or `unresolved`, that outcome is recorded at once, as for Word, and nothing
  is held. **[call]** The register decides again, for real, when the approved document is
  delivered, so a change in between (another delivery landing first) is still caught.
- Every run that would deliver is held, forced runs and re-deliveries included. **[call]** A
  forced run exists to send the document again, and what is sent should have been looked at.

### 14.3 What is kept while it waits

The worker stores, beside the item's source in the runs bucket:

- the **held decomposition**: the decomposed document and its image bytes, exactly as they would
  be delivered;
- the **page images**, one JPEG per page, rendered by pdfium, the same size as the extraction
  review's page previews;
- the **page map**: for each section and block, the pages it came from (the reader's provenance).

The item's outcome is `awaiting_review`, and it records the held decomposition's sha256. The job
**succeeds** with the note "held for review". It doesn't wait: a held item can sit for days.

The held files are deleted when the item is approved and delivered, or rejected.

### 14.4 Approve and reject

- **Approve** (`POST /conversions/items/:id/approve`, optional note) records who and when on the
  item and queues a `decompose` job marked `approved`. The worker reads the held decomposition,
  checks its sha256 against the item's, and delivers it through the register as any other
  delivery. It does **not** read the PDF again, so what is delivered is what was reviewed, even if
  the reader has changed since. The delivery acts as the user who started the batch, as for Word;
  the reviewer is recorded on the item. **[call]**
- **Reject** (`POST /conversions/items/:id/reject`, note required) records who, when and the note,
  sets the outcome `rejected` and deletes the held files. `rejected` is final. The row's usual
  actions then apply: a forced run decomposes again (and holds again), and re-delivering with a
  replacement file takes either a Word file or a PDF. **[call]**
- Whether a run is held depends on **the file being delivered**, not on the item: a PDF item
  re-delivered with its Word original goes straight through, and a Word item re-delivered with a
  PDF is held. **[call]**
- The bulk "retry failed" action leaves `rejected` items out: running the same reader again would
  give the same reading. A forced run of one row still works. **[call]**
- Both are refused (409) unless the item is `awaiting_review`, so two reviewers can't both decide.
- **Who reviews:** anyone who may use the Conversion tab (operators, designers, admins), including
  the person who started the batch. **[call]** A separate reviewer permission can come later.
- **An approved run ends like any delivery.** **[call]** Whatever the register and the bridge
  answer (`created`, `updated`, `changed_in_target`, a refusal, the bridge unreachable) is the
  item's outcome, as for Word, and the held files are deleted once the approved run has recorded
  any outcome. It never goes back to `awaiting_review`; trying again is a forced run, held and
  reviewed again. Held files whose sha256 doesn't match fail the item.

### 14.4a A held item and other runs of its source

- `awaiting_review` counts as **running**: like `delivering`, it blocks a forced run, a re-delivery
  or a detach of the same item until it is approved or rejected. **[call]**
- A hold also records the register entry it was decided against (its id and content sha256, or
  none). At approval the worker compares: if the entry has changed since (another run of the same
  source delivered in between), the item fails with "the target's document changed after this was
  reviewed; run it again", and nothing is sent. **[call]** So an older reading never overwrites a
  newer one.

### 14.5 The review page

A page of its own, opened from the row's **Review** button. **[call]**

- **Left:** the page image, with the thumbnail strip and dots on pages that have flags (the
  extraction review's page viewer, reused).
- **Right:** the decomposed document as it would be delivered: the heading outline as a tree,
  each section's blocks beneath its heading, tables drawn as their grid with merges, figures as
  their crops, and each flag beside the element it is on.
- Choosing a heading, block or flag shows its first page on the left.
- **A decision bar:** Approve, and Reject with its note.

The page is read-only. It shows the item's file name, its target, and the count of flags by kind.

### 14.6 On the Conversion tab

- The file picker and drop zone take `.docx` and `.pdf`; the copy says "Word or PDF".
- Two new outcomes: **Awaiting review** (it needs attention, so the "Needs attention" filter shows
  it) and **Rejected** (final; it counts with the failed ones).
- A batch with items awaiting review isn't finished.
- Each row shows its flag count (§4.9), for Word files too.

### 14.7 The layout service

- The `layout` service leaves the `pdf` compose profile and starts with the stack, since the tab
  now takes PDFs. **[call]**
- The worker builds its layout client from `LAYOUT_URL`. Without one, a PDF item fails at once:
  "this CT Studio has no layout service (LAYOUT_URL)".
- An unreachable layout service is retried as the converter is. On the job's last attempt the
  item fails, saying the layout service couldn't be reached.

### 14.8 The decomposer version of a PDF

The contract's `decomposerVersion` is an integer and stays one. For a PDF it is
`DECOMPOSER_VERSION × 1000 + PDF_READER_VERSION`; a Word file's stays `DECOMPOSER_VERSION`.
**[call]** So a new reader version changes the idempotency key and the provenance of a PDF, and
not of Word files. The reader's version stays below 1000. Printed line and page numbers dropped as furniture
(§4.3) and the one count of inferred heading levels (§4.4) change what the reader produces, so
`PDF_READER_VERSION` goes to 3 and a PDF's decomposer version to 1003. (2026-10-27)

### 14.9 Done when

- The API integration test with Postgres takes a PDF through the API, the worker (with a fake
  layout analyser), a review approval and the bridge to the fake sink. It also takes a rejected
  PDF through, and a Word file in the same batch straight through.
- In the owner's run, a real PDF is reviewed and delivered to the real sink.

## 15. Step 5c: scanned pages

Agreed with the owner on 2026-10-27. The owner has scanned PDFs to test with. The OCR model is
the one CT Studio is already configured to use. §3, §5 and §6 still hold, and this section
fills in the rest.

### 15.1 The OCR model

- Scanned pages use **CT Studio's own OCR setting**: the model chosen under Administration >
  Models (or `ocr.model` in `config/llm-providers.yaml`), its own endpoint and key
  (`OCR_BASE_URL`, `OCR_API_KEY`) when set, and its output budget, temperature, concurrency and
  parallel-call limit. Decomposition adds no OCR setting of its own. An extraction spec's
  `document.ocr` mode doesn't apply. **[owner]**
- This replaces §9's "temperature 0". What makes a re-run repeatable is the **shared OCR cache**,
  as for extraction. A page's transcription is kept under the PDF's SHA-256, the model and the
  settings, so a re-run reads the same text as the first run and updates in place. An extraction
  and a decomposition of the same PDF bytes share transcriptions. **[call]**
- If the cache is cleared or the OCR settings change, a re-run may read a page differently. That
  shows up as an ordinary update behind the version check, and is accepted. **[call]**
- Each job also keeps its own copy of every page it transcribes, under its run key, as
  extraction does. A retried job doesn't transcribe a page twice.
- Errors are handled as for extraction. A transient model error is retried. A refusal, an
  unavailable model or an exceeded context fails the document, naming the page and the model. A
  cancelled batch stops at the next page.
- **No OCR configured.** A PDF with a page that has no visible text over its scan fails before
  any layout or OCR work, saying "page N is scanned and this CT Studio has no OCR model". A page
  that is scanned only by §15.2's second rule (a little visible text over a full-page image) is
  then read from its visible text, as before 5c, since that rule exists only to send it to the
  model. A born-digital PDF is unaffected. **[call]** (2026-10-27, after the final review: a
  born-digital cover page must not fail the PDF)
- **The seam.** The reader is given a page transcriber, which takes a page index and returns
  the model's raw markdown and the rotation it applied. In the worker, this is extraction's OCR
  loop, with its caches, gates and cancellation, refactored to hand back raw markdown. The dev
  tools use a plain client with a cache folder on disk. **[call]**

### 15.2 Classification

A page is **scanned** when either of these holds: **[owner]**

- it has no visible text and images cover at least half of it (§3's rule, as the reader has
  it);
- one image covers at least 80% of it and its visible text is at most 20 words. This catches the
  stamps, page-number overlays and "scanned by" lines that real scans carry. The visible words
  are then left out, and they are counted in the page's `page_recognised` flag: "N words of
  visible text over the scan were left out". The OCR reads them from the image anyway.

A page with no visible text and no images (a blank page) is born-digital, with nothing on it. A
full-page figure with a short caption meets the second rule, so it is read as a scanned page
and flagged. The reviewer sees that on the review page. **[owner]** (2026-10-27: the trade is
acceptable)

### 15.3 From transcription to document

The model returns markdown: headings, paragraphs, lists, HTML tables with their spans, LaTeX
equations, and a placeholder for each figure with its box. Its text comes without positions, so
it is taken in the model's own order, and the page comes **whole, between its neighbours** in
page order. Its blocks map to their page in the provenance and the page map, and the text check
leaves them out (§15.4). **[call]**

- **Headings**, decided per heading, by §4.4's sources in their order: **[call]**
  - a bookmark targeting the page, matched against that page's headings and lines, ignoring
    case, spaces and the typed number;
  - then a typed number;
  - then, in a document whose other headings are numbered, one below the previous numbered
    heading (§4.4);
  - otherwise the markdown's `#` level. The levels are normalised, so the shallowest level used
    on the document's scanned pages is level 1.

  A heading whose level comes from the markdown alone is flagged `structure_inferred`.
- **Inline text.** Bold, italic, `<sup>` and `<sub>` become marks. Markdown links become links.
  Lists keep their nesting. Footnote markers stay as text. **[call]**
- **Tables** come from the HTML grid, parsed leniently, with their row and column spans:
  - `<br>` is a line break in the cell;
  - `<th>` rows are header rows, and a table with no `<th>` has none;
  - §4.6's caption, note and "Table N:" rules apply to the paragraphs next to it.

  Each scanned table is flagged `structure_inferred` (§5). A table that is the last block of one
  scanned page is joined to one that is the first block of the next scanned page by §4.6's
  rule. Nothing is joined across a scanned/born-digital boundary (§5). **[call]**
- **Equations.** A display equation is matched to the layout's formula regions on the page, in
  reading order. It becomes an equation block with its LaTeX text and the region's crop as its
  image. A display equation with no region, and every inline equation, stays as its LaTeX in the
  text, flagged `structure_inferred`. **[call]**
- **Figures.** The layout service reads every page, as now. On a scanned page, only its picture
  and formula regions are used (§5), and they are cropped from the rendered page. **[call]**
  - Each placeholder's box, converted from the rendered image's pixels to the page, is matched
    to the picture region it overlaps most. The placeholder's alt text becomes the figure's
    description, and the figure sits where the placeholder was.
  - A region left unmatched goes after the page's last block.
  - A placeholder left unmatched is dropped.
  - Either kind of mismatch is flagged on the page.
- **Rotation.** pdfium applies `/Rotate`, so the OCR and the layout see the page as displayed.
  When the OCR client corrects a page's rotation, the layout's regions are in the uncorrected
  frame. Figures are then matched in reading order only, and their crops are rotated by the
  same correction. **[call]**
- **Furniture.** The model is asked for the page "as if reading naturally", and usually leaves out
  running headers and page numbers. Where a PDF has at least three scanned pages, a first or last
  line of a scanned page that repeats, digits aside, on at least half of them is dropped as
  furniture. It is counted in §4.3's flag. **[call]**
- **A scanned page with no text** (the model returns nothing) adds nothing. It is still flagged
  `page_recognised`, with the message that no text was recognised on it. **[call]**

### 15.4 Checks

Scanned pages are flagged, not checked (§6). The born-digital pages of the same PDF are checked as
before. Scanned pages are left out of the text check, the text layer's left-out counts and the
born-digital furniture rule's page count. References must still resolve across the whole
document. The flag count on the batch row includes the scanned pages' flags, so a reviewer sees
them before opening the review page.

### 15.5 Measuring quality: rasterised twins

A scan has no Word original, so quality is measured as in §7, on **rasterised twins**: the twins'
PDFs rendered to image-only PDFs at 200 dpi (every page an image, no text layer). **[call]**

- They go through the scanned route and are scored against their Word files with §7's scorer.
  This gives §13's scores (headings, tables, cells, word recall and precision) for the OCR route,
  on documents whose answer is known.
- `pdf_twins.py` gains `--rasterise`, plus `--ocr-url`, `--ocr-model`, an API key from the
  `OCR_API_KEY` environment variable, and a cache folder. A second run is free and repeatable.
- The scores are reported to the owner, as in 5a.
- The owner's own scans are decomposed and reviewed by eye. They have no answer to score
  against.

### 15.6 Version

`PDF_READER_VERSION` goes to 2, so a PDF's decomposer version becomes 1002 (§14.8). Born-digital
PDFs get the new version too. A re-run of one is an ordinary update behind the version check.
**[call]**

### 15.7 Done when

- A mixed PDF (born-digital and scanned pages) decomposes in the worker's tests, with a fake OCR
  transcriber and a fake layout analyser, and every scanned page is flagged.
- The rasterised twins are scored, and the scores are reported to the owner.
- In the owner's run, their scanned PDFs decompose, are held for review, and one is approved
  through to the sink.

### 15.8 Results: rasterised twins (2026-10-27)

The four twins of §13, their PDFs rendered to image-only PDFs at 200 dpi, are scored through the
scanned route against their Word files. OCR is `allenai/olmocr-2-7b` on the owner's endpoint; the
layout service is the pinned CPU image. The first run is before the fixes below, the second
after; §13's born-digital scores are beside them.

| | OCR route, first run | OCR route, after the fixes | Born-digital (§13) |
|---|---|---|---|
| Headings found | 0/107 | 97/107 | 107/107 |
| Heading level right | — | 29/97 | 107/107 |
| Tables found | 164/166 | 164/166 | 155/166 |
| Table shape right | 58/164 | 52/164 | 112/155 |
| Extra tables | 8 | 7 | 15 |
| Cells right | 10523/17252 (61%) | 9998/17252 (58%) | 14762/17252 (86%) |
| Words recall / precision | 0.988 / 0.804 | 0.990 / 0.953 | 0.991 / 0.994 |

What the first run showed, and what was fixed (2026-10-27):

- **Headings.** olmOCR writes a heading as a plain line ("3.2. Pump performance"), never with
  `#`, and often with the body text on the next line. A short line that starts with a typed
  number and doesn't end like a sentence is now a heading; a single-number line inside an
  ordered list stays an item. **[call]**
- **Contents pages** were most of the extra words: each entry's dot leader was read into one
  long paragraph. A contents entry (a leader, then a page number) is now a line of its own, never
  wrapped and never a heading, so §4.3's contents rule drops the run as on a born-digital page.
  **[call]**
- **Inline math made only of symbols** (`\( \geq 98\% \)`, `\pm`, `^\circ`) is now plain text
  ("≥ 98%"); anything else stays LaTeX. **[call]**

What is left, and why:

- **Heading levels.** In three of the reports the numbered chapters sit under two unnumbered
  top-level entries, so in Word chapter 1 is level 2. A scan has no bookmarks to say so, and
  the typed number makes chapter 1 level 1: every level is one too shallow, though the tree below
  is right. The born-digital route gets these levels from the bookmarks.
- **Cells.** The model repeats a vertically merged cell's value in every row it spans (e.g.
  "<0.05" 1009 times where Word holds 796), and its HTML grids are less often the right shape than
  TableFormer's. The cells score is where the OCR route is weakest; every scanned table is flagged.
- The fixes moved the shape score slightly down (58 to 52): with the headings found, some tables
  now split into a different section and pair with a different Word table.

The owner's own scans are next (§15.7): they are decomposed, held for review and read by eye.

## 16. Layout analysis on a GPU (2026-10-28)

The layout service is most of a PDF's decomposition time: on the CPU, about 3 s a page on a
table-heavy report (§13's 102-page twin took 314 s). It can now run on the CT Studio host's NVIDIA
GPU, with the CPU service behind it.

### 16.1 What was measured

A spike timed the same four PDFs (two of the owner's, two twins) through a whole decompose, warm,
on the pinned CPU image (Docker given 8 CPUs) and on the same Docling and weights built with CUDA
torch:

| PDF | Pages | CPU | RTX 3090 (another host) | RTX 5090 (the CT Studio host) |
|---|---|---|---|---|
| real1 | 15 | 19 s | 5 s | 2.7 s |
| real2 | 8 | 11 s | 3 s | 1.4 s |
| doc1 | 13 | 17 s | 5 s | 2.1 s |
| doc4, 70 tables | 102 | 314 s | 107 s | 43 s |

- **TF32 changes the output.** With the GPU's default TF32 matrix maths, the layout model split one
  table on page 68 of doc4 in two, and §6's checks refused the document, which the CPU reads
  whole. In full precision the GPU's boxes are the CPU's to within 0.002 points on all four, at
  about the same speed. The service turns TF32 off whenever it runs on CUDA.
- **Memory:** about 1.7 GB of GPU memory, up to 2.5 GB while warming up.
- **Two documents at once** on the 5090 gained about 20% throughput (on the 3090, nearly double):
  not worth a second instance on this host. The service still reads one request at a time.

### 16.2 How it is set up

- **One Dockerfile, two images.** `deploy/layout/Dockerfile` takes `TORCH_INDEX` (`cpu` by default;
  `cu130` for the GPU image): the same torch version from PyTorch's index, the same locked
  Docling, the same weights. `layout_service.device.prepare` turns TF32 off on CUDA before the
  models load, and the fingerprint ends `; cuda` or `; cpu`. The GPU image without a GPU runs on
  the CPU.
- **`layout-gpu`** (`deploy/docker-compose.yml`) extends `layout` (internal network, no ports,
  read-only root, nothing fetched) with `gpus: all`, only in the `gpu` profile. The worker
  starts it when the profile is on (`depends_on`, `required: false`); `layout` keeps running.
- **Turned on by three lines in `.env`:** `COMPOSE_PROFILES=gpu`, `LAYOUT_URL=http://layout-gpu:8000`,
  `LAYOUT_FALLBACK_URL=http://layout:8000`. Without them nothing changes.

### 16.3 Fallback

`LAYOUT_FALLBACK_URL` makes the worker's analyser a `FallbackLayoutAnalyser`
(`decompose/pdf/layout.py`). A document is read by one service from its first page to its last:

- If the primary is unavailable (unreachable, a 5xx, or no answer within 120 s a request,
  `PRIMARY_TIMEOUT_S`; the fallback keeps 600 s) on any chunk, the whole document is read again
  on the fallback, and the primary is left alone for 60 s; the next document after that tries
  it again. **[call]**
- On a GPU, every failed conversion is a 503 (`DeviceUnavailable`, `device.failure`), never the
  422 of a PDF at fault: Docling catches a stage's CUDA error (out of memory, since other programs
  share the GPU) and reports only a failed conversion, so the CPU service decides whether a PDF is
  refused. The models' first load is covered too: a GPU without room for them answers 503 and
  tries again on the next request. On the CPU nothing is a device error.
- After out of memory the service frees its GPU cache. Any other CUDA error loses the GPU to the
  process: the service answers 503 and exits, and Docker restarts it.
- A document the primary refuses (4xx; on a GPU, only a request the service rejects before
  reading, such as a non-PDF) is not retried: the CPU would refuse it as well.
- Both down: the job is retried as before.

### 16.4 Left for later

- The layout service on another host's GPU (the 3090 above): it needs a published port, a token
  and the 21 GB image copied there.
- Several documents at once: worth it only where the GPU has room, as on the 3090.
