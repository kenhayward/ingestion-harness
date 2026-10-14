"""Withdrawing what was delivered (ADR 0011 step 7): a job deletion or a retirement queues a
`withdraw` job naming the target objects and graphs to remove; unretiring queues `republish`,
which delivers the type's withdrawn jobs again."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, PositiveInt, ValidationError

from .pipeline import DocumentError, PipelineDeps, load_definition, publish_outputs
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
    what is already gone is no error, so a retry after a crash completes the withdrawal."""
    params: WithdrawParams = _params(job, WithdrawParams, "withdraw")
    target = deps.target
    if target is None:
        raise DocumentError("no publish target: nothing can be withdrawn")
    for o in params.objects:
        target.store.delete(o.bucket, o.key)
    dropped = 0
    for g in params.graphs:
        for version in g.versions:
            key = target.prefix + graph_version_key(g.sha256, g.template_id, version)
            target.store.delete(target.bucket, key)
        if g.graph_iri is not None and deps.graph_store is not None:
            deps.graph_store.delete(g.graph_iri)
            dropped += 1
    queue.event(job.id, "info", WITHDRAWN, {"objects": len(params.objects), "graphs": dropped})
    return len(params.objects), dropped


def run_republish(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> int:
    """Deliver each withdrawn job of the type again, from its reviewed document (else its draft)
    with its own recipe version: outputs to the target and recorded, its graph as a new version."""
    from .rdf_rebuild import claimed, delivered_document
    from .template_pipeline import build_graph, publish_graph, render_document

    params: RepublishParams = _params(job, RepublishParams, "republish")
    source, target = deps.delivered_jobs, deps.target
    if source is None or target is None:
        raise DocumentError("republishing needs the database and a publish target")
    count = 0
    for withdrawn in source.withdrawn_jobs(params.template_id):
        document = delivered_document(deps, withdrawn)
        if document is None:
            queue.event(job.id, "warn", "republish skipped", {"job": withdrawn.job_id})
            continue
        run = claimed(withdrawn)
        loaded = load_definition(run, deps, queue)
        if not isinstance(loaded, LoadedTemplate):
            raise DocumentError(
                f"{withdrawn.template_id} v{withdrawn.template_version} is no recipe"
            )
        template = loaded.template
        graph = build_graph(run, deps, queue, template, document)
        formats = template.delivery_formats()
        rendered = render_document(template, document, graph)
        published = publish_outputs(deps, [o for o in rendered if o.format in formats])
        queue.record_published(run, published, target.bucket)
        if graph is not None and "rdf" in formats:
            publish_graph(run, deps, queue, template, document, graph)
        count += 1
    queue.event(job.id, "info", REPUBLISHED, {"jobs": count})
    return count
