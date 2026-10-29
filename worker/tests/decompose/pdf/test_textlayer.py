"""Tests for the PDF text layer."""

from __future__ import annotations

import io

import pytest
from pypdf import PdfReader

from ingest_worker.decompose.package import DecompositionRejected
from ingest_worker.decompose.pdf.textlayer import (
    PageText,
    left_out_flags,
    map_symbol,
    read_text_layer,
)
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
    # the last: one word over a full-page image is a stamp on a scan (spec 15.2)
    assert [p.kind for p in layer.pages] == ["born_digital", "scanned", "scanned", "scanned"]
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


@pytest.mark.parametrize("angle", [0, 90, 180, 270])
@pytest.mark.parametrize("rotate", [0, 90])
def test_chars_carry_the_way_their_text_runs(angle: int, rotate: int) -> None:
    chars = _chars(Run("Risk", 300, 400, angle=angle), size=(595, 842), rotate=rotate)
    assert [c.angle for c in chars] == [angle] * 4
    if angle in (90, 270):  # its baseline is a column
        assert all(c.origin_x == pytest.approx(300, abs=1) for c in chars)
        assert len({round(c.baseline) for c in chars}) == 4


def test_text_clipped_out_is_not_visible() -> None:
    # A drawing can hold a copy of a caption outside its box, clipped away.
    page = Page(
        runs=[
            Run("Shown", 72, 100, clip=(60, 80, 300, 110)),
            Run("Hidden", 72, 200, clip=(60, 300, 300, 340)),
        ]
    )
    [layer] = read_text_layer(make_pdf([page])).pages
    assert [(c.text, c.visible) for c in layer.chars if c.text in "SH"] == [
        ("S", True),
        ("H", False),
    ]


def test_a_page_drawn_at_font_size_1_reads_at_its_printed_sizes() -> None:
    # Some PDFs set every font at 1 point and give the size in the matrix: 12 and 8 points here.
    chars = _chars(Run("Body", 72, 100, size=12, scale=12), Run("sub", 72, 120, size=8, scale=8))
    assert [round(c.size, 1) for c in chars] == [12.0] * 4 + [8.0] * 3


def test_a_char_drawn_at_another_scale_takes_the_page_s_size() -> None:
    # 320-point type shrunk 20 times beside 16-point type: both read as 16 points
    chars = _chars(Run("Final", 72, 100, size=16, scale=0.05), Run("Adopted", 72, 120, size=16))
    assert [round(c.size) for c in chars] == [16] * 12


def test_a_glyph_drawn_twice_in_one_place_is_read_once() -> None:
    # pdfium merges a copy drawn soon after the first itself; not one drawn later
    between = [
        Run(word, 72, 200 + 12 * k) for k, word in enumerate(("One", "Two", "Six", "Ten", "Red"))
    ]
    runs = [Run("Dry", 72, 100), *between, Run("Dry", 72, 100)]
    page = read_text_layer(make_pdf([Page(runs)])).pages[0]
    assert "".join(c.text for c in page.chars if not c.text.isspace()) == "DryOneTwoSixTenRed"
    assert page.overprinted == 3


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


def test_visible_glyphs_with_no_text_are_counted_per_page() -> None:
    pages = [
        Page([Run("A\x00B\x00", 72, 100)]),
        Page([Run("Clean", 72, 100), Run("\x00", 72, 200, invisible=True)]),
        Page([Run("C\x00", 72, 100)]),
    ]
    text = read_text_layer(make_pdf(pages))
    assert [p.glyphs_left_out for p in text.pages] == [2, 0, 1]
    assert ["".join(c.text for c in p.chars) for p in text.pages] == ["AB", "Clean", "C"]
    assert [(f.code, f.severity, f.at, f.message) for f in left_out_flags(text)] == [
        ("structure_inferred", "info", None, "2 glyphs on page 1 had no text and were left out"),
        ("structure_inferred", "info", None, "1 glyph on page 3 had no text and was left out"),
    ]


def test_codes_xml_forbids_are_left_out_as_no_text() -> None:
    """A font with no Unicode mapping can give its raw code: a control XML 1.0 can't hold."""
    text = read_text_layer(make_pdf([Page([Run("A\x02B\x1fC\x0bD\tE", 72, 100)])]))
    page = text.pages[0]
    assert "".join(c.text for c in page.chars) == "ABCD\tE"
    assert page.glyphs_left_out == 3
    assert [f.message for f in left_out_flags(text)] == [
        "3 glyphs on page 1 had no text and were left out"
    ]


def test_stamp_over_scan_is_scanned() -> None:
    """Spec 15.2: one image over 80% of the page and at most 20 visible words is a scan."""

    def page_of(words: int, cover: float) -> PageText:
        side = 842 * cover**0.5
        runs = [Run(" ".join(["stamp"] * words), 30, 20)] if words else []
        layer = read_text_layer(
            make_pdf([Page(runs=runs, images=[Img(0, 0, 595 * cover**0.5, side)])])
        )
        return layer.pages[0]

    stamped = page_of(5, 0.9)
    assert stamped.kind == "scanned" and stamped.left_out_words == 5
    wordy = page_of(30, 0.9)
    assert wordy.kind == "born_digital" and wordy.left_out_words == 0
    assert page_of(5, 0.75).kind == "born_digital"
    assert page_of(0, 0.9).left_out_words == 0
