"""PDF tables: Docling's grid filled with the PDF's own text (spec section 4.6).

A table that ends a page and one that starts the next, with the same columns, are joined first,
the continuation's repeated header rows removed. A table is then built: its caption (Docling's,
a "Table 3:" piece beside it, or a spanning first row), its notes (marker pieces after it, or
marker rows at the foot of its grid), its header rows, cell alignment and column widths. Every
char stays accounted for in the ledger: owned by the table's ref, or dropped with a reason.
Every table is flagged `structure_inferred`: Docling's grid and merges can't be proven.
"""

from __future__ import annotations

import re
import unicodedata
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, replace
from itertools import pairwise
from statistics import median
from typing import Literal

from ingest_worker.decompose.ids import child_id
from ingest_worker.decompose.inline import merge_runs
from ingest_worker.decompose.model import (
    Block,
    Cell,
    Flag,
    Inline,
    Paragraph,
    Row,
    Table,
    TableNote,
    Text,
)
from ingest_worker.decompose.pdf.layout import BBox, LayoutCell, LayoutTable
from ingest_worker.decompose.pdf.pieces import Ledger, Line, Piece
from ingest_worker.decompose.pdf.textlayer import PageText, TextLayer
from ingest_worker.decompose.tables import CAPTION_PREFIX, NOTE_PREFIX, caption_key

#: Columns line up when their left edges are within this fraction of the table's width.
_COLUMN_TOLERANCE = 0.05
#: Text is centred when its side gaps are within this fraction of the cell's width.
_CENTRE_TOLERANCE = 0.15
#: Text is right-aligned when its right gap is under this fraction of its left gap.
_RIGHT_RATIO = 1 / 3
#: Vertical alignment needs at least this many lines (font sizes) of free height in the cell.
_FREE_LINES = 1.5

HAlign = Literal["left", "center", "right"]
VAlign = Literal["top", "middle", "bottom"]
Key = tuple[int, int]


@dataclass(frozen=True)
class JoinedTable(LayoutTable):
    """A table joined across pages: its rows are the first part's, then each continuation's."""

    last_page: int = 0


def _last_page(piece: Piece) -> int:
    return piece.table.last_page if isinstance(piece.table, JoinedTable) else piece.page


def _is_body(piece: Piece) -> bool:
    return piece.layer != "furniture" and bool(
        piece.lines or piece.table is not None or piece.picture is not None
    )


def _dims(table: LayoutTable) -> tuple[int, int]:
    """Rows and columns, enough to hold every cell."""
    rows = max([table.rows, *(c.row + max(c.row_span, 1) for c in table.cells)])
    cols = max([table.cols, *(c.col + max(c.col_span, 1) for c in table.cells)])
    return rows, cols


def _text(lines: Iterable[Line]) -> str:
    return " ".join(t for t in (line.text for line in lines) if t)


def _key(text: str) -> str:
    """Text normalised, whitespace removed: what repeated header cells and captions match on."""
    return re.sub(r"\s+", "", unicodedata.normalize("NFKC", text).casefold())


def _cell_key(lines: Iterable[Line]) -> str:
    return _key(_text(lines))


def _origins(table: LayoutTable) -> dict[Key, LayoutCell]:
    """Each origin cell by (row, col), the first one Docling gave at a position."""
    out: dict[Key, LayoutCell] = {}
    for cell in table.cells:
        out.setdefault((cell.row, cell.col), cell)
    return out


def _column_lefts(table: LayoutTable) -> dict[int, float]:
    lefts: dict[int, float] = {}
    for cell in table.cells:
        if cell.bbox is not None:
            lefts[cell.col] = min(lefts.get(cell.col, cell.bbox[0]), cell.bbox[0])
    return lefts


# --- Joining ---------------------------------------------------------------------------------


def join_split_tables(pieces: list[Piece], text: TextLayer, ledger: Ledger) -> list[Piece]:
    """The pieces with each table continued at the top of the next page joined to the table
    that ends the page before; a joined piece keeps the first's ref."""
    kinds = {p.index: p.kind for p in text.pages}
    out: list[Piece] = []
    for piece in pieces:
        previous = next((i for i in range(len(out) - 1, -1, -1) if _is_body(out[i])), None)
        if (
            piece.table is not None
            and _is_body(piece)
            and previous is not None
            and _joins(out[previous], piece, kinds)
        ):
            out[previous] = _join(out[previous], piece, ledger)
            continue
        out.append(piece)
    return out


def _joins(first: Piece, second: Piece, kinds: Mapping[int, str]) -> bool:
    """Whether `second`, the first body piece on its page, continues `first`, the body piece
    just before it."""
    if first.table is None or second.table is None:
        return False
    last = _last_page(first)
    if second.page != last + 1 or kinds.get(last) != kinds.get(second.page):
        return False
    if first.table.label != "table" or second.table.label != "table":
        return False
    cols = _dims(first.table)[1]
    if cols != _dims(second.table)[1]:
        return False
    a, b = _column_lefts(first.table), _column_lefts(second.table)
    if set(a) != set(range(cols)) or set(b) != set(range(cols)):
        return False
    reach = _COLUMN_TOLERANCE * (first.bbox[2] - first.bbox[0])
    return all(abs(a[c] - b[c]) <= reach for c in range(cols))


def _row_keys(piece: Piece, row: int) -> list[tuple[int, int, str]]:
    assert piece.table is not None and piece.cells is not None
    return sorted(
        (c.col, c.col_span, _cell_key(piece.cells.get((c.row, c.col), [])))
        for c in _origins(piece.table).values()
        if c.row == row
    )


def _repeated_rows(first: Piece, second: Piece) -> int:
    """How many of `second`'s leading rows repeat `first`'s first rows."""
    assert first.table is not None and second.table is not None
    limit = min(_dims(first.table)[0], _dims(second.table)[0])
    count = 0
    while count < limit:
        keys = _row_keys(second, count)
        if not any(k for _, _, k in keys) or keys != _row_keys(first, count):
            break
        count += 1
    # A cell that spans from a repeated row into a kept one keeps its row, and those after it.
    while count and any(
        c.row < count < c.row + c.row_span for c in _origins(second.table).values()
    ):
        count -= 1
    return count


def _join(first: Piece, second: Piece, ledger: Ledger) -> Piece:
    assert first.table is not None and second.table is not None
    assert first.cells is not None and second.cells is not None
    repeated = _repeated_rows(first, second)
    rows = _dims(first.table)[0]

    # The first part's spans stop at the join: a merge can't be proven across pages.
    cells = [
        replace(c, row_span=min(c.row_span, rows - c.row)) if c.row + c.row_span > rows else c
        for c in first.table.cells
    ]
    joined_cells = dict(first.cells)
    for (r, c), lines in second.cells.items():
        if r < repeated:
            for line in lines:
                for ch in line.chars:
                    ledger.drop(line.page, ch.index, "repeated-header")
        else:
            joined_cells[(r - repeated + rows, c)] = lines
    ledger.rename(second.ref, first.ref)
    cells += [
        replace(cell, row=cell.row - repeated + rows)
        for cell in second.table.cells
        if cell.row >= repeated
    ]
    table = JoinedTable(
        first.table.ref,
        first.table.page,
        first.table.bbox,
        rows + _dims(second.table)[0] - repeated,
        _dims(first.table)[1],
        tuple(cells),
        first.table.captions + second.table.captions,
        first.table.label,
        last_page=_last_page(second),
    )
    return replace(first, table=table, cells=joined_cells)


# --- Building --------------------------------------------------------------------------------


@dataclass
class _Slot:
    cell: LayoutCell
    lines: list[Line]


def _grid(piece: Piece) -> tuple[int, int, dict[Key, _Slot], dict[Key, Key]]:
    """The grid's size, its origin cells with their lines, and which origin covers each slot.

    Spans are Docling's, clipped to the grid and to cells already placed; a cell whose own slot
    is covered by an earlier span gives its lines to that span, so no text is lost.
    """
    assert piece.table is not None
    table = piece.table
    cells_lines = piece.cells or {}
    origins = _origins(table)
    for key in cells_lines:
        if key not in origins:
            origins[key] = LayoutCell(key[0], key[1], 1, 1, None, False)
    rows, cols = _dims(table)
    rows = max([rows, 1, *(r + 1 for r, _ in origins)])
    cols = max([cols, 1, *(c + 1 for _, c in origins)])
    slots: dict[Key, _Slot] = {}
    covered: dict[Key, Key] = {}
    for key in sorted(origins):
        cell = origins[key]
        lines = list(cells_lines.get(key, []))
        if key in covered:
            slots[covered[key]].lines.extend(lines)
            continue
        r, c = key
        col_span = 1
        while col_span < max(cell.col_span, 1) and c + col_span < cols:
            if (r, c + col_span) in covered:
                break
            col_span += 1
        row_span = 1
        while row_span < max(cell.row_span, 1) and r + row_span < rows:
            if any((r + row_span, c + k) in covered for k in range(col_span)):
                break
            row_span += 1
        for dr in range(row_span):
            for dc in range(col_span):
                covered[(r + dr, c + dc)] = key
        slots[key] = _Slot(replace(cell, row_span=row_span, col_span=col_span), lines)
    return rows, cols, slots, covered


def _sole_cell(
    row: int, cols: int, slots: dict[Key, _Slot], covered: dict[Key, Key]
) -> _Slot | None:
    """The row's one cell, if it spans the whole row and only that row; else None."""
    slot = slots.get((row, 0))
    if slot is None or slot.cell.col_span != cols or slot.cell.row_span != 1:
        return None
    if any(covered.get((row, c)) != (row, 0) for c in range(cols)):
        return None
    return slot


def _inlines(lines: Iterable[Line]) -> list[Inline]:
    """Lines joined with single spaces, runs merged by marks (as `Piece.inlines`)."""
    runs: list[Inline] = []
    for line in lines:
        line_runs = line.runs()
        if runs and line_runs:
            runs.append(Text(text=" "))
        runs.extend(line_runs)
    return merge_runs(runs)


def _split_prefix(line: Line, length: int) -> tuple[list[int], Line | None]:
    """The indexes of the chars that make the first `length` characters of `line.text` (and
    the blanks after them), and the line without them, or None when nothing is left."""
    wanted = line.text[:length].rstrip()
    chars = line.chars
    k = 0
    if wanted:
        k = next(
            (
                n
                for n in range(1, len(chars) + 1)
                if Line(line.page, chars[:n], line.bbox).text == wanted
            ),
            0,
        )
        if k == 0:
            return [], line
    while k < len(chars) and chars[k].text.isspace():
        k += 1
    rest = chars[k:]
    return [c.index for c in chars[:k]], (Line(line.page, rest, line.bbox) if rest else None)


def _owned_by(lines: Iterable[Line], ref: str, ledger: Ledger) -> None:
    for line in lines:
        for c in line.chars:
            ledger.reassign(line.page, c.index, ref)


def _is_text(piece: Piece) -> bool:
    return (
        piece.layer != "furniture"
        and bool(piece.lines)
        and piece.table is None
        and piece.picture is None
        and piece.heading_level is None
    )


@dataclass
class _Caption:
    lines: list[Line]
    position: Literal["above", "below"]
    ref: str | None  # the piece it was, if not a row of the grid


def _find_caption(piece: Piece, before: list[Piece], after: list[Piece]) -> _Caption | None:
    """Docling's caption beside the table, else a "Table N" piece just above or below it."""
    assert piece.table is not None
    neighbours: list[Piece] = []
    if before and _is_text(before[-1]) and before[-1].page == piece.page:
        neighbours.append(before[-1])
    if after and _is_text(after[0]) and after[0].page == _last_page(piece):
        neighbours.append(after[0])
    docling = {k for k in map(_key, piece.table.captions) if k}
    chosen = next((p for p in neighbours if _cell_key(p.lines) in docling), None)
    if chosen is None:
        chosen = next(
            (
                p
                for p in neighbours
                if (m := CAPTION_PREFIX.match(p.lines[0].text)) and m.group(1).lower() == "table"
            ),
            None,
        )
    if chosen is None:
        return None
    above = (chosen.page, chosen.bbox[1]) < (piece.page, piece.bbox[1])
    return _Caption(list(chosen.lines), "above" if above else "below", chosen.ref)


def _caption_inlines(caption: _Caption, ledger: Ledger) -> tuple[list[Inline], bool]:
    """The caption without its "Table N:" prefix, whose chars are dropped, and whether it had
    one."""
    lines = caption.lines
    match = CAPTION_PREFIX.match(lines[0].text) if lines else None
    if match is None:
        return _inlines(lines), False
    dropped, rest = _split_prefix(lines[0], match.end())
    if not dropped:
        return _inlines(lines), False
    for index in dropped:
        ledger.drop(lines[0].page, index, "caption-number")
    kept = ([rest] if rest is not None else []) + lines[1:]
    return _inlines(kept), True


def _notes(lines: list[Line]) -> list[TableNote]:
    """One note per line that starts with a marker; a line that doesn't continues the note
    before it."""
    groups: list[tuple[str, list[Line]]] = []
    for line in lines:
        match = NOTE_PREFIX.match(line.text)
        if match is not None:
            _, rest = _split_prefix(line, match.end())
            groups.append((match.group(1), [rest] if rest is not None else []))
        elif groups:
            groups[-1][1].append(line)
        else:
            groups.append(("", [line]))
    return [TableNote(marker=marker, inlines=_inlines(body)) for marker, body in groups]


def _is_note(lines: list[Line]) -> bool:
    return bool(lines) and NOTE_PREFIX.match(lines[0].text) is not None


def _bounds(lines: list[Line]) -> BBox:
    return (
        min(line.bbox[0] for line in lines),
        min(line.bbox[1] for line in lines),
        max(line.bbox[2] for line in lines),
        max(line.bbox[3] for line in lines),
    )


def _alignment(cell: LayoutCell, lines: list[Line]) -> tuple[HAlign, VAlign]:
    box = cell.bbox
    if box is None or not lines:
        return "left", "top"
    tx0, ty0, tx1, ty1 = _bounds(lines)
    width, height = box[2] - box[0], box[3] - box[1]
    left, right = max(tx0 - box[0], 0.0), max(box[2] - tx1, 0.0)
    h: HAlign = "left"
    if width > 0 and abs(left - right) <= _CENTRE_TOLERANCE * width:
        h = "center"
    elif right < _RIGHT_RATIO * left:
        h = "right"
    v: VAlign = "top"
    # A line's height is its font size: a glyph box is tighter than the line it sits in.
    line_height = median(c.size for line in lines for c in line.chars)
    if height > 0 and height - (ty1 - ty0) >= _FREE_LINES * line_height:
        centre = ((ty0 + ty1) / 2 - box[1]) / height
        if centre > 2 / 3:
            v = "bottom"
        elif centre >= 1 / 3:
            v = "middle"
    return h, v


def _column_widths(slots: Iterable[_Slot], cols: int) -> list[float]:
    """Relative widths from the cells' x boundaries, summing to 1; equal when they can't be
    read."""
    lefts: dict[int, float] = {}
    right: float | None = None
    for slot in slots:
        box = slot.cell.bbox
        if box is None:
            continue
        col = slot.cell.col
        lefts[col] = min(lefts.get(col, box[0]), box[0])
        if col + slot.cell.col_span == cols:
            right = box[2] if right is None else max(right, box[2])
    if set(lefts) == set(range(cols)) and right is not None:
        edges = [lefts[c] for c in range(cols)] + [right]
        widths = [b - a for a, b in pairwise(edges)]
        if all(w > 0 for w in widths):
            total = sum(widths)
            return [w / total for w in widths]
    return [1 / cols] * cols


def build_table(
    piece: Piece,
    table_id: str,
    pieces_after: list[Piece],
    pieces_before: list[Piece],
    ledger: Ledger,
    page: PageText,
) -> tuple[Table, set[str], list[Flag]]:
    """The `Table` of a table piece, the refs of the pieces it took as its caption and notes,
    and its `structure_inferred` flag.

    The chars of those pieces become the table's (owned by its piece's ref); a caption's
    number is dropped as `caption-number`.
    """
    assert piece.table is not None
    rows, cols, slots, covered = _grid(piece)
    consumed: set[str] = set()

    # The caption: Docling's or a piece beside the table, else a spanning first row.
    caption = _find_caption(piece, pieces_before, pieces_after)
    first_row = 0
    if caption is None and rows > 1:
        slot = _sole_cell(0, cols, slots, covered)
        if slot is not None and slot.lines and CAPTION_PREFIX.match(slot.lines[0].text):
            caption = _Caption(slot.lines, "above", None)
            first_row = 1
    caption_inlines: list[Inline] = []
    numbered = False
    if caption is not None:
        if caption.ref is not None:
            consumed.add(caption.ref)
            _owned_by(caption.lines, piece.ref, ledger)
        caption_inlines, numbered = _caption_inlines(caption, ledger)

    # Note rows at the foot of the grid leave it, never its first row.
    last_row = rows
    while last_row - 1 > first_row:
        slot = _sole_cell(last_row - 1, cols, slots, covered)
        if slot is None or not _is_note(slot.lines):
            break
        last_row -= 1
    notes: list[TableNote] = []
    for r in range(last_row, rows):
        notes.extend(_notes(slots[(r, 0)].lines))
    moved = last_row < rows

    # Notes after the table: the marker pieces that follow it (after a caption below it).
    start = 1 if caption is not None and pieces_after and caption.ref == pieces_after[0].ref else 0
    for after in pieces_after[start:]:
        if not (_is_text(after) and after.page == _last_page(piece) and _is_note(after.lines)):
            break
        consumed.add(after.ref)
        _owned_by(after.lines, piece.ref, ledger)
        notes.extend(_notes(after.lines))

    kept = range(first_row, last_row)
    header_rows = 0
    for r in kept:
        own = [s for (row, _), s in slots.items() if row == r]
        if not own or not all(s.cell.header for s in own):
            break
        header_rows += 1

    built: list[Row] = []
    ordinal = 0
    for n, r in enumerate(kept):
        header = n < header_rows
        cells: list[Cell] = []
        for c in range(cols):
            origin = covered.get((r, c))
            if origin is not None and origin != (r, c):
                continue
            ordinal += 1
            if origin is None:
                cells.append(Cell(header=header, blocks=[]))
                continue
            slot = slots[origin]
            inlines = _inlines(slot.lines)
            blocks: list[Block] = []
            if inlines:
                cell_id = child_id(table_id, "cell", ordinal)
                blocks.append(Paragraph(id=child_id(cell_id, "p", 1), inlines=inlines))
            h_align, v_align = _alignment(slot.cell, slot.lines)
            cells.append(
                Cell(
                    row_span=min(slot.cell.row_span, last_row - r),
                    col_span=slot.cell.col_span,
                    h_align=h_align,
                    v_align=v_align,
                    header=header,
                    blocks=blocks,
                )
            )
        built.append(Row(cells=cells))

    message = "Table grid inferred from layout"
    if _last_page(piece) != piece.page:
        message += f"; joined across pages {piece.page + 1}–{_last_page(piece) + 1}"  # noqa: RUF001
    if moved:
        message += "; notes moved out of the grid"
    flag = Flag(code="structure_inferred", severity="warning", at=table_id, message=message)

    table = Table(
        id=table_id,
        numbered=numbered,
        caption=caption_inlines,
        caption_position=caption.position if caption is not None else "above",
        column_widths=_column_widths(
            (s for (r, _), s in slots.items() if first_row <= r < last_row), cols
        ),
        header_rows=header_rows,
        rows=built,
        notes=notes,
        wide=page.width > page.height,
        key=caption_key(caption_inlines) if caption is not None else None,
    )
    return table, consumed, [flag]
