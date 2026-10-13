"""Word (.docx) sources, converted to PDF before the pipeline (docs/design/word-documents.md).

The converter is a port: Gotenberg (headless LibreOffice) in deployments, a fake in tests.
"""

from __future__ import annotations

import io
import re
import zipfile
from typing import Protocol

import httpx

DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
#: The main part's content type of a .docx (not .docm, .dotx or other OOXML packages).
DOCX_MAIN_TYPE = f"{DOCX_MIME}.main+xml"
_OVERRIDE = re.compile(r"<Override\s[^>]*>")
#: Bump when the conversion request changes in a way that changes its output (cache keys).
CONVERT_VERSION = 1
#: [Content_Types].xml is a few KiB; anything bigger is not a document we accept.
_MAX_TYPES_BYTES = 1 << 20
#: Gotenberg's body when LibreOffice could not read the document (a property of the file).
_LIBREOFFICE_FAILED = b"LibreOffice failed to convert"


def is_docx(data: bytes) -> bool:
    """A Word document (.docx), judged by its content types, never by a file name."""
    if not data.startswith(b"PK\x03\x04"):
        return False
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            info = z.getinfo("[Content_Types].xml")
            if info.file_size > _MAX_TYPES_BYTES:
                return False
            types = z.read(info).decode("utf-8", errors="replace")
    except (zipfile.BadZipFile, KeyError, OSError, ValueError, EOFError):
        return False
    return any(
        _attr(tag, "PartName") == "/word/document.xml"
        and _attr(tag, "ContentType") == DOCX_MAIN_TYPE
        for tag in _OVERRIDE.findall(types)
    )


def _attr(tag: str, name: str) -> str | None:
    match = re.search(rf"\s{name}\s*=\s*[\"']([^\"']*)[\"']", tag)
    return match.group(1) if match else None


class ConversionRejected(Exception):
    """The converter could not convert this document: a property of the file (needs review)."""

    def __init__(self, message: str, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status  # the converter's HTTP status, when it answered with one


class ConverterUnavailable(Exception):
    """The converter is down, busy or slow: transient, so the job is retried."""


class DocumentConverter(Protocol):
    def to_pdf(self, docx: bytes) -> bytes: ...

    def fingerprint(self) -> str:
        """Identifies the converter version and options: part of the converted-PDF cache key."""
        ...


class GotenbergConverter:
    """Gotenberg's LibreOffice route (`POST /forms/libreoffice/convert`)."""

    def __init__(
        self, base_url: str, client: httpx.Client | None = None, timeout_s: float = 70.0
    ) -> None:
        self._base = base_url.rstrip("/")
        # Slightly above the service's own --api-timeout (60 s), so its error wins.
        self._client = client or httpx.Client(timeout=timeout_s)
        self._fingerprint: str | None = None

    def to_pdf(self, docx: bytes) -> bytes:
        try:
            response = self._client.post(
                f"{self._base}/forms/libreoffice/convert",
                files={"files": ("document.docx", docx, DOCX_MIME)},
            )
        except httpx.HTTPError as exc:
            raise ConverterUnavailable(f"converter unreachable: {exc}") from exc
        body = response.content
        if response.status_code == 200:
            if body.startswith(b"%PDF-"):
                return body
            raise ConversionRejected("the converter returned something other than a PDF")
        detail = body[:300].decode("utf-8", errors="replace").strip()
        if 400 <= response.status_code < 500 or body.startswith(_LIBREOFFICE_FAILED):
            raise ConversionRejected(
                f"{response.status_code}: {detail}", status=response.status_code
            )
        raise ConverterUnavailable(f"converter error {response.status_code}: {detail}")

    def fingerprint(self) -> str:
        if self._fingerprint is None:
            try:
                response = self._client.get(f"{self._base}/version")
                response.raise_for_status()
            except httpx.HTTPError as exc:
                raise ConverterUnavailable(f"converter unreachable: {exc}") from exc
            self._fingerprint = f"gotenberg-{response.text.strip()}-c{CONVERT_VERSION}"
        return self._fingerprint
