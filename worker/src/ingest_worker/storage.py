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


def ocr_run_key(job_id: str, page_number: int) -> str:
    """Raw OCR model output for a 1-based page number."""
    return f"{job_id}/ocr/page-{page_number}.md"


def ocr_cache_key(pdf_sha256: str, settings_fingerprint: str, page_number: int) -> str:
    """OCR output shared by every job of the same PDF and OCR settings (worker-internal)."""
    return f"ocr-cache/{pdf_sha256}/{settings_fingerprint}/page-{page_number}.md"


def reviewed_document_key(job_id: str) -> str:
    """The approved document.json (edits applied) of a reviewed job, in the runs bucket."""
    return f"{job_id}/reviewed-document.json"


def page_preview_key(job_id: str, page_number: int) -> str:
    """JPEG preview of a 1-based page, shown on the review screen."""
    return f"{job_id}/pages/page-{page_number}.jpg"


def prepared_text_key(pdf_sha256: str) -> str:
    """Page text of a PDF after extraction + OCR (workbench prepare task, runs bucket)."""
    return f"prepared/{pdf_sha256}/text.json"


def prepared_triage_key(pdf_sha256: str) -> str:
    """Page count, OCR'd pages and size of a prepared PDF (runs bucket)."""
    return f"prepared/{pdf_sha256}/triage.json"


def segmentation_key(project_id: str, job_id: str) -> str:
    """Section-anchor preview grid of a workbench project (runs bucket, segment task)."""
    return f"segmentation/{project_id}/{job_id}.json"


def drafting_key(project_id: str, job_id: str) -> str:
    """A drafting stage's result for a workbench project (runs bucket, draft task)."""
    return f"drafting/{project_id}/{job_id}.json"


class ObjectStore(Protocol):
    def get(self, bucket: str, key: str) -> bytes: ...

    def get_optional(self, bucket: str, key: str) -> bytes | None: ...

    def put(self, bucket: str, key: str, body: bytes, content_type: str) -> None: ...

    def delete(self, bucket: str, key: str) -> None: ...


class MemoryObjectStore:
    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], tuple[bytes, str]] = {}

    def get(self, bucket: str, key: str) -> bytes:
        try:
            return self.objects[(bucket, key)][0]
        except KeyError:
            raise KeyError(f"s3://{bucket}/{key} not found") from None

    def get_optional(self, bucket: str, key: str) -> bytes | None:
        entry = self.objects.get((bucket, key))
        return entry[0] if entry else None

    def put(self, bucket: str, key: str, body: bytes, content_type: str) -> None:
        self.objects[(bucket, key)] = (body, content_type)

    def delete(self, bucket: str, key: str) -> None:
        self.objects.pop((bucket, key), None)


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

    def get_optional(self, bucket: str, key: str) -> bytes | None:
        try:
            return self.get(bucket, key)
        except self._client.exceptions.NoSuchKey:
            return None

    def put(self, bucket: str, key: str, body: bytes, content_type: str) -> None:
        self._client.put_object(Bucket=bucket, Key=key, Body=body, ContentType=content_type)

    def delete(self, bucket: str, key: str) -> None:
        self._client.delete_object(Bucket=bucket, Key=key)
