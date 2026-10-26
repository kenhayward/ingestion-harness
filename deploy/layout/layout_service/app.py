"""The layout service: a PDF in, Docling's document out.

The analyser is injected so the HTTP behaviour is tested without Docling; only `main` (the
uvicorn factory) imports the Docling-backed one.
"""

from __future__ import annotations

from typing import Annotated, Protocol

from fastapi import FastAPI, File, Form, HTTPException, UploadFile

MAX_PAGES = 500
MAX_BYTES = 256 * 2**20


class Analyser(Protocol):
    def page_count(self, pdf: bytes) -> int: ...

    def analyse(self, pdf: bytes, first: int, last: int) -> dict: ...

    def fingerprint(self) -> str: ...


def create_app(
    analyser: Analyser, *, max_pages: int = MAX_PAGES, max_bytes: int = MAX_BYTES
) -> FastAPI:
    app = FastAPI(title="layout", docs_url=None, redoc_url=None, openapi_url=None)

    # Plain `def` handlers run in FastAPI's thread pool, so a long analysis does not block /health.
    @app.post("/layout")
    def layout(
        file: Annotated[UploadFile, File()],
        first: Annotated[int, Form()],
        last: Annotated[int, Form()],
    ) -> dict:
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
        return {"pages": pages, "document": analyser.analyse(pdf, first, last)}

    @app.get("/health")
    def health() -> dict:
        return {"status": "ok", "fingerprint": analyser.fingerprint()}

    return app


def main() -> FastAPI:
    # Imported here so the tests, which never install Docling, can import this module.
    from layout_service.docling_analyser import DoclingAnalyser

    return create_app(DoclingAnalyser())
