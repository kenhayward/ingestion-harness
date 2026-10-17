"""The worker's dispatch of document-less maintenance tasks (main._run_claimed)."""

from __future__ import annotations

from typing import Any

import pytest

from ingest_worker import rdf_rebuild
from ingest_worker.llm.registry import ModelRegistry
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.queue import ClaimedJob, JobQueue
from ingest_worker.rdf_rebuild import MemoryRebuildSource, RebuildSource
from ingest_worker.specs import SpecRegistry
from ingest_worker.storage import MemoryObjectStore

from .fakes import FakeQueue

SOURCE = MemoryRebuildSource()


def deps() -> PipelineDeps:
    return PipelineDeps(
        store=MemoryObjectStore(),
        specs=SpecRegistry([]),
        models=ModelRegistry({}, {}, {}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        delivered_jobs=SOURCE,
    )


def rebuild_job(params: dict[str, Any]) -> ClaimedJob:
    return ClaimedJob(
        "44444444-4444-4444-8444-444444444444", "", "", 0, "", "", None, 1, 10,
        task="rebuild", params=params,
    )  # fmt: skip


def test_rebuild_task_runs_remint(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[tuple[JobQueue, RebuildSource]] = []

    def remint(_deps: PipelineDeps, queue: JobQueue, source: RebuildSource) -> list[str]:
        calls.append((queue, source))
        return ["remint under https://staging.example/: 2 re-minted, 0 already there, 0 failed"]

    monkeypatch.setattr(rdf_rebuild, "remint", remint)
    queue = FakeQueue(jobs=[rebuild_job({"mode": "remint"})])
    assert run_once(queue, deps(), "w1")
    assert calls == [(queue, SOURCE)]
    assert queue.completed == [("44444444-4444-4444-8444-444444444444", [])]


def test_rebuild_task_reloads_the_store(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[PipelineDeps] = []

    def rebuild(d: PipelineDeps) -> list[str]:
        calls.append(d)
        return ["rebuild: 1 ontology graphs, 3 document graphs, 0 missing"]

    monkeypatch.setattr(rdf_rebuild, "rebuild", rebuild)
    d = deps()
    queue = FakeQueue(jobs=[rebuild_job({"mode": "rebuild"})])
    assert run_once(queue, d, "w1")
    assert calls == [d]
    assert queue.completed


@pytest.mark.parametrize("params", [{}, {"mode": "backfill"}, {"mode": "remint", "extra": 1}])
def test_rebuild_task_with_bad_params_goes_to_review(params: dict[str, Any]) -> None:
    queue = FakeQueue(jobs=[rebuild_job(params)])
    run_once(queue, deps(), "w1")
    assert not queue.completed
    [(_, reason)] = queue.reviewed
    assert reason.startswith("invalid rebuild parameters")


def test_a_paused_queue_hands_out_nothing() -> None:
    queue = FakeQueue(jobs=[rebuild_job({"mode": "rebuild"})], paused=True)
    assert not run_once(queue, deps(), "w1")
    assert queue.jobs
