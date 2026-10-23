from __future__ import annotations

import io
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
    package = open_package(_zip({"word/document.xml": b"x" * 5000}))
    package._infos["word/document.xml"].file_size = 10
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
