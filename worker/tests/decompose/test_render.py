"""The renderer: one OOXML object -> one-object .docx -> PDF -> cropped PNG."""

from __future__ import annotations

import io
import zipfile

import pytest
from PIL import Image

from ingest_worker.convert import ConversionRejected, ConverterUnavailable
from ingest_worker.decompose.package import open_package
from ingest_worker.decompose.render import ConverterRenderer, RenderFragment
from tests.decompose.fakes import FakeRenderer

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _pdf_with_box() -> bytes:
    # Bilevel pages are stored losslessly, so the box edges stay sharp.
    page = Image.new("1", (200, 200), 1)
    page.paste(0, (40, 60, 140, 110))  # a 100x50 black box
    buf = io.BytesIO()
    page.save(buf, format="PDF", resolution=72.0)
    return buf.getvalue()


def _blank_pdf() -> bytes:
    buf = io.BytesIO()
    Image.new("1", (200, 200), 1).save(buf, format="PDF", resolution=72.0)
    return buf.getvalue()


class _Converter:
    def __init__(self, pdf: bytes | Exception) -> None:
        self.pdf = pdf
        self.docx: list[bytes] = []

    def to_pdf(self, docx: bytes) -> bytes:
        self.docx.append(docx)
        if isinstance(self.pdf, Exception):
            raise self.pdf
        return self.pdf

    def fingerprint(self) -> str:
        return "fake"


def _fragment(
    body_xml: str = "<w:p><w:r><w:t>object</w:t></w:r></w:p>",
    styles_xml: bytes | None = None,
    parts: dict[str, bytes] | None = None,
    rels: list[tuple[str, str, str]] | None = None,
) -> RenderFragment:
    return RenderFragment(body_xml, 12240, styles_xml, parts or {}, rels or [])


def test_crops_to_content() -> None:
    png = ConverterRenderer(_Converter(_pdf_with_box()), dpi=72).render(_fragment())
    assert png is not None
    size = Image.open(io.BytesIO(png)).size
    assert size == (104, 54)


def test_rejected_conversion_returns_none() -> None:
    renderer = ConverterRenderer(_Converter(ConversionRejected("bad")), dpi=72)
    assert renderer.render(_fragment()) is None


def test_blank_page_returns_none() -> None:
    assert ConverterRenderer(_Converter(_blank_pdf()), dpi=72).render(_fragment()) is None


def test_unavailable_propagates() -> None:
    renderer = ConverterRenderer(_Converter(ConverterUnavailable("down")), dpi=72)
    with pytest.raises(ConverterUnavailable):
        renderer.render(_fragment())


def test_fragment_document_is_valid_package() -> None:
    converter = _Converter(_pdf_with_box())
    fragment = _fragment(
        styles_xml=(
            b'<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>'
        ),
        parts={"word/media/image1.png": b"\x89PNG-bytes"},
        rels=[("rId9", "image", "media/image1.png")],
    )
    ConverterRenderer(converter, dpi=72).render(fragment)
    package = open_package(converter.docx[0])
    root = package.xml("word/document.xml")
    assert root is not None
    assert [t.text for t in root.iter(f"{W}t")] == ["object"]
    assert next(root.iter(f"{W}pgSz")).get(f"{W}w") == "12240"
    margins = next(root.iter(f"{W}pgMar"))
    assert margins.get(f"{W}left") == "0" and margins.get(f"{W}right") == "0"
    assert package.part("word/media/image1.png") == b"\x89PNG-bytes"
    assert package.target("word/document.xml", "rId9") == "word/media/image1.png"
    assert package.part("word/styles.xml") is not None
    with zipfile.ZipFile(io.BytesIO(converter.docx[0])) as z:
        types = z.read("[Content_Types].xml").decode()
    assert 'Extension="png"' in types


def test_fragment_may_use_any_declared_prefix() -> None:
    body = (
        '<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>'
        "<wp:inline><a:graphic><wpg:wgp/></a:graphic></wp:inline></w:drawing></mc:Choice>"
        '<mc:Fallback><w:pict><v:shape o:spid="x"/></w:pict></mc:Fallback>'
        "</mc:AlternateContent></w:r><m:oMath/></w:p>"
    )
    converter = _Converter(_pdf_with_box())
    ConverterRenderer(converter, dpi=72).render(_fragment(body_xml=body))
    assert open_package(converter.docx[0]).xml("word/document.xml") is not None


def test_fake_renderer_records_fragments() -> None:
    fake = FakeRenderer()
    fragment = _fragment()
    png = fake.render(fragment)
    assert png is not None and Image.open(io.BytesIO(png)).size == (10, 10)
    assert fake.fragments == [fragment]
