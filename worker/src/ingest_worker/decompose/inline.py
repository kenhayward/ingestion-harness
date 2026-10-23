"""Inline content of a Word paragraph: marks, characters, whitespace, tracked changes, fields.

A paragraph's runs are read in document order into the model's inlines. Tracked changes are read
as accepted, comments and hidden text are dropped, and a field keeps its result while its
instruction is never output. The context carries what later tasks need to act on fields and
cross-references without this module knowing about them.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Literal
from xml.etree.ElementTree import Element

from ingest_worker.symbol_fonts import FIRST, LAST, TABLES, Family, font_family

from .model import Break, Flag, Inline, Link, Text, XRef

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

Mark = Literal["bold", "italic", "underline", "superscript", "subscript"]
_MARKS: tuple[Mark, ...] = ("bold", "italic", "underline", "superscript", "subscript")
_PROPS = (*_MARKS, "hidden")
_OFF = {"0", "false", "off"}
_REPLACEMENT = "�"

#: Containers whose children are runs in the paragraph's flow.
_TRANSPARENT = {
    f"{W}{name}"
    for name in ("hyperlink", "smartTag", "sdt", "sdtContent", "customXml", "dir", "bdo")
}
_ACCEPTED = {f"{W}ins", f"{W}moveTo"}
_REJECTED = {f"{W}del", f"{W}moveFrom"}


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


@dataclass
class InlineContext:
    """State shared by the paragraphs of a part.

    `fields` is the stack of open fields and `closed_fields` the finished ones, in closing order.
    `bookmarks` maps a bookmark name to the id it resolves to (filled by a later task). `changes`
    counts tracked-change elements read as accepted. `caption_number_map` maps a caption's kind
    and the number the source displayed for it, such as `("table", 13)`, to the captioned
    element's id.
    """

    styles: RunStyles = field(default_factory=RunStyles)
    bookmarks: dict[str, str] = field(default_factory=dict)
    fields: list[FieldState] = field(default_factory=list)
    closed_fields: list[FieldState] = field(default_factory=list)
    flags: list[Flag] = field(default_factory=list)
    changes: int = 0
    caption_number_map: dict[tuple[str, int], str] = field(default_factory=dict)


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
            elif tag == f"{W}fldSimple":
                state = FieldState(child.get(f"{W}instr", ""), in_result=True)
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
        if self.ctx.fields:
            self.ctx.closed_fields.append(self.ctx.fields.pop())

    @property
    def in_instruction(self) -> bool:
        return any(not f.in_result for f in self.ctx.fields)

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

        for child in run:
            tag = child.tag.removeprefix(W)
            if tag == "fldChar":
                self.field_char(child)
            elif tag == "instrText":
                if self.ctx.fields and not self.ctx.fields[-1].in_result:
                    self.ctx.fields[-1].instruction += child.text or ""
            elif not visible or self.in_instruction:
                continue
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
            self.ctx.fields.append(FieldState())
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


def inlines_of(p: Element, ctx: InlineContext, *, at: str) -> list[Inline]:
    """The inlines of paragraph `p`; `at` locates it in any flag raised."""
    style_el = p.find(f"{W}pPr/{W}pStyle")
    style = style_el.get(f"{W}val") if style_el is not None else None
    reader = _Reader(ctx, style, at)
    reader.walk(p)
    return merge_runs(reader.out)


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
