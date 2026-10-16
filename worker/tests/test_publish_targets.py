"""Publishing targets in the worker: seeding from .env, live stores, credential rules.

The seed and prefix cases come from the fixture the API's tests read too."""

from __future__ import annotations

import base64
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
    S3Settings,
    TargetMissing,
    TargetRow,
    default_seed,
    normalise_prefix,
)
from ingest_worker.storage import MemoryObjectStore

from .fakes import FakeTargets, MemoryPublishTargetStore

FIXTURES = REPO_ROOT / "packages" / "shared" / "test" / "fixtures"
FIXTURE = json.loads((FIXTURES / "publish-targets.json").read_text(encoding="utf-8"))
SECRET_FIXTURE = json.loads((FIXTURES / "llm-secret.json").read_text(encoding="utf-8"))

INTERNAL = S3Settings("http://seaweed:8333", "us-east-1", "k", "s")


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


class Spy:
    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def __call__(
        self, endpoint: str, region: str, access_key: str, secret_key: str, **kw: Any
    ) -> Any:
        self.calls.append(
            {
                "endpoint": endpoint,
                "region": region,
                "access_key": access_key,
                "secret_key": secret_key,
                **kw,
            }
        )
        return MemoryObjectStore()


def live(
    rows: list[TargetRow], env: dict[str, str] | None = None
) -> tuple[LiveTargets, MemoryPublishTargetStore, Spy]:
    store = MemoryPublishTargetStore(rows)
    spy = Spy()
    return LiveTargets(store, INTERNAL, env or {}, make=spy), store, spy


def test_internal_target_uses_the_workers_own_connection() -> None:
    targets, _, spy = live([row(prefix="pvp/")])
    t = targets.get("default")
    assert (t.id, t.bucket, t.prefix) == ("default", "ingest-published", "pvp/")
    assert spy.calls == [
        {
            "endpoint": "http://seaweed:8333",
            "region": "us-east-1",
            "access_key": "k",
            "secret_key": "s",
            "path_style": True,
            "sse": "none",
            "kms_key_id": None,
            "storage_class": None,
        }
    ]


def test_external_target_passes_its_options_and_defaults_the_endpoint() -> None:
    r = row(
        id="lake",
        label="Lake",
        kind="external",
        bucket="lake",
        region="eu-west-2",
        access_key_id="AK",
        secret_key_env="S3_SECRET_KEY",
        path_style=False,
        sse="aws:kms",
        kms_key_id="kms-1",
        storage_class="STANDARD_IA",
    )
    targets, _, spy = live([row(), r], {"S3_SECRET_KEY": "envsecret"})
    targets.get("lake")
    assert spy.calls == [
        {
            "endpoint": "https://s3.eu-west-2.amazonaws.com",
            "region": "eu-west-2",
            "access_key": "AK",
            "secret_key": "envsecret",
            "path_style": False,
            "sse": "aws:kms",
            "kms_key_id": "kms-1",
            "storage_class": "STANDARD_IA",
        }
    ]


def test_seeded_default_reads_its_keys_from_the_named_variables() -> None:
    r = row(
        kind="external",
        endpoint="https://s3.example.com",
        region="eu-west-2",
        access_key_env="TARGET_S3_ACCESS_KEY",
        secret_key_env="TARGET_S3_SECRET_KEY",
    )
    targets, _, spy = live([r], {"TARGET_S3_ACCESS_KEY": "ak", "TARGET_S3_SECRET_KEY": "sk"})
    targets.get("default")
    assert (spy.calls[0]["access_key"], spy.calls[0]["secret_key"]) == ("ak", "sk")


def test_each_credential_half_resolves_independently() -> None:
    r = row(
        kind="external",
        endpoint="https://s3.example.com",
        region="r",
        access_key_id="stored-ak",
        secret_key_env="TARGET_S3_SECRET_KEY",
    )
    targets, _, spy = live([r], {"TARGET_S3_SECRET_KEY": "sk"})
    targets.get("default")
    assert (spy.calls[0]["access_key"], spy.calls[0]["secret_key"]) == ("stored-ak", "sk")


def test_a_stored_secret_is_decrypted_with_the_master_key() -> None:
    r = row(
        kind="external",
        endpoint="https://s3.example.com",
        region="r",
        access_key_id="ak",
        secret_key_enc=SECRET_FIXTURE["ciphertext"],
    )
    targets, _, spy = live([r], {"LLM_SECRETS_KEY": SECRET_FIXTURE["key"]})
    targets.get("default")
    assert spy.calls[0]["secret_key"] == SECRET_FIXTURE["plaintext"]


def test_an_undecryptable_secret_is_a_document_error() -> None:
    r = row(
        label="Lake",
        kind="external",
        endpoint="https://s3.example.com",
        region="r",
        access_key_id="ak",
        secret_key_enc="v1:" + base64.b64encode(b"x" * 40).decode(),
    )
    targets, _, _ = live([r], {"LLM_SECRETS_KEY": base64.b64encode(b"k" * 32).decode()})
    with pytest.raises(DocumentError, match="cannot decrypt the secret of Lake"):
        targets.get("default")


def test_a_stored_secret_without_a_master_key_is_a_document_error() -> None:
    r = row(
        label="Lake",
        kind="external",
        endpoint="https://s3.example.com",
        region="r",
        access_key_id="ak",
        secret_key_enc=SECRET_FIXTURE["ciphertext"],
    )
    targets, _, _ = live([r])
    with pytest.raises(DocumentError, match="cannot decrypt the secret of Lake"):
        targets.get("default")


def test_missing_credentials_are_a_document_error() -> None:
    r = row(label="Lake", kind="external", endpoint="https://s3.example.com", region="r")
    targets, _, _ = live([r])
    with pytest.raises(DocumentError, match="Lake has no credentials"):
        targets.get("default")


@pytest.mark.parametrize("field", ["access_key_env", "secret_key_env"])
def test_only_the_seeded_variables_may_be_read(field: str) -> None:
    kw: dict[str, Any] = {"access_key_id": "ak", "secret_key_env": "S3_SECRET_KEY"}
    kw[field] = "DATABASE_URL"
    r = row(label="Lake", kind="external", endpoint="https://s3.example.com", region="r", **kw)
    targets, _, _ = live([r], {"DATABASE_URL": "postgres://secret", "S3_SECRET_KEY": "s"})
    with pytest.raises(DocumentError, match="Lake names an unsupported credential variable"):
        targets.get("default")


def test_an_unknown_target_is_missing_never_the_default() -> None:
    targets, _, _ = live([row()])
    with pytest.raises(TargetMissing, match="no publishing target gone"):
        targets.get("gone")
    assert issubclass(TargetMissing, DocumentError)


def test_refresh_rebuilds_only_when_the_version_moved() -> None:
    targets, store, spy = live([row()])
    targets.get("default")
    assert targets.refresh() is False
    targets.get("default")
    assert len(spy.calls) == 1  # cached

    store.set_rows([row(bucket="moved")])
    assert targets.refresh() is True
    assert targets.get("default").bucket == "moved"
    assert len(spy.calls) == 2


def test_get_refreshes_before_resolving() -> None:
    targets, store, _ = live([row()])
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
    t = Target(MemoryObjectStore(), "b", "p/", "x")
    assert FakeTargets({"x": t}).get("x") is t
    with pytest.raises(TargetMissing):
        FakeTargets({}).get("y")


def test_target_keeps_positional_construction_and_defaults_its_id() -> None:
    t = Target(MemoryObjectStore(), "published")
    assert (t.id, t.prefix) == ("default", "")


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
        "pvp/",
        True,
        True,
    )

    after = pg.version()
    assert pg.seed_default(seed) == "kept"
    assert pg.version() == after
    assert pg.seed_default(replace(seed, bucket="other")) == "differs"
    assert pg.version() == after
