from __future__ import annotations

from ingest_worker.config import Settings
from ingest_worker.queue import backoff_seconds


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
