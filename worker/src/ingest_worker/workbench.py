"""Workbench tasks (ADR 0007). `prepare`: a sample's page text after extraction and OCR,
before copy selection and segmentation, so anchors can change without re-running OCR.

Output keys and JSON shapes mirror packages/shared/src/workbench.ts (PreparedText,
PreparedTriage)."""

from __future__ import annotations

import hashlib
import json
from typing import Any

from .ocr import pages_needing_ocr
from .pipeline import DocumentError, PipelineDeps, check_cancelled, ocr_pages
from .queue import ClaimedJob, JobQueue
from .storage import prepared_text_key, prepared_triage_key


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
