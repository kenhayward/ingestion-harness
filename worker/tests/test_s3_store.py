"""S3ObjectStore request shape against a stub boto3 client (no network)."""

from __future__ import annotations

from typing import Any

import pytest

from ingest_worker.storage import S3ObjectStore


class StubClient:
    def __init__(self) -> None:
        self.puts: list[dict[str, Any]] = []

    def put_object(self, **kw: Any) -> None:
        self.puts.append(kw)


@pytest.fixture
def made(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    import boto3

    seen: dict[str, Any] = {"client": StubClient()}

    def client(service: str, **kw: Any) -> StubClient:
        seen.update(kw)
        return seen["client"]  # type: ignore[no-any-return]

    monkeypatch.setattr(boto3, "client", client)
    return seen


def test_defaults_keep_path_style_and_send_no_extra_put_options(made: dict[str, Any]) -> None:
    store = S3ObjectStore("http://s", "us-east-1", "k", "s")
    assert made["config"].s3 == {"addressing_style": "path"}
    store.put("b", "k", b"x", "text/csv")
    assert made["client"].puts == [
        {"Bucket": "b", "Key": "k", "Body": b"x", "ContentType": "text/csv"}
    ]


def test_virtual_addressing_when_not_path_style(made: dict[str, Any]) -> None:
    S3ObjectStore("http://s", "r", "k", "s", path_style=False)
    assert made["config"].s3 == {"addressing_style": "virtual"}


def test_sse_kms_and_storage_class_apply_to_put_only_when_set(made: dict[str, Any]) -> None:
    store = S3ObjectStore(
        "http://s", "r", "k", "s", sse="aws:kms", kms_key_id="kms-1", storage_class="STANDARD_IA"
    )
    store.put("b", "k", b"x", "text/csv")
    assert made["client"].puts[0] == {
        "Bucket": "b",
        "Key": "k",
        "Body": b"x",
        "ContentType": "text/csv",
        "ServerSideEncryption": "aws:kms",
        "SSEKMSKeyId": "kms-1",
        "StorageClass": "STANDARD_IA",
    }


def test_aes256_sets_no_key_id(made: dict[str, Any]) -> None:
    S3ObjectStore("http://s", "r", "k", "s", sse="AES256").put("b", "k", b"x", "t")
    assert made["client"].puts[0]["ServerSideEncryption"] == "AES256"
    assert "SSEKMSKeyId" not in made["client"].puts[0]
