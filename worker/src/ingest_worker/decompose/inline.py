"""Inline content of a Word paragraph: marks, characters, whitespace, tracked changes, fields.

A paragraph's runs are read in document order into the model's inlines. Tracked changes are read
as accepted, comments and hidden text are dropped, and a field keeps its result while its
instruction is never output. A table of contents (or list of tables or figures) is dropped
whole; a cross-reference field or internal hyperlink becomes an `XRef` to its bookmark (pointed
at an element id by the last pass), and an external one a `Link`. Equations (`m:oMath`) sit
among the runs as inline equations; a paragraph holding only display equations (`m:oMathPara`)
is left for the caller to place as equation blocks. The context carries what later tasks need to act on fields and
cross-references without this module knowing about them.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Literal, NamedTuple
from xml.etree.ElementTree import Element

from ingest_worker.symbol_fonts import FIRST, LAST, TABLES, Family, font_family

from .equations import O_MATH, O_MATH_PARA, equation_of
from .media import ALTERNATE, MediaContext, is_media, media_of, text_alternative
from .model import Break, Flag, Inline, InlineEquation, InlineImage, Link, NoteRef, Text, XRef
from .package import DecompositionFailed, Rel

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"

#: The prefix of an `XRef` target that names a bookmark, before the last pass resolves it.
BOOKMARK = "bookmark:"

Mark = Literal["bold", "italic", "underline", "superscript", "subscript"]
_MARKS: tuple[Mark, ...] = ("bold", "italic", "underline", "superscript", "subscript")
_PROPS = (*_MARKS, "hidden")
_OFF = {"0", "false", "off"}
_REPLACEMENT = "�"

#: Containers whose children are runs in the paragraph's flow.
_TRANSPARENT = {
    f"{W}{name}" for name in ("smartTag", "sdt", "sdtContent", "customXml", "dir", "bdo")
}
#: Documents embedded in another part, whose content the decomposer cannot place, so refuses.
EMBEDDED_DOCUMENT_TAGS = {f"{W}altChunk", f"{W}subDoc"}
EMBEDDED_DOCUMENTS = "embedded documents (altChunk/subDoc) are not supported"
_ACCEPTED = {f"{W}ins", f"{W}moveTo"}
_REJECTED = {f"{W}del", f"{W}moveFrom"}

#: Fields whose result is dropped whole: tables of contents and lists of tables or figures.
_DROPPED_FIELDS = {"TOC"}
#: Fields whose result is a cross-reference to the bookmark they name.
_REFERENCE_FIELDS = {"REF", "PAGEREF", "NOTEREF"}
#: Field switches followed by a value.
_VALUED_SWITCHES = {r"\l", r"\o", r"\t", r"\*", r"\#", r"\@"}
#: The addresses an external link may have; any other keeps its text without the link.
_LINK_SCHEMES = ("http://", "https://", "mailto:", "ftp://")
_TOKEN = re.compile(r'"([^"]*)"|(\S+)')


# --- Styles ----------------------------------------------------------------------------------


def _val_on(el: Element) -> bool:
    return el.get(f"{W}val", "1").lower() not in _OFF


def _rpr_props(rpr: Element | None) -> dict[str, bool]:
    """The properties a run-properties element sets, on or off; absent ones are not listed."""
    props: dict[str, bool] = {}
    if rpr is None:
        return props
    for child in rpr:
        tag = child.tag.removeprefix(W)
        if tag == "b":
            props["bold"] = _val_on(child)
        elif tag == "i":
            props["italic"] = _val_on(child)
        elif tag == "u":
            props["underline"] = child.get(f"{W}val", "single").lower() not in _OFF | {"none"}
        elif tag == "vertAlign":
            val = child.get(f"{W}val", "baseline")
            props["superscript"] = val == "superscript"
            props["subscript"] = val == "subscript"
        elif tag in ("vanish", "specVanish"):
            props["hidden"] = props.get("hidden", False) or _val_on(child)
    return props


class RunStyles:
    """Run properties from styles.xml: document defaults, then each style down its basedOn chain."""

    def __init__(self, root: Element | None = None) -> None:
        self._rpr: dict[str, Element | None] = {}
        self._based_on: dict[str, str] = {}
        self._defaults: Element | None = None
        if root is None:
            return
        defaults = root.find(f"{W}docDefaults/{W}rPrDefault/{W}rPr")
        self._defaults = defaults
        for style in root.findall(f"{W}style"):
            sid = style.get(f"{W}styleId")
            if sid is None:
                continue
            self._rpr[sid] = style.find(f"{W}rPr")
            parent = style.find(f"{W}basedOn")
            if parent is not None and (pid := parent.get(f"{W}val")):
                self._based_on[sid] = pid

    @classmethod
    def from_xml(cls, root: Element | None) -> RunStyles:
        return cls(root)

    def _chain(self, style_id: str | None) -> list[Element | None]:
        """The run properties of a style and its ancestors, most basic first."""
        chain: list[Element | None] = []
        seen: set[str] = set()
        while style_id is not None and style_id in self._rpr and style_id not in seen:
            seen.add(style_id)
            chain.append(self._rpr[style_id])
            style_id = self._based_on.get(style_id)
        chain.reverse()
        return chain

    def resolve(
        self, paragraph_style: str | None, char_style: str | None, direct: Element | None
    ) -> dict[str, bool]:
        """Effective properties: defaults, paragraph style, character style, then direct."""
        layers = [self._defaults, *self._chain(paragraph_style), *self._chain(char_style), direct]
        props = dict.fromkeys(_PROPS, False)
        for layer in layers:
            props.update(_rpr_props(layer))
        return props


# --- Context ---------------------------------------------------------------------------------


@dataclass
class FieldState:
    """A field Word has opened (or a `fldSimple`): its instruction, which half is being read, and
    the text of its result read so far (outside any field nested in it)."""

    instruction: str = ""
    in_result: bool = False
    result: str = ""
    #: The paragraph reader the field began in, while it is open, and its place in that
    #: reader's output then; a field closed by the same reader can wrap its result.
    opener: _Reader | None = field(default=None, repr=False, compare=False)
    mark: int = field(default=0, repr=False, compare=False)

    @property
    def kind(self) -> str:
        """The field's keyword (`TOC`, `SEQ`, `REF`, `PAGEREF`, `NOTEREF`, `HYPERLINK`, ...)."""
        words = self.instruction.split()
        return words[0].upper() if words else ""

    @property
    def argument(self) -> str:
        """The instruction's first argument, such as a `SEQ` field's identifier (`Table`)."""
        words = self.instruction.split()
        return words[1] if len(words) > 1 else ""

    @property
    def tokens(self) -> list[str]:
        """The instruction's words, with quoted ones unquoted."""
        return [
            m.group(1) if m.group(1) is not None else m.group(2)
            for m in _TOKEN.finditer(self.instruction)
        ]


@dataclass
class InlineContext:
    """State shared by the paragraphs of a part.

    `fields` is the stack of open fields and `closed_fields` the finished ones, in closing order.
    `bookmarks` maps a bookmark name to the id of the element it starts in, and
    `pending_bookmarks` holds the names read since the last element was placed. `changes`
    counts tracked-change elements read as accepted. `caption_number_map` maps a caption's kind
    and the number the source displayed for it, such as `("table", 13)`, to the captioned
    element's id. `media` holds the images and equations read so far and what reading more
    needs; the decomposer always supplies it, and reading a picture, drawing or equation
    without it fails.
    """

    styles: RunStyles = field(default_factory=RunStyles)
    bookmarks: dict[str, str] = field(default_factory=dict)
    fields: list[FieldState] = field(default_factory=list)
    closed_fields: list[FieldState] = field(default_factory=list)
    flags: list[Flag] = field(default_factory=list)
    changes: int = 0
    caption_number_map: dict[tuple[str, int], str] = field(default_factory=dict)
    media: MediaContext | None = None
    pending_bookmarks: list[str] = field(default_factory=list)
    _rels: dict[str, dict[str, Rel]] = field(default_factory=dict, repr=False)

    def relationships(self) -> dict[str, Rel]:
        """The relationships of the part being read, or none without a media context."""
        if self.media is None:
            return {}
        part = self.media.part
        if part not in self._rels:
            self._rels[part] = self.media.pkg.rels(part)
        return self._rels[part]


def place_bookmarks(ctx: InlineContext, element_id: str) -> None:
    """Map the bookmarks read since the last element was placed to `element_id`."""
    for name in ctx.pending_bookmarks:
        ctx.bookmarks.setdefault(name, element_id)
    ctx.pending_bookmarks.clear()


def move_bookmarks(ctx: InlineContext, old: str, new: str) -> None:
    """Point the bookmarks mapped to `old`, or to something inside it, at `new`, which absorbed
    it."""
    for name, target in ctx.bookmarks.items():
        if target == old or target.startswith(f"{old}#"):
            ctx.bookmarks[name] = new


def check_fields_closed(ctx: InlineContext, where: str) -> None:
    """Refuse a part that leaves a field open, which would otherwise swallow what follows it."""
    if ctx.fields:
        kinds = ", ".join(f.kind or "unnamed" for f in ctx.fields)
        raise DecompositionFailed(f"a field in {where} is never closed ({kinds})")


# --- Reading ---------------------------------------------------------------------------------


def _map_symbol(code: int, family: Family | None, font: str, ctx: InlineContext, at: str) -> str:
    """A Symbol or Wingdings code (low byte) as Unicode; unmapped gives U+FFFD and a flag."""
    low = code & 0xFF
    if family is not None:
        mapped = TABLES[family].get(low)
        if mapped is not None:
            return mapped
        if low == 0x20:
            return " "
    ctx.flags.append(
        Flag(
            code="symbol_unmapped",
            severity="warning",
            at=at,
            message=f"no mapping for code {code:04X} in font {font or 'unknown'}",
        )
    )
    return _REPLACEMENT


class _Reader:
    def __init__(self, ctx: InlineContext, paragraph_style: str | None, at: str) -> None:
        self.ctx = ctx
        self.paragraph_style = paragraph_style
        self.at = at
        self.out: list[Inline] = []
        #: Pictures, drawings and equations met, with the position in `out` they sit before.
        self.objects: list[tuple[int, Element]] = []
        #: The equations among `objects` that are in display form (in an `m:oMathPara`).
        self.display: list[Element] = []
        #: Stretches of the output, by `mark` at their start and end, to wrap as a
        #: cross-reference or link, in the order they closed.
        self.spans: list[tuple[int, int, _Wrap]] = []

    @property
    def mark(self) -> int:
        """The place reached in the output, counting text and objects alike."""
        return len(self.out) + len(self.objects)

    # -- flow --

    def walk(self, parent: Element) -> None:
        for child in parent:
            tag = child.tag
            if tag == f"{W}r":
                self.run(child)
            elif tag in _ACCEPTED:
                self.ctx.changes += 1
                self.walk(child)
            elif tag in _REJECTED:
                self.ctx.changes += 1
                self.track_fields(child)
            elif tag in _TRANSPARENT:
                self.walk(child)
            elif tag == f"{W}hyperlink":
                start = self.mark
                self.walk(child)
                wrap = self.hyperlink(child)
                if wrap is not None and not self.suppressed:
                    self.spans.append((start, self.mark, wrap))
            elif tag == f"{W}bookmarkStart":
                if name := child.get(f"{W}name"):
                    self.ctx.pending_bookmarks.append(name)
            elif self.suppressed and tag in (O_MATH, O_MATH_PARA):
                continue
            elif tag == O_MATH:
                self.objects.append((len(self.out), child))
            elif tag == O_MATH_PARA:
                for o in child.iter(O_MATH):
                    self.objects.append((len(self.out), o))
                    self.display.append(o)
            elif tag in EMBEDDED_DOCUMENT_TAGS:
                raise DecompositionFailed(EMBEDDED_DOCUMENTS, self.at or None)
            elif tag == ALTERNATE:
                chosen = text_alternative(child)
                if chosen is not None:
                    self.walk(chosen)
            elif tag == f"{W}fldSimple":
                state = FieldState(
                    child.get(f"{W}instr", ""), in_result=True, opener=self, mark=self.mark
                )
                self.ctx.fields.append(state)
                self.walk(child)
                self.close_field()

    def track_fields(self, deleted: Element) -> None:
        """Keep the field stack balanced across deleted content, which contributes no text."""
        for el in deleted.iter():
            if el.tag == f"{W}fldChar":
                self.field_char(el)
            elif (
                el.tag == f"{W}delInstrText"
                and self.ctx.fields
                and not self.ctx.fields[-1].in_result
            ):
                self.ctx.fields[-1].instruction += el.text or ""

    def close_field(self) -> None:
        if not self.ctx.fields:
            return
        state = self.ctx.fields.pop()
        self.ctx.closed_fields.append(state)
        opened_here = state.opener is self
        state.opener = None
        if opened_here and not self.suppressed:
            wrap = self.field_wrap(state)
            if wrap is not None:
                self.spans.append((state.mark, self.mark, wrap))

    @property
    def suppressed(self) -> bool:
        """Whether output is held back: inside a field's instruction, or in the result of a
        field that is dropped whole."""
        return any(not f.in_result or f.kind in _DROPPED_FIELDS for f in self.ctx.fields)

    # -- references --

    def field_wrap(self, state: FieldState) -> _Wrap | None:
        """How a closed field's result is wrapped: a cross-reference field, or a `HYPERLINK`
        field to a bookmark (`\\l`), as an `XRef`; a `HYPERLINK` to an address as a `Link`."""
        tokens = state.tokens
        kind = state.kind
        if kind in _REFERENCE_FIELDS:
            name = next((t for t in tokens[1:] if not t.startswith("\\")), None)
            return _xref(name) if name else None
        if kind != "HYPERLINK":
            return None
        address: str | None = None
        anchor: str | None = None
        rest = iter(tokens[1:])
        for token in rest:
            lowered = token.lower()
            if lowered == r"\l":
                anchor = next(rest, None)
            elif lowered in _VALUED_SWITCHES:
                next(rest, None)
            elif not token.startswith("\\") and address is None:
                address = token
        return _target(address, anchor)

    def hyperlink(self, el: Element) -> _Wrap | None:
        """How a `w:hyperlink`'s content is wrapped: to its external address as a `Link`, or to
        its bookmark (`w:anchor`) as an `XRef`."""
        rel_id = el.get(f"{R}id")
        rel = self.ctx.relationships().get(rel_id) if rel_id else None
        address = rel.target if rel is not None and rel.external else None
        if rel_id and address is None:
            return None  # an internal part or an unknown relationship: keep the text only
        return _target(address, el.get(f"{W}anchor"))

    # -- runs --

    def run(self, run: Element) -> None:
        rpr = run.find(f"{W}rPr")
        style_el = rpr.find(f"{W}rStyle") if rpr is not None else None
        char_style = style_el.get(f"{W}val") if style_el is not None else None
        if rpr is not None and rpr.find(f"{W}rPrChange") is not None:
            self.ctx.changes += 1
        props = self.ctx.styles.resolve(self.paragraph_style, char_style, rpr)
        marks = frozenset(m for m in _MARKS if props[m])
        visible = not props["hidden"]
        family, font = self.run_font(rpr)

        for child in run_children(run):
            tag = child.tag.removeprefix(W)
            if tag == "fldChar":
                self.field_char(child)
            elif tag == "instrText":
                if self.ctx.fields and not self.ctx.fields[-1].in_result:
                    self.ctx.fields[-1].instruction += child.text or ""
            elif not visible or self.suppressed:
                continue
            elif tag in ("footnoteReference", "endnoteReference"):
                if note := child.get(f"{W}id"):
                    prefix = "fn" if tag == "footnoteReference" else "en"
                    self.out.append(NoteRef(note_id=f"{prefix}-{note}"))
            elif is_media(child):
                self.objects.append((len(self.out), child))
            elif tag == "t":
                self.text(child.text or "", marks, family, font)
            elif tag in ("tab", "ptab"):
                self.emit(" ", marks)
            elif tag == "cr" or (
                tag == "br" and child.get(f"{W}type", "textWrapping") == "textWrapping"
            ):
                self.out.append(Break())
            elif tag == "noBreakHyphen":
                self.emit("\u2011", marks)
            elif tag == "sym":
                self.symbol(child, marks)

    def blank(self) -> bool:
        """Whether the paragraph's text is only whitespace."""
        return all(
            isinstance(i, Break) or (isinstance(i, Text) and not i.text.strip()) for i in self.out
        )

    def lone_media(self) -> Element | None:
        """The picture or drawing standing alone in the paragraph: the only object, with no
        other content than whitespace."""
        if len(self.objects) != 1 or self.objects[0][1].tag == O_MATH or not self.blank():
            return None
        return self.objects[0][1]

    def display_math(self) -> list[Element]:
        """The display equations of a paragraph that holds nothing else but whitespace."""
        if self.display and len(self.objects) == len(self.display) and self.blank():
            return self.display
        return []

    def placed(self) -> list[Inline]:
        """`out` with each picture or drawing read as an `InlineImage`, and each equation as an
        `InlineEquation`, at its place, and the spans of cross-references and links wrapped."""
        # One slot per mark: text and objects in the order they were read.
        slots: list[list[Inline]] = []
        pending = iter(self.objects)
        upcoming = next(pending, None)
        for index in range(len(self.out) + 1):
            while upcoming is not None and upcoming[0] == index:
                slots.append(self.place(upcoming[1]))
                upcoming = next(pending, None)
            if index < len(self.out):
                slots.append([self.out[index]])
        # Inner spans close first; an outer one then wraps what they became.
        for start, end, wrap in self.spans:
            if start < end:
                content = [item for slot in slots[start:end] for item in slot]
                slots[start:end] = [wrap(content), *([] for _ in range(end - start - 1))]
        return [item for slot in slots for item in slot]

    def place(self, el: Element) -> list[Inline]:
        """A picture or drawing as an `InlineImage` (or nothing), an equation as an
        `InlineEquation`."""
        if el.tag == O_MATH:
            equation = equation_of(el, self.ctx, at=self.at, display=False)
            return [InlineEquation(equation_id=equation.id)]
        image = media_of(el, self.ctx, at=self.at, in_text=True)
        return [image] if isinstance(image, InlineImage) else []

    def run_font(self, rpr: Element | None) -> tuple[Family | None, str]:
        fonts = rpr.find(f"{W}rFonts") if rpr is not None else None
        if fonts is None:
            return None, ""
        for attr in ("ascii", "hAnsi", "cs"):
            name = fonts.get(f"{W}{attr}")
            if name and (family := font_family(name)) is not None:
                return family, name
        return None, ""

    def field_char(self, el: Element) -> None:
        kind = el.get(f"{W}fldCharType")
        if kind == "begin":
            self.ctx.fields.append(FieldState(opener=self, mark=self.mark))
        elif kind == "separate" and self.ctx.fields:
            self.ctx.fields[-1].in_result = True
        elif kind == "end":
            self.close_field()

    def emit(self, text: str, marks: frozenset[Mark]) -> None:
        if text:
            self.out.append(Text(text=text, marks=marks))
            if self.ctx.fields and self.ctx.fields[-1].in_result:
                self.ctx.fields[-1].result += text

    def text(self, text: str, marks: frozenset[Mark], family: Family | None, font: str) -> None:
        chars: list[str] = []
        for ch in text:
            code = ord(ch)
            if FIRST + 0x20 <= code <= LAST:
                chars.append(
                    _map_symbol(code, family or "symbol", family or "Symbol", self.ctx, self.at)
                )
            elif family is not None and 0x21 <= code <= 0xFF:
                chars.append(_map_symbol(code, family, font, self.ctx, self.at))
            else:
                chars.append(ch)
        self.emit("".join(chars), marks)

    def symbol(self, el: Element, marks: frozenset[Mark]) -> None:
        font = el.get(f"{W}font", "")
        raw = el.get(f"{W}char", "")
        try:
            code = int(raw, 16)
        except ValueError:
            code = -1
        if code < 0:
            self.emit(_map_symbol(0, None, font, self.ctx, self.at), marks)
            return
        self.emit(_map_symbol(code, font_family(font), font, self.ctx, self.at), marks)


_Wrap = Callable[[list[Inline]], list[Inline]]


def run_children(run: Element) -> Iterator[Element]:
    """A run's children, alternate content holding no drawing read as its text alternative's
    children."""
    for child in run:
        if child.tag == ALTERNATE and not is_media(child):
            chosen = text_alternative(child)
            if chosen is not None:
                yield from run_children(chosen)
        else:
            yield child


def _xref(name: str) -> _Wrap:
    """Wraps text as a cross-reference to bookmark `name`; content that is not only text (or
    has none) is kept as it is."""

    def wrap(content: list[Inline]) -> list[Inline]:
        text = plain_text(content)
        if not text.strip() or not all(isinstance(i, Text | Break) for i in content):
            return content
        return [XRef(target_id=f"{BOOKMARK}{name}", text=text)]

    return wrap


def _link(href: str) -> _Wrap:
    def wrap(content: list[Inline]) -> list[Inline]:
        return [Link(href=href, inlines=content)] if content else content

    return wrap


def _target(address: str | None, anchor: str | None) -> _Wrap | None:
    """A link to `address` (with `anchor` as its fragment), or else a cross-reference to the
    bookmark `anchor`; an address whose scheme is not allowed keeps its text only."""
    if address:
        if not address.lower().startswith(_LINK_SCHEMES):
            return None
        return _link(f"{address}#{anchor}" if anchor else address)
    return _xref(anchor) if anchor else None


def _read(p: Element, ctx: InlineContext, at: str) -> _Reader:
    style_el = p.find(f"{W}pPr/{W}pStyle")
    style = style_el.get(f"{W}val") if style_el is not None else None
    reader = _Reader(ctx, style, at)
    reader.walk(p)
    return reader


def skip_paragraph(p: Element, ctx: InlineContext) -> None:
    """Read a paragraph that is dropped (an entry of a generated list) only to keep the field
    stack balanced; its bookmarks and flags are dropped with it."""
    pending = list(ctx.pending_bookmarks)
    flags = len(ctx.flags)
    _read(p, ctx, at="")
    ctx.pending_bookmarks[:] = pending
    del ctx.flags[flags:]


def inlines_of(p: Element, ctx: InlineContext, *, at: str) -> list[Inline]:
    """The inlines of paragraph `p`, pictures and drawings as `InlineImage`s and equations as
    `InlineEquation`s; `at` locates it in any flag raised and names the images and equations
    in it."""
    return merge_runs(_read(p, ctx, at).placed())


class ReadParagraph(NamedTuple):
    """A paragraph as read: its inlines, or what stands alone in it for the caller to place as
    blocks, which is a picture or drawing (`lone`) or its display equations (`display`)."""

    inlines: list[Inline]
    lone: Element | None
    display: list[Element]


def read_paragraph(p: Element, ctx: InlineContext, *, at: str) -> ReadParagraph:
    """The inlines of paragraph `p`, as `inlines_of` gives them; or, when one picture or
    drawing stands alone in it, no inlines and that run child; or, when it holds only display
    equations, no inlines and their `m:oMath` elements, in order."""
    reader = _read(p, ctx, at)
    lone = reader.lone_media()
    if lone is not None:
        return ReadParagraph([], lone, [])
    display = reader.display_math()
    if display:
        return ReadParagraph([], None, display)
    return ReadParagraph(merge_runs(reader.placed()), None, [])


def plain_text(inlines: list[Inline]) -> str:
    """The text of inlines, with a `Break` as a newline."""
    parts: list[str] = []
    for item in inlines:
        if isinstance(item, Text):
            parts.append(item.text)
        elif isinstance(item, Break):
            parts.append("\n")
        elif isinstance(item, Link):
            parts.append(plain_text(item.inlines))
        elif isinstance(item, XRef):
            parts.append(item.text)
    return "".join(parts)


def merge_runs(inlines: list[Inline]) -> list[Inline]:
    """Join adjacent `Text` with equal marks and drop empty ones."""
    merged: list[Inline] = []
    for item in inlines:
        if isinstance(item, Text):
            if not item.text:
                continue
            last = merged[-1] if merged else None
            if isinstance(last, Text) and last.marks == item.marks:
                merged[-1] = Text(text=last.text + item.text, marks=item.marks)
                continue
        elif isinstance(item, Link):
            item = Link(href=item.href, inlines=merge_runs(item.inlines))
        merged.append(item)
    return merged
