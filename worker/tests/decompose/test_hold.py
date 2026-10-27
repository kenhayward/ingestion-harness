"""A PDF's decomposition held for review (spec §14.3): its images, page JPEGs and manifest in the
runs bucket, read back only when the bytes are the ones held."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace

import pytest

from ingest_worker.bridge.models import ActingUser
from ingest_worker.decompose import Decomposition
from ingest_worker.decompose.hold import HeldMismatch, delete_held, read_held, write_held
from ingest_worker.decompose.items import ConversionItem
from ingest_worker.decompose.pdf import decompose_pdf
from ingest_worker.storage import (
    MemoryObjectStore,
    decomposition_held_image_key,
    decomposition_held_manifest_key,
    decomposition_held_page_key,
)
from tests.decompose.pdf.fakes import two_pages

USER = ActingUser(id="u1", name="Operator", email=None)
ITEM = ConversionItem("i1", "b1", "two-pages.pdf", "decompositions/b1/i1.pdf", "decomposing")
ENTRY = {"id": "e1", "contentSha256": "ab" * 32}


def _page(pdf: bytes, index: int) -> bytes:
    return f"jpeg {index}".encode()


def _decomposed() -> tuple[bytes, Decomposition]:
    data, layout = two_pages()
    return data, decompose_pdf(data, layout=layout)


def _write(store: MemoryObjectStore, data: bytes, result: Decomposition) -> str:
    return write_held(
        store,
        "runs",
        ITEM,
        result,
        data=data,
        decomposer_version=1001,
        started_by=USER,
        entry=ENTRY,
        render_preview=_page,
    )


def test_held_round_trip() -> None:
    store = MemoryObjectStore()
    data, result = _decomposed()
    assert len(result.document.images) == 2

    sha = _write(store, data, result)

    raw = store.get("runs", decomposition_held_manifest_key("b1", "i1"))
    assert sha == hashlib.sha256(raw).hexdigest()
    manifest, held = read_held(store, "runs", replace(ITEM, held_sha256=sha))
    assert held.document == result.document
    assert held.image_bytes == result.image_bytes
    assert held.page_map == result.page_map
    assert manifest.decomposer_version == 1001
    assert manifest.started_by == USER
    assert manifest.page_count == 2
    assert manifest.source_sha256 == hashlib.sha256(data).hexdigest()
    assert store.get("runs", decomposition_held_page_key("b1", "i1", 1)) == b"jpeg 0"
    assert store.get("runs", decomposition_held_page_key("b1", "i1", 2)) == b"jpeg 1"

    key = decomposition_held_image_key("b1", "i1", 0)
    image = bytearray(store.get("runs", key))
    image[0] ^= 0xFF
    store.put("runs", key, bytes(image), "image/png")
    with pytest.raises(HeldMismatch):
        read_held(store, "runs", replace(ITEM, held_sha256=sha))


def test_the_manifest_is_camel_case_as_the_api_reads_it() -> None:
    store = MemoryObjectStore()
    data, result = _decomposed()
    _write(store, data, result)

    manifest = json.loads(store.get("runs", decomposition_held_manifest_key("b1", "i1")))

    assert set(manifest) == {
        "version",
        "sourceSha256",
        "decomposerVersion",
        "startedBy",
        "entry",
        "document",
        "images",
        "pageCount",
        "pageMap",
    }
    assert manifest["version"] == 1
    assert manifest["entry"] == ENTRY
    assert manifest["startedBy"] == {"id": "u1", "name": "Operator", "email": None}
    first = result.document.images[0]
    assert manifest["images"][0] == {
        "id": first.id,
        "key": decomposition_held_image_key("b1", "i1", 0),
        "sha256": hashlib.sha256(result.image_bytes[first.id]).hexdigest(),
        "contentType": first.content_type,
    }
    # Each section and block names the 1-based pages it came from.
    assert manifest["pageMap"] == result.page_map
    assert manifest["pageMap"]["s-1-scope-of-the-plan"] == [1]
    assert all(page in (1, 2) for pages in manifest["pageMap"].values() for page in pages)


def test_a_manifest_that_is_not_the_held_one_is_refused() -> None:
    store = MemoryObjectStore()
    data, result = _decomposed()
    _write(store, data, result)

    with pytest.raises(HeldMismatch):
        read_held(store, "runs", replace(ITEM, held_sha256="00" * 32))


def test_delete_held_removes_everything_and_ignores_what_is_gone() -> None:
    store = MemoryObjectStore()
    data, result = _decomposed()
    _write(store, data, result)
    store.delete("runs", decomposition_held_page_key("b1", "i1", 2))  # gone already

    delete_held(store, "runs", ITEM)

    assert not any(key.startswith("decompositions/b1/i1.held/") for _bucket, key in store.objects)
    delete_held(store, "runs", ITEM)  # nothing left: no error


def test_a_page_that_cannot_be_rendered_leaves_nothing_held() -> None:
    store = MemoryObjectStore()
    data, result = _decomposed()

    def broken(pdf: bytes, index: int) -> bytes:
        if index == 1:
            raise RuntimeError("pdfium could not render page 2")
        return b"jpeg"

    with pytest.raises(RuntimeError, match="page 2"):
        write_held(
            store,
            "runs",
            ITEM,
            result,
            data=data,
            decomposer_version=1001,
            started_by=USER,
            entry=None,
            render_preview=broken,
        )

    assert store.objects == {}
