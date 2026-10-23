"""Footnotes and endnotes, and the last pass that resolves cross-references.

Word's footnotes and endnotes both become notes, with ids `fn-<w:id>` and `en-<w:id>`; the
separator and continuation notes are not content. Reading the body leaves each cross-reference
field and internal hyperlink as an `XRef` to the bookmark it names; the last pass points it at
the element the bookmark starts in, or keeps its text and flags it when there is none. The same
pass turns typed references ("see Table 3") into `XRef`s to the table or figure whose caption
showed that number in the source, outside captions and links.
"""

from __future__ import annotations

import re
from collections.abc import Sequence
from typing import Literal

from .body import container_blocks
from .inline import BOOKMARK, InlineContext, W, check_fields_closed, merge_runs, place_bookmarks
from .model import (
    Block,
    DecomposedDocument,
    Figure,
    Flag,
    Inline,
    Link,
    ListBlock,
    ListItem,
    Note,
    Paragraph,
    Row,
    Section,
    Table,
    TableNote,
    Text,
    XRef,
)
from .package import Package
from .styles import Styles

#: A typed reference to a table or figure by the number its caption showed.
TYPED_REFERENCE = re.compile(r"\b(Table|Figure)\s+(\d+)\b")
#: Longer numbers are not caption numbers (and would be costly to convert).
_MAX_DIGITS = 9

_MAIN = "word/document.xml"
_REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
_NOTE_PARTS: tuple[tuple[Literal["footnote", "endnote"], str], ...] = (
    ("footnote", "fn"),
    ("endnote", "en"),
)
_NORMAL = "normal"


# --- Notes -----------------------------------------------------------------------------------


def _note_part(pkg: Package, kind: str) -> str | None:
    """The package path of the main part's footnotes or endnotes part, if it has one."""
    for rel in pkg.rels(_MAIN).values():
        if rel.type == f"{_REL_BASE}{kind}s" and not rel.external:
            return pkg.target(_MAIN, rel.id)
    return None


def _trim_leading_space(blocks: list[Block]) -> list[Block]:
    """The note's blocks without the space Word puts after the note mark."""
    if not blocks or not isinstance(first := blocks[0], Paragraph) or not first.inlines:
        return blocks
    lead = first.inlines[0]
    if not isinstance(lead, Text):
        return blocks
    text = lead.text.lstrip()
    inlines = ([Text(text=text, marks=lead.marks)] if text else []) + first.inlines[1:]
    return [first.model_copy(update={"inlines": inlines}), *blocks[1:]]


def notes_of(pkg: Package, ctx: InlineContext) -> list[Note]:
    """The footnotes, then the endnotes, in source order.

    While a part is read, pictures in it resolve their relationships against that part. A
    bookmark that starts in a note but in none of its blocks maps to the note.
    """
    styles = Styles(pkg.xml("word/styles.xml"), pkg.xml("word/numbering.xml"))
    notes: list[Note] = []
    for kind, prefix in _NOTE_PARTS:
        part = _note_part(pkg, kind)
        root = pkg.xml(part) if part is not None else None
        if part is None or root is None:
            continue
        media = ctx.media
        previous = media.part if media is not None else _MAIN
        if media is not None:
            media.part = part
        try:
            for el in root.findall(f"{W}{kind}"):
                nid = el.get(f"{W}id")
                if nid is None or el.get(f"{W}type", _NORMAL) != _NORMAL:
                    continue
                note_id = f"{prefix}-{nid}"
                blocks = container_blocks(el, note_id, styles, ctx)
                place_bookmarks(ctx, note_id)
                notes.append(Note(id=note_id, blocks=_trim_leading_space(blocks)))
            check_fields_closed(ctx, f"the {kind}s")
        finally:
            if media is not None:
                media.part = previous
    return notes


# --- References ------------------------------------------------------------------------------


class _Resolver:
    """Rebuilds the document's inlines with cross-references resolved, collecting flags."""

    def __init__(self, ctx: InlineContext) -> None:
        self.ctx = ctx
        self.flags: list[Flag] = []

    def inlines(self, items: Sequence[Inline], at: str, *, typed: bool = True) -> list[Inline]:
        out: list[Inline] = []
        for item in items:
            if isinstance(item, XRef) and item.target_id.startswith(BOOKMARK):
                out.extend(self.bookmark(item, at))
            elif isinstance(item, Link):
                out.append(
                    Link(href=item.href, inlines=self.inlines(item.inlines, at, typed=False))
                )
            elif isinstance(item, Text) and typed:
                out.extend(self.typed(item, at))
            else:
                out.append(item)
        return merge_runs(out)

    def bookmark(self, xref: XRef, at: str) -> list[Inline]:
        name = xref.target_id.removeprefix(BOOKMARK)
        target = self.ctx.bookmarks.get(name)
        if target is not None:
            return [XRef(target_id=target, text=xref.text)]
        self.flags.append(
            Flag(
                code="xref_unmatched",
                severity="warning",
                at=at,
                message=f"cross-reference to unknown bookmark {name!r}: {xref.text!r}",
            )
        )
        return [Text(text=xref.text)]

    def typed(self, item: Text, at: str) -> list[Inline]:
        out: list[Inline] = []
        done = 0
        for match in TYPED_REFERENCE.finditer(item.text):
            label, digits = match.group(1), match.group(2)
            target = (
                self.ctx.caption_number_map.get((label.lower(), int(digits)))
                if len(digits) <= _MAX_DIGITS
                else None
            )
            if target is None:
                self.flags.append(
                    Flag(
                        code="xref_unmatched",
                        severity="info",
                        at=at,
                        message=f"no caption numbered {match.group(0)!r} in the source",
                    )
                )
                continue
            if match.start() > done:
                out.append(Text(text=item.text[done : match.start()], marks=item.marks))
            out.append(XRef(target_id=target, text=match.group(0)))
            done = match.end()
        if done == 0:
            return [item]
        if done < len(item.text):
            out.append(Text(text=item.text[done:], marks=item.marks))
        return out

    def blocks(self, blocks: Sequence[Block]) -> list[Block]:
        return [self.block(b) for b in blocks]

    def block(self, block: Block) -> Block:
        if isinstance(block, Paragraph):
            return block.model_copy(update={"inlines": self.inlines(block.inlines, block.id)})
        if isinstance(block, ListBlock):
            items = [ListItem(blocks=self.blocks(item.blocks)) for item in block.items]
            return block.model_copy(update={"items": items})
        if isinstance(block, Table):
            rows = [
                Row(cells=[c.model_copy(update={"blocks": self.blocks(c.blocks)}) for c in r.cells])
                for r in block.rows
            ]
            notes = [
                TableNote(marker=n.marker, inlines=self.inlines(n.inlines, block.id))
                for n in block.notes
            ]
            caption = self.inlines(block.caption, block.id, typed=False)
            return block.model_copy(update={"rows": rows, "notes": notes, "caption": caption})
        if isinstance(block, Figure):
            caption = self.inlines(block.caption, block.id, typed=False)
            return block.model_copy(update={"caption": caption})
        return block

    def section(self, section: Section) -> Section:
        return section.model_copy(
            update={
                "title": self.inlines(section.title, section.id),
                "blocks": self.blocks(section.blocks),
                "sections": [self.section(s) for s in section.sections],
            }
        )


def resolve_references(doc: DecomposedDocument, ctx: InlineContext) -> DecomposedDocument:
    """The document with every bookmark cross-reference pointed at its element and typed
    references matched, as a new document; what can't be resolved keeps its text and is
    flagged `xref_unmatched` in the report."""
    resolver = _Resolver(ctx)
    blocks = resolver.blocks(doc.blocks)
    sections = [resolver.section(s) for s in doc.sections]
    notes = [n.model_copy(update={"blocks": resolver.blocks(n.blocks)}) for n in doc.notes]
    return doc.model_copy(
        update={
            "blocks": blocks,
            "sections": sections,
            "notes": notes,
            "report": [*doc.report, *resolver.flags],
        }
    )
