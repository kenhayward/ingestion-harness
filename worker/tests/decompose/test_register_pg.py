"""PgRegisterStore against a real Postgres with db/migrations applied. Excluded by default."""

from __future__ import annotations

import json
import os
import threading
import uuid
from collections.abc import Iterator

import psycopg
import pytest

from ingest_worker.decompose.deliver import decide
from ingest_worker.decompose.register import (
    PgRegisterStore,
    RegisterEntry,
    RegisterRaced,
    RegisterTx,
)

pytestmark = pytest.mark.integration

OLD_SHA = "a" * 64
NEW_SHA = "b" * 64
RECEIPT = {
    "written": [],
    "document": {
        "persistentId": "DOC-1",
        "components": [{"kind": "document", "id": "DOC-1", "version": "1", "element": None}],
        "readBack": {"ok": True, "at": None, "detail": None},
    },
}


@pytest.fixture
def store() -> Iterator[tuple[PgRegisterStore, str]]:
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL not set")
    sink = f"test-{uuid.uuid4()}"
    yield PgRegisterStore.for_url(url), sink
    with psycopg.connect(url, autocommit=True) as conn:
        conn.execute("DELETE FROM decomposition_register WHERE sink_id = %s", (sink,))


def _pending(tx: RegisterTx, sink: str, replacing: RegisterEntry | None, sha: str) -> RegisterEntry:
    return tx.put_pending(
        replacing=replacing,
        sink_id=sink,
        instance_id=None,
        source_key="r1.docx",
        content_sha256=sha,
        idempotency_key=uuid.uuid4().hex * 2,
        batch_id=None,
    )


def _settle_delivered(sink: str) -> None:
    """What the API does on the first delivery's final event."""
    with psycopg.connect(os.environ["DATABASE_URL"], autocommit=True) as conn:
        conn.execute(
            """UPDATE decomposition_register
                  SET state = 'delivered', persistent_id = 'DOC-1', last_receipt = %s::jsonb
                WHERE sink_id = %s""",
            (json.dumps(RECEIPT), sink),
        )


def test_entries_round_trip_with_a_null_instance(store: tuple[PgRegisterStore, str]) -> None:
    pg, sink = store
    with pg.transaction() as tx:
        first = _pending(tx, sink, None, OLD_SHA)
        tx.set_delivery(first.id, f"d-{uuid.uuid4()}")
    _settle_delivered(sink)
    with pg.transaction() as tx:
        found = tx.by_key(sink, None, "r1.docx")
        assert found is not None and found.id == first.id
        assert found.last_receipt is not None and found.last_receipt.document is not None
        assert found.last_receipt.document.persistent_id == "DOC-1"
        assert [e.id for e in tx.by_hash(sink, None, OLD_SHA)] == [first.id]
        assert tx.by_key(sink, "tenant-2", "r1.docx") is None
        again = _pending(tx, sink, found, NEW_SHA)
    assert (again.state, again.delivery_id, again.persistent_id) == ("pending", None, "DOC-1")
    assert again.last_receipt == found.last_receipt and again.content_sha256 == NEW_SHA


def test_concurrent_delivery_is_refused(store: tuple[PgRegisterStore, str]) -> None:
    pg, sink = store
    with pg.transaction() as tx:
        first = _pending(tx, sink, None, OLD_SHA)
        tx.set_delivery(first.id, f"d-{uuid.uuid4()}")
    _settle_delivered(sink)

    seen: list[str | None] = []
    waiting = threading.Event()

    def second_run() -> None:
        with pg.transaction() as tx:
            waiting.set()
            by_key = tx.by_key(sink, None, "r1.docx")  # waits on the first run's lock
            seen.append(decide(by_key, tx.by_hash(sink, None, NEW_SHA), NEW_SHA, False).outcome)

    with pg.transaction() as tx:
        by_key = tx.by_key(sink, None, "r1.docx")
        decision = decide(by_key, tx.by_hash(sink, None, NEW_SHA), NEW_SHA, False)
        assert (decision.outcome, decision.create) == (None, False)
        thread = threading.Thread(target=second_run)
        thread.start()
        assert waiting.wait(5)
        thread.join(0.5)
        assert thread.is_alive(), "the second run's by_key should wait on the row lock"
        _pending(tx, sink, by_key, NEW_SHA)
    thread.join(10)

    assert seen == ["in_flight"]


def test_a_new_source_registered_twice_at_once_is_refused(
    store: tuple[PgRegisterStore, str],
) -> None:
    pg, sink = store
    raced: list[BaseException] = []
    inserting = threading.Event()

    def second_run() -> None:
        try:
            with pg.transaction() as tx:
                assert tx.by_key(sink, None, "r1.docx") is None
                inserting.set()
                _pending(tx, sink, None, OLD_SHA)  # waits on the first insert, then conflicts
        except RegisterRaced as exc:
            raced.append(exc)

    with pg.transaction() as tx:
        assert tx.by_key(sink, None, "r1.docx") is None
        _pending(tx, sink, None, OLD_SHA)
        thread = threading.Thread(target=second_run)
        thread.start()
        assert inserting.wait(5)
        thread.join(0.5)
    thread.join(10)

    assert len(raced) == 1
    with pg.transaction() as tx:
        assert len(tx.by_hash(sink, None, OLD_SHA)) == 1
