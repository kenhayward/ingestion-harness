"""PgJobQueue against a real Postgres (deploy/scripts/dev-infra up). Excluded by default."""

from __future__ import annotations

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
