"""`decompose_pdf`: the whole PDF pipeline, through a fake layout service."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

import ingest_worker.decompose.pdf as pdf_reader
from ingest_worker.decompose.forms import tables_of
from ingest_worker.decompose.model import Paragraph, Table, TableNote, Text
from ingest_worker.decompose.package import DecompositionFailed
from ingest_worker.decompose.pdf import decompose_pdf
from ingest_worker.decompose.pdf.layout import LayoutUnavailable
from tests.decompose.pdf import docling
from tests.decompose.pdf.fakes import FakeCropper, FakeLayout
from tests.decompose.pdf.make_pdf import Img, Page, Run, make_pdf
from tests.decompose.pdf.test_pdf_tables import cell_runs, grid, simple
from tests.decompose.pdf.test_pieces import blank_on_the_edge

WIDTH, HEIGHT = 595.0, 842.0


def bl(x0: float, y0: float, x1: float, y1: float) -> docling.Box:
    return (x0, HEIGHT - y0, x1, HEIGHT - y1)


def answering(items: list[dict[str, Any]], pages: int = 1) -> FakeLayout:
    return FakeLayout(lambda first, last: docling.doc([(WIDTH, HEIGHT)] * pages, items))


def small_report() -> tuple[bytes, FakeLayout]:
    texts = {(0, 0): "Dose", (0, 1): "Result", (1, 0): "5", (1, 1): "Pass"}
    runs = [
        Run("Introduction", 72, 60),
        Run("The study ran for two weeks.", 72, 80),
        Run("Table 1: Doses", 72, 92),
        *cell_runs(texts),
        Run("a", 203, 134, size=7, rise=3),  # a superscript marker after "Pass"
        Run("a: measured at 25 C", 72, 160),
        Run("Page 1", 280, 800),
    ]
    items = [
        docling.text("section_header", 1, bl(60, 48, 400, 64)),
        docling.text("text", 1, bl(60, 68, 400, 84)),
        docling.text("caption", 1, bl(60, 86, 400, 96)),
        grid(1, simple(2, 2), rows=2, cols=2),
        docling.text("footnote", 1, bl(60, 148, 400, 165)),
        docling.text("page_footer", 1, bl(270, 788, 330, 804), furniture=True),
    ]
    data = make_pdf([Page(runs=runs)], outline=[(1, "Introduction", 0, 50)])
    return data, answering(items)


def test_end_to_end_small_report() -> None:
    data, layout = small_report()
    result = decompose_pdf(data, layout=layout, cropper=FakeCropper())
    doc = result.document
    assert doc.blocks == []
    [section] = doc.sections
    assert section.title == [Text(text="Introduction")]
    print(section.blocks)
    paragraph, table = section.blocks
    assert isinstance(paragraph, Paragraph)
    assert paragraph.inlines == [Text(text="The study ran for two weeks.")]
    assert isinstance(table, Table)
    assert table.caption == [Text(text="Doses")]
    assert table.numbered
    assert table.notes == [TableNote(marker="a", inlines=[Text(text="measured at 25 C")])]
    assert "Page 1" not in str(doc.model_dump())
    assert [(f.code, f.at, f.message) for f in doc.report] == [
        ("structure_inferred", None, "Dropped as page furniture: 1 line on 1 page"),
        ("structure_inferred", table.id, "Table grid inferred from layout"),
    ]
    assert result.image_bytes == {}
    assert result.originals == {}
    assert layout.calls == [(1, 1)]


def test_cell_text_past_the_table_box_stays_in_its_table() -> None:
    # Docling's table box stops at x=250, but its last cell's box runs on to x=272: the text in
    # that cell, past the table's box, is still the table's (attach_text gave it to the cell).
    table = grid(1, simple(1, 2, header_rows=0), rows=1, cols=2)
    table["prov"][0]["bbox"]["r"] = 250
    runs = [Run("Dose", 76, 114), Run("Over", 245, 114)]
    data = make_pdf([Page(runs=runs)])
    result = decompose_pdf(data, layout=answering([table]), cropper=FakeCropper())
    [built] = result.document.blocks
    assert isinstance(built, Table)
    assert [[c.blocks[0].inlines for c in row.cells] for row in built.rows] == [
        [[Text(text="Dose")], [Text(text="Over")]]
    ]


def test_a_blank_on_a_cell_edge_keeps_its_word_gap() -> None:
    runs, table = blank_on_the_edge()
    data = make_pdf([Page(runs=runs)])
    result = decompose_pdf(data, layout=answering([table]), cropper=FakeCropper())
    [built] = result.document.blocks
    assert isinstance(built, Table)
    assert built.rows[0].cells[0].blocks[0].inlines == [Text(text="Fresh mix")]


FIXTURES = Path(__file__).parent / "fixtures"


def test_rotated_page_with_real_docling_output() -> None:
    """`fixtures/rotated-table.pdf` is a `/Rotate 90` page (displayed 842 x 595) and
    `fixtures/rotated-table.docling.json` the layout service's answer for it, captured (from
    `worker/`, with `PYTHONPATH=.`) against `ingestion-harness/layout:dev` with these lines:

        def grid(x0, y0, cw, rh, n=3):
            out = []
            for i in range(n + 1):
                out.append((x0, y0 + i * rh, x0 + n * cw, y0 + i * rh))
                out.append((x0 + i * cw, y0, x0 + i * cw, y0 + n * rh))
            return out

        rows = [("Check", "Value", "Result"), ("Speed", "12", "Pass"), ("Load", "40", "Fail")]
        cells = [Run(t, 78 + c * 200, 185 + r * 40, 11, "Helvetica-Bold" if r == 0 else "Helvetica")
                 for r, row in enumerate(rows) for c, t in enumerate(row)]
        page = Page(runs=[Run("Results of the run", 72, 80, 16, "Helvetica-Bold"),
                          Run("The table below lists the checks made on the line.", 72, 120),
                          *cells, Run("The line was released after these checks.", 72, 320)],
                    lines=grid(72, 160, 200, 40), rotate=90)
        data = make_pdf([page])
        # POST it to /layout with first=1, last=1; the response's "document", saved with
        # json.dump(indent=1, sort_keys=True)

    Docling found no table on a landscape page with a 4-column, 5-row grid of these glyphs
    (rotated or not), so the grid is 3 x 3 with wide cells.
    """
    data = (FIXTURES / "rotated-table.pdf").read_bytes()
    raw = json.loads((FIXTURES / "rotated-table.docling.json").read_text("utf-8"))
    result = decompose_pdf(data, layout=FakeLayout(lambda first, last: raw), cropper=FakeCropper())
    [table] = tables_of(result.document)
    assert [[plain(c.blocks[0].inlines) for c in row.cells] for row in table.rows] == [
        ["Check", "Value", "Result"],
        ["Speed", "12", "Pass"],
        ["Load", "40", "Fail"],
    ]
    assert table.wide


def plain(inlines: list[Any]) -> str:
    return "".join(i.text for i in inlines if isinstance(i, Text))


def test_scanned_page_without_ocr_fails_fast() -> None:
    data = make_pdf([Page(runs=[Run("Text", 72, 100)]), Page(images=[Img(0, 0, WIDTH, HEIGHT)])])
    layout = answering([], pages=2)
    with pytest.raises(DecompositionFailed) as info:
        decompose_pdf(data, layout=layout, cropper=FakeCropper())
    assert info.value.detail == "page 2 is scanned and this CT Studio has no OCR model"
    assert layout.calls == []


def test_page_limit(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pdf_reader, "MAX_PAGES", 2)
    data = make_pdf([Page(runs=[Run(f"Page {n}", 72, 300)]) for n in range(3)])
    layout = answering([], pages=3)
    with pytest.raises(DecompositionFailed) as info:
        decompose_pdf(data, layout=layout, cropper=FakeCropper())
    assert info.value.detail == "the PDF has 3 pages; the limit is 2"
    assert layout.calls == []


def test_layout_unavailable_propagates() -> None:
    def down(first: int, last: int) -> dict[str, Any]:
        raise LayoutUnavailable("the layout service is down")

    data = make_pdf([Page(runs=[Run("Text", 72, 100)])])
    with pytest.raises(LayoutUnavailable):
        decompose_pdf(data, layout=FakeLayout(down), cropper=FakeCropper())


def test_same_pdf_same_document() -> None:
    data, layout = small_report()
    first = decompose_pdf(data, layout=layout)  # the default cropper, pdfium
    second = decompose_pdf(data, layout=layout)
    assert first.document.model_dump() == second.document.model_dump()


def test_reader_constants() -> None:
    assert pdf_reader.PDF_READER_VERSION == 6
    assert pdf_reader.MAX_PAGES == 500


def test_glyphs_with_no_text_are_flagged_in_the_report() -> None:
    data = make_pdf([Page(runs=[Run("Dose\x00 given.", 72, 100)])])
    result = decompose_pdf(data, layout=answering([]), cropper=FakeCropper())
    assert [(f.code, f.severity, f.at, f.message) for f in result.document.report] == [
        ("structure_inferred", "info", None, "1 glyph on page 1 had no text and was left out"),
        ("structure_inferred", "warning", "s~lead#p-1", "Text the layout analysis missed"),
    ]


def test_line_numbers_and_an_annex_page_number_are_furniture() -> None:
    texts = {(0, 0): "Test", (0, 1): "Limit", (1, 0): "Assay", (1, 1): "95%"}
    lines = [
        ("Annex storage", 120),
        ("The study ran for two weeks", 134),
        ("and was reviewed at the end", 148),
        ("Table 1: Doses", 156),
        ("a: Release testing", 220),
        ("b: Shelf life testing", 234),
    ]
    runs = [Run(str(2190 + k), 40, y, size=8) for k, (_, y) in enumerate(lines)]
    runs += [Run(line, 72, y) for line, y in lines]
    runs += [*cell_runs(texts, top=160), Run("A3 8", 280, 800)]
    runs += [Run("a", 112, 194, size=7, rise=3), Run("b", 200, 194, size=7, rise=3)]
    items = [
        docling.text("section_header", 1, bl(30, 108, 400, 123)),
        docling.text("text", 1, bl(30, 125, 400, 151)),
        docling.text("caption", 1, bl(30, 152, 400, 159)),
        grid(1, simple(2, 2), rows=2, cols=2, top=160),
        docling.text("text", 1, bl(30, 210, 400, 238)),
        docling.picture(1, bl(270, 785, 330, 806)),
        docling.text("text", 1, bl(275, 790, 320, 804)),
    ]
    result = decompose_pdf(
        make_pdf([Page(runs=runs)]), layout=answering(items), cropper=FakeCropper()
    )
    doc = result.document
    [section] = doc.sections
    assert section.title == [Text(text="Annex storage")]
    paragraph, table = section.blocks
    assert isinstance(paragraph, Paragraph)
    assert paragraph.inlines == [
        Text(text="The study ran for two weeks and was reviewed at the end")
    ]
    assert isinstance(table, Table)
    assert table.caption == [Text(text="Doses")]
    assert table.notes == [
        TableNote(marker="a", inlines=[Text(text="Release testing")]),
        TableNote(marker="b", inlines=[Text(text="Shelf life testing")]),
    ]
    assert "219" not in str(doc.model_dump())
    assert "A3" not in str(doc.model_dump())
    assert doc.images == []
    assert [(f.severity, f.message) for f in doc.report if f.at is None] == [
        (
            "info",
            "Dropped as page furniture: 1 line and 1 picture on 1 page; 6 line numbers on 1 page",
        ),
        ("info", "Heading levels inferred for 1 heading"),
    ]
