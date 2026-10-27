"""The decomposed document from the pieces (spec sections 4.4 to 4.9).

Headings open sections nested by their level; the blocks before the first heading are the
document's leading blocks. Ids follow the Word reader's scheme (`body.py`): a section's from its
parent and its whole heading text, a block's from its kind and ordinal in its section. A title
leaves out the typed number, whose chars outline.py dropped, and keeps only superscript and
subscript.

A paragraph Docling split at a line or a page break is joined again; list items in one Docling
group form a list, nested by their indentation, their bullets dropped, and their numbers too
when they count from the start (else they stay as text: a list continued from a page before).
Tables are built by tables.py, taking their captions and notes. The ledger is renamed from piece
refs to the ids the pieces became (a section's for a heading; the outermost list's for a list
item), and so are the flags of the earlier stages. A piece with no visible text gives its chars to the
block before it.

A picture is cropped from the page to an image: a figure when a caption is beside it (its number
dropped), else an image block, with the id kind `image` either way, as in the Word reader. The
text inside it is its alt text, owned by its block; a picture no image object covers is a
drawing, flagged. A formula is cropped to an image-only equation, its chars owned by its block.
A footnote whose leading marker is a superscript run on its page becomes a note, owning its
chars, and that run a note reference; both markers are dropped as `note-marker`, since the
reference's token stands for them in the text form. A footnote with no marker found stays a
paragraph, flagged, as does one that more than one run could be the marker of. A power
("m²", "10²") is never a marker. Link annotations wrap the text under them in paragraphs, list
items and notes; unmapped symbols are flagged at the block that owns them.
"""

from __future__ import annotations

import re
from collections import defaultdict
from dataclasses import dataclass, field, replace

from ingest_worker.decompose import in_document_order
from ingest_worker.decompose.ids import child_id, normalise_title, section_id
from ingest_worker.decompose.inline import merge_runs, plain_text
from ingest_worker.decompose.model import (
    Block,
    DecomposedDocument,
    Equation,
    EquationBlock,
    Figure,
    Flag,
    Image,
    ImageBlock,
    Inline,
    Link,
    ListBlock,
    ListItem,
    Note,
    NoteRef,
    Paragraph,
    Property,
    Section,
    Table,
    Text,
)
from ingest_worker.decompose.pdf.crop import PageCropper
from ingest_worker.decompose.pdf.layout import BBox
from ingest_worker.decompose.pdf.pieces import DROPPED_PREFIX, Ledger, Line, Piece
from ingest_worker.decompose.pdf.tables import (
    build_table,
    caption_inlines,
    find_caption,
    table_regions,
)
from ingest_worker.decompose.pdf.textlayer import Char, PageText, TextLayer

#: A part that ends with one of these ends a sentence, and is not joined to the next.
_SENTENCE_END = re.compile(r"[.!?:;]\s*$")
#: Parts on one page join when the gap between them is at most this many line heights.
_JOIN_GAP = 1.5
#: ... and the second starts at most this many points above the first's bottom.
_OVERLAP = 2.0
#: A list item indented more than this many points past the one before it is nested.
_LIST_STEP = 6.0
#: An ordered list's marker, its number or letter in group 1.
_ORDERED = re.compile(r"^\(?(\d+|[a-z]|[ivx]+)[.)]")
_ROMAN = {"i": 1, "v": 5, "x": 10}
#: A marker that is removed: bullet glyphs, or an ordered marker followed by a space. A dash
#: needs the space too, so "-5 °C" keeps its sign.
_MARKER = re.compile(r"^(?:[•●○▪■]+|[–-]+(?=\s|$)|\(?(?:\d+|[a-z]|[ivx]+)[.)](?=\s|$))")  # noqa: RUF001
#: The labels whose pieces are paragraphs that may continue one another.
_JOINABLE = frozenset({"text", "paragraph"})
#: The labels whose pieces' superscript runs can be footnote markers.
_MARKED = frozenset({"text", "paragraph", "list_item"})
#: A footnote's leading marker.
_FOOTNOTE_MARKER = re.compile(r"^(\d{1,2}|[a-z]|[*†‡§])\s")
#: A letter marker also needs a capital or a digit after it: "a total of 12" is no footnote.
_LETTER_NOTE = re.compile(r"^[a-z]\s+[A-Z\d]")
#: A `2` or `3` superscript right after one of these units ("m²", "kg/m²") is a power, not a
#: footnote marker.
_UNITS = frozenset(
    {"m", "cm", "mm", "km", "µm", "μm", "nm", "s", "ms", "g", "kg", "mg", "L", "mL", "ft", "in"}
)
_POWERS = frozenset({"2", "3"})
#: A word as a number (perhaps empty) and what follows it: "5m" is the unit "m".
_UNIT_WORD = re.compile(r"[\d.,]*(.+)")
#: The marks a heading's title keeps: the rest are the publishing theme's.
_HEADING_MARKS = frozenset({"superscript", "subscript"})
#: A picture is an image, not a drawing, when one image object covers this fraction of its box.
_IMAGE_COVER = 0.8
#: An image is centred when its centre is within this fraction of the page width of the page's.
_CENTRE = 0.05
_MM_PER_POINT = 25.4 / 72

_ORPHAN = "Text the layout analysis missed"
_NO_MARKER = "Footnote with no marker found"
_AMBIGUOUS = "Footnote marker ambiguous"

#: The scope of the blocks before the first heading, as in the Word reader (`body.py`): `~` is
#: never in a title's slug, so no section can have this id.
_LEADING = "s~lead"


@dataclass
class Provenance:
    """Where each block came from: the pages of the chars it owns (and a picture's or formula's
    own page), and for a table the page and box of each of its parts."""

    pages: dict[str, set[int]] = field(default_factory=dict)
    regions: dict[str, list[tuple[int, BBox]]] = field(default_factory=dict)


# --- Inlines ---------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Entry:
    """One run of a line, with the note its char marks and the link its char is under; `added`
    for a space with no char of its own."""

    run: Text
    note: str | None = None
    href: str | None = None
    added: bool = False


@dataclass
class _Anchors:
    """What chars become besides text: a footnote marker's chars (by page and char index) a
    note reference, and the chars under a link annotation that link's content."""

    links: dict[int, tuple[tuple[BBox, str], ...]]
    notes: dict[tuple[int, int], str] = field(default_factory=dict)

    def href(self, page: int, c: Char) -> str | None:
        x, y = (c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2
        for box, uri in self.links.get(page, ()):
            if box[0] <= x <= box[2] and box[1] <= y <= box[3]:
                return uri
        return None

    def inlines(self, lines: list[Line]) -> list[Inline]:
        """The lines joined with single spaces, as `Piece.inlines`, with note references and
        links; a space between two chars of one link is in it."""
        entries: list[_Entry] = []
        for line in lines:
            runs = line.char_runs()
            if entries and runs:
                entries.append(_Entry(Text(text=" "), added=True))
            for run, c in runs:
                if c is None:
                    entries.append(_Entry(run, added=True))
                else:
                    note = self.notes.get((line.page, c.index))
                    entries.append(_Entry(run, note, self.href(line.page, c)))
        for n in range(1, len(entries) - 1):
            if entries[n].added and entries[n - 1].href == entries[n + 1].href:
                entries[n] = replace(entries[n], href=entries[n - 1].href)
        out: list[Inline] = []
        group: list[Inline] = []
        for n, entry in enumerate(entries):
            if entry.note is None:
                group.append(entry.run)
            elif n == 0 or entries[n - 1].note != entry.note:
                group.append(NoteRef(note_id=entry.note))
            if n == len(entries) - 1 or entries[n + 1].href != entry.href:
                if entry.href is None:
                    out.extend(group)
                else:
                    out.append(Link(href=entry.href, inlines=merge_runs(group)))
                group = []
        return merge_runs(out)


# --- Builders --------------------------------------------------------------------------------


@dataclass
class _Para:
    """A paragraph: one piece, or several Docling split."""

    id: str
    pieces: list[Piece]

    def build(self, anchors: _Anchors) -> Paragraph:
        lines = [line for piece in self.pieces for line in piece.lines]
        return Paragraph(id=self.id, inlines=anchors.inlines(lines))


@dataclass(frozen=True)
class _Marker:
    """An ordered list item's marker, not dropped yet: its number or letter, and its chars."""

    value: str
    page: int
    chars: tuple[Char, ...]


@dataclass
class _List:
    """A list being assembled; an item holds its paragraph, then any lists nested in it.
    `marked` holds each item's paragraph, its piece as it was, and its ordered marker if any."""

    id: str
    ordered: bool
    x0: float
    items: list[list[_Para | _List]] = field(default_factory=list)
    marked: list[tuple[_Para, Piece, _Marker | None]] = field(default_factory=list)

    def build(self, anchors: _Anchors) -> ListBlock:
        return ListBlock(
            id=self.id,
            ordered=self.ordered,
            items=[ListItem(blocks=[b.build(anchors) for b in blocks]) for blocks in self.items],
        )


#: A block that is complete when it is placed.
_Built = Table | Figure | ImageBlock | EquationBlock


@dataclass
class _Scope:
    """A section being assembled, or the root holding the leading blocks."""

    id: str
    level: int = 0
    title: list[Inline] = field(default_factory=list)
    blocks: list[_Para | _List | _Built] = field(default_factory=list)
    sections: list[_Scope] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)
    slugs: dict[str, int] = field(default_factory=dict)

    def take(self, kind: str) -> str:
        self.counts[kind] = self.counts.get(kind, 0) + 1
        return child_id(self.id, kind, self.counts[kind])

    def built_blocks(self, anchors: _Anchors) -> list[Block]:
        return [b.build(anchors) if isinstance(b, _Para | _List) else b for b in self.blocks]

    def build(self, anchors: _Anchors) -> Section:
        return Section(
            id=self.id,
            title=self.title,
            blocks=self.built_blocks(anchors),
            sections=[s.build(anchors) for s in self.sections],
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


def _lead(line: Line, prefix: str) -> int | None:
    """How many of the line's chars make `prefix` of its text, or None when no count does."""
    for k in range(1, len(line.chars) + 1):
        if Line(line.page, line.chars[:k], line.bbox).text == prefix:
            return k
    return None


def _without_lead(line: Line, k: int) -> list[Line]:
    """The line without its first `k` chars: none, when nothing is left."""
    rest = line.chars[k:]
    return [Line(line.page, rest, _bounds(rest))] if rest else []


def _covered(box: BBox, by: BBox) -> float:
    """The fraction of `box` that `by` covers."""
    w = min(box[2], by[2]) - max(box[0], by[0])
    h = min(box[3], by[3]) - max(box[1], by[1])
    area = (box[2] - box[0]) * (box[3] - box[1])
    return w * h / area if w > 0 and h > 0 and area > 0 else 0.0


@dataclass(frozen=True)
class _MarkerRun:
    """A superscript run that may be a footnote's marker: where it is in reading order (piece
    index, run index), the piece it is in, its text and its chars."""

    position: tuple[int, int]
    ref: str
    text: str
    chars: tuple[Char, ...]


def _roman(text: str) -> int:
    values = [_ROMAN[c] for c in text]
    return sum(-v if n + 1 < len(values) and v < values[n + 1] else v for n, v in enumerate(values))


def _counts_from_the_start(values: list[str]) -> bool:
    """Whether ordered markers run 1, 2, 3 ... (or a, b, c ..., or i, ii, iii ...) from the
    first."""
    wanted = list(range(1, len(values) + 1))
    if all(v.isdigit() for v in values) and [int(v) for v in values] == wanted:
        return True
    if all(len(v) == 1 for v in values) and [ord(v) - ord("a") + 1 for v in values] == wanted:
        return True
    return all(set(v) <= set(_ROMAN) for v in values) and [_roman(v) for v in values] == wanted


def _is_unit(word: str) -> bool:
    match = _UNIT_WORD.fullmatch(word)
    return match is not None and match.group(1) in _UNITS


def _is_power(before: str, text: str) -> bool:
    """Whether a superscript run `text` right after the word `before` (no space between) is
    a power, never a footnote marker: after a digit, a closing bracket or a lone letter ("10²",
    "(a+b)²", "R²"), or a `2` or `3` after a unit, the last of a compound one ("kg/m²")."""
    if not before:
        return False
    if before[-1].isdigit() or before[-1] in ")]" or (len(before) == 1 and before.isalpha()):
        return True
    return text in _POWERS and _is_unit(before.rsplit("/", 1)[-1])


def _superscript_runs(piece: Piece) -> list[tuple[str, tuple[Char, ...]]]:
    """The text and chars of each run of superscript chars in the piece, in reading order;
    a power (`_is_power`) left out."""
    found: list[tuple[str, tuple[Char, ...]]] = []
    for line in piece.lines:
        current: list[Char] = []
        word = ""  # the text since the last space
        before = ""  # the word just before the current run
        for run, c in [*line.char_runs(), (Text(text=" "), None)]:
            if c is not None and "superscript" in run.marks:
                if not current:
                    before = word
                current.append(c)
                continue
            if current:
                text = "".join(x.text for x in current)
                if not _is_power(before, text):
                    found.append((text, tuple(current)))
                current = []
            word = "" if c is None or c.text.isspace() else word + c.text
    return found


def _footnote_marker(text: str) -> str | None:
    """The marker a footnote's first line starts with, if any (spec 4.8)."""
    match = _FOOTNOTE_MARKER.match(text)
    if match is None:
        return None
    marker = match.group(1)
    if marker.isalpha() and _LETTER_NOTE.match(text) is None:
        return None
    return marker


class _Builder:
    def __init__(
        self, pieces: list[Piece], text: TextLayer, ledger: Ledger, cropper: PageCropper
    ) -> None:
        self.pieces = pieces
        self.text = text
        self.ledger = ledger
        self.cropper = cropper
        self.pages: dict[int, PageText] = {p.index: p for p in text.pages}
        self.anchors = _Anchors({p.index: p.links for p in text.pages if p.links})
        self.root = _Scope(_LEADING)
        self.stack: list[_Scope] = []  # the open sections, outermost first
        self.scope = self.root
        self.lists: list[_List] = []  # the open lists, outermost first
        self.every_list: list[_List] = []  # every list made, for `settle_markers`
        self.group: str | None = None  # the Docling group of the open list
        self.para: _Para | None = None  # the paragraph just placed, if nothing came after it
        self.joinable = False  # whether the next text piece may continue `para`
        self.owner: dict[str, str] = {}  # piece ref -> the id it became
        self.blank: dict[str, str] = {}  # blank piece ref -> the ref of the piece before it
        self.pending: list[str] = []  # blank pieces before any placed piece
        self.last_ref: str | None = None  # the piece placed last
        self.consumed: set[str] = set()  # pieces a table or figure took as its caption or notes
        self.flags: list[Flag] = []
        self.regions: dict[str, list[tuple[int, BBox]]] = {}
        self.images: list[Image] = []
        self.image_bytes: dict[str, bytes] = {}
        self.equations: list[Equation] = []
        self.own_page: dict[str, int] = {}  # picture or formula block id -> its page
        self.markers: dict[str, _MarkerRun] = {}  # footnote ref -> the marker paired with it
        self.ambiguous: set[str] = set()  # footnotes more than one run could be the marker of
        self.notes: list[tuple[str, list[Line]]] = []  # each note's id and lines
        self.made: dict[str, tuple[str, Piece]] = {}  # footnote ref -> its note's id, its piece
        self.note_count = 0
        # the first and last piece with text on each page, for joins across a page break
        self.firsts: dict[int, str] = {}
        self.lasts: dict[int, str] = {}
        for piece in pieces:
            if _has_text(piece) and piece.label != "footnote":
                self.firsts.setdefault(piece.page, piece.ref)
                self.lasts[piece.page] = piece.ref

    # -- the flow --

    def run(self) -> None:
        self.match_footnotes()
        for i, piece in enumerate(self.pieces):
            if piece.ref in self.consumed:
                continue
            if piece.picture is not None:
                self.picture(piece, i)
            elif piece.label == "formula" and piece.table is None:
                self.formula(piece)
            elif piece.table is not None:
                self.table(piece, i)
            elif not _has_text(piece):
                self.give_away(piece)
            elif piece.label == "footnote":
                self.footnote(piece)
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

    def took_before(self, consumed: set[str]) -> None:
        """A caption above a table or picture can only be the paragraph just placed: when it
        was taken, it leaves that paragraph."""
        if self.para is not None and self.para.pieces[-1].ref in consumed:
            self.para.pieces.pop()
            if not self.para.pieces:
                # the caption paragraph keeps the ordinal it was given, unused, as in Word
                self.scope.blocks.remove(self.para)

    # -- headings --

    def heading(self, piece: Piece) -> None:
        level = piece.heading_level
        assert level is not None
        title = self.title(piece)
        if not plain_text(title).strip():
            # As in the Word reader: an empty heading (here, one of only its typed number) is
            # left out and what follows stays where it is; its other chars go to the block
            # before.
            self.flags.append(
                Flag(
                    code="heading_empty",
                    severity="info",
                    at=self.scope.id,
                    message="an empty heading was left out",
                )
            )
            self.give_away(piece)
            return
        self.end_flow()
        while self.stack and self.stack[-1].level >= level:
            self.stack.pop()
        parent = self.stack[-1] if self.stack else self.root
        full = plain_text(list(piece.inlines()))
        slug = normalise_title(full)
        parent.slugs[slug] = parent.slugs.get(slug, 0) + 1
        sid = section_id(None if parent is self.root else parent.id, full, parent.slugs[slug])
        section = _Scope(sid, level=level, title=title)
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
        if first.recognised != second.recognised:  # spec 5: not across a scan's edge
            return False
        last, nxt = _text_lines(first)[-1], _text_lines(second)[0]
        if _SENTENCE_END.search(last.text) or not _overlaps(first.bbox, second.bbox):
            return False
        if first.page == second.page:
            height = last.bbox[3] - last.bbox[1]
            gap = nxt.bbox[1] - last.bbox[3]
            # a part above the one before is not its continuation: joining would reorder text
            return -_OVERLAP <= gap <= _JOIN_GAP * height
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
        lines, ordered, marker = self.strip_marker(piece)
        item = replace(piece, lines=lines)
        if not _has_text(item):
            if marker is not None:
                self.drop_marker(marker)
            self.give_away(piece)  # a marker alone: what is left is blank
            return
        if self.lists and piece.group != self.group:
            self.end_list()
        if not self.lists:
            outer = _List(self.scope.take("list"), ordered, x0)
            self.scope.blocks.append(outer)
            self.every_list.append(outer)
            self.lists = [outer]
            self.group = piece.group
        else:
            while len(self.lists) > 1 and x0 < self.lists[-1].x0 - _LIST_STEP:
                self.lists.pop()
            parent = self.lists[-1]
            if x0 > parent.x0 + _LIST_STEP and parent.items:
                nested = _List(self.scope.take("list"), ordered, x0)
                parent.items[-1].append(nested)
                self.every_list.append(nested)
                self.lists.append(nested)
        para = _Para(self.scope.take("p"), [item])
        self.lists[-1].items.append([para])
        self.lists[-1].marked.append((para, piece, marker))
        self.placed(piece, self.lists[0].id)

    def strip_marker(self, piece: Piece) -> tuple[list[Line], bool, _Marker | None]:
        """The item's lines without its leading bullet or number, whether that marker is an
        ordered list's, and the ordered marker. A bullet's chars are dropped as `list-marker`
        here; an ordered marker's only once its list is known to count from the start
        (`settle_markers`)."""
        lines = list(piece.lines)
        index = next(i for i, line in enumerate(lines) if line.text)
        first = lines[index]
        match = _MARKER.match(first.text)
        k = _lead(first, match.group(0)) if match is not None else None
        if match is None or k is None:
            return lines, False, None
        kept = [*lines[:index], *_without_lead(first, k), *lines[index + 1 :]]
        ordered = _ORDERED.match(match.group(0))
        if ordered is not None:
            return kept, True, _Marker(ordered.group(1), first.page, first.chars[:k])
        for c in first.chars[:k]:
            self.ledger.drop(first.page, c.index, "list-marker")
        return kept, False, None

    def drop_marker(self, marker: _Marker) -> None:
        for c in marker.chars:
            self.ledger.drop(marker.page, c.index, "list-marker")

    def settle_markers(self) -> None:
        """Each list's ordered markers are dropped when every item has one and they count from
        the start (1, 2, 3 ...; a, b, c ...; i, ii, iii ...): the list's numbering stands for
        them. Otherwise (a list continued from a page before, say) every marker stays as text
        in its item, owned by the list."""
        for lst in self.every_list:
            markers = [m for _, _, m in lst.marked]
            if markers and all(m is not None for m in markers):
                values = [m.value for m in markers if m is not None]
                if _counts_from_the_start(values):
                    for m in markers:
                        assert m is not None
                        self.drop_marker(m)
                    continue
            for para, piece, marker in lst.marked:
                if marker is not None:
                    para.pieces = [piece]

    # -- tables --

    def table(self, piece: Piece, index: int) -> None:
        self.end_list()
        table_id = self.scope.take("table")
        before = [self.para.pieces[-1]] if self.para is not None else []
        table, consumed, flags = build_table(
            piece,
            table_id,
            self.pieces[index + 1 :],
            before,
            self.ledger,
            self.pages[piece.page],
        )
        self.took_before(consumed)
        self.unpair(consumed)
        self.consumed |= consumed
        self.scope.blocks.append(table)
        self.flags.extend(flags)
        self.regions[table_id] = table_regions(piece)
        for ref in consumed:
            self.owner[ref] = table_id
        self.placed(piece, table_id)
        self.para = None
        self.joinable = False

    # -- pictures and formulas --

    def crop(self, piece: Piece, image_id: str, alt: str | None) -> Image:
        """The piece's box cropped from its page as image `image_id`, recorded with its bytes."""
        page = self.pages[piece.page]
        x0, y0, x1, y1 = piece.bbox
        centred = abs((x0 + x1) / 2 - page.width / 2) <= _CENTRE * page.width
        image = Image(
            id=image_id,
            content_type="image/png",
            width_mm=round((x1 - x0) * _MM_PER_POINT, 2),
            height_mm=round((y1 - y0) * _MM_PER_POINT, 2),
            align="center" if centred else "left",
            alt=alt,
            origin="cropped",
        )
        self.images.append(image)
        self.image_bytes[image_id] = self.cropper.crop(piece.page, piece.bbox)
        return image

    def picture(self, piece: Piece, index: int) -> None:
        """A figure when a caption is beside the picture, else an image block (spec 4.7)."""
        self.end_list()
        block_id = self.scope.take("image")
        before = [self.para.pieces[-1]] if self.para is not None else []
        caption = find_caption(piece, before, self.pieces[index + 1 :])
        alt = plain_text(list(piece.inlines())) or None
        image = self.crop(piece, child_id(block_id, "img", 1), alt)
        page = self.pages[piece.page]
        if not any(_covered(piece.bbox, box) >= _IMAGE_COVER for box in page.images):
            self.flags.append(
                Flag(
                    code="drawing_rendered",
                    severity="warning",
                    at=block_id,
                    message=f"drawing rendered to image {image.id}",
                )
            )
        block: Figure | ImageBlock
        if caption is None:
            block = ImageBlock(id=block_id, image_id=image.id)
        else:
            assert caption.ref is not None
            self.took_before({caption.ref})
            self.unpair({caption.ref})
            self.consumed.add(caption.ref)
            self.owner[caption.ref] = block_id
            inlines, numbered = caption_inlines(caption, self.ledger)
            block = Figure(
                id=block_id,
                image_id=image.id,
                numbered=numbered,
                caption=inlines,
                caption_position=caption.position,
            )
        self.scope.blocks.append(block)
        self.own_page[block_id] = piece.page
        self.placed(piece, block_id)
        self.para = None
        self.joinable = False

    def formula(self, piece: Piece) -> None:
        """An equation kept as the image of its box (spec 4.7); its chars are the block's. A
        scanned page's display equation has its LaTeX too (spec 15.3), and is not flagged."""
        self.end_flow()
        block_id = self.scope.take("equation")
        equation_id = child_id(block_id, "eq", 1)
        image = self.crop(piece, child_id(equation_id, "img", 1), None)
        self.equations.append(Equation(id=equation_id, latex=piece.latex, image_id=image.id))
        if piece.latex is None:
            self.flags.append(
                Flag(
                    code="equation_image_only",
                    severity="warning",
                    at=block_id,
                    message=f"equation {equation_id} kept as an image only",
                )
            )
        self.scope.blocks.append(EquationBlock(id=block_id, equation_id=equation_id))
        self.own_page[block_id] = piece.page
        self.placed(piece, block_id)

    # -- footnotes --

    def match_footnotes(self) -> None:
        """Pairs each footnote that starts with a marker with a superscript run of that text
        on its page, in a paragraph or list item (spec 4.8). A page's footnotes take markers in
        increasing reading order: each looks at the unpaired runs before it and after the
        marker the footnote before it took. It takes the one run of its text there; when more
        than one could be its marker, it takes none and is left `ambiguous` rather than paired
        by a guess. Only the pairing is recorded here: the note and its reference are made
        when the footnote is placed (`footnote`)."""
        runs: dict[int, list[_MarkerRun]] = defaultdict(list)
        for i, piece in enumerate(self.pieces):
            if (
                piece.label in _MARKED
                and piece.table is None
                and piece.picture is None
                and piece.heading_level is None
            ):
                for n, (text, chars) in enumerate(_superscript_runs(piece)):
                    runs[piece.page].append(_MarkerRun((i, n), piece.ref, text, chars))
        last: dict[int, tuple[int, int]] = {}  # the marker paired last on each page
        for i, piece in enumerate(self.pieces):
            lines = _text_lines(piece)
            if piece.label != "footnote" or piece.table is not None or not lines:
                continue
            marker = _footnote_marker(lines[0].text)
            after = last.get(piece.page, (-1, -1))
            candidates = [
                r
                for r in runs[piece.page]
                if r.text == marker and after < r.position and r.position[0] < i
            ]
            if not candidates:
                continue
            if len(candidates) > 1:
                self.ambiguous.add(piece.ref)
                continue
            [hit] = candidates
            runs[piece.page].remove(hit)
            last[piece.page] = hit.position
            self.markers[piece.ref] = hit

    def footnote(self, piece: Piece) -> None:
        """A footnote paired with a marker is a note, without its leading marker; the marker
        becomes its reference. Both markers are dropped as `note-marker`. A footnote with no
        marker, an ambiguous one, or one whose piece a table or figure took as its caption
        (before or after this, `unpair`) stays a paragraph where it is, flagged. Neither ends the flow: a paragraph can continue on the
        next page after the footnotes of this one."""
        marker = self.markers.get(piece.ref)
        if marker is None or marker.ref in self.consumed:
            self.unpaired(piece)
            return
        self.note_count += 1
        note_id = f"fn-{self.note_count}"
        for c in marker.chars:
            self.anchors.notes[(piece.page, c.index)] = note_id
            self.ledger.drop(piece.page, c.index, "note-marker")
        lines = list(piece.lines)
        index = next(i for i, line in enumerate(lines) if line.text)
        first = lines[index]
        k = _lead(first, marker.text)
        assert k is not None
        for c in first.chars[:k]:
            self.ledger.drop(first.page, c.index, "note-marker")
        self.notes.append(
            (note_id, [*lines[:index], *_without_lead(first, k), *lines[index + 1 :]])
        )
        self.made[piece.ref] = (note_id, piece)
        self.owner[piece.ref] = note_id

    def unpaired(self, piece: Piece, *, place: bool = True) -> None:
        """A footnote with no marker (or an ambiguous one) stays a paragraph, flagged."""
        para = _Para(self.scope.take("p"), [piece])
        self.scope.blocks.append(para)
        if place:
            self.placed(piece, para.id)
        else:
            self.owner[piece.ref] = para.id
        message = _AMBIGUOUS if piece.ref in self.ambiguous else _NO_MARKER
        self.flags.append(
            Flag(code="structure_inferred", severity="warning", at=piece.ref, message=message)
        )

    def unpair(self, consumed: set[str]) -> None:
        """A note whose marker is in a piece a table or figure has just taken as its caption,
        after the note was made, is undone: the marker is the caption's text again (its chars
        owned by the caption's piece, unless the table took them already), and the footnote
        is a paragraph here, flagged as one with no marker found."""
        for ref, (note_id, piece) in list(self.made.items()):
            marker = self.markers[ref]
            if marker.ref not in consumed:
                continue
            del self.made[ref]
            self.notes = [n for n in self.notes if n[0] != note_id]
            for c in marker.chars:
                self.anchors.notes.pop((piece.page, c.index), None)
                if self.ledger.entries(piece.page).get(c.index) == [DROPPED_PREFIX + "note-marker"]:
                    self.ledger.reassign(piece.page, c.index, marker.ref)
            for line in piece.lines:
                for c in line.chars:
                    if self.ledger.entries(line.page).get(c.index) == [
                        DROPPED_PREFIX + "note-marker"
                    ]:
                        self.ledger.reassign(line.page, c.index, piece.ref)
            self.unpaired(piece, place=False)

    # -- unmapped symbols --

    def symbol_flags(self) -> list[Flag]:
        """A `symbol_unmapped` flag for each unmapped char owned by a block or note, at it."""
        queues: dict[tuple[int, str, str], list[Char]] = defaultdict(list)
        for page_text in self.text.pages:
            for c in page_text.chars:
                queues[(page_text.index, c.font, c.text)].append(c)
        flags: list[Flag] = []
        for page, font, char in self.text.unmapped_symbols:
            queue = queues[(page, font, char)]
            if not queue:
                continue
            c = queue.pop(0)
            owners = [
                o
                for o in self.ledger.entries(page).get(c.index, [])
                if not o.startswith(DROPPED_PREFIX)
            ]
            if owners:
                flags.append(
                    Flag(
                        code="symbol_unmapped",
                        severity="warning",
                        at=owners[0],
                        message=f"no mapping for code {ord(char):04X} in font {font or 'unknown'}",
                    )
                )
        return flags

    # -- the result --

    def finish(self) -> tuple[list[Block], list[Section], list[Note], Provenance]:
        self.settle_markers()
        for ref, before in self.blank.items():
            self.owner[ref] = self.owner[before]
        self.ledger.rename_all(self.owner)
        ids = set(self.owner.values())
        pages: dict[str, set[int]] = {}
        for number in self.pages:
            for owners in self.ledger.entries(number).values():
                for o in owners:
                    if o in ids:
                        pages.setdefault(o, set()).add(number)
        for block_id, number in self.own_page.items():
            pages.setdefault(block_id, set()).add(number)
        blocks = self.root.built_blocks(self.anchors)
        sections = [s.build(self.anchors) for s in self.root.sections]
        notes = [
            Note(
                id=note_id,
                blocks=[
                    Paragraph(id=child_id(note_id, "p", 1), inlines=self.anchors.inlines(lines))
                ],
            )
            for note_id, lines in self.notes
        ]
        self.flags.extend(self.symbol_flags())
        return blocks, sections, notes, Provenance(pages, self.regions)

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
    each block came from. The ledger is renamed from piece refs to block and note ids, and the
    report holds `flags` (pointed at ids) and the flags raised here, in document order.

    `cropper` crops pictures and formulas from their pages.
    """
    builder = _Builder(pieces, text, ledger, cropper)
    builder.run()
    blocks, sections, notes, provenance = builder.finish()
    doc = DecomposedDocument(
        blocks=blocks,
        sections=sections,
        images=builder.images,
        equations=builder.equations,
        notes=notes,
        properties=list(properties),
        report=[],
    )
    report = builder.pointed([*flags, *builder.flags])
    doc = doc.model_copy(update={"report": in_document_order(report, doc)})
    return doc, builder.image_bytes, provenance


# --- Properties ------------------------------------------------------------------------------

#: The information dictionary's keys, under the names the Word reader's core properties use
#: (`properties._CORE`), in that order.
_INFO = (
    ("Title", "title"),
    ("Subject", "subject"),
    ("Author", "author"),
    ("Keywords", "keywords"),
    ("CreationDate", "created"),
    ("ModDate", "modified"),
)
_INFO_DATES = frozenset({"CreationDate", "ModDate"})
#: A PDF date: `D:YYYYMMDDHHmmSS` with everything after the year optional, then `Z` or an
#: offset `+HH'mm'`.
_PDF_DATE = re.compile(
    r"^D?:?(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?\s*(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?\s*$"
)


def _iso_date(value: str) -> str:
    """A PDF date in ISO 8601 (as Word's core dates are), or the value as it is when it does
    not read as one."""
    match = _PDF_DATE.match(value)
    if match is None:
        return value
    year, month, day, hour, minute, second, zulu, sign, off_h, off_m = match.groups()
    out = year + "".join(f"-{p}" for p in (month, day) if p)
    if day and hour:
        out += f"T{hour}:{minute or '00'}:{second or '00'}"
        if zulu:
            out += "Z"
        elif sign:
            out += f"{sign}{off_h}:{off_m or '00'}"
    return out


def pdf_properties(data: bytes) -> list[Property]:
    """The information dictionary's title, subject, author, keywords and dates, as
    `pdf-info` properties; empty ones left out."""
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(data)
    try:
        info = doc.get_metadata_dict()
    finally:
        doc.close()
    found: list[Property] = []
    for key, name in _INFO:
        value = (info.get(key) or "").strip()
        if key in _INFO_DATES:
            value = _iso_date(value)
        if value:
            found.append(Property(name=name, value=value, origin="pdf-info"))
    return found
