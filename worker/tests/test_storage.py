from __future__ import annotations

from ingest_worker.storage import MemoryObjectStore


def test_get_optional_returns_none_for_missing_objects() -> None:
    store = MemoryObjectStore()
    assert store.get_optional("b", "k") is None
    store.put("b", "k", b"x", "text/plain")
    assert store.get_optional("b", "k") == b"x"
