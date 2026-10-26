"""PgItemStore against a real Postgres with db/migrations applied. Excluded by default."""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from datetime import datetime

import psycopg
import pytest

from ingest_worker.decompose.items import PgItemStore

pytestmark = pytest.mark.integration


@pytest.fixture
def item() -> Iterator[tuple[PgItemStore, psycopg.Connection[tuple[object, ...]], str]]:
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL not set")
    conn = psycopg.connect(url, autocommit=True)
    batch = conn.execute(
        """INSERT INTO decomposition_batches (target_id, created_by, state)
           VALUES ('manuals', '{"id": null, "name": null}', 'started') RETURNING id::text"""
    ).fetchone()
    assert batch is not None
    item_id = str(uuid.uuid4())
    conn.execute(
        """INSERT INTO decomposition_items
             (id, batch_id, source_key, filename, content_sha256, size_bytes, object_key)
           VALUES (%s, %s, 'a/r1.docx', 'r1.docx', %s, 10, 'decompositions/b/i.docx')""",
        (item_id, batch[0], "a" * 64),
    )
    yield PgItemStore(conn), conn, item_id
    conn.execute("DELETE FROM decomposition_items WHERE batch_id = %s", (batch[0],))
    conn.execute("DELETE FROM decomposition_batches WHERE id = %s", (batch[0],))
    conn.close()


def _outcome(conn: psycopg.Connection[tuple[object, ...]], item_id: str) -> tuple[object, ...]:
    row = conn.execute(
        """SELECT outcome, detail, register_entry_id::text, report_key
             FROM decomposition_items WHERE id = %s""",
        (item_id,),
    ).fetchone()
    assert row is not None
    return row


def test_an_item_is_started_reported_and_decided(
    item: tuple[PgItemStore, psycopg.Connection[tuple[object, ...]], str],
) -> None:
    store, conn, item_id = item
    started = store.start(item_id)
    assert started is not None
    assert (started.outcome, started.source_key, started.object_key) == (
        "queued",
        "a/r1.docx",
        "decompositions/b/i.docx",
    )
    store.set_report(item_id, "decompositions/b/i.report.json")
    entry = str(uuid.uuid4())
    assert store.decide(item_id, "delivering", "a new source", entry)
    assert _outcome(conn, item_id) == (
        "delivering",
        "a new source",
        entry,
        "decompositions/b/i.report.json",
    )
    assert store.start(str(uuid.uuid4())) is None


def test_a_delivering_item_may_be_recorded_delivering_again(
    item: tuple[PgItemStore, psycopg.Connection[tuple[object, ...]], str],
) -> None:
    """A retry resumes its own delivery: `delivering` again, but never a final outcome over it."""
    store, conn, item_id = item
    store.start(item_id)
    entry = str(uuid.uuid4())
    assert store.decide(item_id, "delivering", "a new source", entry)
    assert store.decide(item_id, "delivering", "resumed", None)
    assert not store.decide(item_id, "failed", "the job was cancelled", None)
    assert _outcome(conn, item_id)[:3] == ("delivering", "resumed", entry)


def test_an_item_id_that_is_not_a_uuid_is_no_item(
    item: tuple[PgItemStore, psycopg.Connection[tuple[object, ...]], str],
) -> None:
    """A job's params name a malformed item id: no such item (the job goes to review), not a
    cast error that the job retries."""
    store, _conn, _item_id = item
    assert store.start("not-a-uuid") is None
    store.set_report("not-a-uuid", "k")
    assert store.decide("not-a-uuid", "failed", "x", None) is False


def test_a_settled_item_is_never_overwritten_by_the_worker(
    item: tuple[PgItemStore, psycopg.Connection[tuple[object, ...]], str],
) -> None:
    """The bridge's event settled the item before the worker recorded it as delivering."""
    store, conn, item_id = item
    store.start(item_id)
    conn.execute(
        "UPDATE decomposition_items SET outcome = 'created', detail = 'doc' WHERE id = %s",
        (item_id,),
    )
    assert not store.decide(item_id, "delivering", "a new source", str(uuid.uuid4()))
    started = store.start(item_id)  # a retry leaves it alone too
    assert started is not None and started.outcome == "created"
    assert _outcome(conn, item_id)[:3] == ("created", "doc", None)


def _times(conn: psycopg.Connection[tuple[object, ...]], item_id: str) -> tuple[object, ...]:
    row = conn.execute(
        "SELECT started_at, finished_at FROM decomposition_items WHERE id = %s", (item_id,)
    ).fetchone()
    assert row is not None
    return row


def test_an_item_records_when_it_started_keeping_the_first_start(
    item: tuple[PgItemStore, psycopg.Connection[tuple[object, ...]], str],
) -> None:
    store, conn, item_id = item
    assert _times(conn, item_id) == (None, None)
    store.start(item_id)
    started, finished = _times(conn, item_id)
    assert started is not None and finished is None
    store.start(item_id)  # a retry
    assert _times(conn, item_id) == (started, None)
    assert store.decide(item_id, "delivering", "a new source", None)
    assert _times(conn, item_id) == (started, None)  # the API's settle finishes it


def test_a_final_outcome_the_worker_decides_finishes_the_item(
    item: tuple[PgItemStore, psycopg.Connection[tuple[object, ...]], str],
) -> None:
    store, conn, item_id = item
    store.start(item_id)
    assert store.decide(item_id, "duplicate", "the same content as a.docx", None)
    started, finished = _times(conn, item_id)
    assert isinstance(started, datetime) and isinstance(finished, datetime)
    assert finished >= started
