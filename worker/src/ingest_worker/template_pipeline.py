"""Run a document template: shared preparation (OCR, copies, page markers, sections), then the
template's steps in order, typed normalisation, checks, outputs and the review decision.

Outputs ({templateId}/v{version}/<output>/{documentId}.<ext>):
    fields     one-row CSV, one column per field (normalised values)
    <table>    one CSV per table
    <check>    one CSV per check step
    issues     values that could not be normalised (kept as written)
    document   JSON with field evidence/pages, tables, checks, issues, review decision
    graph      Turtle (.ttl), for recipes with an ontology mapping once Administration > Linked data
               sets a base IRI (ADR 0011); delivered only when `delivery.formats` has rdf
"""

from __future__ import annotations

import csv
import hashlib
import io
import json
import logging
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal

import psycopg
from rdflib import Graph

from .bridge.package import deliver_document
from .extract import ExtractionResult
from .graph_registry import EntityRecord, GraphPublish, GraphRegistry
from .graph_store import GraphStore
from .llm.base import LLMProvider
from .normalize import normalize_value
from .outputs import DOCUMENT_ID_COLUMN, RenderedOutput, _cell, content_type, encode_csv
from .pipeline import (
    DocumentError,
    JobModels,
    PipelineDeps,
    Prepared,
    ProcessResult,
    RepeatPlan,
    StepProgress,
    Target,
    advisory_event,
    page_images,
    prepare_document,
    resolve_models,
    run_check_with_event,
    run_nodes,
    run_step_extraction,
    target_for,
)
from .queue import ClaimedJob, JobQueue
from .rdf import GraphContext, ShaclReport, render, to_turtle, validate, with_version
from .review import apply_edits, run_checks
from .shacl import load_graphs, outputs_by_property
from .specs import Extraction, LoadedTemplate
from .step_cache import StepCache
from .storage import (
    graph_version_key,
    ontology_normalized_key,
    output_key,
    page_preview_key,
    reviewed_document_key,
    shacl_report_key,
)
from .template import CheckStep, ExtractStep, FillingStep, PluginStep, Template, compile_step

if TYPE_CHECKING:
    from .plugins import ResolvedPlugin

ISSUE_COLUMNS = ["step", "target", "row", "column", "raw", "message"]

log = logging.getLogger("ingest_worker")

#: Job event the API reads for the Test runs tab (TS: STEP_PROGRESS_EVENT, StepProgressSchema).
STEP_PROGRESS = "step progress"
#: The `step` of the key check's issues (segment.key_issues): not an extract step.
SEGMENT_STEP = "segment"

#: Job event when a mapped recipe drafts no graph because no base IRI is set.
GRAPH_SKIPPED = "graph skipped: set the customer under Administration > Linked data"
#: Job event when a graph that is not delivered could not be rendered (CSV/JSON still are).
GRAPH_FAILED = "graph failed"
#: Job event when a delivered graph was published (`{graph, version, triples, endpoint}`;
#: TS: GRAPH_PUBLISHED_EVENT).
GRAPH_PUBLISHED = "graph published"
#: Job event when the document's graph violates the recipe's shapes.
GRAPH_VIOLATES = "graph violates shapes"


#: Job event when a publish is sent back to review because its graph violates the shapes.
PUBLISH_REFUSED = "publish refused: graph violates shapes"


class ShapesViolated(Exception):
    """A publish that delivers RDF whose graph violates the recipe's shapes: back to review."""

    def __init__(self, reasons: list[str]) -> None:
        super().__init__("; ".join(reasons))
        self.reasons = reasons


@dataclass(frozen=True)
class RenderedGraph:
    """A document's graph, already serialised: a graph that cannot be written never gets here."""

    turtle: bytes
    triples: int
    graph: Graph
    #: The base IRI it was minted under (read once per job).
    base: str = ""
    entities: tuple[EntityRecord, ...] = ()
    #: Value node IRI -> the output it publishes (`Rendering.nodes`), for SHACL results.
    nodes: dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class GraphDelivery:
    """A drafted graph to publish once the document's outputs are delivered without review: its
    copy to the target, then the triple store (`publish_graph`)."""

    template: Template
    document: dict[str, Any]
    graph: RenderedGraph

    def deliver(self, job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, target: Target) -> None:
        publish_graph(job, deps, queue, self.template, self.document, self.graph, target)


Progress = StepProgress


def step_reporter(job: ClaimedJob, queue: JobQueue, step_id: str, index: int, of: int) -> Progress:
    """A `step progress` event before each model call of a step (its place among the extract
    steps, the attempt, the chunk), for Workbench runs and production jobs alike (Home follows
    them live). Advisory: a failed write (job deleted mid-run, database blip) never fails the
    step."""

    def report(
        attempt: int, chunk: dict[str, Any] | None, occurrence: dict[str, Any] | None = None
    ) -> None:
        data = {
            "step": step_id,
            "index": index,
            "of": of,
            "attempt": attempt,
            "chunk": None if chunk is None else {"n": chunk["index"], "of": chunk["count"]},
            "occurrence": occurrence,
        }
        try:
            queue.event(job.id, "info", STEP_PROGRESS, data)
        except Exception:
            log.exception("could not record step progress for job %s", job.id)

    return report


def workbench_step_cache(job: ClaimedJob, deps: PipelineDeps) -> StepCache | None:
    """Only workbench test runs use the step cache: never production, regression or re-runs.
    `params.uncached` and reference runs (`params.forceReview`) force fresh calls but still
    store their results, so re-running references always asks the model again."""
    if job.project_id is None or not job.test or job.task != "process":
        return None
    params = job.params or {}
    fresh = bool(params.get("uncached")) or bool(params.get("forceReview"))
    return StepCache(deps.store, deps.buckets.runs, read=not fresh)


def process_template_job(
    job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, loaded: LoadedTemplate
) -> ProcessResult:
    template = loaded.template
    compiled = {s.id: compile_step(template, s) for s in template.extract_steps()}
    extract_ids = [s.id for s in template.extract_steps()]
    resolved = resolve_models(job, deps, list(compiled.values()))
    from .plugins import resolve_plugins

    plugins = resolve_plugins(template)  # like models: before the first model call
    doc = prepare_document(job, deps, queue, template.document)
    cache = workbench_step_cache(job, deps)
    _save_previews(job, deps, queue, doc.pdf, doc.total_pages)

    def node(step: ExtractStep | CheckStep | PluginStep) -> Callable[[DocState], DocState]:
        """The step as a node: the state before it in, the state after it out."""
        if isinstance(step, PluginStep):
            plugin_step = step

            def run_plugin(state: DocState) -> DocState:
                data = run_plugin_step(
                    job, queue, template, plugin_step, plugins[plugin_step.id], doc, state
                )
                return state.apply(normalise_step(template, plugin_step, data))

            return run_plugin
        if isinstance(step, CheckStep):
            check = step

            def run_check(state: DocState) -> DocState:
                compiled_check = template.compile_check(check)
                result = run_check_with_event(job, queue, compiled_check, state.step_results)
                return state.with_check(check.id, result)

            return run_check

        extract = step

        def run_extract(state: DocState) -> DocState:
            result = run_step(
                job,
                deps,
                queue,
                loaded,
                extract,
                compiled[extract.id],
                resolved[extract.id],
                doc,
                state,
                trigger="process",
                cache=cache,
                progress=step_reporter(
                    job, queue, extract.id, extract_ids.index(extract.id) + 1, len(extract_ids)
                ),
            )
            return state.apply(normalise_step(template, extract, result.data, result.model_ref))

        return run_extract

    nodes = [node(step) for step in template.pipeline]
    state = run_nodes(job, queue, nodes, DocState(issues=tuple(segment_issues(doc))))

    reasons = _review_reasons(template, state.checks, list(state.issues))
    if reasons:
        queue.event(job.id, "warn", "review required", {"reasons": reasons})
    done = finalise(
        job, deps, queue, template, document_of(job, doc, template, state, reasons), mode="draft"
    )
    write_drafts(deps, done.outputs)
    formats: list[str] = list(template.delivery_formats())
    graph = (
        GraphDelivery(template, done.document, done.graph)
        if done.graph is not None and "rdf" in formats
        else None
    )
    return ProcessResult(
        done.outputs, done.reasons, formats, graph, document=done.document, template=template
    )


def publish_template_job(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    loaded: LoadedTemplate,
    *,
    deliver: bool = True,
    on_published: Callable[[list[RenderedOutput], Target, str], None] | None = None,
) -> list[RenderedOutput]:
    """Apply the reviewer's edits to the draft (never modified), keep the reviewed document in
    the runs bucket and, when `deliver`, publish it to the publishing target of the job's recipe
    version (resolved first: a missing target writes nothing). Approved test runs (workbench
    references) pass `deliver=False`: reviewed, never delivered, no target resolved."""
    template = loaded.template
    target = target_for(deps, loaded) if deliver else None
    draft_key = output_key(template.id, template.version, "document", job.document_id, "json")
    draft = json.loads(deps.store.get(deps.buckets.outputs, draft_key))
    edits = queue.review_edits(job.id)
    decision = queue.review_decision(job.id) or {}
    try:
        document = apply_edits(template, draft, edits)
    except ValueError as exc:
        raise DocumentError(f"cannot apply review edits: {exc}") from exc
    document["review"] = {
        "decision": "approved",
        "reviewer": decision.get("reviewer"),
        "note": decision.get("note"),
        "reviewed_at": decision.get("reviewed_at"),
        "edits": edits,
    }
    document["published_at"] = datetime.now(UTC).isoformat()
    # Keep the reviewed document next to the job's run data: the final target may be an S3 the
    # API cannot read, and references/regression need the approved values.
    deps.store.put(
        deps.buckets.runs,
        reviewed_document_key(job.id),
        json.dumps(document, ensure_ascii=False, indent=2).encode("utf-8"),
        "application/json",
    )
    if not deliver:
        queue.event(job.id, "info", "reviewed", {"edits": len(edits)})
        return []
    if template.semantics is not None and not document.get("source_sha256"):
        # Drafted before graphs existed: only a graph needs the source's hash.
        document["source_sha256"] = hashlib.sha256(
            deps.store.get(job.bucket, job.object_key)
        ).hexdigest()
    done = finalise(job, deps, queue, template, document, mode="publish")
    graph, rendered = done.graph, done.outputs
    formats = template.delivery_formats()
    published: list[RenderedOutput] = []
    if target is not None:  # None: no publishing targets, nothing is delivered
        reviewer = queue.reviewer(job.id)
        published, delivery_id = deliver_document(
            deps,
            job,
            template=template,
            document=document,
            outputs=[o for o in rendered if o.format in formats],
            target=target,
            acting=reviewer or queue.uploader(job.id),
            approver=reviewer,
        )
        if on_published is not None:
            # Recorded before the graph: a store failure keeps the record.
            on_published(published, target, delivery_id)
        if graph is not None and "rdf" in formats:
            publish_graph(job, deps, queue, template, document, graph, target)
    queue.event(job.id, "info", "published", {"edits": len(edits), "outputs": len(published)})
    return published


def publish_graph(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    template: Template,
    document: dict[str, Any],
    rendered: RenderedGraph,
    target: Target,
) -> int | None:
    """Publish a delivered graph as the next version of its (file, document type) graph: the
    versioned copy in `target` (recorded with it), the pinned ontologies' TBox graphs not loaded
    yet under this base, and the store's PUT, then the version and its entities (one
    transaction, holding the graph's lock). None when nothing is recorded (no registry)."""
    registry, store = deps.graph_registry, deps.graph_store
    if registry is None:
        return None
    sha = str(document["source_sha256"])
    record = GraphPublish(
        sha256=sha,
        template_id=template.id,
        graph_iri=str(rendered.graph.identifier),
        job_id=job.id,
        document_id=job.document_id,
        template_version=template.version,
        base_iri=rendered.base,
        triples=rendered.triples,
        entities=list(rendered.entities),
        target_id=target.id,
    )
    published_at = datetime.now(UTC).isoformat()

    bridge = deps.bridge
    if bridge is None:
        raise RuntimeError("no delivery bridge is configured: the graph cannot be copied")

    def write(version: int) -> None:
        body = to_turtle(with_version(rendered.graph, version, published_at))
        key = target.prefix + graph_version_key(sha, template.id, version)
        # Synchronous, inside the graph's lock, as the copy was written before the bridge.
        bridge.put_object(target.id, target.bucket, key, body, "text/turtle")
        if store is not None:
            load_tbox(deps, store, registry, template, rendered.base)
            store.put(record.graph_iri, body, "text/turtle")

    version = registry.publish(record, write)
    queue.event(
        job.id,
        "info",
        GRAPH_PUBLISHED,
        {
            "graph": record.graph_iri,
            "version": version,
            "triples": record.triples,
            "endpoint": store is not None,
        },
    )
    return version


def load_tbox(
    deps: PipelineDeps,
    store: GraphStore,
    registry: GraphRegistry,
    template: Template,
    base: str,
) -> None:
    """Load each pinned ontology and shapes version not yet in the store under this base, as
    its own graph `{base}graph/ontology/{id}/{version}`."""
    semantics = template.semantics
    if semantics is None:
        return
    for pin in {(p.id, p.version) for p in [*semantics.ontologies, *semantics.shapes]}:
        if registry.ontology_loaded(pin[0], pin[1], base):
            continue
        data = deps.store.get_optional(deps.buckets.runs, ontology_normalized_key(*pin))
        if data is None:
            raise DocumentError(
                f"{pin[0]} v{pin[1]} is not available: import it again in the library"
            )
        graph_iri = f"{base}graph/ontology/{pin[0]}/{pin[1]}"
        store.put(graph_iri, data, "application/n-triples")
        registry.record_ontology(pin[0], pin[1], base, graph_iri)


def context_values(
    template: Template,
    step: FillingStep,
    fields: dict[str, dict[str, Any]],
    tables: dict[str, list[dict[str, Any]]],
) -> list[dict[str, str]]:
    """Render a step's `context` from earlier results: field values as-is, table columns as
    distinct values with counts (most frequent first), e.g. "G17230211 (13x), GTT230211 (2x)"."""
    out = []
    for name, path in step.context.items():
        head, _, column = path.partition(".")
        if column:
            counts: dict[str, int] = {}
            for row in tables.get(head, []):
                cell = row.get(column)
                for v in cell if isinstance(cell, list) else [cell]:
                    if v not in (None, ""):
                        counts[str(v)] = counts.get(str(v), 0) + 1
            ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
            text = ", ".join(f"{v} ({n}x)" for v, n in ranked) or "(none)"
        else:
            value = (fields.get(head) or {}).get("value")
            text = ", ".join(map(str, value)) if isinstance(value, list) else str(value)
        out.append({"name": name, "path": path, "text": text})
    return out


def repeat_plan(template: Template, step: ExtractStep, doc: Prepared) -> RepeatPlan | None:
    """The occurrences a step reading a repeating section runs over (None: a plain step)."""
    section = template.repeating_section(step)
    if section is None:
        return None
    return RepeatPlan(section.id, doc.occurrences.get(section.id, []), step.key_column)


def segment_issues(doc: Prepared) -> list[dict[str, Any]]:
    """The key check's findings as job issues (step `segment`)."""
    return [
        {
            "step": SEGMENT_STEP,
            "target": i.section,
            "row": None,
            "column": None,
            "raw": None,
            "message": i.message,
        }
        for i in doc.key_issues
    ]


def key_column_issues(
    template: Template, step: FillingStep, rows: list[dict[str, Any]]
) -> list[dict[str, Any]]:
    """A row whose occurrence had no key: the worker could not fill the step's keyColumn."""
    if not isinstance(step, ExtractStep):
        return []  # only extract steps read repeating sections
    section = template.repeating_section(step)
    column = step.key_column
    if section is None or column is None or step.table is None:
        return []
    return [
        {
            "step": step.id,
            "target": step.table,
            "row": n,
            "column": column,
            "raw": None,
            "message": f"no key found in this row's occurrence of {section.id}",
        }
        for n, row in enumerate(rows, start=1)
        if row.get(column) is None
    ]


def run_step(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    loaded: LoadedTemplate,
    step: ExtractStep,
    ex: Extraction,
    model: tuple[LLMProvider, str],
    doc: Prepared,
    state: DocState,
    *,
    trigger: str,
    extra_instructions: str | None = None,
    cache: StepCache | None = None,
    progress: Progress | None = None,
) -> ExtractionResult:
    """Run one extract step with context from earlier steps (`state`); record it in step_runs."""
    provider, model_id = model
    context = dict(ex.prompt_context or {})
    context["step_context"] = context_values(loaded.template, step, state.fields, state.tables)
    context["source_file"] = job.filename or None
    if extra_instructions:
        guidance = f"Reviewer guidance for this re-run: {extra_instructions}"
        base = context.get("instructions")
        context["instructions"] = f"{base}\n\n{guidance}" if base else guidance
    ex = ex.model_copy(update={"prompt_context": context})
    images = page_images(job, deps, queue, doc.pdf, ex.page_images, doc.total_pages)
    run: dict[str, Any] = {
        "step_id": step.id,
        "trigger": trigger,
        "model": f"{provider.name}/{model_id}",
        "attempts": 0,
        "input_tokens": None,
        "output_tokens": None,
        "started_at": datetime.now(UTC).isoformat(),
    }
    try:
        result = run_step_extraction(
            job,
            deps,
            loaded.directory,
            ex,
            provider,
            model_id,
            doc.sections,
            images,
            cache=cache,
            progress=progress,
            repeat=repeat_plan(loaded.template, step, doc),
        )
    except Exception as exc:
        attempts = getattr(exc.__cause__, "attempts", [])
        queue.record_step_run(
            job.id,
            {
                **run,
                "attempts": len(attempts),
                "cached": False,
                "status": "failed",
                "error": str(exc)[:2000],
                "finished_at": datetime.now(UTC).isoformat(),
            },
        )
        raise

    def total(key: str) -> int | None:
        values = [getattr(a, key) for a in result.attempts if getattr(a, key) is not None]
        return sum(values) if values else None

    queue.record_step_run(
        job.id,
        {
            **run,
            "model": result.model_ref,
            "attempts": len(result.attempts),
            "input_tokens": total("input_tokens"),
            "output_tokens": total("output_tokens"),
            "cached": result.cached,
            "status": "succeeded",
            "finished_at": datetime.now(UTC).isoformat(),
        },
    )
    queue.event(
        job.id,
        "info",
        f"reused cached {step.id}"
        if result.cached
        else f"extracted {step.id}"
        if trigger == "process"
        else f"re-ran {step.id}",
        {"model": result.model_ref, "attempts": len(result.attempts)},
    )
    return result


def run_plugin_step(
    job: ClaimedJob,
    queue: JobQueue,
    template: Template,
    step: PluginStep,
    resolved: ResolvedPlugin,
    doc: Prepared,
    state: DocState,
) -> dict[str, Any]:
    """Run one plugin step on the text of its sections and the values before it; record it in
    step_runs (no model) and as the event `ran <step>`."""
    from .plugins import PluginContext

    ctx = PluginContext(
        job,
        template,
        step,
        {i: doc.sections.get(i, "") for i in step.sections},
        context_values(template, step, state.fields, state.tables),
        lambda message, data: advisory_event(job, queue, message, data),
    )
    run: dict[str, Any] = {
        "step_id": step.id,
        "trigger": "process",
        "model": None,
        "attempts": 1,
        "input_tokens": None,
        "output_tokens": None,
        "started_at": datetime.now(UTC).isoformat(),
    }
    try:
        data = resolved.plugin.run(ctx, resolved.settings)
    except Exception as exc:
        queue.record_step_run(
            job.id,
            {
                **run,
                "status": "failed",
                "error": str(exc)[:2000],
                "finished_at": datetime.now(UTC).isoformat(),
            },
        )
        raise
    queue.record_step_run(
        job.id, {**run, "status": "succeeded", "finished_at": datetime.now(UTC).isoformat()}
    )
    queue.event(job.id, "info", f"ran {step.id}", {"plugin": step.uses})
    return data


def rerun_template_job(
    job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, loaded: LoadedTemplate
) -> ProcessResult:
    """Re-run one extract step of a document in review: OCR text is reused from the runs
    bucket, only that step calls the model, its outputs are replaced, checks re-run, and the
    draft goes back to review."""
    template = loaded.template
    params = job.rerun or {}
    step = next((s for s in template.extract_steps() if s.id == params.get("step")), None)
    if step is None:
        raise DocumentError(
            f"no extract step {params.get('step')!r} in {template.id} v{template.version}"
        )
    ex = compile_step(template, step)
    if params.get("pageImages"):  # reviewer shows the model the page(s) to read directly
        ex = ex.model_copy(update={"page_images": [int(n) for n in params["pageImages"]]})
    ref = params.get("model") or job.model_override or ex.model
    model = JobModels(job, deps.models).resolve(ref, what=f"re-run of {step.id!r}")

    draft_key = output_key(template.id, template.version, "document", job.document_id, "json")
    document = json.loads(deps.store.get(deps.buckets.outputs, draft_key))
    stored = DocState.from_document(document)
    doc = prepare_document(job, deps, queue, template.document)

    result = run_step(
        job,
        deps,
        queue,
        loaded,
        step,
        ex,
        model,
        doc,
        stored,
        trigger="rerun",
        extra_instructions=params.get("instructions"),
    )
    # The step's issues are replaced; the SHACL ones are the previous graph's, validated below.
    kept = tuple(i for i in stored.issues if i.get("step") not in (step.id, "shacl"))
    state = replace(stored, issues=kept).apply(
        normalise_step(template, step, result.data, result.model_ref)
    )
    fields, tables, issues = state.fields, state.tables, list(state.issues)
    checks = run_checks(template, fields, tables)
    reasons = [f"re-run of step {step.id}", *_review_reasons(template, checks, issues)]
    document.update(
        source_sha256=doc.sha256,
        fields=fields,
        tables=tables,
        checks=checks,
        issues=issues,
        review_required=True,
        review_reasons=reasons,
        models=state.models,
        reruns=[
            *document.get("reruns", []),
            {
                "step": step.id,
                "model": result.model_ref,
                "instructions": params.get("instructions"),
                "page_images": params.get("pageImages"),
                "at": datetime.now(UTC).isoformat(),
            },
        ],
    )
    done = finalise(job, deps, queue, template, document, mode="draft")
    write_drafts(deps, done.outputs)
    return ProcessResult(done.outputs, done.reasons, list(template.delivery_formats()))


def _save_previews(
    job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, pdf: bytes, pages: int
) -> None:
    """JPEG previews for the review screen. A convenience: failures never fail the job."""
    try:
        for index in range(pages):
            key = page_preview_key(job.id, index + 1)
            deps.store.put(deps.buckets.runs, key, deps.render_preview(pdf, index), "image/jpeg")
    except Exception as exc:
        queue.event(job.id, "warn", "page previews unavailable", {"error": repr(exc)})


@dataclass(frozen=True)
class StepOutcome:
    """What one extract step adds to the document, normalised: a graph node's output."""

    step_id: str
    #: The step's result as checks read it: its fields by id, or `{"rows": …}` for a table.
    result: dict[str, Any]
    #: Field id -> `{value, evidence, page}`.
    fields: dict[str, dict[str, Any]]
    #: Table id -> rows (at most one table).
    tables: dict[str, list[dict[str, Any]]]
    #: Values that could not be normalised (kept as written), then rows missing their key.
    issues: tuple[dict[str, Any], ...]
    #: The model the step ran on (None: not recorded).
    model: str | None = None


@dataclass(frozen=True)
class DocState:
    """The document as a recipe's steps build it. Steps never change a state: `apply` and
    `with_check` return a new one, so each state can be kept, compared or resumed from."""

    fields: dict[str, dict[str, Any]] = field(default_factory=dict)
    tables: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    checks: dict[str, Any] = field(default_factory=dict)
    issues: tuple[dict[str, Any], ...] = ()
    #: Each step's result by step id (extract steps and checks): what check paths read.
    step_results: dict[str, Any] = field(default_factory=dict)
    #: The model each extract step ran on.
    models: dict[str, str] = field(default_factory=dict)

    def apply(self, outcome: StepOutcome) -> DocState:
        """The state after `outcome`: a step run again replaces its values where they were."""
        models = self.models
        if outcome.model is not None:
            models = {**models, outcome.step_id: outcome.model}
        return DocState(
            fields={**self.fields, **outcome.fields},
            tables={**self.tables, **outcome.tables},
            checks=self.checks,
            issues=(*self.issues, *outcome.issues),
            step_results={**self.step_results, outcome.step_id: outcome.result},
            models=models,
        )

    def with_check(self, check_id: str, result: dict[str, Any]) -> DocState:
        return replace(
            self,
            checks={**self.checks, check_id: result},
            step_results={**self.step_results, check_id: result},
        )

    @classmethod
    def from_document(cls, document: dict[str, Any]) -> DocState:
        """The state a stored draft `document.json` holds (step results are not stored)."""
        return cls(
            fields=dict(document["fields"]),
            tables=dict(document["tables"]),
            checks=dict(document.get("checks", {})),
            issues=tuple(document.get("issues", [])),
            models=dict(document.get("models", {})),
        )


def step_inputs(template: Template, step: FillingStep) -> list[str]:
    """The steps (extract or plugin) whose values `step` reads through its `context`, in pipeline order: the
    step's dependencies. (A valid recipe fills each output with one step, and a context names
    only outputs filled by earlier steps.)"""
    writer = {
        output: s.id
        for s in template.filling_steps()
        for output in [*s.fields, *([s.table] if s.table else [])]
    }
    wanted = {writer[path.partition(".")[0]] for path in step.context.values()}
    return [s.id for s in template.filling_steps() if s.id in wanted]


def normalise_step(
    template: Template, step: FillingStep, data: dict[str, Any], model: str | None = None
) -> StepOutcome:
    """A step's reply (`data`, never changed) as typed values plus the issues found."""
    order = template.document.date_order
    issues: list[dict[str, Any]] = []
    if step.fields:
        fields: dict[str, dict[str, Any]] = {}
        for field_id in step.fields:
            definition = template.field(field_id)
            entry = data.get(field_id) or {}
            value, issue = normalize_value(
                entry.get("value"), definition.type, options=definition.enum, date_order=order
            )
            fields[field_id] = {
                "value": value,
                "evidence": entry.get("evidence"),
                "page": entry.get("page"),
            }
            if issue:
                issues.append(
                    {
                        "step": step.id,
                        "target": field_id,
                        "row": None,
                        "column": None,
                        "raw": entry.get("value"),
                        "message": issue,
                    }
                )
        return StepOutcome(step.id, dict(fields), fields, {}, tuple(issues), model)

    assert step.table is not None
    table = template.table(step.table)
    rows: list[dict[str, Any]] = []
    for n, raw_row in enumerate(data.get("rows", []), start=1):
        row: dict[str, Any] = {}
        for column in table.columns:
            value, issue = normalize_value(
                raw_row.get(column.id), column.type, options=column.enum, date_order=order
            )
            row[column.id] = value
            if issue:
                issues.append(
                    {
                        "step": step.id,
                        "target": table.id,
                        "row": n,
                        "column": column.id,
                        "raw": raw_row.get(column.id),
                        "message": issue,
                    }
                )
        rows.append(row)
    issues += key_column_issues(template, step, rows)
    return StepOutcome(step.id, {"rows": rows}, {}, {table.id: rows}, tuple(issues), model)


def _review_reasons(
    template: Template, checks: dict[str, Any], issues: list[dict[str, Any]]
) -> list[str]:
    policy = template.review.required
    if policy == "never":
        return []
    reasons = ["review policy: always"] if policy == "always" else []
    keys = sum(1 for i in issues if i.get("step") == SEGMENT_STEP)
    if len(issues) > keys:
        reasons.append(f"{len(issues) - keys} normalisation issue(s)")
    if keys:
        reasons.append(f"{keys} section key issue(s)")
        reasons += [
            f"section key issue: {i['message']}" for i in issues if i.get("step") == SEGMENT_STEP
        ]
    for check_id, result in checks.items():
        unmatched = sum(1 for r in result["rows"] if r["status"] == "unmatched")
        if unmatched:
            reasons.append(f"check {check_id}: {unmatched} unmatched")
    return reasons


def _csv(header: list[str], rows: list[list[Any]]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(header)
    writer.writerows([[_cell(v) for v in row] for row in rows])
    return encode_csv(buf.getvalue())


def build_graph(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    template: Template,
    document: dict[str, Any],
) -> RenderedGraph | None:
    """The document's graph for a recipe with an ontology mapping; None without a mapping, or
    (with a `graph skipped` event) without a base IRI.

    The graph never costs the other outputs: when RDF is not delivered, a graph that cannot be
    rendered is a `graph failed` event and no graph. When it is delivered, that failure, and a
    recipe delivering only RDF while no base is set, go to review."""
    if template.semantics is None:
        return None
    formats = template.delivery_formats()
    base = deps.linked_data.effective_base() if deps.linked_data else None
    if base is None:
        if formats == ["rdf"]:
            raise DocumentError(f"RDF is the only delivered format and the {GRAPH_SKIPPED}")
        queue.event(job.id, "warn", GRAPH_SKIPPED)
        return None
    pins = [(o.id, o.version) for o in template.semantics.ontologies]
    store = deps.ontologies

    def concepts(scheme: str, label: str) -> str | None:
        return store.concept_by_label(pins, scheme, label) if store else None

    try:
        rendering = render(template, document, GraphContext(base, concepts))
        graph = rendering.graph
        turtle = to_turtle(graph)
    except psycopg.Error:
        raise  # the ontology library is unreachable: retried like any outage
    except Exception as exc:  # rdflib refuses IRIs it cannot write with a plain Exception
        if "rdf" in formats:
            raise DocumentError(f"cannot render the graph: {exc}") from exc
        queue.event(job.id, "warn", GRAPH_FAILED, {"error": str(exc)})
        return None
    return RenderedGraph(
        turtle, len(graph), graph, base, tuple(rendering.entities), dict(rendering.nodes)
    )


def shacl_check(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    template: Template,
    graph: RenderedGraph | None,
) -> ShaclReport | None:
    """Validate the document's graph against the recipe's shapes and keep the report (runs
    bucket); None without shapes or without a graph. Missing shapes are a DocumentError."""
    semantics = template.semantics
    if graph is None or semantics is None or not semantics.shapes:
        return None
    shapes = load_graphs(deps, [(p.id, p.version) for p in semantics.shapes])
    ontologies = load_graphs(deps, [(p.id, p.version) for p in semantics.ontologies])
    report = validate(graph.graph, shapes, ontologies, outputs_by_property(template), graph.nodes)
    deps.store.put(
        deps.buckets.runs,
        shacl_report_key(job.id),
        json.dumps(report.to_json()).encode(),
        "application/json",
    )
    violations = report.violations()
    if violations:
        queue.event(job.id, "warn", GRAPH_VIOLATES, {"violations": len(violations)})
    return report


def add_report(report: ShaclReport, issues: list[dict[str, Any]], reasons: list[str]) -> None:
    """Violations become review reasons; warnings and infos, issues (step `shacl`)."""
    reasons.extend(v.reason() for v in report.violations() if v.reason() not in reasons)
    issues.extend(
        {
            "step": "shacl",
            "target": r.output,
            "row": None,
            "column": None,
            "raw": r.value or None,
            "message": f"{r.severity}: {r.message}",
        }
        for r in report.results
        if r.severity != "Violation"
    )


def document_of(
    job: ClaimedJob, doc: Prepared, template: Template, state: DocState, reasons: list[str]
) -> dict[str, Any]:
    """The draft `document.json` of a job: the state its steps built and the review reasons."""
    return {
        "document_id": job.document_id,
        "job_id": job.id,
        "source_sha256": doc.sha256,
        "template": {"id": template.id, "version": template.version, "name": template.name},
        "extracted_at": datetime.now(UTC).isoformat(),
        "page_count": doc.total_pages,
        "models": state.models,
        "fields": state.fields,
        "tables": state.tables,
        "checks": state.checks,
        "issues": list(state.issues),
        "review_required": bool(reasons),
        "review_reasons": reasons,
    }


#: `draft`: an extraction or a step re-run, whose shapes report joins the draft's issues and
#: review reasons. `publish`: a reviewed document, left as it is; a delivered graph must satisfy
#: the shapes, and one that is not delivered is checked only when its shapes can be read.
FinaliseMode = Literal["draft", "publish"]


@dataclass(frozen=True)
class Finalised:
    """A document with its graph and rendered outputs, nothing written yet (but the SHACL
    report, which the check keeps in the runs bucket)."""

    document: dict[str, Any]
    graph: RenderedGraph | None
    outputs: list[RenderedOutput]

    @property
    def reasons(self) -> list[str]:
        """The document's review reasons (the list `document` holds)."""
        reasons: list[str] = self.document["review_reasons"]
        return reasons


def finalise(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    template: Template,
    document: dict[str, Any],
    *,
    mode: FinaliseMode,
) -> Finalised:
    """The ending every document shares: its graph, the shapes check, its outputs. In `draft`
    mode the report's violations become review reasons and its warnings issues (`document` is
    updated); in `publish` mode a delivered graph that violates the shapes is ShapesViolated."""
    graph = build_graph(job, deps, queue, template, document)
    delivered = "rdf" in template.delivery_formats()
    if mode == "publish" and not delivered:
        # The graph is not delivered: its report is advisory, and missing shapes never block.
        try:
            report = shacl_check(job, deps, queue, template, graph)
        except DocumentError:
            report = None
    else:
        report = shacl_check(job, deps, queue, template, graph)
    if report is not None:
        if mode == "draft":
            add_report(report, document["issues"], document["review_reasons"])
            document["review_required"] = bool(document["review_reasons"])
        elif delivered and report.violations():
            # Before any write: a delivered graph must satisfy the shapes (ADR 0011 step 5).
            raise ShapesViolated([v.reason() for v in report.violations()])
    return Finalised(document, graph, render_document(template, document, graph))


def write_drafts(deps: PipelineDeps, outputs: list[RenderedOutput]) -> None:
    """Put a draft's outputs in the outputs bucket (the reviewer and Delete find them there)."""
    for o in outputs:
        deps.store.put(deps.buckets.outputs, o.key, o.body, content_type(o.format))


def render_document(
    template: Template, document: dict[str, Any], graph: RenderedGraph | None = None
) -> list[RenderedOutput]:
    """Render a (draft or reviewed) document into the template's outputs (plus its graph)."""
    doc_id = document["document_id"]
    fields, tables = document["fields"], document["tables"]

    def key(output_id: str, fmt: str) -> str:
        return output_key(template.id, template.version, output_id, doc_id, fmt)  # type: ignore[arg-type]

    out: list[RenderedOutput] = []
    if template.outputs.fields:
        ids = [f.id for f in template.outputs.fields]
        values = [(fields.get(i) or {}).get("value") for i in ids]
        out.append(
            RenderedOutput(
                "fields",
                "csv",
                key("fields", "csv"),
                _csv([DOCUMENT_ID_COLUMN, *ids], [[doc_id, *values]]),
                1,
            )
        )
    for table in template.outputs.tables:
        cols = [c.id for c in table.columns]
        rows = tables.get(table.id, [])
        body = _csv(
            [DOCUMENT_ID_COLUMN, *cols], [[doc_id, *(r.get(c) for c in cols)] for r in rows]
        )
        out.append(RenderedOutput(table.id, "csv", key(table.id, "csv"), body, len(rows)))
    check_cols = ["value", "status", "matched", "distance", "count"]
    for check_id, result in document["checks"].items():
        rows = result["rows"]
        body = _csv(
            [DOCUMENT_ID_COLUMN, *check_cols], [[doc_id, *(r[c] for c in check_cols)] for r in rows]
        )
        out.append(RenderedOutput(check_id, "csv", key(check_id, "csv"), body, len(rows)))
    issues = document["issues"]
    body = _csv(
        [DOCUMENT_ID_COLUMN, *ISSUE_COLUMNS],
        [[doc_id, *(i.get(c) for c in ISSUE_COLUMNS)] for i in issues],
    )
    out.append(RenderedOutput("issues", "csv", key("issues", "csv"), body, len(issues)))
    body = json.dumps(document, ensure_ascii=False, indent=2).encode("utf-8")
    out.append(RenderedOutput("document", "json", key("document", "json"), body, None))
    if graph is not None and template.semantics is not None:
        out.append(RenderedOutput("graph", "rdf", key("graph", "ttl"), graph.turtle, graph.triples))
    return out
