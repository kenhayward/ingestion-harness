"""Decomposition of source documents into a checked, source-neutral document model.

`decompose_docx` runs the whole Word pipeline: the package is opened, the body, notes and
properties are read, references are resolved, the report is completed and ordered, and the
result is checked against the source before it is returned.
"""

from __future__ import annotations

import re
from collections.abc import Iterator, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal

from ingest_worker.decompose.body import walk_body
from ingest_worker.decompose.fidelity import check
from ingest_worker.decompose.inline import InlineContext, RunStyles
from ingest_worker.decompose.media import MediaContext
from ingest_worker.decompose.model import (
    Block,
    DecomposedDocument,
    EquationBlock,
    Figure,
    Flag,
    ImageBlock,
    Inline,
    InlineEquation,
    InlineImage,
    Link,
    ListBlock,
    Paragraph,
    Section,
    Table,
)
from ingest_worker.decompose.package import (
    NESTING_TOO_DEEP,
    DecompositionFailed,
    DecompositionRejected,
    open_package,
)
from ingest_worker.decompose.properties import properties_of
from ingest_worker.decompose.references import notes_of, resolve_references
from ingest_worker.decompose.render import Renderer

if TYPE_CHECKING:
    from ingest_worker.decompose.pdf.layout import LayoutAnalyser
    from ingest_worker.decompose.pdf.transcript import PageTranscriber

__all__ = [
    "DECOMPOSER_VERSION",
    "NO_LAYOUT",
    "Decomposition",
    "DecompositionFailed",
    "DecompositionRejected",
    "SourceKind",
    "decompose_docx",
    "decompose_source",
    "decomposer_version",
    "source_kind",
]

#: The decomposer's version, sent with a delivered document. It never feeds ids, so an improved
#: decomposer updates the same sections.
DECOMPOSER_VERSION = 1

#: Why a PDF can't be read by a worker without a layout service.
NO_LAYOUT = "this CT Studio has no layout service (LAYOUT_URL)"

SourceKind = Literal["docx", "pdf"]

_ID_PARENT = re.compile(r"^(.*)[#/][^#/]*$")


@dataclass(frozen=True)
class Decomposition:
    """A checked decomposed document with its images' bytes and the originals of converted
    images, both by image id."""

    document: DecomposedDocument
    image_bytes: dict[str, bytes]
    originals: dict[str, bytes]
    #: A PDF's: the 1-based pages each section and block came from, by id (a Word file's is
    #: empty).
    page_map: dict[str, list[int]] = field(default_factory=dict)


def source_kind(data: bytes) -> SourceKind:
    """A PDF has `%PDF-` within its first 1024 bytes; anything else is read as a Word file."""
    return "pdf" if b"%PDF-" in data[:1024] else "docx"


def decomposer_version(kind: SourceKind) -> int:
    """The version sent with a document of this kind: the PDF reader's version is part of a
    PDF's, so improving it updates its documents without touching Word's."""
    if kind == "docx":
        return DECOMPOSER_VERSION
    from ingest_worker.decompose.pdf import PDF_READER_VERSION  # the reader imports this module

    return DECOMPOSER_VERSION * 1000 + PDF_READER_VERSION


def decompose_source(
    data: bytes,
    *,
    renderer: Renderer,
    layout: LayoutAnalyser | None,
    transcriber: PageTranscriber | None = None,
    ocr_longest_dim: int = 1288,
) -> Decomposition:
    """Decompose a Word file or a PDF, by what `data` is. A PDF needs `layout`; without it the
    document fails. A layout service that can't answer raises `LayoutUnavailable`. A PDF's
    scanned pages are read through `transcriber` (the OCR model, its images `ocr_longest_dim`
    pixels on their longest side); without one, a PDF with a scanned page fails."""
    if source_kind(data) == "docx":
        return decompose_docx(data, renderer=renderer)
    from ingest_worker.decompose.pdf import decompose_pdf

    if layout is None:
        raise DecompositionFailed(NO_LAYOUT)
    return decompose_pdf(
        data, layout=layout, transcriber=transcriber, ocr_longest_dim=ocr_longest_dim
    )


def decompose_docx(data: bytes, *, renderer: Renderer) -> Decomposition:
    """Decompose a .docx, rendering drawings, equations and conversions through `renderer`.

    Raises `DecompositionRejected` when the source is unreadable or unsafe, and
    `DecompositionFailed` when it can't be turned into a document that passes its checks. A
    recursion too deep anywhere (parts referring to each other in a loop, say) is a rejection.
    """
    try:
        return _decompose(data, renderer)
    except RecursionError:
        raise DecompositionRejected(NESTING_TOO_DEEP) from None


def _decompose(data: bytes, renderer: Renderer) -> Decomposition:
    pkg = open_package(data)
    media = MediaContext.for_package(pkg, renderer)
    ctx = InlineContext(styles=RunStyles.from_xml(pkg.xml("word/styles.xml")), media=media)
    blocks, sections = walk_body(pkg, ctx)
    notes = notes_of(pkg, ctx)
    properties = properties_of(pkg)
    doc = DecomposedDocument(
        blocks=blocks,
        sections=sections,
        images=media.images,
        equations=media.equations,
        notes=notes,
        properties=properties,
        report=list(ctx.flags),
    )
    doc = resolve_references(doc, ctx)  # appends its own flags to the report
    report = list(doc.report)
    if ctx.changes > 0:
        report.append(
            Flag(
                code="changes_accepted",
                severity="info",
                message=f"{ctx.changes} tracked changes accepted",
            )
        )
    doc = doc.model_copy(update={"report": in_document_order(report, doc)})
    check(doc, pkg, ctx)
    return Decomposition(
        document=doc, image_bytes=dict(media.image_bytes), originals=dict(media.originals)
    )


# --- The report's order ----------------------------------------------------------------------


def in_document_order(flags: Sequence[Flag], doc: DecomposedDocument) -> list[Flag]:
    """`flags` stably sorted by where they apply: flags without a place first, then by the
    position of their element in reading order (body, then notes). A flag at something that is
    not itself an element, such as an image inside a paragraph, sorts with the nearest element
    its id is under; one under no element sorts last."""
    positions: dict[str, int] = {}
    for element_id in _ids(doc):
        positions.setdefault(element_id, len(positions))

    def position(flag: Flag) -> int:
        at = flag.at
        if at is None:
            return -1
        while at not in positions:
            parent = _ID_PARENT.match(at)
            if parent is None:
                return len(positions)
            at = parent.group(1)
        return positions[at]

    return sorted(flags, key=position)


def _ids(doc: DecomposedDocument) -> Iterator[str]:
    """Every section, block, note, image and equation id, in reading order."""
    yield from _block_ids(doc.blocks)
    for section in doc.sections:
        yield from _section_ids(section)
    for note in doc.notes:
        yield note.id
        yield from _block_ids(note.blocks)


def _section_ids(section: Section) -> Iterator[str]:
    yield section.id
    yield from _inline_ids(section.title)
    yield from _block_ids(section.blocks)
    for child in section.sections:
        yield from _section_ids(child)


def _block_ids(blocks: Sequence[Block]) -> Iterator[str]:
    for block in blocks:
        yield block.id
        if isinstance(block, Paragraph):
            yield from _inline_ids(block.inlines)
        elif isinstance(block, ListBlock):
            for item in block.items:
                yield from _block_ids(item.blocks)
        elif isinstance(block, Table):
            yield from _inline_ids(block.caption)
            for row in block.rows:
                for cell in row.cells:
                    yield from _block_ids(cell.blocks)
            for note in block.notes:
                yield from _inline_ids(note.inlines)
        elif isinstance(block, Figure):
            yield block.image_id
            yield from _inline_ids(block.caption)
        elif isinstance(block, EquationBlock):
            yield block.equation_id
        elif isinstance(block, ImageBlock):
            yield block.image_id


def _inline_ids(inlines: Sequence[Inline]) -> Iterator[str]:
    for item in inlines:
        if isinstance(item, InlineImage):
            yield item.image_id
        elif isinstance(item, InlineEquation):
            yield item.equation_id
        elif isinstance(item, Link):
            yield from _inline_ids(item.inlines)
