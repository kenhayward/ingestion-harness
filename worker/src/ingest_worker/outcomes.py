"""What a job's run ends in, as values (docs/design/worker-nodes-refactor.md, part 4).

A task's handler (main.TASKS) does its work and returns an Outcome; `apply_outcome` alone
writes the job's status, and hands an extraction without review to the delivery bridge (ADR
0017), in the order the worker has always made them. Errors still raise: a DocumentError (needs review), JobCancelled
and outages are mapped by main._run_claimed."""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any

from .bridge.package import deliver_document
from .outputs import RenderedOutput
from .pipeline import PipelineDeps, Target, check_cancelled
from .queue import ClaimedJob, JobQueue

if TYPE_CHECKING:
    from .template import Template
    from .template_pipeline import GraphDelivery

log = logging.getLogger("ingest_worker")


@dataclass(frozen=True)
class Complete:
    """The job succeeded; its outputs (if any) are recorded with it."""

    outputs: list[RenderedOutput] = field(default_factory=list)
    #: What the worker logs about it.
    note: str = "succeeded"


@dataclass(frozen=True)
class AwaitReview:
    """A person must review the document before anything is delivered."""

    outputs: list[RenderedOutput]
    reasons: list[str]
    #: Record `outputs` as the job's drafts first (findable by Delete), then stop at a safe
    #: point if the job was cancelled meanwhile. False: a refused publish, which wrote nothing.
    drafts: bool = True
    note: str = "awaiting review"


@dataclass(frozen=True)
class Deliver:
    """An extraction that needs no review: its drafts are recorded, then `delivered` is handed
    to the bridge for `target` (None: a test run, or no targets; the job then succeeds) as one
    package with `document` (the recipe's data; None for legacy specs) and, once handed over,
    `graph`. The job is then delivering until the bridge's events finish it."""

    outputs: list[RenderedOutput]
    delivered: list[RenderedOutput]
    target: Target | None
    graph: GraphDelivery | None = None
    document: dict[str, Any] | None = None
    template: Template | None = None
    note: str = "succeeded"


@dataclass(frozen=True)
class Delivering:
    """The bridge accepted the job's packages: the job waits in `delivering` (its `outputs`
    recorded as drafts) until the bridge's events for `deliveries` (target id, delivery id)
    finish it."""

    outputs: list[RenderedOutput]
    deliveries: list[tuple[str, str]]
    note: str = "handed to the bridge"


Outcome = Complete | AwaitReview | Deliver | Delivering
TaskHandler = Callable[[ClaimedJob, PipelineDeps, JobQueue], Outcome]


def apply_outcome(job: ClaimedJob, outcome: Outcome, queue: JobQueue, deps: PipelineDeps) -> None:
    """Write `outcome`: the job's status, and for Deliver the hand-off to the bridge itself."""
    bucket = deps.buckets.outputs
    if isinstance(outcome, Complete):
        queue.complete(job, outcome.outputs, bucket)
        log.info("job %s %s", job.id, outcome.note)
        return
    if isinstance(outcome, AwaitReview):
        if outcome.drafts:
            queue.record_drafts(job, outcome.outputs, bucket)
            check_cancelled(job, queue)
        queue.await_review(job, outcome.outputs, bucket, outcome.reasons)
        log.info("job %s %s: %s", job.id, outcome.note, "; ".join(outcome.reasons))
        return
    if isinstance(outcome, Delivering):
        queue.delivering(job, outcome.outputs, bucket, outcome.deliveries)
        log.info("job %s %s", job.id, outcome.note)
        return
    queue.record_drafts(job, outcome.outputs, bucket)
    check_cancelled(job, queue)
    target = outcome.target
    if target is None or not outcome.delivered:
        queue.complete(job, outcome.outputs, bucket)
        log.info("job %s %s with %d outputs", job.id, outcome.note, len(outcome.outputs))
        return
    check_cancelled(job, queue)
    published, delivery_id = deliver_document(
        deps,
        job,
        template=outcome.template,
        document=outcome.document,
        outputs=outcome.delivered,
        target=target,
        acting=queue.uploader(job.id),  # auto-published: the uploader acts
        approver=None,
    )
    queue.record_published(job, published, target, delivery_id)
    if outcome.graph is not None:
        outcome.graph.deliver(job, deps, queue, target)
    queue.delivering(job, outcome.outputs, bucket, [(target.id, delivery_id)])
    log.info("job %s handed %d outputs to the bridge", job.id, len(published))
