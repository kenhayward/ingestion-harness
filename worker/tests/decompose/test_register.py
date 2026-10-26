"""The register's two checks (spec §8): `decide`, one test per row of its table, and the memory
store's transactions."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

import pytest

from ingest_worker.decompose.deliver import GONE, decide
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


def test_gone_entry_is_unresolved_forced_or_not() -> None:
    """An update the target refused with its missing-document marker (`not_found`, details
    `reason: document_missing` naming the entry's own document; deleted there): no run sends
    another, forced or not; only the API's reload (a detach, then a create) loads it."""
    not_found = {
        "class": "needs_user",
        "code": "not_found",
        "message": "no map DOC-1",
        "details": {"reason": "document_missing", "persistentId": "DOC-1"},
    }
    e = entry(state="failed", last_error=not_found)
    for force in (False, True):
        for sha in (SHA, NEW_SHA):
            d = decide(e, [e], sha, force=force)
            assert (d.outcome, d.create, d.entry) == ("unresolved", False, e)
            assert d.reason == GONE
    assert GONE == (
        "The target no longer has this document (it may have been deleted). "
        "Load it as a new document to create it again."
    )
    # Without the marker (a lost delivery, no route, no sink job), or with it naming another
    # document, or another failure: not gone, so the update is tried again.
    for error in (
        {"class": "needs_user", "code": "not_found", "message": "no route"},
        {"class": "needs_user", "code": "not_found", "message": "the bridge has no record"},
        {**not_found, "details": {"reason": "document_missing", "persistentId": "DOC-2"}},
        {**not_found, "details": {"reason": "elsewhere", "persistentId": "DOC-1"}},
        {**not_found, "code": "content_rejected"},
    ):
        other = entry(state="failed", last_error=error)
        assert decide(other, [other], SHA, force=False).outcome is None, error
    never = entry(state="failed", persistent_id=None, last_error=not_found)
    assert decide(never, [], SHA, force=False).outcome is None


def test_changed_entry_refuses() -> None:
    e = entry(state="changed")
    for force in (False, True):
        assert decide(e, [e], SHA, force=force).outcome == "changed_in_target"
        assert decide(e, [], NEW_SHA, force=force).outcome == "changed_in_target"


#: The worker's own definite refusal: the bridge took nothing (deliver_decomposition marks it).
REFUSED = {
    "class": "needs_user",
    "code": "content_rejected",
    "message": "too large",
    "details": {"refusedBeforeAcceptance": True},
}
NOT_RECORDED = {"class": "retryable", "code": "not_recorded", "message": "never recorded"}
SINK_FAILED = {"class": "permanent", "code": "sink_failed", "message": "the sink failed"}

#: Entries without a persistent id whose last delivery may have reached the target.
MAYBE_REACHED = {
    "a bridge-reported failure": entry(state="failed", persistent_id=None, last_error=SINK_FAILED),
    "an unrecorded delivery, expired": entry(
        state="failed", persistent_id=None, last_error=NOT_RECORDED
    ),
    "incomplete without a document": entry(state="incomplete", persistent_id=None),
}


def test_an_entry_the_bridge_refused_creates_again_under_a_new_key() -> None:
    e = entry(state="failed", persistent_id=None, last_error=REFUSED)
    for sha in (SHA, NEW_SHA):
        for force in (False, True):
            d = decide(e, [e], sha, force=force)
            assert (d.outcome, d.create, d.entry, d.idempotency_key) == (None, True, e, None)


@pytest.mark.parametrize("name", MAYBE_REACHED)
@pytest.mark.parametrize("force", [False, True])
def test_same_content_without_persistent_id_creates_again_under_the_stored_key(
    name: str, force: bool
) -> None:
    e = MAYBE_REACHED[name]
    d = decide(e, [e], SHA, force=force)
    assert (d.outcome, d.create, d.entry) == (None, True, e)
    assert d.idempotency_key == e.idempotency_key
    assert d.reason == (
        "sent again with the same key as the earlier attempt, so the target can't create it twice"
    )


@pytest.mark.parametrize("name", MAYBE_REACHED)
@pytest.mark.parametrize("force", [False, True])
def test_new_content_without_persistent_id_is_unresolved(name: str, force: bool) -> None:
    e = MAYBE_REACHED[name]
    d = decide(e, [], NEW_SHA, force=force)
    assert (d.outcome, d.create, d.entry) == ("unresolved", False, e)
    assert d.reason == (
        "an earlier delivery of this source may have created a document in the target; "
        "re-run the original file, or resolve it in the target"
    )


def test_failed_entry_with_same_content_elsewhere_is_duplicate() -> None:
    mine = entry(state="failed", persistent_id=None)
    other = entry(id="e2", source_key="elsewhere/r1.docx")
    d = decide(mine, [mine, other], SHA, force=False)
    assert (d.outcome, d.entry) == ("duplicate", other)
    forced = decide(mine, [mine, other], SHA, force=True)
    assert (forced.outcome, forced.create, forced.entry) == (None, True, mine)
    assert forced.idempotency_key == mine.idempotency_key


def test_a_failed_create_elsewhere_is_no_duplicate() -> None:
    """Content whose only entry never became a document is not seen on the tenant."""
    other = entry(id="e2", source_key="elsewhere/r1.docx", state="failed", persistent_id=None)
    assert decide(None, [other], SHA, force=False).outcome is None


@pytest.mark.parametrize("force", [False, True])
def test_the_sources_own_entry_in_by_hash_is_in_flight(force: bool) -> None:
    """`by_key` read nothing, yet the content check finds an entry for this very source: another
    run registered it in between (this one waited on that run's content lock): in flight."""
    racing = entry(state="pending", persistent_id=None, delivery_id=None)
    d = decide(None, [racing], SHA, force=force, source_key="reports/r1.docx")
    assert (d.outcome, d.create, d.entry) == ("in_flight", False, racing)
    other = entry(id="e2", source_key="elsewhere/r1.docx")
    assert decide(None, [other], SHA, False, source_key="reports/r1.docx").outcome == "duplicate"


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
