"""The worker's main loop rides out a lost database connection (main.serve): a restore swaps
the database and ends every connection to the old one, a Postgres restart does the same."""

from __future__ import annotations

import logging
import threading

import psycopg
import pytest

from ingest_worker.main import RECONNECT_S, serve

LOST = "terminating connection due to administrator command"


class FakeRuntime:
    def __init__(self, stop: threading.Event, fail: bool) -> None:
        self.stop, self.fail = stop, fail
        self.ticks = 0
        self.closed = False

    def tick(self) -> None:
        self.ticks += 1
        if self.fail:
            raise psycopg.OperationalError(LOST)
        self.stop.set()

    def close(self) -> None:
        self.closed = True


def test_a_lost_connection_reconnects_instead_of_ending_the_worker(
    caplog: pytest.LogCaptureFixture,
) -> None:
    stop = threading.Event()
    opened: list[FakeRuntime] = []

    def connect() -> FakeRuntime:
        runtime = FakeRuntime(stop, fail=not opened)
        opened.append(runtime)
        return runtime

    waits: list[float] = []
    with caplog.at_level(logging.WARNING, logger="ingest_worker"):
        serve(connect, stop, wait=waits.append)

    assert [r.ticks for r in opened] == [1, 1]
    assert [r.closed for r in opened] == [True, True]
    assert waits == [RECONNECT_S]
    assert any(LOST in m and "reconnecting" in m for m in caplog.messages)


def test_a_failed_reconnect_is_tried_again() -> None:
    stop = threading.Event()
    attempts: list[int] = []

    def connect() -> FakeRuntime:
        attempts.append(1)
        if len(attempts) == 1:
            raise psycopg.OperationalError("connection refused")
        return FakeRuntime(stop, fail=False)

    waits: list[float] = []
    serve(connect, stop, wait=waits.append)
    assert len(attempts) == 2
    assert waits == [RECONNECT_S]


def test_other_errors_still_end_the_worker() -> None:
    stop = threading.Event()

    class Broken(FakeRuntime):
        def tick(self) -> None:
            raise RuntimeError("a bug")

    runtime = Broken(stop, fail=False)
    with pytest.raises(RuntimeError, match="a bug"):
        serve(lambda: runtime, stop, wait=lambda _s: None)
    assert runtime.closed
