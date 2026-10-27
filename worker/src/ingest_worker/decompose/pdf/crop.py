"""Cropping a region of a page to an image, for pictures and formulas (spec section 4.7)."""

from __future__ import annotations

import io
from collections.abc import Mapping
from typing import Protocol

from ingest_worker.decompose.pdf.layout import BBox

#: Print resolution, in dots per inch.
PRINT_DPI = 300
_POINTS_PER_INCH = 72


class PageCropper(Protocol):
    def crop(self, page: int, bbox: BBox) -> bytes:
        """The region `bbox` (points, top-left origin) of 0-based `page`, as a PNG."""
        ...


class PdfiumCropper:
    """Renders page regions of a PDF with pdfium, as the page is displayed (`/Rotate` applied),
    at `dpi` dots per inch."""

    def __init__(self, data: bytes, dpi: int = PRINT_DPI) -> None:
        import pypdfium2 as pdfium

        self._doc = pdfium.PdfDocument(data)
        self._scale = dpi / _POINTS_PER_INCH

    def crop(self, page: int, bbox: BBox) -> bytes:
        handle = self._doc[page]
        try:
            width, height = handle.get_size()  # as displayed
            x0, y0 = max(bbox[0], 0.0), max(bbox[1], 0.0)
            x1, y1 = min(bbox[2], width), min(bbox[3], height)
            # pdfium crops the rendered page by (left, bottom, right, top) amounts
            crop = (x0, height - y1, width - x1, y0)
            bitmap = handle.render(scale=self._scale, crop=crop)
            out = io.BytesIO()
            bitmap.to_pil().save(out, format="PNG")
            return out.getvalue()
        finally:
            handle.close()

    def close(self) -> None:
        self._doc.close()


class RotatedCropper:
    """Crops through `inner`, then turns the crops of a page the OCR client read rotated by the
    same clockwise degrees (spec 15.3): the layout's regions are in the page's own frame."""

    def __init__(self, inner: PageCropper, rotations: Mapping[int, int]) -> None:
        self._inner = inner
        self._rotations = {page: deg % 360 for page, deg in rotations.items() if deg % 360}

    def crop(self, page: int, bbox: BBox) -> bytes:
        png = self._inner.crop(page, bbox)
        degrees = self._rotations.get(page)
        if degrees is None:
            return png
        from PIL import Image

        turned = Image.open(io.BytesIO(png)).rotate(-degrees, expand=True)
        out = io.BytesIO()
        turned.save(out, format="PNG")
        return out.getvalue()
