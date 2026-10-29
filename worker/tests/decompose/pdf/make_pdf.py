"""Synthetic PDFs for the PDF reader's tests.

`make_pdf` writes the page content itself (standard-14 fonts, ruling lines, a 1x1 image
stretched over a box) and uses pypdf only for what sits around it: the outline, encryption, the
info dictionary and link annotations.

Every position is in points on the page as displayed, with the origin at the top left, so a page
with `rotate=90` is drawn upright for the reader: the builder turns the coordinates and the text
matrix into the unrotated page space.
"""

from __future__ import annotations

import io
import math
from dataclasses import dataclass, field

from pypdf import PdfReader, PdfWriter
from pypdf.annotations import Link
from pypdf.generic import Fit

from ingest_worker.symbol_fonts import SYMBOL


@dataclass
class Run:
    text: str
    x: float
    y: float
    size: float = 11
    font: str = "Helvetica"
    invisible: bool = False
    rise: float = 0
    #: The way the run reads on the displayed page, in degrees anticlockwise: 90 runs upward.
    angle: int = 0
    #: How much the run's matrix scales its font: drawn at `size`, with a font of `size / scale`.
    scale: float = 1
    #: A box (x0, y0, x1, y1), displayed, the run is clipped to.
    clip: tuple[float, float, float, float] | None = None


@dataclass
class Img:
    x: float
    y: float
    w: float
    h: float


@dataclass
class Page:
    runs: list[Run] = field(default_factory=list)
    images: list[Img] = field(default_factory=list)
    size: tuple[float, float] = (595, 842)
    rotate: int = 0
    #: Ruling lines as (x0, y0, x1, y1).
    lines: list[tuple[float, float, float, float]] = field(default_factory=list)


_FONTS = ("Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Symbol")
_SYMBOL_BYTES = {char: code for code, char in SYMBOL.items()}


class _Space:
    """Displayed (top-left origin) coordinates to the unrotated page space."""

    def __init__(self, size: tuple[float, float], rotate: int) -> None:
        self.w, self.h = size
        # (a, b) is where displayed +x points in page space, (c, d) where displayed "up" does.
        self.matrix = {0: (1, 0, 0, 1), 90: (0, 1, -1, 0), 180: (-1, 0, 0, -1), 270: (0, -1, 1, 0)}[
            rotate
        ]
        self.rotate = rotate

    def point(self, x: float, y: float) -> tuple[float, float]:
        w, h = self.w, self.h
        return {
            0: (x, h - y),
            90: (y, x),
            180: (w - x, y),
            270: (w - y, h - x),
        }[self.rotate]


def _pdf_string(text: str, font: str) -> bytes:
    if font == "Symbol":
        raw = bytes(_SYMBOL_BYTES.get(c, ord(c) & 0xFF) for c in text)
    else:
        raw = text.encode("cp1252")
    escaped = raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")
    return b"(" + escaped + b")"


def _num(value: float) -> bytes:
    return f"{value:.4f}".encode()


def _content(page: Page) -> bytes:
    space = _Space(page.size, page.rotate)
    a, b, c, d = space.matrix
    out: list[bytes] = []
    for n, img in enumerate(page.images):
        ux, uy = space.point(img.x, img.y + img.h)
        cm = (img.w * a, img.w * b, img.h * c, img.h * d, ux, uy)
        out.append(b"q " + b" ".join(_num(v) for v in cm) + f" cm /Im{n} Do Q".encode())
    for x0, y0, x1, y1 in page.lines:
        p0, p1 = space.point(x0, y0), space.point(x1, y1)
        out.append(
            b"0.5 w %s m %s l S"
            % (
                b" ".join(_num(v) for v in p0),
                b" ".join(_num(v) for v in p1),
            )
        )
    for run in page.runs:
        ux, uy = space.point(run.x, run.y)
        cos, sin = (
            round(math.cos(math.radians(run.angle))),
            round(math.sin(math.radians(run.angle))),
        )
        # the run's direction and its glyphs' up, displayed (y down), then in page space
        (rx, ry), (vx, vy) = (cos, -sin), (-sin, -cos)
        k = run.scale
        tm = b" ".join(
            _num(v)
            for v in (
                k * (rx * a - ry * c),
                k * (rx * b - ry * d),
                k * (vx * a - vy * c),
                k * (vx * b - vy * d),
                ux,
                uy,
            )
        )
        text = b"BT /F%d %s Tf %d Tr %s Ts %s Tm %s Tj ET" % (
            _FONTS.index(run.font),
            _num(run.size / run.scale),
            3 if run.invisible else 0,
            _num(run.rise),
            tm,
            _pdf_string(run.text, run.font),
        )
        if run.clip is not None:
            (px0, py0), (px1, py1) = space.point(*run.clip[:2]), space.point(*run.clip[2:])
            box = (min(px0, px1), min(py0, py1), abs(px1 - px0), abs(py1 - py0))
            text = b"q %s re W n %s Q" % (b" ".join(_num(v) for v in box), text)
        out.append(text)
    return b"\n".join(out)


def _raw_pdf(pages: list[Page]) -> bytes:
    """The document as raw objects: 1 catalog, 2 page tree, 3.. fonts and an image, then pages."""
    objects: list[bytes] = [b"", b""]  # filled in once the page ids are known
    font_ids = []
    for name in _FONTS:
        encoding = b"" if name == "Symbol" else b" /Encoding /WinAnsiEncoding"
        objects.append(
            b"<< /Type /Font /Subtype /Type1 /BaseFont /%s%s >>" % (name.encode(), encoding)
        )
        font_ids.append(len(objects))
    objects.append(
        b"<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray "
        b"/BitsPerComponent 8 /Length 1 >>\nstream\n\x80\nendstream"
    )
    image_id = len(objects)
    fonts = b" ".join(b"/F%d %d 0 R" % (i, oid) for i, oid in enumerate(font_ids))
    page_ids = []
    for page in pages:
        content = _content(page)
        objects.append(b"<< /Length %d >>\nstream\n%s\nendstream" % (len(content), content))
        content_id = len(objects)
        images = b" ".join(b"/Im%d %d 0 R" % (n, image_id) for n in range(len(page.images)))
        w, h = page.size
        objects.append(
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %s %s] /Rotate %d "
            b"/Resources << /Font << %s >> /XObject << %s >> >> /Contents %d 0 R >>"
            % (_num(w), _num(h), page.rotate, fonts, images, content_id)
        )
        page_ids.append(len(objects))
    kids = b" ".join(b"%d 0 R" % i for i in page_ids)
    objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (kids, len(page_ids))

    out = io.BytesIO()
    out.write(b"%PDF-1.7\n")
    offsets = []
    for number, body in enumerate(objects, start=1):
        offsets.append(out.tell())
        out.write(b"%d 0 obj\n%s\nendobj\n" % (number, body))
    xref = out.tell()
    out.write(b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1))
    for offset in offsets:
        out.write(b"%010d 00000 n \n" % offset)
    out.write(
        b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    )
    return out.getvalue()


def make_pdf(
    pages: list[Page],
    *,
    outline: list[tuple[int, str, int, float | None]] = (),  # type: ignore[assignment]
    password: str | None = None,
    info: dict[str, str] | None = None,
    links: list[tuple[int, tuple[float, float, float, float], str]] = (),  # type: ignore[assignment]
) -> bytes:
    """A PDF of `pages`.

    An outline entry is (level from 1, title, page index, top in points from the page top or
    None); a link is (page index, (x0, y0, x1, y1) from the page's top left, uri).
    """
    data = _raw_pdf(pages)
    if not (outline or password or info or links):
        return data
    writer = PdfWriter(clone_from=PdfReader(io.BytesIO(data)))
    if info:
        writer.add_metadata(info)
    for index, (x0, y0, x1, y1), uri in links:
        _w, h = pages[index].size
        writer.add_annotation(index, Link(rect=(x0, h - y1, x1, h - y0), url=uri))
    parents: list[object] = []  # parents[level - 1] is the open item of that level
    for level, title, index, top in outline:
        fit = Fit.xyz(top=pages[index].size[1] - top) if top is not None else Fit.fit()
        item = writer.add_outline_item(
            title, index, parent=parents[level - 2] if level > 1 else None, fit=fit
        )
        del parents[level - 1 :]
        parents.append(item)
    if password is not None:
        writer.encrypt(password, algorithm="AES-256")
    out = io.BytesIO()
    writer.write(out)
    return out.getvalue()
