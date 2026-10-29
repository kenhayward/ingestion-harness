"""The PDF reader (spec docs/superpowers/specs/2026-10-26-pdf-reader-design.md).

`decompose_pdf` runs the whole pipeline: the text layer is read and the pages are classified,
Docling's layout is fetched in chunks of pages, the scanned pages are transcribed by the OCR
model and laid out on a synthetic text layer (scanned.py), the text layer's chars are put into
Docling's items on the born-digital pages, furniture and contents are dropped, headings are
found, tables split across pages are joined, the document is built, its report is ordered, and
its born-digital pages are checked against the text layer before it is returned.
"""

from __future__ import annotations

from dataclasses import replace

from ingest_worker.decompose import Decomposition, in_document_order
from ingest_worker.decompose.package import DecompositionFailed
from ingest_worker.decompose.pdf.build import build_document, pdf_properties
from ingest_worker.decompose.pdf.bullets import bullets_from_pictures
from ingest_worker.decompose.pdf.crop import PageCropper, PdfiumCropper, RotatedCropper
from ingest_worker.decompose.pdf.drawn import tables_from_drawings
from ingest_worker.decompose.pdf.fidelity import check_pdf
from ingest_worker.decompose.pdf.furniture import (
    Dropped,
    drop_furniture,
    dropped_flag,
    line_number_margins,
)
from ingest_worker.decompose.pdf.layout import (
    LayoutAnalyser,
    LayoutDoc,
    LayoutPicture,
    analyse_document,
)
from ingest_worker.decompose.pdf.outline import assign_headings, read_bookmarks
from ingest_worker.decompose.pdf.pieces import Ledger, Piece, attach_text
from ingest_worker.decompose.pdf.scanned import (
    RecognisedPage,
    drop_scanned_furniture,
    normalise_levels,
    recognise_page,
)
from ingest_worker.decompose.pdf.tables import join_split_tables
from ingest_worker.decompose.pdf.textlayer import (
    PageText,
    TextLayer,
    left_out_flags,
    read_text_layer,
)
from ingest_worker.decompose.pdf.transcript import PageTranscriber, parse_transcript

__all__ = ["MAX_PAGES", "PDF_READER_VERSION", "decompose_pdf"]

#: The PDF reader's version, part of the decomposer version for a PDF.
PDF_READER_VERSION = 10

#: A PDF with more pages fails (spec section 10).
MAX_PAGES = 500

#: What a PDF with a scanned page and no OCR model fails with (spec 15.1).
NO_OCR = "page {page} is scanned and this CT Studio has no OCR model"


def decompose_pdf(
    data: bytes,
    *,
    layout: LayoutAnalyser,
    transcriber: PageTranscriber | None = None,
    cropper: PageCropper | None = None,
    chunk: int = 20,
    ocr_longest_dim: int = 1288,
) -> Decomposition:
    """Decompose a PDF, its layout from `layout`, `chunk` pages a request, its scanned pages
    transcribed by `transcriber` from images `ocr_longest_dim` pixels on their longest side.

    Pictures and formulas are cropped through `cropper` (by default the PDF's own pages,
    rendered by pdfium). Raises `DecompositionRejected` when the PDF can't be opened,
    `DecompositionFailed` when it has too many pages, a scanned page and no transcriber, or its
    document fails its checks (a `TranscriptionFailed` when the OCR model can't read a page),
    and `LayoutUnavailable` when the layout service can't answer.
    """
    text = read_text_layer(data)
    pages = len(text.pages)
    if pages > MAX_PAGES:
        raise DecompositionFailed(f"the PDF has {pages} pages; the limit is {MAX_PAGES}")
    scanned = [p for p in text.pages if p.kind == "scanned"]
    if scanned and transcriber is None:
        # Without the OCR model, a page with some visible text over a scan keeps that text (spec
        # 15.2's second rule needs the model); only a page with none can't be read at all.
        if blank := next((p for p in scanned if not p.visible_words), None):
            raise DecompositionFailed(NO_OCR.format(page=blank.index + 1))
        keep = {p.index for p in scanned}
        text = TextLayer(
            tuple(replace(p, keep_text=True) if p.index in keep else p for p in text.pages),
            text.unmapped_symbols,
        )
        scanned = []
    margins = line_number_margins(text)
    layout_doc = analyse_document(layout, data, pages, chunk=chunk, margins=margins)
    layout_doc = tables_from_drawings(layout_doc, text)
    layout_doc = bullets_from_pictures(layout_doc, text)
    recognised: dict[int, RecognisedPage] = {}
    scanned_furniture: dict[int, int] = {}
    rotations: dict[int, int] = {}
    if scanned:
        assert transcriber is not None
        recognised, scanned_furniture, rotations = _recognise(
            scanned, layout_doc, transcriber, ocr_longest_dim
        )
        text = TextLayer(
            tuple(recognised[p.index].page if p.index in recognised else p for p in text.pages),
            text.unmapped_symbols,
        )
    pieces, ledger = attach_text(layout_doc, text)
    pieces = _splice(pieces, recognised, ledger)
    pieces, dropped, header_fields = drop_furniture(pieces, text, ledger)
    dropped = _with_scanned(dropped, scanned_furniture)
    pieces, flags = assign_headings(pieces, read_bookmarks(data), ledger)
    pieces = join_split_tables(pieces, text, ledger)
    own_cropper = None
    if cropper is None:
        cropper = own_cropper = PdfiumCropper(data)
    if rotations:
        cropper = RotatedCropper(cropper, rotations)
    scanned_flags = [f for page in sorted(recognised) for f in recognised[page].flags]
    try:
        doc, image_bytes, provenance = build_document(
            pieces,
            text=text,
            ledger=ledger,
            cropper=cropper,
            properties=[*pdf_properties(data), *header_fields],
            flags=[*flags, *(f for f in scanned_flags if f.at is not None)],
        )
    finally:
        if own_cropper is not None:
            own_cropper.close()
    summary = dropped_flag(dropped)
    report = [
        *([summary] if summary is not None else []),
        *left_out_flags(text),
        *(f for f in scanned_flags if f.at is None),
        *in_document_order(doc.report, doc),
    ]
    doc = doc.model_copy(update={"report": report})
    unproven = check_pdf(doc, ledger, text, provenance)
    page_map = {
        element: sorted(p + 1 for p in pages) for element, pages in provenance.pages.items()
    }
    return Decomposition(
        document=doc, image_bytes=image_bytes, originals={}, page_map=page_map, unproven=unproven
    )


def _render_px(page: PageText, longest_dim: int, rotation: int) -> tuple[int, int]:
    """The size of the image the OCR client sent for `page` (`ocr.render_page_png`)."""
    scale = longest_dim / max(page.width, page.height)
    size = (round(page.width * scale), round(page.height * scale))
    return (size[1], size[0]) if rotation % 180 else size


def _recognise(
    scanned: list[PageText],
    layout_doc: LayoutDoc,
    transcriber: PageTranscriber,
    longest_dim: int,
) -> tuple[dict[int, RecognisedPage], dict[int, int], dict[int, int]]:
    """The scanned pages read through the OCR model (spec 15.3): each page's pieces, the
    furniture lines dropped per page, and the pages the OCR client turned, by its degrees."""
    transcripts = transcriber.transcribe([p.index for p in scanned])
    blocks = {
        p.index: parse_transcript(transcripts[p.index].markdown if p.index in transcripts else "")
        for p in scanned
    }
    blocks, dropped = drop_scanned_furniture(normalise_levels(blocks))
    rotations = {
        p.index: transcripts[p.index].rotation % 360
        for p in scanned
        if p.index in transcripts and transcripts[p.index].rotation % 360
    }
    pictures: dict[int, list[LayoutPicture]] = {}
    for item in layout_doc.items:
        if isinstance(item, LayoutPicture):
            pictures.setdefault(item.page, []).append(item)
    recognised = {
        p.index: recognise_page(
            p,
            blocks[p.index],
            pictures.get(p.index, []),
            rotation=rotations.get(p.index, 0),
            render_px=_render_px(p, longest_dim, rotations.get(p.index, 0)),
            left_out_words=p.left_out_words,
        )
        for p in scanned
    }
    return recognised, dropped, rotations


def _chars_of(piece: Piece) -> list[tuple[int, int]]:
    lines = list(piece.lines)
    for cell_lines in (piece.cells or {}).values():
        lines.extend(cell_lines)
    return [(line.page, c.index) for line in lines for c in line.chars]


def _splice(
    pieces: list[Piece], recognised: dict[int, RecognisedPage], ledger: Ledger
) -> list[Piece]:
    """The scanned pages' pieces put among the born-digital ones in page order, each page whole
    (spec 15.3), their chars owned in the ledger."""
    pending = sorted(recognised.items())
    for _, page in pending:
        for piece in page.pieces:
            for number, index in _chars_of(piece):
                ledger.own(number, index, piece.ref)
    out: list[Piece] = []
    for piece in pieces:
        while pending and pending[0][0] < piece.page:
            out.extend(pending.pop(0)[1].pieces)
        out.append(piece)
    for _, page in pending:
        out.extend(page.pieces)
    return out


def _with_scanned(dropped: Dropped, scanned: dict[int, int]) -> Dropped:
    """The furniture dropped from the scanned pages counted in the summary (spec 15.3)."""
    if not scanned:
        return dropped
    furniture = dict(dropped.furniture)
    for page, n in scanned.items():
        furniture[page] = furniture.get(page, 0) + n
    return replace(dropped, furniture=dict(sorted(furniture.items())))
