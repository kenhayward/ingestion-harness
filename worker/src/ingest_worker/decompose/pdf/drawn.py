"""Tables the layout analysis took for pictures, read back from their ruling lines.

Docling sometimes labels a ruled table a picture: it would be cropped to an image, and the text
inside it (which Docling gives as the picture's own text items) would follow it as paragraphs.
It can also give a table it did read a picture of the same region, or one picture over a table
and what is around it. So a picture on a born-digital page with no image object under it is read
for grids: its ruling lines in groups that touch, each group a grid if it has at least two rows
and two columns, a border all round, and every merged cell is a rectangle. Its rows and columns are where its
horizontal and vertical rules are, and two neighbouring cells are one where no rule parts them.
A grid where Docling has a table already is that table, and the text items inside it are
dropped too (Docling can give a table and a picture of it with the cells' text as the picture's
items); any other becomes a table marked `ruled`, which its flag says, and the text items inside
it are dropped from the layout so its chars go to its cells. When every ruling line in the picture is in a grid, the picture was only
tables, and it is dropped; else it stays as it is, and so do its grids.

A picture that stays over a table Docling did read, the same region, still had its text items
inside that table: they would take its cells' chars (the smallest box wins), and the cells would
be empty. So they are dropped too, and the picture stays an image (a table of chemical
structures, say, whose drawings no cell holds).
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from itertools import pairwise

from ingest_worker.decompose.pdf.layout import (
    BBox,
    LayoutCell,
    LayoutDoc,
    LayoutItem,
    LayoutPicture,
    LayoutTable,
    LayoutText,
)
from ingest_worker.decompose.pdf.textlayer import PageText, TextLayer

#: Rules this many points apart are one line, and a rule reaches a point this close to it.
_NEAR = 2.0
#: A rule reaches into the picture's box from this many points outside it.
_REACH = 3.0
#: A grid is Docling's table when they share this fraction of the smaller one's area.
_SAME = 0.8


@dataclass(frozen=True)
class _Rule:
    at: float  # y of a horizontal rule, x of a vertical one
    start: float
    end: float


def tables_from_drawings(layout: LayoutDoc, text: TextLayer) -> LayoutDoc:
    """The layout with each picture that is only ruled tables replaced by those of its tables
    Docling didn't read, and the text items inside them dropped; and the text items inside a
    table Docling read that a picture repeats."""
    pages = {p.index: p for p in text.pages if p.kind == "born_digital"}
    docling = [i for i in layout.items if isinstance(i, LayoutTable)]
    found: dict[str, list[LayoutTable]] = {}
    #: Docling's tables a dropped picture's grids are: its text items in them go too.
    drawn_again: list[LayoutTable] = []
    for item in layout.items:
        page = pages.get(item.page)
        if isinstance(item, LayoutPicture) and page is not None:
            tables = _tables(item, page)
            if tables is not None:
                same = [
                    d for d in docling if d.page == item.page and any(_same(t, d) for t in tables)
                ]
                found[item.ref] = [t for t in tables if not any(_same(t, d) for d in same)]
                drawn_again += same
    repeated = [
        d
        for d in docling
        if any(
            isinstance(i, LayoutPicture)
            and i.ref not in found
            and i.page == d.page
            and _same_box(i.bbox, d.bbox, of_both=True)
            for i in layout.items
        )
    ]
    if not found and not repeated:
        return layout
    boxes = [(t.page, t.bbox) for tables in found.values() for t in tables]
    boxes += [(d.page, d.bbox) for d in [*repeated, *drawn_again]]
    items: list[LayoutItem] = []
    for item in layout.items:
        if item.ref in found:
            items.extend(found[item.ref])
        elif not (isinstance(item, LayoutText) and _inside(item, boxes)):
            items.append(item)
    return LayoutDoc(tuple(items))


def _same(a: LayoutTable, b: LayoutTable) -> bool:
    return _same_box(a.bbox, b.bbox)


def _same_box(a: BBox, b: BBox, *, of_both: bool = False) -> bool:
    """Whether the boxes share `_SAME` of the smaller one's area; `of_both`, of the larger's
    too (a small picture inside a table is not a picture of it)."""
    w = min(a[2], b[2]) - max(a[0], b[0])
    h = min(a[3], b[3]) - max(a[1], b[1])
    areas = (_area(a), _area(b))
    measure = max(areas) if of_both else min(areas)
    return w > 0 and h > 0 and measure > 0 and w * h >= _SAME * measure


def _area(box: BBox) -> float:
    return (box[2] - box[0]) * (box[3] - box[1])


def _inside(item: LayoutText, boxes: Iterable[tuple[int, BBox]]) -> bool:
    x, y = (item.bbox[0] + item.bbox[2]) / 2, (item.bbox[1] + item.bbox[3]) / 2
    return any(
        page == item.page and box[0] <= x <= box[2] and box[1] <= y <= box[3] for page, box in boxes
    )


def _tables(picture: LayoutPicture, page: PageText) -> list[LayoutTable] | None:
    """The tables the picture's ruling lines draw, top down, if they are all it draws: None if
    an image object is under it, it has no ruling lines, or one of its groups of them is no
    grid."""
    x0, y0, x1, y1 = picture.bbox
    if any(i[0] < x1 and x0 < i[2] and i[1] < y1 and y0 < i[3] for i in page.images):
        return None
    near = [
        r
        for r in page.rules
        if r[0] >= x0 - _REACH
        and r[2] <= x1 + _REACH
        and r[1] >= y0 - _REACH
        and r[3] <= y1 + _REACH
    ]
    if not near:
        return None
    tables: list[LayoutTable] = []
    for n, group in enumerate(_groups(near)):
        table = _table(group, picture, n)
        if table is None:
            return None
        tables.append(table)
    return sorted(tables, key=lambda t: t.bbox[1])


def _groups(rules: list[BBox]) -> list[list[BBox]]:
    """The rules in groups that touch (within `_NEAR`), each group's rules in page order."""
    parent = list(range(len(rules)))

    def root(i: int) -> int:
        while parent[i] != i:
            i = parent[i]
        return i

    for i, a in enumerate(rules):
        for j in range(i + 1, len(rules)):
            b = rules[j]
            if (
                a[0] <= b[2] + _NEAR
                and b[0] <= a[2] + _NEAR
                and a[1] <= b[3] + _NEAR
                and b[1] <= a[3] + _NEAR
            ):
                parent[root(j)] = root(i)
    groups: dict[int, list[BBox]] = {}
    for i, rule in enumerate(rules):
        groups.setdefault(root(i), []).append(rule)
    return list(groups.values())


def _table(rules: list[BBox], picture: LayoutPicture, n: int) -> LayoutTable | None:
    """The table one group of ruling lines draws, if it is a grid."""
    across = _merged(
        _Rule((r[1] + r[3]) / 2, r[0], r[2]) for r in rules if r[2] - r[0] >= r[3] - r[1]
    )
    down = _merged(_Rule((r[0] + r[2]) / 2, r[1], r[3]) for r in rules if r[3] - r[1] > r[2] - r[0])
    ys = sorted({r.at for r in across})
    xs = sorted({r.at for r in down})
    # a line that bounds no cell is no row's edge: an underline in a cell, say
    ys = [y for y in ys if y in (ys[0], ys[-1]) or _bounds(across, y, xs)]
    xs = [x for x in xs if x in (xs[0], xs[-1]) or _bounds(down, x, ys)]
    rows, cols = len(ys) - 1, len(xs) - 1
    if rows < 2 or cols < 2:
        return None
    # a table is closed all round; boxes joined by a line (a flow chart) are not
    if not (
        _covers(across, ys[0], xs[0], xs[-1])
        and _covers(across, ys[-1], xs[0], xs[-1])
        and _covers(down, xs[0], ys[0], ys[-1])
        and _covers(down, xs[-1], ys[0], ys[-1])
    ):
        return None
    cells = _cells(xs, ys, across, down)
    if cells is None:
        return None
    ref = picture.ref if n == 0 else f"{picture.ref}/table-{n}"
    captions = picture.captions if n == 0 else ()
    grid = (xs[0], ys[0], xs[-1], ys[-1])
    return LayoutTable(ref, picture.page, grid, rows, cols, cells, captions, ruled=True)


def _merged(rules: Iterable[_Rule]) -> list[_Rule]:
    """Rules on one line (within `_NEAR` of its first) joined where they meet, left to right (or
    top down), each line at its first rule's position: Word draws a border as a rule per cell
    and a dot at each corner. The rules of a line are put in order along it, not by where each
    is across it: a rule a hundredth of a point higher came first, and the rules before it
    along the line were joined to its start, which they lost."""
    lines: list[list[_Rule]] = []
    for rule in sorted(rules, key=lambda r: r.at):
        if lines and rule.at - lines[-1][0].at <= _NEAR:
            lines[-1].append(rule)
        else:
            lines.append([rule])
    out: list[_Rule] = []
    for line in lines:
        at = line[0].at
        current: _Rule | None = None
        for rule in sorted(line, key=lambda r: r.start):
            if current is not None and rule.start <= current.end + _NEAR:
                current = _Rule(at, current.start, max(current.end, rule.end))
            else:
                if current is not None:
                    out.append(current)
                current = _Rule(at, rule.start, rule.end)
        if current is not None:
            out.append(current)
    return out


def _bounds(rules: list[_Rule], at: float, edges: list[float]) -> bool:
    """Whether rules on line `at` run the whole way between two neighbouring `edges` anywhere."""
    return any(_covers(rules, at, a, b) for a, b in pairwise(edges))


def _covers(rules: list[_Rule], at: float, start: float, end: float) -> bool:
    """Whether a rule on line `at` runs from `start` to `end`."""
    return any(
        abs(r.at - at) <= _NEAR and r.start <= start + _NEAR and r.end >= end - _NEAR for r in rules
    )


def _cells(
    xs: list[float], ys: list[float], across: list[_Rule], down: list[_Rule]
) -> tuple[LayoutCell, ...] | None:
    """The grid's cells, those no rule parts merged; None unless every merged cell is a
    rectangle."""
    rows, cols = len(ys) - 1, len(xs) - 1
    parent = {(r, c): (r, c) for r in range(rows) for c in range(cols)}

    def root(key: tuple[int, int]) -> tuple[int, int]:
        while parent[key] != key:
            key = parent[key]
        return key

    for r in range(rows):
        for c in range(cols):
            if c + 1 < cols and not _covers(down, xs[c + 1], ys[r], ys[r + 1]):
                parent[root((r, c + 1))] = root((r, c))
            if r + 1 < rows and not _covers(across, ys[r + 1], xs[c], xs[c + 1]):
                parent[root((r + 1, c))] = root((r, c))
    groups: dict[tuple[int, int], list[tuple[int, int]]] = {}
    for key in parent:
        groups.setdefault(root(key), []).append(key)
    cells: list[LayoutCell] = []
    for members in groups.values():
        top, left = min(r for r, _ in members), min(c for _, c in members)
        bottom, right = max(r for r, _ in members), max(c for _, c in members)
        if len(members) != (bottom - top + 1) * (right - left + 1):
            return None
        box = (xs[left], ys[top], xs[right + 1], ys[bottom + 1])
        cells.append(
            LayoutCell(top, left, bottom - top + 1, right - left + 1, box, header=top == 0)
        )
    return tuple(sorted(cells, key=lambda c: (c.row, c.col)))
