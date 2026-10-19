"""Withdrawing what was delivered (ADR 0011 step 7): a job deletion or a retirement queues a
`withdraw` job naming the target objects and graphs to remove; unretiring queues `republish`,
which delivers the type's withdrawn jobs again."""

from __future__ import annotations

import functools
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, PositiveInt, ValidationError

from .bridge.client import BridgeClient
from .graph_registry import PublishedGraph
from .pipeline import (
    DocumentError,
    PipelineDeps,
    Targets,
    load_definition,
)
from .queue import ClaimedJob, JobQueue
from .specs import LoadedTemplate
from .storage import graph_version_key

#: Held in step with `TARGET_ID` in packages/shared/src/publish-targets.ts.
TARGET_ID = r"^[a-z0-9][a-z0-9_-]{0,39}$"


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class TargetObject(_Strict):
    bucket: str = Field(min_length=1)
    key: str = Field(min_length=1)
    #: The publishing target the object was delivered to: it is deleted through that target.
    target: str = Field(pattern=TARGET_ID)


class WithdrawnGraph(_Strict):
    sha256: str = Field(min_length=1)
    template_id: str = Field(alias="templateId", min_length=1)
    #: Set: drop the graph itself (else only the listed versions' copies go). One graph may have
    #: an entry per target holding copies; only the one holding the current graph names it.
    graph_iri: str | None = Field(alias="graphIri", min_length=1)
    #: The publishing target holding the listed versions' copies (under its prefix).
    target: str = Field(pattern=TARGET_ID)
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
    """Remove the target objects, every listed version copy and each graph named, each through
    the publishing target it was delivered to (every target is resolved first: a missing one
    deletes nothing). Idempotent: what is already gone is no error, so a retry after a crash
    completes the withdrawal. What was delivered again since the withdrawal was queued is
    spared: an object a live output of the same target has, a version with a row, and a graph
    with a current version (checked under the graph's lock)."""
    params: WithdrawParams = _params(job, WithdrawParams, "withdraw")
    targets, source, registry = deps.targets, deps.delivered_jobs, deps.graph_registry
    bridge = deps.bridge
    if targets is None:
        raise DocumentError("no publishing targets: nothing can be withdrawn")
    if bridge is None:
        raise RuntimeError("no delivery bridge is configured: nothing can be withdrawn")
    for name in dict.fromkeys(
        [o.target for o in params.objects] + [g.target for g in params.graphs]
    ):
        targets.get(name)
    # Through the target each object was delivered to: the bridge deletes it with that target's
    # connection, whether it was delivered before the bridge existed or by one of its deliveries.
    by_target: dict[str, list[tuple[str, str]]] = {}
    for o in params.objects:
        if source is not None and source.object_live(o.target, o.bucket, o.key):
            continue
        by_target.setdefault(o.target, []).append((o.bucket, o.key))
    objects = sum(bridge.delete_objects(t, refs) for t, refs in by_target.items())
    by_graph: dict[tuple[str, str], list[WithdrawnGraph]] = {}
    for g in params.graphs:
        by_graph.setdefault((g.sha256, g.template_id), []).append(g)
    dropped: list[int] = []
    for (sha256, template_id), entries in by_graph.items():
        work = functools.partial(_withdraw_graph, deps, targets, bridge, entries, dropped)
        if registry is None:
            work(None, set())
        else:
            registry.locked(sha256, template_id, work)
    queue.event(job.id, "info", WITHDRAWN, {"objects": objects, "graphs": sum(dropped)})
    return objects, sum(dropped)


def _withdraw_graph(
    deps: PipelineDeps,
    targets: Targets,
    bridge: BridgeClient,
    entries: list[WithdrawnGraph],
    dropped: list[int],
    current: PublishedGraph | None,
    versions: set[int],
) -> None:
    """One graph's copies, each entry's through its own target, and the graph itself (once),
    sparing a version published since."""
    for g in entries:
        target = targets.get(g.target)
        copies = [
            (target.bucket, target.prefix + graph_version_key(g.sha256, g.template_id, version))
            for version in g.versions
            if version not in versions  # published again since: its copy is the new one
        ]
        bridge.delete_objects(target.id, copies)
    graph_iri = next((g.graph_iri for g in entries if g.graph_iri is not None), None)
    if graph_iri is not None and current is None and deps.graph_store is not None:
        deps.graph_store.delete(graph_iri)
        dropped.append(1)


def run_republish(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> list[tuple[str, str]]:
    """Deliver each withdrawn job of the type again, from its reviewed document (else its draft)
    with its own recipe version: outputs to that version's publishing target, its graph as a new
    version, then the record (a failure before it leaves the job withdrawn, so the retry finds it
    again; a missing target is a DocumentError for the whole run). A type retired again
    meanwhile is left withdrawn; a job that cannot be rendered is skipped. Each delivery acts as
    the person who pressed Republish; returns the (target id, delivery id) of every delivery,
    which the bridge's events finish."""
    from .rdf_rebuild import claimed, delivered_document
    from .template_pipeline import build_graph, deliver_publication, render_document

    params: RepublishParams = _params(job, RepublishParams, "republish")
    source, targets = deps.delivered_jobs, deps.targets
    if source is None or targets is None:
        raise DocumentError("republishing needs the database and the publishing targets")
    if source.is_retired(params.template_id):
        queue.event(job.id, "info", "republish skipped: retired", {"type": params.template_id})
        return []
    acting = queue.uploader(job.id)  # who pressed Republish
    deliveries: list[tuple[str, str]] = []
    jobs = 0
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
        target = targets.get(template.publish_to())  # the job's version's own target
        formats = template.delivery_formats()
        rendered = render_document(template, document, graph)
        delivered = deliver_publication(
            run,
            deps,
            queue,
            template=template,
            document=document,
            outputs=[o for o in rendered if o.format in formats],
            graph=graph if "rdf" in formats else None,
            target=target,
            acting=acting,
            approver=queue.reviewer(run.id),
        )
        queue.record_published(run, delivered.outputs, target, delivered.s3[1])
        deliveries.extend(delivered.deliveries)
        jobs += 1
    queue.event(job.id, "info", REPUBLISHED, {"jobs": jobs})
    return deliveries
