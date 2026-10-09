"""Postgres-backed job queue (jobs table, see db/migrations). Claims use FOR UPDATE SKIP LOCKED
so any number of worker replicas can poll concurrently."""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any, Literal, Protocol

from .llm.base import ModelDescriptor
from .outputs import RenderedOutput

Level = Literal["debug", "info", "warn", "error"]


@dataclass(frozen=True)
class ClaimedJob:
    id: str
    document_id: str
    spec_id: str
    spec_version: int
    bucket: str
    object_key: str
    model_override: str | None
    attempts: int
    max_attempts: int
    #: "process" (extract) or "publish" (apply review edits and deliver to the final target).
    task: str = "process"


class JobQueue(Protocol):
    def claim(self, worker_id: str) -> ClaimedJob | None: ...

    def complete(
        self, job: ClaimedJob, outputs: list[RenderedOutput], outputs_bucket: str
    ) -> None: ...

    def await_review(
        self,
        job: ClaimedJob,
        outputs: list[RenderedOutput],
        outputs_bucket: str,
        reasons: list[str],
    ) -> None:
        """Record draft outputs and park the job until a reviewer approves or rejects it."""
        ...

    def record_published(
        self, job: ClaimedJob, outputs: list[RenderedOutput], bucket: str
    ) -> None: ...

    def review_edits(self, job_id: str) -> list[dict[str, Any]]:
        """Reviewer edits in the order they were made."""
        ...

    def review_decision(self, job_id: str) -> dict[str, Any] | None: ...

    def needs_review(self, job: ClaimedJob, reason: str) -> None: ...

    def fail(self, job: ClaimedJob, error: str) -> None:
        """Re-queue with backoff while attempts remain, else mark failed."""
        ...

    def event(
        self, job_id: str, level: Level, message: str, data: dict[str, Any] | None = None
    ) -> None: ...

    def upsert_models(self, models: list[ModelDescriptor]) -> None: ...

    def reap_stale(self, older_than_s: float) -> int: ...


CLAIM_SQL = """
WITH next AS (
  SELECT id FROM jobs
   WHERE status = 'queued' AND run_after <= now()
   ORDER BY run_after, created_at
   FOR UPDATE SKIP LOCKED
   LIMIT 1
), claimed AS (
  UPDATE jobs j
     SET status = 'running', attempts = j.attempts + 1, locked_by = %(worker)s,
         locked_at = now(), updated_at = now()
    FROM next WHERE j.id = next.id
  RETURNING j.*
)
SELECT c.id::text, c.document_id::text, d.spec_id, d.spec_version, d.bucket, d.object_key,
       c.model_override, c.attempts, c.max_attempts, c.task
  FROM claimed c JOIN documents d ON d.id = c.document_id
"""


def backoff_seconds(attempts: int) -> int:
    """30s, 2m, 4.5m, ... capped at 30 minutes."""
    return int(min(30 * attempts**2, 1800))


class PgJobQueue:
    def __init__(self, database_url: str) -> None:
        import psycopg

        self._conn = psycopg.connect(database_url, autocommit=True)

    def close(self) -> None:
        self._conn.close()

    def claim(self, worker_id: str) -> ClaimedJob | None:
        row = self._conn.execute(CLAIM_SQL, {"worker": worker_id}).fetchone()
        return ClaimedJob(*row) if row else None

    def complete(self, job: ClaimedJob, outputs: list[RenderedOutput], outputs_bucket: str) -> None:
        with self._conn.transaction():
            self._record_outputs(job, outputs, outputs_bucket, "draft")
            self._finish(job.id, "succeeded", None)

    def _record_outputs(
        self, job: ClaimedJob, outputs: list[RenderedOutput], bucket: str, stage: str
    ) -> None:
        for o in outputs:
            self._conn.execute(
                """INSERT INTO job_outputs (job_id, output_id, stage, format, bucket, object_key, row_count)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (job_id, output_id, stage) DO UPDATE
                     SET bucket = EXCLUDED.bucket, object_key = EXCLUDED.object_key,
                         row_count = EXCLUDED.row_count, created_at = now()""",
                (job.id, o.output_id, stage, o.format, bucket, o.key, o.row_count),
            )

    def await_review(
        self,
        job: ClaimedJob,
        outputs: list[RenderedOutput],
        outputs_bucket: str,
        reasons: list[str],
    ) -> None:
        with self._conn.transaction():
            self._record_outputs(job, outputs, outputs_bucket, "draft")
            self._conn.execute(
                """UPDATE jobs SET status = 'awaiting_review', review_reasons = %s, error = NULL,
                          locked_by = NULL, locked_at = NULL, updated_at = now() WHERE id = %s""",
                (json.dumps(reasons), job.id),
            )

    def record_published(self, job: ClaimedJob, outputs: list[RenderedOutput], bucket: str) -> None:
        self._record_outputs(job, outputs, bucket, "published")

    def review_edits(self, job_id: str) -> list[dict[str, Any]]:
        cur = self._conn.execute(
            """SELECT field_id, table_id, row_number, column_id, new_value, editor, reason, at
                 FROM review_edits WHERE job_id = %s ORDER BY id""",
            (job_id,),
        )
        return [
            {
                "field": r[0],
                "table": r[1],
                "row": r[2],
                "column": r[3],
                "value": r[4],
                "editor": r[5],
                "reason": r[6],
                "at": r[7].isoformat(),
            }
            for r in cur.fetchall()
        ]

    def review_decision(self, job_id: str) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT reviewer, review_note, reviewed_at FROM jobs WHERE id = %s", (job_id,)
        ).fetchone()
        if row is None or row[2] is None:
            return None
        return {"reviewer": row[0], "note": row[1], "reviewed_at": row[2].isoformat()}

    def needs_review(self, job: ClaimedJob, reason: str) -> None:
        self._finish(job.id, "needs_review", reason)

    def fail(self, job: ClaimedJob, error: str) -> None:
        if job.attempts < job.max_attempts:
            self._conn.execute(
                """UPDATE jobs SET status = 'queued', error = %s, locked_by = NULL, locked_at = NULL,
                          run_after = now() + make_interval(secs => %s), updated_at = now()
                    WHERE id = %s""",
                (error, backoff_seconds(job.attempts), job.id),
            )
        else:
            self._finish(job.id, "failed", error)

    def _finish(self, job_id: str, status: str, error: str | None) -> None:
        self._conn.execute(
            """UPDATE jobs SET status = %s, error = %s, locked_by = NULL, locked_at = NULL,
                      updated_at = now() WHERE id = %s""",
            (status, error, job_id),
        )

    def event(
        self, job_id: str, level: Level, message: str, data: dict[str, Any] | None = None
    ) -> None:
        self._conn.execute(
            "INSERT INTO job_events (job_id, level, message, data) VALUES (%s, %s, %s, %s)",
            (job_id, level, message, json.dumps(data) if data is not None else None),
        )

    def upsert_models(self, models: list[ModelDescriptor]) -> None:
        with self._conn.transaction():
            for m in models:
                self._conn.execute(
                    """INSERT INTO llm_models (provider, provider_kind, model_id, display_name)
                       VALUES (%s, %s, %s, %s)
                       ON CONFLICT (provider, model_id) DO UPDATE
                         SET provider_kind = EXCLUDED.provider_kind,
                             display_name = COALESCE(EXCLUDED.display_name, llm_models.display_name),
                             discovered_at = now()""",
                    (m.provider, m.provider_kind, m.model_id, m.display_name),
                )

    def reap_stale(self, older_than_s: float) -> int:
        """Re-queue jobs whose worker died mid-run."""
        cur = self._conn.execute(
            """UPDATE jobs SET status = 'queued', locked_by = NULL, locked_at = NULL,
                      error = 'worker lock expired', updated_at = now()
                WHERE status = 'running' AND locked_at < now() - make_interval(secs => %s)""",
            (older_than_s,),
        )
        return cur.rowcount
