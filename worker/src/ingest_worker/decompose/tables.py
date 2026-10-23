"""Word tables as decomposed `Table` blocks (the real reader arrives with the table task)."""

from __future__ import annotations

from collections.abc import Callable
from xml.etree.ElementTree import Element

from .inline import InlineContext
from .model import Block, Table

#: Reads the block content of a container element (a table cell) into blocks whose ids are
#: built from the given prefix.
WalkBlocks = Callable[[Element, str], list[Block]]


def table_of(tbl: Element, ctx: InlineContext, *, id: str, walk_blocks: WalkBlocks) -> Table:
    """The `Table` for a `w:tbl` element."""
    raise NotImplementedError("table reading is not implemented yet")
