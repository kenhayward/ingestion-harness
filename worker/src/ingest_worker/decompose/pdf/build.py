"""The decomposed document from the pieces (spec sections 4.4, 4.5 and 4.9).

Headings open sections nested by their level; the blocks before the first heading are the
document's leading blocks. Ids follow the Word reader's scheme (`body.py`): a section's from its
parent and its whole heading text, a block's from its kind and ordinal in its section. A title
leaves out the typed number, whose chars outline.py dropped, and keeps only superscript and
subscript.

A paragraph Docling split at a line or a page break is joined again; list items in one Docling
group form a list, nested by their indentation, their bullets and numbers dropped. Tables are
built by tables.py, taking their captions and notes. The ledger is renamed from piece refs to
the ids the pieces became (a section's for a heading; the outermost list's for a list item),
and so are the flags of the earlier stages. A piece with no visible text gives its chars to the
block before it.

Pictures, formulas and footnotes are left out here and added in Task 9 (`_LATER`); their chars
stay owned by their pieces' refs until then.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace

from ingest_worker.decompose import in_document_order
from ingest_worker.decompose.ids import child_id, normalise_title, section_id
from ingest_worker.decompose.inline import merge_runs, plain_text
from ingest_worker.decompose.model import (
    Block,
    DecomposedDocument,
    Flag,
    Inline,
    ListBlock,
    ListItem,
    Paragraph,
    Property,
    Section,
    Table,
    Text,
)
from ingest_worker.decompose.pdf.crop import PageCropper
from ingest_worker.decompose.pdf.layout import BBox
from ingest_worker.decompose.pdf.pieces import DROPPED_PREFIX, Ledger, Line, Piece
from ingest_worker.decompose.pdf.tables import build_table, table_regions
from ingest_worker.decompose.pdf.textlayer import Char, PageText, TextLayer

#: A part that ends with one of these ends a sentence, and is not joined to the next.
_SENTENCE_END = re.compile(r"[.!?:;]\s*$")
#: Parts on one page join when the gap between them is at most this many line heights.
_JOIN_GAP = 1.5
#: A list item indented more than this many points past the one before it is nested.
_LIST_STEP = 6.0
#: An ordered list's marker.
_ORDERED = re.compile(r"^\(?(\d+|[a-z]|[ivx]+)[.)]")
#: A marker that is removed: bullet glyphs, or an ordered marker followed by a space. A dash
#: needs the space too, so "-5 °C" keeps its sign.
_MARKER = re.compile(r"^(?:[•●○▪■]+|[–-]+(?=\s|$)|\(?(?:\d+|[a-z]|[ivx]+)[.)](?=\s|$))")  # noqa: RUF001
#: The labels whose pieces are paragraphs that may continue one another.
_JOINABLE = frozenset({"text", "paragraph"})
#: The labels Task 9 builds (pictures, formulas, footnotes): left out of the document for now.
_LATER = frozenset({"picture", "formula", "footnote"})
#: The marks a heading's title keeps: the rest are the publishing theme's.
_HEADING_MARKS = frozenset({"superscript", "subscript"})

_ORPHAN = "Text the layout analysis missed"

#: The scope of the blocks before the first heading, as in the Word reader (`body.py`): `~` is
#: never in a title's slug, so no section can have this id.
_LEADING = "s~lead"


@dataclass
class Provenance:
    """Where each block came from: the pages of the chars it owns, and for a table the page
    and box of each of its parts."""

    pages: dict[str, set[int]] = field(default_factory=dict)
    regions: dict[str, list[tuple[int, BBox]]] = field(default_factory=dict)


# --- Builders --------------------------------------------------------------------------------


@dataclass
class _Para:
    """A paragraph: one piece, or several Docling split."""

    id: str
    pieces: list[Piece]

    def build(self) -> Paragraph:
        lines = [line for piece in self.pieces for line in piece.lines]
        return Paragraph(id=self.id, inlines=list(replace(self.pieces[0], lines=lines).inlines()))


@dataclass
class _List:
    """A list being assembled; an item holds its paragraph, then any lists nested in it."""

    id: str
    ordered: bool
    x0: float
    items: list[list[_Para | _List]] = field(default_factory=list)

    def build(self) -> ListBlock:
        return ListBlock(
            id=self.id,
            ordered=self.ordered,
            items=[ListItem(blocks=[b.build() for b in blocks]) for blocks in self.items],
        )


@dataclass
class _Scope:
    """A section being assembled, or the root holding the leading blocks."""

    id: str
    level: int = 0
    title: list[Inline] = field(default_factory=list)
    blocks: list[_Para | _List | Table] = field(default_factory=list)
    sections: list[_Scope] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)
    slugs: dict[str, int] = field(default_factory=dict)

    def take(self, kind: str) -> str:
        self.counts[kind] = self.counts.get(kind, 0) + 1
        return child_id(self.id, kind, self.counts[kind])

    def built_blocks(self) -> list[Block]:
        return [b if isinstance(b, Table) else b.build() for b in self.blocks]

    def build(self) -> Section:
        return Section(
            id=self.id,
            title=self.title,
            blocks=self.built_blocks(),
            sections=[s.build() for s in self.sections],
        )


# --- Pieces ----------------------------------------------------------------------------------


def _text_lines(piece: Piece) -> list[Line]:
    return [line for line in piece.lines if line.text]


def _has_text(piece: Piece) -> bool:
    return piece.table is not None or bool(_text_lines(piece))


def _overlaps(a: BBox, b: BBox) -> bool:
    return a[0] < b[2] and b[0] < a[2]


def _bounds(chars: tuple[Char, ...]) -> BBox:
    return (
        min(c.x0 for c in chars),
        min(c.y0 for c in chars),
        max(c.x1 for c in chars),
        max(c.y1 for c in chars),
    )


class _Builder:
    def __init__(self, pieces: list[Piece], text: TextLayer, ledger: Ledger) -> None:
        self.pieces = pieces
        self.ledger = ledger
        self.pages: dict[int, PageText] = {p.index: p for p in text.pages}
        self.root = _Scope(_LEADING)
        self.stack: list[_Scope] = []  # the open sections, outermost first
        self.scope = self.root
        self.lists: list[_List] = []  # the open lists, outermost first
        self.group: str | None = None  # the Docling group of the open list
        self.para: _Para | None = None  # the paragraph just placed, if nothing came after it
        self.joinable = False  # whether the next text piece may continue `para`
        self.owner: dict[str, str] = {}  # piece ref -> the id it became
        self.blank: dict[str, str] = {}  # blank piece ref -> the ref of the piece before it
        self.pending: list[str] = []  # blank pieces before any placed piece
        self.last_ref: str | None = None  # the piece placed last
        self.consumed: set[str] = set()  # pieces a table took as its caption or notes
        self.flags: list[Flag] = []
        self.regions: dict[str, list[tuple[int, BBox]]] = {}
        # the first and last piece with text on each page, for joins across a page break
        self.firsts: dict[int, str] = {}
        self.lasts: dict[int, str] = {}
        for piece in pieces:
            if _has_text(piece) and piece.label != "footnote":
                self.firsts.setdefault(piece.page, piece.ref)
                self.lasts[piece.page] = piece.ref

    # -- the flow --

    def run(self) -> None:
        for i, piece in enumerate(self.pieces):
            if piece.ref in self.consumed:
                continue
            if piece.picture is not None or piece.label in _LATER:
                self.later(piece)
            elif piece.table is not None:
                self.table(piece, i)
            elif not _has_text(piece):
                self.give_away(piece)
            elif piece.heading_level is not None:
                self.heading(piece)
            elif piece.label == "list_item":
                self.list_item(piece)
            else:
                self.paragraph(piece)

    def placed(self, piece: Piece, block_id: str) -> None:
        """`piece` became (part of) `block_id`; blank pieces waiting for a block take it too."""
        self.owner[piece.ref] = block_id
        for ref in self.pending:
            self.blank[ref] = piece.ref
        self.pending.clear()
        self.last_ref = piece.ref

    def give_away(self, piece: Piece) -> None:
        """A piece with no visible text: its chars go to the block before it, or after it when
        it comes first."""
        if self.last_ref is None:
            self.pending.append(piece.ref)
        else:
            self.blank[piece.ref] = self.last_ref

    def end_flow(self) -> None:
        self.end_list()
        self.para = None
        self.joinable = False

    def end_list(self) -> None:
        self.lists = []
        self.group = None

    def later(self, piece: Piece) -> None:
        """Task 9 builds pictures, formulas and footnotes. A picture or formula ends the flow
        (no join or list runs across it); a footnote, at the foot of its page, does not."""
        if piece.label != "footnote":
            self.end_flow()

    # -- headings --

    def heading(self, piece: Piece) -> None:
        self.end_flow()
        level = piece.heading_level
        assert level is not None
        while self.stack and self.stack[-1].level >= level:
            self.stack.pop()
        parent = self.stack[-1] if self.stack else self.root
        full = plain_text(list(piece.inlines()))
        slug = normalise_title(full)
        parent.slugs[slug] = parent.slugs.get(slug, 0) + 1
        sid = section_id(None if parent is self.root else parent.id, full, parent.slugs[slug])
        section = _Scope(sid, level=level, title=self.title(piece))
        parent.sections.append(section)
        self.stack.append(section)
        self.scope = section
        self.placed(piece, sid)
        # Only a jump of two or more levels below a parent heading is a skip.
        if parent is not self.root and level > parent.level + 1:
            self.flags.append(
                Flag(
                    code="heading_skipped_level",
                    severity="warning",
                    at=sid,
                    message=f"heading level {level} where level {parent.level + 1} was due",
                )
            )

    def title(self, piece: Piece) -> list[Inline]:
        """The heading's inlines without its dropped chars (the typed number), keeping only
        `_HEADING_MARKS`."""
        lines: list[Line] = []
        for line in piece.lines:
            entries = self.ledger.entries(line.page)
            chars = tuple(
                c
                for c in line.chars
                if not any(o.startswith(DROPPED_PREFIX) for o in entries.get(c.index, []))
            )
            if chars:
                lines.append(Line(line.page, chars, line.bbox))
        inlines = replace(piece, lines=lines).inlines()
        return merge_runs([Text(text=t.text, marks=t.marks & _HEADING_MARKS) for t in inlines])

    # -- paragraphs --

    def paragraph(self, piece: Piece) -> None:
        self.end_list()
        joinable = piece.label in _JOINABLE
        if self.para is not None and self.joinable and joinable and self.joins(piece):
            self.para.pieces.append(piece)
        else:
            self.para = _Para(self.scope.take("p"), [piece])
            self.scope.blocks.append(self.para)
        self.joinable = joinable
        self.placed(piece, self.para.id)
        if piece.orphan:
            self.flags.append(
                Flag(code="structure_inferred", severity="warning", at=piece.ref, message=_ORPHAN)
            )

    def joins(self, second: Piece) -> bool:
        """Whether `second` continues the paragraph just placed (spec section 4.5)."""
        assert self.para is not None
        first = self.para.pieces[-1]
        last, nxt = _text_lines(first)[-1], _text_lines(second)[0]
        if _SENTENCE_END.search(last.text) or not _overlaps(first.bbox, second.bbox):
            return False
        if first.page == second.page:
            height = last.bbox[3] - last.bbox[1]
            return nxt.bbox[1] - last.bbox[3] <= _JOIN_GAP * height
        return (
            second.page == first.page + 1
            and self.lasts.get(first.page) == first.ref
            and self.firsts.get(second.page) == second.ref
        )

    # -- lists --

    def list_item(self, piece: Piece) -> None:
        self.para = None
        self.joinable = False
        x0 = _text_lines(piece)[0].bbox[0]
        lines, ordered = self.strip_marker(piece)
        item = replace(piece, lines=lines)
        if not _has_text(item):
            self.give_away(piece)  # a marker alone: what is left is blank
            return
        if self.lists and piece.group != self.group:
            self.end_list()
        if not self.lists:
            outer = _List(self.scope.take("list"), ordered, x0)
            self.scope.blocks.append(outer)
            self.lists = [outer]
            self.group = piece.group
        else:
            while len(self.lists) > 1 and x0 < self.lists[-1].x0 - _LIST_STEP:
                self.lists.pop()
            parent = self.lists[-1]
            if x0 > parent.x0 + _LIST_STEP and parent.items:
                nested = _List(self.scope.take("list"), ordered, x0)
                parent.items[-1].append(nested)
                self.lists.append(nested)
        self.lists[-1].items.append([_Para(self.scope.take("p"), [item])])
        self.placed(piece, self.lists[0].id)

    def strip_marker(self, piece: Piece) -> tuple[list[Line], bool]:
        """The item's lines without its leading bullet or number, whose chars are dropped as
        `list-marker`, and whether that marker is an ordered list's."""
        lines = list(piece.lines)
        index = next(i for i, line in enumerate(lines) if line.text)
        first = lines[index]
        match = _MARKER.match(first.text)
        if match is None:
            return lines, False
        marker = match.group(0)
        for k in range(1, len(first.chars) + 1):
            if Line(first.page, first.chars[:k], first.bbox).text == marker:
                break
        else:
            return lines, False
        for c in first.chars[:k]:
            self.ledger.drop(first.page, c.index, "list-marker")
        rest = first.chars[k:]
        kept = [Line(first.page, rest, _bounds(rest))] if rest else []
        return [*lines[:index], *kept, *lines[index + 1 :]], bool(_ORDERED.match(marker))

    # -- tables --

    def table(self, piece: Piece, index: int) -> None:
        self.end_list()
        table_id = self.scope.take("table")
        # A caption above the table can only be the paragraph just placed.
        before = [self.para.pieces[-1]] if self.para is not None else []
        table, consumed, flags = build_table(
            piece,
            table_id,
            self.pieces[index + 1 :],
            before,
            self.ledger,
            self.pages[piece.page],
        )
        if before and before[0].ref in consumed:
            assert self.para is not None
            self.para.pieces.pop()
            if not self.para.pieces:
                # the caption paragraph keeps the ordinal it was given, unused, as in Word
                self.scope.blocks.remove(self.para)
        self.consumed |= consumed
        self.scope.blocks.append(table)
        self.flags.extend(flags)
        self.regions[table_id] = table_regions(piece)
        for ref in consumed:
            self.owner[ref] = table_id
        self.placed(piece, table_id)
        self.para = None
        self.joinable = False

    # -- the result --

    def finish(self) -> tuple[list[Block], list[Section], Provenance]:
        for ref, before in self.blank.items():
            self.owner[ref] = self.owner[before]
        for ref, block_id in self.owner.items():
            self.ledger.rename(ref, block_id)
        ids = set(self.owner.values())
        pages: dict[str, set[int]] = {}
        for number in self.pages:
            for owners in self.ledger.entries(number).values():
                for o in owners:
                    if o in ids:
                        pages.setdefault(o, set()).add(number)
        blocks = self.root.built_blocks()
        sections = [s.build() for s in self.root.sections]
        return blocks, sections, Provenance(pages, self.regions)

    def pointed(self, flags: list[Flag]) -> list[Flag]:
        """`flags` with each `at` that is a piece ref pointed at the id the piece became."""
        return [
            f.model_copy(update={"at": self.owner[f.at]})
            if f.at is not None and f.at in self.owner
            else f
            for f in flags
        ]


def build_document(
    pieces: list[Piece],
    *,
    text: TextLayer,
    ledger: Ledger,
    cropper: PageCropper,
    properties: list[Property],
    flags: list[Flag],
) -> tuple[DecomposedDocument, dict[str, bytes], Provenance]:
    """The document built from the pieces, the PNG bytes of its images by image id, and where
    each block came from. The ledger is renamed from piece refs to block ids, and the report
    holds `flags` (pointed at ids) and the flags raised here, in document order.

    `cropper` crops pictures and formulas, which Task 9 adds; no image is made yet.
    """
    builder = _Builder(pieces, text, ledger)
    builder.run()
    blocks, sections, provenance = builder.finish()
    doc = DecomposedDocument(
        blocks=blocks,
        sections=sections,
        images=[],
        equations=[],
        notes=[],
        properties=list(properties),
        report=[],
    )
    report = builder.pointed([*flags, *builder.flags])
    doc = doc.model_copy(update={"report": in_document_order(report, doc)})
    return doc, {}, provenance
