from __future__ import annotations

import io
from concurrent.futures import ThreadPoolExecutor

import pytest

from ingest_worker.ocr import (
    OLMOCR_PROMPT,
    OcrSettings,
    ocr_page,
    pages_needing_ocr,
    parse_olmocr,
    render_page_png,
)

from .decompose.pdf.make_pdf import Page, Run, make_pdf
from .fakes import FakeProvider

SETTINGS = OcrSettings(model="local/olmocr-2-7b-1025")


@pytest.mark.parametrize(
    ("mode", "expected"),
    [("auto", [1, 2]), ("always", [0, 1, 2]), ("never", [])],
)
def test_pages_needing_ocr(mode: str, expected: list[int]) -> None:
    pages = ["INVOICE 42 Acme Supplies Ltd, 1 High St", "  \n ", "p. 3"]
    assert pages_needing_ocr(pages, mode, min_chars=25) == expected  # type: ignore[arg-type]


def test_parse_olmocr_strips_front_matter() -> None:
    raw = (
        "---\nprimary_language: en\nis_rotation_valid: false\nrotation_correction: 90\n"
        "is_table: false\nis_diagram: false\n---\nINVOICE 42\nTotal 10.00\n"
    )
    text, meta = parse_olmocr(raw)
    assert text == "INVOICE 42\nTotal 10.00"
    assert meta["rotation_correction"] == 90 and meta["is_rotation_valid"] is False


def test_parse_olmocr_without_front_matter_returns_text() -> None:
    assert parse_olmocr("plain text\n") == ("plain text", {})


def fake_render(calls: list[tuple[int, int]]):  # type: ignore[no-untyped-def]
    def render(pdf: bytes, index: int, longest_dim: int, rotation: int) -> bytes:
        calls.append((index, rotation))
        return b"\x89PNG-fake-" + bytes([index, rotation // 90])

    return render


def test_ocr_page_sends_olmocr_prompt_and_image() -> None:
    provider = FakeProvider("local")
    provider.vision_responses = ["---\nis_rotation_valid: true\nrotation_correction: 0\n---\nHELLO"]
    renders: list[tuple[int, int]] = []

    page = ocr_page(provider, "olmocr-2-7b-1025", b"%PDF", 3, SETTINGS, fake_render(renders))

    assert page.index == 3 and page.text == "HELLO" and page.rotation == 0
    [(model, request)] = provider.vision_calls
    assert model == "olmocr-2-7b-1025"
    assert request.prompt == OLMOCR_PROMPT
    assert request.image_png.startswith(b"\x89PNG")
    assert request.max_tokens == SETTINGS.max_tokens
    assert renders == [(3, 0)]


def test_ocr_page_retries_once_with_rotation_correction() -> None:
    provider = FakeProvider("local")
    provider.vision_responses = [
        "---\nis_rotation_valid: false\nrotation_correction: 270\n---\nsdrawkcab",
        "---\nis_rotation_valid: true\nrotation_correction: 0\n---\nupright text",
    ]
    renders: list[tuple[int, int]] = []

    page = ocr_page(provider, "m", b"%PDF", 0, SETTINGS, fake_render(renders))

    assert page.text == "upright text" and page.rotation == 270
    assert renders == [(0, 0), (0, 270)]
    assert len(page.raw) == 2


def test_render_page_png_scales_longest_side() -> None:
    pdfium = pytest.importorskip("pypdfium2")
    from PIL import Image

    doc = pdfium.PdfDocument.new()
    doc.new_page(612, 792)  # US Letter, portrait
    buf = io.BytesIO()
    doc.save(buf)

    png = render_page_png(buf.getvalue(), 0, 1288, 0)
    image = Image.open(io.BytesIO(png))
    assert image.format == "PNG"
    assert max(image.size) == 1288 and image.size[1] > image.size[0]

    rotated = Image.open(io.BytesIO(render_page_png(buf.getvalue(), 0, 1288, 90)))
    assert rotated.size[0] > rotated.size[1]


def test_parse_olmocr_flattens_html_tables_to_text_rows() -> None:
    raw = (
        "---\nis_table: true\n---\nINVOICE 42\n"
        "<table><tr><th>Description</th><th>Qty</th><th>Amount</th></tr>"
        "<tr><td>Widget &amp; bolt</td><td>2</td><td>10.00</td></tr></table>\nSubtotal 10.00"
    )
    text, _ = parse_olmocr(raw)
    assert text.splitlines() == [
        "INVOICE 42",
        "Description  Qty  Amount",
        "Widget & bolt  2  10.00",
        "Subtotal 10.00",
    ]


def test_pages_render_from_many_threads_at_once() -> None:
    """OCR renders from a thread pool; PDFium, not thread-safe, failed such opens at random with
    "Failed to load document (PDFium: Data format error)"."""
    pdf = make_pdf([Page(runs=[Run(f"Page {n}", 72, 100)]) for n in range(4)])
    with ThreadPoolExecutor(max_workers=8) as pool:
        pngs = list(pool.map(lambda i: render_page_png(pdf, i % 4, 200, 0), range(64)))
    assert all(png.startswith(b"\x89PNG") for png in pngs)
