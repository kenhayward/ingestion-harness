# Document decomposition: rebuilding documents in a structured-authoring target

**Status:** design, for review · 2026-10-23 · agreed with the owner in conversation

CT Studio extracts fields and tables from documents today. This design adds a second thing it can
do with a document: **decompose** it into its parts (sections, narrative, tables, images and
equations) and send those parts through the delivery bridge to a target that **reassembles** the
document in its own structured-authoring format.

The first source format is Word (`.docx`), the second is PDF. The first target is an external sink
in a private repository, which writes a structured-authoring dialect; its specifics live there,
not here. Nothing in this design names a vendor.

In this document, **[owner]** marks what the owner decided, and **[call]** marks a call made in
the design conversation that the owner can still overturn.

## 1. Why

Organisations hold their technical reports as Word files, and sometimes only as PDFs. They want
each report to become a **living document** in a structured-authoring system: it goes under that
system's version control, and from then on people and AI revise and extend it. **[owner]**

The rebuilt copy is the master. The original is a one-off source; nothing keeps the two in sync.

The revisions people make afterwards are, in the owner's words, "usually a revised section
narrative, a table summarisation or a new section with human / AI narrative". So the rebuilt
document must be addressable by **section**, and its tables must be readable as data, not only as
formatted text. **[owner]**

Tables are static tables in the rebuilt document in this version. Later, as laboratory systems come
online, their data will flow through a semantic graph, and data-bound tables will replace the
static ones table by table. The two pipelines meet then, not now. **[owner]**

## 2. Goals, non-goals and anti-goals

**Goals**

- Decompose a Word document, and later a PDF (born-digital, scanned or a mixture), into one
  sink-neutral **decomposed document**, and deliver it through the bridge.
- Keep the section hierarchy.
- Keep narrative paragraphs with their character formatting: bold, italic, underline, superscript
  and subscript. Drop fonts, styles and every other kind of formatting. **[owner]**
- Keep tables with their structure: merged cells, cell alignment, titles, footnotes and character
  formatting. Drop other formatting. **[owner]**
- Keep images as separate objects, with their size and their place in the flow, including images
  in table cells. **[owner]**
- Keep tables and figures *numbered*, but let the target produce the numbers, and drop the tables
  of contents and the lists of tables and figures, which the target regenerates. **[owner]**
- Keep equations as structured maths. **[owner]**
- Run straight through, for a single document or a batch of documents (a folder), with no review
  step in CT Studio. Review happens in the target. **[owner]**
- Live on its own top-level tab in CT Studio, with no document types, recipes or Workbench: the
  conversion is deterministic. **[owner]**
- Re-run safely: never overwrite a document someone has changed in the target, and never load the
  same file twice by accident. **[owner]**

**Non-goals**

- Floating images and exact page positions. The target does not support floating images; an
  image's place is its position in the flow. **[owner]**
- Matching the source's look. Fonts, styles, spacing, colours and page layout are dropped.
- Keeping the source and the rebuilt document in sync after delivery.
- Data-bound tables and a semantic-graph path for table data (a later version; §12).
- A review screen for the decomposition in CT Studio.
- Comments, which are dropped. **[owner]**
- `.doc`, `.odt`, `.rtf` and other formats. They can follow the Word reader once there is a need.

**Anti-goals: what makes this a failure even if it technically works**

The owner would accept a rebuilt document whose formatting is "a little different". The big issue
is "if the text or table contents did not come over accurately (e.g. if we got our table cell
merging wrong)". **[owner]**

So:

- **Content is never silently changed, lost or moved.** Every character of the source's body text
  is accounted for (§7). A table's cell grid, merges included, is exactly the source's.
- **A document that fails a fidelity check is not delivered.** It fails in the batch, with the
  reason. A document that is delivered with an uncertainty carries a flag that says where (§5.9).
- **Nothing a person has changed in the target is overwritten from CT Studio, ever** (§8).

## 3. The flow

1. A person starts a **decomposition batch** on the conversion tab (§10): one or more files, or a
   folder, and one target. A single file is a batch of one, which is what testing needs. A folder is
   uploaded from the browser with its relative paths. An S3 prefix as a source is a later addition
   (§12). The target must be one whose sink can take decomposed documents (§9). Every document in
   the batch goes to the one destination chosen on that target. **[owner]** (files or folders, S3
   later); **[call]** (one destination per batch: the source's own subfolders are not mirrored).
2. Each document is one job, decomposed by the worker (§4, §5).
3. The decomposer runs its fidelity checks (§7). A document that fails them stops here.
4. CT Studio checks the **register** (§8) to decide whether this is a new document, an update, a
   repeat or a duplicate.
5. The bridge delivers the decomposed document in a package, as a create or as a version-checked
   update. The sink writes it, reads it back and compares (§7), and returns a receipt with the
   target's **persistent id** and the version of every component it wrote.
6. CT Studio records the receipt in the register.

A batch is many independent documents. One that fails (a corrupt file, an unsupported format, a
fidelity failure, a refusal by the target) fails on its own, and the rest carry on. **[call]**

The batch shows one row per document, with its outcome:

| Outcome | Meaning |
|---|---|
| Created | A new document in the target |
| Updated | A new version of a document delivered before |
| Already loaded | Same file, same place: skipped (§8) |
| Duplicate | Same file under another name: refused (§8) |
| Changed in target | The target's copy has changed since the last delivery: refused (§8) |
| Failed | Could not be decomposed or delivered, with the reason |

Each delivered row links to its document in the target and to its **decomposition report** (§5.9).

## 4. Reading the sources

### Word

Word documents are read **directly from their structure** (the OOXML parts), not through the
existing Word-to-PDF conversion, which stays as it is for extraction jobs. **[call]**

- **Tracked changes** are all accepted. The report says how many. **[owner]**
- **Comments** are dropped. **[owner]**
- **Headings** come from the outline level of each paragraph's style (or its direct outline level),
  so custom heading styles work. Heading numbers are not kept; the target numbers headings.
- **Symbol-font characters** (`w:sym`, and text runs in Symbol or Wingdings, whether the font is
  set on the run or by its styles, read from the font slot Word draws each character in) are
  converted to their Unicode characters. One that has no mapping is flagged and kept as the replacement
  character with its code in the report. The sample report has 34 of them (°, ± and the like).
- **Fields** keep their last displayed text, with these exceptions:
  - table-of-contents fields and lists of tables or figures are dropped;
  - caption-number fields are dropped (the target numbers captions);
  - cross-reference fields become cross-references (§5.6).
- **Content controls and form fields** are replaced by their content.
- **Hidden text** is dropped.
- **Headers and footers** are not content. Fields found in them become document properties
  (§5.8).
- **Drawings** (shapes, groups, canvases, text boxes, SmartArt and native charts) are rendered to
  images with the existing LibreOffice container: each drawing is placed alone in a throwaway
  document at the source's page width, rendered to PNG (and SVG where it converts cleanly), and
  cropped to its bounds. A fallback picture stored in the file is used if the rendering fails.
  Rendered images are flagged. **[call]** A drawing's own text (in text boxes, SmartArt, chart
  titles and labels, and labelled shapes) is carried as the image's alt text, in reading order, so
  it stays searchable and is counted by the fidelity check. **[owner]**
- **EMF and WMF images** are converted to PNG at print resolution, with the original kept beside
  it, and flagged. **[call]**

### PDF

PDFs come as a mixture of born-digital and scanned documents, so the PDF reader decides **page by
page**. **[owner]** (a mixture); **[call]** (the approach).

- **A page with a text layer** is read from the text and its layout: heading levels from font
  size, weight and numbering; tables from ruling lines and column alignment; images as embedded.
- **A scanned page** goes to the vision model CT Studio already uses for OCR
  (`docs/design/ocr-engines.md`). It returns tables as HTML with merged cells kept, which maps onto
  the decomposed table. Figures are cropped from the page image.
- Repeated page furniture is dropped: running headers and footers, page numbers, and tables of
  contents or lists of tables or figures.
- Everything inferred is flagged: every inferred heading level, every table structure found from
  layout, and every scanned page (flagged as recognised, not read).

Both routes produce the same decomposed document as Word. The layout-analysis library is the
builder's choice; it must run locally, like everything else in CT Studio.

## 5. The decomposed document

One decomposed document is a tree of sections holding ordered blocks, plus the images, the notes,
the properties and the report. It replaces the reserved `narrative` part of the package contract,
whose flat block list is too thin for this (§9).

Every element has an **id**, derived deterministically and never from a random value, so a
re-delivery can match the parts it wrote before. Updates usually come from a *revised* source, so
section ids must survive sections being added or removed around them. **[call]**

- **A section's id** comes from its title path: the normalised titles of its ancestors and itself,
  plus its occurrence number among siblings with the same title. The sample repeats titles per
  study, which the occurrence number handles. Adding a section above it doesn't change it.
  Renaming a section's heading makes it a new section, and the old one is gone.
- **Blocks, tables, figures, images and equations** get ids from their section's id and their
  ordinal within it. A section's body is rewritten whole on an update, so positional ids within a
  section are enough. Cross-references use these ids.
- **The decomposer version doesn't feed ids.** An improved decomposer updates the same sections.

### 5.1 Sections

- A **section** has an id, a title (inline content, §5.3), its blocks in order and its child
  sections in order. Its level is its depth in the tree; it is not stored separately.
- Content before the first heading belongs to the document itself, as its leading blocks (their
  ids are under `s~lead`, which no section title can produce).
- An **empty heading** (no text, or only spaces and line breaks) is no section: Word shows
  nothing for it, so it is read as an empty paragraph and left out, and what follows stays in the
  section before it. It is flagged `heading_empty` (info) at that section. **[call]** (owner's
  decision, 2026-10-26: empty headings are left out; phase 1 kept one as a `[]` section.)
- A heading level that skips (level 1, then level 3) gets no invented section in between; the level
  3 section is a child of the level 1 one, and the skip is flagged. **[call]**

### 5.2 Blocks

- **Paragraph**: inline content.
- **List**: ordered or not, with items. Each item holds blocks, so lists nest and an item can hold
  more than one paragraph. Numbering is the target's.
- **Table** (§5.4).
- **Figure**: an image (§5.5), optionally numbered, with a caption and its position (above or
  below).
- **Equation** in display form (§5.7).
- **Image**: an image in the flow that is not a numbered figure.

### 5.3 Inline content

A run of text with marks, where the marks are only `bold`, `italic`, `underline`, `superscript`
and `subscript`. **[owner]** Besides text, inline content holds:

- **a note reference** to a footnote (Word footnotes and endnotes both become footnotes);
- **a cross-reference** to a section, table, figure or equation, by id, with the text the source
  showed;
- **an external link**, with its address and text;
- **an inline equation** (§5.7);
- **an inline image**, rare but possible;
- **a line break**.

Tabs used to line things up become a single space. **[call]**

### 5.4 Tables

A table holds the following.

- **An id, numbered or not, and a caption** in inline content, with its position (above or below).
  The source's literal "Table 13:" and its number field are removed; the target numbers it. A
  multi-part number ("Table 3-1:", "Table 14.2.1", "Table A.1") is removed whole.
- **A caption in a merged first row.** In the sample, each table's title is a merged first row
  that starts "Table n:". Such a row is recognised as the caption, not data.
- **Columns**: relative widths.
- **Header rows**: how many of the top rows are headers, whether marked as repeating in Word or
  recognised (a caption row is never a header row).
- **Rows of cells.** Each cell has its column span, row span, horizontal alignment (left, centre,
  right or justified), vertical alignment (top, middle, bottom) and blocks. A cell holds blocks,
  so it can hold paragraphs, lists and images.
- **Notes**: each has a marker (a, b, c, or 1, 2, 3) and inline content. In the sample, table
  notes are typed as the table's last rows ("a: …"), and once as a one-cell table straight after
  the table. Both are recognised and attached to the table, matched by their markers, and those
  rows leave the grid. Notes that are not recognised stay as rows and are flagged.
- **A "wide" hint** when the table sat on a landscape page, which the target may use when it
  publishes.
- **A key**: a normalised form of the caption text (without its number), so a later data-bound
  table can find the static table it replaces (§12). **[call]**

The cell grid is resolved from Word's own grid (`gridCol`, `gridSpan`, `vMerge`). A table whose
grid doesn't resolve to a rectangle, where every grid slot is covered exactly once, fails the
fidelity check (§7). Nested tables are kept as a table inside a cell. **[call]**

### 5.5 Images

Each image in the document's image list has:

- an id;
- a content type, PNG or JPEG (or SVG when rendered from a drawing that converts cleanly);
- the bytes, carried as package images by reference;
- its width and height, in millimetres;
- its alignment (left, centre, right, or inline in text);
- its alt text: the source's own, or, for a rendered drawing, the drawing's text (§4);
- its origin: embedded, converted (from EMF or WMF), rendered (from a drawing) or cropped (from a
  scanned page);
- the original bytes, when the image was converted.

Its place in the flow is where its block or inline item sits: in a section, between the blocks
before and after it, or in a table cell. **[owner]** A floating image is anchored to its
paragraph, placed in the flow there, and flagged. **[call]**

### 5.6 Cross-references

- **A Word cross-reference field** points at a bookmark; the decomposer resolves it to the section,
  table, figure or equation the bookmark is in. This is exact.
- **A typed reference** ("see Table 3", "Figure 1 shows…", "Table 3-2") is matched to the caption
  with that whole number in the source. Anything it can't match stays as plain text and is flagged. **[call]**
- **An internal hyperlink** becomes a cross-reference to its target.

### 5.7 Equations

Each equation, whether inline or a display block, has three forms. The sink takes the best one it
can handle. **[owner]**

- **MathML**, converted from Word's equation format. This is the main form.
- **LaTeX**, derived from the MathML.
- **An image**, SVG and PNG, rendered as the fallback.

An equation that doesn't convert (including one with a fraction, script or other structure left
empty once tracked changes are accepted) is kept as the image only, and flagged. The converter must be one
CT Studio can redistribute (Microsoft's own conversion stylesheet ships with Office and can't be);
the builder picks it. **[call]**

### 5.8 Properties

The decomposed document offers what it found about the document to the target's connector. The
connector may use it or ignore it. **[owner]**

Each property is a name, a value and its origin:

- `core`: title, subject, author, keywords and dates from the file's own properties;
- `custom`: custom document properties;
- `header-field`: name and value pairs found in headers and footers. In the sample, these are
  document-management fields: owning location, type, subtype and title;
- `pdf-info`: a PDF's information dictionary and metadata.

### 5.9 The report

Each decomposed document carries its **decomposition report**: a list of flags, each with a code,
a severity (`info` or `warning`), where it applies (a section, block or table id) and a message.
The report is shown in CT Studio and sent with the document, so the target's reviewers can see what
to check. The sink decides how to show it there.

The flag codes:

- `changes_accepted`: tracked changes were accepted (with the count);
- `symbol_unmapped`;
- `heading_skipped_level`;
- `heading_empty` (info): an empty heading was left out (§5.1), at the section it was in;
- `caption_not_found`: a table or figure has no caption that could be recognised;
- `table_notes_unrecognised`;
- `xref_unmatched`;
- `image_floating_anchored`;
- `image_converted`;
- `drawing_rendered`;
- `equation_image_only`;
- `structure_inferred`: PDF only;
- `page_recognised`: PDF only, for a scanned page.

## 6. What's kept and what's dropped

| Kept | Dropped |
|---|---|
| Section hierarchy and titles | Heading numbers (the target numbers) |
| Paragraph text, in order | Fonts, styles, colours, spacing, highlighting |
| Bold, italic, underline, superscript, subscript | All other character formatting |
| Lists and their nesting | List numbering and bullets (the target's) |
| Tables: grid, merges, alignment, header rows, caption, notes | Borders, shading, cell padding, widths in absolute units |
| Table and figure captions, as numbered | Literal caption numbers and number fields |
| Images: size, alignment, place in the flow, alt text | Floating positions, wrapping, page coordinates |
| Equations (MathML, LaTeX, image) | — |
| Footnotes and endnotes (as footnotes) | — |
| Cross-references and external links | — |
| Document properties, offered | Headers and footers as content |
| Tracked changes, accepted | Comments, hidden text |
| A "wide" hint for landscape tables | Page breaks, section breaks, page setup |
| — | Tables of contents, lists of tables and figures |

## 7. Fidelity checks

These enforce the anti-goal. They run on every document, every time. **[call]**

**In the decomposer, before delivery:**

- **Text accounting.** The source's body text is extracted independently of the decomposition,
  from the same accepted-changes view. That means every paragraph, cell, note and caption, minus
  only the categories this design drops (tables of contents, number fields, hidden text, comments,
  deleted text, headers and footers). It is compared with the text of the decomposed document,
  read back in order. A drawing's text counts at the drawing's place, through its image's alt text.
  They must be equal, apart from whitespace normalisation and these documented conversions:
  symbols to Unicode, tabs to spaces, caption numbers removed ("Table 13:"), and table-note markers
  moved from their rows into the table's notes. An equation kept as an image only is compared by
  its image. A difference fails the document, naming the
  first place they diverge.
- **Table grids.** For each table, the grid resolved from the source and the grid rebuilt from the
  decomposed cells must be the same shape, with the same spans and the same cell text. This is what
  catches a wrong merge. A difference fails the document.
- **References.** Every note reference, cross-reference and image reference resolves to something
  in the document.

**In the sink, after writing:** the sink reads the written document back, converts it to the same
text and table-grid forms, and compares them with what it was sent. The result is in the receipt.
A mismatch is shown in CT Studio as a failed delivery, naming where, and the document stays in the
target for a person to look at. Read-back is required of any sink that takes decomposed documents
(§9).

For PDFs, text accounting compares with the PDF's own text layer on born-digital pages; scanned
pages have no independent text to compare with, which is why they are flagged.

**Test corpus.** The decomposer's tests use synthetic documents built in the tests, which cover
each construct in §5. Real sample reports stay outside this repository, in a private corpus the
owner runs against.

## 8. Identity and re-runs

The target assigns each document a **persistent id**, a string unique on its tenant, when it first
creates it. **[owner]** CT Studio keeps a **register** that links sources to those ids.

### The register

One entry per delivered document, scoped to the target's sink and instance (so to one tenant):

- the **source key**: the file's path relative to the batch's source folder, as the browser reports
  it (including the folder's own name). For a file uploaded on its own, the key is its file name;
- the **content hash**: the SHA-256 of the file's bytes, which CT Studio already computes;
- the **persistent id**;
- the **last receipt**: every component the sink wrote, with its version;
- the job, the batch, and when it was delivered.

The same file sent to two tenants is two documents, with two entries. **[call]**

An entry is in one of these states. **[call]**

- `pending`: a delivery is in flight;
- `delivered`: the document arrived and read back equal;
- `incomplete`: it arrived without a clean receipt;
- `changed`: the target refused an update as *changed in target*;
- `failed`: the delivery failed;
- `detached` and `accepted`: someone resolved a refusal (see "Resolving a refused document").

### The two checks

**[owner]** (the two checks); **[call]** (how they combine):

| Content hash | Source key | Outcome |
|---|---|---|
| seen on this tenant | same | **Already loaded**: skipped |
| seen on this tenant | different | **Duplicate**: refused, naming the document it duplicates |
| new | same | **Update**, behind the version check |
| new | new | **Create**, and register under both |

**Force-load**, chosen on a batch or on one document:

- turns *already loaded* into an update, for example after the decomposer improves;
- turns *duplicate* into a create: a deliberate second document with its own persistent id;
- **never bypasses the version check.**

**Redeliver** from a document's row in CT Studio, optionally with a replacement file, updates
that document explicitly. This is how a renamed or moved file updates the right document.

### The version check

An update says to the sink: "update the document with this persistent id, provided every component
in this receipt is still at this version". **[owner]**

- **If they all are,** the sink writes the update as a new version under the target's version
  control, and returns the new receipt.
- **If any component has changed or gone,** the sink refuses and changes nothing. This includes
  a section someone revised, an image replaced, a section added or removed, or the document
  deleted. The refusal lists each changed component with its version then and now. CT Studio shows
  the document as *changed in target*.

The sink makes the check and the update as close to atomic as the target allows, using locks where
it has them. The check is exact: any new version counts as a change, even one the target makes
for a lifecycle change. **[call]**

Two jobs for the same register entry never run at once. The register entry is locked while a
delivery for it is in flight. **[call]**

### Resolving a refused document **[owner]**

A document refused as *changed in target* offers its owner two actions in CT Studio:

- **Detach.** CT Studio forgets the register entry. The edited document stays in the target,
  untouched, and the next run of that source creates a new document with a new persistent id.
  - **[call]** "Forgets" means the entry is kept as a `detached` marker, naming the detach.
    Both checks ignore it, so the same file is neither *already loaded* nor a *duplicate*.
  - The next create of that source carries the detach in its idempotency key (§9). That way the
    target can't answer with the detached document, even when the file is the one it was first
    made from.
  - That create replaces the marker with a new entry.
- **Accept the target's current state.** CT Studio reads the target's current component versions
  into the register entry, so the next run's update goes through, **overwriting the edits made in
  the target**. The confirmation shows each changed component with its versions before and now,
  and names who changed it where the target reports that. The person must confirm explicitly.
  Each acceptance is recorded with who and when.
  - **[call]** The versions come from the refusal itself, which lists each changed component
    with its version then and now. The target has no call that reads them. A component that is
    gone is dropped.
  - When more than 40 components changed, the refusal doesn't list them all. CT Studio then
    can't accept, and offers detach instead.
  - The target doesn't report who made a change, so the confirmation doesn't show it.
  - The entry becomes `accepted`. The next run of that source is an update, even of the same
    file, so it is never *already loaded*. Once that update arrives, the entry is `delivered`
    again.
  - The confirmation is refused if the entry changed after the person saw it, so they confirm
    only what they saw.

Both actions work on one document at a time. The batch view lists the refused ones. **[call]**

**[call]** Detach and accept apply only to an entry that is currently refused as *changed in
target*:

- A row whose document a later run has since delivered or refused again shows as *superseded*,
  with neither action. That way an old row can never detach a live document.
- A row whose entry is in flight offers neither.
- **[call]** An entry with a document but no recorded component versions can't be held to the
  target's copy, so no update is sent: the row reads *unresolved* ("detach to create a new one,
  or resolve it in the target") and offers detach only. There is nothing to accept.

**[call]** (owner, 2026-10-26) **A document gone from the target.** A target may answer an update
of a document it no longer holds (deleted there, say) with `not_found` rather than *changed in
target*. The sink then sends a marker, and only that refusal carries it: `not_found` with
`details: {reason: 'document_missing', persistentId}`, naming the document the update named. An
entry is *gone* only when it has a persistent id, is `failed`, and its last error is that marker
with the entry's own persistent id. Any other `not_found` says nothing about the document and is
never *gone*: a delivery the bridge has no record of (the reconcile's), no such route, a sink job
lost after a restart, or a document found elsewhere. Reloading on one of those could duplicate a
document that still exists. For a gone entry the row reads *unresolved* ("The target no longer has this document (it may have
been deleted). Load it as a new document to create it again.") and the item says `gone`. No run sends
it another update, forced or not. The row offers **Load as a new document** and detach. The item's
`reloadable` says when it applies: the entry is gone, or is still the detached tombstone (so a
reload whose rerun failed after its detach can be tried again), and the row isn't *superseded*.
Load as a new document asks for confirmation, then detaches the entry (recorded with `reason: gone`) and
reruns the stored file as a plain create in a new batch of one. Because of the detach, that create
makes a new document with a new persistent id. A double click makes one batch.

### Deliveries that don't finish cleanly **[call]**

A create can write to the target and still not end with a clean receipt: read-back fails, the sink
fails part-way, or the response is lost. None of these may lead to a second copy next time.

- **The register entry is written before delivery,** in state `pending`, with the source key, the
  hash and the delivery's idempotency key. It becomes `delivered` with the receipt, or `incomplete`
  with whatever persistent id and components the sink reported.
- **A sink's create is idempotent by its idempotency key.** The sink records the key on the
  document it creates, and before creating it looks for a document carrying that key. It returns
  that document's receipt instead of creating another.
- **A replayed key returns the receipt of the first write under it, never the current state.**
- **A failed read-back** is reported in a receipt. The entry is `incomplete` with the persistent
  id, and the batch row says *read-back mismatch*, with the place.
- **The bridge retries `retryable` errors** as it does today. A retry carries the same
  idempotency key, so it finds the first attempt's document.
- **An entry with no persistent id** is created again under a new key only when the bridge
  refused its last delivery outright. Otherwise that delivery may have made a document: the same
  file is created again under the entry's stored key, which finds it, and a changed file is
  *unresolved* until it is resolved in the target.
- **A later run of an `incomplete` entry** is an update behind the version check, against the
  components reported so far, like any other.

## 9. Contract changes

The package contract is published (`@ih/bridge-contract`, 0.7.0) and a private sink depends on it,
so it changes deliberately, as a new contract version. **[call]**

- **Contract version 2** adds a `document` part to the package: the decomposed document of §5.
  Its images travel in the existing `images` part. The reserved `narrative` part is withdrawn.
  **[call]** on what goes with it:
  - A package with a `document` part carries nothing else except `images`. Decomposition and
    extraction stay separate deliveries.
  - Provenance becomes a choice between two variants. The existing *extraction* variant has its
    recipe and approver. The new *decomposition* variant has its batch id, the decomposer
    version and the user who started the batch, but no recipe and no approver.
  - Version 2 is otherwise version 1 plus these additions, so a version 2 sink receives extraction
    packages in version 2 form with no change to their content.
- **Shared comparison code.** The text and table-grid forms of §7, and their normalisation, are
  defined once, in the contract package, as functions over a decomposed document. The decomposer
  and the sink's read-back both use them, so a mismatch is never just two implementations
  disagreeing. **[call]**
  - A cross-reference compares by the id it points at, not by its text, because the target
    generates the text.
  - An equation compares by its MathML, or by its image's id when the sink took the image.
- **The bridge keeps version 1 sinks working.** A sink declares its contract version in
  `describe`. The bridge sends version 1 packages to version 1 sinks, and never sends a `document`
  part to them.
- **A new capability, `decomposedDocuments`.** A sink that offers it must:
  - assign a persistent id per document, unique on the tenant, never reused;
  - return the version of every component it wrote, in its receipt;
  - accept a conditional update (a persistent id plus the expected component versions), and refuse
    without changing anything if any differ;
  - read back and compare after writing (`readBack: true`);
  - state which equation forms it accepts (`mathml`, `latex`, `image`).

  CT Studio offers a target for decomposition batches only if its sink has this capability.
- **The deliver request** gains an optional `update`: the persistent id and the expected component
  versions from the register's last receipt.
- **The receipt** gains, for a decomposed document:
  - its persistent id;
  - every component with its kind, id, version and the decomposed-document element it holds (for
    example, a section id or an image id);
  - the read-back result.
- **A new error code, `changed_in_target`** (class `needs_user`), whose details list each changed
  component with its expected version and its current version, or that it is gone.
- **Idempotency.** For a decomposition, the key is derived from the source hash, the target
  document's persistent id (empty for a create), the decomposer version and a run token, so a
  retried delivery is recognised as the same one. The run token is:
  - **for an update:** the digest of the versions it expects, which is the SHA-256 of the sorted
    `id@version` list. **[call]** Two updates of one document that expect different versions
    are different writes, even of the same file. So A, then B, then A again writes A a second
    time, rather than replaying A's first receipt. A retry expects the same versions, so it
    keeps its key.
  - **for a create after a detach:** the detach action's id, until the source has a document
    again. **[call]** This includes a create the bridge refused outright. That create's key
    differs from the detached document's, so the target can't answer with that document (§8).
  - **for a force-load:** a new token for the batch, so it is a new delivery. A forced update
    joins it to the digest of the versions it expects.
  - **for any other create:** none. The same file gets the same key, so it gets the same result.
- **The conformance suite** gains checks for the capability: create, read back, update with
  matching versions, refused update with a changed version, and a version 1 sink never receiving a
  `document` part.

## 10. Where it lives

- **Worker.**
  - The Word reader, the PDF reader, the fidelity checks and the report.
  - Drawing and EMF rendering, through the existing LibreOffice container.
  - Scanned pages, through the existing OCR model.
- **API.**
  - Decomposition batches, their jobs and their outcomes.
  - The register and its two checks.
  - Force-load and redeliver.
  - Detach and accept-target-state, with the record of each acceptance.
- **Web: a new top-level tab** beside the existing ones, for decomposition only. Its working name
  is **Conversion**; the owner will settle the final name. **[owner]**
  - Upload one or more files, or a folder, and choose a target. There is no document type, recipe
    or Workbench step, because the conversion is deterministic. **[owner]**
  - Progress while a batch runs, one row per document.
  - Results: each document's outcome, its link in the target, its report, and the actions it
    offers (force-load, redeliver, detach, accept the target's state).
  - Earlier batches, newest first.
- **Bridge.** Delivering version 2 packages, conditional updates and the new receipt fields.
- **Contract package.** Version 2, published, with the conformance checks.

Decomposition batches are a new kind of job beside extraction jobs, not a recipe. They have no
model-driven extraction and no review step. **[call]**

## 11. Phasing

| # | Work | Done when |
|---|---|---|
| 1 | **Word into the decomposed document**, with its fidelity checks and report, run from a test harness | The synthetic corpus decomposes and passes its checks, and the owner's private samples decompose with no fidelity failure |
| 2 | **Contract version 2, the bridge, the register and the version check**, against a fake sink | The conformance suite's new checks pass against the fake sink; re-runs produce each outcome in §3 |
| 3 | **Batches in CT Studio**: the API and the conversion tab | A single file, and then a folder, go through to the fake sink with one row per document |
| 4 | **The first real sink** (in its own repository: its dialect capture and its writes) | A sample report reaches a sandbox, reads back equal, and updates and refuses as §8 says |
| 5 | **PDF**, born-digital and scanned | PDF samples decompose; scanned pages are flagged |
| 6 | **S3 prefix as a batch source** | A prefix runs as a folder does |

Phases 1 and 4's capture work need nothing from each other and can run side by side.

**Phase 3 status.** Phase 3 is implemented. It covers:

- conversion batches in the API, as one `decompose` job per file in the worker;
- each file's outcome settled from the bridge's events;
- force-load, redeliver, detach and accept from a document's row;
- the **Conversion** tab.

It is tested end to end, from the API's routes through the worker and the bridge to the fake
document sink (`apps/api/test/integration/conversion-e2e-pg.test.ts`). The test runs a single
file, then a folder, and covers already loaded, updated, changed in target, accept and detach.
The owner's run of the sample report against the real sink is pending (phase 4).

**Phase 2 status.** Phase 2 is implemented: contract version 2 (`document` part, conditional
update, `changed_in_target`), the bridge's version check, the register and its reconcile, and the
conformance suite's document checks, tested end to end through the bridge against the fake
document sink (`apps/bridge/test/decomposed-e2e.test.ts`).

**Phase 1 status.** Phase 1 (Word) is implemented; the owner's sample run is pending. Run it with
`uv run --directory worker python scripts/decompose.py <file.docx> <out-dir> [--converter-url URL]`.

## 12. Later

- **Data-bound tables.** A table's key (§5.4) lets a later data-bound table find the static table
  it replaces. That is when this pipeline and the extraction pipeline's semantic-graph path meet.
- **S3 batches** (phase 6).
- **Other source formats** through the Word reader's model.
- **Mirroring the source folders** in the target, if wanted.

## 13. Left to the builder

- The libraries for reading OOXML, analysing PDF layout, converting OMML to MathML and MathML to
  LaTeX. They must run locally, and CT Studio must be able to redistribute them.
- The exact JSON shape of the decomposed document, within §5.
- The register's table layout, within §8.
- How the conversion tab looks, following CT Studio's existing pages and styling.
- How text is normalised for text accounting (§7), provided the documented conversions are the only
  differences allowed.
