"""The PDF reader (spec docs/superpowers/specs/2026-10-26-pdf-reader-design.md).

`decompose_pdf` runs the whole pipeline: the text layer is read and the pages are classified,
Docling's layout is fetched in chunks of pages, the text layer's chars are put into its items,
furniture and contents are dropped, headings are found, tables split across pages are joined, the
document is built, its report is ordered, and it is checked against the text layer before it is
returned.
"""

from __future__ import annotations

from ingest_worker.decompose import Decomposition, in_document_order
from ingest_worker.decompose.package import DecompositionFailed
from ingest_worker.decompose.pdf.build import build_document, pdf_properties
from ingest_worker.decompose.pdf.crop import PageCropper, PdfiumCropper
from ingest_worker.decompose.pdf.fidelity import check_pdf
from ingest_worker.decompose.pdf.furniture import drop_furniture, dropped_flag
from ingest_worker.decompose.pdf.layout import LayoutAnalyser, analyse_document
from ingest_worker.decompose.pdf.outline import assign_headings, read_bookmarks
from ingest_worker.decompose.pdf.pieces import attach_text
from ingest_worker.decompose.pdf.tables import join_split_tables
from ingest_worker.decompose.pdf.textlayer import read_text_layer

__all__ = ["MAX_PAGES", "PDF_READER_VERSION", "decompose_pdf"]

#: The PDF reader's version, part of the decomposer version for a PDF.
PDF_READER_VERSION = 1

#: A PDF with more pages fails (spec section 10).
MAX_PAGES = 500


def decompose_pdf(
    data: bytes, *, layout: LayoutAnalyser, cropper: PageCropper | None = None, chunk: int = 20
) -> Decomposition:
    """Decompose a born-digital PDF, its layout from `layout`, `chunk` pages a request.

    Pictures and formulas are cropped through `cropper` (by default the PDF's own pages,
    rendered by pdfium). Raises `DecompositionRejected` when the PDF can't be opened,
    `DecompositionFailed` when it has too many pages or a scanned page, or its document fails
    its checks, and `LayoutUnavailable` when the layout service can't answer.
    """
    text = read_text_layer(data)
    pages = len(text.pages)
    if pages > MAX_PAGES:
        raise DecompositionFailed(f"the PDF has {pages} pages; the limit is {MAX_PAGES}")
    scanned = next((p for p in text.pages if p.kind == "scanned"), None)
    if scanned is not None:
        raise DecompositionFailed(
            f"page {scanned.index + 1} is scanned; scanned pages are not read yet"
        )
    layout_doc = analyse_document(layout, data, pages, chunk=chunk)
    pieces, ledger = attach_text(layout_doc, text)
    pieces, dropped, header_fields = drop_furniture(pieces, text, ledger)
    pieces, flags = assign_headings(pieces, read_bookmarks(data), ledger)
    pieces = join_split_tables(pieces, text, ledger)
    own_cropper = None
    if cropper is None:
        cropper = own_cropper = PdfiumCropper(data)
    try:
        doc, image_bytes, provenance = build_document(
            pieces,
            text=text,
            ledger=ledger,
            cropper=cropper,
            properties=[*pdf_properties(data), *header_fields],
            flags=flags,
        )
    finally:
        if own_cropper is not None:
            own_cropper.close()
    summary = dropped_flag(dropped)
    report = [*([summary] if summary is not None else []), *in_document_order(doc.report, doc)]
    doc = doc.model_copy(update={"report": report})
    check_pdf(doc, ledger, text, provenance)
    return Decomposition(document=doc, image_bytes=image_bytes, originals={})
