from __future__ import annotations

from ingest_worker.storage import MemoryObjectStore


def test_get_optional_returns_none_for_missing_objects() -> None:
    store = MemoryObjectStore()
    assert store.get_optional("b", "k") is None
    store.put("b", "k", b"x", "text/plain")
    assert store.get_optional("b", "k") == b"x"


def test_prepared_keys_mirror_the_typescript_helpers() -> None:
    from ingest_worker.storage import prepared_text_key, prepared_triage_key

    assert prepared_text_key("abc") == "prepared/abc/text.json"
    assert prepared_triage_key("abc") == "prepared/abc/triage.json"
