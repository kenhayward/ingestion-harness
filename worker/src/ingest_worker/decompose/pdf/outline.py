"""The heading tree: headings and levels from the PDF's bookmarks, else typed numbers, else
inference (spec section 4.4).

Bookmarks are the author's own outline, so they win when at least half of them find their line
on the page. Without them, Docling's section headers are the headings and a typed number
("2.1 Scope") gives the level; an unnumbered one goes one below the previous numbered heading.
The typed number of a heading is dropped from the ledger (the section numbering is rebuilt from
the tree), except where a bookmark's level disagrees with the number (the number is then text).
"""

from __future__ import annotations

import io
import re
from collections.abc import Sequence
from dataclasses import dataclass, replace

from pypdf import PdfReader
from pypdf.errors import PyPdfError
from pypdf.generic import Destination, NullObject

from ingest_worker.decompose.model import Flag
from ingest_worker.decompose.pdf.layout import BBox
from ingest_worker.decompose.pdf.pieces import Ledger, Line, Piece
from ingest_worker.decompose.tables import CAPTION_PREFIX

_NUMBER = re.compile(r"^\s*(\d{1,3}(?:\.\d{1,3})*)(?:\.\s*|\s+)(?=[^\d\s.])")

#: At least this fraction of the bookmarks must find their line for the outline to be trusted.
_TRUSTED = 0.5

_READ_ERRORS = (PyPdfError, ValueError, KeyError, TypeError, AttributeError, IndexError)


@dataclass(frozen=True)
class Bookmark:
    level: int  # from 1
    title: str
    page: int | None  # from 0
    top: float | None  # points from the page top, from the /XYZ destination


def typed_number(text: str) -> tuple[int, int] | None:
    """The level a typed section number gives ("2.1" is 2) and the length it takes, or None."""
    match = _NUMBER.match(text)
    if match is None:
        return None
    return match.group(1).count(".") + 1, match.end()


def read_bookmarks(data: bytes) -> list[Bookmark]:
    """The outline in document order, with levels from nesting."""
    try:
        reader = PdfReader(io.BytesIO(data))
        marks: list[Bookmark] = []
        _walk(reader, reader.outline, 1, marks)
    except _READ_ERRORS:
        return []
    return marks


def _walk(reader: PdfReader, items: Sequence[object], level: int, out: list[Bookmark]) -> None:
    for item in items:
        if isinstance(item, list):
            _walk(reader, item, level + 1, out)
        elif isinstance(item, Destination):
            page, top = _target(reader, item)
            out.append(Bookmark(level, str(item.title), page, top))


def _target(reader: PdfReader, dest: Destination) -> tuple[int | None, float | None]:
    try:
        page = reader.get_destination_page_number(dest)
        if page is None or not 0 <= page < len(reader.pages):
            return None, None
        top = dest.top
        if top is None or isinstance(top, NullObject):
            return page, None
        return page, float(reader.pages[page].mediabox.height) - float(top)
    except _READ_ERRORS:
        return None, None


def _key(text: str) -> str:
    number = typed_number(text)
    rest = text[number[1] :] if number else text
    return "".join(rest.lower().split())


@dataclass
class _Match:
    bookmark: Bookmark
    piece: Piece
    start: int
    end: int  # the piece's lines start..end


def assign_headings(
    pieces: list[Piece], bookmarks: list[Bookmark], ledger: Ledger
) -> tuple[list[Piece], list[Flag]]:
    """Set `heading_level` on the heading pieces, splitting a piece around a bookmarked line.

    A flag's `at` is a piece ref until block ids exist.
    """
    matches, missed = _match_bookmarks(pieces, bookmarks)
    if bookmarks and len(matches) >= _TRUSTED * len(bookmarks):
        flags = [
            Flag(
                code="structure_inferred",
                severity="warning",
                at=None,
                message=f"Bookmark left out: {mark.title}",
            )
            for mark in missed
        ]
        return _apply_bookmarks(pieces, matches, ledger), flags
    return pieces, _number_headings(pieces, ledger)


def _spans(piece: Piece) -> list[tuple[int, int]]:
    count = len(piece.lines)
    spans = [(i, i + 1) for i in range(count)]
    if count > 1:
        spans.append((0, count))  # a heading set over all the piece's lines
    return spans


def _span_text(piece: Piece, span: tuple[int, int]) -> str:
    return " ".join(line.text for line in piece.lines[span[0] : span[1]])


def _match_bookmarks(
    pieces: list[Piece], bookmarks: list[Bookmark]
) -> tuple[list[_Match], list[Bookmark]]:
    matches: list[_Match] = []
    missed: list[Bookmark] = []
    taken: set[tuple[int, int]] = set()  # (id(piece), line index)
    for mark in bookmarks:
        key = _key(mark.title)
        best: tuple[float, _Match] | None = None
        if mark.page is not None and key and not CAPTION_PREFIX.match(mark.title):
            for piece in pieces:
                if piece.page != mark.page or piece.table is not None or piece.picture is not None:
                    continue
                for span in _spans(piece):
                    if _key(_span_text(piece, span)) != key:
                        continue
                    if any((id(piece), i) in taken for i in range(*span)):
                        continue
                    top = piece.lines[span[0]].bbox[1]
                    distance = 0.0 if mark.top is None else abs(top - mark.top)
                    if best is None or distance < best[0]:
                        best = (distance, _Match(mark, piece, *span))
        if best is None:
            missed.append(mark)
            continue
        match = best[1]
        taken.update((id(match.piece), i) for i in range(match.start, match.end))
        matches.append(match)
    return matches, missed


def _apply_bookmarks(pieces: list[Piece], matches: list[_Match], ledger: Ledger) -> list[Piece]:
    by_piece: dict[int, list[_Match]] = {}
    for match in matches:
        by_piece.setdefault(id(match.piece), []).append(match)
    out: list[Piece] = []
    for piece in pieces:
        if id(piece) in by_piece:
            out.extend(_split(piece, sorted(by_piece[id(piece)], key=lambda m: m.start), ledger))
            continue
        if piece.label == "section_header":
            piece.label = "text"  # Docling's heading that the outline does not have
        out.append(piece)
    return out


def _split(piece: Piece, matches: list[_Match], ledger: Ledger) -> list[Piece]:
    """The piece cut around each matched line: lines before get `<ref>~a`, the heading keeps the
    ref, and lines after get `<ref>~b` (cut again for a further heading)."""
    out: list[Piece] = []
    current = piece
    offset = 0
    for match in matches:
        start, end = match.start - offset, match.end - offset
        lines = current.lines
        if start > 0:
            out.append(_part(current, f"{current.ref}~a", lines[:start], ledger))
        after = (
            _part(current, f"{current.ref}~b", lines[end:], ledger) if end < len(lines) else None
        )
        current.lines = lines[start:end]
        current.bbox = _bounds(current.lines)
        current.label = "section_header"
        current.heading_level = match.bookmark.level
        _drop_number(current, ledger, only_level=match.bookmark.level)
        out.append(current)
        if after is None:
            return out
        current, offset = after, match.end
    out.append(current)
    return out


def _part(piece: Piece, ref: str, lines: list[Line], ledger: Ledger) -> Piece:
    """A piece of the same kind over `lines`, which take over those lines' ledger entries."""
    for line in lines:
        entries = ledger.entries(line.page)
        for c in line.chars:
            if entries.get(c.index) == [piece.ref]:
                ledger.reassign(line.page, c.index, ref)
    return replace(piece, ref=ref, lines=lines, bbox=_bounds(lines))


def _bounds(lines: list[Line]) -> BBox:
    return (
        min(line.bbox[0] for line in lines),
        min(line.bbox[1] for line in lines),
        max(line.bbox[2] for line in lines),
        max(line.bbox[3] for line in lines),
    )


def _number_headings(pieces: list[Piece], ledger: Ledger) -> list[Flag]:
    flags: list[Flag] = []
    previous: int | None = None
    for piece in pieces:
        if piece.label != "section_header" or not piece.lines:
            continue
        number = typed_number(piece.lines[0].text)
        if number is not None:
            piece.heading_level = previous = number[0]
            _drop_number(piece, ledger, only_level=None)
            continue
        piece.heading_level = 1 if previous is None else previous + 1
        flags.append(
            Flag(
                code="structure_inferred",
                severity="warning",
                at=piece.ref,
                message="Heading level inferred",
            )
        )
    return flags


def _drop_number(piece: Piece, ledger: Ledger, *, only_level: int | None) -> None:
    """Drop the typed number's chars from the ledger; with `only_level`, only when the number has
    that many parts (a bookmark's level agreeing with the number, as Word's numbering does)."""
    first = piece.lines[0]
    number = typed_number(first.text)
    if number is None or (only_level is not None and number[0] != only_level):
        return
    wanted = first.text[: number[1]].rstrip()
    for k in range(1, len(first.chars) + 1):
        if Line(first.page, first.chars[:k], first.bbox).text == wanted:
            for c in first.chars[:k]:
                ledger.drop(first.page, c.index, "heading-number")
            return
