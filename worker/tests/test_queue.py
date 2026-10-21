from __future__ import annotations

import threading
from typing import Any

import pytest

from ingest_worker.config import Settings
from ingest_worker.main import idle
from ingest_worker.queue import backoff_seconds

from .fakes import FakeQueue


def test_backoff_grows_quadratically_and_caps() -> None:
    assert [backoff_seconds(n) for n in (1, 2, 3)] == [30, 120, 270]
    assert backoff_seconds(100) == 1800


def test_settings_require_core_env() -> None:
    import pytest

    with pytest.raises(ValueError, match="DATABASE_URL"):
        Settings.from_env({})
    s = Settings.from_env(
        {
            "DATABASE_URL": "postgres://x",
            "S3_ENDPOINT": "http://s3",
            "S3_ACCESS_KEY": "a",
            "S3_SECRET_KEY": "b",
            "BRIDGE_URL": "http://bridge:3100",
            "BRIDGE_CLIENT_KEY": "k" * 32,
        }
    )
    assert s.bucket_runs == "ingest-runs"
    assert s.specs_dir.name == "specs"


def test_idle_waits_for_work_with_the_poll_interval() -> None:
    queue = FakeQueue()
    idle(queue, threading.Event(), 2.0)
    assert queue.waits == [2.0]


def test_idle_does_not_wait_once_stopping() -> None:
    queue = FakeQueue()
    stop = threading.Event()
    stop.set()
    idle(queue, stop, 2.0)
    assert queue.waits == []


def test_a_target_not_synced_yet_never_uses_up_the_jobs_attempts(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ingest_worker import main
    from ingest_worker.publish_targets import TargetNotSynced
    from ingest_worker.queue import ClaimedJob

    def not_synced(*_args: Any) -> Any:
        raise TargetNotSynced("default")

    monkeypatch.setitem(main.TASKS, "process", not_synced)
    job = ClaimedJob("j", "d", "demo", 1, "inbox", "k", None, 1, 3)
    queue = FakeQueue()
    for _ in range(5):  # more waits than max_attempts
        main._run_claimed(job, queue, None)  # type: ignore[arg-type]
    assert len(queue.waited) == 5 and queue.failed == [] and queue.reviewed == []
    assert all(delay == main.TARGET_SYNC_WAIT_S for _, _, delay in queue.waited)


def test_a_wait_past_30_minutes_fails_the_job_naming_the_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from ingest_worker import main
    from ingest_worker.publish_targets import TargetNotSynced
    from ingest_worker.queue import ClaimedJob

    def not_synced(*_args: Any) -> Any:
        raise TargetNotSynced("rdf-default")

    monkeypatch.setitem(main.TASKS, "process", not_synced)
    job = ClaimedJob("j", "d", "demo", 1, "inbox", "k", None, 1, 3)
    queue = FakeQueue()
    assert main.TARGET_SYNC_MAX_WAIT_S == 1800
    while queue.now_s < main.TARGET_SYNC_MAX_WAIT_S:  # every wait just under the ceiling
        queue.jobs = [job]
        main.run_once(queue, None, "w1")  # type: ignore[arg-type]
        queue.now_s += main.TARGET_SYNC_WAIT_S
    assert queue.gave_up == [] and queue.failed == []
    waits = len(queue.waited)
    queue.jobs = [job]
    main.run_once(queue, None, "w1")  # type: ignore[arg-type]
    assert len(queue.waited) == waits  # not re-queued again
    assert queue.gave_up == [
        (
            "j",
            "publishing target rdf-default has not synced with the delivery bridge for 30 "
            "minutes: check the bridge and the API's log",
        )
    ]
    assert "j" not in queue.waiting_since
    # Run again later (an operator's Retry), it waits afresh rather than failing at once.
    queue.jobs = [job]
    main.run_once(queue, None, "w1")  # type: ignore[arg-type]
    assert len(queue.waited) == waits + 1 and len(queue.gave_up) == 1
