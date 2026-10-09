"""Object storage. Key conventions mirror packages/shared/src/storage-keys.ts."""

from __future__ import annotations

from typing import TYPE_CHECKING, Literal, Protocol

if TYPE_CHECKING:
    from types_boto3_s3 import S3Client


def output_key(
    spec_id: str, version: int, output_id: str, document_id: str, fmt: Literal["csv", "json"]
) -> str:
    return f"{spec_id}/v{version}/{output_id}/{document_id}.{fmt}"


def run_key(job_id: str, extraction_id: str, attempt: int) -> str:
    return f"{job_id}/{extraction_id}/attempt-{attempt}.json"


class ObjectStore(Protocol):
    def get(self, bucket: str, key: str) -> bytes: ...

    def put(self, bucket: str, key: str, body: bytes, content_type: str) -> None: ...


class MemoryObjectStore:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], tuple[bytes, str]] = {}

    def get(self, bucket: str, key: str) -> bytes:
        try:
            return self.objects[(bucket, key)][0]
        except KeyError:
            raise KeyError(f"s3://{bucket}/{key} not found") from None

    def put(self, bucket: str, key: str, body: bytes, content_type: str) -> None:
        self.objects[(bucket, key)] = (body, content_type)


class S3ObjectStore:
    """boto3 against SeaweedFS (path-style addressing)."""

    def __init__(self, endpoint: str, region: str, access_key: str, secret_key: str) -> None:
        import boto3
        from botocore.config import Config

        self._client: S3Client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            config=Config(s3={"addressing_style": "path"}, retries={"mode": "standard"}),
        )

    def get(self, bucket: str, key: str) -> bytes:
        return self._client.get_object(Bucket=bucket, Key=key)["Body"].read()

    def put(self, bucket: str, key: str, body: bytes, content_type: str) -> None:
        self._client.put_object(Bucket=bucket, Key=key, Body=body, ContentType=content_type)
