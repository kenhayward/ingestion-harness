"""A PDF rendered to an image-only PDF: every page a picture of itself, no text layer (spec
section 15.5). The twins' PDFs, rasterised, go through the scanned route and are scored against
their Word files, so the OCR route is measured on documents whose answer is known."""

from __future__ import annotations

import io

_POINTS_PER_INCH = 72


def rasterise_pdf(data: bytes, dpi: int = 200) -> bytes:
    """`data`'s pages rendered at `dpi`, as displayed (`/Rotate` applied), in a new PDF whose
    pages have the same sizes."""
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(data)
    try:
        images = []
        for index in range(len(doc)):
            page = doc[index]
            try:
                images.append(page.render(scale=dpi / _POINTS_PER_INCH).to_pil().convert("RGB"))
            finally:
                page.close()
    finally:
        doc.close()
    out = io.BytesIO()
    first, *rest = images
    first.save(out, format="PDF", resolution=float(dpi), save_all=True, append_images=rest)
    return out.getvalue()
