from __future__ import annotations

import hashlib
import json
import logging
import time
from collections.abc import Callable, Iterable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field, replace
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Any, Literal, Protocol

from jsonschema import Draft202012Validator

from .checks import run_check
from .convert import ConversionRejected, DocumentConverter, is_docx
from .errors import DocumentError as DocumentError
from .extract import SYSTEM_PROMPT, ExtractionFailedError, ExtractionResult, run_extraction
from .llm.base import (
    ContextExceededError,
    LLMProvider,
    ModelUnavailableError,
    RefusalError,
    context_exceeded_reason,
    model_unavailable_reason,
)
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
from .publish_targets import DEFAULT_TARGET_ID
from .publish_targets import Target as Target
from .queue import ClaimedJob, JobQueue
from .segment import (
    PAGE_BREAK,
    KeyIssue,
    MissingSectionsError,
    Occurrence,
    Segmented,
    segment_occurrences,
    select_copy,
)
from .specs import (
    Check,
    DocumentLayout,
    Extraction,
    LoadedTemplate,
    OcrMode,
    PageRange,
    SpecRegistry,
)
from .step_cache import CachedStep, StepCache, step_cache_key
from .storage import ObjectStore, converted_key, ocr_cache_key, ocr_run_key, run_key

if TYPE_CHECKING:
    from langgraph.checkpoint.base import BaseCheckpointSaver

    from .bridge.client import BridgeClient
    from .graph_registry import GraphRegistry
    from .linked_data import LinkedDataSettings
    from .mapping_memory import MappingMemoryStore
    from .ontology import OntologyStore
    from .ontology_fetch import Fetched
    from .rdf_rebuild import RebuildSource
    from .template import Template
    from .template_pipeline import GraphDelivery

#: Render size for extraction page images (same as olmOCR's training size; legible for VLMs).
log = logging.getLogger("ingest_worker")

#: Job events the API reads to show where a running extraction is (TS: PREPARE_PROGRESS_EVENT,
#: SEGMENTED_EVENT in packages/shared/src/jobs.ts): the text layer read, then each OCR page
#: (`{stage, page, of, pages}`, `pages` being the document's page count; Workbench `prepare`
#: jobs write it too), then the sections found.
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
class ProcessResult:
    outputs: list[RenderedOutput]
    #: Non-empty when the document must be reviewed before publishing.
    review_reasons: list[str] = field(default_factory=list)
    #: The output formats delivered on publishing (None: every output).
    formats: list[str] | None = None
    #: The document's graph, published once its outputs are delivered without review (None: no
    #: graph is delivered).
    graph: GraphDelivery | None = None
    #: The publishing target of the job's recipe version (legacy specs: the default), resolved
    #: before extraction; None for test runs and without targets (nothing is delivered).
    target: Target | None = None
    #: The rendered document (a recipe's fields, tables, provenance): the package's data. None
    #: for legacy specs.
    document: dict[str, Any] | None = None
    #: The recipe whose outputs these are (None: a legacy spec).
    template: Template | None = None

    def delivered(self) -> list[RenderedOutput]:
        if self.formats is None:
            return self.outputs
        return [o for o in self.outputs if o.format in self.formats]


class Targets(Protocol):
    """The publishing targets by id (LiveTargets); `get` raises TargetMissing for an unknown id."""

    def get(self, target_id: str) -> Target: ...

    def rdf(self) -> Target | None:
        """The triple store target (`rdf-default`), or None when RDF_ENDPOINT is not set."""
        ...


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
    #: Where approved outputs are delivered, by publishing target id. None: outputs stay in the
    #: outputs bucket only.
    targets: Targets | None = None
    #: The delivery bridge every publication goes through (None: nothing can be delivered).
    bridge: BridgeClient | None = None
    #: This deployment's id, as packages name their producer.
    deployment: str = "default"
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
    #: The mapping memory (docs/design/mapping-memory.md); None: mapping runs recall nothing.
    mapping_memory: MappingMemoryStore | None = None
    #: The `embedding_model` setting (an `endpoint/model-id`); None: lexical retrieval only.
    embedding_model: str | None = None
    #: The published graphs' versions and entities (None: delivered graphs are not recorded).
    graph_registry: GraphRegistry | None = None
    #: Delivered and withdrawn jobs, for `republish` (None: republish goes to review).
    delivered_jobs: RebuildSource | None = None
    #: Saves a recipe's steps after each one, so a stopped job resumes where it stopped
    #: (step_graph, the LangGraph trial; None: the steps run as before).
    step_checkpointer: BaseCheckpointSaver[Any] | None = None


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
    #: Occurrences of each repeating section (none for recipes without one).
    occurrences: dict[str, list[Occurrence]] = field(default_factory=dict)
    #: The key check of sections with `keyFrom` (segment.key_issues).
    key_issues: list[KeyIssue] = field(default_factory=list)


@dataclass(frozen=True)
class RepeatPlan:
    """A step reading a repeating section: one model call per occurrence; with `key_column`,
    the worker fills that column of every row with the occurrence's key."""

    section_id: str
    occurrences: list[Occurrence]
    key_column: str | None


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


@dataclass(frozen=True)
class JobModels:
    """The models one job may use: the only way a node gets a chat, vision or OCR provider
    (tests/test_nodes.py holds the worker to it), so the data policy is checked whenever one is
    resolved, before any call."""

    job: ClaimedJob
    registry: ModelRegistry

    def resolve(self, ref: str, *, what: str | None = None) -> tuple[LLMProvider, str]:
        """`ref` resolved and allowed. With `what` (the model's use, e.g. "OCR model"), a ref
        that does not resolve is a DocumentError naming it; without, ModelResolutionError."""
        return self._allowed(self.registry.resolve, ref, what)

    def resolve_ocr(self, ref: str, *, what: str | None = None) -> tuple[LLMProvider, str]:
        """Like resolve(), on the provider's OCR endpoint (ModelRegistry.resolve_ocr)."""
        return self._allowed(self.registry.resolve_ocr, ref, what)

    def allow(self, provider: LLMProvider, ref: str) -> None:
        """Refuse, before any call, to send a local-only project's data to an external provider."""
        external = self.registry.location(provider.name) == "external"
        if job_data_policy(self.job) == "local" and external:
            raise DocumentError(
                f"data policy: project is local-only but {ref} resolves to external provider "
                f"{provider.name}"
            )

    def _allowed(
        self,
        resolve: Callable[[str], tuple[LLMProvider, str]],
        ref: str,
        what: str | None,
    ) -> tuple[LLMProvider, str]:
        try:
            resolved = resolve(ref)
        except ModelResolutionError as exc:
            if what is None:
                raise
            raise DocumentError(f"{what}: {exc}") from exc
        self.allow(resolved[0], ref)
        return resolved


def run_nodes[S](
    job: ClaimedJob, queue: JobQueue, nodes: Iterable[Callable[[S], S]], state: S
) -> S:
    """Run `nodes` in order, each on the state the one before returned, with a safe point
    before every node: a cancelled job stops before the next one starts (JobCancelled)."""
    for node in nodes:
        check_cancelled(job, queue)
        state = node(state)
    return state


def resolve_models(
    job: ClaimedJob, deps: PipelineDeps, extractions: list[Extraction]
) -> dict[str, tuple[LLMProvider, str]]:
    """Resolve every model before the first LLM call so a config error costs no tokens."""
    allowed = JobModels(job, deps.models)
    return {
        ex.id: allowed.resolve(job.model_override or ex.model, what=f"extraction {ex.id!r}")
        for ex in extractions
    }


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


@dataclass(frozen=True)
class PageText:
    """A document's pages as read: `layer` is the PDF's text layer, `pages` the same pages after
    OCR replaced the ones with too little text."""

    layer: list[str]
    pages: list[str]

    @property
    def total(self) -> int:
        """The document's page count."""
        return len(self.layer)


@dataclass(frozen=True)
class Selected:
    """The pages segmentation reads: the kept copy, with page markers when the layout asks."""

    pages: list[str]
    #: 0-based index, in the document, of the first kept page.
    first: int


def read_pages(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    source: Source,
    ocr: OcrMode,
    *,
    expected: PageRange | None = None,
    text_layer: TextExtractor | None = None,
) -> PageText:
    """Node: read the text layer (`text_layer`, else `deps.extract_text`), refuse a page count
    outside `expected` before any OCR, then OCR the pages that need it. Reports `prepare
    progress` (the text layer, then each OCR page)."""
    layer = (text_layer or deps.extract_text)(source.pdf)
    total = len(layer)

    def report(stage: Literal["text", "ocr"], page: int, of: int) -> None:
        # `pages` is the document's page count, so a reader mid-OCR still knows it (#142).
        data = {"stage": stage, "page": page, "of": of, "pages": total}
        advisory_event(job, queue, PREPARE_PROGRESS, data)

    report("text", total, total)
    if expected and not (expected.min <= total <= expected.max):
        raise DocumentError(
            f"page count {total} outside expected range {expected.min}-{expected.max}"
        )
    pages = ocr_pages(
        job,
        deps,
        queue,
        source.pdf,
        layer,
        ocr,
        sha256=source.sha256,
        progress=lambda done, of: report("ocr", done, of),
    )
    return PageText(layer, pages)


def select_pages(
    job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, pages: list[str], document: DocumentLayout
) -> Selected:
    """Node: keep one copy (`document.copies`), refuse a document with no text left, and mark
    each page with its original number when the layout asks for page markers."""
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
    return Selected(pages, first)


def segment_pages(
    job: ClaimedJob, queue: JobQueue, selected: Selected, document: DocumentLayout
) -> Segmented:
    """Node: cut the selected pages into the layout's sections; a missing required section is a
    DocumentError. Reports `segmented`."""
    try:
        marker = PAGE_MARKER if getattr(document, "page_markers", False) else None
        segmented = segment_occurrences(selected.pages, document.sections, page_marker=marker)
    except MissingSectionsError as exc:
        raise DocumentError(str(exc)) from exc
    data: dict[str, Any] = {"pages": len(selected.pages), "sections": list(segmented.sections)}
    if segmented.occurrences:
        data["occurrences"] = {k: len(v) for k, v in segmented.occurrences.items()}
    queue.event(job.id, "info", SEGMENTED, data)
    return segmented


def prepare_document(
    job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, document: DocumentLayout
) -> Prepared:
    """The source, read, selected and segmented: the nodes above in order."""
    source = load_source(job, deps, queue)
    read = read_pages(job, deps, queue, source, document.ocr, expected=document.pages)
    selected = select_pages(job, deps, queue, read.pages, document)
    segmented = segment_pages(job, queue, selected, document)
    return Prepared(
        source.pdf,
        read.total,
        segmented.sections,
        source.sha256,
        segmented.occurrences,
        segmented.key_issues,
    )


def target_named(deps: PipelineDeps, target_id: str) -> Target | None:
    """The publishing target `target_id` (None: no targets, nothing is delivered). An unknown id
    raises TargetMissing (a DocumentError: needs review), never a fallback to the default."""
    return None if deps.targets is None else deps.targets.get(target_id)


def target_for(deps: PipelineDeps, loaded: Any) -> Target | None:
    """The publishing target of a loaded recipe version (`delivery.publishTo`, else the default);
    legacy specs always deliver to the default."""
    if isinstance(loaded, LoadedTemplate):
        return target_named(deps, loaded.template.publish_to())
    return target_named(deps, DEFAULT_TARGET_ID)


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
    # Before any model call: a missing target sends the job to review without an LLM run. Test
    # runs deliver nothing and resolve none.
    target = None if job.test else target_for(deps, loaded)
    if isinstance(loaded, LoadedTemplate):
        from .template_pipeline import process_template_job

        return replace(process_template_job(job, deps, queue, loaded), target=target)
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
    return ProcessResult(outputs, target=target)


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
    provider, model_id = JobModels(job, deps.models).resolve_ocr(deps.ocr.model, what="OCR model")

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
        except ModelUnavailableError as exc:  # a retry would repeat it
            raise DocumentError(
                model_unavailable_reason(f"OCR page {index + 1}", model_ref, exc)
            ) from exc
        except ContextExceededError as exc:  # a retry would repeat it
            raise DocumentError(
                context_exceeded_reason(
                    f"OCR page {index + 1}",
                    model_ref,
                    "raise the model's context length on its server (e.g. LM Studio) or lower "
                    "the OCR output budget (ocr.maxTokens in config/llm-providers.yaml, now "
                    f"{settings.max_tokens})",
                    exc,
                )
            ) from exc
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


#: progress(attempt, chunk, occurrence) before each model call; chunk is {index, count} and
#: occurrence {n, of, key}, each None when the step has none.
StepProgress = Callable[[int, dict[str, int] | None, dict[str, Any] | None], None]


def _attempt_reporter(
    progress: StepProgress | None,
    chunk: dict[str, int] | None,
    occurrence: Occurrence | None,
) -> Callable[[int], None] | None:
    """Bind a chunk and an occurrence to the step's progress callback (None: no reporting)."""
    if progress is None:
        return None
    report = progress
    where = (
        None
        if occurrence is None
        else {"n": occurrence.index, "of": occurrence.count, "key": occurrence.key}
    )
    return lambda attempt: report(attempt, chunk, where)


def _without_column(schema: dict[str, Any], column: str) -> dict[str, Any]:
    """A table step's schema whose rows leave out `column` (the worker fills it)."""
    rows = schema["properties"]["rows"]
    row = rows["items"]
    items = {
        **row,
        "required": [c for c in row["required"] if c != column],
        "properties": {k: v for k, v in row["properties"].items() if k != column},
    }
    return {**schema, "properties": {**schema["properties"], "rows": {**rows, "items": items}}}


def _chunks(
    ex: Extraction, sections: dict[str, str]
) -> list[tuple[str, dict[str, str], dict[str, Any] | None]]:
    """(audit suffix, sections, chunk) per call: one call, or one per chunk of pages."""
    if ex.chunk_pages is None:
        return [("", sections, None)]
    section_id = ex.sections[0]
    pages = [p.strip() for p in sections[section_id].split(PAGE_BREAK) if p.strip()]
    size = ex.chunk_pages
    groups = [PAGE_BREAK.join(pages[i : i + size]) for i in range(0, len(pages), size)] or [""]
    return [
        (f".chunk-{n}", {**sections, section_id: text}, {"index": n, "count": len(groups)})
        for n, text in enumerate(groups, start=1)
    ]


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
    progress: StepProgress | None = None,
    repeat: RepeatPlan | None = None,
) -> ExtractionResult:
    """Run one extraction, or one call per chunk of pages with `merge_path` arrays concatenated
    (keeps each call's output well inside the model's output token limit). With `repeat`, one
    call (or one per chunk) per occurrence of the repeating section, told which occurrence it
    reads; its `key_column` is left out of the schema sent and set on every row from the
    occurrence's key. No occurrence: no call and no rows.
    `progress(attempt, chunk, occurrence)` is called before each model call (never for a cache
    hit).

    With a `cache`, an unchanged step input (every rendered prompt, schema, images, step id,
    model and provider fingerprint) returns the stored output without calling the model, if it
    still satisfies the schema; a miss stores the result."""
    if repeat is not None and not repeat.occurrences:
        return ExtractionResult({"rows": []}, f"{provider.name}/{model_id}", [])

    plan: list[tuple[str, dict[str, str], dict[str, Any] | None, Occurrence | None]] = []
    if repeat is None:
        plan = [(f"{ex.id}{suffix}", s, chunk, None) for suffix, s, chunk in _chunks(ex, sections)]
    else:
        for each in repeat.occurrences:
            own = {**sections, repeat.section_id: each.text}
            plan += [
                (f"{ex.id}.occ-{each.index}{suffix}", s, chunk, each)
                for suffix, s, chunk in _chunks(ex, own)
            ]

    key_column = repeat.key_column if repeat is not None else None
    prompt_context = ex.prompt_context
    table = (prompt_context or {}).get("table")
    if key_column and prompt_context is not None and isinstance(table, dict):
        # The worker fills the key column: the model is not asked for it.
        columns = [c for c in table.get("columns", []) if c.get("id") != key_column]
        prompt_context = {**prompt_context, "table": {**table, "columns": columns}}

    def occurrence_context(o: Occurrence | None) -> dict[str, Any] | None:
        if o is None or repeat is None:
            return None
        return {"index": o.index, "count": o.count, "key": o.key, "section": repeat.section_id}

    rendered = [
        (
            audit_id,
            render_prompt(
                directory,
                ex.prompt,
                call_sections,
                ex.sections,
                chunk,
                prompt_context,
                occurrence=occurrence_context(occurrence),
            ),
            chunk,
            occurrence,
        )
        for audit_id, call_sections, chunk, occurrence in plan
    ]

    key: str | None = None
    if cache is not None:
        key = step_cache_key(
            model_ref=f"{provider.name}/{model_id}",
            provider=deps.models.cache_fingerprint(provider.name),
            step_id=ex.id,
            system=SYSTEM_PROMPT,
            schema=ex.schema_,
            prompts=[prompt for _, prompt, _, _ in rendered],
            images=images,
            max_tokens=ex.max_tokens,
            max_attempts=ex.max_attempts,
        )
        hit = cache.get(key)
        if hit is not None and Draft202012Validator(ex.schema_).is_valid(hit.data):
            return ExtractionResult(hit.data, hit.model_ref, [], cached=True)
        # An entry that no longer satisfies the schema is a miss; the fresh result replaces it.

    schema = _without_column(ex.schema_, key_column) if key_column else ex.schema_
    merged: ExtractionResult | None = None
    for audit_id, prompt, chunk, occurrence in rendered:
        where = f" [chunk {chunk['index']}/{chunk['count']}]" if chunk else ""
        if occurrence is not None:
            where = f" [occurrence {occurrence.index}/{occurrence.count}]{where}"
        try:
            result = run_extraction(
                extraction_id=ex.id,
                provider=provider,
                model_id=model_id,
                prompt=prompt,
                schema=schema,
                max_attempts=ex.max_attempts,
                images=images,
                max_tokens=ex.max_tokens,
                on_attempt=_attempt_reporter(progress, chunk, occurrence),
            )
        except ExtractionFailedError as exc:
            _audit(deps, job.id, audit_id, exc.attempts)
            raise DocumentError(f"{exc}{where}") from exc
        except RefusalError as exc:
            raise DocumentError(f"extraction {ex.id!r}{where}: {exc}") from exc
        except ModelUnavailableError as exc:  # a retry would repeat it
            raise DocumentError(
                model_unavailable_reason(
                    f"extraction {ex.id!r}{where}", f"{provider.name}/{model_id}", exc
                )
            ) from exc
        except ContextExceededError as exc:  # a retry would repeat it
            raise DocumentError(
                context_exceeded_reason(
                    f"extraction {ex.id!r}{where}",
                    f"{provider.name}/{model_id}",
                    "raise the model's context length on its server (e.g. LM Studio), lower the "
                    f"step's maxTokens (now {ex.max_tokens}) or split it with chunkPages",
                    exc,
                )
            ) from exc
        _audit(deps, job.id, audit_id, result.attempts)
        if key_column and occurrence is not None:
            for row in result.data["rows"]:
                row[key_column] = occurrence.key
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
