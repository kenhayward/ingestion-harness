from __future__ import annotations

import json
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .checks import run_check
from .extract import ExtractionFailedError, ExtractionResult, run_extraction
from .llm.base import LLMProvider, RefusalError
from .llm.registry import ModelRegistry, ModelResolutionError
from .ocr import (
    OcrPage,
    OcrSettings,
    PageRenderer,
    ocr_page,
    pages_needing_ocr,
    parse_olmocr,
    render_page_png,
    render_preview_jpeg,
)
from .outputs import RenderedOutput, render_outputs
from .pdf import TextExtractor
from .prompts import render_prompt
from .queue import ClaimedJob, JobQueue
from .segment import PAGE_BREAK, MissingSectionsError, segment, select_copy
from .specs import Check, DocumentLayout, Extraction, LoadedTemplate, OcrMode, SpecRegistry
from .storage import ObjectStore, ocr_run_key, run_key

#: Render size for extraction page images (same as olmOCR's training size; legible for VLMs).
PAGE_IMAGE_LONGEST_DIM = 1288


class DocumentError(Exception):
    """The document (or spec) can't be processed as-is. Not retried; job goes to needs_review."""


@dataclass
class Buckets:
    inbox: str
    outputs: str
    runs: str


@dataclass
class Target:
    """Final destination for published outputs (any S3 endpoint/bucket; keys get `prefix`)."""

    store: ObjectStore
    bucket: str
    prefix: str = ""


@dataclass
class ProcessResult:
    outputs: list[RenderedOutput]
    #: Non-empty when the document must be reviewed before publishing.
    review_reasons: list[str] = field(default_factory=list)


@dataclass
class PipelineDeps:
    store: ObjectStore
    specs: SpecRegistry
    models: ModelRegistry
    extract_text: TextExtractor
    buckets: Buckets
    #: None disables OCR: image-only documents then go to needs_review.
    ocr: OcrSettings | None = None
    render_page: PageRenderer = field(default=render_page_png)
    #: (pdf, 0-based page) -> JPEG preview for the review screen.
    render_preview: Callable[[bytes, int], bytes] = field(default=render_preview_jpeg)
    #: Where approved outputs are delivered. None: outputs stay in the outputs bucket only.
    target: Target | None = None


@dataclass
class Prepared:
    """The document after text extraction, OCR, copy selection, page markers, segmentation."""

    pdf: bytes
    total_pages: int
    sections: dict[str, str]


#: Matches the lines added by mark_pages.
PAGE_MARKER = r"^\[page \d+\]$"


def mark_pages(pages: list[str], first_page: int) -> list[str]:
    """Prefix pages with "[page N]" using original (1-based) PDF page numbers."""
    return [f"[page {first_page + i}]\n{text}" for i, text in enumerate(pages)]


def resolve_models(
    job: ClaimedJob, deps: PipelineDeps, extractions: list[Extraction]
) -> dict[str, tuple[LLMProvider, str]]:
    """Resolve every model before the first LLM call so a config error costs no tokens."""
    resolved: dict[str, tuple[LLMProvider, str]] = {}
    for ex in extractions:
        try:
            resolved[ex.id] = deps.models.resolve(job.model_override or ex.model)
        except ModelResolutionError as exc:
            raise DocumentError(f"extraction {ex.id!r}: {exc}") from exc
    return resolved


def prepare_document(
    job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, document: DocumentLayout
) -> Prepared:
    pdf = deps.store.get(job.bucket, job.object_key)
    pages = deps.extract_text(pdf)
    total_pages = len(pages)
    if document.pages and not (document.pages.min <= len(pages) <= document.pages.max):
        raise DocumentError(
            f"page count {len(pages)} outside expected range "
            f"{document.pages.min}-{document.pages.max}"
        )

    pages = _ocr_pages(job, deps, queue, pdf, pages, document.ocr)
    first = 0
    if document.copies:
        first, pages = select_copy(pages, document.copies)
        if first:
            queue.event(job.id, "info", "selected copy", {"first_page": first + 1})
    if not any(p.strip() for p in pages):
        hint = (
            "OCR is not configured"
            if deps.ocr is None
            else "OCR disabled by spec (document.ocr: never)"
            if document.ocr == "never"
            else "OCR returned no text"
        )
        raise DocumentError(f"no extractable text (scanned/image-only PDF?); {hint}")
    if getattr(document, "page_markers", False):
        pages = mark_pages(pages, first + 1)

    try:
        marker = PAGE_MARKER if getattr(document, "page_markers", False) else None
        sections = segment(pages, document.sections, page_marker=marker)
    except MissingSectionsError as exc:
        raise DocumentError(str(exc)) from exc
    queue.event(job.id, "info", "segmented", {"pages": len(pages), "sections": list(sections)})
    return Prepared(pdf, total_pages, sections)


def publish_outputs(deps: PipelineDeps, outputs: list[RenderedOutput]) -> list[RenderedOutput]:
    """Write outputs to the final target (same layout, keys prefixed). Returns what was written."""
    if deps.target is None:
        return []
    published = [replace(o, key=f"{deps.target.prefix}{o.key}") for o in outputs]
    for o in published:
        content_type = "text/csv" if o.format == "csv" else "application/json"
        deps.target.store.put(deps.target.bucket, o.key, o.body, content_type)
    return published


def process_job(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> ProcessResult:
    loaded = deps.specs.get(job.spec_id, job.spec_version)
    if isinstance(loaded, LoadedTemplate):
        from .template_pipeline import process_template_job

        return process_template_job(job, deps, queue, loaded)
    spec = loaded.spec

    resolved = resolve_models(job, deps, spec.extractions)
    doc = prepare_document(job, deps, queue, spec.document)

    results: dict[str, dict[str, Any]] = {}
    models_used: dict[str, str] = {}
    for ex in spec.extractions:
        provider, model_id = resolved[ex.id]
        images = page_images(job, deps, queue, doc.pdf, ex.page_images, doc.total_pages)
        result = run_step_extraction(
            job, deps, loaded.directory, ex, provider, model_id, doc.sections, images
        )
        results[ex.id] = result.data
        models_used[ex.id] = result.model_ref
        queue.event(
            job.id,
            "info",
            f"extracted {ex.id}",
            {"model": result.model_ref, "attempts": len(result.attempts)},
        )

    for check in spec.checks:
        results[check.id] = run_check_with_event(job, queue, check, results)

    outputs = render_outputs(
        spec,
        results,
        document_id=job.document_id,
        job_id=job.id,
        extracted_at=datetime.now(UTC).isoformat(),
        models=models_used,
    )
    for o in outputs:
        content_type = "text/csv" if o.format == "csv" else "application/json"
        deps.store.put(deps.buckets.outputs, o.key, o.body, content_type)
    return ProcessResult(outputs)


def _ocr_pages(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    pdf: bytes,
    pages: list[str],
    mode: OcrMode,
) -> list[str]:
    """Replace low-text pages with OCR output. Transient model errors propagate (retried)."""
    if deps.ocr is None:
        return pages
    targets = pages_needing_ocr(pages, mode, deps.ocr.min_chars)
    if not targets:
        return pages
    try:
        provider, model_id = deps.models.resolve(deps.ocr.model)
    except ModelResolutionError as exc:
        raise DocumentError(f"OCR model: {exc}") from exc

    settings = deps.ocr
    pages = list(pages)

    # Reuse transcriptions saved by an earlier attempt of this job (retries, crashed workers).
    cached: list[int] = []
    for index in targets:
        raw = deps.store.get_optional(deps.buckets.runs, ocr_run_key(job.id, index + 1))
        if raw is not None:
            pages[index] = parse_olmocr(raw.decode("utf-8"))[0]
            cached.append(index)
    todo = [i for i in targets if i not in cached]

    def run(index: int) -> OcrPage:
        try:
            page = ocr_page(provider, model_id, pdf, index, settings, deps.render_page)
        except RefusalError as exc:
            raise DocumentError(f"OCR page {index + 1}: {exc}") from exc
        # Saved as each page finishes, so a later failure doesn't lose completed pages.
        deps.store.put(
            deps.buckets.runs,
            ocr_run_key(job.id, index + 1),
            page.raw[-1].encode("utf-8"),
            "text/markdown",
        )
        return page

    # Pages are independent, so OCR them concurrently; results are written back in page order
    # and the first exception (transient or DocumentError) propagates.
    with ThreadPoolExecutor(max_workers=max(1, settings.concurrency)) as pool:
        for page in pool.map(run, todo):
            pages[page.index] = page.text
    queue.event(
        job.id,
        "info",
        "ocr",
        {
            "model": f"{provider.name}/{model_id}",
            "pages": [i + 1 for i in targets],
            "cached": [i + 1 for i in cached],
        },
    )
    return pages


def run_step_extraction(
    job: ClaimedJob,
    deps: PipelineDeps,
    directory: Path,
    ex: Extraction,
    provider: LLMProvider,
    model_id: str,
    sections: dict[str, str],
    images: tuple[bytes, ...],
) -> ExtractionResult:
    """Run one extraction, or one call per chunk of pages with `merge_path` arrays concatenated
    (keeps each call's output well inside the model's output token limit)."""
    plan: list[tuple[str, dict[str, str], dict[str, Any] | None]]
    if ex.chunk_pages is None:
        plan = [(ex.id, sections, None)]
    else:
        section_id = ex.sections[0]
        pages = [p.strip() for p in sections[section_id].split(PAGE_BREAK) if p.strip()]
        size = ex.chunk_pages
        groups = [PAGE_BREAK.join(pages[i : i + size]) for i in range(0, len(pages), size)] or [""]
        plan = [
            (
                f"{ex.id}.chunk-{n}",
                {**sections, section_id: text},
                {"index": n, "count": len(groups)},
            )
            for n, text in enumerate(groups, start=1)
        ]

    merged: ExtractionResult | None = None
    for audit_id, chunk_sections, chunk in plan:
        prompt = render_prompt(
            directory, ex.prompt, chunk_sections, ex.sections, chunk, ex.prompt_context
        )
        where = f" [chunk {chunk['index']}/{chunk['count']}]" if chunk else ""
        try:
            result = run_extraction(
                extraction_id=ex.id,
                provider=provider,
                model_id=model_id,
                prompt=prompt,
                schema=ex.schema_,
                max_attempts=ex.max_attempts,
                images=images,
                max_tokens=ex.max_tokens,
            )
        except ExtractionFailedError as exc:
            _audit(deps, job.id, audit_id, exc.attempts)
            raise DocumentError(f"{exc}{where}") from exc
        except RefusalError as exc:
            raise DocumentError(f"extraction {ex.id!r}{where}: {exc}") from exc
        _audit(deps, job.id, audit_id, result.attempts)
        if merged is None:
            merged = result
        else:
            assert ex.merge_path is not None  # guaranteed by spec validation
            merged.data[ex.merge_path].extend(result.data[ex.merge_path])
            merged.attempts.extend(result.attempts)
    assert merged is not None
    return merged


def page_images(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    pdf: bytes,
    page_numbers: list[int],
    total_pages: int,
) -> tuple[bytes, ...]:
    """Render the requested 1-based pages. Pages beyond the document are skipped."""
    missing = [n for n in page_numbers if n > total_pages]
    if missing:
        queue.event(job.id, "warn", "page images skipped", {"pages": missing})
    return tuple(
        deps.render_page(pdf, n - 1, PAGE_IMAGE_LONGEST_DIM, 0)
        for n in page_numbers
        if n <= total_pages
    )


def run_check_with_event(
    job: ClaimedJob, queue: JobQueue, check: Check, results: dict[str, Any]
) -> dict[str, Any]:
    result = run_check(check, results)
    unmatched = [r["value"] for r in result["rows"] if r["status"] == "unmatched"]
    if unmatched:
        queue.event(
            job.id, "warn", f"check {check.id}: {len(unmatched)} unmatched", {"values": unmatched}
        )
    return result


def _audit(deps: PipelineDeps, job_id: str, extraction_id: str, attempts: list[Any]) -> None:
    """Persist every prompt/response pair to the runs bucket for debugging and evals."""
    for a in attempts:
        deps.store.put(
            deps.buckets.runs,
            run_key(job_id, extraction_id, a.n),
            json.dumps(asdict(a), ensure_ascii=False, indent=2).encode("utf-8"),
            "application/json",
        )
