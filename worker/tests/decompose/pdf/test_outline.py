"""Headings and their levels: bookmarks first, then typed numbers, then inference."""

from __future__ import annotations

from typing import Any

from ingest_worker.decompose.pdf.layout import parse_docling
from ingest_worker.decompose.pdf.outline import (
    Bookmark,
    assign_headings,
    read_bookmarks,
    typed_number,
)
from ingest_worker.decompose.pdf.pieces import Ledger, Piece, attach_text
from ingest_worker.decompose.pdf.textlayer import read_text_layer
from tests.decompose.pdf import docling
from tests.decompose.pdf.make_pdf import Page, Run, make_pdf

HEIGHT = 842.0


def bl(x0: float, y0: float, x1: float, y1: float) -> docling.Box:
    return (x0, HEIGHT - y0, x1, HEIGHT - y1)


def head(page: int, y: float) -> dict[str, Any]:
    return docling.text("section_header", page, bl(60, y - 12, 400, y + 4))


def para(page: int, y0: float, y1: float) -> dict[str, Any]:
    return docling.text("text", page, bl(60, y0, 400, y1))


def build(
    runs: list[Run],
    items: list[dict[str, Any]],
    outline: list[tuple[int, str, int, float | None]] = (),  # type: ignore[assignment]
) -> tuple[list[Piece], Ledger, list[Bookmark]]:
    data = make_pdf([Page(runs=runs)], outline=outline)
    layout = parse_docling(docling.doc([(595, HEIGHT)], items))
    pieces, ledger = attach_text(layout, read_text_layer(data))
    return pieces, ledger, read_bookmarks(data)


def levels(pieces: list[Piece]) -> list[int | None]:
    return [p.heading_level for p in pieces]


def test_typed_number_forms() -> None:
    assert typed_number("2.1 Scope") == (2, 4)
    assert typed_number("2.1. Scope") == (2, 5)
    assert typed_number("1.4.Microbial") == (2, 4)
    assert typed_number("2023 Results") is None
    assert typed_number("1.5mg Dose") is None


def test_read_bookmarks_levels_pages_and_tops() -> None:
    data = make_pdf(
        [Page(runs=[Run("x", 72, 100)]), Page(runs=[Run("y", 72, 100)])],
        outline=[(1, "One", 0, 90), (2, "Two", 1, None), (1, "Three", 1, 300)],
    )
    marks = read_bookmarks(data)
    assert [(b.level, b.title, b.page) for b in marks] == [
        (1, "One", 0),
        (2, "Two", 1),
        (1, "Three", 1),
    ]
    assert marks[0].top == 90
    assert marks[1].top is None
    assert marks[2].top == 300
    assert read_bookmarks(make_pdf([Page()])) == []


def test_bookmarks_set_headings_and_levels() -> None:
    runs = [
        Run("1 Intro", 72, 100),
        Run("Body", 72, 130),
        Run("2.1 Aim", 72, 200),
        Run("2.2 Scope", 72, 300),
        Run("Stray", 72, 400),
    ]
    items = [head(1, 100), para(1, 120, 135), head(1, 200), head(1, 300), head(1, 400)]
    outline = [(1, "1 Intro", 0, 90), (2, "2.1 Aim", 0, 190), (2, "2.2 Scope", 0, 290)]
    pieces, ledger, marks = build(runs, items, outline)
    out, flags = assign_headings(pieces, marks, ledger)
    assert levels(out) == [1, None, 2, 2, None]
    assert out[4].label == "text"
    assert flags == []


def test_bookmark_line_inside_a_paragraph_is_split_out() -> None:
    runs = [Run("Before text", 72, 100), Run("2 Scope", 72, 114), Run("After text", 72, 128)]
    pieces, ledger, marks = build(runs, [para(1, 85, 135)], [(1, "Scope", 0, 104)])
    ref = pieces[0].ref
    out, _ = assign_headings(pieces, marks, ledger)
    assert [p.ref for p in out] == [f"{ref}~a", ref, f"{ref}~b"]
    assert [[line.text for line in p.lines] for p in out] == [
        ["Before text"],
        ["2 Scope"],
        ["After text"],
    ]
    assert levels(out) == [None, 1, None]
    assert out[0].bbox[3] < out[1].bbox[1]
    owners = {
        c.text: ledger.entries(0)[c.index] for p in out for line in p.lines for c in line.chars
    }
    assert owners["B"] == [f"{ref}~a"]
    assert owners["A"] == [f"{ref}~b"]
    assert owners["S"] == [ref]


def test_bookmark_without_a_match_is_flagged() -> None:
    runs = [Run("1 Intro", 72, 100), Run("2 Method", 72, 200), Run("Table 1 Results", 72, 300)]
    items = [head(1, 100), head(1, 200), para(1, 290, 305)]
    outline = [
        (1, "1 Intro", 0, 90),
        (1, "2 Method", 0, 190),
        (1, "3 Missing", 0, 250),
        (1, "Table 1 Results", 0, 290),
    ]
    pieces, ledger, marks = build(runs, items, outline)
    out, flags = assign_headings(pieces, marks, ledger)
    assert levels(out) == [1, 1, None]
    assert [(f.code, f.severity, f.at, f.message) for f in flags] == [
        ("structure_inferred", "warning", None, "Bookmark left out: 3 Missing"),
        ("structure_inferred", "warning", None, "Bookmark left out: Table 1 Results"),
    ]


def test_untrusted_bookmarks_fall_back_to_numbering() -> None:
    runs = [Run("1 Intro", 72, 100), Run("2.1 Aim", 72, 200), Run("Other", 72, 300)]
    items = [head(1, 100), head(1, 200), head(1, 300)]
    outline = [(1, "1 Intro", 0, 90), (1, "Nowhere", 0, 190), (1, "Elsewhere", 0, 290)]
    pieces, ledger, marks = build(runs, items, outline)
    out, flags = assign_headings(pieces, marks, ledger)
    assert levels(out) == [1, 2, 3]
    assert [f.message for f in flags] == ["Heading level inferred"]


def test_unnumbered_heading_goes_one_below() -> None:
    runs = [Run("3 Method", 72, 100), Run("Conditions", 72, 200), Run("Body", 72, 300)]
    items = [head(1, 100), head(1, 200), para(1, 290, 305)]
    pieces, ledger, _ = build(runs, items)
    out, flags = assign_headings(pieces, [], ledger)
    assert levels(out) == [1, 2, None]
    assert len(flags) == 1
    assert (flags[0].code, flags[0].at, flags[0].message) == (
        "structure_inferred",
        out[1].ref,
        "Heading level inferred",
    )


def test_first_unnumbered_heading_is_level_one_and_title_stays_text() -> None:
    runs = [Run("A Title", 72, 60), Run("Preface", 72, 100)]
    items = [docling.text("title", 1, bl(60, 48, 400, 64)), head(1, 100)]
    pieces, ledger, _ = build(runs, items)
    out, flags = assign_headings(pieces, [], ledger)
    assert levels(out) == [None, 1]
    assert out[0].label == "title"
    assert len(flags) == 1


def _owners(piece: Piece, ledger: Ledger) -> list[list[str]]:
    return [ledger.entries(0)[c.index] for c in piece.lines[0].chars]


def test_heading_number_chars_are_dropped_in_the_ledger() -> None:
    runs = [Run("2.1 Scope", 72, 100)]
    pieces, ledger, _ = build(runs, [head(1, 100)])
    out, _ = assign_headings(pieces, [], ledger)
    owners = _owners(out[0], ledger)
    assert owners[:3] == [["dropped:heading-number"]] * 3  # "2.1"
    assert owners[-1] == [out[0].ref]


def test_bookmark_headings_drop_the_number_only_when_the_parts_equal_the_level() -> None:
    runs = [Run("2.1 Scope", 72, 100), Run("2.2 Aim", 72, 200)]
    items = [head(1, 100), head(1, 200)]
    outline = [(1, "Scope", 0, 90), (2, "Aim", 0, 190)]
    pieces, ledger, marks = build(runs, items, outline)
    out, _ = assign_headings(pieces, marks, ledger)
    assert levels(out) == [1, 2]
    assert _owners(out[0], ledger)[0] == [out[0].ref]  # "2.1" has two parts, the level is 1
    assert _owners(out[1], ledger)[0] == ["dropped:heading-number"]


def test_two_bookmarks_in_one_paragraph_split_it_in_turn() -> None:
    runs = [
        Run("Top", 72, 100),
        Run("Alpha", 72, 114),
        Run("Middle", 72, 128),
        Run("Beta", 72, 142),
    ]
    outline = [(1, "Alpha", 0, 104), (1, "Beta", 0, 132)]
    pieces, ledger, marks = build(runs, [para(1, 85, 150)], outline)
    ref = pieces[0].ref
    out, _ = assign_headings(pieces, marks, ledger)
    assert [p.ref for p in out] == [f"{ref}~a", ref, f"{ref}~b~a", f"{ref}~b"]
    assert [[line.text for line in p.lines] for p in out] == [
        ["Top"],
        ["Alpha"],
        ["Middle"],
        ["Beta"],
    ]
    assert levels(out) == [None, 1, None, 1]
    owners = {
        c.text: ledger.entries(0)[c.index] for p in out for line in p.lines for c in line.chars
    }
    assert owners["M"] == [f"{ref}~b~a"]
    assert owners["B"] == [f"{ref}~b"]
