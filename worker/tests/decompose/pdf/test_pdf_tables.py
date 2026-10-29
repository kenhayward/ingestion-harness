"""PDF tables: the grid from Docling, joins across pages, captions, notes and alignment."""

from __future__ import annotations

from typing import Any

from ingest_worker.decompose.model import Cell, Paragraph, Table, TableNote, Text
from ingest_worker.decompose.pdf.layout import analyse_document, parse_docling
from ingest_worker.decompose.pdf.pieces import Ledger, Piece, attach_text
from ingest_worker.decompose.pdf.tables import (
    build_table,
    headers_above_tables,
    join_split_tables,
)
from ingest_worker.decompose.pdf.textlayer import TextLayer, read_text_layer
from tests.decompose.pdf import docling
from tests.decompose.pdf.fakes import FakeLayout
from tests.decompose.pdf.make_pdf import Page, Run, make_pdf

WIDTH, HEIGHT = 595.0, 842.0
#: Column edges and row height of the tables drawn here.
COLS = (72.0, 172.0, 272.0, 372.0)
ROW = 20.0

#: A cell: (row, col, row_span, col_span, header).
Spec = tuple[int, int, int, int, bool]


def bl(x0: float, y0: float, x1: float, y1: float, height: float = HEIGHT) -> docling.Box:
    return (x0, height - y0, x1, height - y1)


def cell_box(
    r: int, c: int, rs: int = 1, cs: int = 1, top: float = 100, cols: tuple[float, ...] = COLS
) -> tuple[float, float, float, float]:
    return (cols[c], top + ROW * r, cols[c + cs], top + ROW * (r + rs))


def grid(
    page: int,
    specs: list[Spec],
    *,
    rows: int,
    cols: int,
    top: float = 100,
    height: float = HEIGHT,
    edges: tuple[float, ...] = COLS,
    captions: list[str] = (),  # type: ignore[assignment]
) -> dict[str, Any]:
    """A Docling table node whose cells are the boxes of `cell_box`."""
    data = []
    for r, c, rs, cs, header in specs:
        x0, y0, x1, y1 = cell_box(r, c, rs, cs, top, edges)
        data.append(
            {
                "bbox": {"l": x0, "t": y0, "r": x1, "b": y1, "coord_origin": "TOPLEFT"},
                "row_span": rs,
                "col_span": cs,
                "start_row_offset_idx": r,
                "start_col_offset_idx": c,
                "column_header": header,
                "row_header": False,
            }
        )
    return {
        "_kind": "tables",
        "label": "table",
        "content_layer": "body",
        "prov": [
            {
                "page_no": page,
                "bbox": {
                    **dict(
                        zip(
                            "ltrb",
                            bl(edges[0], top, edges[cols], top + ROW * rows, height),
                            strict=True,
                        )
                    ),
                    "coord_origin": "BOTTOMLEFT",
                },
                "charspan": [0, 0],
            }
        ],
        "captions": [{"$ref": ref} for ref in captions],
        "data": {"num_rows": rows, "num_cols": cols, "table_cells": data},
    }


def simple(rows: int, cols: int, header_rows: int = 1) -> list[Spec]:
    return [(r, c, 1, 1, r < header_rows) for r in range(rows) for c in range(cols)]


def cell_runs(
    texts: dict[tuple[int, int], str], top: float = 100, edges: tuple[float, ...] = COLS
) -> list[Run]:
    return [Run(t, edges[c] + 4, top + ROW * r + 14) for (r, c), t in texts.items()]


def build(
    pages: list[Page], items: list[dict[str, Any]], sizes: list[tuple[float, float]] | None = None
) -> tuple[list[Piece], TextLayer, Ledger]:
    text = read_text_layer(make_pdf(pages))
    layout = parse_docling(docling.doc(sizes or [(WIDTH, HEIGHT)] * len(pages), items))
    pieces, ledger = attach_text(layout, text)
    return pieces, text, ledger


def cell_text(cell: Cell) -> str:
    out = []
    for block in cell.blocks:
        assert isinstance(block, Paragraph)
        out.append("".join(i.text for i in block.inlines if isinstance(i, Text)))
    return "\n".join(out)


def grid_texts(table: Table) -> list[list[str]]:
    return [[cell_text(cell) for cell in row.cells] for row in table.rows]


def owner(ledger: Ledger, text: TextLayer, page: int, char: str) -> list[str]:
    c = next(c for c in text.pages[page].chars if c.text == char)
    return ledger.entries(page)[c.index]


def tables_of(pieces: list[Piece]) -> list[Piece]:
    return [p for p in pieces if p.table is not None]


# --- The grid --------------------------------------------------------------------------------


def test_grid_and_spans() -> None:
    texts = {(0, 0): "Span", (0, 1): "B", (0, 2): "C", (1, 1): "E", (2, 0): "G", (2, 2): "I"}
    specs: list[Spec] = [(0, 0, 2, 1, True), (0, 1, 1, 1, True), (0, 2, 1, 1, True)]
    specs += [(1, 1, 1, 1, False), (1, 2, 1, 1, False)]
    specs += [(2, c, 1, 1, False) for c in range(3)]
    pieces, text, ledger = build([Page(runs=cell_runs(texts))], [grid(1, specs, rows=3, cols=3)])
    table, consumed, flags = build_table(pieces[0], "t-1", [], [], ledger, text.pages[0])
    assert grid_texts(table) == [["Span", "B", "C"], ["E", ""], ["G", "", "I"]]
    assert table.rows[0].cells[0].row_span == 2
    assert [len(row.cells) for row in table.rows] == [3, 2, 3]
    assert table.rows[1].cells[1].blocks == []  # an empty cell has no blocks, as in Word
    assert table.header_rows == 1
    assert [c.header for c in table.rows[0].cells] == [True, True, True]
    assert not table.rows[1].cells[0].header
    assert table.column_widths == [1 / 3, 1 / 3, 1 / 3]
    assert not table.wide
    assert table.caption == [] and not table.numbered and table.key is None
    assert consumed == set()
    assert [(f.code, f.severity, f.at, f.message) for f in flags] == [
        ("structure_inferred", "warning", "t-1", "Table grid inferred from layout")
    ]
    first = table.rows[0].cells[0].blocks[0]
    assert isinstance(first, Paragraph)
    assert first.id == "t-1#cell-1#p-1"


def test_column_widths_follow_the_cell_edges() -> None:
    edges = (72.0, 122.0, 272.0, 472.0)
    texts = {(0, 0): "A", (0, 1): "B", (0, 2): "C"}
    pieces, text, ledger = build(
        [Page(runs=cell_runs(texts, edges=edges))],
        [grid(1, simple(1, 3), rows=1, cols=3, edges=edges)],
    )
    table, _, _ = build_table(pieces[0], "t-1", [], [], ledger, text.pages[0])
    assert table.column_widths == [0.125, 0.375, 0.5]


# --- Joins across pages ----------------------------------------------------------------------


def split_pages(second: dict[tuple[int, int], str], *, top2: float = 100) -> list[Page]:
    first = {(0, 0): "A", (0, 1): "B", (1, 0): "1", (1, 1): "2"}
    return [
        Page(runs=[Run("Intro", 72, 80), *cell_runs(first, top=700)]),
        Page(runs=[*cell_runs(second, top=top2), Run("After", 72, 300)]),
    ]


SECOND = {(0, 0): "A", (0, 1): "B", (1, 0): "3", (1, 1): "4"}


def para(page: int, y0: float, y1: float) -> dict[str, Any]:
    return docling.text("text", page, bl(60, y0, 400, y1))


def test_split_table_joins_and_drops_repeated_header() -> None:
    items = [
        para(1, 65, 85),
        grid(1, simple(2, 2), rows=2, cols=2, top=700),
        grid(2, simple(2, 2), rows=2, cols=2),
        para(2, 285, 305),
    ]
    pieces, text, ledger = build(split_pages(SECOND), items)
    joined = join_split_tables(pieces, text, ledger)
    tables = tables_of(joined)
    assert len(tables) == 1
    assert len(joined) == 3
    assert tables[0].ref == tables_of(pieces)[0].ref
    table, _, flags = build_table(tables[0], "t-1", joined[2:], joined[:1], ledger, text.pages[0])
    assert grid_texts(table) == [["A", "B"], ["1", "2"], ["3", "4"]]
    assert table.header_rows == 1
    assert owner(ledger, text, 1, "A") == ["dropped:repeated-header"]
    assert owner(ledger, text, 1, "3") == [tables[0].ref]
    assert owner(ledger, text, 0, "A") == [tables[0].ref]
    assert [f.message for f in flags] == [
        "Table grid inferred from layout; joined across pages 1–2"  # noqa: RUF001
    ]


def test_table_split_at_chunk_boundary_joins() -> None:
    data = make_pdf(split_pages(SECOND))

    def respond(first: int, last: int) -> dict[str, Any]:
        if first == 1:
            items = [para(1, 65, 85), grid(1, simple(2, 2), rows=2, cols=2, top=700)]
        else:
            items = [grid(1, simple(2, 2), rows=2, cols=2), para(1, 285, 305)]
        return docling.doc([(WIDTH, HEIGHT)], items)

    layout = analyse_document(FakeLayout(respond), data, 2, chunk=1)
    text = read_text_layer(data)
    pieces, ledger = attach_text(layout, text)
    joined = join_split_tables(pieces, text, ledger)
    tables = tables_of(joined)
    assert len(tables) == 1
    table, _, flags = build_table(tables[0], "t-1", [], [], ledger, text.pages[0])
    assert grid_texts(table) == [["A", "B"], ["1", "2"], ["3", "4"]]
    assert owner(ledger, text, 1, "B") == ["dropped:repeated-header"]
    assert owner(ledger, text, 1, "3") == [tables[0].ref]
    assert owner(ledger, text, 1, "4") == [tables[0].ref]
    assert "joined across pages 1–2" in flags[0].message  # noqa: RUF001


def test_continuation_without_a_repeated_header_keeps_its_rows() -> None:
    second = {(0, 0): "5", (0, 1): "6", (1, 0): "7", (1, 1): "8"}
    items = [
        grid(1, simple(2, 2), rows=2, cols=2, top=700),
        grid(2, simple(2, 2, header_rows=0), rows=2, cols=2),
    ]
    pieces, text, ledger = build(split_pages(second), items)
    tables = tables_of(join_split_tables(pieces, text, ledger))
    assert len(tables) == 1
    table, _, _ = build_table(tables[0], "t-1", [], [], ledger, text.pages[0])
    assert grid_texts(table) == [["A", "B"], ["1", "2"], ["5", "6"], ["7", "8"]]
    assert owner(ledger, text, 1, "5") == [tables[0].ref]


def test_continuation_repeating_a_data_row_keeps_it() -> None:
    items = [
        grid(1, simple(2, 2, header_rows=0), rows=2, cols=2, top=700),
        grid(2, simple(2, 2, header_rows=0), rows=2, cols=2),
    ]
    pieces, text, ledger = build(split_pages(SECOND), items)
    tables = tables_of(join_split_tables(pieces, text, ledger))
    assert len(tables) == 1
    table, _, _ = build_table(tables[0], "t-1", [], [], ledger, text.pages[0])
    assert grid_texts(table) == [["A", "B"], ["1", "2"], ["A", "B"], ["3", "4"]]
    assert owner(ledger, text, 1, "A") == [tables[0].ref]


def test_overshooting_span_stops_at_the_join() -> None:
    specs: list[Spec] = [(0, 0, 1, 1, True), (0, 1, 1, 1, True), (1, 0, 2, 1, False)]
    specs.append((1, 1, 1, 1, False))
    items = [
        grid(1, specs, rows=2, cols=2, top=700),
        grid(2, simple(2, 2), rows=2, cols=2),
    ]
    pieces, text, ledger = build(split_pages(SECOND), items)
    tables = tables_of(join_split_tables(pieces, text, ledger))
    assert len(tables) == 1
    table, _, _ = build_table(tables[0], "t-1", [], [], ledger, text.pages[0])
    assert grid_texts(table) == [["A", "B"], ["1", "2"], ["3", "4"]]
    assert table.rows[1].cells[0].row_span == 1


def test_no_join_across_a_blank_page() -> None:
    pages = split_pages(SECOND)
    pages.insert(1, Page())
    items = [
        grid(1, simple(2, 2), rows=2, cols=2, top=700),
        grid(3, simple(2, 2), rows=2, cols=2),
    ]
    pieces, text, ledger = build(pages, items)
    assert len(tables_of(join_split_tables(pieces, text, ledger))) == 2
    assert owner(ledger, text, 2, "A") == [tables_of(pieces)[1].ref]


def test_no_join_when_columns_differ() -> None:
    second = {(0, 0): "A", (0, 1): "B", (0, 2): "C", (1, 0): "3", (1, 1): "4", (1, 2): "5"}
    items = [
        grid(1, simple(2, 2), rows=2, cols=2, top=700),
        grid(2, simple(2, 3), rows=2, cols=3),
    ]
    pieces, text, ledger = build(split_pages(second), items)
    assert len(tables_of(join_split_tables(pieces, text, ledger))) == 2


def test_no_join_when_column_edges_differ() -> None:
    edges = (72.0, 300.0, 372.0)
    second = {(0, 0): "A", (0, 1): "B", (1, 0): "3", (1, 1): "4"}
    pages = split_pages({})
    pages[1].runs[:0] = cell_runs(second, edges=edges)
    items = [
        grid(1, simple(2, 2), rows=2, cols=2, top=700),
        grid(2, simple(2, 2), rows=2, cols=2, edges=edges),
    ]
    pieces, text, ledger = build(pages, items)
    assert len(tables_of(join_split_tables(pieces, text, ledger))) == 2


def test_no_join_when_text_lies_between() -> None:
    pages = split_pages(SECOND)
    pages[0].runs.append(Run("Below the table", 72, 780))
    items = [
        grid(1, simple(2, 2), rows=2, cols=2, top=700),
        para(1, 765, 785),
        grid(2, simple(2, 2), rows=2, cols=2),
    ]
    pieces, text, ledger = build(pages, items)
    assert len(tables_of(join_split_tables(pieces, text, ledger))) == 2


# --- A header row given as text -------------------------------------------------------------

BODY = {(0, 0): "AE", (0, 1): "Adverse event", (1, 0): "ULN", (1, 1): "Upper limit"}


def header_above(
    header: list[Run], *, bottom: float = 115, label: str = "section_header"
) -> tuple[list[Piece], TextLayer, Ledger]:
    """A two-column table at 110 with no header row, and a text item over it whose box runs
    down to `bottom`: Docling's table box starts in it at 110 when `bottom` is past that."""
    items = [
        docling.text(label, 1, bl(60, 92, 400, bottom)),
        grid(1, simple(2, 2, header_rows=0), rows=2, cols=2, top=110),
    ]
    return build([Page(runs=[*header, *cell_runs(BODY, top=110)])], items)


def test_a_header_row_given_as_a_heading_goes_back_in_its_table() -> None:
    # As a protocol's list of abbreviations: "Abbreviation  Definition" a heading of its own.
    pieces, text, ledger = header_above([Run("Code", 76, 104), Run("Meaning", 176, 104)])
    joined = headers_above_tables(pieces, ledger)
    assert len(joined) == 1
    table, _, _ = build_table(joined[0], "t-1", [], [], ledger, text.pages[0])
    assert grid_texts(table) == [
        ["Code", "Meaning"],
        ["AE", "Adverse event"],
        ["ULN", "Upper limit"],
    ]
    assert table.header_rows == 1
    assert owner(ledger, text, 0, "M") == [joined[0].ref]


def test_text_above_a_table_stays_out_of_it() -> None:
    header = [Run("Code", 76, 104), Run("Meaning", 176, 104)]
    # its box ends above the table's
    pieces, _, ledger = header_above(header, bottom=108)
    assert len(headers_above_tables(pieces, ledger)) == 2
    # a picture's label, say
    pieces, _, ledger = header_above(header, label="caption")
    assert len(headers_above_tables(pieces, ledger)) == 2
    # in one column
    pieces, _, ledger = header_above([Run("Abbreviations used", 76, 104)])
    assert len(headers_above_tables(pieces, ledger)) == 2
    # a caption, its words spread over the columns with word gaps only (ICH Q13's Table 4)
    pieces, _, ledger = header_above([Run("Table 4: Example of a testing approach", 140, 104)])
    assert len(headers_above_tables(pieces, ledger)) == 2
    # a word across a column's edge
    pieces, _, ledger = header_above([Run("Abbreviations", 140, 104), Run("used", 300, 104)])
    assert len(headers_above_tables(pieces, ledger)) == 2


# --- Captions --------------------------------------------------------------------------------


def test_caption_above_is_taken_and_numbered() -> None:
    texts = {(0, 0): "A", (0, 1): "B", (1, 0): "1", (1, 1): "2"}
    runs = [Run("Table 3: Results", 72, 90), *cell_runs(texts)]
    items = [docling.text("caption", 1, bl(60, 78, 400, 96)), grid(1, simple(2, 2), rows=2, cols=2)]
    pieces, text, ledger = build([Page(runs=runs)], items)
    caption, piece = pieces
    table, consumed, _ = build_table(piece, "t-1", [], [caption], ledger, text.pages[0])
    assert table.caption == [Text(text="Results")]
    assert table.numbered
    assert table.caption_position == "above"
    assert table.key == "results"
    assert consumed == {caption.ref}
    assert owner(ledger, text, 0, "T") == ["dropped:caption-number"]
    assert owner(ledger, text, 0, "3") == ["dropped:caption-number"]
    assert owner(ledger, text, 0, "R") == [piece.ref]
    assert grid_texts(table) == [["A", "B"], ["1", "2"]]


def test_paragraph_starting_with_table_n_is_not_a_caption() -> None:
    texts = {(0, 0): "A", (0, 1): "B"}
    runs = [Run("Table 3 shows the doses", 72, 90), *cell_runs(texts)]
    items = [para(1, 78, 96), grid(1, simple(1, 2), rows=1, cols=2)]
    pieces, text, ledger = build([Page(runs=runs)], items)
    before, piece = pieces
    table, consumed, _ = build_table(piece, "t-1", [], [before], ledger, text.pages[0])
    assert table.caption == [] and consumed == set()
    assert owner(ledger, text, 0, "T") == [before.ref]
    assert owner(ledger, text, 0, "3") == [before.ref]


def test_short_text_with_a_separated_number_is_a_caption() -> None:
    texts = {(0, 0): "A", (0, 1): "B"}
    runs = [Run("Table 4 – Doses", 72, 90), *cell_runs(texts)]  # noqa: RUF001
    items = [para(1, 78, 96), grid(1, simple(1, 2), rows=1, cols=2)]
    pieces, text, ledger = build([Page(runs=runs)], items)
    before, piece = pieces
    table, consumed, _ = build_table(piece, "t-1", [], [before], ledger, text.pages[0])
    assert table.caption == [Text(text="Doses")] and table.numbered
    assert consumed == {before.ref}


def test_figure_first_row_is_not_a_table_caption() -> None:
    texts = {(0, 0): "Figure 2: Plot", (1, 0): "1", (1, 1): "2"}
    specs: list[Spec] = [(0, 0, 1, 2, False), (1, 0, 1, 1, False), (1, 1, 1, 1, False)]
    pieces, text, ledger = build([Page(runs=cell_runs(texts))], [grid(1, specs, rows=2, cols=2)])
    table, _, _ = build_table(pieces[0], "t-1", [], [], ledger, text.pages[0])
    assert table.caption == []
    assert grid_texts(table) == [["Figure 2: Plot"], ["1", "2"]]


def test_caption_below_with_another_label_is_not_taken() -> None:
    texts = {(0, 0): "A", (0, 1): "B"}
    runs = [*cell_runs(texts), Run("Figure 2: Plot", 72, 140)]
    items = [grid(1, simple(1, 2), rows=1, cols=2), para(1, 128, 145)]
    pieces, text, ledger = build([Page(runs=runs)], items)
    piece, after = pieces
    table, consumed, _ = build_table(piece, "t-1", [after], [], ledger, text.pages[0])
    assert table.caption == [] and consumed == set()
    assert owner(ledger, text, 0, "F") == [after.ref]


def test_docling_caption_below_is_taken() -> None:
    texts = {(0, 0): "A", (0, 1): "B"}
    runs = [*cell_runs(texts), Run("Summary of the doses", 72, 140)]
    caption = docling.text("caption", 1, bl(60, 128, 400, 145))
    caption["text"] = "Summary of the doses"
    items = [grid(1, simple(1, 2), rows=1, cols=2, captions=["#/texts/0"]), caption]
    pieces, text, ledger = build([Page(runs=runs)], items)
    piece, after = pieces
    table, consumed, _ = build_table(piece, "t-1", [after], [], ledger, text.pages[0])
    assert table.caption == [Text(text="Summary of the doses")]
    assert not table.numbered
    assert table.caption_position == "below"
    assert table.key == "summary-of-the-doses"
    assert consumed == {after.ref}
    assert owner(ledger, text, 0, "S") == [piece.ref]


def test_caption_in_first_row() -> None:
    texts = {(0, 0): "Table 2: Doses", (1, 0): "A", (1, 1): "B", (2, 0): "1", (2, 1): "2"}
    specs: list[Spec] = [(0, 0, 1, 2, False), (1, 0, 1, 1, True), (1, 1, 1, 1, True)]
    specs += [(2, 0, 1, 1, False), (2, 1, 1, 1, False)]
    pieces, text, ledger = build([Page(runs=cell_runs(texts))], [grid(1, specs, rows=3, cols=2)])
    table, consumed, _ = build_table(pieces[0], "t-1", [], [], ledger, text.pages[0])
    assert table.caption == [Text(text="Doses")]
    assert table.numbered and table.caption_position == "above"
    assert table.key == "doses"
    assert grid_texts(table) == [["A", "B"], ["1", "2"]]
    assert table.header_rows == 1
    assert consumed == set()
    assert owner(ledger, text, 0, "T") == ["dropped:caption-number"]
    assert owner(ledger, text, 0, "D") == [pieces[0].ref]


# --- Notes -----------------------------------------------------------------------------------


def sup(marker: str, r: int, c: int, top: float = 100) -> Run:
    """A superscript note marker just after a one-character cell text."""
    return Run(marker, COLS[c] + 10, top + ROW * r + 14, size=7, rise=3)


def test_numbered_list_after_a_table_stays_outside() -> None:
    texts = {(0, 0): "A", (0, 1): "B", (1, 0): "1", (1, 1): "2"}
    runs = [*cell_runs(texts), Run("1. First step", 72, 160)]
    items = [grid(1, simple(2, 2), rows=2, cols=2), para(1, 148, 165)]
    pieces, text, ledger = build([Page(runs=runs)], items)
    piece, after = pieces
    table, consumed, _ = build_table(piece, "t-1", [after], [], ledger, text.pages[0])
    assert table.notes == []
    assert consumed == set()
    assert owner(ledger, text, 0, "F") == [after.ref]


def test_note_row_without_its_marker_stays_in_grid() -> None:
    texts = {(0, 0): "A", (0, 1): "B", (1, 0): "1", (1, 1): "2", (2, 0): "b: below the limit"}
    specs = [*simple(2, 2), (2, 0, 1, 2, False)]
    pieces, text, ledger = build([Page(runs=cell_runs(texts))], [grid(1, specs, rows=3, cols=2)])
    table, _, flags = build_table(pieces[0], "t-1", [], [], ledger, text.pages[0])
    assert grid_texts(table) == [["A", "B"], ["1", "2"], ["b: below the limit"]]
    assert table.notes == []
    assert flags[0].message == "Table grid inferred from layout"


def test_notes_after_the_table() -> None:
    texts = {(0, 0): "A", (0, 1): "B", (1, 0): "1", (1, 1): "2"}
    runs = [*cell_runs(texts), sup("a", 1, 1), Run("a: measured at 25 °C", 72, 160)]
    runs.append(Run("Body", 72, 200))
    items = [
        grid(1, simple(2, 2), rows=2, cols=2),
        docling.text("footnote", 1, bl(60, 148, 400, 165)),
        para(1, 188, 205),
    ]
    pieces, text, ledger = build([Page(runs=runs)], items)
    piece, note, body = pieces
    table, consumed, flags = build_table(piece, "t-1", [note, body], [], ledger, text.pages[0])
    assert table.notes == [TableNote(marker="a", inlines=[Text(text="measured at 25 °C")])]
    assert consumed == {note.ref}
    assert owner(ledger, text, 0, "m") == [piece.ref]
    assert owner(ledger, text, 0, ":") == ["dropped:note-separator"]
    assert owner(ledger, text, 0, "y") == [body.ref]
    assert flags[0].message == "Table grid inferred from layout"


def test_note_row_moves_out_of_grid() -> None:
    texts = {(0, 0): "A", (0, 1): "B", (1, 0): "1", (1, 1): "2", (2, 0): "b: below the limit"}
    specs = [*simple(2, 2), (2, 0, 1, 2, False)]
    runs = [*cell_runs(texts), sup("b", 1, 1)]
    pieces, text, ledger = build([Page(runs=runs)], [grid(1, specs, rows=3, cols=2)])
    table, _, flags = build_table(pieces[0], "t-1", [], [], ledger, text.pages[0])
    assert grid_texts(table) == [
        ["A", "B"],
        ["1", "2 b"],
    ]  # pdfium sees a word gap before the marker
    assert table.notes == [TableNote(marker="b", inlines=[Text(text="below the limit")])]
    assert flags[0].message == "Table grid inferred from layout; notes moved out of the grid"
    assert owner(ledger, text, 0, "l") == [pieces[0].ref]


# --- Alignment and the page ------------------------------------------------------------------


def test_alignment() -> None:
    runs = [
        Run("Name", 172 + (100 - 28.7) / 2, 114),  # Helvetica 11pt: "Name" is about 28.7pt
        Run("12", 258, 134),
        Run("abc", 176, 154),
    ]
    specs: list[Spec] = [(0, 0, 1, 1, True), (1, 0, 1, 1, False), (2, 0, 1, 1, False)]
    edges = (172.0, 272.0)
    pieces, text, ledger = build([Page(runs=runs)], [grid(1, specs, rows=3, cols=1, edges=edges)])
    table, _, _ = build_table(pieces[0], "t-1", [], [], ledger, text.pages[0])
    assert [row.cells[0].h_align for row in table.rows] == ["center", "right", "left"]
    assert [row.cells[0].v_align for row in table.rows] == ["top", "top", "top"]


def test_vertical_alignment() -> None:
    runs = [Run("mid", 176, 100 + 30 + 4), Run("low", 276, 100 + 60 - 4)]
    edges = (172.0, 272.0, 372.0)
    data = grid(1, [(0, 0, 3, 1, False), (0, 1, 3, 1, False)], rows=3, cols=2, edges=edges)
    pieces, text, ledger = build([Page(runs=runs)], [data])
    table, _, _ = build_table(pieces[0], "t-1", [], [], ledger, text.pages[0])
    assert [c.v_align for c in table.rows[0].cells] == ["middle", "bottom"]


def test_landscape_table_is_wide() -> None:
    texts = {(0, 0): "A", (0, 1): "B"}
    page = Page(runs=cell_runs(texts), rotate=90)
    displayed = (HEIGHT, WIDTH)
    items = [grid(1, simple(1, 2), rows=1, cols=2, height=WIDTH)]
    pieces, text, ledger = build([page], items, sizes=[displayed])
    table, _, _ = build_table(pieces[0], "t-1", [], [], ledger, text.pages[0])
    assert table.wide
    assert grid_texts(table) == [["A", "B"]]


def test_cell_under_another_cells_span_keeps_its_text() -> None:
    texts = {(0, 0): "Wide", (0, 1): "Hidden", (1, 0): "1", (1, 1): "2"}
    specs: list[Spec] = [(0, 0, 1, 2, True), (0, 1, 1, 1, True), (1, 0, 1, 1, False)]
    specs.append((1, 1, 1, 1, False))
    pieces, text, ledger = build([Page(runs=cell_runs(texts))], [grid(1, specs, rows=2, cols=2)])
    table, _, _ = build_table(pieces[0], "t-1", [], [], ledger, text.pages[0])
    assert grid_texts(table) == [["Wide Hidden"], ["1", "2"]]
    assert table.rows[0].cells[0].col_span == 2
