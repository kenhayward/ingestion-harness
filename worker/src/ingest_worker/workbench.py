"""Workbench tasks (ADR 0007). `prepare`: a sample's page text after extraction and OCR,
before copy selection and segmentation, so anchors can change without re-running OCR.

Output keys and JSON shapes mirror packages/shared/src/workbench.ts (PreparedText,
PreparedTriage)."""

from __future__ import annotations

import json
import logging
import multiprocessing
import re
import signal
from bisect import bisect_right
from multiprocessing.connection import Connection
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator
from pypdf.errors import FileNotDecryptedError, PdfReadError, WrongPasswordError

from .anchor_hints import suggest_anchor
from .convert import ConversionRejected
from .ocr import pages_needing_ocr
from .pipeline import PREPARE_PROGRESS as PREPARE_PROGRESS  # re-exported: the Samples tab's
from .pipeline import (
    DocumentError,
    JobCancelled,
    PipelineDeps,
    check_cancelled,
    load_source,
    mark_pages,
    ocr_pages,
)
from .queue import ClaimedJob, JobQueue
from .segment import PAGE_BREAK, section_spans, select_copy
from .specs import CopySelection, Section
from .storage import prepared_text_key, prepared_triage_key, segmentation_key

log = logging.getLogger("ingest_worker")

#: Longest matched line returned to the UI.
LINE_LIMIT = 200


#: Job event the API reads for the Samples tab (TS: PREPARE_FAILED_EVENT). Progress is
#: `pipeline.PREPARE_PROGRESS` (TS: PREPARE_PROGRESS_EVENT), shared with production jobs.
PREPARE_FAILED = "prepare failed"

#: TS: PREPARE_ERROR_CODES (packages/shared/src/workbench.ts).
PrepareErrorCode = Literal["password", "corrupt", "too_large", "other"]


class PrepareFailed(DocumentError):
    """A sample that cannot be prepared, with the reason's code for the Samples tab."""

    def __init__(self, code: PrepareErrorCode, message: str) -> None:
        super().__init__(message)
        self.code: PrepareErrorCode = code


def prepare_error_code(exc: DocumentError) -> PrepareErrorCode:
    """The Samples tab's reason for a failed preparation."""
    if isinstance(exc, PrepareFailed):
        return exc.code
    cause = exc.__cause__
    if isinstance(cause, ConversionRejected):
        return "too_large" if cause.status == 413 else "corrupt"
    return "other"


def _extract(deps: PipelineDeps, pdf: bytes) -> list[str]:
    """The text layer; a PDF pypdf cannot open is a property of the file (needs review)."""
    try:
        return deps.extract_text(pdf)
    except (FileNotDecryptedError, WrongPasswordError) as exc:
        raise PrepareFailed("password", "PDF is password-protected") from exc
    except PdfReadError as exc:
        raise PrepareFailed("corrupt", f"PDF could not be read: {exc}") from exc


def _quietly(
    job: ClaimedJob,
    level: Literal["info", "warn"],
    message: str,
    data: dict[str, Any],
    queue: JobQueue,
) -> None:
    """Progress is advisory: a failed event write (job deleted mid-run, database blip) must
    neither replace the DocumentError being raised nor abort a good preparation."""
    try:
        queue.event(job.id, level, message, data)
    except Exception:
        log.exception("could not record %r for job %s", message, job.id)


def prepare_sample(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> dict[str, Any]:
    """Extract and OCR (mode auto) one sample (a PDF, or a .docx converted to PDF); write its
    text and triage to the runs bucket, keyed by the sha256 of the uploaded file. Returns the
    triage. Reports `prepare progress` events as it goes; a sample that cannot be prepared
    records a `prepare failed` event (code and message, the message being the review reason)
    before the DocumentError reaches run_once."""
    try:
        return _prepare(job, deps, queue)
    except DocumentError as exc:
        data = {"code": prepare_error_code(exc), "message": str(exc)}
        _quietly(job, "warn", PREPARE_FAILED, data, queue)
        raise


def _prepare(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> dict[str, Any]:
    def report(stage: Literal["text", "ocr"], page: int, of: int) -> None:
        data = {"stage": stage, "page": page, "of": of}
        _quietly(job, "info", PREPARE_PROGRESS, data, queue)

    source = load_source(job, deps, queue)
    pdf, sha256 = source.pdf, source.sha256
    pages = _extract(deps, pdf)
    report("text", len(pages), len(pages))
    ocr_numbers = (
        [i + 1 for i in pages_needing_ocr(pages, "auto", deps.ocr.min_chars)] if deps.ocr else []
    )
    pages = ocr_pages(
        job,
        deps,
        queue,
        pdf,
        pages,
        "auto",
        sha256=sha256,
        progress=lambda done, total: report("ocr", done, total),
    )
    if not any(p.strip() for p in pages):
        hint = "OCR is not configured" if deps.ocr is None else "OCR returned no text"
        raise DocumentError(f"no extractable text (scanned/image-only PDF?); {hint}")
    check_cancelled(job, queue)

    text = {
        "sha256": sha256,
        "pages": [
            {"number": i + 1, "text": page, "ocr": i + 1 in ocr_numbers}
            for i, page in enumerate(pages)
        ],
    }
    triage: dict[str, Any] = {
        "sha256": sha256,
        "pageCount": len(pages),
        "ocrPages": ocr_numbers,
        "chars": sum(len(page) for page in pages),
        "ocrModel": deps.ocr.model if deps.ocr and ocr_numbers else None,
    }
    runs = deps.buckets.runs
    deps.store.put(runs, prepared_text_key(sha256), json.dumps(text).encode(), "application/json")
    deps.store.put(
        runs, prepared_triage_key(sha256), json.dumps(triage).encode(), "application/json"
    )
    queue.event(job.id, "info", "prepared", {"pages": len(pages), "ocr_pages": ocr_numbers})
    return triage


class SegmentDocument(BaseModel):
    """The candidate `document` block a preview applies (TS: SegmentDocumentSchema)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    sections: list[Section] = Field(min_length=1)
    copies: CopySelection | None = None
    page_markers: bool = Field(default=True, alias="pageMarkers")

    @model_validator(mode="after")
    def _unique_section_ids(self) -> SegmentDocument:
        seen: set[str] = set()
        for section in self.sections:
            if section.id in seen:
                raise ValueError(f"duplicate section id {section.id}")
            seen.add(section.id)
        return self


def _regex_error(pattern: str) -> str | None:
    try:
        re.compile(pattern, re.MULTILINE)
    except re.error as exc:
        return str(exc)
    return None


def _line_at(text: str, pos: int) -> str:
    start = text.rfind("\n", 0, pos) + 1
    end = text.find("\n", pos)
    return text[start : len(text) if end == -1 else end].strip()[:LINE_LIMIT]


def segment_samples(
    samples: list[tuple[str, list[str] | None]], document: SegmentDocument
) -> dict[str, Any]:
    """The preview grid (TS: SegmentationResult) for (sample id, prepared pages or None).

    Same steps as prepare_document: copy selection, page markers, then section_spans, so the
    grid shows exactly where production segmentation would cut. Invalid anchors are reported in
    anchorErrors and skipped; they never fail the preview. The grid also carries `suggestions`
    (anchor_hints) for required sections that miss a sample."""
    anchor_errors: dict[str, str] = {}
    for section in document.sections:
        if (error := _regex_error(section.anchor)) is not None:
            anchor_errors[section.id] = error
    copies = document.copies
    if copies is not None and (error := _regex_error(copies.anchor)) is not None:
        anchor_errors["copies"] = error
        copies = None
    valid = [s for s in document.sections if s.id not in anchor_errors]
    required = [s.id for s in valid if s.required]

    rows: list[dict[str, Any]] = []
    suggestions: list[dict[str, Any]] = []
    found_in: dict[str, list[str]] = {}  # section id -> texts where its anchor matched
    for sample_id, pages in samples:
        if not pages:
            rows.append(
                {
                    "sampleId": sample_id,
                    "firstPage": 1,
                    "pageCount": 0,
                    "error": "not prepared" if pages is None else "no pages",
                    "missingRequired": [],
                    "sections": [],
                }
            )
            continue
        first, kept = select_copy(pages, copies) if copies else (0, pages)
        if document.page_markers:
            kept = mark_pages(kept, first + 1)
        text = PAGE_BREAK.join(kept)
        page_starts: list[int] = []
        offset = 0
        for page in kept:
            page_starts.append(offset)
            offset += len(page) + len(PAGE_BREAK)
        spans, unmatched = section_spans(text, valid)
        by_id = {span.id: span for span in spans}
        for span_id in by_id:
            found_in.setdefault(span_id, []).append(text)
        cells: list[dict[str, Any]] = []
        for section in document.sections:
            span = by_id.get(section.id)
            if span is None:
                cells.append(
                    {"id": section.id, "found": False, "page": None, "line": None, "chars": 0}
                )
                continue
            body = text[span.start : span.end].strip()
            cells.append(
                {
                    "id": section.id,
                    "found": True,
                    "page": first + bisect_right(page_starts, span.start),
                    "line": _line_at(text, span.start),
                    "chars": len(body),
                }
            )
        rows.append(
            {
                "sampleId": sample_id,
                "firstPage": first + 1,
                "pageCount": len(kept),
                "error": None,
                "missingRequired": [i for i in unmatched if i in required],
                "sections": cells,
            }
        )
        for section in valid:
            if section.required and section.id in unmatched:
                hint = suggest_anchor(section.anchor, text)
                if hint is not None:
                    suggestions.append(
                        {
                            "section": section.id,
                            "sampleId": sample_id,
                            "anchor": hint[0],
                            "reason": hint[1],
                        }
                    )
    # A suggestion must not break a sample where the section was found: drop any that misses one.
    suggestions = [
        s
        for s in suggestions
        if all(re.search(s["anchor"], t, re.MULTILINE) for t in found_in.get(s["section"], []))
    ]
    return {"anchorErrors": anchor_errors, "samples": rows, "suggestions": suggestions}


class SegmentSample(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    sample_id: str = Field(alias="sampleId")
    sha256: str


class SegmentParams(BaseModel):
    """jobs.params of a segment job (written by the API)."""

    model_config = ConfigDict(extra="forbid", populate_by_name=True, frozen=True)

    samples: list[SegmentSample]
    document: SegmentDocument


#: Longest a segmentation preview may run before its child process is killed.
SEGMENT_TIMEOUT_S = 10.0


def _segment_child(
    conn: Connection, samples: list[tuple[str, list[str] | None]], document: dict[str, Any]
) -> None:
    """Child-process entry point (module level so 'spawn' can import it)."""
    # A forked child inherits the worker's graceful-stop handlers, which would ignore terminate().
    for name in ("SIGTERM", "SIGINT"):
        if hasattr(signal, name):
            signal.signal(getattr(signal, name), signal.SIG_DFL)
    conn.send(segment_samples(samples, SegmentDocument.model_validate(document)))
    conn.close()


def segment_with_timeout(
    samples: list[tuple[str, list[str] | None]],
    document: SegmentDocument,
    timeout_s: float = SEGMENT_TIMEOUT_S,
) -> dict[str, Any]:
    """segment_samples in a child process; a runaway regex is killed after `timeout_s`."""
    method = "fork" if "fork" in multiprocessing.get_all_start_methods() else "spawn"
    ctx: Any = multiprocessing.get_context(method)  # typeshed: BaseContext has no Process
    parent, child = ctx.Pipe(duplex=False)
    proc = ctx.Process(
        target=_segment_child,
        args=(child, samples, document.model_dump(by_alias=True)),
        daemon=True,
    )
    try:
        proc.start()
        child.close()
        if not parent.poll(timeout_s):
            raise DocumentError(
                f"preview took longer than {timeout_s:g}s; an anchor may backtrack catastrophically"
            )
        try:
            result: dict[str, Any] = parent.recv()
        except EOFError as exc:
            raise DocumentError("preview process failed") from exc
        return result
    finally:
        if proc.is_alive():
            proc.terminate()
            proc.join(5)
            if proc.is_alive():
                proc.kill()
        if proc.pid is not None:
            proc.join()
        child.close()
        parent.close()


def _prepared_pages(deps: PipelineDeps, sha256: str) -> list[str] | None:
    raw = deps.store.get_optional(deps.buckets.runs, prepared_text_key(sha256))
    if raw is None:
        return None
    pages: list[dict[str, Any]] = json.loads(raw)["pages"]
    return [str(p["text"]) for p in pages]


def run_segment(
    job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, *, timeout_s: float = SEGMENT_TIMEOUT_S
) -> dict[str, Any]:
    """Apply the job's candidate anchors to every listed sample; write and return the grid.

    A newer preview deletes this job's row and result object while it runs, so cancellation is
    checked before the write and again after it (removing the object this run just wrote)."""
    try:
        params = SegmentParams.model_validate(job.params or {})
    except ValidationError as exc:
        raise DocumentError(f"invalid segment parameters: {exc}") from exc
    if job.project_id is None:
        raise DocumentError("segment job without a project")
    grid = segment_with_timeout(
        [(s.sample_id, _prepared_pages(deps, s.sha256)) for s in params.samples],
        params.document,
        timeout_s,
    )
    check_cancelled(job, queue)
    key = segmentation_key(job.project_id, job.id)
    deps.store.put(deps.buckets.runs, key, json.dumps(grid).encode(), "application/json")
    if queue.is_cancelled(job):
        deps.store.delete(deps.buckets.runs, key)
        raise JobCancelled(job.id)
    return grid
