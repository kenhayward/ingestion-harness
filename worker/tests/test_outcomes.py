"""Outcomes as values (docs/design/worker-nodes-refactor.md, part 4): every task's handler
returns an Outcome, and apply_outcome alone writes the job's status."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from ingest_worker.main import TASKS
from ingest_worker.outcomes import AwaitReview, Complete, Deliver, apply_outcome
from ingest_worker.outputs import RenderedOutput
from ingest_worker.pipeline import Buckets, JobCancelled, PipelineDeps, Target
from ingest_worker.storage import MemoryObjectStore

from .fakes import FakeQueue
from .test_template_pipeline import JOB

MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"
CSV = RenderedOutput("fields", "csv", "demo/v1/fields/doc-1.csv", b"a\n", 1)
JSON = RenderedOutput("document", "json", "demo/v1/document/doc-1.json", b"{}", None)


def deps() -> PipelineDeps:
    return PipelineDeps(
        store=MemoryObjectStore(),
        specs=None,  # type: ignore[arg-type]
        models=None,  # type: ignore[arg-type]
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
    )


def task_kinds() -> set[str]:
    """The tasks the newest `jobs_task_check` allows (migrations apply in name order)."""
    found: set[str] = set()
    for path in sorted(MIGRATIONS.glob("*.sql")):
        text = path.read_text(encoding="utf-8")
        for match in re.finditer(r"jobs_task_check\s+CHECK\s*\(task IN \(([^)]*)\)\)", text):
            found = set(re.findall(r"'([a-z]+)'", match.group(1)))
    return found


def test_every_task_the_database_allows_has_a_handler() -> None:
    kinds = task_kinds()
    assert "process" in kinds and "rebuild" in kinds
    assert set(TASKS) == kinds


def test_complete_finishes_the_job_with_its_outputs() -> None:
    queue = FakeQueue()
    apply_outcome(JOB, Complete([JSON], note="done"), queue, deps())
    assert queue.completed == [("job-1", [JSON])]
    assert not queue.drafts and not queue.awaiting


def test_a_draft_waiting_for_review_is_recorded_first() -> None:
    queue = FakeQueue()
    apply_outcome(JOB, AwaitReview([CSV, JSON], ["review policy: always"]), queue, deps())
    assert queue.drafts == [("job-1", [CSV, JSON])]
    assert queue.awaiting == [("job-1", [CSV, JSON], ["review policy: always"])]


def test_a_cancel_after_the_drafts_are_recorded_stops_before_review() -> None:
    queue = FakeQueue(cancel_when=lambda: True)
    with pytest.raises(JobCancelled):
        apply_outcome(JOB, AwaitReview([JSON], ["x"]), queue, deps())
    assert queue.drafts == [("job-1", [JSON])] and not queue.awaiting


def test_a_refused_publish_goes_back_to_review_without_drafts() -> None:
    queue = FakeQueue(cancel_when=lambda: True)  # nothing more is written, so no safe point
    apply_outcome(JOB, AwaitReview([], ["SHACL: x"], drafts=False), queue, deps())
    assert not queue.drafts and queue.awaiting == [("job-1", [], ["SHACL: x"])]


def test_deliver_publishes_to_the_target_then_completes() -> None:
    queue, store = FakeQueue(), MemoryObjectStore()
    target = Target(store=store, bucket="published", prefix="pvp/", id="lake")
    apply_outcome(JOB, Deliver([CSV, JSON], [CSV], target), queue, deps())
    assert queue.drafts == [("job-1", [CSV, JSON])]
    assert list(store.objects) == [("published", "pvp/demo/v1/fields/doc-1.csv")]
    [(job_id, published, target_id)] = queue.published
    assert (job_id, [o.key for o in published], target_id) == (
        "job-1",
        ["pvp/demo/v1/fields/doc-1.csv"],
        "lake",
    )
    assert queue.completed == [("job-1", [CSV, JSON])]


def test_deliver_without_a_target_only_completes() -> None:
    queue = FakeQueue()
    apply_outcome(JOB, Deliver([JSON], [JSON], None), queue, deps())
    assert not queue.published and queue.completed == [("job-1", [JSON])]


def test_deliver_with_nothing_to_deliver_records_no_publication() -> None:
    queue, store = FakeQueue(), MemoryObjectStore()
    apply_outcome(JOB, Deliver([JSON], [], Target(store=store, bucket="b")), queue, deps())
    assert not queue.published and not store.objects and queue.completed


def test_a_cancel_before_delivery_delivers_nothing() -> None:
    queue, store = FakeQueue(cancel_when=lambda: True), MemoryObjectStore()
    with pytest.raises(JobCancelled):
        apply_outcome(JOB, Deliver([CSV], [CSV], Target(store=store, bucket="b")), queue, deps())
    assert not store.objects and not queue.published and not queue.completed
