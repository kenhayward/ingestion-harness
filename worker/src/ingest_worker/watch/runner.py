"""Runs the cycles of the watches that are due (spec §9: exactly one poller per watch across every
worker): each watch's cycle runs under a session advisory lock taken without waiting, on the
runner's own autocommit connection (the pattern of call_slots.PgCallSlots), so a watch another
worker is looking at is skipped this round and a worker that dies frees its locks."""

from __future__ import annotations

import contextlib
import logging
import threading
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from datetime import UTC, datetime, timedelta
from typing import Protocol

import psycopg

from ingest_worker.call_slots import slot_key
from ingest_worker.watch.cycle import WatchDeps, run_cycle

log = logging.getLogger(__name__)

#: How often the worker's loop asks the runner for due watches, in seconds.
WATCH_TICK_S = 1.0


class WatchLocks(Protocol):
    def hold(self, watch_id: str) -> AbstractContextManager[bool]:
        """True inside the block when this process holds the watch's lock; False (and nothing
        held) when another holds it."""
        ...


class MemoryWatchLocks:
    """Locks in this process (tests: several runners share one instance)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._held: set[str] = set()

    @contextmanager
    def hold(self, watch_id: str) -> Iterator[bool]:
        with self._lock:
            if watch_id in self._held:
                taken = False
            else:
                self._held.add(watch_id)
                taken = True
        try:
            yield taken
        finally:
            if taken:
                with self._lock:
                    self._held.discard(watch_id)


def watch_lock_key(watch_id: str) -> int:
    return slot_key(f"watch:{watch_id}")


class PgWatchLocks:
    """A watch's lock as a session-level advisory lock on this runner's own autocommit connection
    (opened when first needed, opened again after it is lost)."""

    def __init__(self, conninfo: str) -> None:
        self._conninfo = conninfo
        self._conn: psycopg.Connection[tuple[object, ...]] | None = None

    def _connection(self) -> psycopg.Connection[tuple[object, ...]]:
        if self._conn is None or self._conn.closed:
            self._conn = psycopg.connect(self._conninfo, autocommit=True)
        return self._conn

    def _lost(self) -> None:
        if self._conn is not None:
            with contextlib.suppress(psycopg.Error):
                self._conn.close()
        self._conn = None

    @contextmanager
    def hold(self, watch_id: str) -> Iterator[bool]:
        key = watch_lock_key(watch_id)
        try:
            row = self._connection().execute("SELECT pg_try_advisory_lock(%s)", (key,)).fetchone()
        except psycopg.OperationalError:
            self._lost()
            raise
        taken = bool(row and row[0])
        try:
            yield taken
        finally:
            if taken and self._conn is not None:
                try:
                    self._conn.execute("SELECT pg_advisory_unlock(%s)", (key,))
                except psycopg.Error:
                    log.warning("could not unlock watch %s", watch_id, exc_info=True)
                    self._lost()  # the lock goes with the session

    def close(self) -> None:
        self._lost()


def _utcnow() -> datetime:
    return datetime.now(UTC)


class WatchRunner:
    def __init__(
        self,
        deps: WatchDeps,
        locks: WatchLocks,
        clock: Callable[[], datetime] = _utcnow,
    ) -> None:
        self.deps = deps
        self.locks = locks
        self.clock = clock

    def tick(self) -> int:
        """Run every due watch this process can lock; the cycles run."""
        store = self.deps.store
        ran = 0
        for due in store.due(self.clock()):
            with self.locks.hold(due.id) as held:
                if not held:
                    continue
                now = self.clock()
                # Another runner may have looked meanwhile, or an admin stopped it.
                w = store.watch(due.id)
                if w is None or w.state == "stopped" or w.next_look_at > now:
                    continue
                try:
                    result = run_cycle(w, self.deps, now)
                except psycopg.OperationalError:
                    raise  # the worker reconnects
                except Exception as exc:
                    log.warning("watch %s: the cycle failed", w.name, exc_info=True)
                    store.event(w.id, "error", f"the folder could not be looked at: {exc}", None)
                    store.schedule(w.id, now + timedelta(seconds=w.sleep_seconds))
                    continue
                store.schedule(w.id, result.next_look_at)
                ran += 1
        return ran
