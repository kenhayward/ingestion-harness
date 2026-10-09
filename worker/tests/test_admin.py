from __future__ import annotations

from typing import Any

import pytest

from ingest_worker.admin import ensure_buckets


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
