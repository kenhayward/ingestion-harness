"""Withdrawing what was delivered (ADR 0011 step 7): a job deletion or a retirement queues a
`withdraw` job naming the target objects and graphs to remove; unretiring queues `republish`,
which delivers the type's withdrawn jobs again."""

from __future__ import annotations

import functools
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, PositiveInt, ValidationError

from .graph_registry import PublishedGraph
from .pipeline import DocumentError, PipelineDeps, Target, load_definition, publish_outputs
from .queue import ClaimedJob, JobQueue
from .specs import LoadedTemplate
from .storage import graph_version_key


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class TargetObject(_Strict):
    bucket: str = Field(min_length=1)
    key: str = Field(min_length=1)


class WithdrawnGraph(_Strict):
    sha256: str = Field(min_length=1)
    template_id: str = Field(alias="templateId", min_length=1)
    #: Set: drop the graph itself (else only the listed versions' copies go).
    graph_iri: str | None = Field(alias="graphIri", min_length=1)
    versions: list[PositiveInt]


class WithdrawParams(_Strict):
    """Mirrors `WithdrawParamsSchema` (packages/shared/src/jobs.ts)."""

    objects: list[TargetObject]
    graphs: list[WithdrawnGraph]


class RepublishParams(_Strict):
    template_id: str = Field(alias="templateId", min_length=1)


#: Job events (`{objects, graphs}` / `{jobs}`).
WITHDRAWN = "withdrawn"
REPUBLISHED = "republished"


def _params(job: ClaimedJob, model: type[_Strict], task: str) -> Any:
    try:
        return model.model_validate(job.params or {})
    except ValidationError as exc:
        raise DocumentError(f"invalid {task} parameters: {exc}") from exc


def run_withdraw(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> tuple[int, int]:
    """Remove the target objects, every listed version copy and each graph named. Idempotent:
    what is already gone is no error, so a retry after a crash completes the withdrawal. What was
    delivered again since the withdrawal was queued is spared: an object a live output has, a
    version with a row, and a graph with a current version (checked under the graph's lock)."""
    params: WithdrawParams = _params(job, WithdrawParams, "withdraw")
    target, source, registry = deps.target, deps.delivered_jobs, deps.graph_registry
    if target is None:
        raise DocumentError("no publish target: nothing can be withdrawn")
    objects = 0
    for o in params.objects:
        if source is not None and source.object_live(o.bucket, o.key):
            continue
        target.store.delete(o.bucket, o.key)
        objects += 1
    dropped: list[int] = []
    for g in params.graphs:
        work = functools.partial(_withdraw_graph, deps, target, g, dropped)
        if registry is None:
            work(None, set())
        else:
            registry.locked(g.sha256, g.template_id, work)
    queue.event(job.id, "info", WITHDRAWN, {"objects": objects, "graphs": sum(dropped)})
    return objects, sum(dropped)


def _withdraw_graph(
    deps: PipelineDeps,
    target: Target,
    g: WithdrawnGraph,
    dropped: list[int],
    current: PublishedGraph | None,
    versions: set[int],
) -> None:
    """One graph's copies, and the graph itself, sparing a version published since."""
    for version in g.versions:
        if version in versions:
            continue  # published again since: its copy is the new one
        target.store.delete(
            target.bucket, target.prefix + graph_version_key(g.sha256, g.template_id, version)
        )
    if g.graph_iri is not None and current is None and deps.graph_store is not None:
        deps.graph_store.delete(g.graph_iri)
        dropped.append(1)


def run_republish(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> int:
    """Deliver each withdrawn job of the type again, from its reviewed document (else its draft)
    with its own recipe version: outputs to the target, its graph as a new version, then the
    record (a failure before it leaves the job withdrawn, so the retry finds it again). A type
    retired again meanwhile is left withdrawn; a job that cannot be rendered is skipped."""
    from .rdf_rebuild import claimed, delivered_document
    from .template_pipeline import build_graph, publish_graph, render_document

    params: RepublishParams = _params(job, RepublishParams, "republish")
    source, target = deps.delivered_jobs, deps.target
    if source is None or target is None:
        raise DocumentError("republishing needs the database and a publish target")
    if source.is_retired(params.template_id):
        queue.event(job.id, "info", "republish skipped: retired", {"type": params.template_id})
        return 0
    count = 0
    for withdrawn in source.withdrawn_jobs(params.template_id):
        try:
            document = delivered_document(deps, withdrawn)
            if document is None:
                raise DocumentError("no reviewed or draft document")
            run = claimed(withdrawn)
            loaded = load_definition(run, deps, queue)
            if not isinstance(loaded, LoadedTemplate):
                raise DocumentError("not a recipe: legacy spec outputs are not re-delivered")
            template = loaded.template
            graph = build_graph(run, deps, queue, template, document)
        except (DocumentError, LookupError) as exc:
            queue.event(
                job.id, "warn", "republish skipped", {"job": withdrawn.job_id, "reason": str(exc)}
            )
            continue
        formats = template.delivery_formats()
        rendered = render_document(template, document, graph)
        published = publish_outputs(deps, [o for o in rendered if o.format in formats])
        if graph is not None and "rdf" in formats:
            publish_graph(run, deps, queue, template, document, graph)
        queue.record_published(run, published, target.bucket)
        count += 1
    queue.event(job.id, "info", REPUBLISHED, {"jobs": count})
    return count
