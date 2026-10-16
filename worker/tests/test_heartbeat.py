"""Job heartbeats: a running job keeps its claim fresh, so only a stopped worker's job is reaped."""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from pathlib import Path

from ingest_worker.heartbeat import beating
from ingest_worker.main import run_once
from ingest_worker.queue import ClaimedJob

from .fakes import FakeQueue
from .test_ontology_embed import embed_job, make, saved


def wait_until(check: Callable[[], bool], timeout_s: float = 2.0) -> bool:
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        if check():
            return True
        time.sleep(0.005)
    return check()


def test_beats_every_interval_until_the_job_ends() -> None:
    beats: list[float] = []

    def beat() -> bool:
        beats.append(time.monotonic())
        return True

    with beating(beat, 0.01, on_lost=lambda: None):
        assert wait_until(lambda: len(beats) >= 3)
    ended = len(beats)
    time.sleep(0.05)
    assert len(beats) == ended  # no beat after the job


def test_stops_beating_once_the_job_is_no_longer_its_own() -> None:
    beats: list[int] = []
    lost = threading.Event()

    def beat() -> bool:
        beats.append(1)
        return False  # reaped, cancelled or claimed by another run

    with beating(beat, 0.01, on_lost=lost.set):
        assert lost.wait(2.0)
        time.sleep(0.05)
    assert beats == [1]


def test_a_failing_beat_is_tried_again() -> None:
    """A database hiccup: the next beat still runs (a lost connection is not a lost job)."""
    calls: list[int] = []

    def beat() -> bool:
        calls.append(1)
        if len(calls) == 1:
            raise ConnectionError("database went away")
        return True

    with beating(beat, 0.01, on_lost=lambda: None):
        assert wait_until(lambda: len(calls) >= 3)


class FakeHeartbeat:
    def __init__(self) -> None:
        self.beats: list[str] = []

    def beat(self, job: ClaimedJob) -> bool:
        self.beats.append(job.id)
        return True


def test_a_job_beats_while_it_runs(fixture_specs_dir: Path) -> None:
    deps, provider, ontologies = make(fixture_specs_dir)
    saved(ontologies)
    slow = provider.embed

    def embed(model: str, texts: list[str]) -> list[list[float]]:
        time.sleep(0.1)
        return slow(model, texts)

    provider.embed = embed  # type: ignore[method-assign]
    heartbeat = FakeHeartbeat()
    queue = FakeQueue(jobs=[embed_job()])
    run_once(queue, deps, "w1", heartbeat=heartbeat, heartbeat_s=0.01)
    assert queue.completed
    assert heartbeat.beats and set(heartbeat.beats) == {"job-e"}
    ended = len(heartbeat.beats)
    time.sleep(0.05)
    assert len(heartbeat.beats) == ended
