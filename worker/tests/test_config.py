"""Worker settings from the environment."""

from __future__ import annotations

import pytest

from ingest_worker.config import Settings

REQUIRED = {
    "DATABASE_URL": "postgres://x",
    "S3_ENDPOINT": "http://s3",
    "S3_ACCESS_KEY": "a",
    "S3_SECRET_KEY": "s",
}


@pytest.mark.parametrize(
    ("value", "expected"),
    [(None, None), ("", None), ("http://converter:3000", "http://converter:3000")],
)
def test_converter_url_is_optional(value: str | None, expected: str | None) -> None:
    env = dict(REQUIRED) if value is None else {**REQUIRED, "CONVERTER_URL": value}
    assert Settings.from_env(env).converter_url == expected
