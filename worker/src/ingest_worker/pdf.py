from __future__ import annotations

import io
from collections.abc import Callable

from pypdf import PdfReader

#: Turns PDF bytes into one text string per page. Injected so tests needn't build real PDFs.
TextExtractor = Callable[[bytes], list[str]]


def extract_pages(pdf: bytes) -> list[str]:
    """Text layer extraction. Scanned (image-only) PDFs yield empty pages — see docs/architecture.md."""
    reader = PdfReader(io.BytesIO(pdf))
    return [page.extract_text(extraction_mode="layout") or "" for page in reader.pages]
