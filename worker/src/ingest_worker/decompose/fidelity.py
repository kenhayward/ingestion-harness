"""Fidelity checks: the decomposed document against an independent walk of its source (§7).

Content must never be silently changed, lost or moved. `check` compares three things and
refuses the document, naming the place, on the first difference:

- **References.** No two sections, blocks, notes, images or equations share an id. Every note
  reference, cross-reference, image and equation the document mentions exists in it, and
  every equation's image does.
- **Text.** `source_walk` reads the source's OOXML itself, in the order and with the units of
  `forms.text_form`, and the two must be equal.
- **Table grids.** For each table, the grid `tables.source_grid` resolves from the source (with
  its caption and note rows set aside), with each cell's text as the source walk reads it,
  must equal the table's grid form. This catches a wrong merge even when the text agrees.

`check` adds no flags: it returns None or raises `DecompositionFailed`.
"""

from __future__ import annotations

from collections.abc import Iterator, Sequence

from .forms import grid_forms, located_text_form, tables_of
from .inline import InlineContext
from .model import (
    Block,
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
    XRef,
)
from .package import DecompositionFailed, Package
from .source_walk import IMAGE_ONLY_EQUATION, SourcePlace, read_source, source_text_units

__all__ = [
    "IMAGE_ONLY_EQUATION",
    "DecompositionFailed",
    "check",
    "check_references",
    "source_text_units",
]

_MAX_SHOWN = 120


# --- References ------------------------------------------------------------------------------


class _References:
    def __init__(self, doc: DecomposedDocument) -> None:
        self.images = {i.id for i in doc.images}
        self.equations = {e.id for e in doc.equations}
        self.notes = {n.id for n in doc.notes}
        targets = [
            *(n.id for n in doc.notes),
            *(b.id for b in _all_blocks(doc)),
            *(s.id for s in _all_sections(doc.sections)),
        ]
        seen: set[str] = set()
        for element_id in [*targets, *(i.id for i in doc.images), *(e.id for e in doc.equations)]:
            if element_id in seen:
                raise DecompositionFailed(f"duplicate id {element_id}", element_id)
            seen.add(element_id)
        self.ids = set(targets)  # what a cross-reference may point at

    def missing(self, what: str, at: str | None) -> DecompositionFailed:
        return DecompositionFailed(f"{what} does not resolve", at)

    def inlines(self, items: Sequence[Inline], at: str | None) -> None:
        for item in items:
            if isinstance(item, NoteRef) and item.note_id not in self.notes:
                raise self.missing(f"note reference {item.note_id}", at)
            if isinstance(item, XRef) and item.target_id not in self.ids:
                raise self.missing(f"cross-reference to {item.target_id}", at)
            if isinstance(item, InlineImage) and item.image_id not in self.images:
                raise self.missing(f"image {item.image_id}", at)
            if isinstance(item, InlineEquation) and item.equation_id not in self.equations:
                raise self.missing(f"equation {item.equation_id}", at)
            if isinstance(item, Link):
                self.inlines(item.inlines, at)

    def blocks(self, blocks: Sequence[Block], at: str | None) -> None:
        for block in blocks:
            if isinstance(block, Paragraph):
                self.inlines(block.inlines, at)
            elif isinstance(block, ListBlock):
                for item in block.items:
                    self.blocks(item.blocks, at)
            elif isinstance(block, Table):
                self.inlines(block.caption, at)
                for row in block.rows:
                    for cell in row.cells:
                        self.blocks(cell.blocks, at)
                for note in block.notes:
                    self.inlines(note.inlines, at)
            elif isinstance(block, Figure | ImageBlock):
                if isinstance(block, Figure):
                    self.inlines(block.caption, at)
                if block.image_id not in self.images:
                    raise self.missing(f"image {block.image_id}", at)
            elif isinstance(block, EquationBlock) and block.equation_id not in self.equations:
                raise self.missing(f"equation {block.equation_id}", at)

    def check(self, doc: DecomposedDocument) -> None:
        for equation in doc.equations:
            if equation.image_id not in self.images:
                raise self.missing(f"the image {equation.image_id} of equation {equation.id}", None)
        self.blocks(doc.blocks, None)
        for section in _all_sections(doc.sections):
            self.inlines(section.title, section.id)
            self.blocks(section.blocks, section.id)
        for note in doc.notes:
            self.blocks(note.blocks, note.id)


def _all_sections(sections: Sequence[Section]) -> Iterator[Section]:
    for section in sections:
        yield section
        yield from _all_sections(section.sections)


def _all_blocks(doc: DecomposedDocument) -> Iterator[Block]:
    def inner(blocks: Sequence[Block]) -> Iterator[Block]:
        for block in blocks:
            yield block
            if isinstance(block, ListBlock):
                for item in block.items:
                    yield from inner(item.blocks)
            elif isinstance(block, Table):
                for row in block.rows:
                    for cell in row.cells:
                        yield from inner(cell.blocks)

    yield from inner(doc.blocks)
    for section in _all_sections(doc.sections):
        yield from inner(section.blocks)
    for note in doc.notes:
        yield from inner(note.blocks)


def check_references(doc: DecomposedDocument) -> None:
    """Refuse `doc` if two of its elements share an id, or a note reference, cross-reference,
    image or equation it mentions (or an equation's image) is not in it."""
    _References(doc).check(doc)


# --- The check -------------------------------------------------------------------------------


def _shown(unit: str | None) -> str:
    if unit is None:
        return "nothing"
    return f'"{unit[:_MAX_SHOWN]}{"…" if len(unit) > _MAX_SHOWN else ""}"'


def _section_at(place: SourcePlace, sections: Sequence[str]) -> str | None:
    """The id a source place names: a note's id, or the section with that ordinal (the k-th
    heading of the source is the k-th section of the document, depth first)."""
    if isinstance(place, str):
        return place
    if place == 0 or not sections:
        return None
    return sections[min(place, len(sections)) - 1]


def check(doc: DecomposedDocument, pkg: Package, ctx: InlineContext) -> None:
    """Refuse `doc` if a reference doesn't resolve, its text differs from the source's, or a
    table's grid differs from the source's; the error names where."""
    check_references(doc)

    walk = read_source(pkg, ctx)
    source = walk.units
    located = located_text_form(doc, image_only=IMAGE_ONLY_EQUATION)
    sections = [s.id for s in _all_sections(doc.sections)]
    for i in range(max(len(source), len(located))):
        ours = source[i][0] if i < len(source) else None
        theirs = located[i][0] if i < len(located) else None
        if ours == theirs:
            continue
        at = _section_at(source[i][1], sections) if i < len(source) else located[i][1]
        raise DecompositionFailed(
            f"text unit {i} differs from the source: source {_shown(ours)}, "
            f"document {_shown(theirs)}",
            at,
        )

    tables = tables_of(doc)
    if len(tables) != len(walk.grids):
        raise DecompositionFailed(
            f"the document has {len(tables)} tables where the source has {len(walk.grids)}"
        )
    forms = grid_forms(doc, image_only=IMAGE_ONLY_EQUATION)
    for table, expected in zip(tables, walk.grids, strict=True):
        got = forms[table.id]
        if got == expected:
            continue
        row = next(
            (
                r
                for r in range(max(len(got), len(expected)))
                if got[r : r + 1] != expected[r : r + 1]
            ),
            0,
        )
        raise DecompositionFailed(
            f"the grid of table {table.id} differs from the source at row {row}: source "
            f"{expected[row] if row < len(expected) else 'nothing'}, document "
            f"{got[row] if row < len(got) else 'nothing'}",
            table.id,
        )
