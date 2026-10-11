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
    assert q.is_cancelled(job.id)
    q.complete(job, [], "outputs")
    q.needs_review(job, "x")
    q.fail(job, "x")
    q.await_review(job, [], "outputs", ["r"])
    row = q._conn.execute("SELECT status FROM jobs WHERE id = %s", (job.id,)).fetchone()
    assert row is not None and row[0] == "cancelled"
