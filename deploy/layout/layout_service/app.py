"""The layout service: a PDF in, Docling's document out.

The analyser is injected so the HTTP behaviour is tested without Docling; only `main` (the
uvicorn factory) imports the Docling-backed one.
"""

from __future__ import annotations

from typing import Annotated, Protocol

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse

MAX_PAGES = 500
MAX_BYTES = 256 * 2**20
#: A request's time limit: this many seconds a page in its range, ...
SECONDS_PER_PAGE = 30
#: ... and never more than this.
MAX_SECONDS = 600


class AnalysisFailed(Exception):
    """The analyser could not convert this PDF (corrupt, or a page range it chokes on)."""


class DeviceUnavailable(Exception):
    """The GPU failed (out of memory, a driver error), not the PDF: another service can read it."""


def require_success(status: str, *, timed_out: bool) -> None:
    """Raises `AnalysisFailed` unless a conversion that ended with `status` (Docling's
    `ConversionStatus` value) succeeded in full: a partial document is never returned."""
    if timed_out:
        raise AnalysisFailed("timed out")
    if status != "success":
        raise AnalysisFailed(f"the conversion ended {status}")


class Analyser(Protocol):
    def page_count(self, pdf: bytes) -> int: ...

    def analyse(self, pdf: bytes, first: int, last: int, timeout: float) -> dict:
        """Docling's document for pages `first` to `last`; raises `AnalysisFailed` when the
        conversion fails, takes longer than `timeout` seconds, or is partial."""
        ...

    def fingerprint(self) -> str: ...


def create_app(
    analyser: Analyser, *, max_pages: int = MAX_PAGES, max_bytes: int = MAX_BYTES
) -> FastAPI:
    app = FastAPI(title="layout", docs_url=None, redoc_url=None, openapi_url=None)

    # Plain `def` handlers run in FastAPI's thread pool, so a long analysis does not block /health.
    @app.post("/layout", response_model=None)
    def layout(
        file: Annotated[UploadFile, File()],
        first: Annotated[int, Form()],
        last: Annotated[int, Form()],
    ) -> dict | JSONResponse:
        pdf = file.file.read(max_bytes + 1)
        if len(pdf) > max_bytes:
            raise HTTPException(413, f"larger than {max_bytes} bytes")
        if not pdf.startswith(b"%PDF-"):
            raise HTTPException(400, "not a PDF")
        try:
            pages = analyser.page_count(pdf)
        except Exception as error:
            raise HTTPException(400, "not a readable PDF") from error
        if pages > max_pages:
            raise HTTPException(413, f"{pages} pages is more than {max_pages}")
        if not 1 <= first <= last <= pages:
            raise HTTPException(422, f"pages {first} to {last} are not within 1 to {pages}")
        try:
            timeout = float(min(SECONDS_PER_PAGE * (last - first + 1), MAX_SECONDS))
            document = analyser.analyse(pdf, first, last, timeout)
        except AnalysisFailed as error:
            # 422, not 5xx: the worker retries server errors, and this PDF will fail again.
            return JSONResponse({"error": f"layout analysis failed: {error}"}, status_code=422)
        except DeviceUnavailable as error:
            # 503: the worker reads the document on its fallback service, or retries the job.
            return JSONResponse({"error": f"layout device unavailable: {error}"}, status_code=503)
        return {"pages": pages, "document": document}

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "fingerprint": analyser.fingerprint()}

    return app


def main() -> FastAPI:
    # Imported here so the tests, which never install Docling, can import this module.
    from layout_service.docling_analyser import DoclingAnalyser

    return create_app(DoclingAnalyser())
