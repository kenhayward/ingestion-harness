"""`decompose_pdf`: the whole PDF pipeline, through a fake layout service."""

from __future__ import annotations

from typing import Any

import pytest

import ingest_worker.decompose.pdf as pdf_reader
from ingest_worker.decompose.model import Paragraph, Table, TableNote, Text
from ingest_worker.decompose.package import DecompositionFailed
from ingest_worker.decompose.pdf import decompose_pdf
from ingest_worker.decompose.pdf.layout import LayoutUnavailable
from tests.decompose.pdf import docling
from tests.decompose.pdf.fakes import FakeCropper, FakeLayout
from tests.decompose.pdf.make_pdf import Img, Page, Run, make_pdf
from tests.decompose.pdf.test_pdf_tables import cell_runs, grid, simple

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


def test_scanned_page_fails_for_now() -> None:
    data = make_pdf([Page(runs=[Run("Text", 72, 100)]), Page(images=[Img(0, 0, WIDTH, HEIGHT)])])
    layout = answering([], pages=2)
    with pytest.raises(DecompositionFailed) as info:
        decompose_pdf(data, layout=layout, cropper=FakeCropper())
    assert info.value.detail == "page 2 is scanned; scanned pages are not read yet"
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
    assert pdf_reader.PDF_READER_VERSION == 1
    assert pdf_reader.MAX_PAGES == 500
