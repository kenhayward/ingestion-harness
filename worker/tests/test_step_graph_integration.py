"""The LangGraph trial against a real Postgres (docs/design/langgraph-trial.md): a worker
process killed in the middle of a step, and a new one resuming the job where it stopped.

Needs IH_TEST_DATABASE_URL (a throwaway database: the checkpointer creates schema `langgraph`):
    docker run --rm -d --name ih-lg-pg -e POSTGRES_PASSWORD=test -p 55491:5432 postgres:17
    IH_TEST_DATABASE_URL=postgres://postgres:test@localhost:55491/postgres \\
        uv run pytest -m integration tests/test_step_graph_integration.py
"""

from __future__ import annotations

import os
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any

import psycopg
import pytest

from ingest_worker.main import run_once
from ingest_worker.step_graph import CHECKPOINT_SCHEMA, postgres_checkpointer, thread_key

from .fakes import FakeProvider, FakeQueue
from .step_graph_child import deps_for, job_named
from .test_template_pipeline import RESPONSES

pytestmark = pytest.mark.integration

URL = os.environ.get("IH_TEST_DATABASE_URL", "")
WORKER = Path(__file__).resolve().parents[1]
_, DATE, CHUNK_1, CHUNK_2 = RESPONSES


@pytest.fixture
def database_url() -> str:
    if not URL:
        pytest.skip("IH_TEST_DATABASE_URL not set (a throwaway database)")
    return URL


def test_a_killed_worker_resumes_at_the_step_it_was_on(database_url: str, tmp_path: Path) -> None:
    job = job_named(f"killed-{uuid.uuid4().hex[:8]}")
    marker = tmp_path / "in-date"
    child = subprocess.Popen(
        [sys.executable, "-m", "tests.step_graph_child", database_url, str(tmp_path / "child"),
         str(marker), job.id],
        cwd=WORKER, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
    )  # fmt: skip
    deadline = time.monotonic() + 120
    while not marker.exists():
        if child.poll() is not None or time.monotonic() > deadline:
            child.kill()
            output = child.communicate()[0].decode(errors="replace")
            pytest.fail(f"the child never reached the date step:\n{output}")
        time.sleep(0.2)
    child.kill()  # mid-step: no exception, no cleanup, as when a container is killed
    child.wait(timeout=30)

    saver, close = postgres_checkpointer(database_url)  # a new worker: new pool, new saver
    try:
        provider = FakeProvider("local", responses=[DATE, CHUNK_1, CHUNK_2])
        deps = deps_for(tmp_path / "parent", provider, saver)
        queue = FakeQueue(jobs=[job])
        run_once(queue, deps, "parent")

        assert queue.awaiting, queue.reviewed or queue.failed
        assert [r.schema_name for _, r in provider.calls] == ["date", "data", "data"]
        key = thread_key(job, "demo", 1, _sha(b"%PDF"))
        assert list(saver.list({"configurable": {"thread_id": key}})) == []
    finally:
        close()


def test_the_checkpoints_live_in_their_own_schema(database_url: str) -> None:
    _, close = postgres_checkpointer(database_url)
    close()
    with psycopg.connect(database_url) as conn:
        schemas = {
            row[0]
            for row in conn.execute(
                "SELECT table_schema FROM information_schema.tables "
                "WHERE table_name IN ('checkpoints', 'checkpoint_blobs', 'checkpoint_writes')"
            )
        }
    assert schemas == {CHECKPOINT_SCHEMA}


def _sha(data: bytes) -> str:
    import hashlib

    return hashlib.sha256(data).hexdigest()


STATUSES = ["queued", "running", "succeeded", "failed", "needs_review", "awaiting_review",
            "cancelled", "rejected"]  # fmt: skip


def test_the_prune_keeps_only_threads_of_queued_or_running_jobs(database_url: str) -> None:
    """ORPHANS_SQL against CT Studio's own jobs table (db/migrations applied)."""
    from ingest_worker.step_graph import pg_orphaned_threads, prune_threads, run_steps
    from ingest_worker.template_pipeline import DocState

    from .fakes import FakeQueue

    with psycopg.connect(database_url, autocommit=True) as conn:
        if conn.execute("SELECT to_regclass('public.jobs')").fetchone() == (None,):
            pytest.skip("needs db/migrations applied: npm run migrate with DATABASE_URL")
        jobs = {status: str(uuid.uuid4()) for status in STATUSES}
        for status, job_id in jobs.items():
            conn.execute(
                "INSERT INTO jobs (id, task, status) VALUES (%s, 'ontology', %s)",
                (job_id, status),
            )
    keys = {name: f"process:{job_id}:prune" for name, job_id in jobs.items()}
    keys["deleted"] = f"process:{uuid.uuid4()}:prune"  # its job row is gone

    def stops(state: DocState) -> DocState:
        raise RuntimeError("worker lost")

    saver, close = postgres_checkpointer(database_url)
    try:
        for key in keys.values():  # a thread left by a run that stopped after one step
            with pytest.raises(RuntimeError):
                run_steps(
                    job_named("prune"), FakeQueue(), saver, key,
                    [("a", lambda s: s), ("b", stops)], DocState(),
                )  # fmt: skip

        orphans = pg_orphaned_threads(database_url)
        ours = {key for key in orphans if key in keys.values()}  # other tests' threads too

        assert ours == {keys[n] for n in keys if n not in ("queued", "running")}
        assert orphans == sorted(orphans)
        assert prune_threads(saver, lambda: sorted(ours)) == len(ours)
        left = {k for k in keys.values() if saver.get_tuple(_config(k)) is not None}
        assert left == {keys["queued"], keys["running"]}
    finally:
        for key in keys.values():
            saver.delete_thread(key)
        close()
        with psycopg.connect(database_url, autocommit=True) as conn:
            conn.execute("DELETE FROM jobs WHERE id = ANY(%s)", (list(jobs.values()),))


def _config(thread_id: str) -> Any:
    return {"configurable": {"thread_id": thread_id}}
