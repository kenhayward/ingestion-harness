"""Publishing targets in the worker: reading the API's cache of the bridge's registry (the
credentials live on the delivery bridge; the API does the seeding).

The prefix cases come from the fixture the API's tests read too."""

from __future__ import annotations

import inspect
import json
import os
from collections.abc import Iterator
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

import pytest

from ingest_worker.config import REPO_ROOT
from ingest_worker.pipeline import DocumentError, Target
from ingest_worker.publish_targets import (
    LiveTargets,
    PgPublishTargetStore,
    TargetMissing,
    TargetNotSynced,
    TargetRow,
    normalise_prefix,
)

from .fakes import FakeTargets, MemoryPublishTargetStore

FIXTURES = REPO_ROOT / "packages" / "shared" / "test" / "fixtures"
FIXTURE = json.loads((FIXTURES / "publish-targets.json").read_text(encoding="utf-8"))
SECRET_FIXTURE = json.loads((FIXTURES / "llm-secret.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", FIXTURE["prefixes"], ids=lambda c: repr(c["input"]))
def test_normalise_prefix_matches_the_shared_fixture(case: dict[str, str]) -> None:
    assert normalise_prefix(case["input"]) == case["expected"]


NOW = datetime(2026, 10, 21, tzinfo=UTC)
S3 = {"bucket": "ingest-published", "prefix": "", "sse": "none", "layout": ""}


def row(**kw: Any) -> TargetRow:
    base = TargetRow(
        id="default",
        label="Default",
        kind="internal",
        sink_id="s3",
        destination=S3,
        synced_at=NOW,
    )
    return replace(base, **kw)


def live(rows: list[TargetRow]) -> tuple[LiveTargets, MemoryPublishTargetStore]:
    store = MemoryPublishTargetStore(rows)
    return LiveTargets(store), store


def test_a_target_is_its_id_bucket_and_prefix_only() -> None:
    targets, _ = live([row(destination={**S3, "prefix": "pvp/"})])
    assert targets.get("default") == Target("default", "ingest-published", "pvp/")


def test_get_builds_the_s3_place_from_the_destination() -> None:
    targets, _ = live(
        [
            row(id="blank", destination={"bucket": "b", "prefix": "p/", "layout": ""}),
            row(id="files", destination={"bucket": "b", "layout": "files"}),
            row(id="archive", destination={"bucket": "b", "prefix": "a/", "layout": "package"}),
            row(id="bare", destination={"bucket": "b"}),
        ]
    )
    assert targets.get("blank") == Target("blank", "b", "p/", "files")
    assert targets.get("files") == Target("files", "b", "", "files")
    assert targets.get("archive") == Target("archive", "b", "a/", "package")
    assert targets.get("bare") == Target("bare", "b", "", "files")


def test_rdf_reads_the_dataset_from_the_destination() -> None:
    triples = row(id="rdf-default", kind="rdf", sink_id="rdf", destination={"dataset": "kb"})
    targets, _ = live([row(), triples])
    assert targets.rdf() == Target("rdf-default", "kb", "")
    assert live([row()])[0].rdf() is None


def test_a_target_of_another_sink_is_delivered_to_with_no_s3_place() -> None:
    hook = row(id="hook", kind="sink", sink_id="webhook", destination={"url": "https://x"})
    targets, _ = live([hook, replace(hook, id="early", synced_at=None)])
    assert targets.get("hook") == Target("hook", "", "", layout="sink", sink_id="webhook")
    with pytest.raises(TargetNotSynced, match="early"):
        targets.get("early")


def test_a_target_knows_its_sink_instance() -> None:
    docs = row(id="docs", kind="sink", sink_id="docs", destination={}, instance_id="tenant-1")
    targets, _ = live([docs])
    assert (targets.get("docs").sink_id, targets.get("docs").instance_id) == ("docs", "tenant-1")


def test_a_target_knows_its_tenants_lanes_from_the_cache() -> None:
    docs = row(id="docs", kind="sink", sink_id="docs", destination={}, instance_id="eu", lanes=10)
    lake = row(id="lake", lanes=3)
    targets, _ = live([docs, lake, row()])
    assert targets.get("docs").lanes == 10
    assert targets.get("lake").lanes == 3
    assert targets.get("default").lanes is None


def test_a_target_not_synced_yet_is_not_ready_and_is_no_document_error() -> None:
    targets, store = live([row(synced_at=None)])
    with pytest.raises(TargetNotSynced, match="default"):
        targets.get("default")
    assert not issubclass(TargetNotSynced, DocumentError)  # retried, never sent to review
    store.set_rows([row()])
    assert targets.get("default").bucket == "ingest-published"


def test_an_unsynced_rdf_default_is_waited_for_not_skipped() -> None:
    rdf = row(id="rdf-default", kind="rdf", sink_id="rdf", destination={"dataset": "kb"})
    # Present but unsynced raises whether or not RDF is configured.
    unsynced = replace(rdf, synced_at=None)
    for expected in (True, False):
        with pytest.raises(TargetNotSynced, match="rdf-default"):
            LiveTargets(MemoryPublishTargetStore([row(), unsynced]), expected).rdf()
    # Configured but not in the cache yet: wait.
    with pytest.raises(TargetNotSynced):
        LiveTargets(MemoryPublishTargetStore([row()]), rdf_expected=True).rdf()
    store = MemoryPublishTargetStore([row(), unsynced])
    targets = LiveTargets(store, rdf_expected=True)
    store.set_rows([row(), rdf])
    assert targets.rdf() == Target("rdf-default", "kb", "")


def test_without_rdf_endpoint_a_missing_rdf_default_is_none() -> None:
    assert LiveTargets(MemoryPublishTargetStore([row()]), rdf_expected=False).rdf() is None


def test_an_unknown_target_is_missing_never_the_default() -> None:
    targets, _ = live([row()])
    with pytest.raises(TargetMissing, match="no publishing target gone"):
        targets.get("gone")
    assert issubclass(TargetMissing, DocumentError)


def test_a_removed_target_is_missing_and_says_it_was_removed() -> None:
    targets, _ = live([row(), row(id="gone-repo", label="Gone", inert=True)])
    with pytest.raises(TargetMissing, match="publishing target gone-repo was removed"):
        targets.get("gone-repo")
    assert targets.removed("gone-repo")
    assert not targets.removed("default")
    assert not targets.removed("never-was")


def test_refresh_reloads_only_when_the_version_moved() -> None:
    targets, store = live([row()])
    targets.get("default")
    assert targets.refresh() is False
    store.set_rows([row(destination={**S3, "bucket": "moved"})])
    assert targets.refresh() is True
    assert targets.get("default").bucket == "moved"


def test_get_refreshes_before_resolving() -> None:
    targets, store = live([row()])
    assert targets.get("default").bucket == "ingest-published"
    store.set_rows([row(destination={**S3, "bucket": "moved"})])
    assert targets.get("default").bucket == "moved"


def test_the_worker_seeds_nothing() -> None:
    import ingest_worker.main as main
    import ingest_worker.publish_targets as pt

    for name in ("seed_default_target", "seed_rdf_target", "default_seed", "rdf_seed"):
        assert not hasattr(pt, name) and not hasattr(main, name)
    assert not hasattr(PgPublishTargetStore, "seed_default")
    assert not hasattr(PgPublishTargetStore, "seed_rdf")
    source = inspect.getsource(main)
    assert "seed_default_target" not in source and "seed_rdf_target" not in source


def test_fake_targets_get() -> None:
    t = Target("x", "b", "p/")
    assert FakeTargets({"x": t}).get("x") is t
    with pytest.raises(TargetMissing):
        FakeTargets({}).get("y")


def test_target_defaults_its_prefix() -> None:
    assert Target("default", "published").prefix == ""


@pytest.fixture
def pg() -> Iterator[PgPublishTargetStore]:
    url = os.environ.get("IH_TEST_DATABASE_URL")
    if not url:
        pytest.skip("IH_TEST_DATABASE_URL not set (a throwaway migrated database)")
    import psycopg

    conn = psycopg.connect(url, autocommit=True)
    conn.execute("DELETE FROM publish_targets WHERE id IN ('prod-lake', 'rdf-default')")
    conn.execute(
        "UPDATE publish_targets SET kind = 'internal', sink_id = 's3', synced_at = now(),"
        ' destination = \'{"bucket": "ingest-published", "prefix": "pvp/"}\''
        " WHERE id = 'default'"
    )
    yield PgPublishTargetStore(conn)
    conn.close()


@pytest.mark.integration
def test_pg_store_reads_the_cache_columns_and_moves_the_version(pg: PgPublishTargetStore) -> None:
    [r] = [r for r in pg.load() if r.id == "default"]
    assert (r.kind, r.sink_id, r.inert, r.synced_at is not None) == ("internal", "s3", False, True)
    assert LiveTargets(pg).get("default") == Target("default", "ingest-published", "pvp/", "files")
    before = pg.version()
    pg._conn.execute("UPDATE publish_targets SET label = 'Renamed' WHERE id = 'default'")
    assert pg.version() > before


@pytest.mark.integration
def test_pg_store_reads_the_cached_lanes(pg: PgPublishTargetStore) -> None:
    pg._conn.execute("UPDATE publish_targets SET lanes = 6 WHERE id = 'default'")
    try:
        assert LiveTargets(pg).get("default").lanes == 6
    finally:
        pg._conn.execute("UPDATE publish_targets SET lanes = NULL WHERE id = 'default'")


@pytest.mark.integration
def test_pg_target_not_synced_yet_waits(pg: PgPublishTargetStore) -> None:
    pg._conn.execute("UPDATE publish_targets SET synced_at = NULL WHERE id = 'default'")
    with pytest.raises(TargetNotSynced):
        LiveTargets(pg).get("default")


@pytest.mark.integration
def test_inert_target_is_missing(pg: PgPublishTargetStore) -> None:
    """A copy restore's external targets of the backup stay as inert rows (foreign keys):
    nothing can use them, so to the worker they do not exist."""
    pg._conn.execute(
        """INSERT INTO publish_targets
             (id, label, kind, sink_id, destination, source, inert_at, synced_at)
           VALUES ('prod-lake', 'Production lake', 'external', 's3', '{"bucket": "lake"}', 'ui',
                   now(), now())"""
    )
    with pytest.raises(TargetMissing):
        LiveTargets(pg).get("prod-lake")


@pytest.mark.integration
def test_pg_triple_store_is_read_from_its_destination(pg: PgPublishTargetStore) -> None:
    pg._conn.execute(
        """INSERT INTO publish_targets (id, label, kind, sink_id, destination, source, synced_at)
           VALUES ('rdf-default', 'Triple store', 'rdf', 'rdf', '{"dataset": "kb"}', 'env', now())"""
    )
    assert LiveTargets(pg).rdf() == Target("rdf-default", "kb", "")


class _Conn:
    def __init__(self, fail: bool) -> None:
        self.fail, self.closed = fail, False

    def execute(self, *_args: Any) -> Any:
        import psycopg

        if self.fail:
            raise psycopg.OperationalError("the connection is closed")
        return self

    def fetchone(self) -> tuple[int]:
        return (7,)

    def close(self) -> None:
        self.closed = True


def test_a_lost_connection_is_replaced_once() -> None:
    broken, fresh = _Conn(fail=True), _Conn(fail=False)
    store = PgPublishTargetStore(broken, reconnect=lambda: fresh)  # type: ignore[arg-type]
    assert store.version() == 7
    assert broken.closed


def test_without_reconnect_a_lost_connection_raises() -> None:
    import psycopg

    store = PgPublishTargetStore(_Conn(fail=True))  # type: ignore[arg-type]
    with pytest.raises(psycopg.OperationalError):
        store.version()


def test_the_worker_rides_out_a_database_restart_while_refreshing_targets() -> None:
    import psycopg

    from ingest_worker.main import refresh_targets

    class Down:
        def refresh(self) -> bool:
            raise psycopg.OperationalError("server closed the connection unexpectedly")

    class Moved:
        def refresh(self) -> bool:
            return True

    assert refresh_targets(Down()) is False  # type: ignore[arg-type]
    assert refresh_targets(Moved()) is True  # type: ignore[arg-type]


def test_fake_targets_rdf() -> None:
    assert FakeTargets({}).rdf() is None
    assert FakeTargets({}, rdf=Target("rdf-default", "ct", "")).rdf() == Target(
        "rdf-default", "ct", ""
    )
