"""The register's two checks (spec §8): `decide`, one test per row of its table, and the memory
store's transactions."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

import pytest

from ingest_worker.decompose.deliver import decide
from ingest_worker.decompose.register import MemoryRegisterStore, RegisterEntry

SHA = "a" * 64
NEW_SHA = "b" * 64
AT = datetime(2026, 10, 23, 9, 0, tzinfo=UTC)


def entry(**changes: object) -> RegisterEntry:
    base = RegisterEntry(
        id="e1",
        sink_id="docs",
        instance_id="tenant-1",
        source_key="reports/r1.docx",
        content_sha256=SHA,
        persistent_id="DOC-1",
        state="delivered",
        idempotency_key="k" * 64,
        delivery_id="d1",
        last_receipt=None,
        last_error=None,
        batch_id=None,
        created_at=AT,
        updated_at=AT,
        delivered_at=AT,
    )
    return replace(base, **changes)  # type: ignore[arg-type]


def test_new_file_creates() -> None:
    d = decide(None, [], SHA, force=False)
    assert (d.outcome, d.create, d.entry) == (None, True, None)


def test_same_file_same_key_is_already_loaded() -> None:
    e = entry()
    d = decide(e, [e], SHA, force=False)
    assert (d.outcome, d.entry) == ("already_loaded", e)
    incomplete = entry(state="incomplete")
    assert decide(incomplete, [incomplete], SHA, force=False).outcome == "already_loaded"


def test_force_turns_already_loaded_into_update() -> None:
    e = entry()
    d = decide(e, [e], SHA, force=True)
    assert (d.outcome, d.create, d.entry) == (None, False, e)


def test_same_file_other_key_is_duplicate() -> None:
    other = entry(id="e2", source_key="elsewhere/r1.docx")
    d = decide(None, [other], SHA, force=False)
    assert (d.outcome, d.entry) == ("duplicate", other)
    assert "DOC-1" in d.reason and "elsewhere/r1.docx" in d.reason
    # Under a key with its own (other) content, too: that content is already a document here.
    mine = entry(content_sha256=NEW_SHA, persistent_id="DOC-9")
    assert decide(mine, [other], SHA, force=False).outcome == "duplicate"


def test_force_turns_duplicate_into_create() -> None:
    other = entry(id="e2", source_key="elsewhere/r1.docx")
    d = decide(None, [other], SHA, force=True)
    assert (d.outcome, d.create, d.entry) == (None, True, None)
    # A source of its own is updated, never orphaned by a second create.
    mine = entry(content_sha256=NEW_SHA, persistent_id="DOC-9")
    forced = decide(mine, [other], SHA, force=True)
    assert (forced.outcome, forced.create, forced.entry) == (None, False, mine)


def test_changed_file_same_key_updates() -> None:
    e = entry(content_sha256=NEW_SHA)
    d = decide(e, [], SHA, force=False)
    assert (d.outcome, d.create, d.entry) == (None, False, e)
    # A later run of an incomplete or failed entry with a persistent id is an update too.
    failed = entry(state="failed")
    assert decide(failed, [failed], SHA, force=False).create is False


def test_pending_is_in_flight() -> None:
    e = entry(state="pending", delivery_id=None)
    for force in (False, True):
        assert decide(e, [e], SHA, force=force).outcome == "in_flight"
        assert decide(e, [], NEW_SHA, force=force).outcome == "in_flight"


def test_changed_entry_refuses() -> None:
    e = entry(state="changed")
    for force in (False, True):
        assert decide(e, [e], SHA, force=force).outcome == "changed_in_target"
        assert decide(e, [], NEW_SHA, force=force).outcome == "changed_in_target"


def test_entry_without_persistent_id_creates_again() -> None:
    e = entry(state="failed", persistent_id=None)
    d = decide(e, [e], SHA, force=False)
    assert (d.outcome, d.create, d.entry) == (None, True, e)


def test_failed_entry_with_same_content_elsewhere_is_duplicate() -> None:
    mine = entry(state="failed", persistent_id=None)
    other = entry(id="e2", source_key="elsewhere/r1.docx")
    d = decide(mine, [mine, other], SHA, force=False)
    assert (d.outcome, d.entry) == ("duplicate", other)
    forced = decide(mine, [mine, other], SHA, force=True)
    assert (forced.outcome, forced.create, forced.entry) == (None, True, mine)


def test_a_failed_create_elsewhere_is_no_duplicate() -> None:
    """Content whose only entry never became a document is not seen on the tenant."""
    other = entry(id="e2", source_key="elsewhere/r1.docx", state="failed", persistent_id=None)
    assert decide(None, [other], SHA, force=False).outcome is None


# --- MemoryRegisterStore -----------------------------------------------------------------------


def test_memory_store_resets_an_entry_to_pending() -> None:
    store = MemoryRegisterStore(clock=lambda: AT)
    with store.transaction() as tx:
        first = tx.put_pending(
            replacing=None,
            sink_id="docs",
            instance_id=None,
            source_key="r1.docx",
            content_sha256=SHA,
            idempotency_key="1" * 64,
            batch_id=None,
        )
        tx.set_delivery(first.id, "d1")
    store.settle(first.id, state="delivered", persistent_id="DOC-1")
    with store.transaction() as tx:
        found = tx.by_key("docs", None, "r1.docx")
        assert found is not None and found.persistent_id == "DOC-1"
        again = tx.put_pending(
            replacing=found,
            sink_id="docs",
            instance_id=None,
            source_key="r1.docx",
            content_sha256=NEW_SHA,
            idempotency_key="2" * 64,
            batch_id="b2",
        )
    assert again.id == first.id
    assert (again.state, again.delivery_id, again.persistent_id) == ("pending", None, "DOC-1")
    assert (again.content_sha256, again.idempotency_key, again.batch_id) == (
        NEW_SHA,
        "2" * 64,
        "b2",
    )
    with store.transaction() as tx:
        assert tx.by_hash("docs", None, NEW_SHA) == [again]
        assert tx.by_hash("docs", "other", NEW_SHA) == []


def test_memory_store_rolls_back_a_failed_transaction() -> None:
    store = MemoryRegisterStore(clock=lambda: AT)
    with pytest.raises(RuntimeError), store.transaction() as tx:
        tx.put_pending(
            replacing=None,
            sink_id="docs",
            instance_id=None,
            source_key="r1.docx",
            content_sha256=SHA,
            idempotency_key="1" * 64,
            batch_id=None,
        )
        raise RuntimeError("boom")
    assert store.entries() == []
