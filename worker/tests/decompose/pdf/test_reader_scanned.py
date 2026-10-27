"""`decompose_pdf` on PDFs with scanned pages, through a fake layout service and a fake OCR
transcriber (spec section 15)."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any

import pytest

from ingest_worker.decompose.inline import plain_text
from ingest_worker.decompose.model import Block, Paragraph, Section, Table, Text
from ingest_worker.decompose.package import DecompositionFailed
from ingest_worker.decompose.pdf import decompose_pdf
from ingest_worker.decompose.pdf.transcript import Transcript, TranscriptionFailed
from tests.decompose.pdf import docling
from tests.decompose.pdf.fakes import FakeCropper, FakeLayout
from tests.decompose.pdf.make_pdf import Img, Page, Run, make_pdf
from tests.decompose.pdf.test_pdf_tables import cell_runs, grid, simple

WIDTH, HEIGHT = 595.0, 842.0


def bl(x0: float, y0: float, x1: float, y1: float) -> docling.Box:
    return (x0, HEIGHT - y0, x1, HEIGHT - y1)


def scan() -> Page:
    return Page(images=[Img(0, 0, WIDTH, HEIGHT)])


class FakeTranscriber:
    def __init__(
        self, pages: Mapping[int, str], rotations: Mapping[int, int] | None = None
    ) -> None:
        self.pages = pages
        self.rotations = rotations or {}
        self.calls: list[list[int]] = []

    def transcribe(self, pages: Sequence[int]) -> dict[int, Transcript]:
        self.calls.append(list(pages))
        return {p: Transcript(self.pages.get(p, ""), self.rotations.get(p, 0)) for p in pages}


def layout_of(items: list[dict[str, Any]], pages: int) -> FakeLayout:
    return FakeLayout(lambda first, last: docling.doc([(WIDTH, HEIGHT)] * pages, items))


def mixed() -> tuple[bytes, FakeLayout, FakeTranscriber]:
    runs = [Run("1 Introduction", 72, 60), Run("The plant runs all year.", 72, 80)]
    items = [
        docling.text("section_header", 1, bl(60, 48, 400, 64)),
        docling.text("text", 1, bl(60, 68, 400, 84)),
    ]
    data = make_pdf([Page(runs=runs), scan(), scan()])
    transcriber = FakeTranscriber(
        {
            1: "---\nprimary_language: en\n---\n# 2 Pumps\n\nThe pumps are checked weekly.",
            2: "### 3.2 Scope\n\nIt covers both lines.\n\n"
            "<table><tr><th>Line</th><th>Rate</th></tr><tr><td>A</td><td>5</td></tr></table>",
        }
    )
    return data, layout_of(items, 3), transcriber


def walk(sections: list[Section]) -> list[Section]:
    out: list[Section] = []
    for s in sections:
        out.append(s)
        out.extend(walk(s.sections))
    return out


def text_of(block: Block) -> str:
    assert isinstance(block, Paragraph)
    return plain_text(block.inlines)


def test_mixed_pdf() -> None:
    data, layout, transcriber = mixed()
    result = decompose_pdf(data, layout=layout, transcriber=transcriber, cropper=FakeCropper())
    doc = result.document
    sections = walk(doc.sections)
    assert [plain_text(s.title) for s in sections] == ["Introduction", "Pumps", "Scope"]
    intro, pumps, scope = sections
    assert [text_of(b) for b in intro.blocks] == ["The plant runs all year."]
    assert [text_of(b) for b in pumps.blocks] == ["The pumps are checked weekly."]
    assert scope in pumps.sections  # "3.2" is level 2, whatever its "###"
    paragraph, table = scope.blocks
    assert text_of(paragraph) == "It covers both lines."
    assert isinstance(table, Table)
    recognised = [f for f in doc.report if f.code == "page_recognised"]
    assert [f.message for f in recognised] == [
        "page 2 was read by the OCR model",
        "page 3 was read by the OCR model",
    ]
    assert result.page_map[pumps.blocks[0].id] == [2]
    assert result.page_map[table.id] == [3]
    assert result.page_map[intro.blocks[0].id] == [1]
    assert transcriber.calls == [[1, 2]]


def test_no_transcriber_fails_fast() -> None:
    data, layout, _ = mixed()
    with pytest.raises(DecompositionFailed) as info:
        decompose_pdf(data, layout=layout, cropper=FakeCropper())
    assert info.value.detail == "page 2 is scanned and this CT Studio has no OCR model"
    assert layout.calls == []


def test_transcription_failed_propagates() -> None:
    class Refusing:
        def transcribe(self, pages: Sequence[int]) -> dict[int, Transcript]:
            raise TranscriptionFailed("the OCR model refused the page", at="page 2")

    data, layout, _ = mixed()
    with pytest.raises(DecompositionFailed) as info:
        decompose_pdf(data, layout=layout, transcriber=Refusing(), cropper=FakeCropper())
    assert info.value.at == "page 2"


def test_empty_scanned_page() -> None:
    data, layout, _ = mixed()
    result = decompose_pdf(
        data, layout=layout, transcriber=FakeTranscriber({1: "", 2: "Text."}), cropper=FakeCropper()
    )
    messages = [f.message for f in result.document.report if f.code == "page_recognised"]
    assert messages[0] == "page 2 was read by the OCR model; page 2: no text was recognised"


def test_furniture_counts_born_digital_pages_only() -> None:
    """Six born-digital pages, three with the same header, and six scanned pages: half the
    born-digital pages is enough (spec 15.4)."""
    pages = []
    items = []
    for n in range(6):
        runs = [Run(f"Body text {n}.", 72, 300)]
        if n < 3:
            runs.append(Run("ACME report", 72, 20))
            items.append(docling.text("text", n + 1, bl(60, 10, 300, 26)))
        items.append(docling.text("text", n + 1, bl(60, 290, 300, 306)))
        pages.append(Page(runs=runs))
    pages.extend(scan() for _ in range(6))
    data = make_pdf(pages)
    transcriber = FakeTranscriber({p: f"Scanned body {p}." for p in range(6, 12)})
    result = decompose_pdf(
        data, layout=layout_of(items, 12), transcriber=transcriber, cropper=FakeCropper()
    )
    assert "ACME report" not in str(result.document.model_dump())


def test_scanned_furniture_counted_in_summary() -> None:
    data = make_pdf([scan() for _ in range(3)])
    transcriber = FakeTranscriber({p: f"Body {'ABC'[p]}\n\nPage {p + 1}" for p in range(3)})
    result = decompose_pdf(
        data, layout=layout_of([], 3), transcriber=transcriber, cropper=FakeCropper()
    )
    report = [f.message for f in result.document.report]
    assert "Dropped as page furniture: 3 lines on 3 pages" in report[0]
    assert "Page 2" not in str(result.document.model_dump())


def test_no_join_across_boundary() -> None:
    """A table ending a born-digital page and one starting a scanned page stay two tables, and
    an unfinished paragraph isn't continued by the scanned page (spec 5)."""
    texts = {(0, 0): "Dose", (0, 1): "Result", (1, 0): "5", (1, 1): "Pass"}
    runs = [*cell_runs(texts)]
    items = [grid(1, simple(2, 2), rows=2, cols=2)]
    data = make_pdf([Page(runs=runs), scan()])
    transcriber = FakeTranscriber(
        {1: "<table><tr><td>6</td><td>Fail</td></tr></table>\n\nand so on"}
    )
    result = decompose_pdf(
        data, layout=layout_of(items, 2), transcriber=transcriber, cropper=FakeCropper()
    )
    tables = [b for b in result.document.blocks if isinstance(b, Table)]
    assert len(tables) == 2

    runs = [Run("The pumps run", 72, 800)]
    items = [docling.text("text", 1, bl(60, 790, 400, 806))]
    data = make_pdf([Page(runs=runs), scan()])
    result = decompose_pdf(
        data,
        layout=layout_of(items, 2),
        transcriber=FakeTranscriber({1: "all day long."}),
        cropper=FakeCropper(),
    )
    paragraphs = [b for b in result.document.blocks if isinstance(b, Paragraph)]
    assert [plain_text(p.inlines) for p in paragraphs] == ["The pumps run", "all day long."]


def test_stamped_scan_is_read() -> None:
    page = Page(runs=[Run("Scanned by ACME", 30, 20)], images=[Img(0, 40, WIDTH, HEIGHT - 40)])
    data = make_pdf([page])
    result = decompose_pdf(
        data,
        layout=layout_of([], 1),
        transcriber=FakeTranscriber({0: "Real body text."}),
        cropper=FakeCropper(),
    )
    doc = result.document
    assert [plain_text(b.inlines) for b in doc.blocks if isinstance(b, Paragraph)] == [
        "Real body text."
    ]
    (flag,) = [f for f in doc.report if f.code == "page_recognised"]
    assert flag.message.endswith("3 words of visible text over the scan were left out")


def test_figure_on_a_scanned_page() -> None:
    data = make_pdf([scan()])
    box = bl(100, 200, 400, 500)
    items = [docling.picture(1, box)]
    # 1288 px tall for 842 pt: the placeholder's box in the rendered image's pixels
    s = 1288 / HEIGHT
    name = f"page_{round(100 * s)}_{round(200 * s)}_{round(300 * s)}_{round(300 * s)}.png"
    transcriber = FakeTranscriber({0: f"Before.\n\n![A pump]({name})\n\nFigure 1: The pump."})
    cropper = FakeCropper()
    result = decompose_pdf(
        data, layout=layout_of(items, 1), transcriber=transcriber, cropper=cropper
    )
    doc = result.document
    (image,) = doc.images
    assert image.alt == "A pump"
    assert cropper.calls == [(0, (100.0, 200.0, 400.0, 500.0))]
    assert any(getattr(b, "caption", None) == [Text(text="The pump.")] for b in doc.blocks)


def test_paired_equation_survives_the_reader() -> None:
    data = make_pdf([scan()])
    items = [docling.picture(1, bl(200, 300, 400, 330))]
    result = decompose_pdf(
        data,
        layout=layout_of(items, 1),
        transcriber=FakeTranscriber({0: "Text.\n\n$$x^2$$\n\nMore."}),
        cropper=FakeCropper(),
    )
    doc = result.document
    assert [e.latex for e in doc.equations] == ["x^2"]
    assert len(doc.blocks) == 3


def test_a_stamped_cover_without_ocr_reads_as_born_digital() -> None:
    """With no OCR model, a page with a little visible text over a full image keeps that text
    (spec 15.2's second rule needs the OCR model); only a page with no text at all fails."""
    page = Page(runs=[Run("Annual Report 2026", 72, 300)], images=[Img(0, 0, WIDTH, HEIGHT)])
    data = make_pdf([page])
    result = decompose_pdf(data, layout=layout_of([], 1), cropper=FakeCropper())
    texts = [plain_text(b.inlines) for b in result.document.blocks if isinstance(b, Paragraph)]
    assert texts == ["Annual Report 2026"]
    assert not any(f.code == "page_recognised" for f in result.document.report)


def test_bookmarks_leave_scanned_headings_be() -> None:
    runs = [Run("Introduction", 72, 60), Run("The plant runs all year.", 72, 80)]
    items = [
        docling.text("section_header", 1, bl(60, 48, 400, 64)),
        docling.text("text", 1, bl(60, 68, 400, 84)),
    ]
    data = make_pdf([Page(runs=runs), scan()], outline=[(1, "Introduction", 0, 50)])
    result = decompose_pdf(
        data,
        layout=layout_of(items, 2),
        transcriber=FakeTranscriber({1: "# Appendix\n\nScanned body."}),
        cropper=FakeCropper(),
    )
    titles = [plain_text(s.title) for s in walk(result.document.sections)]
    assert titles == ["Introduction", "Appendix"]
