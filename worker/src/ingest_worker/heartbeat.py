"""Job heartbeats (migration 0042): while a worker runs a job, a thread refreshes the job's
`heartbeat_at` every `HEARTBEAT_S`, so the reaper (`JobQueue.reap_stale`) only re-queues a job
whose worker stopped, never a long one still running. One job, one worker: the claim already
hands a queued job to a single worker (FOR UPDATE SKIP LOCKED); the heartbeat keeps another
worker's reaper from taking it back while it runs."""

from __future__ import annotations

import logging
import threading
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from typing import Any, Protocol

from .queue import ClaimedJob

log = logging.getLogger("ingest_worker")

#: Seconds between beats; well under the reaper's STALE_LOCK_S (900 by default).
HEARTBEAT_S = 60.0


class JobHeartbeat(Protocol):
    def beat(self, job: ClaimedJob) -> bool:
        """Refresh the job's heartbeat; False once it is no longer this run's claim
        (cancelled, deleted, or re-queued and claimed again)."""
        ...


class PgJobHeartbeat:
    """Beats on its own autocommit connection: the worker's queue connection is busy with the
    job (and may be inside a transaction) while the beat thread runs."""

    def __init__(self, database_url: str) -> None:
        import psycopg

        self._conn: Any = psycopg.connect(database_url, autocommit=True)

    def beat(self, job: ClaimedJob) -> bool:
        # Same guard as every worker status write (queue._MINE); never touches updated_at.
        cur = self._conn.execute(
            """UPDATE jobs SET heartbeat_at = now()
                WHERE id = %s AND status = 'running' AND locked_at IS NOT DISTINCT FROM %s""",
            (job.id, job.claimed_at),
        )
        return bool(cur.rowcount)

    def close(self) -> None:
        self._conn.close()


@contextmanager
def beating(
    beat: Callable[[], bool], interval_s: float, on_lost: Callable[[], None]
) -> Iterator[None]:
    """Call `beat` every `interval_s` on a daemon thread while the block runs. A beat that
    raises (a database hiccup) is tried again next time; one that returns False means the job
    is no longer this run's: `on_lost` is called and the beats stop (the job itself stops at
    its next cancel check)."""
    done = threading.Event()

    def run() -> None:
        while not done.wait(interval_s):
            try:
                if not beat():
                    on_lost()
                    return
            except Exception:
                log.warning("job heartbeat failed; trying again", exc_info=True)

    thread = threading.Thread(target=run, name="job-heartbeat", daemon=True)
    thread.start()
    try:
        yield
    finally:
        done.set()
        thread.join(timeout=interval_s + 5)
