"""Operator cancellation: the worker stops at safe points and never writes a status."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from ingest_worker.main import run_once
from ingest_worker.storage import MemoryObjectStore

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


class EventsFail(FakeQueue):
    """The job row was deleted mid-run: every write for it raises (FK violation)."""

    def event(
        self, job_id: str, level: str, message: str, data: dict[str, Any] | None = None
    ) -> None:
        raise RuntimeError("insert or update on table job_events violates foreign key")


def test_the_worker_survives_writes_failing_for_a_deleted_job(tmp_path: Path) -> None:
    deps, provider, _ = make(tmp_path)
    provider.responses = [RuntimeError("LLM down")] * 10
    queue = EventsFail(jobs=[JOB], templates={("demo", 1): TEMPLATE})
    assert run_once(queue, deps, "w1") is True  # no exception escapes the poll loop


def test_drafts_written_before_a_late_cancel_are_recorded_so_delete_can_remove_them(
    tmp_path: Path,
) -> None:
    deps, _, _ = make(tmp_path)
    store = deps.store
    assert isinstance(store, MemoryObjectStore)
    queue = FakeQueue(
        jobs=[JOB],
        templates={("demo", 1): TEMPLATE},
        # cancelled the moment the drafts exist: after the last step, before await_review
        cancel_when=lambda: any(bucket == "outputs" for bucket, _ in store.objects),
    )
    run_once(queue, deps, "w1")
    assert not queue.awaiting
    assert (JOB.id, "warn", "cancelled") in queue.events
    [(job_id, outputs)] = queue.drafts
    assert job_id == JOB.id
    assert {o.output_id for o in outputs} >= {"document", "issues"}
    assert all(deps.store.get_optional("outputs", o.key) for o in outputs)
