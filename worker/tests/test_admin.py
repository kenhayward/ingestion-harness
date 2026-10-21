from __future__ import annotations

from dataclasses import replace
from typing import Any

import pytest

from ingest_worker.admin import (
    backups_bucket,
    bridge_staging_bucket,
    ensure_buckets,
    target_buckets,
)
from ingest_worker.publish_targets import TargetRow


class FakeS3:
    def __init__(self, existing: list[str], failures: int = 0) -> None:
        self.buckets = list(existing)
        self.failures = failures

    def list_buckets(self) -> dict[str, Any]:
        if self.failures:
            self.failures -= 1
            raise ConnectionError("not up yet")
        return {"Buckets": [{"Name": n} for n in self.buckets]}

    def create_bucket(self, Bucket: str) -> None:
        self.buckets.append(Bucket)


def test_creates_only_missing_buckets_after_endpoint_comes_up() -> None:
    s3 = FakeS3(["inbox"], failures=2)
    created = ensure_buckets(s3, ["inbox", "outputs", "runs"], delay_s=0)
    assert created == ["outputs", "runs"]
    assert sorted(s3.buckets) == ["inbox", "outputs", "runs"]


def test_gives_up_after_max_attempts() -> None:
    with pytest.raises(ConnectionError):
        ensure_buckets(FakeS3([], failures=5), ["a"], attempts=3, delay_s=0)


def test_internal_target_buckets_come_from_the_store() -> None:
    rows = [
        row("default", "internal", "pub"),
        row("a", "internal", "pub"),
        row("b", "internal", "other"),
        row("c", "external", "lake"),
    ]
    assert target_buckets(lambda: rows, ["fallback"]) == ["pub", "other"]


def test_init_buckets_lists_internal_targets_buckets_from_their_destinations() -> None:
    rdf = TargetRow("rdf-default", "Triple store", "rdf", "rdf", {"dataset": "ct"})
    other_sink = TargetRow("hook", "Hook", "sink", "webhook", {"url": "https://x"})
    inert = replace(row("old", "internal", "gone"), inert=True)
    rows = [row("default", "internal", "pub"), rdf, other_sink, inert, row("c", "external", "lake")]
    assert target_buckets(lambda: rows, ["fallback"]) == ["pub"]


def test_target_buckets_fall_back_when_the_store_is_unavailable() -> None:
    def down() -> list[TargetRow]:
        raise ConnectionError("no database")

    assert target_buckets(down, ["fallback"]) == ["fallback"]


def test_backups_bucket_defaults_like_the_api() -> None:
    assert backups_bucket({}) == "ingest-backups"
    assert backups_bucket({"S3_BUCKET_BACKUPS": ""}) == "ingest-backups"
    assert backups_bucket({"S3_BUCKET_BACKUPS": "acme-backups"}) == "acme-backups"


def row(id: str, kind: str, bucket: str) -> TargetRow:
    return TargetRow(
        id=id,
        label=id,
        kind=kind,  # type: ignore[arg-type]
        sink_id="s3",
        destination={"bucket": bucket, "prefix": "", "layout": ""},
    )


@pytest.mark.parametrize(
    ("env", "expected"),
    [({}, "ingest-bridge"), ({"BRIDGE_STAGING_BUCKET": ""}, "ingest-bridge"),
     ({"BRIDGE_STAGING_BUCKET": "staging"}, "staging")],
)  # fmt: skip
def test_the_bridge_staging_bucket_is_created_too(env: dict[str, str], expected: str) -> None:
    assert bridge_staging_bucket(env) == expected
