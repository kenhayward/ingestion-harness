"""The thread prune of ADR 0018: a step graph thread is kept only while its job is queued or
running; the worker prunes the others when it starts and then hourly."""

from __future__ import annotations

import logging

import pytest
from langgraph.checkpoint.memory import InMemorySaver

from ingest_worker.step_graph import (
    PRUNE_EVERY_S,
    ThreadPruner,
    orphaned_threads,
    prune_threads,
    run_steps,
)
from ingest_worker.template_pipeline import DocState

from .fakes import FakeQueue
from .test_template_pipeline import JOB


def thread(job_id: str, run: str = "a1b2") -> str:
    return f"process:{job_id}:{run}"


@pytest.mark.parametrize(
    ("threads", "live", "orphans"),
    [
        ([], set(), []),
        ([thread("j1")], {"j1"}, []),  # queued or running: kept
        ([thread("j1")], set(), [thread("j1")]),  # finished, deleted or unknown
        ([thread("j1", "old"), thread("j1", "new")], {"j1"}, []),  # another run of a live job
        (
            [thread("j1", "old"), thread("j1", "new")],
            set(),
            [thread("j1", "new"), thread("j1", "old")],
        ),
        ([thread("j1"), thread("j2")], {"j2"}, [thread("j1")]),
        (["someone-else:j1"], set(), []),  # not a step graph thread: never touched
        ([thread("j1"), thread("j1")], set(), [thread("j1")]),  # listed twice, pruned once
    ],
)
def test_a_thread_is_kept_only_while_its_job_is_queued_or_running(
    threads: list[str], live: set[str], orphans: list[str]
) -> None:
    assert orphaned_threads(threads, live) == orphans


def stopped_thread(saver: InMemorySaver, key: str) -> None:
    """A thread left by a run that stopped after its first step."""

    def fails(state: DocState) -> DocState:
        raise RuntimeError("worker lost")

    with pytest.raises(RuntimeError):
        run_steps(JOB, FakeQueue(), saver, key, [("a", lambda s: s), ("b", fails)], DocState())


def threads_in(saver: InMemorySaver) -> set[str]:
    return {c.config["configurable"]["thread_id"] for c in saver.list(None)}


def test_prune_deletes_the_orphans_and_nothing_else() -> None:
    saver = InMemorySaver()
    for key in (thread("live"), thread("gone"), thread("done")):
        stopped_thread(saver, key)

    pruned = prune_threads(saver, lambda: orphaned_threads(threads_in(saver), {"live"}))

    assert pruned == 2
    assert threads_in(saver) == {thread("live")}


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def __call__(self) -> float:
        return self.now


def test_the_worker_prunes_when_it_starts_then_hourly() -> None:
    clock, calls = Clock(), []
    pruner = ThreadPruner(InMemorySaver(), lambda: calls.append(clock.now) or [], clock=clock)

    pruner.tick()  # the first tick, at start
    clock.now += PRUNE_EVERY_S - 1
    pruner.tick()
    clock.now += 1
    pruner.tick()

    assert calls == [1000.0, 1000.0 + PRUNE_EVERY_S]
    assert PRUNE_EVERY_S == 3600


def test_a_failed_prune_never_stops_the_worker(caplog: pytest.LogCaptureFixture) -> None:
    clock = Clock()

    def outage() -> list[str]:
        raise OSError("database unavailable")

    pruner = ThreadPruner(InMemorySaver(), outage, clock=clock)
    with caplog.at_level(logging.WARNING, logger="ingest_worker"):
        pruner.tick()
        pruner.tick()  # not retried before the next hour
    assert "could not prune" in caplog.text
    assert caplog.text.count("could not prune") == 1
