"""Word (.docx) sources: detection, the Gotenberg adapter and load_source (with fakes)."""

from __future__ import annotations

import hashlib
import io
import zipfile
from pathlib import Path

import httpx
import pytest

from ingest_worker.convert import (
    DOCX_MIME,
    ConversionRejected,
    ConverterUnavailable,
    GotenbergConverter,
    is_docx,
)
from ingest_worker.llm.registry import ModelRegistry
from ingest_worker.pipeline import Buckets, DocumentError, PipelineDeps, Source, load_source
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore, converted_key

from .fakes import FakeConverter, FakeQueue

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


def types_zip(overrides: str) -> bytes:
    """A package whose [Content_Types].xml holds exactly `overrides`."""
    out = io.BytesIO()
    with zipfile.ZipFile(out, "w") as z:
        z.writestr("[Content_Types].xml", f"<Types>{overrides}</Types>")
        z.writestr("word/document.xml", "<w:document/>")
    return out.getvalue()


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
        (types_zip(f"<Override ContentType='{MAIN}' PartName='/word/document.xml'/>"), True),
        (types_zip(f'<Override PartName="/word/other.xml" ContentType="{MAIN}"/>'), False),
    ],
    ids=[
        "docx",
        "docm",
        "dotx",
        "no-types",
        "huge-types",
        "truncated",
        "pdf",
        "empty",
        "random",
        "attribute-order",
        "main-type-elsewhere",
    ],
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


# --- load_source: what the pipeline reads from the inbox ---------------------------------


def source_deps(
    specs_dir: Path, data: bytes, converter: FakeConverter | None
) -> tuple[PipelineDeps, ClaimedJob]:
    store = MemoryObjectStore()
    store.put("inbox", "letter/v1/doc-w.docx", data, DOCX_MIME)
    deps = PipelineDeps(
        store=store,
        specs=load_specs(specs_dir),
        models=ModelRegistry({}, {}, {}),
        extract_text=lambda _pdf: ["text"],
        buckets=Buckets("inbox", "outputs", "runs"),
        converter=converter,
    )
    job = ClaimedJob(
        id="job-w",
        document_id="doc-w",
        spec_id="letter",
        spec_version=1,
        bucket="inbox",
        object_key="letter/v1/doc-w.docx",
        model_override=None,
        attempts=1,
        max_attempts=3,
    )
    return deps, job


SHA = hashlib.sha256(DOCX).hexdigest()


def test_a_pdf_is_passed_through_without_converting(fixture_specs_dir: Path) -> None:
    converter = FakeConverter()
    deps, job = source_deps(fixture_specs_dir, b"%PDF-1.7 original", converter)
    source = load_source(job, deps, FakeQueue())
    assert source == Source(
        data=b"%PDF-1.7 original",
        sha256=hashlib.sha256(b"%PDF-1.7 original").hexdigest(),
        kind="pdf",
        pdf=b"%PDF-1.7 original",
    )
    assert converter.calls == []


def test_a_docx_is_converted_once_and_cached_by_its_sha(fixture_specs_dir: Path) -> None:
    converter = FakeConverter()
    deps, job = source_deps(fixture_specs_dir, DOCX, converter)
    queue = FakeQueue()

    first = load_source(job, deps, queue)
    assert first == Source(data=DOCX, sha256=SHA, kind="docx", pdf=b"%PDF-converted")
    assert deps.store.get("runs", converted_key(SHA, "fake-1")) == b"%PDF-converted"
    assert converted_key(SHA, "fake-1") == f"converted/{SHA}/fake-1.pdf"

    second = load_source(job, deps, queue)
    assert second == first
    assert converter.calls == [DOCX]
    converted = [d for _, _, msg, d in queue.event_details if msg == "converted"]
    assert [c["cached"] for c in converted] == [False, True]
    assert converted[0]["converter"] == "fake-1"


def test_a_corrupt_cache_entry_is_converted_again(fixture_specs_dir: Path) -> None:
    converter = FakeConverter()
    deps, job = source_deps(fixture_specs_dir, DOCX, converter)
    deps.store.put("runs", converted_key(SHA, "fake-1"), b"junk", "application/pdf")
    assert load_source(job, deps, FakeQueue()).pdf == b"%PDF-converted"
    assert deps.store.get("runs", converted_key(SHA, "fake-1")) == b"%PDF-converted"
    assert len(converter.calls) == 1


def test_another_converter_version_converts_again(fixture_specs_dir: Path) -> None:
    converter = FakeConverter()
    deps, job = source_deps(fixture_specs_dir, DOCX, converter)
    load_source(job, deps, FakeQueue())
    converter.version = "fake-2"
    load_source(job, deps, FakeQueue())
    assert len(converter.calls) == 2


def test_a_docx_without_a_converter_needs_configuration(fixture_specs_dir: Path) -> None:
    deps, job = source_deps(fixture_specs_dir, DOCX, None)
    with pytest.raises(DocumentError, match="set CONVERTER_URL"):
        load_source(job, deps, FakeQueue())


def test_a_rejected_document_is_a_document_error(fixture_specs_dir: Path) -> None:
    converter = FakeConverter(error=ConversionRejected("500: LibreOffice failed to convert"))
    deps, job = source_deps(fixture_specs_dir, DOCX, converter)
    with pytest.raises(DocumentError, match="could not convert the Word document: 500"):
        load_source(job, deps, FakeQueue())


def test_an_outage_propagates_unchanged(fixture_specs_dir: Path) -> None:
    converter = FakeConverter(error=ConverterUnavailable("converter unreachable"))
    deps, job = source_deps(fixture_specs_dir, DOCX, converter)
    with pytest.raises(ConverterUnavailable):
        load_source(job, deps, FakeQueue())
