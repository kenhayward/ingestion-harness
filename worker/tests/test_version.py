from __future__ import annotations

import pytest

from ingest_worker.version import app_version


@pytest.mark.parametrize(
    ("value", "expected"),
    [("2026.10.17.3", "2026.10.17.3"), (None, "dev"), ("", "dev")],
)
def test_app_version_reads_the_build_arg(
    monkeypatch: pytest.MonkeyPatch, value: str | None, expected: str
) -> None:
    if value is None:
        monkeypatch.delenv("APP_VERSION", raising=False)
    else:
        monkeypatch.setenv("APP_VERSION", value)
    assert app_version() == expected
