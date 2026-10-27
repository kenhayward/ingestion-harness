"""Page furniture and tables of contents dropped from the pieces, under guards.

Furniture is decided per line: a line is furniture only if it lies in the top or bottom margin
band of its page, and Docling put it in the furniture layer, its text repeats at the same height
on enough pages, or it reads as a page number ("8", "A3 8", "Page 8 of 120"). A furniture label in
the body is ignored. A picture in a band with no image object under it, over nothing but
furniture text, is dropped too. Printed line numbers are dropped from the start of the lines:
short numbers in one narrow column left of all other text on the page, on at least half its
lines, increasing down the page. Contents are a `document_index` item,
a contents heading with the contents lines after it, or a run of contents lines with dot leaders
that starts on a leader line; a run's page numbers never go back nor past the last page. One
contents-like line in the body is kept. Dropped chars are recorded in the ledger.
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import dataclass, field, replace
from itertools import pairwise

from ingest_worker.decompose.model import Flag, Property
from ingest_worker.decompose.pdf.layout import BBox
from ingest_worker.decompose.pdf.pieces import (
    DROPPED_PREFIX,
    DropReason,
    Ledger,
    Line,
    Piece,
)
from ingest_worker.decompose.pdf.textlayer import Char, PageText, TextLayer

#: The top and bottom fraction of a page's height that can hold furniture.
_BAND = 0.1
#: Lines repeat when their y differs by at most this many points ...
_REPEAT_Y = 3.0
#: ... on at least this many pages, or half of the pages if that is more.
_REPEAT_PAGES = 3
#: A contents run needs this many lines, ...
_RUN_LINES = 3
#: ... this fraction of them with dot leaders.
_RUN_LEADERS = 0.5

#: The brief's pattern, except that a dot leader may touch the page number ("SUMMARY.....6").
_CONTENTS_LINE = re.compile(r"^(?P<title>.*\S)\s*(?:(?:\.{2,}|…+)\s*|\s+)(?P<page>\d{1,4})$")
_LEADER = re.compile(r"(?:\.{2,}|…)\s*\d{1,4}$")
_CONTENTS_HEADING = re.compile(r"(?i)^(table of contents|contents|list of (tables|figures))$")
_HEADER_FIELD = re.compile(r"^(?P<name>[A-Z][\w /&-]{1,40}):\s*(?P<value>\S.*)$")
_EN_DASH = chr(0x2013)
_HEADING_LABELS = frozenset({"section_header", "title"})
#: A line of a piece with one of these labels is a contents entry only with a dot leader;
#: without one it ends a run.
_BOUNDARY_LABELS = frozenset({"section_header", "title", "caption"})
_PAGE_NUMBER = re.compile(r"\d{1,4}")
#: A contents table needs this many entry rows.
_TABLE_ROWS = 3
#: A printed page number, perhaps with an annex or part prefix: "8", "- 8 -", "A3 8", "A3-8",
#: "Page 8 of 120", "8/120", "iv".
_PAGE_LABEL = re.compile(
    r"(?i)(?:page\s+)?[-\u2013\u2014\s]*(?:[a-z]{1,2}\d{0,3}[\s.\-\u2013]+)?"
    r"(?:\d{1,4}|(?=[ivx])x{0,3}(?:ix|iv|v?i{0,3}))(?:\s*(?:of|/)\s*\d{1,4})?[-\u2013\u2014\s]*"
)
#: A printed line number has at most this many digits, ...
_LINE_NUMBER_DIGITS = 5
#: ... a page has at least this many of them, on at least this fraction of its lines, ...
_LINE_NUMBERS = 5
_LINE_NUMBER_SHARE = 0.5
#: ... their left or right edges within this many points of one another, ...
_LINE_NUMBER_X = 3.0
#: ... and all other text on the page at least this many ems to their right.
_LINE_NUMBER_GAP = 0.5


@dataclass(frozen=True)
class Dropped:
    #: Page index (0-based) to the number of furniture lines dropped from it.
    furniture: dict[int, int]
    #: Page indexes (0-based, ascending) where contents were dropped.
    contents_pages: tuple[int, ...]
    #: Page index (0-based) to the number of printed line numbers dropped from it.
    line_numbers: dict[int, int] = field(default_factory=dict)
    #: Page index (0-based) to the number of furniture pictures dropped from it.
    pictures: dict[int, int] = field(default_factory=dict)


def _key(text: str) -> str:
    return " ".join(re.sub(r"\d", "#", text).lower().split())


def _is_text(piece: Piece) -> bool:
    return piece.table is None and piece.picture is None


def _centre_y(line: Line) -> float:
    return (line.bbox[1] + line.bbox[3]) / 2


def _drop(ledger: Ledger, line: Line, reason: DropReason) -> None:
    for c in line.chars:
        ledger.drop(line.page, c.index, reason)


def _with(piece: Piece, kept: list[Line]) -> Piece:
    return piece if len(kept) == len(piece.lines) else replace(piece, lines=kept)


def drop_furniture(
    pieces: list[Piece], text: TextLayer, ledger: Ledger
) -> tuple[list[Piece], Dropped, list[Property]]:
    """The pieces without furniture lines and contents, what was dropped, and the header fields
    found among the furniture."""
    pieces, line_numbers = _drop_line_numbers(pieces, text, ledger)
    heights = {p.index: p.height for p in text.pages}
    needed = max(_REPEAT_PAGES, math.ceil(len(text.pages) / 2))

    def in_band(line: Line) -> bool:
        height = heights.get(line.page)
        if height is None:
            return False
        y = _centre_y(line)
        return y < _BAND * height or y > (1 - _BAND) * height

    # (page, y) of every band line per key, for the repetition rule
    seen: dict[str, list[tuple[int, float]]] = defaultdict(list)
    for piece in pieces:
        if _is_text(piece):
            for line in piece.lines:
                if in_band(line) and line.text:
                    seen[_key(line.text)].append((line.page, _centre_y(line)))

    def repeats(line: Line) -> bool:
        y = _centre_y(line)
        found = {p for p, other in seen[_key(line.text)] if abs(other - y) <= _REPEAT_Y}
        return len(found) >= needed

    furniture: dict[int, int] = defaultdict(int)
    properties: dict[tuple[str, str], Property] = {}
    remaining: list[Piece] = []
    for piece in pieces:
        if not _is_text(piece):
            remaining.append(piece)
            continue
        kept: list[Line] = []
        for line in piece.lines:
            text_ = line.text
            if (
                text_
                and in_band(line)
                and (
                    piece.layer == "furniture"
                    or repeats(line)
                    or _PAGE_LABEL.fullmatch(text_) is not None
                )
            ):
                _drop(ledger, line, "furniture")
                furniture[line.page] += 1
                field = _HEADER_FIELD.match(text_)
                if field:
                    name, value = field["name"], field["value"].strip()
                    prop = Property(name=name, value=value, origin="header-field")
                    properties.setdefault((name, value), prop)
            else:
                kept.append(line)
        if kept:
            remaining.append(_with(piece, kept))

    remaining, pictures = _drop_pictures(remaining, text, ledger)
    remaining, contents_pages = _drop_contents(remaining, ledger, len(text.pages))
    dropped = Dropped(
        dict(sorted(furniture.items())),
        tuple(sorted(contents_pages)),
        line_numbers,
        pictures,
    )
    return remaining, dropped, list(properties.values())


def _overlaps(a: BBox, b: BBox) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


def _in_band(page: PageText, y: float) -> bool:
    return y < _BAND * page.height or y > (1 - _BAND) * page.height


def _drop_pictures(
    pieces: list[Piece], text: TextLayer, ledger: Ledger
) -> tuple[list[Piece], dict[int, int]]:
    """Without the pictures that are only furniture text (`_furniture_picture`), and how many
    were dropped on each page."""
    pages = {p.index: p for p in text.pages}
    dropped: dict[int, int] = defaultdict(int)
    out: list[Piece] = []
    for piece in pieces:
        page = pages.get(piece.page)
        if piece.picture is None or page is None or not _furniture_picture(piece, page, ledger):
            out.append(piece)
            continue
        for line in piece.lines:
            _drop(ledger, line, "furniture")
        dropped[piece.page] += 1
    return out, dict(sorted(dropped.items()))


def _furniture_picture(piece: Piece, page: PageText, ledger: Ledger) -> bool:
    """A picture in a margin band with no image object under it, whose own text is page
    numbers, and every char it overlaps either its own or already dropped (a footer's page
    number that Docling also took for a picture)."""
    box = piece.bbox
    if not _in_band(page, (box[1] + box[3]) / 2):
        return False
    if any(_overlaps(box, image) for image in page.images):
        return False
    if any(_PAGE_LABEL.fullmatch(line.text) is None for line in piece.lines if line.text):
        return False
    own = {c.index for line in piece.lines for c in line.chars}
    entries = ledger.entries(page.index)
    under = [
        c
        for c in page.chars
        if c.visible and not c.text.isspace() and _overlaps(box, (c.x0, c.y0, c.x1, c.y1))
    ]
    return bool(under) and all(
        c.index in own or any(e.startswith(DROPPED_PREFIX) for e in entries.get(c.index, []))
        for c in under
    )


@dataclass(frozen=True)
class _Number:
    """A line's leading number: where the line is, the number's chars and its value."""

    at: tuple[int, int]  # (piece index, line index)
    chars: tuple[Char, ...]
    value: int

    @property
    def x0(self) -> float:
        return self.chars[0].x0

    @property
    def x1(self) -> float:
        return self.chars[-1].x1


def _leading_number(line: Line) -> tuple[Char, ...] | None:
    """The chars of the line's first word when it is a short run of digits, else None."""
    chars = [c for c in line.chars if not c.text.isspace()]
    if not chars:
        return None
    word = [chars[0]]
    for c in chars[1:]:
        if c.space_before or c.x0 - word[-1].x1 > _LINE_NUMBER_GAP * c.size:
            break
        word.append(c)
    digits = "".join(c.text for c in word)
    if not (digits.isascii() and digits.isdigit() and len(digits) <= _LINE_NUMBER_DIGITS):
        return None
    return tuple(word)


def _line_count(chars: list[Char]) -> int:
    """How many lines the chars are on: baselines more than half the font size apart."""
    count = 0
    last: float | None = None
    for c in sorted(chars, key=lambda c: c.baseline):
        if last is None or c.baseline - last > 0.5 * c.size:
            count += 1
            last = c.baseline
    return count


def _x0(n: _Number) -> float:
    return n.x0


def _x1(n: _Number) -> float:
    return n.x1


def _column(numbers: list[_Number]) -> list[_Number]:
    """The most numbers whose right edges, or else left edges, line up."""
    best: list[_Number] = []
    for edge in (_x1, _x0):
        for anchor in numbers:
            group = [n for n in numbers if abs(edge(n) - edge(anchor)) <= _LINE_NUMBER_X]
            if len(group) > len(best):
                best = group
    return best


def _band_numbers(column: list[_Number], banded: list[_Number]) -> list[_Number]:
    """The numbers in a margin band that carry on the page's column of line numbers (the body
    text can start in the top band): lined up with it, and counting on from it, down the top
    band to its first number and from its last number down the bottom band."""
    first, last = column[0], column[-1]
    out: list[_Number] = []
    for edge in (_x1, _x0):
        lined = [n for n in banded if all(abs(edge(n) - edge(m)) <= _LINE_NUMBER_X for m in column)]
        above = sorted(
            (n for n in lined if n.chars[0].baseline < first.chars[0].baseline),
            key=lambda n: n.chars[0].baseline,
        )
        below = sorted(
            (n for n in lined if n.chars[0].baseline > last.chars[0].baseline),
            key=lambda n: n.chars[0].baseline,
        )
        values = [n.value for n in [*above, *column, *below]]
        if (above or below) and all(b > a for a, b in pairwise(values)):
            out = [*above, *below]
            break
    return out


def _drop_line_numbers(
    pieces: list[Piece], text: TextLayer, ledger: Ledger
) -> tuple[list[Piece], dict[int, int]]:
    """The pieces without printed line numbers, and how many were dropped on each page.

    A page's line numbers are the leading numbers of its text lines out of the margin bands
    that stand in one column: at least `_LINE_NUMBERS` of them, on at least half the page's
    lines, increasing down the page, with every other char on the page well to their right. A
    numbered list fails that last test against the body text beside it, and a table's cells are
    never looked at, so a first column of numbers stays."""
    pages = {p.index: p for p in text.pages}

    def body(page: PageText, c: Char) -> bool:
        shown = c.visible and not c.text.isspace()
        return shown and not _in_band(page, (c.y0 + c.y1) / 2)

    numbers: dict[int, list[_Number]] = defaultdict(list)
    banded: dict[int, list[_Number]] = defaultdict(list)  # in a margin band
    for i, piece in enumerate(pieces):
        page = pages.get(piece.page)
        if not _is_text(piece) or page is None:
            continue
        for j, line in enumerate(piece.lines):
            chars = _leading_number(line)
            if chars is not None:
                value = int("".join(c.text for c in chars))
                into = numbers if all(body(page, c) for c in chars) else banded
                into[piece.page].append(_Number((i, j), chars, value))

    doomed: dict[tuple[int, int], set[int]] = {}
    counts: dict[int, int] = {}
    for number, found in sorted(numbers.items()):
        page = pages[number]
        column = sorted(_column(found), key=lambda n: n.chars[0].baseline)
        if len(column) < _LINE_NUMBERS:
            continue
        values = [n.value for n in column]
        if any(b <= a for a, b in pairwise(values)):
            continue
        taken = {c.index for n in column for c in n.chars}
        others = [c for c in page.chars if body(page, c) and c.index not in taken]
        right = max(n.x1 for n in column)
        size = max(c.size for n in column for c in n.chars)
        if others and min(c.x0 for c in others) < right + _LINE_NUMBER_GAP * size:
            continue
        if len(column) < _LINE_NUMBER_SHARE * _line_count([c for c in page.chars if body(page, c)]):
            continue
        column += _band_numbers(column, banded[number])
        for n in column:
            doomed[n.at] = {c.index for c in n.chars}
        counts[number] = len(column)

    if not doomed:
        return pieces, {}
    out: list[Piece] = []
    for i, piece in enumerate(pieces):
        if not any((i, j) in doomed for j in range(len(piece.lines))):
            out.append(piece)
            continue
        kept: list[Line] = []
        for j, line in enumerate(piece.lines):
            gone = doomed.get((i, j))
            if gone is None:
                kept.append(line)
                continue
            rest = tuple(c for c in line.chars if c.index not in gone)
            shown = [c for c in rest if not c.text.isspace()]
            if not shown:
                gone = {c.index for c in line.chars}  # the blanks go with the number
            for c in line.chars:
                if c.index in gone:
                    ledger.drop(line.page, c.index, "line-number")
            if shown:
                box = (
                    min(c.x0 for c in shown),
                    min(c.y0 for c in shown),
                    max(c.x1 for c in shown),
                    max(c.y1 for c in shown),
                )
                kept.append(Line(line.page, rest, box))
        if kept:
            out.append(replace(piece, lines=kept))
    return out, counts


def _is_contents(line: Line) -> bool:
    return _CONTENTS_LINE.match(line.text) is not None


def _has_leader(line: Line) -> bool:
    return _LEADER.search(line.text) is not None


def _reads_as_entries(piece: Piece) -> bool:
    """A table whose rows each read as a contents entry: a title with a letter, then a page
    number, the page numbers not decreasing down the rows."""
    if piece.table is None or not piece.cells:
        return False
    rows: dict[int, list[tuple[int, str]]] = defaultdict(list)
    for (row, col), lines in piece.cells.items():
        cell = " ".join(line.text for line in lines).strip()
        if cell:
            rows[row].append((col, cell))
    if len(rows) < _TABLE_ROWS:
        return False
    previous = 0
    for row in sorted(rows):
        cells = sorted(rows[row])
        if len(cells) < 2 or not _PAGE_NUMBER.fullmatch(cells[-1][1]):
            return False
        if not any(c.isalpha() for _, cell in cells[:-1] for c in cell):
            return False
        number = int(cells[-1][1])
        if number < previous:
            return False
        previous = number
    return True


def _is_heading(piece: Piece) -> bool:
    heading = " ".join(line.text for line in piece.lines).strip()
    return (
        piece.label in _HEADING_LABELS
        and _is_text(piece)
        and _CONTENTS_HEADING.match(heading) is not None
    )


def _drop_contents(
    pieces: list[Piece], ledger: Ledger, page_count: int
) -> tuple[list[Piece], set[int]]:
    # The text lines in reading order as (piece index, line index); a table or picture is a None
    # that ends a run.
    seq: list[tuple[int, int] | None] = []
    for i, piece in enumerate(pieces):
        if _is_text(piece):
            seq.extend((i, j) for j in range(len(piece.lines)))
        elif seq and seq[-1] is not None:
            seq.append(None)

    def line_at(entry: tuple[int, int]) -> Line:
        return pieces[entry[0]].lines[entry[1]]

    def contents_at(entry: tuple[int, int]) -> bool:
        line = line_at(entry)
        if pieces[entry[0]].label in _BOUNDARY_LABELS:
            return _has_leader(line) and _is_contents(line)  # Docling labels some contents so
        return _is_contents(line)

    def run_from(start: int, *, led: bool = False) -> int:
        """The index after the run of contents lines that starts at `start`. A run starts on a
        line with a leader, unless a contents heading leads it (`led`); it ends at a heading or
        caption, at a line without a leader once leaders are the majority, and at a page
        number lower than the one before it or past the document's last page."""
        end = start
        leaders = 0
        previous = 0
        while end < len(seq):
            entry = seq[end]
            if entry is None or not contents_at(entry):
                break
            line = line_at(entry)
            leader = _has_leader(line)
            if not leader and (2 * leaders > end - start or (end == start and not led)):
                break
            match = _CONTENTS_LINE.match(line.text)
            assert match is not None
            number = int(match["page"])
            if number < previous or number > page_count:
                break
            previous = number
            leaders += leader
            end += 1
        return end

    doomed: set[tuple[int, int]] = set()
    tables: set[int] = set()
    for i, piece in enumerate(pieces):
        if piece.label == "document_index" and _is_text(piece):
            doomed.update((i, j) for j in range(len(piece.lines)))
        elif piece.table is not None:
            after_heading = i > 0 and _is_heading(pieces[i - 1])
            if piece.table.label == "document_index" or (
                after_heading and _reads_as_entries(piece)
            ):
                tables.add(i)
                if after_heading:
                    doomed.update((i - 1, j) for j in range(len(pieces[i - 1].lines)))

    # A contents heading, with the contents lines after it (if there are none, it stays).
    for k, entry in enumerate(seq):
        if entry is None or entry[1] != 0:
            continue
        piece = pieces[entry[0]]
        heading = " ".join(line.text for line in piece.lines).strip()
        if piece.label in _HEADING_LABELS and _CONTENTS_HEADING.match(heading):
            after = k + len(piece.lines)
            end = run_from(after, led=True)
            if end > after:
                doomed.update(e for e in seq[k:end] if e is not None)

    # A run of contents lines, at least half of them with dot leaders.
    k = 0
    while k < len(seq):
        entry = seq[k]
        if entry is None or not contents_at(entry):
            k += 1
            continue
        end = run_from(k)
        if end == k:
            k += 1
            continue
        run = [e for e in seq[k:end] if e is not None]
        leaders = sum(_has_leader(line_at(e)) for e in run)
        if len(run) >= _RUN_LINES and leaders >= _RUN_LEADERS * len(run):
            doomed.update(run)
        k = end

    pages: set[int] = set()
    out: list[Piece] = []
    for i, piece in enumerate(pieces):
        if i in tables:
            for cell_lines in (piece.cells or {}).values():
                for line in cell_lines:
                    _drop(ledger, line, "contents")
            pages.add(piece.page)
            continue
        if not _is_text(piece):
            out.append(piece)
            continue
        kept: list[Line] = []
        for j, line in enumerate(piece.lines):
            if (i, j) in doomed:
                _drop(ledger, line, "contents")
                pages.add(line.page)
            else:
                kept.append(line)
        if kept:
            out.append(_with(piece, kept))
    return out, pages


def _ranges(pages: list[int]) -> str:
    """0-based page indexes as 1-based numbers: 'page 2', 'pages 2 to 3, 7' with an en dash."""
    numbers = sorted(p + 1 for p in pages)
    spans: list[str] = []
    start = prev = numbers[0]
    for number in [*numbers[1:], None]:
        if number is not None and number == prev + 1:
            prev = number
            continue
        spans.append(str(start) if start == prev else f"{start}{_EN_DASH}{prev}")
        if number is not None:
            start = prev = number
    return ("page " if len(numbers) == 1 else "pages ") + ", ".join(spans)


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" + ("" if count == 1 else "s")


def dropped_flag(d: Dropped) -> Flag | None:
    parts: list[str] = []
    if d.furniture or d.pictures:
        what: list[str] = []
        if d.furniture:
            what.append(_plural(sum(d.furniture.values()), "line"))
        if d.pictures:
            what.append(_plural(sum(d.pictures.values()), "picture"))
        pages = _plural(len(set(d.furniture) | set(d.pictures)), "page")
        parts.append(f"Dropped as page furniture: {' and '.join(what)} on {pages}")
    if d.line_numbers:
        numbers = _plural(sum(d.line_numbers.values()), "line number")
        where = f"{numbers} on {_plural(len(d.line_numbers), 'page')}"
        parts.append(where if parts else "Dropped " + where)
    if d.contents_pages:
        where = f"contents and lists on {_ranges(list(d.contents_pages))}"
        parts.append(where if parts else "Dropped " + where)
    if not parts:
        return None
    return Flag(code="structure_inferred", severity="info", at=None, message="; ".join(parts))
