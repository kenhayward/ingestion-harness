"""A PDF's text layer: every character with its font, size and box on the displayed page, and
each page's image objects, ruling lines and URI link annotations.

Read through pypdfium2's text page and its raw API. Coordinates are in points with the origin at
the top left of the page as displayed (`/Rotate` applied). A PDF pdfium cannot open, a
password-protected one included, is rejected; one that opens with an empty password is read.
A glyph pdfium gives no text (code 0, or a code XML 1.0 can't hold: a font with no Unicode mapping
can give its raw code, a control) or no box can't be accounted for: it is left out, and the
visible ones are counted per page and flagged (`left_out_flags`).
"""

from __future__ import annotations

import ctypes
import math
import re
from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Literal

from ingest_worker.decompose.model import Flag
from ingest_worker.decompose.package import DecompositionRejected
from ingest_worker.symbol_fonts import FIRST, LAST, TABLES, font_family

_BOLD = re.compile(r"bold|black|heavy|semibold|demi", re.IGNORECASE)
_ITALIC = re.compile(r"italic|oblique", re.IGNORECASE)
#: pdfium's render mode for text that is not drawn (the OCR layer of a scan).
_INVISIBLE_RENDER_MODE = 3
#: A glyph's box is compared to the nearest 1/this of a point to find one drawn twice.
_OVERPRINT = 2
#: A page with no visible text and at least this fraction covered by images is a scan.
_SCANNED_IMAGE_AREA = 0.5
#: So is a page one image covers this fraction of, with at most `_SCAN_MAX_WORDS` visible words
#: (a stamp or a page number over the scan; spec 15.2).
_SCAN_COVER = 0.8
_SCAN_MAX_WORDS = 20
_FONT_NAME_BYTES = 256
#: A path object at most this many points thick, ...
_RULE_THICK = 2.0
#: ... and at least this many long, is a ruling line.
_RULE_LONG = 4.0
#: The codes XML 1.0 can't hold: controls other than tab, LF and CR, surrogates, U+FFFE and U+FFFF.
_NOT_XML = re.compile("[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]")

#: x0, y0, x1, y1 in points on the page as displayed, top-left origin (as `layout.BBox`).
Box = tuple[float, float, float, float]


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
    #: pdfium put a generated space (or line break) just before this char: a word gap.
    space_before: bool = False
    #: The way the char's text runs on the displayed page, in degrees anticlockwise to the
    #: nearest quarter turn: 0 left to right, 90 upward (a label up the side of a figure), 180,
    #: and 270 downward.
    angle: int = 0
    #: The x of the char's origin on the displayed page: where its baseline is when it runs up
    #: or down.
    origin_x: float = 0.0

    @property
    def across(self) -> float:
        """Where the char's baseline is across its line, growing toward the foot of its glyphs:
        its baseline's y for upright text, and for text that runs up or down the x it is at."""
        if self.angle == 90:
            return self.origin_x
        if self.angle == 180:
            return -self.baseline
        if self.angle == 270:
            return -self.origin_x
        return self.baseline

    @property
    def along(self) -> float:
        """Where the char starts along its line, growing in the direction it reads."""
        if self.angle == 90:
            return -self.y1
        if self.angle == 180:
            return -self.x1
        if self.angle == 270:
            return self.y0
        return self.x0


@dataclass(frozen=True)
class PageText:
    index: int
    width: float
    height: float
    chars: tuple[Char, ...]
    #: The fraction of the page covered by image objects.
    image_area: float
    #: The box of each image object, clipped to the page.
    images: tuple[Box, ...] = ()
    #: The box and URI of each link annotation with a `/URI` action.
    links: tuple[tuple[Box, str], ...] = ()
    #: The box of each ruling line: a path object thin one way and long the other.
    rules: tuple[Box, ...] = ()
    #: Visible glyphs left out because pdfium gave them no text (code 0 or not XML) or no box.
    glyphs_left_out: int = 0
    #: Visible glyphs read once though drawn twice: the same text in the same box as one drawn
    #: before it (a diagram's labels made bold by printing them twice).
    overprinted: int = 0
    #: A scanned page's synthetic text layer, from the OCR model's transcription (scanned.py).
    recognised: bool = False
    #: Read from its own visible text even if it looks like a stamped scan (no OCR model).
    keep_text: bool = False

    @property
    def kind(self) -> Literal["born_digital", "scanned"]:
        if self.recognised:
            return "scanned"
        words = self.visible_words
        if not words:
            return "scanned" if self.image_area >= _SCANNED_IMAGE_AREA else "born_digital"
        if words <= _SCAN_MAX_WORDS and self.largest_image >= _SCAN_COVER and not self.keep_text:
            return "scanned"
        return "born_digital"

    @property
    def visible_words(self) -> int:
        """The words of the visible text: runs of visible, non-blank chars split at word gaps."""
        count = 0
        in_word = False
        for c in self.chars:
            if not c.visible or c.text.isspace():
                in_word = False
                continue
            if not in_word or c.space_before:
                count += 1
            in_word = True
        return count

    @property
    def largest_image(self) -> float:
        """The fraction of the page its largest image covers."""
        area = self.width * self.height
        if area <= 0 or not self.images:
            return 0.0
        return min(max((b[2] - b[0]) * (b[3] - b[1]) for b in self.images) / area, 1.0)

    @property
    def left_out_words(self) -> int:
        """The visible words over a scan, left out: the OCR model reads them from the image."""
        return self.visible_words if self.kind == "scanned" and not self.recognised else 0


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
    #: Each char's scale: how much its matrix shrinks or grows the size pdfium gives.
    scales: list[float] = []
    text_page = page.get_textpage()  # type: ignore[attr-defined]
    try:
        handle = text_page.raw
        box = [ctypes.c_double() for _ in range(4)]
        origin = (ctypes.c_double(), ctypes.c_double())
        name = ctypes.create_string_buffer(_FONT_NAME_BYTES)
        flags = ctypes.c_int()
        matrix = raw.FS_MATRIX()
        drawn: set[tuple[str, int, int, int, int]] = set()
        #: Whether each text object, by its address, is shown: not invisible, not clipped out.
        shown: dict[int, bool] = {}
        overprinted = 0
        gap = False
        left_out = 0
        for i in range(text_page.count_chars()):
            if raw.FPDFText_IsGenerated(handle, i):
                gap = True  # a space or line break pdfium inserted, not one the PDF draws
                continue
            obj = raw.FPDFText_GetTextObject(handle, i)
            if not obj:
                visible = True
            elif (address := ctypes.cast(obj, ctypes.c_void_p).value or 0) in shown:
                visible = shown[address]
            else:
                visible = shown[address] = not (
                    raw.FPDFTextObj_GetTextRenderMode(obj) == _INVISIBLE_RENDER_MODE
                    or _clipped_out(obj)
                )
            code = raw.FPDFText_GetUnicode(handle, i)
            if _no_text(code) or not raw.FPDFText_GetCharBox(handle, i, *box):
                left_out += visible
                continue
            raw.FPDFText_GetCharOrigin(handle, i, *origin)
            raw.FPDFText_GetFontInfo(handle, i, name, _FONT_NAME_BYTES, flags)
            font = name.value.decode("utf-8", "replace")
            text, is_unmapped = map_symbol(chr(code), font)
            if is_unmapped:
                unmapped.append((number, font, text))
            (bx0, bx1, by0, by1) = (b.value for b in box)
            xa, ya = display(bx0, by0)
            xb, yb = display(bx1, by1)
            if visible and not text.isspace():
                key = (text, *(round(v * _OVERPRINT) for v in (xa, ya, xb, yb)))
                if key in drawn:
                    overprinted += 1
                    continue
                drawn.add(key)  # type: ignore[arg-type]
            ox, oy = display(origin[0].value, origin[1].value)
            if raw.FPDFText_GetMatrix(handle, i, ctypes.byref(matrix)):
                a, b, c_, d = matrix.a, matrix.b, matrix.c, matrix.d
            else:
                a, b, c_, d = 1.0, 0.0, 0.0, 1.0
            dx, dy = display(origin[0].value + a, origin[1].value + b)
            scales.append(math.sqrt(abs(a * d - b * c_)))
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
                    baseline=oy,
                    visible=visible,
                    space_before=gap,
                    angle=_quarter_turn(dx - ox, dy - oy),
                    origin_x=ox,
                )
            )
            gap = False
    finally:
        text_page.close()
    chars = _sized(chars, scales)
    images = _image_boxes(page, display, width, height)
    covered = sum((b[2] - b[0]) * (b[3] - b[1]) for b in images)
    area = min(covered / (width * height), 1.0) if width > 0 and height > 0 else 0.0
    links = _links(page, display)
    rules = _rules(page, display)
    return PageText(
        number,
        width,
        height,
        tuple(chars),
        area,
        images,
        links,
        rules=rules,
        glyphs_left_out=left_out,
        overprinted=overprinted,
    )


def _clipped_out(obj: object) -> bool:
    """Whether a text object's clip paths leave none of it shown: the boxes round them, which
    hold all they let through, have no area in common with the object's box. A drawing exported
    as a form can carry copies of its labels outside the form's box, clipped away (on page 12 of
    ICH E2C(R2), a figure's caption is printed once and held a second time in its drawing)."""
    import pypdfium2.raw as raw

    clip = raw.FPDFPageObj_GetClipPath(obj)
    if not clip:
        return False
    left, bottom, right, top = (ctypes.c_float() for _ in range(4))
    if not raw.FPDFPageObj_GetBounds(obj, *map(ctypes.byref, (left, bottom, right, top))):
        return False
    shown: list[float] | None = None  # the clip boxes' intersection: x0, y0, x1, y1
    x, y = ctypes.c_float(), ctypes.c_float()
    for path in range(raw.FPDFClipPath_CountPaths(clip)):
        points = []
        for n in range(raw.FPDFClipPath_CountPathSegments(clip, path)):
            segment = raw.FPDFClipPath_GetPathSegment(clip, path, n)
            if segment and raw.FPDFPathSegment_GetPoint(segment, ctypes.byref(x), ctypes.byref(y)):
                points.append((x.value, y.value))
        if points:
            xs, ys = [p[0] for p in points], [p[1] for p in points]
            box = [min(xs), min(ys), max(xs), max(ys)]
            shown = (
                box
                if shown is None
                else [*map(max, shown[:2], box[:2]), *map(min, shown[2:], box[2:])]
            )
    if shown is None:
        return False
    x0, y0, x1, y1 = shown
    return (
        x0 > x1
        or y0 > y1
        or right.value < x0
        or left.value > x1
        or top.value < y0
        or bottom.value > y1
    )


def _quarter_turn(dx: float, dy: float) -> int:
    """The quarter turn nearest the direction (dx, dy) on the displayed page (y down)."""
    if abs(dx) >= abs(dy):
        return 0 if dx >= 0 else 180
    return 270 if dy > 0 else 90


def _sized(chars: list[Char], scales: list[float]) -> list[Char]:
    """The chars at their printed sizes. pdfium gives a char's size as its font's, before the
    matrix it is drawn with scales it: a PDF can draw text at 327 points shrunk 22 times beside
    text at 16 points, as the same 16-point type, and some set every font at 1 point and give
    the size in the matrix alone. So each char's size is its font's times its scale."""
    return [
        replace(c, size=c.size * s) if s > 0 and s != 1 else c
        for c, s in zip(chars, scales, strict=True)
    ]


def _no_text(code: int) -> bool:
    """pdfium gave a glyph no text: code 0, or one XML 1.0 can't hold (the sink refuses it)."""
    return code == 0 or code > 0x10FFFF or bool(_NOT_XML.match(chr(code)))


def left_out_flags(text: TextLayer) -> list[Flag]:
    """An `info` flag for each page with visible glyphs left out (no text or no box)."""
    flags: list[Flag] = []
    for page in text.pages:
        n = page.glyphs_left_out
        if n:
            what = "1 glyph" if n == 1 else f"{n} glyphs"
            verb = "was" if n == 1 else "were"
            message = f"{what} on page {page.index + 1} had no text and {verb} left out"
            flags.append(Flag(code="structure_inferred", severity="info", at=None, message=message))
    return flags


def _displayed(
    display: Callable[[float, float], tuple[float, float]],
    x0: float,
    y0: float,
    x1: float,
    y1: float,
) -> Box:
    """A box in page space, as displayed."""
    xa, ya = display(x0, y0)
    xb, yb = display(x1, y1)
    return (min(xa, xb), min(ya, yb), max(xa, xb), max(ya, yb))


def _image_boxes(
    page: object,
    display: Callable[[float, float], tuple[float, float]],
    width: float,
    height: float,
) -> tuple[Box, ...]:
    """The displayed box of each image object, clipped to the page; those outside it left out."""
    import pypdfium2.raw as raw

    boxes: list[Box] = []
    for obj in page.get_objects(filter=[raw.FPDF_PAGEOBJ_IMAGE]):  # type: ignore[attr-defined]
        x0, y0, x1, y1 = _displayed(display, *obj.get_bounds())
        clipped = (max(x0, 0.0), max(y0, 0.0), min(x1, width), min(y1, height))
        if clipped[0] < clipped[2] and clipped[1] < clipped[3]:
            boxes.append(clipped)
    return tuple(boxes)


def _rules(page: object, display: Callable[[float, float], tuple[float, float]]) -> tuple[Box, ...]:
    """The displayed box of each path object thin enough one way and long enough the other to be
    a ruling line: a stroked line, or a thin filled rectangle as Word draws a table's borders."""
    import pypdfium2.raw as raw

    boxes: list[Box] = []
    for obj in page.get_objects(filter=[raw.FPDF_PAGEOBJ_PATH]):  # type: ignore[attr-defined]
        box = _displayed(display, *obj.get_bounds())
        width, height = box[2] - box[0], box[3] - box[1]
        if min(width, height) <= _RULE_THICK and max(width, height) >= _RULE_LONG:
            boxes.append(box)
    return tuple(boxes)


def _links(
    page: object, display: Callable[[float, float], tuple[float, float]]
) -> tuple[tuple[Box, str], ...]:
    """The displayed rect and URI of each link annotation whose action is a `/URI`."""
    import pypdfium2.raw as raw

    handle = page.raw  # type: ignore[attr-defined]
    doc = page.pdf.raw  # type: ignore[attr-defined]
    found: list[tuple[Box, str]] = []
    position = ctypes.c_int(0)
    link = raw.FPDF_LINK()
    while raw.FPDFLink_Enumerate(handle, ctypes.byref(position), ctypes.byref(link)):
        action = raw.FPDFLink_GetAction(link)
        if not action or raw.FPDFAction_GetType(action) != raw.PDFACTION_URI:
            continue
        size = raw.FPDFAction_GetURIPath(doc, action, None, 0)
        if size <= 1:
            continue
        buffer = ctypes.create_string_buffer(size)
        raw.FPDFAction_GetURIPath(doc, action, buffer, size)
        rect = raw.FS_RECTF()
        if not raw.FPDFLink_GetAnnotRect(link, rect):
            continue
        box = _displayed(display, rect.left, rect.bottom, rect.right, rect.top)
        found.append((box, buffer.value.decode("utf-8", "replace")))
    return tuple(found)
