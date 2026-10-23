"""The document body: a tree of sections holding paragraphs, lists and tables.

Headings (by outline level) open sections; ids come from the heading-title path and the ordinal
of each kind of block within its section, so they survive edits elsewhere in the document.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from xml.etree.ElementTree import Element

from .ids import child_id, normalise_title, section_id
from .inline import InlineContext, W, inlines_of, plain_text
from .model import Block, Break, Flag, Inline, ListBlock, ListItem, Paragraph, Section, Text
from .package import DecompositionFailed, Package
from .styles import Styles
from .tables import table_of

_EMPTY_TITLE = "[]"
_LEADING = "s-0"


# --- Builders --------------------------------------------------------------------------------


@dataclass
class _List:
    """A list being assembled; items may hold nested lists until the whole list is built."""

    id: str
    num_id: str
    ilvl: int
    ordered: bool
    items: list[list[Block | _List]] = field(default_factory=list)

    def build(self) -> ListBlock:
        return ListBlock(
            id=self.id,
            ordered=self.ordered,
            items=[ListItem(blocks=_built(blocks)) for blocks in self.items],
        )


def _built(blocks: list[Block | _List]) -> list[Block]:
    return [b.build() if isinstance(b, _List) else b for b in blocks]


@dataclass
class _Scope:
    """Somewhere blocks accumulate, and the ordinals that name them."""

    id: str
    blocks: list[Block | _List] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)

    def peek(self, kind: str) -> str:
        return child_id(self.id, kind, self.counts.get(kind, 0) + 1)

    def take(self, kind: str) -> str:
        self.counts[kind] = self.counts.get(kind, 0) + 1
        return child_id(self.id, kind, self.counts[kind])


@dataclass
class _Open(_Scope):
    """A section being assembled."""

    level: int = 0
    title: list[Inline] = field(default_factory=list)
    sections: list[_Open] = field(default_factory=list)
    slugs: dict[str, int] = field(default_factory=dict)

    def build(self) -> Section:
        return Section(
            id=self.id,
            title=self.title,
            blocks=_built(self.blocks),
            sections=[s.build() for s in self.sections],
        )


# --- Flow ------------------------------------------------------------------------------------


def _elements(parent: Element) -> Iterator[Element]:
    """Paragraphs and tables under `parent`, with block content controls unwrapped."""
    for child in parent:
        if child.tag == f"{W}sdt":
            content = child.find(f"{W}sdtContent")
            if content is not None:
                yield from _elements(content)
        elif child.tag in (f"{W}p", f"{W}tbl"):
            yield child


class _Flow:
    """Turns paragraphs and tables into blocks of the current scope, grouping list paragraphs."""

    def __init__(self, scope: _Scope, styles: Styles, ctx: InlineContext) -> None:
        self.scope = scope
        self.styles = styles
        self.ctx = ctx
        self.lists: list[_List] = []  # open lists, outermost first

    def switch(self, scope: _Scope) -> None:
        self.end_list()
        self.scope = scope

    def end_list(self) -> None:
        if self.lists:
            self.scope.blocks.append(self.lists[0])
            self.lists = []

    def close_innermost(self) -> None:
        closed = self.lists.pop()
        if not self.lists:
            self.scope.blocks.append(closed)

    def paragraph(self, p: Element) -> None:
        inlines = inlines_of(p, self.ctx, at=self.scope.peek("p"))
        if not inlines:
            return  # an empty paragraph leaves no trace, even between list paragraphs
        info = self.styles.list_info(p)
        if info is None:
            self.end_list()
            self.scope.blocks.append(Paragraph(id=self.scope.take("p"), inlines=inlines))
            return
        num_id, ilvl, ordered = info
        while self.lists and self.lists[-1].ilvl > ilvl:
            self.close_innermost()
        if self.lists and self.lists[-1].ilvl == ilvl and self.lists[-1].num_id != num_id:
            self.close_innermost()
        if self.lists and self.lists[-1].ilvl == ilvl:
            target = self.lists[-1]
        else:
            target = _List(self.scope.take("list"), num_id, ilvl, ordered)
            if self.lists:
                self.lists[-1].items[-1].append(target)
            self.lists.append(target)
        target.items.append([Paragraph(id=self.scope.take("p"), inlines=inlines)])

    def table(self, tbl: Element) -> None:
        self.end_list()
        block = table_of(
            tbl, self.ctx, id=self.scope.take("table"), walk_blocks=self.walk_container
        )
        self.scope.blocks.append(block)

    def walk_container(self, parent: Element, prefix: str) -> list[Block]:
        """The blocks of a container such as a table cell; every paragraph is body text there."""
        inner = _Flow(_Scope(prefix), self.styles, self.ctx)
        for el in _elements(parent):
            if el.tag == f"{W}tbl":
                inner.table(el)
            else:
                inner.paragraph(el)
        inner.end_list()
        return _built(inner.scope.blocks)


# --- Sections --------------------------------------------------------------------------------


def walk_body(pkg: Package, ctx: InlineContext) -> tuple[list[Block], list[Section]]:
    """The document's leading blocks (before the first heading) and its top-level sections."""
    document = pkg.xml("word/document.xml")
    body = document.find(f"{W}body") if document is not None else None
    if body is None:
        raise DecompositionFailed("document has no body")
    styles = Styles(pkg.xml("word/styles.xml"), pkg.xml("word/numbering.xml"))

    root = _Open(_LEADING)  # collects the leading blocks and the top-level sections
    stack: list[_Open] = []  # the open sections, outermost first
    flow = _Flow(root, styles, ctx)

    for el in _elements(body):
        if el.tag == f"{W}tbl":
            flow.table(el)
            continue
        level = styles.outline_level(el)
        if level is None:
            flow.paragraph(el)
            continue
        flow.end_list()
        while stack and stack[-1].level >= level:
            stack.pop()
        parent = stack[-1] if stack else root
        inlines = inlines_of(el, ctx, at=f"{parent.id}/heading")
        blank = (
            all(isinstance(i, Text | Break) for i in inlines) and not plain_text(inlines).strip()
        )
        title = _EMPTY_TITLE if blank else plain_text(inlines)
        slug = normalise_title(title)
        parent.slugs[slug] = parent.slugs.get(slug, 0) + 1
        sid = section_id(None if parent is root else parent.id, title, parent.slugs[slug])
        section = _Open(sid, level=level, title=[Text(text=_EMPTY_TITLE)] if blank else inlines)
        parent.sections.append(section)
        stack.append(section)
        _flag_heading(ctx, section, parent if parent is not root else None, blank)
        flow.switch(section)
    flow.end_list()
    return _built(root.blocks), [s.build() for s in root.sections]


def _flag_heading(ctx: InlineContext, section: _Open, parent: _Open | None, blank: bool) -> None:
    if blank:
        ctx.flags.append(
            Flag(code="heading_empty", severity="warning", at=section.id, message="empty heading")
        )
    expected = parent.level + 1 if parent is not None else 0
    if section.level > expected:
        ctx.flags.append(
            Flag(
                code="heading_skipped_level",
                severity="warning",
                at=section.id,
                message=f"heading level {section.level + 1} where level {expected + 1} was due",
            )
        )
