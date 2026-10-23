# Comparison-form vectors

`comparison-forms.json` pins the **shared comparison code** of the document decomposition
design (spec §7 and §9): the text form and the table-grid forms of a decomposed document. The
decomposer's fidelity check compares them with the source, and a sink's read-back compares them
with what it wrote. A mismatch must never be just two implementations disagreeing, so every
implementation must reproduce these vectors **exactly**.

Phase 1 implements the forms in Python (`worker/src/ingest_worker/decompose/forms.py`), which
generated these vectors. Phase 2's TypeScript forms in this package must reproduce every vector
exactly before they are used. Changing a form means changing the vectors, and both
implementations, together.

## Shape

An array of `{ name, document, text_form, grid_forms }`:

- `document`: a decomposed document (the worker's `DecomposedDocument`, as JSON).
- `text_form`: an array of strings, one per text unit.
- `grid_forms`: an object, from table id to that table's grid (an array of rows, each an array
  of slot strings).

## The forms

**Normalisation** of a string:

1. Unicode NFC.
2. Every run of whitespace becomes one space. Whitespace is exactly what JavaScript's `\s`
   matches: tab, line feed, vertical tab, form feed, carriage return, space, U+00A0, U+1680,
   U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000 and U+FEFF. A zero-width space
   (U+200B) is not whitespace.
3. Trimmed.

**The text form** is one string per text unit, in document order. Each unit is normalised, and
empty units are left out.

- The document's leading `blocks`, then each section: its title, its blocks, then its
  subsections, depth first.
- A paragraph is one unit. A list gives the units of its items' blocks, in order.
- A table gives:
  - its caption;
  - one unit per cell, row by row, in the order of `rows[].cells[]`; a cell's unit is the units
    of its blocks, each normalised, empty ones left out, joined by one space;
  - one unit per note, as `marker: text`.
- A figure gives its caption, then its image's alt text.
- An image block gives its image's alt text.
- An equation block gives its equation's token.
- The notes come last, in the order of `notes`, as the units of their blocks.

Within a unit:

| Inline | Contributes |
|---|---|
| `text` | its text |
| `break` | a space |
| `xref` | `⟦xref:<target_id>⟧`, never its text |
| `link` | its inlines |
| `inline_equation` | `⟦eq:<mathml>⟧`, or `⟦eq:<image_id>⟧` when the equation has no MathML |
| `inline_image` | its image's alt text (nothing when it has none) |
| `note_ref` | nothing |

The brackets are U+27E6 and U+27E7.

**The grid form** of a table is its grid rebuilt from its cells' spans. Each row of `rows` is
placed in turn. A cell takes the first slot of its row that no cell above (by `row_span`) or
before it already covers. It covers `row_span` rows and `col_span` columns from there. Each
slot is `"r,c|text"`: the row and column of the cell covering it, then that cell's text, as in
the text form. A slot no cell covers is `""`. There is one row per row of `rows` (more if a
row span runs past the last), and as many slots as the widest row reaches. Every table has a
grid form, nested tables and those in notes included.
