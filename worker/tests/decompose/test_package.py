from __future__ import annotations

import io
import warnings
import zipfile

import pytest

from ingest_worker.decompose import DecompositionFailed, DecompositionRejected
from ingest_worker.decompose import package as pkg
from ingest_worker.decompose.package import open_package, parse_xml
from tests.decompose.docx import build_docx

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"


def _zip(parts: dict[str, bytes | str]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in parts.items():
            zf.writestr(name, data)
    return buf.getvalue()


def test_builder_round_trips() -> None:
    package = open_package(build_docx(body="<w:p><w:r><w:t>Hi</w:t></w:r></w:p>"))
    root = package.xml("word/document.xml")
    assert root is not None
    assert [t.text for t in root.iter(f"{W}t")] == ["Hi"]
    assert package.part("word/missing.xml") is None
    assert package.xml("word/missing.xml") is None


def test_rels_and_target() -> None:
    package = open_package(
        build_docx(
            body="<w:p/>",
            media={"a.png": b"png"},
            rels=[("rIdImg", "image", "media/a.png"), ("rIdX", "hyperlink", "http://x")],
        )
    )
    assert package.rels("word/document.xml")["rIdImg"].type.endswith("/image")
    assert package.target("word/document.xml", "rIdImg") == "word/media/a.png"
    assert package.target("word/document.xml", "nope") is None
    assert package.part("word/media/a.png") == b"png"


def test_rejects_oversize_part(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pkg, "MAX_PART_BYTES", 1000)
    data = _zip({"word/document.xml": b"<a>" + b"x" * 5000 + b"</a>"})
    with pytest.raises(DecompositionRejected):
        open_package(data).part("word/document.xml")


def test_rejects_declared_total_oversize(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pkg, "MAX_TOTAL_BYTES", 1000)
    data = _zip({"word/document.xml": b"x" * 5000})
    with pytest.raises(DecompositionRejected):
        open_package(data)


def test_rejects_understated_size_by_counted_read(monkeypatch: pytest.MonkeyPatch) -> None:
    # A header that understates the real size must still be caught by the counted read.
    monkeypatch.setattr(pkg, "MAX_PART_BYTES", 1000)
    monkeypatch.setattr(pkg, "_CHUNK", 100)

    class LyingZip:
        def infolist(self) -> list[zipfile.ZipInfo]:
            info = zipfile.ZipInfo("word/document.xml")
            info.file_size = 10
            return [info]

        def open(self, info: zipfile.ZipInfo) -> io.BytesIO:
            return io.BytesIO(b"x" * 5000)

    package = pkg.Package(LyingZip())  # type: ignore[arg-type]
    with pytest.raises(DecompositionRejected, match="grew past"):
        package.part("word/document.xml")


def test_rejects_corrupt_deflate_stream() -> None:
    raw = bytearray(_zip({"word/document.xml": b"<a>" + b"hello world " * 200 + b"</a>"}))
    # Scramble the compressed bytes just after the local file header.
    start = 30 + len("word/document.xml") + 4
    for i in range(start, start + 20):
        raw[i] ^= 0xFF
    with pytest.raises(DecompositionRejected):
        open_package(bytes(raw)).part("word/document.xml")


def test_rejects_truncated_part() -> None:
    # zipfile raises EOFError when the compressed stream ends early.
    class TruncatedZip:
        def infolist(self) -> list[zipfile.ZipInfo]:
            return [zipfile.ZipInfo("word/document.xml")]

        def open(self, info: zipfile.ZipInfo) -> io.BytesIO:
            raise EOFError("Compressed file ended before the end-of-stream marker was reached")

    package = pkg.Package(TruncatedZip())  # type: ignore[arg-type]
    with pytest.raises(DecompositionRejected):
        package.part("word/document.xml")


def test_rejects_too_many_parts(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(pkg, "MAX_PARTS", 2)
    data = _zip({"word/document.xml": b"<a/>", "b": b"1", "c": b"2"})
    with pytest.raises(DecompositionRejected):
        open_package(data)


def test_rejects_entity_declaration() -> None:
    body = b'<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>'
    with pytest.raises(DecompositionRejected):
        parse_xml(body)
    package = open_package(_zip({"word/document.xml": body}))
    with pytest.raises(DecompositionRejected):
        package.xml("word/document.xml")


def test_rejects_malformed_xml() -> None:
    with pytest.raises(DecompositionRejected):
        parse_xml(b"<a><b></a>")


def test_rejects_not_a_docx() -> None:
    with pytest.raises(DecompositionRejected):
        open_package(b"%PDF-1.7\n1 0 obj\n")
    with pytest.raises(DecompositionRejected):
        open_package(_zip({"hello.txt": b"hi"}))


def test_decomposition_failed_carries_detail_and_location() -> None:
    exc = DecompositionFailed("bad table", at="s-a#table-1")
    assert (exc.detail, exc.at) == ("bad table", "s-a#table-1")
    assert DecompositionFailed("x").at is None


def _nested(depth: int) -> bytes:
    return ("<a>" * depth + "</a>" * depth).encode()


def test_nesting_is_capped_before_any_walk() -> None:
    assert parse_xml(_nested(pkg.MAX_DEPTH)).tag == "a"
    with pytest.raises(DecompositionRejected, match="document nesting too deep"):
        parse_xml(_nested(pkg.MAX_DEPTH + 1))


def test_rejects_duplicate_part_names() -> None:
    buf = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", UserWarning)  # zipfile warns of the duplicate it writes
        with zipfile.ZipFile(buf, "w") as zf:
            for data in ("<w:document/>", "<w:other/>"):
                zf.writestr("word/document.xml", data)
    with pytest.raises(DecompositionRejected, match="more than once"):
        open_package(buf.getvalue())


def test_relationships_are_parsed_once_per_part(monkeypatch: pytest.MonkeyPatch) -> None:
    package = open_package(build_docx("<w:p/>", rels=[("rIdX", "image", "media/x.png")]))
    parsed: list[bytes] = []
    real = pkg.parse_xml

    def counting(data: bytes) -> object:
        parsed.append(data)
        return real(data)

    monkeypatch.setattr(pkg, "parse_xml", counting)
    for _ in range(3):
        assert package.target("word/document.xml", "rIdX") == "word/media/x.png"
    assert len(parsed) == 1
