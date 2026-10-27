"""Page furniture and tables of contents dropped from the pieces, under guards.

Furniture is decided per line: a line is furniture only if it lies in the top or bottom margin
band of its page, and Docling put it in the furniture layer or its text repeats at the same height
on enough pages. A furniture label in the body is ignored. Contents are a `document_index` item,
a contents heading with the contents lines after it, or a run of contents lines with dot leaders
that starts on a leader line; a run's page numbers never go back nor past the last page. One
contents-like line in the body is kept. Dropped chars are recorded in the ledger.
"""

from __future__ import annotations

import math
import re
from collections import defaultdict
from dataclasses import dataclass, replace

from ingest_worker.decompose.model import Flag, Property
from ingest_worker.decompose.pdf.pieces import DropReason, Ledger, Line, Piece
from ingest_worker.decompose.pdf.textlayer import TextLayer

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


@dataclass(frozen=True)
class Dropped:
    #: Page index (0-based) to the number of furniture lines dropped from it.
    furniture: dict[int, int]
    #: Page indexes (0-based, ascending) where contents were dropped.
    contents_pages: tuple[int, ...]


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
    # scanned pages have their own rule (scanned.py), and don't count here (spec 15.4)
    heights = {p.index: p.height for p in text.pages if p.kind == "born_digital"}
    needed = max(_REPEAT_PAGES, math.ceil(len(heights) / 2))

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
            if text_ and in_band(line) and (piece.layer == "furniture" or repeats(line)):
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

    remaining, contents_pages = _drop_contents(remaining, ledger, len(text.pages))
    dropped = Dropped(dict(sorted(furniture.items())), tuple(sorted(contents_pages)))
    return remaining, dropped, list(properties.values())


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
    if d.furniture:
        lines = _plural(sum(d.furniture.values()), "line")
        pages = _plural(len(d.furniture), "page")
        parts.append(f"Dropped as page furniture: {lines} on {pages}")
    if d.contents_pages:
        where = f"contents and lists on {_ranges(list(d.contents_pages))}"
        parts.append(where if parts else "Dropped " + where)
    if not parts:
        return None
    return Flag(code="structure_inferred", severity="info", at=None, message="; ".join(parts))
