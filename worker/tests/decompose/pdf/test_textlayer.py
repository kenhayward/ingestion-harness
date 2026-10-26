"""Tests for the PDF text layer."""

from __future__ import annotations

import io

import pytest
from pypdf import PdfReader

from ingest_worker.decompose.package import DecompositionRejected
from ingest_worker.decompose.pdf.textlayer import map_symbol, read_text_layer
from tests.decompose.pdf.make_pdf import Img, Page, Run, make_pdf


def _chars(*runs: Run, **page: object):
    return read_text_layer(make_pdf([Page(list(runs), **page)])).pages[0].chars  # type: ignore[arg-type]


def test_chars_carry_font_size_and_position() -> None:
    chars = _chars(Run("Hello", 72, 100))
    assert "".join(c.text for c in chars) == "Hello"
    assert all(c.font == "Helvetica" and c.size == 11 for c in chars)
    assert chars[0].x0 == pytest.approx(72, abs=1)
    assert all(c.baseline == pytest.approx(100, abs=2) for c in chars)
    assert all(c.y0 < c.baseline <= c.y1 + 1 for c in chars)
    assert [c.index for c in chars] == [0, 1, 2, 3, 4]


def test_generated_space_marks_the_next_char() -> None:
    a, b = _chars(Run("A", 72, 100), Run("B", 120, 100))
    assert (a.space_before, b.space_before) == (False, True)


def test_bold_and_italic_from_font_name() -> None:
    bold, italic, plain = _chars(
        Run("B", 72, 100, font="Helvetica-Bold"),
        Run("I", 100, 100, font="Helvetica-Oblique"),
        Run("P", 130, 100),
    )
    assert (bold.bold, bold.italic) == (True, False)
    assert (italic.bold, italic.italic) == (False, True)
    assert (plain.bold, plain.italic) == (False, False)


def test_symbol_font_mapped() -> None:
    # pdfium may read a Symbol 0xB0 as U+00B0 or as U+F0B0; both are a degree sign.
    layer = read_text_layer(make_pdf([Page([Run("°", 72, 100, font="Symbol")])]))
    assert [c.text for c in layer.pages[0].chars] == ["°"]
    assert layer.unmapped_symbols == ()
    assert map_symbol("", "ABCDEF+SymbolMT") == ("°", False)


def test_private_use_char_without_table_entry_is_kept_and_unmapped() -> None:
    assert map_symbol("", "Symbol") == ("", True)
    assert map_symbol("", "Arial") == ("", True)
    assert map_symbol("A", "Symbol") == ("A", False)


def test_invisible_text_is_not_visible() -> None:
    hidden, shown = _chars(Run("a", 72, 100, invisible=True), Run("b", 100, 100))
    assert hidden.visible is False
    assert shown.visible is True


def test_page_kinds() -> None:
    full = Img(0, 0, 595, 842)
    layer = read_text_layer(
        make_pdf(
            [
                Page([Run("Hello", 72, 100)]),
                Page([Run("Hello", 72, 100, invisible=True)], [full]),
                Page([], [full]),
                Page([Run("Hello", 72, 100)], [full]),
            ]
        )
    )
    assert [p.kind for p in layer.pages] == ["born_digital", "scanned", "scanned", "born_digital"]
    assert layer.pages[0].image_area == 0
    assert layer.pages[2].image_area == pytest.approx(1)


def test_image_area_is_a_fraction_clipped_to_the_page() -> None:
    page = read_text_layer(make_pdf([Page([], [Img(0, 0, 297.5, 842), Img(500, 0, 200, 842)])]))
    assert page.pages[0].image_area == pytest.approx(0.5 + 95 / 595, abs=0.01)


def test_blank_page_is_born_digital() -> None:
    page = read_text_layer(make_pdf([Page()])).pages[0]
    assert page.chars == ()
    assert page.kind == "born_digital"


def test_rotated_page_reads_upright() -> None:
    page = read_text_layer(
        make_pdf([Page([Run("Hello", 72, 100)], size=(595, 842), rotate=90)])
    ).pages[0]
    assert (page.width, page.height) == (842, 595)
    xs = [c.x0 for c in page.chars]
    assert xs == sorted(xs) and len(set(xs)) == 5
    assert xs[0] == pytest.approx(72, abs=1)
    assert page.chars[0].baseline == pytest.approx(100, abs=2)


@pytest.mark.parametrize("rotate", [180, 270])
def test_other_rotations_read_upright(rotate: int) -> None:
    chars = _chars(Run("Hello", 72, 100), rotate=rotate)
    xs = [c.x0 for c in chars]
    assert xs == sorted(xs)
    assert xs[0] == pytest.approx(72, abs=1)
    assert chars[0].baseline == pytest.approx(100, abs=2)


def test_password_protected_is_rejected() -> None:
    with pytest.raises(DecompositionRejected):
        read_text_layer(make_pdf([Page([Run("Hello", 72, 100)])], password="x"))


def test_unparseable_is_rejected() -> None:
    with pytest.raises(DecompositionRejected):
        read_text_layer(b"%PDF-1.7 garbage")


def test_builder_outline_info_and_links_survive() -> None:
    data = make_pdf(
        [Page([Run("Hello", 72, 100)]), Page([Run("Two", 72, 100)])],
        outline=[(1, "One", 0, None), (2, "Sub", 1, 50.0)],
        info={"/Title": "T"},
        links=[(0, (72, 90, 120, 105), "https://example.com")],
    )
    assert len(read_text_layer(data).pages) == 2
    reader = PdfReader(io.BytesIO(data))
    assert reader.metadata is not None and reader.metadata.title == "T"
    assert reader.outline[0].title == "One" and reader.outline[1][0].title == "Sub"
    assert reader.pages[0]["/Annots"][0].get_object()["/A"]["/URI"] == "https://example.com"
