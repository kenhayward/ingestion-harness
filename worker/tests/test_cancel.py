"""Operator cancellation: the worker stops at safe points and never writes a status."""

from __future__ import annotations

from pathlib import Path

from ingest_worker.main import run_once

from .fakes import FakeQueue
from .test_template_db import make
from .test_template_pipeline import JOB, TEMPLATE


def test_cancel_during_the_pipeline_stops_before_the_next_step(tmp_path: Path) -> None:
    deps, provider, _ = make(tmp_path)
    queue = FakeQueue(
        jobs=[JOB],
        templates={("demo", 1): TEMPLATE},
        cancel_when=lambda: len(provider.calls) >= 1,
    )
    assert run_once(queue, deps, "w1") is True
    assert 1 <= len(provider.calls) < 4  # the remaining steps never ran
    assert not (queue.awaiting or queue.completed or queue.reviewed or queue.failed)
    assert (JOB.id, "warn", "cancelled") in queue.events


def test_cancel_before_publishing_delivers_nothing(tmp_path: Path) -> None:
    deps, provider, target = make(tmp_path)
    no_review = {**TEMPLATE, "review": {"required": "never"}}
    queue = FakeQueue(
        jobs=[JOB],
        templates={("demo", 1): no_review},
        cancel_when=lambda: len(provider.calls) >= 4,  # all steps ran
    )
    run_once(queue, deps, "w1")
    assert len(provider.calls) == 4
    assert target.objects == {}
    assert not (queue.completed or queue.published or queue.failed)
    assert (JOB.id, "warn", "cancelled") in queue.events


def test_jobs_that_are_not_cancelled_run_normally(tmp_path: Path) -> None:
    deps, _, _ = make(tmp_path)
    queue = FakeQueue(jobs=[JOB], templates={("demo", 1): TEMPLATE}, cancel_when=lambda: False)
    run_once(queue, deps, "w1")
    assert queue.awaiting
