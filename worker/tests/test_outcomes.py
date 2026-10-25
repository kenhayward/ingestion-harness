"""Outcomes as values (docs/design/worker-nodes-refactor.md, part 4): every task's handler
returns an Outcome, and apply_outcome alone writes the job's status."""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from ingest_worker.main import TASKS
from ingest_worker.outcomes import AwaitReview, Complete, Deliver, Delivering, apply_outcome
from ingest_worker.outputs import RenderedOutput
from ingest_worker.pipeline import Buckets, JobCancelled, PipelineDeps, Target
from ingest_worker.storage import MemoryObjectStore

from .fakes import FakeBridge, FakeQueue
from .test_template_pipeline import JOB

MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"
CSV = RenderedOutput("fields", "csv", "demo/v1/fields/doc-1.csv", b"a\n", 1)
JSON = RenderedOutput("document", "json", "demo/v1/document/doc-1.json", b"{}", None)


def deps(bridge: FakeBridge | None = None) -> PipelineDeps:
    return PipelineDeps(
        store=MemoryObjectStore(),
        specs=None,  # type: ignore[arg-type]
        models=None,  # type: ignore[arg-type]
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        bridge=bridge,
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


def test_deliver_hands_the_package_to_the_bridge_then_the_job_is_delivering() -> None:
    queue, bridge = FakeQueue(), FakeBridge({"lake": ("published", "pvp/")})
    target = Target("lake", "published", "pvp/")
    apply_outcome(JOB, Deliver([CSV, JSON], [CSV], [target]), queue, deps(bridge))
    assert queue.drafts == [("job-1", [CSV, JSON])]
    # The bridge's S3 sink writes at the target's prefix + today's key.
    assert list(bridge.objects) == [("published", "pvp/demo/v1/fields/doc-1.csv")]
    [(job_id, published, target_id)] = queue.published
    assert (job_id, [o.key for o in published], target_id) == (
        "job-1",
        ["pvp/demo/v1/fields/doc-1.csv"],
        "lake",
    )
    [(_, _, delivery_id)] = queue.published_deliveries
    assert queue.handed_over == [("job-1", [CSV, JSON], [("lake", delivery_id)])]
    assert not queue.completed


def test_delivering_waits_for_the_bridge() -> None:
    queue = FakeQueue()
    apply_outcome(JOB, Delivering([], [("lake", "d-1")]), queue, deps())
    assert queue.handed_over == [("job-1", [], [("lake", "d-1")])] and not queue.completed


def test_deliver_without_a_target_only_completes() -> None:
    queue = FakeQueue()
    apply_outcome(JOB, Deliver([JSON], [JSON], []), queue, deps())
    assert not queue.published and queue.completed == [("job-1", [JSON])]


def test_deliver_with_nothing_to_deliver_records_no_publication() -> None:
    queue, bridge = FakeQueue(), FakeBridge()
    apply_outcome(JOB, Deliver([JSON], [], [Target("b", "b", "")]), queue, deps(bridge))
    assert not queue.published and not bridge.requests and queue.completed


def test_a_cancel_before_delivery_delivers_nothing() -> None:
    queue, bridge = FakeQueue(cancel_when=lambda: True), FakeBridge()
    with pytest.raises(JobCancelled):
        apply_outcome(JOB, Deliver([CSV], [CSV], [Target("b", "b", "")]), queue, deps(bridge))
    assert not bridge.requests and not queue.published and not queue.handed_over
