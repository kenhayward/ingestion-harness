"""Word (.docx) sources: detection, the Gotenberg adapter and load_source (with fakes)."""

from __future__ import annotations

import io
import zipfile

import httpx
import pytest

from ingest_worker.convert import (
    DOCX_MIME,
    ConversionRejected,
    ConverterUnavailable,
    GotenbergConverter,
    is_docx,
)

MAIN = "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
MACRO = "application/vnd.ms-word.document.macroEnabled.main+xml"
TEMPLATE = "application/vnd.openxmlformats-officedocument.wordprocessingml.template.main+xml"


def word_zip(main_type: str | None = MAIN, *, padding: int = 0) -> bytes:
    """A minimal OOXML package whose /word/document.xml has `main_type` (None: no types)."""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        if main_type is not None:
            z.writestr(
                "[Content_Types].xml",
                '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/'
                '2006/content-types"><Override PartName="/word/document.xml" '
                f'ContentType="{main_type}"/>' + " " * padding + "</Types>",
            )
        z.writestr("word/document.xml", "<w:document/>")
    return out.getvalue()


DOCX = word_zip()


@pytest.mark.parametrize(
    ("data", "expected"),
    [
        (DOCX, True),
        (word_zip(MACRO), False),
        (word_zip(TEMPLATE), False),
        (word_zip(None), False),
        (word_zip(MAIN, padding=1_100_000), False),
        (b"PK\x03\x04truncated", False),
        (b"%PDF-1.7\n", False),
        (b"", False),
        (bytes(range(256)) * 4, False),
    ],
    ids=["docx", "docm", "dotx", "no-types", "huge-types", "truncated", "pdf", "empty", "random"],
)
def test_is_docx(data: bytes, expected: bool) -> None:
    assert is_docx(data) is expected


def gotenberg(handler: httpx.MockTransport) -> GotenbergConverter:
    return GotenbergConverter("http://converter:3000/", client=httpx.Client(transport=handler))


def test_gotenberg_posts_the_document_and_returns_the_pdf() -> None:
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=b"%PDF-1.7 converted")

    assert gotenberg(httpx.MockTransport(handle)).to_pdf(DOCX) == b"%PDF-1.7 converted"
    [request] = seen
    assert request.method == "POST"
    assert str(request.url) == "http://converter:3000/forms/libreoffice/convert"
    body = request.read()
    assert b'name="files"; filename="document.docx"' in body
    assert f"Content-Type: {DOCX_MIME}".encode() in body
    assert DOCX in body


@pytest.mark.parametrize(
    ("status", "body"),
    [
        (200, b"<html>not a pdf</html>"),
        (400, b"Invalid form data: no form file found for extensions"),
        (500, b"LibreOffice failed to convert the document 'document.docx'. This is usually..."),
    ],
    ids=["200-not-pdf", "400", "500-libreoffice-failed"],
)
def test_gotenberg_rejections(status: int, body: bytes) -> None:
    converter = gotenberg(httpx.MockTransport(lambda _r: httpx.Response(status, content=body)))
    with pytest.raises(ConversionRejected):
        converter.to_pdf(DOCX)


def _raise(exc: Exception) -> httpx.MockTransport:
    def handle(_request: httpx.Request) -> httpx.Response:
        raise exc

    return httpx.MockTransport(handle)


@pytest.mark.parametrize(
    "transport",
    [
        httpx.MockTransport(lambda _r: httpx.Response(503, content=b"Service Unavailable")),
        httpx.MockTransport(lambda _r: httpx.Response(500, content=b"Internal Server Error")),
        _raise(httpx.ConnectError("refused")),
        _raise(httpx.ReadTimeout("slow")),
    ],
    ids=["503", "500-other", "connect", "timeout"],
)
def test_gotenberg_outages_are_transient(transport: httpx.MockTransport) -> None:
    with pytest.raises(ConverterUnavailable):
        gotenberg(transport).to_pdf(DOCX)


def test_gotenberg_fingerprint_reads_the_version_once() -> None:
    calls: list[str] = []

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(request.url.path)
        return httpx.Response(200, content=b"8.37.0\n")

    converter = gotenberg(httpx.MockTransport(handle))
    assert converter.fingerprint() == "gotenberg-8.37.0-c1"
    assert converter.fingerprint() == "gotenberg-8.37.0-c1"
    assert calls == ["/version"]


def test_gotenberg_fingerprint_outage_is_transient() -> None:
    with pytest.raises(ConverterUnavailable):
        gotenberg(_raise(httpx.ConnectError("refused"))).fingerprint()
