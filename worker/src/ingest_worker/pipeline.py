from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import UTC, datetime
from typing import Any

from .extract import ExtractionFailedError, run_extraction
from .llm.base import LLMProvider, RefusalError
from .llm.registry import ModelRegistry, ModelResolutionError
from .ocr import OcrSettings, PageRenderer, ocr_page, pages_needing_ocr, render_page_png
from .outputs import RenderedOutput, render_outputs
from .pdf import TextExtractor
from .prompts import render_prompt
from .queue import ClaimedJob, JobQueue
from .segment import MissingSectionsError, segment
from .specs import OcrMode, SpecRegistry
from .storage import ObjectStore, ocr_run_key, run_key


class DocumentError(Exception):
    """The document (or spec) can't be processed as-is. Not retried; job goes to needs_review."""


@dataclass
class Buckets:
    inbox: str
    outputs: str
    runs: str


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


def process_job(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> list[RenderedOutput]:
    loaded = deps.specs.get(job.spec_id, job.spec_version)
    spec = loaded.spec

    # Resolve every model before the first LLM call so a config error costs no tokens.
    resolved: dict[str, tuple[LLMProvider, str]] = {}
    for ex in spec.extractions:
        ref = job.model_override or ex.model
        try:
            resolved[ex.id] = deps.models.resolve(ref)
        except ModelResolutionError as exc:
            raise DocumentError(f"extraction {ex.id!r}: {exc}") from exc

    pdf = deps.store.get(job.bucket, job.object_key)
    pages = deps.extract_text(pdf)
    if spec.document.pages and not (
        spec.document.pages.min <= len(pages) <= spec.document.pages.max
    ):
        raise DocumentError(
            f"page count {len(pages)} outside expected range "
            f"{spec.document.pages.min}-{spec.document.pages.max}"
        )

    pages = _ocr_pages(job, deps, queue, pdf, pages, spec.document.ocr)
    if not any(p.strip() for p in pages):
        hint = (
            "OCR is not configured"
            if deps.ocr is None
            else "OCR disabled by spec (document.ocr: never)"
            if spec.document.ocr == "never"
            else "OCR returned no text"
        )
        raise DocumentError(f"no extractable text (scanned/image-only PDF?); {hint}")

    try:
        sections = segment(pages, spec.document.sections)
    except MissingSectionsError as exc:
        raise DocumentError(str(exc)) from exc
    queue.event(job.id, "info", "segmented", {"pages": len(pages), "sections": list(sections)})

    results: dict[str, dict[str, Any]] = {}
    models_used: dict[str, str] = {}
    for ex in spec.extractions:
        provider, model_id = resolved[ex.id]
        prompt = render_prompt(loaded.directory, ex.prompt, sections, ex.sections)
        try:
            result = run_extraction(
                extraction_id=ex.id,
                provider=provider,
                model_id=model_id,
                prompt=prompt,
                schema=ex.schema_,
                max_attempts=ex.max_attempts,
            )
        except ExtractionFailedError as exc:
            _audit(deps, job.id, ex.id, exc.attempts)
            raise DocumentError(str(exc)) from exc
        except RefusalError as exc:
            raise DocumentError(f"extraction {ex.id!r}: {exc}") from exc
        _audit(deps, job.id, ex.id, result.attempts)
        results[ex.id] = result.data
        models_used[ex.id] = result.model_ref
        queue.event(
            job.id,
            "info",
            f"extracted {ex.id}",
            {"model": result.model_ref, "attempts": len(result.attempts)},
        )

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
    return outputs


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

    pages = list(pages)
    for index in targets:
        try:
            page = ocr_page(provider, model_id, pdf, index, deps.ocr, deps.render_page)
        except RefusalError as exc:
            raise DocumentError(f"OCR page {index + 1}: {exc}") from exc
        pages[index] = page.text
        deps.store.put(
            deps.buckets.runs,
            ocr_run_key(job.id, index + 1),
            page.raw[-1].encode("utf-8"),
            "text/markdown",
        )
    queue.event(
        job.id,
        "info",
        "ocr",
        {"model": f"{provider.name}/{model_id}", "pages": [i + 1 for i in targets]},
    )
    return pages


def _audit(deps: PipelineDeps, job_id: str, extraction_id: str, attempts: list[Any]) -> None:
    """Persist every prompt/response pair to the runs bucket for debugging and evals."""
    for a in attempts:
        deps.store.put(
            deps.buckets.runs,
            run_key(job_id, extraction_id, a.n),
            json.dumps(asdict(a), ensure_ascii=False, indent=2).encode("utf-8"),
            "application/json",
        )
