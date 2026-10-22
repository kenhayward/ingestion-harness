"""A model's parallel calls across every worker (Administration > Models, *Parallel calls*).

Each call to a model with the setting takes one of its `limit` slots before it is sent and gives
it back after, so all the workers together never send that model more calls at once. On Postgres
a slot is a session-level advisory lock, `(slot_key(ref), slot number)`, held on one autocommit
connection per worker process: a worker that dies loses its connection and with it its slots, so
none is ever leaked. Slots are taken with a non-blocking try and a short wait between tries, so
nothing deadlocks. A model without the setting takes no slot (no database round trip)."""

from __future__ import annotations

import contextlib
import hashlib
import logging
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from typing import Protocol

import psycopg

log = logging.getLogger(__name__)

#: Seconds between tries while every slot is taken (calls take seconds, so this costs little).
POLL_S = 0.2


class CallStopped(Exception):
    """A call waiting for a slot is not needed any more (a call before it failed)."""


class CallSlots(Protocol):
    def slot(
        self, ref: str, limit: int, stopped: Callable[[], bool]
    ) -> AbstractContextManager[None]:
        """Hold one of the model's `limit` slots for the block; while every slot is taken, wait,
        and raise CallStopped as soon as `stopped()` is true."""
        ...


def slot_key(ref: str) -> int:
    """The advisory lock's first key for a model ref: a stable signed 32-bit number (the second
    key is the slot). Two-key advisory locks never conflict with the one-key ones used elsewhere."""
    digest = hashlib.sha256(f"llm-call-slot:{ref}".encode()).digest()
    return int.from_bytes(digest[:4], "big", signed=True)


@contextmanager
def _held(
    take: Callable[[], int | None], give: Callable[[int], None], stopped: Callable[[], bool]
) -> Iterator[None]:
    while (slot := take()) is None:
        if stopped():
            raise CallStopped
        time.sleep(POLL_S)
    try:
        yield
    finally:
        give(slot)


class MemoryCallSlots:
    """Slots in this process (tests: several simulated workers share one instance)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._taken: dict[str, set[int]] = {}

    def slot(
        self, ref: str, limit: int, stopped: Callable[[], bool]
    ) -> AbstractContextManager[None]:
        def take() -> int | None:
            with self._lock:
                taken = self._taken.setdefault(ref, set())
                free = next((s for s in range(limit) if s not in taken), None)
                if free is not None:
                    taken.add(free)
                return free

        def give(slot: int) -> None:
            with self._lock:
                self._taken[ref].discard(slot)

        return _held(take, give, stopped)


class PgCallSlots:
    """Slots as session-level advisory locks on this worker's own autocommit connection (opened
    when first needed, opened again after it is lost). A session may take its own advisory lock
    twice, so the slots this process holds are also counted here, and each is taken once."""

    def __init__(self, conninfo: str) -> None:
        self._conninfo = conninfo
        self._lock = threading.Lock()
        self._conn: psycopg.Connection[tuple[object, ...]] | None = None
        self._held: set[tuple[int, int]] = set()

    def _connection(self) -> psycopg.Connection[tuple[object, ...]]:
        if self._conn is None or self._conn.closed:
            self._conn = psycopg.connect(self._conninfo, autocommit=True)
            self._held.clear()  # a new session holds nothing
        return self._conn

    def _lost(self) -> None:
        """The connection failed: its locks are gone with it."""
        if self._conn is not None:
            with contextlib.suppress(psycopg.Error):
                self._conn.close()
        self._conn = None
        self._held.clear()

    def slot(
        self, ref: str, limit: int, stopped: Callable[[], bool]
    ) -> AbstractContextManager[None]:
        key = slot_key(ref)

        def take() -> int | None:
            with self._lock:
                try:
                    conn = self._connection()
                    for s in range(limit):
                        if (key, s) in self._held:
                            continue
                        row = conn.execute(
                            "SELECT pg_try_advisory_lock(%s, %s)", (key, s)
                        ).fetchone()
                        if row is not None and row[0]:
                            self._held.add((key, s))
                            return s
                except psycopg.OperationalError:
                    self._lost()
                    raise
                return None

        def give(slot: int) -> None:
            with self._lock:
                if (key, slot) not in self._held:
                    return  # the connection was lost meanwhile: the lock went with it
                self._held.discard((key, slot))
                try:
                    assert self._conn is not None
                    self._conn.execute("SELECT pg_advisory_unlock(%s, %s)", (key, slot))
                except psycopg.Error:
                    log.warning("could not give back call slot %s of %s", slot, ref, exc_info=True)
                    self._lost()

        return _held(take, give, stopped)

    def close(self) -> None:
        with self._lock:
            self._lost()
