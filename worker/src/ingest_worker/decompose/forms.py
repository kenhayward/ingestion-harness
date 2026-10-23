"""The comparison forms of a decomposed document: its text, unit by unit, and its table grids.

These are the shared comparison code of the design (§7, §9). The decomposer's fidelity check
compares them with the source, and a sink's read-back compares them with what it wrote, so both
sides must compute them identically. They are pinned by the vectors in the contract package
(`packages/bridge-contract/vectors/comparison-forms.json`), which any other implementation must
reproduce exactly.

The text form is one string per text unit, in document order, each normalised and empty ones
left out:

- the leading blocks, then each section: its title, its blocks, then its subsections;
- a paragraph is one unit; a list gives the units of its items' blocks;
- a table gives its caption, then one unit per cell, row by row (a cell's units joined by a
  space), then one per note, as `marker: text`;
- a figure gives its caption, then its image; an image block its image; an equation block
  its equation token;
- the notes come last, in the order they are listed, as the units of their blocks.

Within a unit, an `XRef` is `⟦xref:<target_id>⟧`, never its text; an equation is
`⟦eq:<mathml>⟧`, or `⟦eq:<image_id>⟧` when it has no MathML; an image (inline, in a block, a
figure or a cell) is `⟦img⟧`, then a space and its alt text if it has any; a `NoteRef` is
`⟦note:<note_id>⟧`; a `Break` is a space; a `Link` is its content. The image token carries no
id, so that a source can be compared without knowing the ids the decomposition gave.

The grid form of a table is its grid rebuilt from the cells' spans: one row of slots per row, each
slot `"r,c|text"`, the row and column of the cell covering it and that cell's text. A slot no
cell covers is `""`.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterator, Sequence

from .model import (
    Block,
    Break,
    Cell,
    DecomposedDocument,
    EquationBlock,
    Figure,
    ImageBlock,
    Inline,
    InlineEquation,
    InlineImage,
    Link,
    ListBlock,
    NoteRef,
    Paragraph,
    Section,
    Table,
    Text,
    XRef,
)

#: The whitespace `normalise` collapses: exactly what JavaScript's `\s` matches, so that the
#: TypeScript forms can use `/\s+/gu`. A zero-width space (U+200B) is not whitespace.
WHITESPACE = re.compile(
    "[\t\n\v\f\r \u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+"
)


def normalise(s: str) -> str:
    """NFC, every run of whitespace (no-break spaces and newlines included) as one space,
    trimmed."""
    return WHITESPACE.sub(" ", unicodedata.normalize("NFC", s)).strip(" ")


def xref_token(target_id: str) -> str:
    return f"⟦xref:{target_id}⟧"


def equation_token(value: str) -> str:
    return f"⟦eq:{value}⟧"


def note_token(note_id: str) -> str:
    return f"⟦note:{note_id}⟧"


#: Where an image is, in the text form.
IMAGE_TOKEN = "⟦img⟧"


def image_text(alt: str | None) -> str:
    """An image in the text form: its token, then its alt text if it has any."""
    return f"{IMAGE_TOKEN} {alt}" if alt else IMAGE_TOKEN


def join_units(units: Sequence[str]) -> str:
    """Units as one: each normalised, the empty ones left out, joined by a space."""
    return " ".join(u for u in (normalise(x) for x in units) if u)


def note_unit(marker: str, text: str) -> str:
    return f"{marker}: {text}"


#: Where a unit is: the id of the section it is in (None before the first heading), or of the
#: note it is in.
Place = str | None


class _Forms:
    """The forms of one document. `image_only`, when given, stands in for the token of every
    equation that has no MathML, for comparison with a source that cannot know its image id."""

    def __init__(self, doc: DecomposedDocument, *, image_only: str | None = None) -> None:
        self.alts = {i.id: i.alt for i in doc.images}
        self.equations = {e.id: e for e in doc.equations}
        self.image_only = image_only

    # -- inlines --

    def inline_text(self, inlines: Sequence[Inline]) -> str:
        return "".join(self.inline(i) for i in inlines)

    def inline(self, item: Inline) -> str:
        if isinstance(item, Text):
            return item.text
        if isinstance(item, Break):
            return " "
        if isinstance(item, XRef):
            return xref_token(item.target_id)
        if isinstance(item, Link):
            return self.inline_text(item.inlines)
        if isinstance(item, InlineEquation):
            return self.equation(item.equation_id)
        if isinstance(item, InlineImage):
            return image_text(self.alts.get(item.image_id))
        if isinstance(item, NoteRef):
            return note_token(item.note_id)
        return ""

    def equation(self, equation_id: str) -> str:
        equation = self.equations.get(equation_id)
        if equation is None:
            return equation_token(equation_id)
        if equation.mathml is not None:
            return equation_token(equation.mathml)
        return self.image_only or equation_token(equation.image_id)

    # -- blocks --

    def block_units(self, block: Block) -> Iterator[str]:
        """The raw (not yet normalised) units of a block."""
        if isinstance(block, Paragraph):
            yield self.inline_text(block.inlines)
        elif isinstance(block, ListBlock):
            for item in block.items:
                for inner in item.blocks:
                    yield from self.block_units(inner)
        elif isinstance(block, Table):
            yield self.inline_text(block.caption)
            for row in block.rows:
                for cell in row.cells:
                    yield self.cell_text(cell)
            for note in block.notes:
                yield note_unit(note.marker, self.inline_text(note.inlines))
        elif isinstance(block, Figure):
            yield self.inline_text(block.caption)
            yield image_text(self.alts.get(block.image_id))
        elif isinstance(block, ImageBlock):
            yield image_text(self.alts.get(block.image_id))
        elif isinstance(block, EquationBlock):
            yield self.equation(block.equation_id)

    def cell_text(self, cell: Cell) -> str:
        return join_units([u for b in cell.blocks for u in self.block_units(b)])

    def located(self, doc: DecomposedDocument) -> list[tuple[str, Place]]:
        units: list[tuple[str, Place]] = []

        def add(raw: Iterator[str], place: Place) -> None:
            units.extend((u, place) for u in (normalise(x) for x in raw) if u)

        def section(s: Section) -> None:
            add(iter([self.inline_text(s.title)]), s.id)
            for block in s.blocks:
                add(self.block_units(block), s.id)
            for sub in s.sections:
                section(sub)

        for block in doc.blocks:
            add(self.block_units(block), None)
        for s in doc.sections:
            section(s)
        for note in doc.notes:
            for block in note.blocks:
                add(self.block_units(block), note.id)
        return units

    # -- grids --

    def grid(self, table: Table) -> list[list[str]]:
        covered: dict[tuple[int, int], str] = {}
        for r, row in enumerate(table.rows):
            c = 0
            for cell in row.cells:
                while (r, c) in covered:
                    c += 1
                slot = f"{r},{c}|{normalise(self.cell_text(cell))}"
                for dr in range(max(cell.row_span, 1)):
                    for dc in range(max(cell.col_span, 1)):
                        covered.setdefault((r + dr, c + dc), slot)
                c += max(cell.col_span, 1)
        rows = max([len(table.rows), *(r + 1 for r, _ in covered)])
        width = max([0, *(c + 1 for _, c in covered)])
        return [[covered.get((r, c), "") for c in range(width)] for r in range(rows)]


def tables_of(doc: DecomposedDocument) -> list[Table]:
    """Every table of the document, nested ones included, in the order of the text form."""
    found: list[Table] = []

    def blocks(items: Sequence[Block]) -> None:
        for block in items:
            if isinstance(block, Table):
                found.append(block)
                for row in block.rows:
                    for cell in row.cells:
                        blocks(cell.blocks)
            elif isinstance(block, ListBlock):
                for item in block.items:
                    blocks(item.blocks)

    def section(s: Section) -> None:
        blocks(s.blocks)
        for sub in s.sections:
            section(sub)

    blocks(doc.blocks)
    for s in doc.sections:
        section(s)
    for note in doc.notes:
        blocks(note.blocks)
    return found


def text_form(doc: DecomposedDocument) -> list[str]:
    """The document's text units, normalised, in document order."""
    return [unit for unit, _ in _Forms(doc).located(doc)]


def located_text_form(
    doc: DecomposedDocument, *, image_only: str | None = None
) -> list[tuple[str, Place]]:
    """The text form with the place of each unit; `image_only`, if given, is the token of
    every equation that has no MathML."""
    return _Forms(doc, image_only=image_only).located(doc)


def grid_forms(
    doc: DecomposedDocument, *, image_only: str | None = None
) -> dict[str, list[list[str]]]:
    """Per table id, the table's grid as `"r,c|text"` slots; `image_only` as in
    `located_text_form`."""
    forms = _Forms(doc, image_only=image_only)
    return {t.id: forms.grid(t) for t in tables_of(doc)}
