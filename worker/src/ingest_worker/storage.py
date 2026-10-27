"""Object storage. Key conventions mirror packages/shared/src/storage-keys.ts."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Literal, Protocol

if TYPE_CHECKING:
    from types_boto3_s3 import S3Client


def output_key(
    spec_id: str,
    version: int,
    output_id: str,
    document_id: str,
    fmt: Literal["csv", "json", "ttl"],
) -> str:
    return f"{spec_id}/v{version}/{output_id}/{document_id}.{fmt}"


def draft_log_key(job_id: str) -> str:
    """A drafting job's model log (TS draftLogKey): every prompt, reply, tool call and result."""
    return f"{job_id}/draft-log.json"


def run_key(job_id: str, extraction_id: str, attempt: int) -> str:
    return f"{job_id}/{extraction_id}/attempt-{attempt}.json"


def ocr_run_key(job_id: str, page_number: int) -> str:
    """Raw OCR model output for a 1-based page number."""
    return f"{job_id}/ocr/page-{page_number}.md"


def ocr_cache_key(pdf_sha256: str, settings_fingerprint: str, page_number: int) -> str:
    """OCR output shared by every job of the same PDF and OCR settings (worker-internal)."""
    return f"ocr-cache/{pdf_sha256}/{settings_fingerprint}/page-{page_number}.md"


def ocr_rotation_key(text_key: str) -> str:
    """Beside an OCR output (`ocr_run_key`, `ocr_cache_key`): the clockwise degrees the page was
    turned by before it was read, when not 0 (none: upright)."""
    return text_key + ".rotation"


def converted_key(source_sha256: str, fingerprint: str) -> str:
    """The PDF a Word (.docx) source converts to, per converter version (worker-internal)."""
    return f"converted/{source_sha256}/{fingerprint}.pdf"


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


def shacl_report_key(job_id: str) -> str:
    """A job's SHACL report of its document's graph (runs bucket; ADR 0011 step 5)."""
    return f"{job_id}/shacl-report.json"


def graph_version_key(sha256: str, template_id: str, version: int) -> str:
    """One published version of a (file, document type) graph, in the target (ADR 0011)."""
    return f"graphs/{sha256}/{template_id}/v{version}.ttl"


def graph_preview_key(project_id: str, job_id: str) -> str:
    """A graph preview's Turtle per sample (runs bucket, graph task; ADR 0011)."""
    return f"graphs/{project_id}/{job_id}.json"


def plugin_preview_key(project_id: str, job_id: str) -> str:
    """A plugin step preview's result per sample (runs bucket, plugin task; recipe plugins 3c)."""
    return f"plugin-previews/{project_id}/{job_id}.json"


def decomposition_source_key(batch_id: str, item_id: str, ext: str) -> str:
    """A batch item's uploaded Word file (runs bucket; TS decompositionSourceKey)."""
    return f"decompositions/{batch_id}/{item_id}.{ext}"


def decomposition_report_key(batch_id: str, item_id: str) -> str:
    """A batch item's decomposition report flags (runs bucket; TS decompositionReportKey)."""
    return f"decompositions/{batch_id}/{item_id}.report.json"


def decomposition_held_manifest_key(batch_id: str, item_id: str) -> str:
    """A held PDF's manifest (runs bucket; TS decompositionHeldManifestKey)."""
    return f"decompositions/{batch_id}/{item_id}.held/manifest.json"


def decomposition_held_image_key(batch_id: str, item_id: str, index: int) -> str:
    """One of a held PDF's extracted images (runs bucket; TS decompositionHeldImageKey)."""
    return f"decompositions/{batch_id}/{item_id}.held/images/{index}"


def decomposition_held_page_key(batch_id: str, item_id: str, page: int) -> str:
    """One of a held PDF's rendered pages (runs bucket; TS decompositionHeldPageKey)."""
    return f"decompositions/{batch_id}/{item_id}.held/pages/{page}.jpg"


def ontology_suggestions_key(project_id: str, job_id: str) -> str:
    """A survey's or refresh's ontology suggestions (runs bucket; TS ontologySuggestionsKey)."""
    return f"ontology-suggestions/{project_id}/{job_id}.json"


def segmentation_key(project_id: str, job_id: str) -> str:
    """Section-anchor preview grid of a workbench project (runs bucket, segment task)."""
    return f"segmentation/{project_id}/{job_id}.json"


def drafting_key(project_id: str, job_id: str) -> str:
    """A drafting stage's result for a workbench project (runs bucket, draft task)."""
    return f"drafting/{project_id}/{job_id}.json"


def ontology_source_key(ontology_id: str, sha256: str, ext: str) -> str:
    """An imported ontology file, named by its bytes (runs bucket; ontologySourceKey)."""
    return f"ontologies/{ontology_id}/sources/{sha256}.{ext}"


def ontology_normalized_key(ontology_id: str, version: int) -> str:
    """A version's canonical N-Triples (runs bucket, ontology task)."""
    return f"ontologies/{ontology_id}/v{version}/normalized.nt"


def export_key(project_id: str, job_id: str) -> str:
    """A project's exported drafting bundle (runs bucket, export task)."""
    return f"exports/{project_id}/{job_id}.zip"


def step_cache_object_key(key: str) -> str:
    """A cached extract step's output, keyed by its full input (workbench, runs bucket)."""
    return f"step-cache/{key}.json"


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
    """boto3 against SeaweedFS or any S3 (path-style addressing unless told otherwise)."""

    def __init__(
        self,
        endpoint: str,
        region: str,
        access_key: str,
        secret_key: str,
        *,
        path_style: bool = True,
        sse: str = "none",
        kms_key_id: str | None = None,
        storage_class: str | None = None,
    ) -> None:
        import boto3
        from botocore.config import Config

        self._sse = sse
        self._kms_key_id = kms_key_id
        self._storage_class = storage_class
        self._client: S3Client = boto3.client(
            "s3",
            endpoint_url=endpoint,
            region_name=region,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            config=Config(
                s3={"addressing_style": "path" if path_style else "virtual"},
                retries={"mode": "standard"},
            ),
        )

    def get(self, bucket: str, key: str) -> bytes:
        return self._client.get_object(Bucket=bucket, Key=key)["Body"].read()

    def get_optional(self, bucket: str, key: str) -> bytes | None:
        try:
            return self.get(bucket, key)
        except self._client.exceptions.NoSuchKey:
            return None

    def put(self, bucket: str, key: str, body: bytes, content_type: str) -> None:
        extra: dict[str, Any] = {}
        if self._sse != "none":
            extra["ServerSideEncryption"] = self._sse
            if self._sse == "aws:kms" and self._kms_key_id:
                extra["SSEKMSKeyId"] = self._kms_key_id
        if self._storage_class:
            extra["StorageClass"] = self._storage_class
        self._client.put_object(
            Bucket=bucket, Key=key, Body=body, ContentType=content_type, **extra
        )

    def delete(self, bucket: str, key: str) -> None:
        self._client.delete_object(Bucket=bucket, Key=key)
