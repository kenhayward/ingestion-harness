"""A PDF's text layer: every character with its font, size and box on the displayed page.

Read through pypdfium2's text page and its raw API. Coordinates are in points with the origin at
the top left of the page as displayed (`/Rotate` applied). A PDF pdfium cannot open, a
password-protected one included, is rejected; one that opens with an empty password is read.
"""

from __future__ import annotations

import ctypes
import re
from dataclasses import dataclass
from typing import Literal

from ingest_worker.decompose.package import DecompositionRejected
from ingest_worker.symbol_fonts import FIRST, LAST, TABLES, font_family

_BOLD = re.compile(r"bold|black|heavy|semibold|demi", re.IGNORECASE)
_ITALIC = re.compile(r"italic|oblique", re.IGNORECASE)
#: pdfium's render mode for text that is not drawn (the OCR layer of a scan).
_INVISIBLE_RENDER_MODE = 3
#: A page with no visible text and at least this fraction covered by images is a scan.
_SCANNED_IMAGE_AREA = 0.5
_FONT_NAME_BYTES = 256


@dataclass(frozen=True)
class Char:
    index: int
    text: str
    font: str
    size: float
    bold: bool
    italic: bool
    x0: float
    y0: float
    x1: float
    y1: float
    baseline: float
    visible: bool


@dataclass(frozen=True)
class PageText:
    index: int
    width: float
    height: float
    chars: tuple[Char, ...]
    #: The fraction of the page covered by image objects.
    image_area: float

    @property
    def kind(self) -> Literal["born_digital", "scanned"]:
        if any(c.visible for c in self.chars):
            return "born_digital"
        return "scanned" if self.image_area >= _SCANNED_IMAGE_AREA else "born_digital"


@dataclass(frozen=True)
class TextLayer:
    pages: tuple[PageText, ...]
    #: (page index, font, char) of each private-use character no table could translate.
    unmapped_symbols: tuple[tuple[int, str, str], ...]


def map_symbol(char: str, font: str) -> tuple[str, bool]:
    """The character a Symbol or Wingdings private-use code stands for, and whether it is
    unmapped: a private-use code with no table entry is kept as it was."""
    if len(char) != 1 or not FIRST <= ord(char) <= LAST:
        return char, False
    family = font_family(font)
    mapped = TABLES[family].get(ord(char) - FIRST) if family is not None else None
    if mapped is None:
        return char, True
    return mapped, False


def read_text_layer(data: bytes) -> TextLayer:
    import pypdfium2 as pdfium

    try:
        doc = pdfium.PdfDocument(data)
    except pdfium.PdfiumError as e:
        raise DecompositionRejected(f"the PDF cannot be opened: {e}") from e
    try:
        pages: list[PageText] = []
        unmapped: list[tuple[int, str, str]] = []
        for number in range(len(doc)):
            page = doc[number]
            try:
                pages.append(_read_page(page, number, unmapped))
            finally:
                page.close()
        return TextLayer(tuple(pages), tuple(unmapped))
    except pdfium.PdfiumError as e:
        raise DecompositionRejected(f"the PDF cannot be read: {e}") from e
    finally:
        doc.close()


def _read_page(page: object, number: int, unmapped: list[tuple[int, str, str]]) -> PageText:
    import pypdfium2.raw as raw

    left, bottom, right, top = page.get_cropbox()  # type: ignore[attr-defined]
    rotation = page.get_rotation()  # type: ignore[attr-defined]
    uw, uh = right - left, top - bottom
    width, height = (uh, uw) if rotation in (90, 270) else (uw, uh)

    def display(x: float, y: float) -> tuple[float, float]:
        x, y = x - left, y - bottom
        if rotation == 90:
            return y, x
        if rotation == 180:
            return uw - x, y
        if rotation == 270:
            return uh - y, uw - x
        return x, uh - y

    chars: list[Char] = []
    text_page = page.get_textpage()  # type: ignore[attr-defined]
    try:
        handle = text_page.raw
        box = [ctypes.c_double() for _ in range(4)]
        origin = (ctypes.c_double(), ctypes.c_double())
        name = ctypes.create_string_buffer(_FONT_NAME_BYTES)
        flags = ctypes.c_int()
        for i in range(text_page.count_chars()):
            if raw.FPDFText_IsGenerated(handle, i):
                continue  # a space or line break pdfium inserted, not one the PDF draws
            code = raw.FPDFText_GetUnicode(handle, i)
            if code == 0:
                continue
            if not raw.FPDFText_GetCharBox(handle, i, *box):
                continue
            raw.FPDFText_GetCharOrigin(handle, i, *origin)
            raw.FPDFText_GetFontInfo(handle, i, name, _FONT_NAME_BYTES, flags)
            font = name.value.decode("utf-8", "replace")
            obj = raw.FPDFText_GetTextObject(handle, i)
            visible = not (obj and raw.FPDFTextObj_GetTextRenderMode(obj) == _INVISIBLE_RENDER_MODE)
            text, is_unmapped = map_symbol(chr(code), font)
            if is_unmapped:
                unmapped.append((number, font, text))
            (bx0, bx1, by0, by1) = (b.value for b in box)
            xa, ya = display(bx0, by0)
            xb, yb = display(bx1, by1)
            chars.append(
                Char(
                    index=len(chars),
                    text=text,
                    font=font,
                    size=float(raw.FPDFText_GetFontSize(handle, i)),
                    bold=bool(_BOLD.search(font)),
                    italic=bool(_ITALIC.search(font)),
                    x0=min(xa, xb),
                    y0=min(ya, yb),
                    x1=max(xa, xb),
                    y1=max(ya, yb),
                    baseline=display(origin[0].value, origin[1].value)[1],
                    visible=visible,
                )
            )
    finally:
        text_page.close()
    return PageText(number, width, height, tuple(chars), _image_area(page, (left, bottom, uw, uh)))


def _image_area(page: object, box: tuple[float, float, float, float]) -> float:
    """The fraction of the page's box covered by image objects, each clipped to the box."""
    import pypdfium2.raw as raw

    left, bottom, uw, uh = box
    if uw <= 0 or uh <= 0:
        return 0.0
    covered = 0.0
    for obj in page.get_objects(filter=[raw.FPDF_PAGEOBJ_IMAGE]):  # type: ignore[attr-defined]
        x0, y0, x1, y1 = obj.get_bounds()
        w = min(x1, left + uw) - max(x0, left)
        h = min(y1, bottom + uh) - max(y0, bottom)
        if w > 0 and h > 0:
            covered += w * h
    return min(covered / (uw * uh), 1.0)
