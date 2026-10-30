"""Symbol and Wingdings characters in a PDF's text layer (degree signs in a Word sample).

Word writes Symbol-font characters as private-use code points (U+F000 + the font's own code),
and a PDF's ToUnicode map passes them on: `25 °C` reads `25 \\uf0b0C`. The extractor maps them to
real characters, only for the font that drew them: the same code point is another glyph in
Wingdings.
"""

from __future__ import annotations

import io
import time

import pytest
from pypdf import PdfWriter
from pypdf.generic import DecodedStreamObject, DictionaryObject, NameObject

from ingest_worker import pdf as pdf_module
from ingest_worker.pdf import extract_pages
from ingest_worker.symbol_fonts import (
    MAX_CMAP_BYTES,
    font_family,
    private_use_codes,
    translation,
)


def _cmap(pairs: str) -> str:
    return (
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap\n"
        "/CMapName/Adobe-Identity-UCS def /CMapType 2 def\n"
        "1 begincodespacerange <00> <FF> endcodespacerange\n"
        f"{pairs}\n"
        "endcmap CMapName currentdict /CMap defineresource pop end end"
    )


def _pdf(fonts: dict[str, tuple[str, str | None]], content: bytes) -> bytes:
    """A one-page PDF: `fonts` is resource name -> (BaseFont, ToUnicode CMap or None)."""
    writer = PdfWriter()
    page = writer.add_blank_page(612, 792)
    resources = DictionaryObject()
    for name, (base, cmap) in fonts.items():
        font = DictionaryObject(
            {
                NameObject("/Type"): NameObject("/Font"),
                NameObject("/Subtype"): NameObject("/Type1"),
                NameObject("/BaseFont"): NameObject(base),
            }
        )
        if cmap is not None:
            stream = DecodedStreamObject()
            stream.set_data(cmap.encode())
            font[NameObject("/ToUnicode")] = writer._add_object(stream)
        resources[NameObject(name)] = writer._add_object(font)
    page[NameObject("/Resources")] = DictionaryObject({NameObject("/Font"): resources})
    stream = DecodedStreamObject()
    stream.set_data(content)
    page[NameObject("/Contents")] = writer._add_object(stream)
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()


HELVETICA = ("/Helvetica", None)
SYMBOL_CMAP = _cmap("3 beginbfchar\n<01> <F0B0>\n<02> <F0B3>\n<03> <F0D7>\nendbfchar")
WINGDINGS_CMAP = _cmap("1 beginbfchar\n<01> <F0FC>\nendbfchar")


def test_degree_sign_of_a_libreoffice_symbol_font() -> None:
    # LibreOffice draws Word's Symbol characters with OpenSymbol (as for a Word upload).
    pdf = _pdf(
        {"/F1": HELVETICA, "/F2": ("/GAAAAA+OpenSymbol", SYMBOL_CMAP)},
        b"BT /F1 12 Tf 72 720 Td (25 ) Tj /F2 12 Tf (\\001) Tj /F1 12 Tf (C/60% RH) Tj ET",
    )
    assert extract_pages(pdf) == ["25 °C/60% RH"]


def test_symbol_comparisons_and_operators() -> None:
    pdf = _pdf(
        {"/F1": HELVETICA, "/F2": ("/ABCDEF+SymbolMT", SYMBOL_CMAP)},
        b"BT /F2 12 Tf 72 720 Td (\\002) Tj /F1 12 Tf (0.05% W) Tj /F2 12 Tf (\\003) Tj "
        b"/F1 12 Tf (h) Tj ET",
    )
    assert extract_pages(pdf) == ["≥0.05% W⋅h"]


def test_wingdings_check_mark_is_not_read_as_symbol() -> None:
    # U+F0FC is a check mark in Wingdings and a bracket piece in Symbol.
    pdf = _pdf(
        {"/F1": HELVETICA, "/F2": ("/Wingdings-Regular", WINGDINGS_CMAP)},
        b"BT /F2 12 Tf 72 720 Td (\\001) Tj /F1 12 Tf ( Pass) Tj ET",
    )
    assert extract_pages(pdf) == ["✓ Pass"]


def test_private_use_codes_of_other_fonts_are_left_alone() -> None:
    pdf = _pdf(
        {"/F1": HELVETICA, "/F2": ("/BAAAAA+Calibri", SYMBOL_CMAP)},
        b"BT /F1 12 Tf 72 720 Td (25 ) Tj /F2 12 Tf (\\001) Tj /F1 12 Tf (C) Tj ET",
    )
    assert extract_pages(pdf) == ["25 C"]


def test_a_code_two_families_draw_on_one_page_is_left_alone() -> None:
    both = _cmap("1 beginbfchar\n<01> <F0FC>\nendbfchar")
    pdf = _pdf(
        {"/F1": ("/SymbolMT", both), "/F2": ("/Wingdings", both)},
        b"BT /F1 12 Tf 72 720 Td (\\001) Tj /F2 12 Tf (\\001) Tj ET",
    )
    assert extract_pages(pdf) == [""]


@pytest.mark.parametrize(
    ("base_font", "family"),
    [
        ("/Symbol", "symbol"),
        ("/ABCDEF+SymbolMT", "symbol"),
        ("/GAAAAA+OpenSymbol", "symbol"),
        ("/SymbolMT-Identity-H", "symbol"),
        ("/Wingdings", "wingdings"),
        ("/ABCDEF+Wingdings-Regular", "wingdings"),
        ("/Wingdings2", None),  # another glyph set
        ("/Wingdings3", None),
        ("/SegoeUISymbol", None),  # real Unicode
        ("/Calibri", None),
        ("/ABCDEF+Calibri,Bold", None),
    ],
)
def test_font_family(base_font: str, family: str | None) -> None:
    assert font_family(base_font) == family


@pytest.mark.parametrize(
    ("cmap", "codes"),
    [
        ("1 beginbfchar\n<01> <F0B0>\nendbfchar", {0xF0B0}),
        ("2 beginbfchar <01> <0041> <02> <f0b3> endbfchar", {0xF0B3}),
        ("1 beginbfrange\n<01> <03> <F0B0>\nendbfrange", {0xF0B0, 0xF0B1, 0xF0B2}),
        ("1 beginbfrange\n<01> <02> [<F0B0> <0041>]\nendbfrange", {0xF0B0}),
        ("1 beginbfchar\n<0001> <E000>\nendbfchar", set()),  # private use, not a font's
        ("1 beginbfchar\n<01> <00B0>\nendbfchar", set()),
    ],
)
def test_private_use_codes(cmap: str, codes: set[int]) -> None:
    assert private_use_codes(_cmap(cmap).encode()) == codes


@pytest.mark.parametrize(
    ("code", "family", "char"),
    [
        (0xF0B0, "symbol", "°"),
        (0xF0B1, "symbol", "±"),
        (0xF0B3, "symbol", "≥"),
        (0xF0A3, "symbol", "≤"),
        (0xF0B4, "symbol", "×"),
        (0xF0B8, "symbol", "÷"),
        (0xF0B9, "symbol", "≠"),
        (0xF0BB, "symbol", "≈"),
        (0xF0D7, "symbol", "⋅"),
        (0xF0B7, "symbol", "•"),
        (0xF06D, "symbol", "µ"),  # micro, as units are written elsewhere
        (0xF061, "symbol", "α"),
        (0xF062, "symbol", "β"),
        (0xF044, "symbol", "Δ"),
        (0xF057, "symbol", "Ω"),
        (0xF0AE, "symbol", "→"),
        (0xF0A5, "symbol", "∞"),
        (0xF02D, "symbol", "−"),
        (0xF030, "symbol", "0"),
        (0xF0FC, "wingdings", "✓"),
        (0xF0FB, "wingdings", "✗"),
        (0xF0FE, "wingdings", "☑"),
        (0xF0FD, "wingdings", "☒"),
        (0xF06C, "wingdings", "●"),
        (0xF0A7, "wingdings", "▪"),
        (0xF0D8, "wingdings", "➢"),
        (0xF0E2, "wingdings", "⬇"),
        (0xF0E0, "wingdings", "➡"),
        (0xF0F0, "wingdings", "⇨"),
    ],
)
def test_translation(code: int, family: str, char: str) -> None:
    assert translation({family: {code}}) == {code: char}


def test_translation_leaves_codes_without_a_character() -> None:
    # Symbol 0x60 is a radical extender, a glyph piece Unicode has no character for.
    assert translation({"symbol": {0xF060}}) == {}


def test_translation_leaves_a_code_two_families_use() -> None:
    assert translation({"symbol": {0xF0B7, 0xF0B0}, "wingdings": {0xF0B7}}) == {0xF0B0: "°"}
    assert translation({"symbol": {0xF0B0}, None: {0xF0B0}}) == {}


def test_a_huge_range_is_clamped_to_the_font_range() -> None:
    # A crafted range must not count through 2^40 codes to find the 16 in U+F0F0-U+F0FF.
    cmap = _cmap("1 beginbfrange\n<00> <FFFFFFFFFF> <F0F0>\nendbfrange")
    assert private_use_codes(cmap.encode()) == set(range(0xF0F0, 0xF100))


def test_a_reversed_range_has_no_codes() -> None:
    assert (
        private_use_codes(_cmap("1 beginbfrange\n<05> <01> <F0B0>\nendbfrange").encode()) == set()
    )


def test_unterminated_blocks_are_read_in_linear_time() -> None:
    # A lazy `begin(.*?)end` scan restarts at every unmatched begin: quadratic in the stream.
    cmap = b"beginbfchar <01> <F0B0> " * 50_000
    started = time.perf_counter()
    assert private_use_codes(cmap) == set()
    assert time.perf_counter() - started < 2


def test_an_oversized_cmap_is_not_read() -> None:
    pairs = "<01> <F0B0>\n" * (MAX_CMAP_BYTES // 12 + 1)
    assert private_use_codes(_cmap(f"beginbfchar\n{pairs}endbfchar").encode()) == set()


def test_a_cmap_shared_by_pages_is_read_once(monkeypatch: pytest.MonkeyPatch) -> None:
    writer = PdfWriter()
    stream = DecodedStreamObject()
    stream.set_data(SYMBOL_CMAP.encode())
    font = DictionaryObject(
        {
            NameObject("/Type"): NameObject("/Font"),
            NameObject("/Subtype"): NameObject("/Type1"),
            NameObject("/BaseFont"): NameObject("/SymbolMT"),
            NameObject("/ToUnicode"): writer._add_object(stream),
        }
    )
    ref = writer._add_object(font)
    for _ in range(3):
        page = writer.add_blank_page(612, 792)
        page[NameObject("/Resources")] = DictionaryObject(
            {NameObject("/Font"): DictionaryObject({NameObject("/F1"): ref})}
        )
        content = DecodedStreamObject()
        content.set_data(b"BT /F1 12 Tf 72 720 Td (\001) Tj ET")
        page[NameObject("/Contents")] = writer._add_object(content)
    out = io.BytesIO()
    writer.write(out)
    calls: list[bytes] = []
    real = pdf_module.private_use_codes

    def counting(cmap: bytes) -> set[int]:
        calls.append(cmap)
        return real(cmap)

    monkeypatch.setattr(pdf_module, "private_use_codes", counting)
    assert extract_pages(out.getvalue()) == ["°", "°", "°"]
    assert len(calls) == 1
