"""Cropping a region of a page to an image, for pictures and formulas (spec section 4.7)."""

from __future__ import annotations

from typing import Protocol

from ingest_worker.decompose.pdf.layout import BBox


class PageCropper(Protocol):
    def crop(self, page: int, bbox: BBox) -> bytes:
        """The region `bbox` (points, top-left origin) of 0-based `page`, as a PNG."""
        ...
