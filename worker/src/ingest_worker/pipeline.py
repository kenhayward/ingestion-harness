from __future__ import annotations

import hashlib
import json
import logging
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal

from jsonschema import Draft202012Validator

from .checks import run_check
from .convert import ConversionRejected, DocumentConverter, is_docx
from .extract import SYSTEM_PROMPT, ExtractionFailedError, ExtractionResult, run_extraction
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
from .outputs import RenderedOutput, content_type, render_outputs
from .pdf import TextExtractor
from .prompts import render_prompt
from .queue import ClaimedJob, JobQueue
from .segment import PAGE_BREAK, MissingSectionsError, segment, select_copy
from .specs import Check, DocumentLayout, Extraction, LoadedTemplate, OcrMode, SpecRegistry
from .step_cache import CachedStep, StepCache, step_cache_key
from .storage import ObjectStore, converted_key, ocr_cache_key, ocr_run_key, run_key

if TYPE_CHECKING:
    from .graph_registry import GraphRegistry
    from .graph_store import GraphStore
    from .linked_data import LinkedDataSettings
    from .ontology import OntologyStore
    from .ontology_fetch import Fetched
    from .rdf_rebuild import RebuildSource

#: Render size for extraction page images (same as olmOCR's training size; legible for VLMs).
log = logging.getLogger("ingest_worker")

#: Job events the API reads to show where a running extraction is (TS: PREPARE_PROGRESS_EVENT,
#: SEGMENTED_EVENT in packages/shared/src/jobs.ts): the text layer read, then each OCR page
#: (`{stage, page, of}`; Workbench `prepare` jobs write it too), then the sections found.
PREPARE_PROGRESS = "prepare progress"
SEGMENTED = "segmented"


def advisory_event(job: ClaimedJob, queue: JobQueue, message: str, data: dict[str, Any]) -> None:
    """Progress is advisory: a failed event write (job deleted mid-run, database blip) is logged,
    never raised, so it can neither fail a good run nor replace the error being raised."""
    try:
        queue.event(job.id, "info", message, data)
    except Exception:
        log.exception("could not record %r for job %s", message, job.id)


PAGE_IMAGE_LONGEST_DIM = 1288


class DocumentError(Exception):
    """The document (or spec) can't be processed as-is. Not retried; job goes to needs_review."""


class JobCancelled(Exception):
    """An operator cancelled the job: stop at the next safe point, write no status."""


def check_cancelled(job: ClaimedJob, queue: JobQueue) -> None:
    """Safe point between LLM calls / before side effects (publishing, recording results)."""
    if queue.is_cancelled(job):
        raise JobCancelled(job.id)


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
    #: The output formats delivered on publishing (None: every output).
    formats: list[str] | None = None
    #: Publishes the document's graph to the triple store once its outputs are delivered
    #: without review (None: no graph is delivered).
    deliver_graph: Callable[[], object] | None = None

    def delivered(self) -> list[RenderedOutput]:
        if self.formats is None:
            return self.outputs
        return [o for o in self.outputs if o.format in self.formats]


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
    #: YAML of a worked-example template shown to drafting models (None: no example).
    example_template: str | None = None
    #: Converts Word (.docx) sources to PDF (None: Word documents go to needs_review).
    converter: DocumentConverter | None = None
    #: The ontology library's tables (None: ontology jobs go to review).
    ontologies: OntologyStore | None = None
    #: Imports over this many triples are refused (ONTOLOGY_MAX_TRIPLES).
    ontology_max_triples: int = 2_000_000
    #: Fetches an allowlisted ontology URL (None: URL imports are off).
    ontology_fetch: Callable[[str], Fetched] | None = None
    #: The base IRI RDF is minted under (None: mapped recipes draft no graph).
    linked_data: LinkedDataSettings | None = None
    #: The `embedding_model` setting (an `endpoint/model-id`); None: lexical retrieval only.
    embedding_model: str | None = None
    #: The published graphs' versions and entities (None: delivered graphs are not recorded).
    graph_registry: GraphRegistry | None = None
    #: The triple store (RDF_ENDPOINT; None: delivered graphs go to S3 only).
    graph_store: GraphStore | None = None
    #: Delivered and withdrawn jobs, for `republish` (None: republish goes to review).
    delivered_jobs: RebuildSource | None = None


@dataclass(frozen=True)
class Source:
    """A job's inbox object and the PDF the pipeline runs on."""

    #: The file as uploaded (a PDF, or a .docx).
    data: bytes
    #: sha256 of `data`: what the API records, and what prepared text and caches are keyed by.
    sha256: str
    kind: Literal["pdf", "docx"]
    #: `data` itself for a PDF; the converted PDF for a .docx.
    pdf: bytes


@dataclass
class Prepared:
    """The document after text extraction, OCR, copy selection, page markers, segmentation."""

    pdf: bytes
    total_pages: int
    sections: dict[str, str]
    #: sha256 of the uploaded file (Source.sha256): names the document's graph.
    sha256: str = ""


#: Matches the lines added by mark_pages.
PAGE_MARKER = r"^\[page \d+\]$"


def mark_pages(pages: list[str], first_page: int) -> list[str]:
    """Prefix pages with "[page N]" using original (1-based) PDF page numbers."""
    return [f"[page {first_page + i}]\n{text}" for i, text in enumerate(pages)]


def job_data_policy(job: ClaimedJob) -> Literal["local", "external"] | None:
    """The data policy governing a job (ADR 0007): None for production jobs; for project jobs,
    params.dataPolicy, where anything but "external" (including a missing value) means local."""
    if job.project_id is None:
        return None
    return "external" if (job.params or {}).get("dataPolicy") == "external" else "local"


def enforce_data_policy(
    job: ClaimedJob, deps: PipelineDeps, provider: LLMProvider, ref: str
) -> None:
    """Refuse, before any call, to send a local-only project's data to an external provider."""
    if job_data_policy(job) == "local" and deps.models.location(provider.name) == "external":
        raise DocumentError(
            f"data policy: project is local-only but {ref} resolves to external provider "
            f"{provider.name}"
        )


def resolve_models(
    job: ClaimedJob, deps: PipelineDeps, extractions: list[Extraction]
) -> dict[str, tuple[LLMProvider, str]]:
    """Resolve every model before the first LLM call so a config error costs no tokens."""
    resolved: dict[str, tuple[LLMProvider, str]] = {}
    for ex in extractions:
        try:
            ref = job.model_override or ex.model
            resolved[ex.id] = deps.models.resolve(ref)
        except ModelResolutionError as exc:
            raise DocumentError(f"extraction {ex.id!r}: {exc}") from exc
        enforce_data_policy(job, deps, resolved[ex.id][0], ref)
    return resolved


def load_source(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> Source:
    """Read the job's inbox object; convert a .docx to PDF, at most once per file and
    converter version (cached in the runs bucket, so re-runs see the same pages). Anything
    that is not a .docx is read as a PDF, as before. A converter outage propagates (retried);
    a document the converter rejects is a DocumentError."""
    data = deps.store.get(job.bucket, job.object_key)
    sha256 = hashlib.sha256(data).hexdigest()
    if not is_docx(data):
        return Source(data, sha256, "pdf", data)
    if deps.converter is None:
        raise DocumentError("Word documents need the converter: set CONVERTER_URL")
    fingerprint = deps.converter.fingerprint()
    key = converted_key(sha256, fingerprint)
    started = time.monotonic()
    pdf = deps.store.get_optional(deps.buckets.runs, key)
    cached = pdf is not None and pdf.startswith(b"%PDF-")
    if pdf is None or not cached:
        try:
            pdf = deps.converter.to_pdf(data)
        except ConversionRejected as exc:
            raise DocumentError(f"could not convert the Word document: {exc}") from exc
        deps.store.put(deps.buckets.runs, key, pdf, "application/pdf")
    queue.event(
        job.id,
        "info",
        "converted",
        {
            "converter": fingerprint,
            "cached": cached,
            "seconds": round(time.monotonic() - started, 2),
        },
    )
    return Source(data, sha256, "docx", pdf)


def prepare_document(
    job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, document: DocumentLayout
) -> Prepared:
    source = load_source(job, deps, queue)
    pdf = source.pdf
    pages = deps.extract_text(pdf)
    total_pages = len(pages)

    def report(stage: Literal["text", "ocr"], page: int, of: int) -> None:
        advisory_event(job, queue, PREPARE_PROGRESS, {"stage": stage, "page": page, "of": of})

    report("text", total_pages, total_pages)
    if document.pages and not (document.pages.min <= len(pages) <= document.pages.max):
        raise DocumentError(
            f"page count {len(pages)} outside expected range "
            f"{document.pages.min}-{document.pages.max}"
        )

    pages = ocr_pages(
        job,
        deps,
        queue,
        pdf,
        pages,
        document.ocr,
        sha256=source.sha256,
        progress=lambda done, total: report("ocr", done, total),
    )
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
    queue.event(job.id, "info", SEGMENTED, {"pages": len(pages), "sections": list(sections)})
    return Prepared(pdf, total_pages, sections, source.sha256)


def publish_outputs(deps: PipelineDeps, outputs: list[RenderedOutput]) -> list[RenderedOutput]:
    """Write outputs to the final target (same layout, keys prefixed). Returns what was written."""
    if deps.target is None:
        return []
    published = [replace(o, key=f"{deps.target.prefix}{o.key}") for o in outputs]
    for o in published:
        ctype = content_type(o.format)
        deps.target.store.put(deps.target.bucket, o.key, o.body, ctype)
    return published


def load_definition(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> Any:
    """The job's document type: a database template if one exists, else a file (spec or
    template) from the specs directory."""
    from pydantic import ValidationError

    from .template import Template

    raw = queue.load_template(job.spec_id, job.spec_version)
    if raw is None:
        return deps.specs.get(job.spec_id, job.spec_version)
    name = f"recipe {job.spec_id} v{job.spec_version}"
    try:
        template = Template.model_validate(raw)
    except ValidationError as exc:
        raise DocumentError(f"{name} is invalid: {exc}") from exc
    custom = [
        s.id for s in template.extract_steps() if s.prompt and not s.prompt.startswith("builtin/")
    ]
    if custom:
        raise DocumentError(
            f"{name}: custom prompt files are not supported for recipes stored in the database "
            f"(steps {', '.join(custom)}); use instructions"
        )
    return LoadedTemplate(template, None)


def process_job(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> ProcessResult:
    loaded = load_definition(job, deps, queue)
    if isinstance(loaded, LoadedTemplate):
        from .template_pipeline import process_template_job

        return process_template_job(job, deps, queue, loaded)
    spec = loaded.spec

    resolved = resolve_models(job, deps, spec.extractions)
    doc = prepare_document(job, deps, queue, spec.document)

    results: dict[str, dict[str, Any]] = {}
    models_used: dict[str, str] = {}
    for ex in spec.extractions:
        check_cancelled(job, queue)
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
        ctype = content_type(o.format)
        deps.store.put(deps.buckets.outputs, o.key, o.body, ctype)
    return ProcessResult(outputs)


def ocr_pages(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    pdf: bytes,
    pages: list[str],
    mode: OcrMode,
    *,
    sha256: str,
    progress: Callable[[int, int], None] | None = None,
) -> list[str]:
    """Replace low-text pages with OCR output. Transient model errors propagate (retried).
    `sha256` is the source's (`Source.sha256`): the shared OCR cache is keyed by it.
    `progress(done, total)` is called after each page is OCR'd, from this thread (never from
    the OCR threads), counting pages read from the caches as done."""
    if deps.ocr is None:
        return pages
    targets = pages_needing_ocr(pages, mode, deps.ocr.min_chars)
    if not targets:
        return pages
    try:
        provider, model_id = deps.models.resolve_ocr(deps.ocr.model)
    except ModelResolutionError as exc:
        raise DocumentError(f"OCR model: {exc}") from exc
    enforce_data_policy(job, deps, provider, deps.ocr.model)

    settings = deps.ocr
    pages = list(pages)
    model_ref = f"{provider.name}/{model_id}"
    shared_key = _ocr_cache_keyer(sha256, model_ref, settings) if settings.cache else None

    # Reuse transcriptions saved by an earlier attempt of this job (retries, crashed workers),
    # then those of earlier jobs of the same PDF: OCR servers are not deterministic even at
    # temperature 0, so re-runs and regressions would otherwise see different page text.
    cached: list[int] = []
    shared: list[int] = []
    for index in targets:
        raw = deps.store.get_optional(deps.buckets.runs, ocr_run_key(job.id, index + 1))
        if raw is None and shared_key is not None:
            raw = deps.store.get_optional(deps.buckets.runs, shared_key(index + 1))
            if raw is not None:
                # The job keeps its own copy: its audit trail must not depend on the cache.
                deps.store.put(
                    deps.buckets.runs, ocr_run_key(job.id, index + 1), raw, "text/markdown"
                )
                shared.append(index)
        if raw is not None:
            pages[index] = parse_olmocr(raw.decode("utf-8"))[0]
            cached.append(index)
    todo = [i for i in targets if i not in cached]

    def run(index: int) -> OcrPage:
        check_cancelled(job, queue)  # a long OCR pass stops at the next page
        try:
            page = ocr_page(provider, model_id, pdf, index, settings, deps.render_page)
        except RefusalError as exc:
            raise DocumentError(f"OCR page {index + 1}: {exc}") from exc
        # Saved as each page finishes, so a later failure doesn't lose completed pages.
        raw = page.raw[-1].encode("utf-8")
        deps.store.put(deps.buckets.runs, ocr_run_key(job.id, index + 1), raw, "text/markdown")
        if shared_key is not None:
            deps.store.put(deps.buckets.runs, shared_key(index + 1), raw, "text/markdown")
        return page

    # Pages are independent, so OCR them concurrently; results are written back in page order
    # and the first exception (transient or DocumentError) propagates.
    if progress is not None and todo:
        progress(len(cached), len(targets))  # the first page can take the whole run
    with ThreadPoolExecutor(max_workers=max(1, settings.concurrency)) as pool:
        for done, page in enumerate(pool.map(run, todo), start=1):
            pages[page.index] = page.text
            if progress is not None:
                progress(len(cached) + done, len(targets))
    queue.event(
        job.id,
        "info",
        "ocr",
        {
            "model": model_ref,
            "pages": [i + 1 for i in targets],
            "cached": [i + 1 for i in cached],
            "shared": [i + 1 for i in shared],
        },
    )
    return pages


def _ocr_cache_keyer(digest: str, model_ref: str, settings: OcrSettings) -> Callable[[int], str]:
    """Cache keys for a source's content (its sha256; for a .docx, of the .docx, whose
    converted PDF is cached and so stable) and the settings that change the transcription."""
    knobs = {
        "model": model_ref,
        "longest_dim": settings.longest_dim,
        "max_tokens": settings.max_tokens,
        "temperature": settings.temperature,
    }
    fingerprint = hashlib.sha256(json.dumps(knobs, sort_keys=True).encode()).hexdigest()[:16]
    return lambda page_number: ocr_cache_key(digest, fingerprint, page_number)


def _attempt_reporter(
    progress: Callable[[int, dict[str, int] | None], None] | None,
    chunk: dict[str, int] | None,
) -> Callable[[int], None] | None:
    """Bind a chunk to the step's progress callback (None: no reporting)."""
    if progress is None:
        return None
    report = progress
    return lambda attempt: report(attempt, chunk)


def run_step_extraction(
    job: ClaimedJob,
    deps: PipelineDeps,
    directory: Path | None,
    ex: Extraction,
    provider: LLMProvider,
    model_id: str,
    sections: dict[str, str],
    images: tuple[bytes, ...],
    *,
    cache: StepCache | None = None,
    progress: Callable[[int, dict[str, int] | None], None] | None = None,
) -> ExtractionResult:
    """Run one extraction, or one call per chunk of pages with `merge_path` arrays concatenated
    (keeps each call's output well inside the model's output token limit).
    `progress(attempt, chunk)` is called before each model call (never for a cache hit).

    With a `cache`, an unchanged step input (every rendered prompt, schema, images, step id,
    model and provider fingerprint) returns the stored output without calling the model, if it
    still satisfies the schema; a miss stores the result."""
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

    rendered = [
        (
            audit_id,
            render_prompt(
                directory, ex.prompt, chunk_sections, ex.sections, chunk, ex.prompt_context
            ),
            chunk,
        )
        for audit_id, chunk_sections, chunk in plan
    ]

    key: str | None = None
    if cache is not None:
        key = step_cache_key(
            model_ref=f"{provider.name}/{model_id}",
            provider=deps.models.cache_fingerprint(provider.name),
            step_id=ex.id,
            system=SYSTEM_PROMPT,
            schema=ex.schema_,
            prompts=[prompt for _, prompt, _ in rendered],
            images=images,
            max_tokens=ex.max_tokens,
            max_attempts=ex.max_attempts,
        )
        hit = cache.get(key)
        if hit is not None and Draft202012Validator(ex.schema_).is_valid(hit.data):
            return ExtractionResult(hit.data, hit.model_ref, [], cached=True)
        # An entry that no longer satisfies the schema is a miss; the fresh result replaces it.

    merged: ExtractionResult | None = None
    for audit_id, prompt, chunk in rendered:
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
                on_attempt=_attempt_reporter(progress, chunk),
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
    if cache is not None and key is not None:
        cache.put(
            key,
            CachedStep(
                merged.data,
                merged.model_ref,
                _token_total(merged.attempts, "input_tokens"),
                _token_total(merged.attempts, "output_tokens"),
            ),
        )
    return merged


def _token_total(attempts: list[Any], name: str) -> int | None:
    values = [getattr(a, name) for a in attempts if getattr(a, name) is not None]
    return sum(values) if values else None


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
