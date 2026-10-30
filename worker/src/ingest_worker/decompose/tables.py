"""Word tables as decomposed `Table` blocks, and the source grid the fidelity check compares.

The grid is Word's own. `w:tblGrid/w:gridCol` gives the columns (widened if a row is wider),
`w:gridSpan` a cell's column span, and `w:vMerge` its row span: a `restart` cell absorbs the
`continue` cells (`w:vMerge` with no value, or `continue`) directly below it that start in the
same grid column with the same column span. Their own content is left out: Word shows only the
restart cell's, and some generators repeat it in every continue cell. A row whose every slot
such a merge covers has no cell of its own and is left out, its merges one row shorter (a
sink refuses an empty row); the fidelity check's source walk leaves it out the same way. A continue cell under no merge is a cell of its own; one that overlaps a merge above without lining up
with it is ambiguous and refused. Slots a row leaves empty (`w:gridBefore`, `w:gridAfter`, or a
row short of the grid) become empty cells, one per slot. A row deleted by a tracked change is
dropped; tracked cell-level changes and legacy horizontal merges are refused. A table Word shows
nothing of (`hidden_table`) is no table at all, on both sides of the fidelity check.

`source_grid` resolves the grid slot by slot from the raw XML, and `table_of` builds cells with
their spans; the two share only the reading of single elements, so a mistake in either one's
merge logic shows up as a difference the fidelity check refuses.

Some source rows are not grid rows (§5.4). A first row of one full-width cell that starts
`Table n:` or holds a `SEQ Table` field is the caption, and trailing full-width rows typed as
notes (`a: ...`) are the notes when each marker appears superscript in the rest of the table;
note-like rows whose marker doesn't stay in the grid and are flagged. `structural_rows` names
these rows by their index in `source_grid`, which keeps every source row, so the fidelity check
can set them aside the same way `table_of` did.
"""

from __future__ import annotations

import re
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from typing import Literal
from xml.etree.ElementTree import Element

from .ids import child_id, normalise_title
from .inline import FieldState, InlineContext, RunStyles, W, inlines_of, merge_runs, plain_text
from .model import Block, Break, Cell, Flag, Inline, Paragraph, Row, Table, TableNote, Text
from .package import DecompositionFailed, DecompositionRejected

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
#: Grid slots (rows times columns) a table, and a whole document's tables, may have. Each slot
#: becomes a cell or a filler, so a tiny file could otherwise claim gigabytes.
MAX_TABLE_SLOTS = 20_000
MAX_DOCUMENT_SLOTS = 200_000
TABLE_TOO_LARGE = "table too large"
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

#: A caption number as the source displays it: `3`, `3-1`, `14.2.1`, `A.1`, `A1`. Its parts
#: are joined by a full stop, a hyphen, a (non-breaking) hyphen or an en dash.
CAPTION_NUMBER = r"(?:(?-i:[A-Z])[.\-\u2010\u2011\u2013]?)?\d+(?:[.\-\u2010\u2011\u2013]\d+)*"
#: A caption's label and whole number, typed or shown by a `SEQ` field, and the separator after
#: it: `Table 13:`, `Table 3-1:`, `Figure 1-`. The en and em dashes are separators too, as Word
#: users type them.
CAPTION_PREFIX = re.compile(
    rf"^\s*(Table|Figure)\s*({CAPTION_NUMBER})\s*[:.\-\u2013\u2014]?\s*", re.I
)
_NUMBER_DASHES = str.maketrans("\u2010\u2011\u2013", "---")
#: A table note's marker and separator: `a: `, `1. `, `*) `.
NOTE_PREFIX = re.compile(r"^\s*([a-z]|\d{1,2}|[*†‡§])\s*[:.)]\s+")
_SEPARATOR = r"\s*[:.\-–—]?\s*"  # noqa: RUF001
_SEQ_TABLE = re.compile(r"\bSEQ\s+Table\b", re.I)
_MARKER_SPLIT = re.compile(r"[\s,;()\[\]]+")

CaptionKind = Literal["table", "figure"]
NotesMatch = Literal["notes", "unrecognised"]


# --- Reading single elements (shared) ------------------------------------------------------

# `unwrapped`, `rows_of`, `cells_of`, `row_gaps`, `cell_span` and `note_markers` are shared with
# the fidelity check's source walk, which reads rows and cells the same way.


def unwrapped(parent: Element, tag: str) -> Iterator[Element]:
    """Children of `parent` with `tag`, looking through content controls and custom XML."""
    for child in parent:
        if child.tag == tag:
            yield child
        elif child.tag in _WRAPPERS:
            yield from unwrapped(child, tag)


def _int_val(el: Element | None, default: int) -> int:
    if el is None:
        return default
    try:
        return int(el.get(f"{W}val", ""))
    except ValueError:
        return default


def hidden_table(tbl: Element, styles: RunStyles) -> bool:
    """Whether Word shows nothing of the table: every row's end mark is hidden
    (`w:trPr/w:hidden`), and so is everything in it, every paragraph mark and every run.

    Such a table (template guidance hidden from print, found in use) is left out: its text is
    hidden text, which is dropped, and what would be left is an empty grid Word never shows.
    """
    rows = list(unwrapped(tbl, f"{W}tr"))
    if not rows or not all(_on(tr.find(f"{W}trPr/{W}hidden")) for tr in rows):
        return False
    return all(_hidden_paragraph(p, styles) for p in tbl.iter(f"{W}p"))


def _on(el: Element | None) -> bool:
    return el is not None and el.get(f"{W}val", "1").lower() not in _OFF


def _hidden_paragraph(p: Element, styles: RunStyles) -> bool:
    style_el = p.find(f"{W}pPr/{W}pStyle")
    style = style_el.get(f"{W}val") if style_el is not None else None
    if not styles.resolve(style, None, p.find(f"{W}pPr/{W}rPr"))["hidden"]:
        return False
    return all(_hidden_run(r, style, styles) for r in _runs(p))


def _runs(el: Element) -> Iterator[Element]:
    """The runs under `el` that Word shows were they not hidden: not deleted or moved away."""
    for child in el:
        if child.tag == f"{W}r":
            yield child
        elif child.tag not in (f"{W}del", f"{W}moveFrom", f"{W}pPr"):
            yield from _runs(child)


def _hidden_run(run: Element, paragraph_style: str | None, styles: RunStyles) -> bool:
    rpr = run.find(f"{W}rPr")
    if all(child is rpr for child in run):
        return True  # nothing to show
    style_el = rpr.find(f"{W}rStyle") if rpr is not None else None
    char_style = style_el.get(f"{W}val") if style_el is not None else None
    return styles.resolve(paragraph_style, char_style, rpr)["hidden"]


def rows_of(tbl: Element) -> list[Element]:
    """The table's rows, without those deleted by a tracked change."""
    return [tr for tr in unwrapped(tbl, f"{W}tr") if tr.find(f"{W}trPr/{W}del") is None]


def cells_of(tr: Element) -> list[Element]:
    """The row's cells; a legacy horizontal merge or a tracked cell change is refused."""
    cells = list(unwrapped(tr, f"{W}tc"))
    for tc in cells:
        if tc.find(f"{W}tcPr/{W}hMerge") is not None:
            raise DecompositionFailed("a horizontally merged cell (w:hMerge) is not supported")
        if any(tc.find(f"{W}tcPr/{W}{tag}") is not None for tag in _CELL_CHANGES):
            raise DecompositionFailed(
                "tracked cell changes are not supported; accept them in Word first"
            )
    return cells


def row_gaps(tr: Element) -> tuple[int, int]:
    """The empty grid slots before and after the row's cells."""
    before = _int_val(tr.find(f"{W}trPr/{W}gridBefore"), 0)
    after = _int_val(tr.find(f"{W}trPr/{W}gridAfter"), 0)
    return max(before, 0), max(after, 0)


def cell_span(tc: Element) -> int:
    """The number of grid columns the cell spans."""
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
    """The number of grid columns: the declared grid, or the widest row if that is wider.

    Checked before anything is built from the grid: a `w:gridBefore` or `w:gridAfter` that
    widens the grid on its own is malformed, and a grid of more than `MAX_TABLE_SLOTS` slots is
    refused. With a declared grid a gap may not exceed it; with none (or an empty one) the grid
    is the widest row's cells, and no gap may make a row wider than that.
    """
    declared = len(_grid_columns(tbl))
    measured = []
    for tr in rows:
        before, after = row_gaps(tr)
        cells = sum(cell_span(tc) for tc in cells_of(tr))
        measured.append((before, cells, after))
    # Without a declared grid, only the cells say how wide the table is.
    base = declared or max((cells for _, cells, _ in measured), default=0)
    what = f"{declared} grid columns" if declared else f"{base} columns of cells"
    widest = base
    for before, cells, after in measured:
        for name, gap in (("gridBefore", before), ("gridAfter", after)):
            too_wide = gap > declared if declared else gap and before + cells + after > base
            if too_wide:
                raise DecompositionFailed(
                    f"a row's {name} of {gap} is wider than the table's {what}"
                )
        widest = max(widest, before + cells + after)
    width = widest
    if width > MAX_COLUMNS:
        raise DecompositionFailed(f"a table {width} grid columns wide (at most {MAX_COLUMNS})")
    if len(rows) * width > MAX_TABLE_SLOTS:
        raise DecompositionRejected(TABLE_TOO_LARGE)
    return width


def count_slots(used: int, rows: int, width: int) -> int:
    """`used` grid slots of the document plus a table's, refused past `MAX_DOCUMENT_SLOTS`."""
    used += rows * width
    if used > MAX_DOCUMENT_SLOTS:
        raise DecompositionRejected(TABLE_TOO_LARGE)
    return used


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
    rows = rows_of(tbl)
    width = _width(tbl, rows)
    texts: dict[tuple[int, int], str] = {}
    slots: list[list[_Owner]] = []
    above: list[_Owner | None] = [None] * width
    for r, tr in enumerate(rows):
        owners: list[_Owner] = []
        before, _ = row_gaps(tr)
        for _ in range(before):
            owners.append(_Owner((r, len(owners)), 1, mergeable=False))
        for tc in cells_of(tr):
            c, span, merge = len(owners), cell_span(tc), _vmerge(tc)
            up = above[c]
            merging = [o for o in above[c : c + span] if o is not None and o.mergeable]
            if merge == "continue" and up in merging and up.origin[1] == c and up.span == span:
                owner = up  # its own content is hidden, as Word shows it
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
    before, _ = row_gaps(tr)
    entries = [_Entry(col, 1) for col in range(before)]
    col = before
    for tc in cells_of(tr):
        span = cell_span(tc)
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


def _drop_covered_rows(layouts: list[list[_Entry]]) -> set[int]:
    """The rows whose every slot a merge from above covers, with those merges shortened.

    Such a row has no cell of its own, which a sink refuses; Word shows it only as height.
    """
    covered = {r for r, row in enumerate(layouts) if all(e.head is not None for e in row)}
    for r in covered:
        for head in {id(e.head): e.head for e in layouts[r] if e.head is not None}.values():
            head.row_span -= 1
    return covered


def _h_align(tc: Element) -> HAlign:
    first = next(unwrapped(tc, f"{W}p"), None)
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
    for tr in unwrapped(tbl, f"{W}tr"):
        for tag in ("ins", "del"):
            if tr.find(f"{W}trPr/{W}{tag}") is not None:
                ctx.changes += 1


def table_of(
    tbl: Element, ctx: InlineContext, *, id: str, walk_blocks: WalkBlocks, wide: bool = False
) -> Table:
    """The `Table` for a `w:tbl` element; cell blocks are read through `walk_blocks`.

    A caption row and recognised note rows leave the grid for `caption` and `notes`; a caption
    in a paragraph beside the table is attached later, by the body.
    """
    try:
        rows = rows_of(tbl)
        width = _width(tbl, rows)
    except DecompositionFailed as failed:
        raise DecompositionFailed(failed.detail, at=id) from None
    ctx.grid_slots = count_slots(ctx.grid_slots, len(rows), width)
    _count_changes(tbl, ctx)
    structure = _structure(rows, width, ctx.styles)
    caption = None
    if structure.caption is not None:
        caption = _caption_row(cells_of(rows[structure.caption])[0], ctx, at=id)
    kept = [rows[i] for i in structure.grid_rows(len(rows))]
    layouts = [_layout(tr, width) for tr in kept]
    _resolve_merges(layouts, id)

    # Read every cell in document order; a continue cell's content is hidden, as Word shows it.
    ordinal = 0
    for row in layouts:
        for entry in row:
            ordinal += 1
            if entry.tc is not None and entry.head is None:
                entry.blocks.extend(walk_blocks(entry.tc, child_id(id, "cell", ordinal)))

    headers = 0
    while headers < len(kept) and _is_header(kept[headers]):
        headers += 1
    covered = _drop_covered_rows(layouts)
    header_rows = headers - sum(1 for r in covered if r < headers)
    layouts = [row for r, row in enumerate(layouts) if r not in covered]

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

    notes: list[TableNote] = []
    for i in structure.notes:
        tc = cells_of(rows[i])[0]
        notes.extend(_notes(_paragraph_inlines(tc, ctx, at=id), note_markers(tc) or []))
    if structure.unrecognised:
        flag_unrecognised_notes(ctx, id)
    if caption is not None:
        register_caption(ctx, caption, id)

    return Table(
        id=id,
        numbered=caption.numbered if caption is not None else False,
        caption=caption.inlines if caption is not None else [],
        column_widths=_column_widths(tbl, width),
        header_rows=header_rows,
        rows=built,
        notes=notes,
        wide=wide,
        key=caption_key(caption.inlines) if caption is not None else None,
    )


# --- Captions --------------------------------------------------------------------------------


@dataclass(frozen=True)
class Caption:
    """A caption's content without its label and number, and what that prefix declared."""

    inlines: list[Inline]
    kind: CaptionKind | None  # the label it gave, if any
    number: str | None  # the number the source displayed, as `caption_number` keys it
    numbered: bool


def caption_number(displayed: str) -> str:
    """A displayed caption number as `caption_number_map` keys it: its dashes as `-`."""
    return displayed.translate(_NUMBER_DASHES)


def _kind(label: str) -> CaptionKind | None:
    folded = label.casefold()
    return "table" if folded == "table" else "figure" if folded == "figure" else None


def _leading_text(inlines: Sequence[Inline]) -> str:
    """The text of the `Text` items before the first item of any other kind."""
    parts: list[str] = []
    for item in inlines:
        if not isinstance(item, Text):
            break
        parts.append(item.text)
    return "".join(parts)


def _strip_leading(inlines: Sequence[Inline], count: int) -> list[Inline]:
    """`inlines` without the first `count` characters of their leading text, and without the
    breaks that leaves at the start."""
    rest = list(inlines)
    while count > 0 and rest and isinstance(first := rest[0], Text):
        if len(first.text) > count:
            rest[0] = Text(text=first.text[count:], marks=first.marks)
            break
        count -= len(first.text)
        rest.pop(0)
    while rest and isinstance(rest[0], Break):
        rest.pop(0)
    return rest


def caption_parts(inlines: Sequence[Inline], seq_fields: Sequence[FieldState]) -> Caption:
    """A caption read from its inlines and the fields they held.

    A leading `CAPTION_PREFIX` is removed, its whole number included, and gives the label and
    number. Failing that, a `SEQ` field still makes the caption numbered, and its result (with
    at most one word before it) is removed when it leads the text. Without either, the caption
    is unnumbered and kept whole.
    """
    lead = _leading_text(inlines)
    if match := CAPTION_PREFIX.match(lead):
        rest = _strip_leading(inlines, match.end())
        return Caption(rest, _kind(match.group(1)), caption_number(match.group(2)), numbered=True)
    seq = next((f for f in seq_fields if f.kind == "SEQ"), None)
    if seq is None:
        return Caption(list(inlines), None, None, numbered=False)
    result = seq.result.strip()
    number = caption_number(result) if re.fullmatch(CAPTION_NUMBER, result) else None
    kept = list(inlines)
    if result:
        prefix = re.compile(rf"^\s*(?:[^\W\d_]+\.?\s*)?{re.escape(result)}{_SEPARATOR}")
        if match := prefix.match(lead):
            kept = _strip_leading(inlines, match.end())
    return Caption(kept, _kind(seq.argument), number, numbered=True)


def caption_key(inlines: Sequence[Inline]) -> str | None:
    """A table's key: its normalised caption text, or None when it has none."""
    text = plain_text(list(inlines))
    return normalise_title(text) if text.strip() else None


def register_caption(ctx: InlineContext, caption: Caption, element_id: str) -> None:
    """Record the source's displayed caption number for typed references; the first one wins."""
    if caption.kind is not None and caption.number is not None:
        ctx.caption_number_map.setdefault((caption.kind, caption.number), element_id)


def _paragraph_inlines(tc: Element, ctx: InlineContext, *, at: str) -> list[list[Inline]]:
    return [inlines_of(p, ctx, at=at) for p in unwrapped(tc, f"{W}p")]


def _caption_row(tc: Element, ctx: InlineContext, *, at: str) -> Caption:
    """The caption in a caption row's cell, its paragraphs joined by breaks."""
    start = len(ctx.closed_fields)
    joined: list[Inline] = []
    for inlines in _paragraph_inlines(tc, ctx, at=at):
        if inlines:
            joined.extend([Break(), *inlines] if joined else inlines)
    return caption_parts(joined, ctx.closed_fields[start:])


# --- Caption and note rows -------------------------------------------------------------------


@dataclass(frozen=True)
class StructuralRows:
    """Source rows that are not grid rows, as indices into the rows of `source_grid`.

    `caption` is the caption row and `notes` the rows that became notes; both leave the grid.
    `unrecognised` are note-like rows whose markers were not found; they stay in the grid.
    """

    caption: int | None = None
    notes: tuple[int, ...] = ()
    unrecognised: tuple[int, ...] = ()

    def grid_rows(self, count: int) -> list[int]:
        """The indices, out of `count` source rows, of the rows that stay in the grid."""
        left = {self.caption, *self.notes}
        return [i for i in range(count) if i not in left]


def structural_rows(tbl: Element, styles: RunStyles) -> StructuralRows:
    """Which of the table's source rows are its caption and its notes (§5.4)."""
    rows = rows_of(tbl)
    return _structure(rows, _width(tbl, rows), styles)


def _structure(rows: list[Element], width: int, styles: RunStyles) -> StructuralRows:
    caption = None
    if len(rows) > 1 and (tc := _sole_cell(rows[0], width)) is not None and _is_caption_cell(tc):
        caption = 0
    first = 0 if caption is None else 1  # the first grid row, never a note row
    candidates: dict[int, list[str]] = {}
    for i in range(len(rows) - 1, first, -1):
        cell = _sole_cell(rows[i], width)
        markers = note_markers(cell) if cell is not None else None
        if markers is None:
            break
        candidates[i] = markers
    rest = [tr for i, tr in enumerate(rows) if i != caption and i not in candidates]
    found = _superscripts(rest, styles)
    notes = tuple(sorted(i for i, ms in candidates.items() if all(m in found for m in ms)))
    unrecognised = tuple(sorted(set(candidates) - set(notes)))
    return StructuralRows(caption, notes, unrecognised)


def _sole_cell(tr: Element, width: int) -> Element | None:
    """The row's only cell, if it spans the whole grid with no gaps, merge or nested table."""
    before, after = row_gaps(tr)
    cells = cells_of(tr)
    if before or after or len(cells) != 1:
        return None
    tc = cells[0]
    if cell_span(tc) != width or _vmerge(tc) is not None or tc.find(f".//{W}tbl") is not None:
        return None
    return tc


def _is_caption_cell(tc: Element) -> bool:
    if CAPTION_PREFIX.match(_plain_text(tc)):
        return True
    instructions = "".join(el.text or "" for el in tc.iter(f"{W}instrText"))
    instructions += " " + " ".join(el.get(f"{W}instr", "") for el in tc.iter(f"{W}fldSimple"))
    return _SEQ_TABLE.search(instructions) is not None


def note_markers(tc: Element) -> list[str] | None:
    """The markers of a cell whose every non-blank paragraph is a note, else None."""
    markers: list[str] = []
    for p in unwrapped(tc, f"{W}p"):
        text = "".join(_texts(p))
        if not text.strip():
            continue
        match = NOTE_PREFIX.match(text)
        if match is None:
            return None
        markers.append(match.group(1))
    return markers or None


def _descendants(el: Element, tag: str) -> Iterator[Element]:
    """The outermost elements with `tag` under `el`, outside deleted content and text boxes."""
    for child in el:
        if _excluded(child):
            continue
        if child.tag == tag:
            yield child
        else:
            yield from _descendants(child, tag)


def _style_val(props: Element | None, tag: str) -> str | None:
    style = props.find(f"{W}{tag}") if props is not None else None
    return style.get(f"{W}val") if style is not None else None


def _superscripts(rows: list[Element], styles: RunStyles) -> set[str]:
    """The tokens of visible superscript runs in the rows: `a` and `b` from a run `a,b`."""
    found: set[str] = set()
    for tr in rows:
        for p in _descendants(tr, f"{W}p"):
            paragraph_style = _style_val(p.find(f"{W}pPr"), "pStyle")
            for r in _descendants(p, f"{W}r"):
                rpr = r.find(f"{W}rPr")
                props = styles.resolve(paragraph_style, _style_val(rpr, "rStyle"), rpr)
                if props["superscript"] and not props["hidden"]:
                    text = "".join(t.text or "" for t in r.findall(f"{W}t"))
                    found.update(token for token in _MARKER_SPLIT.split(text) if token)
    return found


def _notes(paragraphs: list[list[Inline]], markers: list[str]) -> list[TableNote]:
    """One note per paragraph that starts with a marker, which is removed.

    A paragraph that doesn't (its marker hidden, say) continues the note before it, or is a
    note under the cell's first source marker; nothing is dropped.
    """
    notes: list[TableNote] = []
    for inlines in paragraphs:
        if not inlines:
            continue
        match = NOTE_PREFIX.match(_leading_text(inlines))
        if match is not None:
            rest = _strip_leading(inlines, match.end())
            notes.append(TableNote(marker=match.group(1), inlines=rest))
        elif notes:
            last = notes[-1]
            joined = merge_runs([*last.inlines, Break(), *inlines])
            notes[-1] = TableNote(marker=last.marker, inlines=joined)
        else:
            notes.append(TableNote(marker=markers[0] if markers else "", inlines=inlines))
    return notes


def flag_unrecognised_notes(ctx: InlineContext, table_id: str) -> None:
    ctx.flags.append(
        Flag(
            code="table_notes_unrecognised",
            severity="warning",
            at=table_id,
            message="note rows whose markers are not superscript anywhere in the table",
        )
    )


def notes_table(tbl: Element, following: Element, styles: RunStyles) -> NotesMatch | None:
    """Whether `following`, the table directly after `tbl`, is a one-cell table of its notes.

    `notes` when every paragraph is a note whose marker is superscript in `tbl`'s grid,
    `unrecognised` when they are all note-like but a marker is missing, else None.
    """
    rows = rows_of(following)
    if len(rows) != 1:
        return None
    cell = _sole_cell(rows[0], _width(following, rows))
    markers = note_markers(cell) if cell is not None else None
    if markers is None:
        return None
    own = rows_of(tbl)
    structure = _structure(own, _width(tbl, own), styles)
    found = _superscripts([own[i] for i in structure.grid_rows(len(own))], styles)
    return "notes" if all(m in found for m in markers) else "unrecognised"


def notes_of_table(table: Table, following: Element) -> list[TableNote] | None:
    """The notes of a one-cell notes table, or None if its cell holds more than paragraphs."""
    blocks = table.rows[0].cells[0].blocks
    paragraphs = [b.inlines for b in blocks if isinstance(b, Paragraph)]
    if len(paragraphs) != len(blocks):
        return None
    cell = cells_of(rows_of(following)[0])[0]
    return _notes(paragraphs, note_markers(cell) or [])
