"""Workbench tasks (ADR 0007). `prepare`: a sample's page text after extraction and OCR,
before copy selection and segmentation, so anchors can change without re-running OCR.

Output keys and JSON shapes mirror packages/shared/src/workbench.ts (PreparedText,
PreparedTriage)."""

from __future__ import annotations

import hashlib
import json
import re
from bisect import bisect_right
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

from .ocr import pages_needing_ocr
from .pipeline import DocumentError, PipelineDeps, check_cancelled, mark_pages, ocr_pages
from .queue import ClaimedJob, JobQueue
from .segment import PAGE_BREAK, section_spans, select_copy
from .specs import CopySelection, Section
from .storage import prepared_text_key, prepared_triage_key

#: Longest matched line returned to the UI.
LINE_LIMIT = 200


def prepare_sample(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> dict[str, Any]:
    """Extract and OCR (mode auto) one sample PDF; write its text and triage to the runs bucket.
    Returns the triage."""
    pdf = deps.store.get(job.bucket, job.object_key)
    sha256 = hashlib.sha256(pdf).hexdigest()
    pages = deps.extract_text(pdf)
    ocr_numbers = (
        [i + 1 for i in pages_needing_ocr(pages, "auto", deps.ocr.min_chars)] if deps.ocr else []
    )
    pages = ocr_pages(job, deps, queue, pdf, pages, "auto")
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
    anchorErrors and skipped; they never fail the preview."""
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
    return {"anchorErrors": anchor_errors, "samples": rows}
