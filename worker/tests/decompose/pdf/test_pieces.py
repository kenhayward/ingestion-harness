"""PDF text-layer characters put into Docling's layout items."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ingest_worker.decompose.model import Text
from ingest_worker.decompose.pdf.layout import LayoutDoc, parse_docling
from ingest_worker.decompose.pdf.pieces import Ledger, Piece, attach_text
from ingest_worker.decompose.pdf.textlayer import read_text_layer
from tests.decompose.pdf import docling
from tests.decompose.pdf.make_pdf import Img, Page, Run, make_pdf

FIXTURES = Path(__file__).parent / "fixtures"
HEIGHT = 842.0


def bl(x0: float, y0: float, x1: float, y1: float) -> docling.Box:
    """A top-left box as Docling's bottom-left (left, top, right, bottom)."""
    return (x0, HEIGHT - y0, x1, HEIGHT - y1)


def layout(items: list[dict[str, Any]]) -> LayoutDoc:
    return parse_docling(docling.doc([(595, HEIGHT)], items))


def attach(runs: list[Run], items: list[dict[str, Any]]) -> tuple[list[Piece], Ledger]:
    return attach_text(layout(items), read_text_layer(make_pdf([Page(runs=runs)])))


def text_of(piece: Piece) -> str:
    return " ".join(line.text for line in piece.lines)


def test_text_comes_from_the_text_layer() -> None:
    item = docling.text("text", 1, bl(60, 85, 200, 110))
    item["text"] = "WRONG"
    pieces, _ = attach([Run("Right text", 72, 100)], [item])
    assert [text_of(p) for p in pieces] == ["Right text"]
    assert pieces[0].inlines() == [Text(text="Right text")]


def test_superscript_marker() -> None:
    pieces, _ = attach(
        [Run("3", 72, 100), Run("b", 78, 100, size=7, rise=3)],
        [docling.text("text", 1, bl(60, 85, 200, 110))],
    )
    assert pieces[0].inlines() == [Text(text="3"), Text(text="b", marks=frozenset({"superscript"}))]


def test_subscript_and_bold_marks() -> None:
    pieces, _ = attach(
        [
            Run("H", 72, 100, font="Helvetica-Bold"),
            Run("2", 80, 100, size=7, rise=-3, font="Helvetica-Bold"),
        ],
        [docling.text("text", 1, bl(60, 85, 200, 110))],
    )
    assert pieces[0].inlines() == [
        Text(text="H", marks=frozenset({"bold"})),
        Text(text="2", marks=frozenset({"bold", "subscript"})),
    ]


def test_lines_join_with_one_space_and_gaps_become_spaces() -> None:
    pieces, _ = attach(
        [Run("one", 72, 100), Run("two", 100, 100), Run("three", 72, 118)],
        [docling.text("text", 1, bl(60, 85, 200, 125))],
    )
    assert [line.text for line in pieces[0].lines] == ["one two", "three"]
    assert pieces[0].inlines() == [Text(text="one two three")]


def _table_page() -> tuple[list[Run], dict[str, Any]]:
    runs = [Run(f"R{r}C{c}", 78 + 100 * c, 219 + 30 * r) for r in range(2) for c in range(2)]
    table = docling.table(
        1, bl(72, 200, 272, 260), [(0, 0), (0, 1), (1, 0), (1, 1)], rows=2, cols=2
    )
    for cell in table["data"]["table_cells"]:
        r, c = cell["start_row_offset_idx"], cell["start_col_offset_idx"]
        # cell (1, 1) stops short of the table's right edge
        right = 72 + 100 * c + (80 if (r, c) == (1, 1) else 100)
        cell["bbox"] = {
            "l": 72 + 100 * c,
            "t": 200 + 30 * r,
            "r": right,
            "b": 230 + 30 * r,
            "coord_origin": "TOPLEFT",
        }
    return runs, table


def test_cells_get_their_own_lines() -> None:
    runs, table = _table_page()
    pieces, ledger = attach(runs, [table])
    (piece,) = pieces
    assert piece.table is not None and piece.lines == []
    assert piece.cells is not None
    assert {k: [ln.text for ln in v] for k, v in piece.cells.items()} == {
        (0, 0): ["R0C0"],
        (0, 1): ["R0C1"],
        (1, 0): ["R1C0"],
        (1, 1): ["R1C1"],
    }
    assert all(owners == [piece.ref] for owners in ledger.entries(0).values())


def test_chars_in_a_table_but_in_no_cell_go_to_the_nearest_cell() -> None:
    runs, table = _table_page()
    pieces, ledger = attach([*runs, Run("Z", 254, 252)], [table])
    assert pieces[0].cells is not None
    assert [ln.text for ln in pieces[0].cells[(1, 1)]] == ["R1C1 Z"]
    assert all(len(owners) == 1 for owners in ledger.entries(0).values())


def test_table_cells_without_boxes_keep_every_char_in_the_first_cell() -> None:
    runs, table = _table_page()
    for cell in table["data"]["table_cells"]:
        cell["bbox"] = None
    pieces, ledger = attach(runs, [table])
    (piece,) = pieces
    assert piece.cells is not None
    assert [ln.text for ln in piece.cells[(0, 0)]] == ["R0C0 R0C1", "R1C0 R1C1"]
    assert all(owners == [piece.ref] for owners in ledger.entries(0).values())
    assert len(ledger.entries(0)) == 16


def test_stray_chars_fall_back_to_a_real_cell_when_there_is_no_origin_cell() -> None:
    runs, table = _table_page()
    cells = table["data"]["table_cells"]
    table["data"]["table_cells"] = [
        c for c in cells if (c["start_row_offset_idx"], c["start_col_offset_idx"]) == (1, 1)
    ]
    table["data"]["table_cells"][0]["bbox"] = None
    pieces, ledger = attach(runs, [table])
    (piece,) = pieces
    assert piece.cells is not None and list(piece.cells) == [(1, 1)]
    assert len(piece.cells[(1, 1)]) == 2
    assert len(ledger.entries(0)) == 16


def test_orphan_line_is_kept_and_placed() -> None:
    pieces, ledger = attach(
        [Run("Above", 72, 100), Run("Loose line", 72, 300), Run("Below", 72, 500)],
        [
            docling.text("text", 1, bl(60, 85, 200, 110)),
            docling.text("text", 1, bl(60, 485, 200, 510)),
        ],
    )
    assert [text_of(p) for p in pieces] == ["Above", "Loose line", "Below"]
    assert [p.orphan for p in pieces] == [False, True, False]
    orphan = pieces[1]
    assert orphan.label == "text" and orphan.ref == "orphan-0-0"
    entries = ledger.entries(0)
    assert all(entries[c.index] == [orphan.ref] for line in orphan.lines for c in line.chars)


def test_orphan_before_every_item_is_first_on_its_page() -> None:
    pieces, _ = attach(
        [Run("Loose", 72, 50), Run("Item", 72, 300)],
        [docling.text("text", 1, bl(60, 285, 200, 310))],
    )
    assert [(text_of(p), p.orphan) for p in pieces] == [("Loose", True), ("Item", False)]


def test_orphan_lines_close_together_are_one_piece() -> None:
    pieces, _ = attach([Run("first", 72, 300), Run("second", 72, 316), Run("far", 72, 400)], [])
    assert [text_of(p) for p in pieces] == ["first second", "far"]
    assert [p.ref for p in pieces] == ["orphan-0-0", "orphan-0-1"]


def test_orphan_line_stays_in_its_column() -> None:
    left, right = (60, 200), (320, 520)

    def box(column: tuple[int, int], y: float) -> docling.Box:
        return bl(column[0], y - 15, column[1], y + 10)

    pieces, _ = attach(
        [
            Run("L1", 72, 100),
            Run("L2", 72, 200),
            Run("R1", 332, 100),
            Run("R2", 332, 200),
            Run("left orphan", 72, 300),
            Run("right orphan", 332, 330),
        ],
        [
            docling.text("text", 1, box(left, 100)),
            docling.text("text", 1, box(left, 200)),
            docling.text("text", 1, box(right, 100)),
            docling.text("text", 1, box(right, 200)),
        ],
    )
    assert [text_of(p) for p in pieces] == [
        "L1",
        "L2",
        "left orphan",
        "R1",
        "R2",
        "right orphan",
    ]


def test_picture_owns_the_chars_inside_it() -> None:
    pieces, ledger = attach(
        [Run("Caption in figure", 100, 300), Run("Outside", 72, 100)],
        [docling.picture(1, bl(80, 250, 400, 400))],
    )
    picture = next(p for p in pieces if p.picture is not None)
    assert text_of(picture) == "Caption in figure"
    assert picture.label == "picture"
    assert [text_of(p) for p in pieces if p.orphan] == ["Outside"]
    assert all(len(v) == 1 for v in ledger.entries(0).values())


def test_the_smallest_box_wins() -> None:
    pieces, _ = attach(
        [Run("inner", 100, 300)],
        [
            docling.text("text", 1, bl(60, 200, 500, 500)),
            docling.text("text", 1, bl(90, 285, 200, 310)),
        ],
    )
    assert [text_of(p) for p in pieces] == ["inner"]
    assert pieces[0].ref == "#/texts/1"


def test_an_item_without_chars_is_dropped_and_invisible_chars_are_ignored() -> None:
    pieces, ledger = attach(
        [Run("hidden", 72, 100, invisible=True), Run("shown", 72, 300)],
        [
            docling.text("text", 1, bl(60, 85, 200, 110)),
            docling.text("text", 1, bl(60, 285, 200, 310)),
        ],
    )
    assert [text_of(p) for p in pieces] == ["shown"]
    assert len(ledger.entries(0)) == 5


def test_furniture_layer_is_kept_on_the_piece() -> None:
    pieces, _ = attach(
        [Run("Header", 72, 50), Run("Body", 72, 300)],
        [
            docling.text("page_header", 1, bl(60, 35, 200, 60), furniture=True),
            docling.text("text", 1, bl(60, 285, 200, 310)),
        ],
    )
    assert [p.layer for p in pieces] == ["furniture", "body"]


def test_a_scanned_page_is_skipped() -> None:
    page = Page(runs=[Run("ocr", 72, 100, invisible=True)], images=[Img(0, 0, 595, 842)])
    pieces, ledger = attach_text(
        layout([docling.text("text", 1, bl(60, 85, 200, 110))]),
        read_text_layer(make_pdf([page])),
    )
    assert pieces == [] and ledger.entries(0) == {}


def test_ledger_drop_and_rename() -> None:
    ledger = Ledger()
    ledger.own(0, 1, "a")
    ledger.own(0, 2, "a")
    ledger.rename("a", "b1")
    assert ledger.entries(0) == {1: ["b1"], 2: ["b1"]}
    ledger.drop(0, 2, "furniture")
    assert ledger.entries(0)[2] == ["dropped:furniture"]


def test_every_visible_char_is_owned_once() -> None:
    raw = json.loads((FIXTURES / "two-pages.docling.json").read_text("utf-8"))
    text = read_text_layer((FIXTURES / "two-pages.pdf").read_bytes())
    pieces, ledger = attach_text(parse_docling(raw), text)
    assert pieces
    for page in text.pages:
        entries = ledger.entries(page.index)
        for char in page.chars:
            if char.visible:
                assert len(entries[char.index]) == 1, (page.index, char)
        assert set(entries) == {c.index for c in page.chars if c.visible}


def test_reassign_moves_a_chars_ownership() -> None:
    ledger = Ledger()
    ledger.own(0, 3, "a")
    ledger.reassign(0, 3, "b")
    assert ledger.entries(0) == {3: ["b"]}
