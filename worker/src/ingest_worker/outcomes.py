"""What a job's run ends in, as values (docs/design/worker-nodes-refactor.md, part 4).

A task's handler (main.TASKS) does its work and returns an Outcome; `apply_outcome` alone
writes the job's status, and the deliveries an extraction without review makes, in the order
the worker has always made them. Errors still raise: a DocumentError (needs review), JobCancelled
and outages are mapped by main._run_claimed."""

from __future__ import annotations

import logging
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import TYPE_CHECKING

from .outputs import RenderedOutput
from .pipeline import PipelineDeps, Target, check_cancelled, publish_outputs
from .queue import ClaimedJob, JobQueue

if TYPE_CHECKING:
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
    """An extraction that needs no review: its drafts are recorded, then `delivered` goes to
    `target` (None: a test run, or no targets) and, once something was delivered, `graph`."""

    outputs: list[RenderedOutput]
    delivered: list[RenderedOutput]
    target: Target | None
    graph: GraphDelivery | None = None
    note: str = "succeeded"


Outcome = Complete | AwaitReview | Deliver
TaskHandler = Callable[[ClaimedJob, PipelineDeps, JobQueue], Outcome]


def apply_outcome(job: ClaimedJob, outcome: Outcome, queue: JobQueue, deps: PipelineDeps) -> None:
    """Write `outcome`: the job's status, and for Deliver the delivery itself."""
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
    queue.record_drafts(job, outcome.outputs, bucket)
    check_cancelled(job, queue)
    target = outcome.target
    published = [] if target is None else publish_outputs(deps, outcome.delivered, target)
    if target is not None and published:
        queue.record_published(job, published, target)
        if outcome.graph is not None:
            outcome.graph.deliver(job, deps, queue, target)
    queue.complete(job, outcome.outputs, bucket)
    log.info("job %s %s with %d outputs", job.id, outcome.note, len(outcome.outputs))
