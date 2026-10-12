from __future__ import annotations

import threading

from ingest_worker.config import Settings
from ingest_worker.main import idle
from ingest_worker.queue import backoff_seconds

from .fakes import FakeQueue


def test_backoff_grows_quadratically_and_caps() -> None:
    assert [backoff_seconds(n) for n in (1, 2, 3)] == [30, 120, 270]
    assert backoff_seconds(100) == 1800


def test_settings_require_core_env() -> None:
    import pytest

    with pytest.raises(ValueError, match="DATABASE_URL"):
        Settings.from_env({})
    s = Settings.from_env(
        {
            "DATABASE_URL": "postgres://x",
            "S3_ENDPOINT": "http://s3",
            "S3_ACCESS_KEY": "a",
            "S3_SECRET_KEY": "b",
        }
    )
    assert s.bucket_runs == "ingest-runs"
    assert s.specs_dir.name == "specs"


def test_target_defaults_to_the_same_s3_with_a_published_bucket() -> None:
    base = {
        "DATABASE_URL": "postgres://x",
        "S3_ENDPOINT": "http://s3",
        "S3_ACCESS_KEY": "a",
        "S3_SECRET_KEY": "b",
    }
    s = Settings.from_env(base)
    assert (s.target_endpoint, s.target_bucket, s.target_prefix) == (
        "http://s3",
        "ingest-published",
        "",
    )
    assert (s.target_access_key, s.target_secret_key) == ("a", "b")

    elsewhere = Settings.from_env(
        {
            **base,
            "TARGET_S3_ENDPOINT": "https://s3.eu-west-2.amazonaws.com",
            "TARGET_S3_ACCESS_KEY": "AK",
            "TARGET_S3_SECRET_KEY": "SK",
            "TARGET_S3_BUCKET": "lake",
            "TARGET_S3_PREFIX": "ingest/",
            "TARGET_S3_REGION": "eu-west-2",
        }
    )
    assert (
        elsewhere.target_endpoint,
        elsewhere.target_bucket,
        elsewhere.target_prefix,
        elsewhere.target_region,
    ) == ("https://s3.eu-west-2.amazonaws.com", "lake", "ingest/", "eu-west-2")


def test_idle_waits_for_work_with_the_poll_interval() -> None:
    queue = FakeQueue()
    idle(queue, threading.Event(), 2.0)
    assert queue.waits == [2.0]


def test_idle_does_not_wait_once_stopping() -> None:
    queue = FakeQueue()
    stop = threading.Event()
    stop.set()
    idle(queue, stop, 2.0)
    assert queue.waits == []
