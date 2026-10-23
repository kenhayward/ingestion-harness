"""Fidelity checks: the decomposed document against an independent walk of its source (§7).

Content must never be silently changed, lost or moved. `check` compares three things and
refuses the document, naming the place, on the first difference:

- **References.** Every note reference, cross-reference, image and equation the document
  mentions exists in it, and every equation's image does.
- **Text.** `source_text_units` walks the source's OOXML itself, in the order and with the units
  of `forms.text_form`, and the two must be equal. The walk reads paragraphs, runs and fields
  on its own (its own field stack, so an unbalanced or unterminated field shows up as a
  difference, never as silent loss); it never calls the decomposer's paragraph, body or table
  readers. It applies only the documented drops and conversions: tracked changes accepted;
  tables of contents and lists of tables and figures, hidden text, comments, headers and
  footers, deleted text dropped; caption number prefixes (and the `SEQ` result in them)
  removed; note rows and notes tables as `marker: text`; symbols to Unicode, tabs to spaces; a
  drawing's text at its place as its image's alt text; equations and cross-references (fields,
  internal hyperlinks and typed references) as the tokens of the text form, resolved from the
  same bookmarks and caption numbers. Pure readers are shared: styles, hidden-text resolution,
  the symbol tables, the table grid and which rows are a caption or notes, and a drawing's
  text.
- **Table grids.** For each table, the grid `tables.source_grid` resolves from the source (with
  its caption and note rows set aside), with each cell's text as the source walk reads it,
  must equal the table's grid form. This catches a wrong merge even when the text agrees.

`check` adds no flags: it returns None or raises `DecompositionFailed`.
"""

from __future__ import annotations

import copy
import re
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from xml.etree.ElementTree import Element

from ingest_worker.symbol_fonts import FIRST, LAST, TABLES, Family, font_family

from .equations import O_MATH, O_MATH_PARA, omml_to_mathml
from .forms import (
    equation_token,
    grid_forms,
    join_units,
    located_text_form,
    normalise,
    note_unit,
    tables_of,
    xref_token,
)
from .inline import InlineContext, R, W
from .media import MediaContext, _choose, _doc_pr_alt, is_media
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
from .package import DecompositionFailed, Package, Rel
from .references import TYPED_REFERENCE
from .render import RenderFragment
from .styles import Styles
from .tables import (
    CAPTION_PREFIX,
    NOTE_PREFIX,
    _cells,
    _gaps,
    _note_markers,
    _rows,
    _span,
    _unwrapped,
    notes_table,
    source_grid,
    structural_rows,
)

__all__ = ["IMAGE_ONLY_EQUATION", "DecompositionFailed", "check", "source_text_units"]

#: The token of an equation that has no MathML, on the source side, which cannot know the id of
#: the image it was kept as; the check compares the document's image-only equations by it.
IMAGE_ONLY_EQUATION = equation_token("image")

_MAIN = "word/document.xml"
_REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
_MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
_ALTERNATE = f"{_MC}AlternateContent"
_WP = "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}"
#: The title the decomposer gives an empty heading.
_EMPTY_TITLE = "[]"
_MAX_SHOWN = 120
_MAX_DIGITS = 9
_MARKS = ("bold", "italic", "underline", "superscript", "subscript")
_REPLACEMENT = "\ufffd"
_LINK_SCHEMES = ("http://", "https://", "mailto:", "ftp://")
_REFERENCE_FIELDS = {"REF", "PAGEREF", "NOTEREF"}
_VALUED_SWITCHES = {r"\l", r"\o", r"\t", r"\*", r"\#", r"\@"}
_TOKEN = re.compile(r'"([^"]*)"|(\S+)')
_SEPARATOR = r"\s*[:.\-–—]?\s*"  # noqa: RUF001 - en and em dashes separate a caption number

_ACCEPTED = {f"{W}ins", f"{W}moveTo"}
_REJECTED = {f"{W}del", f"{W}moveFrom"}
#: Properties and markers that hold no content of their own.
_NO_CONTENT = {
    f"{W}{name}"
    for name in (
        "pPr",
        "rPr",
        "sectPr",
        "tblPr",
        "tblGrid",
        "trPr",
        "tcPr",
        "sdtPr",
        "sdtEndPr",
        "customXmlPr",
        "smartTagPr",
        "bookmarkStart",
        "bookmarkEnd",
        "delText",
        "delInstrText",
    )
}


# --- Pieces of a paragraph -------------------------------------------------------------------


@dataclass(frozen=True)
class _T:
    """Text, with the marks it has (they bound where a typed reference can be found)."""

    text: str
    marks: frozenset[str]


@dataclass(frozen=True)
class _Br:
    """A line break."""


@dataclass(frozen=True)
class _Tok:
    """An image's alt text, or an equation's token."""

    value: str


@dataclass(frozen=True)
class _Ref:
    """A cross-reference to a bookmark, and the text it showed."""

    name: str
    text: str


@dataclass(frozen=True)
class _Link:
    """An external link; its content counts as text."""

    pieces: tuple[_Piece, ...]


@dataclass(frozen=True)
class _Note:
    """A footnote or endnote reference."""


_Piece = _T | _Br | _Tok | _Ref | _Link | _Note
_Wrap = Callable[[list[_Piece]], list[_Piece]]


@dataclass(frozen=True)
class _Obj:
    """A picture, drawing or equation met in a paragraph, as the piece it reads as."""

    piece: _Tok
    media: bool
    display: bool = False


def _leading_text(pieces: Sequence[_Piece]) -> str:
    parts: list[str] = []
    for piece in pieces:
        if not isinstance(piece, _T):
            break
        parts.append(piece.text)
    return "".join(parts)


def _strip_leading(pieces: Sequence[_Piece], count: int) -> list[_Piece]:
    """`pieces` without the first `count` characters of their leading text, and the line breaks
    that leaves at the start."""
    rest = list(pieces)
    while count > 0 and rest and isinstance(first := rest[0], _T):
        if len(first.text) > count:
            rest[0] = _T(first.text[count:], first.marks)
            break
        count -= len(first.text)
        rest.pop(0)
    while rest and isinstance(rest[0], _Br):
        rest.pop(0)
    return rest


# --- Fields ----------------------------------------------------------------------------------


@dataclass
class _Field:
    instruction: str = ""
    in_result: bool = False
    result: str = ""
    opener: _Para | None = field(default=None, repr=False)
    mark: int = 0

    @property
    def kind(self) -> str:
        words = self.instruction.split()
        return words[0].upper() if words else ""

    @property
    def argument(self) -> str:
        words = self.instruction.split()
        return words[1] if len(words) > 1 else ""

    @property
    def tokens(self) -> list[str]:
        return [
            m.group(1) if m.group(1) is not None else m.group(2)
            for m in _TOKEN.finditer(self.instruction)
        ]

    def wrap(self) -> _Wrap | None:
        """A cross-reference field (or a `HYPERLINK` to a bookmark) wraps its result as a
        cross-reference; a `HYPERLINK` to an allowed address as a link."""
        tokens = self.tokens
        if self.kind in _REFERENCE_FIELDS:
            name = next((t for t in tokens[1:] if not t.startswith("\\")), None)
            return _xref(name) if name else None
        if self.kind != "HYPERLINK":
            return None
        address: str | None = None
        anchor: str | None = None
        rest = iter(tokens[1:])
        for token in rest:
            if token.lower() == r"\l":
                anchor = next(rest, None)
            elif token.lower() in _VALUED_SWITCHES:
                next(rest, None)
            elif not token.startswith("\\") and address is None:
                address = token
        return _target(address, anchor)


def _xref(name: str) -> _Wrap:
    def wrap(content: list[_Piece]) -> list[_Piece]:
        if not all(isinstance(p, _T | _Br) for p in content):
            return content
        text = "".join(p.text if isinstance(p, _T) else "\n" for p in content)
        return [_Ref(name, text)] if text.strip() else content

    return wrap


def _link(content: list[_Piece]) -> list[_Piece]:
    return [_Link(tuple(content))] if content else content


def _target(address: str | None, anchor: str | None) -> _Wrap | None:
    if address:
        return _link if address.lower().startswith(_LINK_SCHEMES) else None
    return _xref(anchor) if anchor else None


# --- Captions and notes ----------------------------------------------------------------------


@dataclass(frozen=True)
class _Caption:
    pieces: list[_Piece]
    kind: str | None
    numbered: bool


def _label(word: str) -> str | None:
    folded = word.casefold()
    return folded if folded in ("table", "figure") else None


def _caption(pieces: list[_Piece], fields: Sequence[_Field]) -> _Caption:
    """A caption without its number prefix: `Table 13:`, or the `SEQ` field's result with at
    most one word before it."""
    lead = _leading_text(pieces)
    if match := CAPTION_PREFIX.match(lead):
        return _Caption(_strip_leading(pieces, match.end()), _label(match.group(1)), True)
    seq = next((f for f in fields if f.kind == "SEQ"), None)
    if seq is None:
        return _Caption(pieces, None, False)
    result = seq.result.strip()
    kept = pieces
    if result:
        prefix = re.compile(rf"^\s*(?:[^\W\d_]+\.?\s*)?{re.escape(result)}{_SEPARATOR}")
        if match := prefix.match(lead):
            kept = _strip_leading(pieces, match.end())
    return _Caption(kept, _label(seq.argument), True)


_Notes = list[tuple[str, list[_Piece]]]


def _notes(paragraphs: Sequence[list[_Piece]], markers: Sequence[str]) -> _Notes:
    """One note per paragraph that starts with a marker; one that doesn't continues the note
    before it, or is a note under the first marker."""
    notes: _Notes = []
    for pieces in paragraphs:
        if not pieces:
            continue
        match = NOTE_PREFIX.match(_leading_text(pieces))
        if match is not None:
            notes.append((match.group(1), _strip_leading(pieces, match.end())))
        elif notes:
            marker, before = notes[-1]
            notes[-1] = (marker, [*before, _Br(), *pieces])
        else:
            notes.append((markers[0] if markers else "", pieces))
    return notes


# --- Source blocks ---------------------------------------------------------------------------


@dataclass
class _SPara:
    pieces: list[_Piece]
    caption: _Caption | None  # set when it can be a caption
    in_list: bool


@dataclass
class _SImage:
    alt: str
    in_list: bool
    caption: _Caption | None = None


@dataclass
class _SEquation:
    token: str


@dataclass
class _STable:
    tbl: Element
    own_caption: _Caption | None
    #: Per grid origin (in grid coordinates, caption and note rows set aside), the blocks of
    #: the cells it covers, in document order.
    cells: dict[tuple[int, int], list[_SBlock]]
    #: The source grid's rows, each slot the origin it belongs to (None: an origin outside the
    #: grid's rows).
    origins: list[list[tuple[int, int] | None]]
    notes: _Notes
    attached: _Caption | None = None

    @property
    def has_caption(self) -> bool:
        own = self.own_caption
        return own is not None and (bool(own.pieces) or own.numbered)

    def as_notes(self) -> _Notes | None:
        """This one-cell table's notes, if its cell holds only paragraphs."""
        blocks = next(iter(self.cells.values()), [])
        if not all(isinstance(b, _SPara) and not b.in_list for b in blocks):
            return None
        cell = _cells(_rows(self.tbl)[0])[0]
        paragraphs = [b.pieces for b in blocks if isinstance(b, _SPara)]
        return _notes(paragraphs, _note_markers(cell) or [])


_SBlock = _SPara | _SImage | _SEquation | _STable


# --- Paragraph reading -----------------------------------------------------------------------


class _Para:
    """One paragraph of the source, read run by run."""

    def __init__(self, walk: _Walk, p: Element) -> None:
        self.source = walk
        style = p.find(f"{W}pPr/{W}pStyle")
        self.style = style.get(f"{W}val") if style is not None else None
        self.items: list[_Piece | _Obj] = []
        self.spans: list[tuple[int, int, _Wrap]] = []
        self.closed: list[_Field] = []
        self.walk(p)

    @property
    def fields(self) -> list[_Field]:
        return self.source.fields

    @property
    def suppressed(self) -> bool:
        return any(not f.in_result or f.kind == "TOC" for f in self.fields)

    # -- flow --

    def walk(self, parent: Element) -> None:
        for child in parent:
            tag = child.tag
            if tag == f"{W}r":
                self.run(child)
            elif tag in _ACCEPTED:
                self.walk(child)
            elif tag in _REJECTED:
                self.deleted(child)
            elif tag == f"{W}hyperlink":
                start = len(self.items)
                self.walk(child)
                wrap = self.hyperlink(child)
                if wrap is not None and not self.suppressed:
                    self.spans.append((start, len(self.items), wrap))
            elif tag == f"{W}fldSimple":
                self.fields.append(
                    _Field(child.get(f"{W}instr", ""), True, opener=self, mark=len(self.items))
                )
                self.walk(child)
                self.close_field()
            elif tag == O_MATH:
                if not self.suppressed:
                    self.items.append(_Obj(_Tok(self.source.equation(child)), media=False))
            elif tag == O_MATH_PARA:
                if not self.suppressed:
                    for o in child.iter(O_MATH):
                        token = _Tok(self.source.equation(o))
                        self.items.append(_Obj(token, media=False, display=True))
            elif tag in _NO_CONTENT:
                continue
            elif tag == _ALTERNATE:
                self.walk(_first_choice(child))
            else:  # smart tags, content controls, custom XML and anything unknown
                self.walk(child)

    def deleted(self, el: Element) -> None:
        """Deleted content gives no text, but its fields keep the stack balanced."""
        for node in el.iter():
            if node.tag == f"{W}fldChar":
                self.field_char(node)
            elif node.tag == f"{W}delInstrText" and self.fields and not self.fields[-1].in_result:
                self.fields[-1].instruction += node.text or ""

    def hyperlink(self, el: Element) -> _Wrap | None:
        rel_id = el.get(f"{R}id")
        rel = self.source.rels().get(rel_id) if rel_id else None
        address = rel.target if rel is not None and rel.external else None
        if rel_id and address is None:
            return None
        return _target(address, el.get(f"{W}anchor"))

    # -- runs --

    def run(self, run: Element) -> None:
        rpr = run.find(f"{W}rPr")
        char_style = rpr.find(f"{W}rStyle") if rpr is not None else None
        props = self.source.ctx.styles.resolve(
            self.style, char_style.get(f"{W}val") if char_style is not None else None, rpr
        )
        marks = frozenset(m for m in _MARKS if props[m])
        visible = not props["hidden"]
        family = _run_family(rpr)
        for child in run:
            tag = child.tag
            if tag == f"{W}fldChar":
                self.field_char(child)
            elif tag == f"{W}instrText":
                if self.fields and not self.fields[-1].in_result:
                    self.fields[-1].instruction += child.text or ""
            elif tag in _NO_CONTENT or not visible or self.suppressed:
                continue
            elif tag in (f"{W}footnoteReference", f"{W}endnoteReference"):
                if child.get(f"{W}id"):
                    self.items.append(_Note())
            elif is_media(child):
                self.items.append(_Obj(_Tok(self.source.alt(child)), media=True))
            elif tag == f"{W}t":
                self.emit(_converted(child.text or "", family), marks)
            elif tag in (f"{W}tab", f"{W}ptab"):
                self.emit(" ", marks)
            elif tag == f"{W}cr" or (
                tag == f"{W}br" and child.get(f"{W}type", "textWrapping") == "textWrapping"
            ):
                self.items.append(_Br())
            elif tag == f"{W}noBreakHyphen":
                self.emit("\u2011", marks)
            elif tag == f"{W}sym":
                self.emit(_sym(child), marks)
            elif tag == _ALTERNATE:
                self.walk(_first_choice(child))
            else:  # a soft hyphen, a page break, a note's own mark, or runs nested (ruby)
                self.walk(child)

    def emit(self, text: str, marks: frozenset[str]) -> None:
        if text:
            self.items.append(_T(text, marks))
            if self.fields and self.fields[-1].in_result:
                self.fields[-1].result += text

    def field_char(self, el: Element) -> None:
        kind = el.get(f"{W}fldCharType")
        if kind == "begin":
            self.fields.append(_Field(opener=self, mark=len(self.items)))
        elif kind == "separate" and self.fields:
            self.fields[-1].in_result = True
        elif kind == "end":
            self.close_field()

    def close_field(self) -> None:
        if not self.fields:
            return
        state = self.fields.pop()
        self.closed.append(state)
        opened_here = state.opener is self
        state.opener = None
        if opened_here and not self.suppressed:
            wrap = state.wrap()
            if wrap is not None:
                self.spans.append((state.mark, len(self.items), wrap))

    # -- what the paragraph is --

    @property
    def objects(self) -> list[_Obj]:
        return [i for i in self.items if isinstance(i, _Obj)]

    def blank(self) -> bool:
        return all(
            isinstance(i, _Obj | _Br) or (isinstance(i, _T) and not i.text.strip())
            for i in self.items
        )

    def lone(self) -> _Tok | None:
        """The picture or drawing standing alone in the paragraph."""
        objects = self.objects
        if len(objects) == 1 and objects[0].media and self.blank():
            return objects[0].piece
        return None

    def display(self) -> list[_Tok]:
        """The display equations of a paragraph holding nothing else."""
        objects = self.objects
        if objects and all(o.display for o in objects) and self.blank():
            return [o.piece for o in objects]
        return []

    def placed(self) -> list[_Piece]:
        """The pieces, objects as theirs and wrapped spans as cross-references and links."""
        slots: list[list[_Piece]] = [[i.piece if isinstance(i, _Obj) else i] for i in self.items]
        for start, end, wrap in self.spans:
            if start < end:
                content = [p for slot in slots[start:end] for p in slot]
                slots[start:end] = [wrap(content), *([] for _ in range(end - start - 1))]
        return [p for slot in slots for p in slot]

    def seq_fields(self) -> list[_Field]:
        return [f for f in self.closed if f.kind == "SEQ"]


def _first_choice(alternate: Element) -> Element:
    choice = alternate.find(f"{_MC}Choice")
    return choice if choice is not None else Element("none")


def _run_family(rpr: Element | None) -> Family | None:
    fonts = rpr.find(f"{W}rFonts") if rpr is not None else None
    if fonts is None:
        return None
    for attr in ("ascii", "hAnsi", "cs"):
        name = fonts.get(f"{W}{attr}")
        if name and (family := font_family(name)) is not None:
            return family
    return None


def _symbol(code: int, family: Family | None) -> str:
    low = code & 0xFF
    if family is not None:
        mapped = TABLES[family].get(low)
        if mapped is not None:
            return mapped
        if low == 0x20:
            return " "
    return _REPLACEMENT


def _converted(text: str, family: Family | None) -> str:
    """Text with Symbol and Wingdings characters as Unicode."""
    out: list[str] = []
    for ch in text:
        code = ord(ch)
        if FIRST + 0x20 <= code <= LAST:
            out.append(_symbol(code, family or "symbol"))
        elif family is not None and 0x21 <= code <= 0xFF:
            out.append(_symbol(code, family))
        else:
            out.append(ch)
    return "".join(out)


def _sym(el: Element) -> str:
    try:
        code = int(el.get(f"{W}char", ""), 16)
    except ValueError:
        return _REPLACEMENT
    return _symbol(code, font_family(el.get(f"{W}font", "")))


def _accepted(o: Element) -> Element:
    """A copy of an equation with its tracked changes accepted."""
    source = copy.deepcopy(o)

    def accept(parent: Element) -> None:
        index = 0
        while index < len(parent):
            child = parent[index]
            if child.tag in _REJECTED:
                del parent[index]
            elif child.tag in _ACCEPTED:
                accept(child)
                parent[index : index + 1] = list(child)
                index += len(child)
            else:
                accept(child)
                index += 1

    accept(source)
    return source


# --- The walk --------------------------------------------------------------------------------


class _NoRenderer:
    def render(self, fragment: RenderFragment) -> bytes | None:
        return None


#: Where a unit is: the ordinal of the section it is in (0 before the first heading), or the
#: id of the note it is in.
_Place = int | str

#: A table's grid as the source has it, filled in once its cells' text is known.
_Record = tuple[_STable, list[list[str]]]


class _Walk:
    """The source walked in the order of the text form."""

    def __init__(self, pkg: Package, ctx: InlineContext) -> None:
        self.pkg = pkg
        self.ctx = ctx
        self.styles = Styles(pkg.xml("word/styles.xml"), pkg.xml("word/numbering.xml"))
        self.media = MediaContext(pkg=pkg, renderer=_NoRenderer())
        self.fields: list[_Field] = []
        self.units: list[tuple[str, _Place]] = []
        self.records: list[_Record] = []
        self._rels: dict[str, dict[str, Rel]] = {}

    def rels(self) -> dict[str, Rel]:
        """The relationships of the part being read."""
        part = self.media.part
        if part not in self._rels:
            self._rels[part] = self.pkg.rels(part)
        return self._rels[part]

    # -- objects --

    def alt(self, run_child: Element) -> str:
        """A picture's or drawing's alt text: the drawing's own text, else its description."""
        el, _ = _choose(run_child)
        if el is None:
            return ""
        text = "\n".join(self.media.drawing_lines(el))
        if text:
            return text
        container = el.find(f"{_WP}inline")
        if container is None:
            container = el.find(f"{_WP}anchor")
        return _doc_pr_alt(container) or ""

    def equation(self, o: Element) -> str:
        mathml = omml_to_mathml(_accepted(o))
        return equation_token(mathml) if mathml is not None else IMAGE_ONLY_EQUATION

    # -- reading --

    def read(self, p: Element) -> _Para:
        return _Para(self, p)

    def elements(self, parent: Element) -> Iterator[Element]:
        """The paragraphs and tables under `parent`, through any container."""
        for child in parent:
            tag = child.tag
            if tag in (f"{W}p", f"{W}tbl"):
                yield child
            elif tag in _NO_CONTENT or tag in _REJECTED:
                continue
            elif tag == _ALTERNATE:
                yield from self.elements(_first_choice(child))
            else:
                yield from self.elements(child)

    def paragraph(self, p: Element, blocks: list[_SBlock]) -> None:
        if self.styles.is_generated_list(p):
            self.read(p)  # only to keep the field stack balanced
            return
        para = self.read(p)
        if not para.items:
            return
        in_list = self.styles.list_info(p) is not None
        lone = para.lone()
        if lone is not None:
            blocks.append(_SImage(lone.value, in_list))
            return
        display = para.display()
        if display:
            blocks.extend(_SEquation(t.value) for t in display)
            return
        pieces = para.placed()
        seqs = para.seq_fields()
        caption = None
        if not in_list and (seqs or self.styles.is_caption(p)):
            caption = _caption(pieces, seqs)
        blocks.append(_SPara(pieces, caption, in_list))

    def container(self, parent: Element) -> list[_SBlock]:
        blocks: list[_SBlock] = []
        for el in self.elements(parent):
            if el.tag == f"{W}tbl":
                blocks.append(self.table(el))
            else:
                self.paragraph(el, blocks)
        return self.finish(blocks)

    def inline_paragraphs(self, tc: Element) -> tuple[list[list[_Piece]], list[_Field]]:
        """The pieces of a cell's own paragraphs, each read whole, and the fields they closed."""
        paragraphs: list[list[_Piece]] = []
        closed: list[_Field] = []
        for p in _unwrapped(tc, f"{W}p"):
            para = self.read(p)
            paragraphs.append(para.placed())
            closed.extend(para.closed)
        return paragraphs, closed

    def table(self, tbl: Element) -> _STable:
        rows = _rows(tbl)
        structure = structural_rows(tbl, self.ctx.styles)
        own = None
        if structure.caption is not None:
            paragraphs, closed = self.inline_paragraphs(_cells(rows[structure.caption])[0])
            joined: list[_Piece] = []
            for pieces in paragraphs:
                if pieces:
                    joined.extend([_Br(), *pieces] if joined else pieces)
            own = _caption(joined, closed)

        grid = source_grid(tbl)
        kept = structure.grid_rows(len(rows))
        index = {r: i for i, r in enumerate(kept)}
        origins = [
            [(index[s.origin[0]], s.origin[1]) if s.origin[0] in index else None for s in grid[r]]
            for r in kept
        ]
        read: list[tuple[tuple[int, int], list[_SBlock]]] = []
        for i, r in enumerate(kept):
            col, _ = _gaps(rows[r])
            for tc in _cells(rows[r]):
                origin = origins[i][col] if col < len(origins[i]) else None
                read.append((origin or (i, col), self.container(tc)))
                col += _span(tc)
        cells: dict[tuple[int, int], list[_SBlock]] = {}
        for origin, blocks in sorted(read, key=lambda item: item[0]):
            cells.setdefault(origin, []).extend(blocks)

        notes: _Notes = []
        for i in structure.notes:
            tc = _cells(rows[i])[0]
            paragraphs, _ = self.inline_paragraphs(tc)
            notes.extend(_notes(paragraphs, _note_markers(tc) or []))
        return _STable(tbl, own, cells, origins, notes)

    # -- a scope's blocks --

    def finish(self, blocks: list[_SBlock]) -> list[_SBlock]:
        """Notes tables taken by the table before them, then caption paragraphs by the table or
        image next to them."""
        out: list[_SBlock] = []
        for block in blocks:
            prev = out[-1] if out else None
            if isinstance(block, _STable) and isinstance(prev, _STable):
                match = notes_table(prev.tbl, block.tbl, self.ctx.styles)
                notes = block.as_notes() if match == "notes" else None
                if notes is not None:
                    prev.notes = [*prev.notes, *notes]
                    continue
            out.append(block)

        taken: set[int] = set()

        def caption_at(j: int, kind: str) -> _Caption | None:
            if not 0 <= j < len(out) or j in taken:
                return None
            block = out[j]
            if not isinstance(block, _SPara) or block.caption is None:
                return None
            return block.caption if block.caption.kind in (None, kind) else None

        def wants(block: _SBlock, kind: str | None) -> bool:
            if isinstance(block, _STable):
                return kind in (None, "table") and not block.has_caption
            return isinstance(block, _SImage) and not block.in_list and kind in (None, "figure")

        def adjacent(i: int, kind: str) -> int | None:
            if caption_at(i - 1, kind) is not None:
                return i - 1
            below = caption_at(i + 1, kind)
            if below is not None:
                nxt = out[i + 2] if i + 2 < len(out) else None
                if nxt is None or not wants(nxt, below.kind):
                    return i + 1
            return None

        for i, block in enumerate(out):
            if isinstance(block, _SImage) and not block.in_list:
                j = adjacent(i, "figure")
            elif isinstance(block, _STable) and not block.has_caption:
                j = adjacent(i, "table")
            else:
                continue
            if j is None:
                continue
            taken.add(j)
            paragraph = out[j]
            assert isinstance(paragraph, _SPara)
            if isinstance(block, _SImage):
                block.caption = paragraph.caption
            else:
                block.attached = paragraph.caption
        return [b for i, b in enumerate(out) if i not in taken]

    # -- units --

    def render(self, pieces: Sequence[_Piece], *, typed: bool) -> str:
        """A unit's text: typed references (`typed`) and resolved cross-references as tokens."""
        out: list[str] = []
        for piece in _merged(pieces):
            if isinstance(piece, _T):
                out.append(self.typed(piece.text) if typed else piece.text)
            elif isinstance(piece, _Br):
                out.append(" ")
            elif isinstance(piece, _Tok):
                out.append(piece.value)
            elif isinstance(piece, _Ref):
                target = self.ctx.bookmarks.get(piece.name)
                out.append(xref_token(target) if target is not None else piece.text)
            elif isinstance(piece, _Link):
                out.append(self.render(piece.pieces, typed=False))
        return "".join(out)

    def typed(self, text: str) -> str:
        out: list[str] = []
        done = 0
        for match in TYPED_REFERENCE.finditer(text):
            label, digits = match.group(1), match.group(2)
            target = (
                self.ctx.caption_number_map.get((label.lower(), int(digits)))
                if len(digits) <= _MAX_DIGITS
                else None
            )
            if target is None:
                continue
            out.extend([text[done : match.start()], xref_token(target)])
            done = match.end()
        out.append(text[done:])
        return "".join(out)

    def emit(
        self, blocks: Sequence[_SBlock], place: _Place, units: list[tuple[str, _Place]]
    ) -> None:
        for block in blocks:
            if isinstance(block, _SPara):
                units.append((self.render(block.pieces, typed=True), place))
            elif isinstance(block, _SImage):
                if block.caption is not None:
                    units.append((self.render(block.caption.pieces, typed=False), place))
                units.append((block.alt, place))
            elif isinstance(block, _SEquation):
                units.append((block.token, place))
            else:
                self.emit_table(block, place, units)

    def emit_table(self, table: _STable, place: _Place, units: list[tuple[str, _Place]]) -> None:
        grid: list[list[str]] = []
        self.records.append((table, grid))
        caption = table.attached or table.own_caption
        if caption is not None:
            units.append((self.render(caption.pieces, typed=False), place))
        texts: dict[tuple[int, int], str] = {}
        for origin, blocks in table.cells.items():
            inner: list[tuple[str, _Place]] = []
            self.emit(blocks, place, inner)
            texts[origin] = join_units([u for u, _ in inner])
            units.append((texts[origin], place))
        for marker, pieces in table.notes:
            units.append((note_unit(marker, self.render(pieces, typed=True)), place))
        grid.extend(
            [f"{o[0]},{o[1]}|{texts.get(o, '')}" if o is not None else "?" for o in row]
            for row in table.origins
        )

    # -- the whole source --

    def run(self) -> None:
        document = self.pkg.xml(_MAIN)
        body = document.find(f"{W}body") if document is not None else None
        if body is None:
            raise DecompositionFailed("document has no body")
        blocks: list[_SBlock] = []
        ordinal = 0
        for el in self.elements(body):
            if el.tag == f"{W}tbl":
                blocks.append(self.table(el))
                continue
            level = None if self.styles.is_generated_list(el) else self.styles.outline_level(el)
            if level is None:
                self.paragraph(el, blocks)
                continue
            self.emit(self.finish(blocks), ordinal, self.units)
            blocks = []
            ordinal += 1
            para = self.read(el)
            pieces = para.placed()
            blank = (
                all(isinstance(p, _T | _Br) for p in pieces)
                and not "".join(p.text for p in pieces if isinstance(p, _T)).strip()
            )
            title = _EMPTY_TITLE if blank else self.render(pieces, typed=True)
            self.units.append((title, ordinal))
        self.emit(self.finish(blocks), ordinal, self.units)
        self.notes()

    def notes(self) -> None:
        for kind, prefix in (("footnote", "fn"), ("endnote", "en")):
            part = self.note_part(kind)
            root = self.pkg.xml(part) if part is not None else None
            if part is None or root is None:
                continue
            self.media.part = part
            self.fields = []
            for el in root.findall(f"{W}{kind}"):
                nid = el.get(f"{W}id")
                if nid is None or el.get(f"{W}type", "normal") != "normal":
                    continue
                self.emit(self.container(el), f"{prefix}-{nid}", self.units)
            self.media.part = _MAIN

    def note_part(self, kind: str) -> str | None:
        for rel in self.pkg.rels(_MAIN).values():
            if rel.type == f"{_REL_BASE}{kind}s" and not rel.external:
                return self.pkg.target(_MAIN, rel.id)
        return None


def _merged(pieces: Sequence[_Piece]) -> list[_Piece]:
    """Adjacent text with equal marks joined, empty text dropped."""
    merged: list[_Piece] = []
    for piece in pieces:
        if isinstance(piece, _T):
            if not piece.text:
                continue
            last = merged[-1] if merged else None
            if isinstance(last, _T) and last.marks == piece.marks:
                merged[-1] = _T(last.text + piece.text, piece.marks)
                continue
        merged.append(piece)
    return merged


def _walk(pkg: Package, ctx: InlineContext) -> _Walk:
    walk = _Walk(pkg, ctx)
    walk.run()
    return walk


def _normalised(units: Sequence[tuple[str, _Place]]) -> list[tuple[str, _Place]]:
    return [(n, place) for u, place in units if (n := normalise(u))]


def source_text_units(pkg: Package, ctx: InlineContext) -> list[str]:
    """The source's text units, read independently of the decomposition, in the order and form
    of `forms.text_form`; an equation without MathML is `IMAGE_ONLY_EQUATION`."""
    return [u for u, _ in _normalised(_walk(pkg, ctx).units)]


# --- References ------------------------------------------------------------------------------


class _References:
    def __init__(self, doc: DecomposedDocument) -> None:
        self.images = {i.id for i in doc.images}
        self.equations = {e.id for e in doc.equations}
        self.notes = {n.id for n in doc.notes}
        self.ids: set[str] = set(self.notes)
        for block in _all_blocks(doc):
            self.ids.add(block.id)
        for section in _all_sections(doc.sections):
            self.ids.add(section.id)

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


# --- The check -------------------------------------------------------------------------------


def _shown(unit: str | None) -> str:
    if unit is None:
        return "nothing"
    return f'"{unit[:_MAX_SHOWN]}{"…" if len(unit) > _MAX_SHOWN else ""}"'


def _section_at(place: _Place, sections: Sequence[str]) -> str | None:
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
    _References(doc).check(doc)

    walk = _walk(pkg, ctx)
    source = _normalised(walk.units)
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
    if len(tables) != len(walk.records):
        raise DecompositionFailed(
            f"the document has {len(tables)} tables where the source has {len(walk.records)}"
        )
    forms = grid_forms(doc, image_only=IMAGE_ONLY_EQUATION)
    for table, (_, expected) in zip(tables, walk.records, strict=True):
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
