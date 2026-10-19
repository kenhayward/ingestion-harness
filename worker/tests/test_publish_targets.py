"""Publishing targets in the worker: seeding from .env, and reading them (their credentials
live on the delivery bridge).

The seed and prefix cases come from the fixture the API's tests read too."""

from __future__ import annotations

import json
import os
from collections.abc import Iterator
from dataclasses import replace
from typing import Any

import pytest

from ingest_worker.config import REPO_ROOT
from ingest_worker.pipeline import DocumentError, Target
from ingest_worker.publish_targets import (
    DefaultSeed,
    LiveTargets,
    PgPublishTargetStore,
    TargetMissing,
    TargetRow,
    default_seed,
    normalise_prefix,
)

from .fakes import FakeTargets, MemoryPublishTargetStore

FIXTURES = REPO_ROOT / "packages" / "shared" / "test" / "fixtures"
FIXTURE = json.loads((FIXTURES / "publish-targets.json").read_text(encoding="utf-8"))
SECRET_FIXTURE = json.loads((FIXTURES / "llm-secret.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", FIXTURE["prefixes"], ids=lambda c: repr(c["input"]))
def test_normalise_prefix_matches_the_shared_fixture(case: dict[str, str]) -> None:
    assert normalise_prefix(case["input"]) == case["expected"]


@pytest.mark.parametrize("case", FIXTURE["seed"], ids=lambda c: str(c["name"]))
def test_default_seed_matches_the_shared_fixture(case: dict[str, Any]) -> None:
    e = case["expected"]
    assert default_seed(case["env"]) == DefaultSeed(
        kind=e["kind"],
        bucket=e["bucket"],
        prefix=e["prefix"],
        endpoint=e["endpoint"],
        region=e["region"],
        access_key_env=e["accessKeyEnv"],
        secret_key_env=e["secretKeyEnv"],
        force_path_style=e["forcePathStyle"],
    )


def row(**kw: Any) -> TargetRow:
    base = TargetRow(
        id="default",
        label="Default",
        kind="internal",
        bucket="ingest-published",
        prefix="",
        endpoint=None,
        region=None,
        access_key_id=None,
        secret_key_enc=None,
        access_key_env=None,
        secret_key_env=None,
        path_style=True,
        sse="none",
        kms_key_id=None,
        storage_class=None,
        seeded_at=None,
    )
    return replace(base, **kw)


def live(rows: list[TargetRow]) -> tuple[LiveTargets, MemoryPublishTargetStore]:
    store = MemoryPublishTargetStore(rows)
    return LiveTargets(store), store


def test_a_target_is_its_id_bucket_and_prefix_only() -> None:
    targets, _ = live([row(prefix="pvp/")])
    assert targets.get("default") == Target("default", "ingest-published", "pvp/")


def test_an_unknown_target_is_missing_never_the_default() -> None:
    targets, _ = live([row()])
    with pytest.raises(TargetMissing, match="no publishing target gone"):
        targets.get("gone")
    assert issubclass(TargetMissing, DocumentError)


def test_refresh_reloads_only_when_the_version_moved() -> None:
    targets, store = live([row()])
    targets.get("default")
    assert targets.refresh() is False
    store.set_rows([row(bucket="moved")])
    assert targets.refresh() is True
    assert targets.get("default").bucket == "moved"


def test_get_refreshes_before_resolving() -> None:
    targets, store = live([row()])
    assert targets.get("default").bucket == "ingest-published"
    store.set_rows([row(bucket="moved")])
    assert targets.get("default").bucket == "moved"


def test_memory_store_seeds_once() -> None:
    store = MemoryPublishTargetStore([row()])
    seed = default_seed({"S3_ENDPOINT": "e", "S3_ACCESS_KEY": "k", "S3_SECRET_KEY": "s"})
    assert store.seed_default(seed) == "seeded"
    assert store.seed_default(seed) == "kept"
    assert store.seed_default(replace(seed, bucket="other")) == "differs"
    assert store.load()[0].bucket == "ingest-published"


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
    conn.execute("DELETE FROM publish_targets WHERE id <> 'default'")
    conn.execute(
        "UPDATE publish_targets SET seeded_at = NULL, kind = 'internal',"
        " bucket = 'ingest-published', prefix = '', endpoint = NULL WHERE id = 'default'"
    )
    yield PgPublishTargetStore(conn)
    conn.close()


@pytest.mark.integration
def test_pg_store_seeds_the_default_once_and_moves_the_version(pg: PgPublishTargetStore) -> None:
    before = pg.version()
    seed = default_seed(
        {
            "S3_ENDPOINT": "http://seaweed:8333",
            "S3_ACCESS_KEY": "k",
            "S3_SECRET_KEY": "s",
            "TARGET_S3_PREFIX": "pvp",
        }
    )
    assert pg.seed_default(seed) == "seeded"
    assert pg.version() > before
    [r] = [r for r in pg.load() if r.id == "default"]
    assert (r.kind, r.prefix, r.seeded_at is not None, r.path_style) == (
        "internal",
        "pvp",  # verbatim, as .env had it
        True,
        True,
    )

    after = pg.version()
    assert pg.seed_default(seed) == "kept"
    assert pg.version() == after
    assert pg.seed_default(replace(seed, bucket="other")) == "differs"
    assert pg.version() == after


@pytest.mark.integration
def test_inert_target_is_missing(pg: PgPublishTargetStore) -> None:
    """A copy restore's external targets of the backup stay as inert rows (foreign keys):
    nothing can use them, so to the worker they do not exist."""
    pg._conn.execute(
        """INSERT INTO publish_targets (id, label, kind, bucket, endpoint, region, source, inert_at)
           VALUES ('prod-lake', 'Production lake', 'external', 'lake', 'https://s3.example',
                   'eu-west-1', 'ui', now())"""
    )
    assert "prod-lake" not in [r.id for r in pg.load()]
    with pytest.raises(TargetMissing):
        LiveTargets(pg).get("prod-lake")


def test_seeding_reports_the_fields_env_now_disagrees_on() -> None:
    from ingest_worker.publish_targets import seed_default_target

    store = MemoryPublishTargetStore([row()])
    env = {"S3_ENDPOINT": "e", "S3_ACCESS_KEY": "k", "S3_SECRET_KEY": "s"}
    assert seed_default_target(store, env) == []  # seeded
    assert seed_default_target(store, env) == []  # kept
    moved = {**env, "TARGET_S3_BUCKET": "other", "TARGET_S3_PREFIX": "p"}
    assert seed_default_target(store, moved) == ["bucket", "prefix"]
    assert store.load()[0].bucket == "ingest-published"  # the database wins


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
