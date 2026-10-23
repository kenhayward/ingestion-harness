"""Word tables as decomposed `Table` blocks, and the source grid the fidelity check compares.

The grid is Word's own. `w:tblGrid/w:gridCol` gives the columns (widened if a row is wider),
`w:gridSpan` a cell's column span, and `w:vMerge` its row span: a `restart` cell absorbs the
`continue` cells (`w:vMerge` with no value, or `continue`) directly below it that start in the
same grid column with the same column span, and takes their content after its own. A continue
cell under no merge is a cell of its own; one that overlaps a merge above without lining up
with it is ambiguous and refused. Slots a row leaves empty (`w:gridBefore`, `w:gridAfter`, or a
row short of the grid) become empty cells, one per slot. A row deleted by a tracked change is
dropped; tracked cell-level changes and legacy horizontal merges are refused.

`source_grid` resolves the grid slot by slot from the raw XML, and `table_of` builds cells with
their spans; the two share only the reading of single elements, so a mistake in either one's
merge logic shows up as a difference the fidelity check refuses.
"""

from __future__ import annotations

from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from typing import Literal
from xml.etree.ElementTree import Element

from .ids import child_id
from .inline import InlineContext, W
from .model import Block, Cell, Row, Table
from .package import DecompositionFailed

#: Reads the block content of a container element (a table cell) into blocks whose ids are
#: built from the given prefix.
WalkBlocks = Callable[[Element, str], list[Block]]

HAlign = Literal["left", "center", "right", "justify"]
VAlign = Literal["top", "middle", "bottom"]
VMerge = Literal["restart", "continue"]

_OFF = {"0", "false", "off"}
_CELL_CHANGES = ("cellIns", "cellDel", "cellMerge")
_AMBIGUOUS = "ambiguous vertical merge in table"
#: Far beyond Word's own 63 columns; a source claiming more is refused, not allocated.
MAX_COLUMNS = 1000
_WRAPPERS = {f"{W}sdt", f"{W}sdtContent", f"{W}customXml"}
_H_ALIGN: dict[str, HAlign] = {
    "left": "left",
    "start": "left",
    "center": "center",
    "right": "right",
    "end": "right",
    "both": "justify",
    "distribute": "justify",
}
_V_ALIGN: dict[str, VAlign] = {"top": "top", "center": "middle", "bottom": "bottom"}


# --- Reading single elements (shared) ------------------------------------------------------


def _unwrapped(parent: Element, tag: str) -> Iterator[Element]:
    """Children of `parent` with `tag`, looking through content controls and custom XML."""
    for child in parent:
        if child.tag == tag:
            yield child
        elif child.tag in _WRAPPERS:
            yield from _unwrapped(child, tag)


def _int_val(el: Element | None, default: int) -> int:
    if el is None:
        return default
    try:
        return int(el.get(f"{W}val", ""))
    except ValueError:
        return default


def _rows(tbl: Element) -> list[Element]:
    """The table's rows, without those deleted by a tracked change."""
    return [tr for tr in _unwrapped(tbl, f"{W}tr") if tr.find(f"{W}trPr/{W}del") is None]


def _cells(tr: Element) -> list[Element]:
    cells = list(_unwrapped(tr, f"{W}tc"))
    for tc in cells:
        if tc.find(f"{W}tcPr/{W}hMerge") is not None:
            raise DecompositionFailed("a horizontally merged cell (w:hMerge) is not supported")
        if any(tc.find(f"{W}tcPr/{W}{tag}") is not None for tag in _CELL_CHANGES):
            raise DecompositionFailed(
                "tracked cell changes are not supported; accept them in Word first"
            )
    return cells


def _gaps(tr: Element) -> tuple[int, int]:
    """The empty grid slots before and after the row's cells."""
    before = _int_val(tr.find(f"{W}trPr/{W}gridBefore"), 0)
    after = _int_val(tr.find(f"{W}trPr/{W}gridAfter"), 0)
    return max(before, 0), max(after, 0)


def _span(tc: Element) -> int:
    return max(_int_val(tc.find(f"{W}tcPr/{W}gridSpan"), 1), 1)


def _vmerge(tc: Element) -> VMerge | None:
    el = tc.find(f"{W}tcPr/{W}vMerge")
    if el is None:
        return None
    return "restart" if el.get(f"{W}val") == "restart" else "continue"


def _grid_columns(tbl: Element) -> list[int | None]:
    """The width in twips of each `w:gridCol`, or None where it has none."""
    widths: list[int | None] = []
    for col in tbl.findall(f"{W}tblGrid/{W}gridCol"):
        try:
            width: int | None = int(col.get(f"{W}w", ""))
        except ValueError:
            width = None
        widths.append(width if width is not None and width > 0 else None)
    return widths


def _width(tbl: Element, rows: list[Element]) -> int:
    """The number of grid columns: the declared grid, or the widest row if that is wider."""
    widest = 0
    for tr in rows:
        before, after = _gaps(tr)
        widest = max(widest, before + sum(_span(tc) for tc in _cells(tr)) + after)
    width = max(len(_grid_columns(tbl)), widest)
    if width > MAX_COLUMNS:
        raise DecompositionFailed(f"a table {width} grid columns wide (at most {MAX_COLUMNS})")
    return width


# --- Source grid -----------------------------------------------------------------------------


@dataclass(frozen=True)
class GridSlot:
    """One slot of the grid: the (row, column) of the cell that covers it, and that cell's text."""

    origin: tuple[int, int]
    text: str


def _plain_text(tc: Element) -> str:
    """The cell's `w:t` text, one line per paragraph, nested tables included.

    Deleted and moved-away runs (`w:del`, `w:moveFrom`; `w:delText` is never `w:t`), rows
    deleted at any depth, and text-box content (accounted for as image alt text) are left out.
    """
    return "\n".join(_lines(tc))


def _excluded(el: Element) -> bool:
    if el.tag in (f"{W}del", f"{W}moveFrom", f"{W}txbxContent"):
        return True
    return el.tag == f"{W}tr" and el.find(f"{W}trPr/{W}del") is not None


def _lines(el: Element) -> Iterator[str]:
    for child in el:
        if _excluded(child):
            continue
        if child.tag == f"{W}p":
            yield "".join(_texts(child))
        else:
            yield from _lines(child)


def _texts(el: Element) -> Iterator[str]:
    for child in el:
        if _excluded(child) or child.tag == f"{W}p":
            continue
        if child.tag == f"{W}t":
            yield child.text or ""
        else:
            yield from _texts(child)


@dataclass(frozen=True)
class _Owner:
    """What covers a slot: the cell's origin, its column span, and whether it can continue."""

    origin: tuple[int, int]
    span: int
    mergeable: bool


def source_grid(tbl: Element) -> list[list[GridSlot]]:
    """The table's grid, resolved from Word's markup: one row of slots per kept row."""
    rows = _rows(tbl)
    width = _width(tbl, rows)
    texts: dict[tuple[int, int], str] = {}
    slots: list[list[_Owner]] = []
    above: list[_Owner | None] = [None] * width
    for r, tr in enumerate(rows):
        owners: list[_Owner] = []
        before, _ = _gaps(tr)
        for _ in range(before):
            owners.append(_Owner((r, len(owners)), 1, mergeable=False))
        for tc in _cells(tr):
            c, span, merge = len(owners), _span(tc), _vmerge(tc)
            up = above[c]
            merging = [o for o in above[c : c + span] if o is not None and o.mergeable]
            if merge == "continue" and up in merging and up.origin[1] == c and up.span == span:
                owner = up
                text = _plain_text(tc)
                if text.strip():
                    texts[owner.origin] = "\n".join(t for t in (texts[owner.origin], text) if t)
            elif merge == "continue" and merging:
                raise DecompositionFailed(_AMBIGUOUS)
            else:
                owner = _Owner((r, c), span, mergeable=merge == "restart")
                texts[owner.origin] = _plain_text(tc)
            owners.extend([owner] * span)
        while len(owners) < width:
            owners.append(_Owner((r, len(owners)), 1, mergeable=False))
        slots.append(owners)
        above = list(owners)
    return [[GridSlot(o.origin, texts.get(o.origin, "")) for o in row] for row in slots]


# --- Table -----------------------------------------------------------------------------------


@dataclass
class _Entry:
    """A cell as placed in its row; filler entries have no element."""

    col: int
    span: int
    tc: Element | None = None
    merge: VMerge | None = None
    head: _Entry | None = None  # for a continue cell: the restart cell that absorbs it
    row_span: int = 1
    blocks: list[Block] = field(default_factory=list)


def _layout(tr: Element, width: int) -> list[_Entry]:
    before, _ = _gaps(tr)
    entries = [_Entry(col, 1) for col in range(before)]
    col = before
    for tc in _cells(tr):
        span = _span(tc)
        entries.append(_Entry(col, span, tc, _vmerge(tc)))
        col += span
    entries.extend(_Entry(c, 1) for c in range(col, width))
    return entries


def _resolve_merges(layouts: list[list[_Entry]], table_id: str) -> None:
    """Join continue cells to the restart cell above, and count each origin's row span."""
    heads: dict[int, _Entry] = {}  # start column -> a merge head whose chain is still open
    for row in layouts:
        nxt: dict[int, _Entry] = {}
        for entry in row:
            if entry.merge == "continue":
                head = heads.get(entry.col)
                if head is not None and head.span == entry.span:
                    entry.head = head
                    head.row_span += 1
                    nxt[entry.col] = head
                elif any(
                    h.col < entry.col + entry.span and entry.col < h.col + h.span
                    for h in heads.values()
                ):
                    raise DecompositionFailed(f"{_AMBIGUOUS} {table_id}", at=table_id)
            elif entry.merge == "restart":
                nxt[entry.col] = entry
        heads = nxt


def _h_align(tc: Element) -> HAlign:
    first = next(_unwrapped(tc, f"{W}p"), None)
    jc = first.find(f"{W}pPr/{W}jc") if first is not None else None
    return _H_ALIGN.get(jc.get(f"{W}val", "") if jc is not None else "", "left")


def _v_align(tc: Element) -> VAlign:
    el = tc.find(f"{W}tcPr/{W}vAlign")
    return _V_ALIGN.get(el.get(f"{W}val", "") if el is not None else "", "top")


def _is_header(tr: Element) -> bool:
    el = tr.find(f"{W}trPr/{W}tblHeader")
    return el is not None and el.get(f"{W}val", "1").lower() not in _OFF


def _column_widths(tbl: Element, width: int) -> list[float]:
    """Relative widths summing to 1; a column without a width gets the mean of the others."""
    declared = _grid_columns(tbl)[:width]
    declared += [None] * (width - len(declared))
    known = [w for w in declared if w is not None]
    fallback = sum(known) / len(known) if known else 1.0
    widths = [float(w) if w is not None else fallback for w in declared]
    total = sum(widths)
    return [w / total for w in widths]


def _count_changes(tbl: Element, ctx: InlineContext) -> None:
    for tr in _unwrapped(tbl, f"{W}tr"):
        for tag in ("ins", "del"):
            if tr.find(f"{W}trPr/{W}{tag}") is not None:
                ctx.changes += 1


def table_of(tbl: Element, ctx: InlineContext, *, id: str, walk_blocks: WalkBlocks) -> Table:
    """The `Table` for a `w:tbl` element; cell blocks are read through `walk_blocks`."""
    try:
        rows = _rows(tbl)
        width = _width(tbl, rows)
    except DecompositionFailed as failed:
        raise DecompositionFailed(failed.detail, at=id) from None
    _count_changes(tbl, ctx)
    layouts = [_layout(tr, width) for tr in rows]
    _resolve_merges(layouts, id)

    # Read every cell in document order; a continue cell's content goes after its origin's.
    ordinal = 0
    for row in layouts:
        for entry in row:
            ordinal += 1
            if entry.tc is not None:
                blocks = walk_blocks(entry.tc, child_id(id, "cell", ordinal))
                (entry.head or entry).blocks.extend(blocks)

    header_rows = 0
    while header_rows < len(rows) and _is_header(rows[header_rows]):
        header_rows += 1

    built: list[Row] = []
    for r, row in enumerate(layouts):
        cells: list[Cell] = []
        for entry in row:
            if entry.head is not None:
                continue
            header = r < header_rows
            if entry.tc is None:
                cells.append(Cell(header=header, blocks=[]))
                continue
            cells.append(
                Cell(
                    row_span=entry.row_span,
                    col_span=entry.span,
                    h_align=_h_align(entry.tc),
                    v_align=_v_align(entry.tc),
                    header=header,
                    blocks=entry.blocks,
                )
            )
        built.append(Row(cells=cells))

    return Table(
        id=id,
        column_widths=_column_widths(tbl, width),
        header_rows=header_rows,
        rows=built,
    )
