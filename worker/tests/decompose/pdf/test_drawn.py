"""Tables the layout analysis took for pictures, read back from their ruling lines."""

from __future__ import annotations

from typing import Any

from ingest_worker.decompose.forms import tables_of
from ingest_worker.decompose.pdf import decompose_pdf
from ingest_worker.decompose.pdf.drawn import tables_from_drawings
from ingest_worker.decompose.pdf.layout import LayoutPicture, LayoutTable, LayoutText, parse_docling
from ingest_worker.decompose.pdf.textlayer import read_text_layer
from tests.decompose.pdf import docling
from tests.decompose.pdf.fakes import FakeCropper, FakeLayout
from tests.decompose.pdf.make_pdf import Img, Page, Run, make_pdf
from tests.decompose.pdf.test_pdf_tables import grid_texts

HEIGHT = 842.0
XS = (72.0, 172.0, 272.0, 372.0)
YS = (200.0, 220.0, 240.0, 260.0)

Line = tuple[float, float, float, float]


def bl(x0: float, y0: float, x1: float, y1: float) -> docling.Box:
    return (x0, HEIGHT - y0, x1, HEIGHT - y1)


def rules(*, open_top_right: bool = False) -> list[Line]:
    """A 3 x 3 grid's rules as Word draws them: one per cell edge. With `open_top_right`, the
    rule between the top row's second and third cells is left out (they are one cell)."""
    out: list[Line] = []
    for y in YS:
        out += [(XS[c], y, XS[c + 1], y) for c in range(3)]
    for c, x in enumerate(XS):
        for r in range(3):
            if not (open_top_right and r == 0 and c == 2):
                out.append((x, YS[r], x, YS[r + 1]))
    return out


TEXTS = {
    (0, 0): "Strength",
    (0, 1): "50 mg",
    (0, 2): "75 mg",
    (1, 0): "Batch 1",
    (1, 1): "T1",
    (1, 2): "T2",
    (2, 0): "Batch 2",
    (2, 1): "T2",
    (2, 2): "T1",
}


def page(texts: dict[tuple[int, int], str] = TEXTS, **kwargs: Any) -> Page:
    runs = [Run("Table 4: Matrixing", 72, 190)]
    runs += [Run(t, XS[c] + 4, YS[r] + 14) for (r, c), t in texts.items()]
    return Page(runs=runs, lines=kwargs.pop("lines", rules()), **kwargs)


def items() -> list[dict[str, Any]]:
    """Docling's answer: a caption, the table as a picture, and its cells' text as text items."""
    out = [
        docling.text("caption", 1, bl(60, 180, 400, 194)),
        docling.picture(1, bl(70, 198, 374, 262)),
    ]
    for r, c in TEXTS:
        out.append(docling.text("text", 1, bl(XS[c] + 2, YS[r] + 4, XS[c] + 60, YS[r] + 17)))
    return out


def recover(p: Page) -> list[object]:
    text = read_text_layer(make_pdf([p]))
    layout = parse_docling(docling.doc([(595, HEIGHT)], items()))
    return list(tables_from_drawings(layout, text).items)


def test_the_text_layer_reads_ruling_lines() -> None:
    [layer] = read_text_layer(make_pdf([page()])).pages
    assert len(layer.rules) == len(rules())
    assert all(min(b[2] - b[0], b[3] - b[1]) <= 2 for b in layer.rules)


def test_a_ruled_picture_becomes_a_table() -> None:
    found = recover(page())
    [table] = [i for i in found if isinstance(i, LayoutTable)]
    assert (table.rows, table.cols, table.ruled) == (3, 3, True)
    assert table.bbox[0] == XS[0] and table.bbox[2] == XS[-1]
    assert [(c.row, c.col, c.row_span, c.col_span, c.header) for c in table.cells][:4] == [
        (0, 0, 1, 1, True),
        (0, 1, 1, 1, True),
        (0, 2, 1, 1, True),
        (1, 0, 1, 1, False),
    ]
    assert not any(isinstance(i, LayoutPicture) for i in found)
    # the cells' text items went; the caption above the table stayed
    assert [i.label for i in found if isinstance(i, LayoutText)] == ["caption"]


def test_cells_no_rule_parts_are_one() -> None:
    found = recover(page(lines=rules(open_top_right=True)))
    [table] = [i for i in found if isinstance(i, LayoutTable)]
    assert [(c.row, c.col, c.col_span) for c in table.cells if c.row == 0] == [(0, 0, 1), (0, 1, 2)]


def test_a_picture_over_an_image_or_without_a_grid_stays() -> None:
    for p in (
        page(images=[Img(100, 205, 50, 30)]),
        page(lines=[]),
        page(lines=[line for line in rules() if line[0] == line[2]]),  # only vertical rules
    ):
        found = recover(p)
        assert sum(isinstance(i, LayoutPicture) for i in found) == 1
        assert not any(isinstance(i, LayoutTable) for i in found)


def test_a_cell_that_is_not_a_rectangle_keeps_the_picture() -> None:
    # an L: no rule between the top two right cells, nor under the top right one
    lines = [line for line in rules(open_top_right=True) if line != (XS[2], YS[1], XS[3], YS[1])]
    found = recover(page(lines=lines))
    assert not any(isinstance(i, LayoutTable) for i in found)


def test_the_table_is_delivered_with_its_caption_and_flag() -> None:
    data = make_pdf([page()])
    layout = FakeLayout(lambda first, last: docling.doc([(595, HEIGHT)], items()))
    doc = decompose_pdf(data, layout=layout, cropper=FakeCropper()).document
    [table] = tables_of(doc)
    assert grid_texts(table) == [
        ["Strength", "50 mg", "75 mg"],
        ["Batch 1", "T1", "T2"],
        ["Batch 2", "T2", "T1"],
    ]
    assert table.header_rows == 1
    assert doc.images == []
    messages = [f.message for f in doc.report if f.at == table.id]
    assert messages == [
        "Table grid read from its ruling lines; the layout analysis took it for a picture"
    ]


def test_a_picture_of_a_table_docling_read_is_dropped() -> None:
    text = read_text_layer(make_pdf([page()]))
    table = docling.table(
        1, bl(72, 200, 372, 260), [(r, c) for r in range(3) for c in range(3)], rows=3, cols=3
    )
    layout = parse_docling(docling.doc([(595, HEIGHT)], [*items()[:2], table]))
    found = list(tables_from_drawings(layout, text).items)
    assert not any(isinstance(i, LayoutPicture) for i in found)
    [kept] = [i for i in found if isinstance(i, LayoutTable)]
    assert not kept.ruled  # Docling's own


def test_a_picture_that_stays_over_a_table_docling_read_gives_its_text_to_the_cells() -> None:
    # An image under the picture keeps it a picture (a table of drawn structures, say).
    data = make_pdf([page(images=[Img(100, 205, 50, 30)])])
    table = docling.table(
        1, bl(72, 200, 372, 260), [(r, c) for r in range(3) for c in range(3)], rows=3, cols=3
    )
    for cell in table["data"]["table_cells"]:  # where the grid draws them
        r, c = cell["start_row_offset_idx"], cell["start_col_offset_idx"]
        cell["bbox"].update(l=XS[c], t=YS[r], r=XS[c + 1], b=YS[r + 1])
    found = [*items(), table]
    layout = parse_docling(docling.doc([(595, HEIGHT)], found))
    kept = list(tables_from_drawings(layout, read_text_layer(data)).items)
    assert sum(isinstance(i, LayoutPicture) for i in kept) == 1
    assert [i.label for i in kept if isinstance(i, LayoutText)] == ["caption"]

    fake = FakeLayout(lambda first, last: docling.doc([(595, HEIGHT)], found))
    doc = decompose_pdf(data, layout=fake, cropper=FakeCropper()).document
    [read] = tables_of(doc)
    assert grid_texts(read) == [
        ["Strength", "50 mg", "75 mg"],
        ["Batch 1", "T1", "T2"],
        ["Batch 2", "T2", "T1"],
    ]

    # A small picture inside the table (a symbol in a cell) is not a picture of it.
    small = [*items()[:1], docling.picture(1, bl(100, 205, 110, 215)), *items()[2:], table]
    layout = parse_docling(docling.doc([(595, HEIGHT)], small))
    kept = list(tables_from_drawings(layout, read_text_layer(data)).items)
    assert sum(isinstance(i, LayoutText) for i in kept) == 1 + len(TEXTS)


def test_a_picture_over_two_grids_gives_the_one_docling_missed() -> None:
    below = 120.0  # a second grid, Docling's table, under the first
    lines = rules() + [(x0, y0 + below, x1, y1 + below) for x0, y0, x1, y1 in rules()]
    p = page(lines=lines)
    p.runs.append(Run("Key for the table", 72, 300))
    text = read_text_layer(make_pdf([p]))
    second = docling.table(1, bl(72, 320, 372, 380), [(0, 0)], rows=3, cols=3)
    picture = docling.picture(1, bl(70, 198, 374, 382))
    key = docling.text("text", 1, bl(70, 290, 300, 304))
    layout = parse_docling(docling.doc([(595, HEIGHT)], [picture, key, second]))
    found = list(tables_from_drawings(layout, text).items)
    assert not any(isinstance(i, LayoutPicture) for i in found)
    tables = [i for i in found if isinstance(i, LayoutTable)]
    assert [(t.ruled, round(t.bbox[1])) for t in tables] == [(True, 200), (False, 320)]
    assert [i.label for i in found if isinstance(i, LayoutText)] == ["text"]  # the key stays


def test_boxes_joined_by_a_line_are_no_table() -> None:
    """A flow chart: two boxes, one above the other, and a line between them."""

    def box(x0: float, y0: float, x1: float, y1: float) -> list[Line]:
        return [(x0, y0, x1, y0), (x0, y1, x1, y1), (x0, y0, x0, y1), (x1, y0, x1, y1)]

    lines = [*box(72, 200, 372, 220), (222, 220, 222, 240), *box(72, 240, 372, 260)]
    found = recover(page(lines=lines))
    assert sum(isinstance(i, LayoutPicture) for i in found) == 1
    assert not any(isinstance(i, LayoutTable) for i in found)
