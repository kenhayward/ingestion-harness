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


def test_segmentation_key_mirrors_the_typescript_helper() -> None:
    from ingest_worker.storage import segmentation_key

    assert segmentation_key("letter", "j1") == "segmentation/letter/j1.json"


def test_delete_removes_an_object_and_tolerates_a_missing_one() -> None:
    store = MemoryObjectStore()
    store.put("b", "k", b"x", "text/plain")
    store.delete("b", "k")
    assert store.get_optional("b", "k") is None
    store.delete("b", "k")


def test_drafting_key_mirrors_the_typescript_helper() -> None:
    from ingest_worker.storage import drafting_key

    assert drafting_key("letter", "j1") == "drafting/letter/j1.json"


def test_draft_log_and_run_keys_mirror_the_typescript_helpers() -> None:
    from ingest_worker.storage import draft_log_key, run_key

    assert draft_log_key("j1") == "j1/draft-log.json"
    assert run_key("j1", "draft-survey", 2) == "j1/draft-survey/attempt-2.json"


def test_export_key_mirrors_the_typescript_helper() -> None:
    from ingest_worker.storage import export_key

    assert export_key("letter", "j1") == "exports/letter/j1.zip"
