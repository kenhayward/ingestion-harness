"""Table grids: spans, filler slots, alignment, header rows, tracked rows and nesting."""

from __future__ import annotations

import time
import xml.etree.ElementTree as ET
from xml.etree.ElementTree import Element

import pytest

from ingest_worker.decompose import decompose_docx, tables
from ingest_worker.decompose.body import walk_body
from ingest_worker.decompose.inline import InlineContext, RunStyles, W, plain_text
from ingest_worker.decompose.media import MediaContext
from ingest_worker.decompose.model import Block, Cell, ListBlock, Paragraph, Table
from ingest_worker.decompose.package import (
    DecompositionFailed,
    DecompositionRejected,
    open_package,
)
from ingest_worker.decompose.tables import GridSlot, source_grid
from tests.decompose.docx import DEFAULT_STYLES, NAMESPACES, build_docx
from tests.decompose.fakes import FakeRenderer

NUMBERING = (
    f"<w:numbering {NAMESPACES}>"
    '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>'
    "</w:abstractNum>"
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    "</w:numbering>"
)


# --- Builders --------------------------------------------------------------------------------


def para(text: str, jc: str | None = None) -> str:
    ppr = f'<w:pPr><w:jc w:val="{jc}"/></w:pPr>' if jc else ""
    run = f"<w:r><w:t>{text}</w:t></w:r>" if text else ""
    return f"<w:p>{ppr}{run}</w:p>"


def tc(
    text: str = "",
    *,
    span: int | None = None,
    vmerge: str | None = None,
    jc: str | None = None,
    valign: str | None = None,
    content: str | None = None,
) -> str:
    props = ""
    if span is not None:
        props += f'<w:gridSpan w:val="{span}"/>'
    if vmerge == "continue":
        props += "<w:vMerge/>"
    elif vmerge is not None:
        props += f'<w:vMerge w:val="{vmerge}"/>'
    if valign is not None:
        props += f'<w:vAlign w:val="{valign}"/>'
    body = content if content is not None else para(text, jc)
    return f"<w:tc><w:tcPr>{props}</w:tcPr>{body}</w:tc>"


def tr(*cells: str, header: bool = False, before: int = 0, after: int = 0, trpr: str = "") -> str:
    props = trpr
    if before:
        props += f'<w:gridBefore w:val="{before}"/>'
    if after:
        props += f'<w:gridAfter w:val="{after}"/>'
    if header:
        props += "<w:tblHeader/>"
    return f"<w:tr><w:trPr>{props}</w:trPr>{''.join(cells)}</w:tr>"


def tbl(*rows: str, cols: list[int]) -> str:
    grid = "".join(f'<w:gridCol w:w="{w}"/>' for w in cols)
    return f"<w:tbl><w:tblPr/><w:tblGrid>{grid}</w:tblGrid>{''.join(rows)}</w:tbl>"


def read(body: str) -> tuple[list[Block], InlineContext, Element]:
    pkg = open_package(build_docx(body, styles=DEFAULT_STYLES, numbering=NUMBERING))
    ctx = InlineContext(
        styles=RunStyles.from_xml(pkg.xml("word/styles.xml")),
        media=MediaContext.for_package(pkg, FakeRenderer()),
    )
    blocks, _ = walk_body(pkg, ctx)
    document = pkg.xml("word/document.xml")
    assert document is not None
    first = document.find(f"{W}body/{W}tbl")
    assert first is not None
    return blocks, ctx, first


def table(body: str) -> tuple[Table, list[list[GridSlot]], InlineContext]:
    blocks, ctx, element = read(body)
    assert isinstance(blocks[0], Table)
    return blocks[0], source_grid(element), ctx


def cell_text(cell: Cell) -> str:
    parts = []
    for b in cell.blocks:
        assert isinstance(b, Paragraph)
        parts.append(plain_text(b.inlines))
    return "\n".join(parts)


def model_grid(t: Table) -> list[list[tuple[int, int]]]:
    """Place the model's cells on the grid as a renderer would; every slot exactly once."""
    width = len(t.column_widths)
    slots: list[list[tuple[int, int] | None]] = [[None] * width for _ in t.rows]
    for r, row in enumerate(t.rows):
        c = 0
        for cell in row.cells:
            while c < width and slots[r][c] is not None:
                c += 1
            for dr in range(cell.row_span):
                for dc in range(cell.col_span):
                    assert r + dr < len(t.rows) and c + dc < width, "cell overruns the grid"
                    assert slots[r + dr][c + dc] is None, "slot covered twice"
                    slots[r + dr][c + dc] = (r, c)
            c += cell.col_span
    assert all(s is not None for row in slots for s in row), "slot left uncovered"
    return [[s for s in row if s is not None] for row in slots]


def origins(grid: list[list[GridSlot]]) -> list[list[tuple[int, int]]]:
    return [[s.origin for s in row] for row in grid]


def spans(t: Table) -> list[list[tuple[int, int]]]:
    return [[(c.row_span, c.col_span) for c in row.cells] for row in t.rows]


# --- Spans -----------------------------------------------------------------------------------


def test_spans_resolve() -> None:
    t, grid, _ = table(
        tbl(
            tr(tc("A", span=2), tc("B"), tc("C")),
            tr(tc("D", vmerge="restart"), tc("E"), tc("F"), tc("G")),
            tr(tc(vmerge="continue"), tc("H", span=2, vmerge="restart"), tc("I")),
            tr(tc("J"), tc(span=2, vmerge="continue"), tc("K")),
            cols=[1000, 1000, 1000, 1000],
        )
    )
    assert spans(t) == [
        [(1, 2), (1, 1), (1, 1)],
        [(2, 1), (1, 1), (1, 1), (1, 1)],
        [(2, 2), (1, 1)],
        [(1, 1), (1, 1)],
    ]
    assert [[cell_text(c) for c in row.cells] for row in t.rows] == [
        ["A", "B", "C"],
        ["D", "E", "F", "G"],
        ["H", "I"],
        ["J", "K"],
    ]
    expected = [
        [(0, 0), (0, 0), (0, 2), (0, 3)],
        [(1, 0), (1, 1), (1, 2), (1, 3)],
        [(1, 0), (2, 1), (2, 1), (2, 3)],
        [(3, 0), (2, 1), (2, 1), (3, 3)],
    ]
    assert model_grid(t) == expected
    assert origins(grid) == expected
    assert [[s.text for s in row] for row in grid] == [
        ["A", "A", "B", "C"],
        ["D", "E", "F", "G"],
        ["D", "H", "H", "I"],
        ["J", "H", "H", "K"],
    ]
    assert t.column_widths == [0.25, 0.25, 0.25, 0.25]
    assert t.header_rows == 0 and t.caption == [] and t.notes == []
    assert not t.numbered and not t.wide and t.key is None


def test_continue_value_and_long_vertical_merge() -> None:
    t, grid, _ = table(
        tbl(
            tr(tc("A", vmerge="restart"), tc("B")),
            tr(tc(vmerge="continue"), tc("C")),
            tr(tc(vmerge="continue"), tc("D")),
            tr(tc("E"), tc("F")),
            cols=[1, 1],
        )
    )
    assert spans(t) == [[(3, 1), (1, 1)], [(1, 1)], [(1, 1)], [(1, 1), (1, 1)]]
    assert origins(grid) == model_grid(t)
    assert [s.text for s in grid[2]] == ["A", "D"]


def test_new_restart_ends_the_merge_above() -> None:
    t, grid, _ = table(
        tbl(
            tr(tc("A", vmerge="restart")),
            tr(tc(vmerge="continue")),
            tr(tc("B", vmerge="restart")),
            tr(tc(vmerge="continue")),
            cols=[1],
        )
    )
    assert spans(t) == [[(2, 1)], [], [(2, 1)], []]
    assert origins(grid) == model_grid(t) == [[(0, 0)], [(0, 0)], [(2, 0)], [(2, 0)]]


def test_continue_without_restart_is_its_own_cell() -> None:
    t, grid, _ = table(
        tbl(
            tr(tc("A", vmerge="continue"), tc("B")),
            tr(tc("C"), tc("D", vmerge="continue")),
            cols=[1, 1],
        )
    )
    assert spans(t) == [[(1, 1), (1, 1)], [(1, 1), (1, 1)]]
    assert [[cell_text(c) for c in row.cells] for row in t.rows] == [["A", "B"], ["C", "D"]]
    assert origins(grid) == model_grid(t) == [[(0, 0), (0, 1)], [(1, 0), (1, 1)]]
    assert [s.text for s in grid[1]] == ["C", "D"]


def element_of(body: str) -> Element:
    document = open_package(build_docx(body)).xml("word/document.xml")
    assert document is not None
    element = document.find(f"{W}body/{W}tbl")
    assert element is not None
    return element


@pytest.mark.parametrize(
    "rows",
    [
        # The restart spans two columns; the continue below spans one, at either column.
        [tr(tc("A", span=2, vmerge="restart")), tr(tc("B", vmerge="continue"), tc("C"))],
        [tr(tc("A", span=2, vmerge="restart")), tr(tc("B"), tc("C", vmerge="continue"))],
        # The restart spans one column; the continue below spans two.
        [tr(tc("A", vmerge="restart"), tc("B")), tr(tc("C", span=2, vmerge="continue"))],
    ],
)
def test_vmerge_with_mismatched_span_fails(rows: list[str]) -> None:
    body = tbl(*rows, cols=[1, 1])
    with pytest.raises(DecompositionFailed) as failed:
        read(body)
    assert failed.value.at == "s~lead#table-1"
    assert failed.value.detail == "ambiguous vertical merge in table s~lead#table-1"
    with pytest.raises(DecompositionFailed, match="ambiguous vertical merge"):
        source_grid(element_of(body))


def test_text_in_continue_cell_is_appended_to_origin() -> None:
    t, grid, _ = table(
        tbl(
            tr(tc("A", vmerge="restart"), tc("x")),
            tr(tc("B", vmerge="continue"), tc("y")),
            tr(tc(vmerge="continue"), tc("z")),  # empty, the normal case: adds nothing
            tr(tc("C", vmerge="continue"), tc("w")),
            cols=[1, 1],
        )
    )
    origin = t.rows[0].cells[0]
    assert origin.row_span == 4
    assert cell_text(origin) == "A\nB\nC"
    assert [b.id for b in origin.blocks] == [
        "s~lead#table-1#cell-1#p-1",
        "s~lead#table-1#cell-3#p-1",
        "s~lead#table-1#cell-7#p-1",
    ]
    assert [[s.text for s in row] for row in grid] == [
        ["A\nB\nC", "x"],
        ["A\nB\nC", "y"],
        ["A\nB\nC", "z"],
        ["A\nB\nC", "w"],
    ]
    assert origins(grid) == model_grid(t)


def test_tracked_cell_change_fails() -> None:
    for tag in ("cellIns", "cellDel", "cellMerge"):
        change = f'<w:{tag} w:id="1" w:author="x" w:date="2026-01-01T00:00:00Z"/>'
        changed = f"<w:tc><w:tcPr>{change}</w:tcPr><w:p/></w:tc>"
        body = tbl(f"<w:tr>{tc('A')}{changed}</w:tr>", cols=[1, 1])
        with pytest.raises(DecompositionFailed) as failed:
            read(body)
        assert failed.value.at == "s~lead#table-1"
        assert failed.value.detail == (
            "tracked cell changes are not supported; accept them in Word first"
        )


def test_tracked_cell_change_in_nested_table_fails_at_the_nested_table() -> None:
    change = '<w:cellDel w:id="1" w:author="x" w:date="2026-01-01T00:00:00Z"/>'
    inner = tbl(f"<w:tr><w:tc><w:tcPr>{change}</w:tcPr><w:p/></w:tc></w:tr>", cols=[1])
    with pytest.raises(DecompositionFailed) as failed:
        read(tbl(tr(tc(content=para("x") + inner)), cols=[1]))
    assert failed.value.at == "s~lead#table-1#cell-1#table-1"


def test_continue_under_a_cell_that_was_never_merged_is_its_own_cell() -> None:
    t, grid, _ = table(
        tbl(tr(tc("A"), tc("B")), tr(tc("C", vmerge="continue"), tc("D")), cols=[1, 1])
    )
    assert spans(t) == [[(1, 1), (1, 1)], [(1, 1), (1, 1)]]
    assert origins(grid) == model_grid(t) == [[(0, 0), (0, 1)], [(1, 0), (1, 1)]]


# --- Filler slots ----------------------------------------------------------------------------


def test_grid_before_after_fills_empty_slots() -> None:
    t, grid, _ = table(
        tbl(
            tr(tc("A"), tc("B"), tc("C"), tc("D")),
            tr(tc("E"), tc("F"), before=2),
            tr(tc("G"), after=3),
            tr(tc("H"), before=1, after=1),
            tr(tc("I")),  # short of the grid, with no gridAfter
            cols=[1, 1, 1, 1],
        )
    )
    texts = [[cell_text(c) for c in row.cells] for row in t.rows]
    assert texts == [
        ["A", "B", "C", "D"],
        ["", "", "E", "F"],
        ["G", "", "", ""],
        ["", "H", "", ""],
        ["I", "", "", ""],
    ]
    assert all(c.row_span == c.col_span == 1 for row in t.rows for c in row.cells)
    fillers = [t.rows[1].cells[0], t.rows[2].cells[3]]
    assert all(c.blocks == [] and c.h_align == "left" and c.v_align == "top" for c in fillers)
    assert origins(grid) == model_grid(t)
    assert [[s.text for s in row] for row in grid] == texts
    assert grid[1][0] == GridSlot(origin=(1, 0), text="")


def test_row_wider_than_grid_widens_it() -> None:
    t, grid, _ = table(tbl(tr(tc("A"), tc("B"), tc("C")), tr(tc("D")), cols=[3000, 1000]))
    assert len(t.column_widths) == 3
    assert sum(t.column_widths) == pytest.approx(1.0)
    assert t.column_widths[0] > t.column_widths[1]
    assert [len(r.cells) for r in t.rows] == [3, 3]
    assert origins(grid) == model_grid(t)


def test_absurd_span_is_refused_not_allocated() -> None:
    body = tbl(tr(tc("A", span=10**9)), cols=[1])
    with pytest.raises(DecompositionFailed) as failed:
        read(body)
    assert failed.value.at == "s~lead#table-1"


def test_column_widths_are_relative() -> None:
    t, _, _ = table(tbl(tr(tc("A"), tc("B"), tc("C")), cols=[2000, 1000, 1000]))
    assert t.column_widths == pytest.approx([0.5, 0.25, 0.25])
    assert sum(t.column_widths) == pytest.approx(1.0)


def test_missing_column_widths_share_equally() -> None:
    body = "<w:tbl><w:tblGrid><w:gridCol/><w:gridCol/></w:tblGrid>" + tr(tc("A"), tc("B"))
    t, _, _ = table(body + "</w:tbl>")
    assert t.column_widths == [0.5, 0.5]


# --- Alignment and header rows ---------------------------------------------------------------


def test_alignment_mapping() -> None:
    t, _, _ = table(
        tbl(
            tr(tc("a", jc="both"), tc("b", jc="center"), tc("c", jc="end"), tc("d")),
            tr(
                tc("e", valign="center"),
                tc("f", valign="bottom"),
                tc("g", jc="start"),
                tc("h", jc="right", valign="top"),
            ),
            cols=[1, 1, 1, 1],
        )
    )
    first, second = t.rows
    assert [c.h_align for c in first.cells] == ["justify", "center", "right", "left"]
    assert [c.v_align for c in first.cells] == ["top"] * 4
    assert [c.h_align for c in second.cells] == ["left", "left", "left", "right"]
    assert [c.v_align for c in second.cells] == ["middle", "bottom", "top", "top"]


def test_alignment_comes_from_the_first_paragraph() -> None:
    t, _, _ = table(tbl(tr(tc(content=para("one", "center") + para("two", "right"))), cols=[1]))
    assert t.rows[0].cells[0].h_align == "center"


def test_header_rows() -> None:
    t, _, _ = table(
        tbl(
            tr(tc("H1"), tc("H2"), header=True),
            tr(tc("h1"), tc("h2"), header=True),
            tr(tc("d1"), tc("d2")),
            tr(tc("x1"), tc("x2"), header=True),  # not at the top: not a header row
            cols=[1, 1],
        )
    )
    assert t.header_rows == 2
    assert [[c.header for c in row.cells] for row in t.rows] == [
        [True, True],
        [True, True],
        [False, False],
        [False, False],
    ]


def test_header_marked_off_is_not_a_header() -> None:
    off = tr(tc("A"), trpr='<w:tblHeader w:val="false"/>')
    t, _, _ = table(tbl(off, tr(tc("B")), cols=[1]))
    assert t.header_rows == 0


# --- Tracked rows ----------------------------------------------------------------------------


def test_deleted_row_is_dropped() -> None:
    deleted = '<w:del w:id="1" w:author="x" w:date="2026-01-01T00:00:00Z"/>'
    inserted = '<w:ins w:id="2" w:author="x" w:date="2026-01-01T00:00:00Z"/>'
    t, grid, ctx = table(
        tbl(
            tr(tc("A"), tc("B")),
            tr(tc("gone"), tc("too"), trpr=deleted),
            tr(tc("C"), tc("D"), trpr=inserted),
            cols=[1, 1],
        )
    )
    assert [[cell_text(c) for c in row.cells] for row in t.rows] == [["A", "B"], ["C", "D"]]
    assert [[s.text for s in row] for row in grid] == [["A", "B"], ["C", "D"]]
    assert origins(grid) == model_grid(t)
    assert ctx.changes == 2


def test_merge_through_a_deleted_row_spans_the_kept_rows() -> None:
    deleted = '<w:del w:id="1" w:author="x" w:date="2026-01-01T00:00:00Z"/>'
    t, grid, _ = table(
        tbl(
            tr(tc("A", vmerge="restart"), tc("B")),
            tr(tc(vmerge="continue"), tc("gone"), trpr=deleted),
            tr(tc(vmerge="continue"), tc("C")),
            cols=[1, 1],
        )
    )
    assert spans(t) == [[(2, 1), (1, 1)], [(1, 1)]]
    assert origins(grid) == model_grid(t) == [[(0, 0), (0, 1)], [(0, 0), (1, 1)]]


def test_deleted_text_is_not_slot_text() -> None:
    cell = (
        "<w:p><w:r><w:t>kept</w:t></w:r>"
        '<w:del w:id="1" w:author="x" w:date="2026-01-01T00:00:00Z">'
        "<w:r><w:delText>old</w:delText></w:r></w:del>"
        '<w:moveFrom w:id="2" w:author="x" w:date="2026-01-01T00:00:00Z">'
        "<w:r><w:t>moved</w:t></w:r></w:moveFrom></w:p>" + para("second")
    )
    _, grid, _ = table(tbl(tr(tc(content=cell)), cols=[1]))
    assert grid[0][0].text == "kept\nsecond"


def test_source_slot_text_excludes_deleted_and_textbox_content() -> None:
    deleted = '<w:del w:id="1" w:author="x" w:date="2026-01-01T00:00:00Z"/>'
    inner = tbl(
        tr(tc("kept row")),
        tr(tc("deleted row"), trpr=deleted),
        cols=[1],
    )
    textbox = (
        "<w:p><w:r><w:t>around</w:t></w:r><w:r><w:drawing><wp:inline><a:graphic>"
        "<a:graphicData><w:txbxContent><w:p><w:r><w:t>boxed</w:t></w:r></w:p>"
        "</w:txbxContent></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"
    )
    t, grid, _ = table(tbl(tr(tc(content=para("first") + inner + textbox)), cols=[1]))
    assert grid[0][0].text == "first\nkept row\naround"
    nested = t.rows[0].cells[0].blocks[1]
    assert isinstance(nested, Table)
    assert [[cell_text(c) for c in row.cells] for row in nested.rows] == [["kept row"]]


def test_horizontal_merge_is_refused() -> None:
    legacy = (
        '<w:tc><w:tcPr><w:hMerge w:val="restart"/></w:tcPr><w:p/></w:tc>'
        "<w:tc><w:tcPr><w:hMerge/></w:tcPr><w:p/></w:tc>"
    )
    body = tbl(f"<w:tr>{legacy}</w:tr>", cols=[1, 1])
    with pytest.raises(DecompositionFailed) as failed:
        read(body)
    assert failed.value.at == "s~lead#table-1"
    with pytest.raises(DecompositionFailed):
        source_grid(element_of(body))


# --- Cell content ----------------------------------------------------------------------------


def test_nested_table_in_cell() -> None:
    inner = tbl(tr(tc("x", span=2)), tr(tc("y"), tc("z")), cols=[1, 1])
    t, grid, _ = table(tbl(tr(tc("outer"), tc(content=para("before") + inner)), cols=[1, 1]))
    cell = t.rows[0].cells[1]
    assert [b.kind for b in cell.blocks] == ["paragraph", "table"]
    nested = cell.blocks[1]
    assert isinstance(nested, Table)
    assert nested.id == "s~lead#table-1#cell-2#table-1"
    assert spans(nested) == [[(1, 2)], [(1, 1), (1, 1)]]
    assert cell.blocks[0].id == "s~lead#table-1#cell-2#p-1"
    assert [[cell_text(c) for c in row.cells] for row in nested.rows] == [["x"], ["y", "z"]]
    assert grid[0][1].text == "before\nx\ny\nz"


def test_cell_holds_paragraphs_and_list() -> None:
    item = (
        '<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>'
        "<w:r><w:t>{}</w:t></w:r></w:p>"
    )
    content = para("intro") + item.format("one") + item.format("two") + para("outro")
    t, _, _ = table(tbl(tr(tc(content=content)), cols=[1]))
    blocks = t.rows[0].cells[0].blocks
    assert [b.kind for b in blocks] == ["paragraph", "list", "paragraph"]
    lst = blocks[1]
    assert isinstance(lst, ListBlock)
    assert len(lst.items) == 2 and not lst.ordered
    assert [b.id for b in blocks] == [
        "s~lead#table-1#cell-1#p-1",
        "s~lead#table-1#cell-1#list-1",
        "s~lead#table-1#cell-1#p-4",
    ]


def test_cell_ids_count_every_cell_in_reading_order() -> None:
    t, _, _ = table(
        tbl(
            tr(tc("A", vmerge="restart"), tc("B")),
            tr(tc(vmerge="continue"), tc("C"), before=0),
            tr(tc("D"), after=1),
            cols=[1, 1],
        )
    )
    # Absorbed continue cells and fillers take an ordinal too, so every source cell has one.
    ids = [[c.blocks[0].id for c in row.cells if c.blocks] for row in t.rows]
    assert ids == [
        ["s~lead#table-1#cell-1#p-1", "s~lead#table-1#cell-2#p-1"],
        ["s~lead#table-1#cell-4#p-1"],
        ["s~lead#table-1#cell-5#p-1"],
    ]


def test_rows_and_cells_in_content_controls() -> None:
    body = (
        "<w:tbl><w:tblGrid><w:gridCol w:w='1'/><w:gridCol w:w='1'/></w:tblGrid>"
        "<w:sdt><w:sdtContent>" + tr(tc("A"), tc("B")) + "</w:sdtContent></w:sdt>"
        "<w:tr><w:sdt><w:sdtContent>" + tc("C") + "</w:sdtContent></w:sdt>" + tc("D") + "</w:tr>"
        "</w:tbl>"
    )
    t, grid, _ = table(body)
    assert [[cell_text(c) for c in row.cells] for row in t.rows] == [["A", "B"], ["C", "D"]]
    assert [[s.text for s in row] for row in grid] == [["A", "B"], ["C", "D"]]


# --- Size caps -------------------------------------------------------------------------------


def test_grid_before_wider_than_the_grid_is_malformed() -> None:
    with pytest.raises(DecompositionFailed) as failed:
        read(tbl(tr(tc("A")), tr(tc("B"), before=3), cols=[1, 1]))
    assert failed.value.at is not None and failed.value.at.endswith("#table-1")
    assert "gridBefore" in failed.value.detail


def test_grid_after_wider_than_the_grid_is_malformed() -> None:
    with pytest.raises(DecompositionFailed, match="gridAfter"):
        read(tbl(tr(tc("A"), after=3), cols=[1, 1]))


def test_table_past_the_slot_cap_is_refused_before_building_cells() -> None:
    rows = tr(tc("x", span=1000)) * 21  # 21 rows by 1000 columns
    with pytest.raises(DecompositionRejected, match="table too large"):
        read(tbl(rows, cols=[1] * 1000))


def _table_element(rows: int, cols: int) -> Element:
    """A `w:tbl` of `rows` rows of one `cols`-wide cell, without a grid."""
    row = tr(tc("x", span=cols))
    return ET.fromstring(f"<w:tbl xmlns:w='{W[1:-1]}'>{row * rows}</w:tbl>")


def test_table_slot_cap_is_20000() -> None:
    assert tables.MAX_TABLE_SLOTS == 20_000
    exactly = _table_element(20, 1000)
    assert tables._width(exactly, tables.rows_of(exactly)) == 1000
    over = _table_element(21, 1000)
    with pytest.raises(DecompositionRejected, match="table too large"):
        tables._width(over, tables.rows_of(over))


def test_document_slot_cap_is_200000() -> None:
    assert tables.MAX_DOCUMENT_SLOTS == 200_000
    assert tables.count_slots(180_000, 20, 1000) == 200_000
    with pytest.raises(DecompositionRejected, match="table too large"):
        tables.count_slots(180_001, 20, 1000)


def test_grid_before_without_tblgrid_cannot_widen_the_grid() -> None:
    body = "<w:tbl>" + tr(tc("A"), tc("B")) + tr(tc("C"), before=5) + "</w:tbl>"
    with pytest.raises(DecompositionFailed) as failed:
        read(body)
    assert failed.value.at is not None and failed.value.at.endswith("#table-1")
    assert "gridBefore" in failed.value.detail


def test_grid_after_without_tblgrid_cannot_widen_the_grid() -> None:
    body = "<w:tbl>" + tr(tc("A"), tc("B")) + tr(tc("C"), after=5) + "</w:tbl>"
    with pytest.raises(DecompositionFailed, match="gridAfter"):
        read(body)


def test_gaps_within_the_widest_row_are_fine_without_tblgrid() -> None:
    body = "<w:tbl>" + tr(tc("A"), tc("B"), tc("C")) + tr(tc("D"), before=1, after=1) + "</w:tbl>"
    t, _, _ = table(body)
    assert len(t.rows[0].cells) == 3


def test_slot_bomb_without_tblgrid_is_refused_fast() -> None:
    row = '<w:tr><w:trPr><w:gridBefore w:val="999"/></w:trPr><w:tc><w:p/></w:tc></w:tr>'
    data = build_docx(("<w:tbl>" + row * 200 + "</w:tbl><w:p/>") * 10)
    started = time.perf_counter()
    with pytest.raises((DecompositionFailed, DecompositionRejected)):
        decompose_docx(data, renderer=FakeRenderer())
    assert time.perf_counter() - started < 1.0


def test_document_past_the_slot_cap_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tables, "MAX_DOCUMENT_SLOTS", 10)
    small = tbl(tr(tc("A"), tc("B")), tr(tc("C"), tc("D")), cols=[1, 1])  # 4 slots
    read(small + para("between") + small)
    with pytest.raises(DecompositionRejected, match="table too large"):
        read(small + para("between") + small + para("again") + small)
