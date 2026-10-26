"""The PDF's own characters put into Docling's layout items.

Docling says where the items are and what kind they are; the text of every item comes from the
PDF's text layer: each visible character belongs to the item whose box holds its centre (the
smallest box wins, a table cell beats its table). Characters in no item become orphan pieces, so
nothing on a born-digital page is lost. The `Ledger` records who owns every character; the
fidelity check at the end of the reader is built on it.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from dataclasses import dataclass
from statistics import median
from typing import Literal

from ingest_worker.decompose.inline import merge_runs
from ingest_worker.decompose.model import Text
from ingest_worker.decompose.pdf.layout import (
    BBox,
    LayoutDoc,
    LayoutPicture,
    LayoutTable,
    LayoutText,
)
from ingest_worker.decompose.pdf.textlayer import Char, PageText, TextLayer

DropReason = Literal[
    "furniture", "contents", "heading-number", "list-marker", "caption-number", "repeated-header"
]

#: Chars share a line when their baselines differ by at most this many times the font size.
_BASELINE_TOLERANCE = 0.5
#: A gap wider than this many times the font size is a space.
_SPACE_GAP = 0.25
#: A mark needs a size at most this fraction of the line's usual size ...
_MARK_SIZE = 0.85
#: ... and a baseline this fraction of that size away from the line's.
_MARK_SHIFT = 0.2
#: Lines whose gap is under this many times the line height belong to one orphan piece.
_ORPHAN_LINE_GAP = 1.5

#: What the ledger holds for a char that was dropped: `dropped:<reason>`.
DROPPED_PREFIX = "dropped:"

_Mark = Literal["bold", "italic", "superscript", "subscript"]


def _union(boxes: list[BBox]) -> BBox:
    return (
        min(b[0] for b in boxes),
        min(b[1] for b in boxes),
        max(b[2] for b in boxes),
        max(b[3] for b in boxes),
    )


def _char_box(c: Char) -> BBox:
    return (c.x0, c.y0, c.x1, c.y1)


@dataclass(frozen=True)
class Line:
    page: int
    chars: tuple[Char, ...]
    bbox: BBox

    @property
    def text(self) -> str:
        return "".join(run.text for run in self.runs())

    def runs(self) -> list[Text]:
        """The line as text runs: spaces added where chars are apart, marks from the chars."""
        chars = list(self.chars)
        while chars and chars[0].text.isspace():
            chars.pop(0)
        while chars and chars[-1].text.isspace():
            chars.pop()
        if not chars:
            return []
        size, baseline = _usual(chars)
        runs: list[Text] = []
        previous: Char | None = None
        previous_marks: frozenset[_Mark] = frozenset()
        for c in chars:
            marks = _marks(c, size, baseline)
            if (
                previous is not None
                and c.x0 - previous.x1 > _SPACE_GAP * c.size
                and not previous.text.isspace()
                and not c.text.isspace()
            ):
                runs.append(Text(text=" ", marks=previous_marks & marks))
            runs.append(Text(text=c.text, marks=marks))
            previous, previous_marks = c, marks
        return runs


def _usual(chars: list[Char]) -> tuple[float, float]:
    """The line's most common size, and the baseline of the chars of that size."""
    counts = Counter(round(c.size, 1) for c in chars)
    size = max(counts, key=lambda s: (counts[s], s))
    baseline = median(c.baseline for c in chars if round(c.size, 1) == size)
    return size, baseline


def _marks(c: Char, size: float, baseline: float) -> frozenset[_Mark]:
    marks: set[_Mark] = set()
    if c.bold:
        marks.add("bold")
    if c.italic:
        marks.add("italic")
    if c.size <= _MARK_SIZE * size:
        if baseline - c.baseline >= _MARK_SHIFT * size:  # y grows downward
            marks.add("superscript")
        elif c.baseline - baseline >= _MARK_SHIFT * size:
            marks.add("subscript")
    return frozenset(marks)


@dataclass
class Piece:
    ref: str
    label: str
    page: int
    bbox: BBox
    lines: list[Line]
    level: int | None
    group: str | None
    orphan: bool = False
    table: LayoutTable | None = None
    cells: dict[tuple[int, int], list[Line]] | None = None
    picture: LayoutPicture | None = None
    heading_level: int | None = None
    #: Docling's content layer; only a text item can be furniture.
    layer: Literal["body", "furniture"] = "body"

    def inlines(self) -> list[Text]:
        """The lines joined with single spaces, runs merged by marks."""
        runs: list[Text] = []
        for line in self.lines:
            line_runs = line.runs()
            if runs and line_runs:
                runs.append(Text(text=" "))
            runs.extend(line_runs)
        return [i for i in merge_runs(list(runs)) if isinstance(i, Text)]


class Ledger:
    """Who owns each visible char: a piece ref, later a block id; or why it was dropped."""

    def __init__(self) -> None:
        self._pages: dict[int, dict[int, list[str]]] = defaultdict(dict)

    def own(self, page: int, char_index: int, owner: str) -> None:
        self._pages[page].setdefault(char_index, []).append(owner)

    def drop(self, page: int, char_index: int, reason: DropReason) -> None:
        """The char stops being owned: it is accounted for by `dropped:<reason>` instead."""
        self._pages[page][char_index] = [DROPPED_PREFIX + reason]

    def reassign(self, page: int, char_index: int, owner: str) -> None:
        """The char's owners are replaced by `owner` alone (a piece was split)."""
        self._pages[page][char_index] = [owner]

    def entries(self, page: int) -> dict[int, list[str]]:
        return {i: list(owners) for i, owners in self._pages.get(page, {}).items()}

    def rename(self, old: str, new: str) -> None:
        for chars in self._pages.values():
            for owners in chars.values():
                owners[:] = [new if o == old else o for o in owners]


def _lines(page: int, chars: list[Char]) -> list[Line]:
    """Chars grouped by baseline into lines, top to bottom, each left to right."""
    clusters: list[list[Char]] = []
    for c in sorted(chars, key=lambda c: (c.baseline, c.x0)):
        if clusters:
            current = clusters[-1]
            reach = _BASELINE_TOLERANCE * max(max(x.size for x in current), c.size)
            if c.baseline - current[0].baseline <= reach:
                current.append(c)
                continue
        clusters.append([c])
    lines = []
    for cluster in clusters:
        cluster.sort(key=lambda c: c.x0)
        lines.append(Line(page, tuple(cluster), _union([_char_box(c) for c in cluster])))
    return lines


def _centre(c: Char) -> tuple[float, float]:
    return (c.x0 + c.x1) / 2, (c.y0 + c.y1) / 2


def _contains(box: BBox, point: tuple[float, float]) -> bool:
    return box[0] <= point[0] <= box[2] and box[1] <= point[1] <= box[3]


def _area(box: BBox) -> float:
    return (box[2] - box[0]) * (box[3] - box[1])


def _distance(box: BBox, point: tuple[float, float]) -> float:
    cx, cy = (box[0] + box[2]) / 2, (box[1] + box[3]) / 2
    return (cx - point[0]) ** 2 + (cy - point[1]) ** 2


#: Where a char goes: an item's index, and for a table the (row, col) of the cell.
_Target = tuple[int, tuple[int, int] | None]


def attach_text(layout: LayoutDoc, text: TextLayer) -> tuple[list[Piece], Ledger]:
    """The layout items with their lines from the text layer, in Docling's reading order, with
    orphan lines placed among them; and the ledger of who owns each char."""
    ledger = Ledger()
    pages = {p.index: p for p in text.pages if p.kind == "born_digital"}
    items = layout.items

    # candidate boxes per page: (area, is_cell, box, target)
    candidates: dict[int, list[tuple[float, bool, BBox, _Target]]] = defaultdict(list)
    cell_boxes: dict[int, list[tuple[BBox, _Target]]] = defaultdict(list)
    for i, item in enumerate(items):
        if item.page not in pages:
            continue
        candidates[item.page].append((_area(item.bbox), False, item.bbox, (i, None)))
        if isinstance(item, LayoutTable):
            for cell in item.cells:
                if cell.bbox is not None:
                    cell_target: _Target = (i, (cell.row, cell.col))
                    candidates[item.page].append((_area(cell.bbox), True, cell.bbox, cell_target))
                    cell_boxes[i].append((cell.bbox, cell_target))

    owned: dict[_Target, list[Char]] = defaultdict(list)
    loose: dict[int, list[Char]] = defaultdict(list)
    for number, page in pages.items():
        for c in page.chars:
            if not c.visible:
                continue
            point = _centre(c)
            best: tuple[float, bool, BBox, _Target] | None = None
            for cand in candidates[number]:
                if _contains(cand[2], point) and (
                    best is None or (cand[0], not cand[1]) < (best[0], not best[1])
                ):
                    best = cand
            if best is None:
                loose[number].append(c)
                continue
            target: _Target = best[3]
            if isinstance(items[target[0]], LayoutTable) and target[1] is None:
                table = items[target[0]]
                assert isinstance(table, LayoutTable)
                target = _nearest_cell(cell_boxes[target[0]], point) or (
                    target[0],
                    _cell_keys(table)[0],
                )
            owned[target].append(c)

    pieces: list[Piece] = []
    for i, item in enumerate(items):
        piece = _piece(i, item, owned)
        if piece is None:
            continue
        pieces.append(piece)
        for c in _chars_of(piece):
            ledger.own(piece.page, c.index, piece.ref)

    orphans = _orphans(pages, loose, ledger)
    return _place(pieces, orphans), ledger


def _nearest_cell(cells: list[tuple[BBox, _Target]], point: tuple[float, float]) -> _Target | None:
    if not cells:
        return None
    return min(cells, key=lambda cell: _distance(cell[0], point))[1]


def _cell_keys(table: LayoutTable) -> list[tuple[int, int]]:
    """The (row, col) of each origin cell, in order; (0, 0) alone for a table with no cells."""
    return list(dict.fromkeys((c.row, c.col) for c in table.cells)) or [(0, 0)]


def _piece(index: int, item: object, owned: dict[_Target, list[Char]]) -> Piece | None:
    if isinstance(item, LayoutTable):
        cells: dict[tuple[int, int], list[Line]] = {}
        for key in _cell_keys(item):
            chars = owned.get((index, key), [])
            cells[key] = _lines(item.page, chars) if chars else []
        if not any(cells.values()):
            return None
        return Piece(
            item.ref, "table", item.page, item.bbox, [], None, None, table=item, cells=cells
        )
    chars = owned.get((index, None), [])
    if not chars:
        return None
    if isinstance(item, LayoutPicture):
        lines = _lines(item.page, chars)
        return Piece(item.ref, "picture", item.page, item.bbox, lines, None, None, picture=item)
    assert isinstance(item, LayoutText)
    lines = _lines(item.page, chars)
    return Piece(
        item.ref, item.label, item.page, item.bbox, lines, item.level, item.group, layer=item.layer
    )


def _chars_of(piece: Piece) -> list[Char]:
    lines = list(piece.lines)
    for cell_lines in (piece.cells or {}).values():
        lines.extend(cell_lines)
    return [c for line in lines for c in line.chars]


def _orphans(
    pages: dict[int, PageText], loose: dict[int, list[Char]], ledger: Ledger
) -> list[Piece]:
    out: list[Piece] = []
    for number in sorted(loose):
        lines = _lines(number, loose[number])
        runs: list[list[Line]] = []
        for line in lines:
            if runs:
                previous = runs[-1][-1]
                height = previous.bbox[3] - previous.bbox[1]
                if line.bbox[1] - previous.bbox[3] < _ORPHAN_LINE_GAP * height:
                    runs[-1].append(line)
                    continue
            runs.append([line])
        for n, run in enumerate(runs):
            piece = Piece(
                f"orphan-{number}-{n}",
                "text",
                number,
                _union([line.bbox for line in run]),
                run,
                None,
                None,
                orphan=True,
            )
            for c in _chars_of(piece):
                ledger.own(number, c.index, piece.ref)
            out.append(piece)
    return out


def _place(pieces: list[Piece], orphans: list[Piece]) -> list[Piece]:
    """Each orphan after the last piece above it on its page whose x-range overlaps it, or first
    on its page."""
    before: dict[int, list[Piece]] = defaultdict(list)
    after: dict[int, list[Piece]] = defaultdict(list)
    for orphan in orphans:
        anchor = None
        for i, piece in enumerate(pieces):
            if (
                piece.page == orphan.page
                and piece.bbox[1] <= orphan.bbox[1]
                and piece.bbox[0] < orphan.bbox[2]
                and orphan.bbox[0] < piece.bbox[2]
            ):
                anchor = i
        if anchor is not None:
            after[anchor].append(orphan)
            continue
        first = next((i for i, p in enumerate(pieces) if p.page >= orphan.page), len(pieces))
        before[first].append(orphan)
    out: list[Piece] = []
    for i, piece in enumerate(pieces):
        out.extend(before[i])
        out.append(piece)
        out.extend(after[i])
    out.extend(before[len(pieces)])
    return out
