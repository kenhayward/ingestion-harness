"""PgJobQueue against a real Postgres (deploy/scripts/dev-infra up). Excluded by default."""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Iterator

import pytest

from ingest_worker.queue import ClaimedJob, PgJobQueue

pytestmark = pytest.mark.integration


@pytest.fixture
def queue_and_job() -> Iterator[tuple[PgJobQueue, ClaimedJob]]:
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL not set")
    q = PgJobQueue(url)
    doc, job = str(uuid.uuid4()), str(uuid.uuid4())
    key = f"demo/v1/{doc}.pdf"
    q._conn.execute(
        """INSERT INTO documents (id, filename, sha256, size_bytes, spec_id, spec_version,
                                  bucket, object_key)
           VALUES (%s, 'a.pdf', 'x', 1, 'demo', 1, 'inbox', %s)""",
        (doc, key),
    )
    q._conn.execute(
        "INSERT INTO jobs (id, document_id, status) VALUES (%s, %s, 'running')", (job, doc)
    )
    yield q, ClaimedJob(job, doc, "demo", 1, "inbox", key, None, 1, 3)
    q._conn.execute("DELETE FROM documents WHERE id = %s", (doc,))
    q.close()


def test_a_cancel_wins_over_late_worker_writes(
    queue_and_job: tuple[PgJobQueue, ClaimedJob],
) -> None:
    q, job = queue_and_job
    q._conn.execute("UPDATE jobs SET status = 'cancelled' WHERE id = %s", (job.id,))
    assert q.is_cancelled(job)
    q.complete(job, [], "outputs")
    q.needs_review(job, "x")
    q.fail(job, "x")
    q.await_review(job, [], "outputs", ["r"])
    row = q._conn.execute("SELECT status FROM jobs WHERE id = %s", (job.id,)).fetchone()
    assert row is not None and row[0] == "cancelled"


@pytest.fixture
def queue_with_queued_job() -> Iterator[tuple[PgJobQueue, str]]:
    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL not set")
    q = PgJobQueue(url)
    q._conn.execute("UPDATE jobs SET run_after = now() + interval '1 day' WHERE status = 'queued'")
    doc, job = str(uuid.uuid4()), str(uuid.uuid4())
    q._conn.execute(
        """INSERT INTO documents (id, filename, sha256, size_bytes, spec_id, spec_version,
                                  bucket, object_key)
           VALUES (%s, 'a.pdf', 'x', 1, 'demo', 1, 'inbox', %s)""",
        (doc, f"demo/v1/{doc}.pdf"),
    )
    q._conn.execute("INSERT INTO jobs (id, document_id) VALUES (%s, %s)", (job, doc))
    yield q, job
    q._conn.execute("DELETE FROM documents WHERE id = %s", (doc,))
    q.close()


def test_a_deleted_job_counts_as_cancelled_for_its_worker(
    queue_with_queued_job: tuple[PgJobQueue, str],
) -> None:
    q, job_id = queue_with_queued_job
    claimed = q.claim("w1")
    assert claimed is not None and claimed.id == job_id
    assert not q.is_cancelled(claimed)
    q._conn.execute("DELETE FROM jobs WHERE id = %s", (job_id,))
    assert q.is_cancelled(claimed)


def test_a_retried_and_reclaimed_job_is_no_longer_the_old_workers(
    queue_with_queued_job: tuple[PgJobQueue, str],
) -> None:
    q, job_id = queue_with_queued_job
    old = q.claim("w1")
    assert old is not None
    q._conn.execute("UPDATE jobs SET status = 'cancelled' WHERE id = %s", (job_id,))
    q._conn.execute(  # operator Retry: back in the queue
        "UPDATE jobs SET status = 'queued', run_after = now() WHERE id = %s", (job_id,)
    )
    assert q.is_cancelled(old)  # queued again: not the old run's claim
    new = q.claim("w2")
    assert new is not None and new.id == job_id
    assert q.is_cancelled(old) and not q.is_cancelled(new)
    q.complete(old, [], "outputs")  # the old run's late write must not touch the new run
    row = q._conn.execute("SELECT status, locked_by FROM jobs WHERE id = %s", (job_id,)).fetchone()
    assert row == ("running", "w2")


def test_production_jobs_are_claimed_before_workbench_jobs(
    queue_with_queued_job: tuple[PgJobQueue, str],
) -> None:
    q, production_job = queue_with_queued_job
    doc, workbench_job = str(uuid.uuid4()), str(uuid.uuid4())
    q._conn.execute(
        """INSERT INTO documents (id, filename, sha256, size_bytes, spec_id, spec_version,
                                  bucket, object_key)
           VALUES (%s, 'b.pdf', 'y', 1, 'demo', 1, 'inbox', %s)""",
        (doc, f"demo/v1/{doc}.pdf"),
    )
    # Queued an hour earlier, but workbench priority (-10) runs after production (0).
    q._conn.execute(
        """INSERT INTO jobs (id, document_id, priority, created_at, run_after)
           VALUES (%s, %s, -10, now() - interval '1 hour', now() - interval '1 hour')""",
        (workbench_job, doc),
    )
    try:
        claimed = q.claim("w1")
        assert claimed is not None and claimed.id == production_job
    finally:
        q._conn.execute("DELETE FROM documents WHERE id = %s", (doc,))


def test_a_document_less_project_job_is_claimed_with_its_params(
    queue_with_queued_job: tuple[PgJobQueue, str],
) -> None:
    q, production_job = queue_with_queued_job
    # Push the fixture's production job back so the segment job is next.
    q._conn.execute(
        "UPDATE jobs SET run_after = now() + interval '1 day' WHERE id = %s", (production_job,)
    )
    project = f"p{uuid.uuid4().hex[:8]}"
    q._conn.execute("INSERT INTO workbench_projects (id, name) VALUES (%s, 'P')", (project,))
    job_id = str(uuid.uuid4())
    q._conn.execute(
        """INSERT INTO jobs (id, project_id, task, test, priority, max_attempts, params)
           VALUES (%s, %s, 'segment', true, -5, 1, %s)""",
        (job_id, project, json.dumps({"samples": [], "document": {"sections": []}})),
    )
    try:
        claimed = q.claim("w1")
        assert claimed is not None and claimed.id == job_id
        assert claimed.task == "segment" and claimed.document_id == ""
        assert claimed.project_id == project
        assert claimed.params == {"samples": [], "document": {"sections": []}}
    finally:
        q._conn.execute("DELETE FROM jobs WHERE id = %s", (job_id,))
        q._conn.execute("DELETE FROM workbench_projects WHERE id = %s", (project,))


def test_wait_for_work_returns_as_soon_as_a_job_is_queued() -> None:
    import time

    url = os.environ.get("DATABASE_URL")
    if not url:
        pytest.skip("DATABASE_URL not set")
    listener, writer = PgJobQueue(url), PgJobQueue(url)
    doc = str(uuid.uuid4())
    try:
        listener.wait_for_work(0.01)  # starts LISTEN
        writer._conn.execute(
            """INSERT INTO documents (id, filename, sha256, size_bytes, spec_id, spec_version,
                                      bucket, object_key)
               VALUES (%s, 'n.pdf', 'z', 1, 'demo', 1, 'inbox', %s)""",
            (doc, f"demo/v1/{doc}.pdf"),
        )
        writer._conn.execute(
            "INSERT INTO jobs (document_id, run_after) VALUES (%s, now() + interval '1 day')",
            (doc,),
        )
        started = time.monotonic()
        listener.wait_for_work(10.0)
        assert time.monotonic() - started < 2.0
    finally:
        writer._conn.execute("DELETE FROM documents WHERE id = %s", (doc,))
        listener.close()
        writer.close()


def test_the_database_times_a_claimed_extraction(
    queue_with_queued_job: tuple[PgJobQueue, str],
) -> None:
    """Migration 0028: the claim and the finish set started_at/finished_at (worker unchanged)."""
    q, job_id = queue_with_queued_job
    claimed = q.claim("w1")
    assert claimed is not None and claimed.id == job_id

    def times() -> tuple[object, object]:
        row = q._conn.execute(
            "SELECT started_at, finished_at FROM jobs WHERE id = %s", (job_id,)
        ).fetchone()
        assert row is not None
        return row[0], row[1]

    started, finished = times()
    assert started is not None and finished is None
    q.complete(claimed, [], "outputs")
    started_after, finished_after = times()
    assert started_after == started
    assert finished_after is not None and finished_after >= started  # type: ignore[operator]


def status_of(q: PgJobQueue, job_id: str) -> tuple[object, ...]:
    row = q._conn.execute(
        "SELECT status, updated_at, heartbeat_at FROM jobs WHERE id = %s", (job_id,)
    ).fetchone()
    assert row is not None
    return tuple(row)


def test_a_running_job_that_beats_is_never_reaped_and_one_that_stops_is(
    queue_with_queued_job: tuple[PgJobQueue, str],
) -> None:
    """Migration 0042: the reaper goes by the heartbeat, not the claim time, so a long job
    whose worker is alive keeps its claim; a job whose beats stopped goes back in the queue."""
    import time

    from ingest_worker.heartbeat import PgJobHeartbeat

    q, job_id = queue_with_queued_job
    heartbeat = PgJobHeartbeat(os.environ["DATABASE_URL"])
    try:
        claimed = q.claim("w1")
        assert claimed is not None and claimed.id == job_id
        time.sleep(1.2)
        assert heartbeat.beat(claimed)
        q.reap_stale(1.0)  # claimed over a second ago, but it beat just now
        assert status_of(q, job_id)[0] == "running"
        time.sleep(1.2)
        q.reap_stale(1.0)  # no beat for over a second: its worker stopped
        assert status_of(q, job_id)[0] == "queued"
        assert not heartbeat.beat(claimed)  # no longer this run's job
    finally:
        heartbeat.close()


def test_a_beat_neither_moves_updated_at_nor_notifies_job_watchers(
    queue_with_queued_job: tuple[PgJobQueue, str],
) -> None:
    import psycopg

    from ingest_worker.heartbeat import PgJobHeartbeat

    q, job_id = queue_with_queued_job
    url = os.environ["DATABASE_URL"]
    heartbeat = PgJobHeartbeat(url)
    listener = psycopg.connect(url, autocommit=True)
    try:
        claimed = q.claim("w1")
        assert claimed is not None
        _, updated, beat_before = status_of(q, job_id)
        listener.execute("LISTEN ih_job_changed")
        assert heartbeat.beat(claimed)
        _, updated_after, beat_after = status_of(q, job_id)
        assert updated_after == updated
        assert beat_after is not None and beat_before is not None and beat_after > beat_before
        assert list(listener.notifies(timeout=0.5, stop_after=1)) == []
        q.complete(claimed, [], "outputs")  # a real change still notifies
        assert [n.payload for n in listener.notifies(timeout=2.0, stop_after=1)] == [job_id]
    finally:
        listener.close()
        heartbeat.close()


def test_a_survey_queues_one_suggest_job_per_project(
    queue_with_queued_job: tuple[PgJobQueue, str],
) -> None:
    """Like the API's createSuggestJob: the project's earlier suggest job is replaced."""
    q, _ = queue_with_queued_job
    project = f"p{uuid.uuid4().hex[:8]}"
    q._conn.execute("INSERT INTO workbench_projects (id, name) VALUES (%s, 'P')", (project,))
    params = {"surveyProposalId": "s1", "candidates": [], "library": [], "pinned": [],
              "dataPolicy": "local"}  # fmt: skip
    try:
        first, removed = q.queue_suggest(project, params)
        assert removed == []
        second, removed = q.queue_suggest(project, {**params, "surveyProposalId": "s2"})
        assert removed == [first]
        rows = q._conn.execute(
            """SELECT id::text, task, status, test, priority, max_attempts, params->>'surveyProposalId'
                 FROM jobs WHERE project_id = %s""",
            (project,),
        ).fetchall()
        assert rows == [(second, "suggest", "queued", True, -5, 3, "s2")]
    finally:
        q._conn.execute("DELETE FROM jobs WHERE project_id = %s", (project,))
        q._conn.execute("DELETE FROM workbench_projects WHERE id = %s", (project,))
