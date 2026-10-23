"""Render one OOXML object (drawing, EMF/WMF picture, equation) to a cropped PNG.

A one-object .docx is built from the fragment, converted to PDF by the worker's document
converter (LibreOffice behind Gotenberg), and page 1 is rendered and cropped to its content.
The fragment's parts come from the (untrusted) source package and live only in memory.
"""

from __future__ import annotations

import io
import posixpath
from dataclasses import dataclass
from typing import Protocol
from xml.sax.saxutils import quoteattr
from zipfile import ZIP_DEFLATED, ZipFile

from PIL import Image, ImageChops

from ingest_worker.convert import ConversionRejected, DocumentConverter

#: Word's largest page height (22 in), so a tall object is not split across pages.
_PAGE_HEIGHT_TWIPS = 31680
_CROP_MARGIN_PX = 2
#: Pages that would render to more pixels than this are refused (a hostile page size).
_MAX_PIXELS = 100_000_000

_W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
_REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
_PKG_REL = "http://schemas.openxmlformats.org/package/2006/relationships"
_CT = "http://schemas.openxmlformats.org/package/2006/content-types"
_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

#: Every prefix a fragment may use, declared on the document element.
_NAMESPACES = {
    "w": _W,
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "wp": "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "pic": "http://schemas.openxmlformats.org/drawingml/2006/picture",
    "wps": "http://schemas.microsoft.com/office/word/2010/wordprocessingShape",
    "wpg": "http://schemas.microsoft.com/office/word/2010/wordprocessingGroup",
    "wpc": "http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas",
    "mc": "http://schemas.openxmlformats.org/markup-compatibility/2006",
    "v": "urn:schemas-microsoft-com:vml",
    "o": "urn:schemas-microsoft-com:office:office",
    "m": "http://schemas.openxmlformats.org/officeDocument/2006/math",
    "w14": "http://schemas.microsoft.com/office/word/2010/wordml",
    "dgm": "http://schemas.openxmlformats.org/drawingml/2006/diagram",
    "c": "http://schemas.openxmlformats.org/drawingml/2006/chart",
}
_IGNORABLE = "w14 wps wpg wpc"

_MEDIA_TYPES = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "jpeg": "image/jpeg",
    "gif": "image/gif",
    "bmp": "image/bmp",
    "tif": "image/tiff",
    "tiff": "image/tiff",
    "emf": "image/x-emf",
    "wmf": "image/x-wmf",
    "svg": "image/svg+xml",
    "bin": "application/vnd.openxmlformats-officedocument.oleObject",
    "vml": "application/vnd.openxmlformats-officedocument.vmlDrawing",
}
_DIAGRAM_TYPES = {
    "data": "application/vnd.openxmlformats-officedocument.drawingml.diagramData+xml",
    "layout": "application/vnd.openxmlformats-officedocument.drawingml.diagramLayout+xml",
    "quickStyle": "application/vnd.openxmlformats-officedocument.drawingml.diagramStyle+xml",
    "colors": "application/vnd.openxmlformats-officedocument.drawingml.diagramColors+xml",
}
_CHART_TYPE = "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"
_DOCUMENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
_STYLES_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"


@dataclass(frozen=True)
class RenderFragment:
    """One object to render, with what it needs from the source package.

    `parts` maps package paths (as in the source, e.g. `word/media/image1.png`) to bytes.
    `rels` are the document-level relationships the fragment uses, as (id, type, target):
    the type is a full URI or the suffix after `.../relationships/`, and the target is
    relative to `word/` in the new package.
    """

    body_xml: str
    page_width_twips: int
    styles_xml: bytes | None
    parts: dict[str, bytes]
    rels: list[tuple[str, str, str]]


class Renderer(Protocol):
    def render(self, fragment: RenderFragment) -> bytes | None:
        """PNG bytes of the fragment, or None when it could not be rendered."""
        ...


class ConverterRenderer:
    """Renders through the document converter and pypdfium2."""

    def __init__(self, converter: DocumentConverter, dpi: int = 300) -> None:
        self._converter = converter
        self._dpi = dpi

    def render(self, fragment: RenderFragment) -> bytes | None:
        docx = build_fragment_docx(fragment)
        try:
            pdf = self._converter.to_pdf(docx)
        except ConversionRejected:
            return None  # ConverterUnavailable propagates: the whole job is retryable
        page = self._render_first_page(pdf)
        if page is None:
            return None
        return _crop_to_content(page)

    def _render_first_page(self, pdf: bytes) -> Image.Image | None:
        import pypdfium2 as pdfium

        try:
            doc = pdfium.PdfDocument(pdf)
        except pdfium.PdfiumError:
            return None
        try:
            if len(doc) == 0:
                return None
            width, height = doc[0].get_size()
            scale = self._dpi / 72
            if width * scale * height * scale > _MAX_PIXELS:
                return None
            image: Image.Image = doc[0].render(scale=scale).to_pil().convert("RGB")
            return image
        except pdfium.PdfiumError:
            return None
        finally:
            doc.close()


def _crop_to_content(image: Image.Image) -> bytes | None:
    """Crop to the non-white bounding box plus a small margin; None when the page is blank."""
    box = ImageChops.difference(image, Image.new("RGB", image.size, "white")).getbbox()
    if box is None:
        return None
    left, top, right, bottom = box
    cropped = image.crop(
        (
            max(left - _CROP_MARGIN_PX, 0),
            max(top - _CROP_MARGIN_PX, 0),
            min(right + _CROP_MARGIN_PX, image.width),
            min(bottom + _CROP_MARGIN_PX, image.height),
        )
    )
    buf = io.BytesIO()
    cropped.save(buf, format="PNG")
    return buf.getvalue()


def build_fragment_docx(fragment: RenderFragment) -> bytes:
    """A one-object .docx: the source page width, zero margins, the fragment's parts."""
    ns = " ".join(f'xmlns:{p}="{u}"' for p, u in _NAMESPACES.items())
    document = (
        f'{_DECL}<w:document {ns} mc:Ignorable="{_IGNORABLE}"><w:body>{fragment.body_xml}'
        f'<w:sectPr><w:pgSz w:w="{fragment.page_width_twips}" w:h="{_PAGE_HEIGHT_TWIPS}"/>'
        '<w:pgMar w:top="0" w:right="0" w:bottom="0" w:left="0" w:header="0" w:footer="0" '
        'w:gutter="0"/></w:sectPr></w:body></w:document>'
    )
    doc_rels = list(fragment.rels)
    parts: dict[str, bytes] = {"word/document.xml": document.encode("utf-8")}
    if fragment.styles_xml is not None:
        parts["word/styles.xml"] = fragment.styles_xml
        doc_rels.append(("rIdFragStyles", "styles", "styles.xml"))
    for name, data in fragment.parts.items():
        parts.setdefault(name.lstrip("/"), data)

    rel_xml = "".join(
        f"<Relationship Id={quoteattr(rid)} "
        f"Type={quoteattr(typ if '://' in typ else _REL_BASE + typ)} Target={quoteattr(target)}/>"
        for rid, typ, target in doc_rels
    )
    out = io.BytesIO()
    with ZipFile(out, "w", ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", _content_types(parts))
        z.writestr(
            "_rels/.rels",
            f'{_DECL}<Relationships xmlns="{_PKG_REL}"><Relationship Id="rId1" '
            f'Type="{_REL_BASE}officeDocument" Target="word/document.xml"/></Relationships>',
        )
        z.writestr(
            "word/_rels/document.xml.rels",
            f'{_DECL}<Relationships xmlns="{_PKG_REL}">{rel_xml}</Relationships>',
        )
        for name, data in parts.items():
            z.writestr(name, data)
    return out.getvalue()


def _content_types(parts: dict[str, bytes]) -> str:
    defaults = {"rels": "application/vnd.openxmlformats-package.relationships+xml"}
    overrides = {
        "/word/document.xml": _DOCUMENT_TYPE,
        "/word/styles.xml": _STYLES_TYPE,
    }
    for name in parts:
        ext = posixpath.splitext(name)[1].lstrip(".").lower()
        base = posixpath.basename(name)
        if name in ("word/document.xml", "word/styles.xml"):
            continue
        if name.startswith("word/charts/") and ext == "xml":
            overrides[f"/{name}"] = _CHART_TYPE
        elif name.startswith("word/diagrams/") and ext == "xml":
            for kind, ctype in _DIAGRAM_TYPES.items():
                if base.lower().startswith(kind.lower()):
                    overrides[f"/{name}"] = ctype
        elif ext in _MEDIA_TYPES:
            defaults[ext] = _MEDIA_TYPES[ext]
        elif ext == "xml":
            defaults.setdefault("xml", "application/xml")
    body = "".join(f'<Default Extension="{e}" ContentType="{t}"/>' for e, t in defaults.items())
    body += "".join(f'<Override PartName="{n}" ContentType="{t}"/>' for n, t in overrides.items())
    return f'{_DECL}<Types xmlns="{_CT}">{body}</Types>'
