"""A model's parallel calls across every worker (Administration > Models): call slots shared by
the workers, taken before a call is sent and given back after."""

from __future__ import annotations

import os
import threading
import time
from collections.abc import Callable
from typing import Any

import pytest

from ingest_worker.call_slots import CallStopped, MemoryCallSlots, PgCallSlots, slot_key
from ingest_worker.pipeline import run_in_order


class Busy:
    """Counts the calls inside a slot at once, across every worker sharing the slots."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.now = 0
        self.most = 0

    def call(self, n: int, delay: float = 0.03, fail: bool = False) -> Callable[[], int]:
        def run() -> int:
            with self.lock:
                self.now += 1
                self.most = max(self.most, self.now)
            time.sleep(delay)
            with self.lock:
                self.now -= 1
            if fail:
                raise ValueError(f"call {n} failed")
            return n

        return run


def _gate(slots: Any, ref: str, limit: int) -> Callable[[Callable[[], bool]], Any]:
    return lambda stopped: slots.slot(ref, limit, stopped)


def _workers(slots: Any, busy: Busy, limit: int, per_worker: int = 4, workers: int = 3) -> None:
    """`workers` workers, each sending up to `limit` calls at once through the shared slots."""
    out: list[list[int]] = []

    def worker() -> None:
        calls = [busy.call(n) for n in range(per_worker * 2)]
        out.append(run_in_order(calls, limit, _gate(slots, "local/qwen", limit)))

    threads = [threading.Thread(target=worker) for _ in range(workers)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert out == [list(range(per_worker * 2))] * workers  # each worker's results in order


def test_the_limit_holds_across_workers() -> None:
    busy = Busy()
    _workers(MemoryCallSlots(), busy, limit=2)
    assert busy.most == 2  # three workers, two slots: never more than two calls at once


def test_each_model_has_its_own_slots() -> None:
    slots = MemoryCallSlots()
    busy = Busy()
    with slots.slot("local/a", 1, lambda: False), slots.slot("local/b", 1, lambda: False):
        busy.call(0, delay=0)()  # both held at once: different models never wait for each other


def test_a_waiting_call_stops_when_told_to() -> None:
    slots = MemoryCallSlots()
    with (
        slots.slot("local/qwen", 1, lambda: False),
        pytest.raises(CallStopped),
        slots.slot("local/qwen", 1, lambda: True),
    ):
        pass


def test_a_call_waiting_for_a_slot_still_runs_when_a_later_call_fails() -> None:
    """Results in plan order and the first failure in plan order: a call earlier than the
    failure keeps waiting for its slot and runs; calls after it stop."""
    slots = MemoryCallSlots()
    busy = Busy()
    hold = threading.Event()

    def other_worker() -> None:  # holds the only slot for a while
        with slots.slot("local/qwen", 1, lambda: False):
            hold.set()
            time.sleep(0.15)

    t = threading.Thread(target=other_worker)
    t.start()
    hold.wait()
    calls = [busy.call(0), busy.call(1, fail=True), busy.call(2), busy.call(3)]
    with pytest.raises(ValueError, match="call 1 failed"):
        run_in_order(calls, 2, _gate(slots, "local/qwen", 1))
    t.join()


def test_slots_are_given_back_when_a_call_fails() -> None:
    slots = MemoryCallSlots()
    with pytest.raises(ValueError), slots.slot("local/qwen", 1, lambda: False):
        raise ValueError("boom")
    with slots.slot("local/qwen", 1, lambda: True):  # free again: taken at once
        pass


def test_slot_keys_are_stable_and_per_model() -> None:
    assert slot_key("local/qwen") == slot_key("local/qwen")
    assert slot_key("local/qwen") != slot_key("local/olmocr")
    assert -(2**31) <= slot_key("local/qwen") < 2**31


# --- on Postgres: session advisory locks, one connection per worker ---------------------------

DB = os.environ.get("IH_TEST_DATABASE_URL")
pg = pytest.mark.skipif(DB is None, reason="IH_TEST_DATABASE_URL not set")


@pytest.mark.integration
@pg
def test_pg_slots_hold_the_limit_across_two_workers() -> None:
    assert DB is not None
    first, second = PgCallSlots(DB), PgCallSlots(DB)
    try:
        busy = Busy()
        out: list[list[int]] = []

        def worker(slots: PgCallSlots) -> None:
            calls = [busy.call(n, delay=0.1) for n in range(6)]
            out.append(run_in_order(calls, 3, _gate(slots, "local/qwen", 3)))

        threads = [threading.Thread(target=worker, args=(s,)) for s in (first, second)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert busy.most == 3
        assert out == [list(range(6))] * 2
    finally:
        first.close()
        second.close()


@pytest.mark.integration
@pg
def test_pg_slots_of_a_worker_that_dies_are_freed() -> None:
    """A killed worker's connection closes, and its advisory locks go with it."""
    assert DB is not None
    dead, alive = PgCallSlots(DB), PgCallSlots(DB)
    try:
        taken = dead.slot("local/qwen", 1, lambda: False)
        taken.__enter__()  # held, never given back
        with pytest.raises(CallStopped), alive.slot("local/qwen", 1, lambda: True):
            pass
        dead.close()  # the worker dies
        with alive.slot("local/qwen", 1, lambda: True):  # free: taken at once
            pass
    finally:
        alive.close()


@pytest.mark.integration
@pg
def test_pg_slots_never_hand_one_slot_to_two_threads_of_one_worker() -> None:
    """A session may take its own advisory lock again; the worker must not count that twice."""
    assert DB is not None
    slots = PgCallSlots(DB)
    try:
        with (
            slots.slot("local/qwen", 1, lambda: False),
            pytest.raises(CallStopped),
            slots.slot("local/qwen", 1, lambda: True),
        ):
            pass
    finally:
        slots.close()
