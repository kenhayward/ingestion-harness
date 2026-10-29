"""The watch cycle on Postgres (watch/store.py `PgWatchStore`, watch/runner.py `PgWatchLocks`):
IH_TEST_DATABASE_URL, a throwaway database with db/migrations applied; each test adds its own
target and watch and removes what it made."""

from __future__ import annotations

import json
import os
import threading
import time
import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest

from ingest_worker.bridge.models import ActingUser, SourceFile
from ingest_worker.storage import MemoryObjectStore
from ingest_worker.watch.cycle import WatchDeps, run_cycle
from ingest_worker.watch.runner import PgWatchLocks, WatchRunner
from ingest_worker.watch.store import PgWatchStore

from .fakes import FakeBridge

pytestmark = pytest.mark.integration

DB = os.environ.get("IH_TEST_DATABASE_URL")
SOURCE = {"folder": "Plant A/Intake"}
USER = ActingUser(id=str(uuid.uuid4()), name="Ada", email="ada@example.com")
PDF = b"%PDF-1.7\nhello\n%%EOF"


class Db:
    def __init__(self, url: str) -> None:
        import psycopg

        self.url = url
        self.conn: psycopg.Connection[Any] = psycopg.connect(url, autocommit=True)
        self.target = f"watch-{uuid.uuid4().hex[:12]}"
        self.conn.execute(
            """INSERT INTO publish_targets (id, label, kind, sink_id, instance_id, destination)
               VALUES (%s, %s, 'sink', 'docs-sink', 'acme', '{}')""",
            (self.target, self.target),
        )
        self.watches: list[str] = []

    def watch(self, **settings: Any) -> str:
        row = self.conn.execute(
            """INSERT INTO watched_folders
                 (name, target_id, source, source_path, run_as, state, reason_files,
                  next_look_at, created_by)
               VALUES (%s, %s, %s, 'Plant A/Intake', %s, %s, %s, now() - interval '1 minute',
                       %s)
               RETURNING id::text""",
            (
                f"w-{uuid.uuid4().hex[:8]}",
                self.target,
                json.dumps(SOURCE),
                json.dumps(USER.model_dump()),
                settings.get("state", "running"),
                settings.get("reason_files", True),
                json.dumps(USER.model_dump()),
            ),
        ).fetchone()
        assert row is not None
        self.watches.append(row[0])
        return str(row[0])

    def one(self, sql: str, *args: Any) -> Any:
        row = self.conn.execute(sql, args).fetchone()
        assert row is not None
        return row[0] if len(row) == 1 else row

    def close(self) -> None:
        for watch_id in self.watches:
            batches = [
                r[0]
                for r in self.conn.execute(
                    "SELECT id FROM decomposition_batches WHERE watch_id = %s", (watch_id,)
                ).fetchall()
            ]
            self.conn.execute("DELETE FROM watched_folders WHERE id = %s", (watch_id,))
            for batch in batches:
                jobs = [
                    r[0]
                    for r in self.conn.execute(
                        "SELECT job_id FROM decomposition_items WHERE batch_id = %s", (batch,)
                    ).fetchall()
                    if r[0] is not None
                ]
                self.conn.execute("DELETE FROM decomposition_items WHERE batch_id = %s", (batch,))
                self.conn.execute("DELETE FROM jobs WHERE id = ANY(%s)", (jobs,))
                self.conn.execute("DELETE FROM decomposition_batches WHERE id = %s", (batch,))
        self.conn.execute("DELETE FROM publish_targets WHERE id = %s", (self.target,))
        self.conn.close()


@pytest.fixture
def db() -> Iterator[Db]:
    if DB is None:
        pytest.skip("IH_TEST_DATABASE_URL not set")
    d = Db(DB)
    try:
        yield d
    finally:
        d.close()


def deps(db: Db, bridge: FakeBridge, objects: MemoryObjectStore) -> WatchDeps:
    import psycopg

    return WatchDeps(
        store=PgWatchStore(psycopg.connect(db.url, autocommit=True)),
        bridge=bridge,
        objects=objects,
        runs_bucket="runs",
        max_bytes=10**6,
        app_url=None,
    )


def drop(bridge: FakeBridge, db: Db, name: str, data: bytes) -> None:
    bridge.sources[FakeBridge.source_key(db.target, SOURCE, "", name)] = data


def folder(bridge: FakeBridge, name: str) -> set[str]:
    return {k[3] for k in bridge.sources if k[2] == name}


def test_a_file_is_picked_up_queued_and_filed(db: Db) -> None:
    bridge, objects = FakeBridge(sinks={db.target}), MemoryObjectStore()
    d = deps(db, bridge, objects)
    watch_id = db.watch()
    drop(bridge, db, "a.pdf", PDF)
    t0 = datetime.now(UTC)

    def cycle(at: datetime) -> Any:
        w = d.store.watch(watch_id)
        assert w is not None
        return run_cycle(w, d, at)

    assert cycle(t0).admitted == 0
    assert cycle(t0 + timedelta(seconds=10)).admitted == 1
    assert folder(bridge, "processing") == {"a.pdf"}

    batch = db.one(
        "SELECT id::text, state, created_by, auto_approve, watch_id::text "
        "FROM decomposition_batches WHERE watch_id = %s",
        watch_id,
    )
    assert batch[1:] == ("started", {"id": USER.id, "name": "Ada"}, True, watch_id)
    assert db.one("SELECT batch_id::text FROM watched_folders WHERE id = %s", watch_id) == batch[0]
    item = db.one(
        "SELECT id::text, source_key, filename, watched, outcome, size_bytes, job_id::text "
        "FROM decomposition_items WHERE batch_id = %s",
        batch[0],
    )
    assert item[1:6] == ("Plant A/Intake/a.pdf", "a.pdf", True, "queued", len(PDF))
    job = db.one(
        "SELECT task, priority, max_attempts, params, created_by, created_by_user::text, status "
        "FROM jobs WHERE id = %s",
        item[6],
    )
    assert job == (
        "decompose",
        0,
        3,
        {
            "batchId": batch[0],
            "itemId": item[0],
            "targetId": db.target,
            "sourceKey": "Plant A/Intake/a.pdf",
            "force": False,
            "autoApprove": True,
        },
        "Ada",
        USER.id,
        "queued",
    )
    assert db.one("SELECT step FROM watch_pickups WHERE item_id = %s", item[0]) == "queued"

    db.conn.execute(
        "UPDATE decomposition_items SET outcome = 'duplicate', detail = 'loaded as D-1' "
        "WHERE id = %s",
        (item[0],),
    )
    assert cycle(t0 + timedelta(seconds=20)).finished == 1
    assert folder(bridge, "failed") == {"a.pdf", "a.pdf.md"}
    assert db.one("SELECT total_failed FROM watched_folders WHERE id = %s", watch_id) == 1
    assert db.one("SELECT count(*) FROM watch_finishes WHERE watch_id = %s", watch_id) == 1
    assert db.one("SELECT step FROM watch_pickups WHERE item_id = %s", item[0]) == "finished"

    # The same name again (an edited copy) is a second item under the same source key.
    drop(bridge, db, "a.pdf", PDF + b" edited")
    cycle(t0 + timedelta(seconds=30))
    assert cycle(t0 + timedelta(seconds=40)).admitted == 1
    assert folder(bridge, "processing") == {"a_1.pdf"}
    assert (
        db.one(
            "SELECT count(*) FROM decomposition_items WHERE batch_id = %s "
            "AND source_key = 'Plant A/Intake/a.pdf'",
            batch[0],
        )
        == 2
    )


def test_a_refused_file_is_a_failed_item_without_a_stored_copy(db: Db) -> None:
    bridge, objects = FakeBridge(sinks={db.target}), MemoryObjectStore()
    d = deps(db, bridge, objects)
    watch_id = db.watch()
    drop(bridge, db, "x.pdf", b"not a document")
    t0 = datetime.now(UTC)
    w = d.store.watch(watch_id)
    assert w is not None
    run_cycle(w, d, t0)
    run_cycle(w, d, t0 + timedelta(seconds=10))
    item = db.one(
        "SELECT outcome, detail, object_key, job_id, finished_at IS NOT NULL "
        "FROM decomposition_items i JOIN decomposition_batches b ON b.id = i.batch_id "
        "WHERE b.watch_id = %s",
        watch_id,
    )
    assert item == ("failed", "file is not a PDF or Word document (.docx)", None, None, True)
    assert db.one("SELECT total_failed FROM watched_folders WHERE id = %s", watch_id) == 1
    assert folder(bridge, "failed") == {"x.pdf", "x.pdf.md"}


def test_a_finished_pickup_is_seen_afresh(db: Db) -> None:
    import psycopg

    store = PgWatchStore(psycopg.connect(db.url, autocommit=True))
    watch_id = db.watch()
    f = SourceFile(name="a.pdf", size=3, modified_at="2026-10-29T00:00:00.000Z", etag=None)
    t0 = datetime.now(UTC)
    store.see(watch_id, f, t0)
    (p,) = store.pickups(watch_id)
    store.finish(watch_id, True, t0, p.id)
    store.finish(watch_id, True, t0, p.id)  # counted once
    assert store.pickups(watch_id) == []
    assert db.one("SELECT total_delivered FROM watched_folders WHERE id = %s", watch_id) == 1
    store.see(watch_id, f, t0 + timedelta(seconds=5))
    (again,) = store.pickups(watch_id)
    assert again.id == p.id and again.step == "seen"
    assert again.first_seen_at == t0 + timedelta(seconds=5)


class SlowBridge(FakeBridge):
    """Lists slowly and records how many lists ran at once."""

    def __init__(self, sinks: set[str]) -> None:
        super().__init__(sinks=sinks)
        self._lock = threading.Lock()
        self.running = 0
        self.most = 0

    def list_source(self, *args: Any, **kwargs: Any) -> list[SourceFile]:
        with self._lock:
            self.running += 1
            self.most = max(self.most, self.running)
        try:
            time.sleep(0.3)
            return super().list_source(*args, **kwargs)
        finally:
            with self._lock:
                self.running -= 1


def test_two_runners_never_run_one_watch_at_once(db: Db) -> None:
    bridge, objects = SlowBridge(sinks={db.target}), MemoryObjectStore()
    watch_id = db.watch()
    drop(bridge, db, "a.pdf", PDF)
    seen = deps(db, bridge, objects)
    f = SourceFile(name="a.pdf", size=len(PDF), modified_at="2026-10-29T00:00:00.000Z", etag=None)
    seen.store.see(watch_id, f, datetime.now(UTC) - timedelta(minutes=1))  # settled already

    runners = [WatchRunner(deps(db, bridge, objects), PgWatchLocks(db.url)) for _ in range(2)]
    start = threading.Barrier(2)
    errors: list[BaseException] = []

    def run(r: WatchRunner) -> None:
        try:
            start.wait()
            r.tick()
        except BaseException as exc:  # reported below
            errors.append(exc)

    threads = [threading.Thread(target=run, args=(r,)) for r in runners]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    for r in runners:
        assert isinstance(r.locks, PgWatchLocks)
        r.locks.close()
    assert errors == []
    assert bridge.most == 1
    assert (
        db.one(
            "SELECT count(*) FROM decomposition_items i JOIN decomposition_batches b "
            "ON b.id = i.batch_id WHERE b.watch_id = %s",
            watch_id,
        )
        == 1
    )
    assert folder(bridge, "processing") == {"a.pdf"}
