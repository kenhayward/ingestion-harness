"""Worker settings from the environment."""

from __future__ import annotations

import pytest

from ingest_worker.config import Settings

REQUIRED = {
    "DATABASE_URL": "postgres://x",
    "S3_ENDPOINT": "http://s3",
    "S3_ACCESS_KEY": "a",
    "S3_SECRET_KEY": "s",
    "BRIDGE_URL": "http://bridge:3100",
    "BRIDGE_CLIENT_KEY": "k" * 32,
}


@pytest.mark.parametrize(
    ("value", "expected"),
    [(None, None), ("", None), ("http://converter:3000", "http://converter:3000")],
)
def test_converter_url_is_optional(value: str | None, expected: str | None) -> None:
    env = dict(REQUIRED) if value is None else {**REQUIRED, "CONVERTER_URL": value}
    assert Settings.from_env(env).converter_url == expected


@pytest.mark.parametrize("missing", ["BRIDGE_URL", "BRIDGE_CLIENT_KEY"])
def test_the_bridge_is_required(missing: str) -> None:
    env = {k: v for k, v in REQUIRED.items() if k != missing}
    with pytest.raises(ValueError, match=missing):
        Settings.from_env(env)


def test_reads_the_bridge_settings() -> None:
    s = Settings.from_env(REQUIRED)
    assert (s.bridge_url, s.bridge_client_key) == ("http://bridge:3100", "k" * 32)


def test_targets_are_no_longer_worker_settings() -> None:
    assert not any(name.startswith("target_") for name in Settings.__dataclass_fields__)
