"""The document body: a tree of sections holding paragraphs, lists and tables.

Headings (by outline level) open sections; ids come from the heading-title path and the ordinal
of each kind of block within its section, so they survive edits elsewhere in the document.

When a scope's blocks are complete, a one-cell table of notes directly after a table becomes
that table's notes, and a caption paragraph (`Caption` style, or holding a `SEQ` field) next to
a table becomes its caption. Adjacency is in the block list, so empty paragraphs between them
don't count. A paragraph that takes a caption keeps the ordinal it was given, unused.
"""

from __future__ import annotations

from collections.abc import Iterator, Mapping
from dataclasses import dataclass, field
from typing import Literal
from xml.etree.ElementTree import Element

from .ids import child_id, normalise_title, section_id
from .inline import InlineContext, W, inlines_of, plain_text
from .model import (
    Block,
    Break,
    Flag,
    ImageBlock,
    Inline,
    ListBlock,
    ListItem,
    Paragraph,
    Section,
    Table,
    Text,
)
from .package import DecompositionFailed, Package
from .styles import Styles
from .tables import (
    Caption,
    CaptionKind,
    caption_key,
    caption_parts,
    flag_unrecognised_notes,
    notes_of_table,
    notes_table,
    register_caption,
    table_of,
)

Position = Literal["above", "below"]

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
    """Somewhere blocks accumulate, the ordinals that name them, the caption paragraphs among
    them (by paragraph id), and the source element of each table (by table id)."""

    id: str
    blocks: list[Block | _List] = field(default_factory=list)
    counts: dict[str, int] = field(default_factory=dict)
    captions: dict[str, Caption] = field(default_factory=dict)
    sources: dict[str, Element] = field(default_factory=dict)

    def finish(self, ctx: InlineContext, *, flag_uncaptioned: bool = True) -> list[Block]:
        """The scope's blocks, with note tables and caption paragraphs attached to tables.

        A table left without a caption is flagged unless `flag_uncaptioned` is off, as it is
        for the tables nested in a cell.
        """
        blocks = _attach_note_tables(_built(self.blocks), self.sources, ctx)
        return attach_captions(blocks, self.captions, ctx, flag_uncaptioned=flag_uncaptioned)

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

    def build(self, ctx: InlineContext) -> Section:
        return Section(
            id=self.id,
            title=self.title,
            blocks=self.finish(ctx),
            sections=[s.build(ctx) for s in self.sections],
        )


# --- Captions and notes ----------------------------------------------------------------------


def _wants_caption(block: Block, kind: CaptionKind | None) -> bool:
    """Whether `block` lacks a caption that a caption of `kind` could be."""
    if isinstance(block, Table):
        return kind in (None, "table") and not (block.caption or block.numbered)
    return isinstance(block, ImageBlock) and kind in (None, "figure")


def adjacent_caption(
    blocks: list[Block],
    index: int,
    captions: Mapping[str, Caption],
    kind: CaptionKind,
    taken: set[int],
) -> tuple[int, Position] | None:
    """The index and position of the caption paragraph for the `kind` block at `index`.

    A caption paragraph is one listed in `captions` whose label, if it has one, is `kind`, and
    that isn't in `taken`. The one directly before the block wins; the one directly after is
    left to the block after it when that block wants a caption of its own.
    """

    def caption_at(j: int) -> Caption | None:
        if not 0 <= j < len(blocks) or j in taken:
            return None
        block = blocks[j]
        caption = captions.get(block.id) if isinstance(block, Paragraph) else None
        return caption if caption is not None and caption.kind in (None, kind) else None

    if caption_at(index - 1) is not None:
        return index - 1, "above"
    below = caption_at(index + 1)
    if below is not None:
        nxt = blocks[index + 2] if index + 2 < len(blocks) else None
        if nxt is None or not _wants_caption(nxt, below.kind):
            return index + 1, "below"
    return None


def _move_flags(ctx: InlineContext, old: str, new: str) -> None:
    """Point the flags raised at `old`, or inside it, at `new`, which absorbed it."""
    for i, flag in enumerate(ctx.flags):
        if flag.at is not None and (flag.at == old or flag.at.startswith(f"{old}#")):
            ctx.flags[i] = flag.model_copy(update={"at": new})


def attach_captions(
    blocks: list[Block],
    captions: Mapping[str, Caption],
    ctx: InlineContext,
    *,
    flag_uncaptioned: bool = True,
) -> list[Block]:
    """Tables given their caption paragraphs, whose flags move to the table. A table left
    without a caption is flagged `caption_not_found` when `flag_uncaptioned` is on."""
    out = list(blocks)
    taken: set[int] = set()
    for i, block in enumerate(blocks):
        if not isinstance(block, Table):
            continue
        hit = (
            None
            if block.caption or block.numbered
            else adjacent_caption(blocks, i, captions, "table", taken)
        )
        if hit is not None:
            j, position = hit
            taken.add(j)
            caption = captions[blocks[j].id]
            register_caption(ctx, caption, block.id)
            _move_flags(ctx, blocks[j].id, block.id)
            block = block.model_copy(
                update={
                    "caption": caption.inlines,
                    "numbered": caption.numbered,
                    "caption_position": position,
                    "key": caption_key(caption.inlines),
                }
            )
            out[i] = block
        if flag_uncaptioned and not (block.caption or block.numbered):
            ctx.flags.append(
                Flag(
                    code="caption_not_found",
                    severity="info",
                    at=block.id,
                    message="no caption found for the table",
                )
            )
    return [b for i, b in enumerate(out) if i not in taken]


def _attach_note_tables(
    blocks: list[Block], sources: Mapping[str, Element], ctx: InlineContext
) -> list[Block]:
    """A one-cell table of notes directly after a table becomes that table's notes."""
    out: list[Block] = []
    for block in blocks:
        prev = out[-1] if out else None
        if (
            isinstance(block, Table)
            and isinstance(prev, Table)
            and block.id in sources
            and prev.id in sources
        ):
            match = notes_table(sources[prev.id], sources[block.id], ctx.styles)
            notes = notes_of_table(block, sources[block.id]) if match == "notes" else None
            if notes is not None:
                out[-1] = prev.model_copy(update={"notes": [*prev.notes, *notes]})
                _move_flags(ctx, block.id, prev.id)
                continue
            if match is not None:
                flag_unrecognised_notes(ctx, prev.id)
        out.append(block)
    return out


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
        self.wide = False  # whether the current page is landscape

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
        start = len(self.ctx.closed_fields)
        inlines = inlines_of(p, self.ctx, at=self.scope.peek("p"))
        if not inlines:
            return  # an empty paragraph leaves no trace, even between list paragraphs
        info = self.styles.list_info(p)
        if info is None:
            self.end_list()
            pid = self.scope.take("p")
            self.scope.blocks.append(Paragraph(id=pid, inlines=inlines))
            seqs = [f for f in self.ctx.closed_fields[start:] if f.kind == "SEQ"]
            if seqs or self.styles.is_caption(p):
                self.scope.captions[pid] = caption_parts(inlines, seqs)
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
        tid = self.scope.take("table")
        block = table_of(tbl, self.ctx, id=tid, walk_blocks=self.walk_container, wide=self.wide)
        self.scope.blocks.append(block)
        self.scope.sources[tid] = tbl

    def walk_container(self, parent: Element, prefix: str) -> list[Block]:
        """The blocks of a container such as a table cell; every paragraph is body text there."""
        inner = _Flow(_Scope(prefix), self.styles, self.ctx)
        inner.wide = self.wide
        for el in _elements(parent):
            if el.tag == f"{W}tbl":
                inner.table(el)
            else:
                inner.paragraph(el)
        inner.end_list()
        return inner.scope.finish(self.ctx, flag_uncaptioned=False)


# --- Pages -----------------------------------------------------------------------------------


def _landscape(sect_pr: Element | None) -> bool:
    """Whether a section's page is landscape: by orientation, or wider than it is high."""
    size = sect_pr.find(f"{W}pgSz") if sect_pr is not None else None
    if size is None:
        return False
    if size.get(f"{W}orient") == "landscape":
        return True
    try:
        return int(size.get(f"{W}w", "")) > int(size.get(f"{W}h", ""))
    except ValueError:
        return False


def _landscape_elements(body: Element, elements: list[Element]) -> set[int]:
    """Indices of the elements on landscape pages. A paragraph's `w:sectPr` ends its section,
    so it governs that paragraph and those before it back to the previous one; the body's own
    `w:sectPr` governs the last section."""
    current = _landscape(body.find(f"{W}sectPr"))
    wide: set[int] = set()
    for i in range(len(elements) - 1, -1, -1):
        sect_pr = elements[i].find(f"{W}pPr/{W}sectPr")
        if sect_pr is not None:
            current = _landscape(sect_pr)
        if current:
            wide.add(i)
    return wide


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

    elements = list(_elements(body))
    wide = _landscape_elements(body, elements)
    for i, el in enumerate(elements):
        flow.wide = i in wide
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
    return root.finish(ctx), [s.build(ctx) for s in root.sections]


def _flag_heading(ctx: InlineContext, section: _Open, parent: _Open | None, blank: bool) -> None:
    if blank:
        ctx.flags.append(
            Flag(code="heading_empty", severity="warning", at=section.id, message="empty heading")
        )
    # Only a jump of two or more levels below a parent heading is a skip; a document that
    # starts at level 2 is not.
    if parent is not None and section.level > parent.level + 1:
        expected = parent.level + 1
        ctx.flags.append(
            Flag(
                code="heading_skipped_level",
                severity="warning",
                at=section.id,
                message=f"heading level {section.level + 1} where level {expected + 1} was due",
            )
        )
