"""Step progress events (Workbench tabs TR3): one per model call of a Workbench run."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

from ingest_worker.config import REPO_ROOT
from ingest_worker.main import run_once
from ingest_worker.template_pipeline import STEP_PROGRESS

from .fakes import FakeQueue
from .test_step_context import make
from .test_template_pipeline import JOB, RESPONSES, TEMPLATE

FIXTURE = REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "step-progress.json"
EXPECTED: list[dict[str, Any]] = json.loads(FIXTURE.read_text(encoding="utf-8"))["templateRun"]

WORKBENCH = replace(JOB, test=True, project_id="demo", params={"dataPolicy": "external"})


def run(tmp_path: Path, job: Any, responses: list[Any]) -> FakeQueue:
    deps, _ = make(tmp_path, responses)
    queue = FakeQueue(jobs=[job], templates={("demo", 1): TEMPLATE})
    run_once(queue, deps, "w1")
    return queue


def progress(queue: FakeQueue) -> list[dict[str, Any]]:
    return [data for _, _, message, data in queue.event_details if message == STEP_PROGRESS]


def test_a_workbench_run_reports_each_model_call_like_the_shared_fixture(tmp_path: Path) -> None:
    queue = run(tmp_path, WORKBENCH, RESPONSES)
    assert queue.completed or queue.awaiting  # the run itself is unaffected
    assert progress(queue) == EXPECTED


def test_a_retried_attempt_is_reported(tmp_path: Path) -> None:
    queue = run(tmp_path, WORKBENCH, ["not json", *RESPONSES])
    assert [(e["step"], e["attempt"]) for e in progress(queue)[:3]] == [
        ("header", 1),
        ("header", 2),
        ("date", 1),
    ]


def test_production_jobs_write_no_progress(tmp_path: Path) -> None:
    queue = run(tmp_path, JOB, RESPONSES)
    assert progress(queue) == []


def test_a_step_served_from_the_cache_reports_nothing(tmp_path: Path) -> None:
    deps, _ = make(tmp_path, RESPONSES)
    first = FakeQueue(jobs=[WORKBENCH], templates={("demo", 1): TEMPLATE})
    run_once(first, deps, "w1")
    second = FakeQueue(jobs=[replace(WORKBENCH, id="job-2")], templates={("demo", 1): TEMPLATE})
    run_once(second, deps, "w1")
    assert progress(first) == EXPECTED
    assert progress(second) == []


class _BrokenEvents(FakeQueue):
    def event(
        self, job_id: str, level: str, message: str, data: dict[str, Any] | None = None
    ) -> None:
        if message == STEP_PROGRESS:
            raise RuntimeError("database blip")
        super().event(job_id, level, message, data)


def test_a_failed_progress_write_never_fails_the_run(tmp_path: Path) -> None:
    deps, _ = make(tmp_path, RESPONSES)
    queue = _BrokenEvents(jobs=[WORKBENCH], templates={("demo", 1): TEMPLATE})
    run_once(queue, deps, "w1")
    assert queue.failed == [] and queue.reviewed == []
    assert queue.completed or queue.awaiting
