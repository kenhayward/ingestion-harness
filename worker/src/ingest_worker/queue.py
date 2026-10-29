"""Postgres-backed job queue (jobs table, see db/migrations). Claims use FOR UPDATE SKIP LOCKED
so any number of worker replicas can poll concurrently.

Statuses: queued, running, succeeded, failed, needs_review, awaiting_review, rejected, cancelled.
`cancelled` is set by an operator (API); every worker status write is guarded with
`AND status = 'running'`, so the worker never overwrites a cancel.
Claims take higher jobs.priority first (production 0, workbench -10; ADR 0007).
Idle workers LISTEN on ih_jobs (trigger jobs_notify_queued, migration 0009) and wake as soon as a
job is queued; the poll interval is only a fallback."""

from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal, Protocol

from .bridge.models import ActingUser
from .llm.base import ModelDescriptor
from .outputs import RenderedOutput

if TYPE_CHECKING:
    from .publish_targets import Target

Level = Literal["debug", "info", "warn", "error"]


#: How long a lane claimed without a `waited` job is left to the dispatcher that claimed it
#: (it queues the job right after) before another counts it an orphan, in seconds.
ORPHAN_GRACE_S = 30

#: The job statuses after which a `decompose` run decides nothing more.
ENDED_JOB_STATUSES = ("succeeded", "failed", "cancelled", "needs_review", "rejected")


@dataclass(frozen=True)
class EndedLane:
    """A conversion item holding a lane, undecided (`decomposing`, or `waiting_to_deliver`
    under its `waited` run), whose job ended: it was given up or cancelled without deciding."""

    item_id: str
    batch_id: str
    #: The job's status, or None when the job is gone.
    status: str | None
    error: str | None


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
    #: "process" (extract), "publish" (apply review edits, deliver), "rerun" (one step) or
    #: "prepare" (workbench: text + OCR only) or "segment" (workbench anchor preview; no document),
    #: or a document-less background task such as "decompose" (one conversion batch item; see
    #: main.TASKS for them all).
    task: str = "process"
    #: Test run of a (draft) template: processed and reviewable, never published.
    test: bool = False
    #: task="rerun": {"step": id, "model"?: ref, "instructions"?: text}
    rerun: dict[str, Any] | None = None
    #: jobs.locked_at of this claim: identifies *this* run. A cancel, delete, retry or stale-lock
    #: reap changes or removes it, after which the run must stop and write nothing.
    claimed_at: datetime | None = None
    #: Workbench project of a project-scoped job (prepare, test runs, segment).
    project_id: str | None = None
    #: Task parameters (segment: samples + candidate document block).
    params: dict[str, Any] | None = None
    #: The document's file name as uploaded ('' without a document): every extraction prompt
    #: names it, so a step can fill an output like the originating file name.
    filename: str = ""
    #: sha256 of the uploaded file ('' without a document): the package's idempotency key.
    source_sha256: str = ""
    #: Seconds the job had waited for a target sync when claimed (jobs.waiting_since; None: not
    #: waiting). Past TARGET_SYNC_MAX_WAIT_S the job fails instead of waiting again.
    waited_s: float | None = None


class JobQueue(Protocol):
    def claim(self, worker_id: str) -> ClaimedJob | None: ...

    def wait_for_work(self, timeout_s: float) -> None:
        """Block until a job is queued (NOTIFY ih_jobs) or `timeout_s` passes."""
        ...

    def is_cancelled(self, job: ClaimedJob) -> bool:
        """True once the job is no longer this run's claim: cancelled, deleted, re-queued
        (Retry, stale-lock reap) or claimed again by another run."""
        ...

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

    def record_drafts(self, job: ClaimedJob, outputs: list[RenderedOutput], bucket: str) -> None:
        """Record draft outputs as soon as they are written, whatever happens to the run next,
        so deleting the job can find and remove them."""
        ...

    def record_published(
        self,
        job: ClaimedJob,
        outputs: list[RenderedOutput],
        target: Target,
        delivery_id: str | None,
        *,
        primary: bool = True,
    ) -> None:
        """Record outputs delivered to `target` (its id and bucket, the keys as written, the
        bridge's delivery that writes them, and whether it is the job's primary target)."""
        ...

    def delivering(
        self,
        job: ClaimedJob,
        outputs: list[RenderedOutput],
        outputs_bucket: str,
        deliveries: list[tuple[str, str]],
    ) -> None:
        """Hand the job to the bridge: status `delivering` with its draft outputs recorded, and
        one `job_deliveries` row per (target id, delivery id). The bridge's events finish it."""
        ...

    def reviewer(self, job_id: str) -> ActingUser | None:
        """The CT Studio user who approved the job (None: not reviewed, or no such user)."""
        ...

    def uploader(self, job_id: str) -> ActingUser | None:
        """The CT Studio user who queued the job (None: not recorded)."""
        ...

    def delivery_overrides(self, job_id: str) -> dict[str, dict[str, str]]:
        """The names the reviewer chose at the job's approval, per target and name field."""
        ...

    def record_delivered_as(self, job_id: str, user_id: str) -> None:
        """The bridge accepted a package of the job as this user (a re-delivery acts as them)."""
        ...

    def flag_connection_needed(self, job_id: str) -> None:
        """The job waits in review for a person's connection (the review offers to add one)."""
        ...

    def last_deliverer(self, job_id: str) -> ActingUser | None:
        """The user the job was last delivered as (None: never, or no such user now)."""
        ...

    def review_edits(self, job_id: str) -> list[dict[str, Any]]:
        """Reviewer edits in the order they were made."""
        ...

    def review_decision(self, job_id: str) -> dict[str, Any] | None: ...

    def load_template(self, template_id: str, version: int) -> dict[str, Any] | None:
        """Template definition stored in the database (None: not a database template)."""
        ...

    def record_step_run(self, job_id: str, run: dict[str, Any]) -> None:
        """One extract step execution: step_id, trigger, model, attempts, tokens, status, times."""
        ...

    def needs_review(self, job: ClaimedJob, reason: str) -> None: ...

    def fail(self, job: ClaimedJob, error: str) -> None:
        """Re-queue with backoff while attempts remain, else mark failed."""
        ...

    def wait(self, job: ClaimedJob, reason: str, delay_s: float) -> None:
        """Re-queue after `delay_s` without spending an attempt (the claim's is given back). The
        first wait records when the job started waiting (jobs.waiting_since)."""
        ...

    def stop_waiting(self, job: ClaimedJob) -> None:
        """The job got past what it waited for: clear jobs.waiting_since. Every status the
        worker writes other than a wait clears it as well."""
        ...

    def give_up(self, job: ClaimedJob, error: str) -> None:
        """Mark failed whatever attempts remain (a wait past its ceiling)."""
        ...

    def event(
        self, job_id: str, level: Level, message: str, data: dict[str, Any] | None = None
    ) -> None: ...

    def upsert_models(self, models: list[ModelDescriptor]) -> None: ...

    def reap_stale(self, older_than_s: float) -> int:
        """Re-queue running jobs whose heartbeat stopped (their worker died)."""
        ...

    def queue_suggest(self, project_id: str, params: dict[str, Any]) -> tuple[str, list[str]]:
        """Queue the project's `suggest` job (SuggestParams), replacing its earlier one like the
        API's createSuggestJob; the new job's id and the ids it replaced."""
        ...

    def queue_decompose_waited(self, item_id: str) -> str | None:
        """Queue the `decompose` run of a conversion item that waited for a lane and now holds
        one (decompose/dispatch.py): its batch's params (DecomposeParams) with `waited: true`,
        recorded as the item's job. None, queuing nothing, when the item is not waiting with a
        lane or its job is such a run already (another dispatcher queued it)."""
        ...

    def lanes_without_job(self) -> list[str]:
        """Items waiting with a lane, claimed more than `ORPHAN_GRACE_S` ago, whose job is not a
        `waited` run: a worker stopped between the lane's claim and the job's insert. The
        dispatcher queues them again."""
        ...

    def lanes_of_ended_jobs(self) -> list[EndedLane]:
        """Items holding a lane that nothing will decide any more: `decomposing` while their job
        has ended (or is gone), or `waiting_to_deliver` while their `waited` run has ended.
        Never a `delivering` item: its job ends once the bridge has it, and the API settles it.
        The dispatcher fails them, freeing their lanes."""
        ...


# Project-scoped jobs (task segment) have no document: its columns come back as ''/0.
CLAIM_SQL = """
WITH next AS (
  SELECT id FROM jobs
   WHERE status = 'queued' AND run_after <= now()
     AND NOT EXISTS (SELECT 1 FROM queue_control WHERE paused)  -- a restore pauses the queue
   ORDER BY priority DESC, run_after, created_at
   FOR UPDATE SKIP LOCKED
   LIMIT 1
), claimed AS (
  UPDATE jobs j
     SET status = 'running', attempts = j.attempts + 1, locked_by = %(worker)s,
         locked_at = now(), heartbeat_at = now(), updated_at = now()
    FROM next WHERE j.id = next.id
  RETURNING j.*
)
SELECT c.id::text, COALESCE(c.document_id::text, ''), COALESCE(d.spec_id, c.project_id, ''),
       COALESCE(d.spec_version, 0), COALESCE(d.bucket, ''), COALESCE(d.object_key, ''),
       c.model_override, c.attempts, c.max_attempts, c.task, c.test, c.rerun, c.locked_at,
       c.project_id, c.params, COALESCE(d.filename, ''), COALESCE(d.sha256, ''),
       EXTRACT(EPOCH FROM now() - c.waiting_since)::float8
  FROM claimed c LEFT JOIN documents d ON d.id = c.document_id
"""


#: A `suggest` job's priority: the API's SEGMENT_PRIORITY, like the Survey tab's Refresh.
SUGGEST_PRIORITY = -5

#: A `decompose` job's priority and attempts: the API's DECOMPOSE_JOB (startBatch).
DECOMPOSE_PRIORITY = 0
DECOMPOSE_MAX_ATTEMPTS = 3

#: Guard for every worker status write: the row is still running under *this* claim.
_MINE = "id = %(id)s AND status = 'running' AND locked_at IS NOT DISTINCT FROM %(claimed)s"


def backoff_seconds(attempts: int) -> int:
    """30s, 2m, 4.5m, ... capped at 30 minutes."""
    return int(min(30 * attempts**2, 1800))


class PgJobQueue:
    def __init__(self, database_url: str) -> None:
        import psycopg

        self._conn = psycopg.connect(database_url, autocommit=True)
        self._listening = False

    def wait_for_work(self, timeout_s: float) -> None:
        if not self._listening:
            self._conn.execute("LISTEN ih_jobs")
            self._listening = True
        for _ in self._conn.notifies(timeout=timeout_s, stop_after=1):
            pass

    def close(self) -> None:
        self._conn.close()

    def claim(self, worker_id: str) -> ClaimedJob | None:
        row = self._conn.execute(CLAIM_SQL, {"worker": worker_id}).fetchone()
        return ClaimedJob(*row) if row else None

    def is_cancelled(self, job: ClaimedJob) -> bool:
        row = self._conn.execute(
            f"SELECT 1 FROM jobs WHERE {_MINE}", {"id": job.id, "claimed": job.claimed_at}
        ).fetchone()
        return row is None

    def complete(self, job: ClaimedJob, outputs: list[RenderedOutput], outputs_bucket: str) -> None:
        with self._conn.transaction():
            if not self._finish(job, "succeeded", None):
                return  # cancelled meanwhile: record nothing
            self._record_outputs(job, outputs, outputs_bucket, "draft")

    def _record_outputs(
        self,
        job: ClaimedJob,
        outputs: list[RenderedOutput],
        bucket: str,
        stage: str,
        target_id: str | None = None,
        delivery_id: str | None = None,
        primary: bool = True,
    ) -> None:
        for o in outputs:
            self._conn.execute(
                """INSERT INTO job_outputs (job_id, output_id, stage, format, bucket, object_key,
                       row_count, target_id, delivery_id, is_primary)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
                   ON CONFLICT (job_id, output_id, stage, target_id) DO UPDATE
                     SET bucket = EXCLUDED.bucket, object_key = EXCLUDED.object_key,
                         row_count = EXCLUDED.row_count, delivery_id = EXCLUDED.delivery_id,
                         is_primary = EXCLUDED.is_primary, created_at = now(),
                         withdrawn_at = NULL""",
                (
                    job.id,
                    o.output_id,
                    stage,
                    o.format,
                    bucket,
                    o.key,
                    o.row_count,
                    target_id,
                    delivery_id,
                    primary,
                ),
            )

    def await_review(
        self,
        job: ClaimedJob,
        outputs: list[RenderedOutput],
        outputs_bucket: str,
        reasons: list[str],
    ) -> None:
        with self._conn.transaction():
            cur = self._conn.execute(
                f"""UPDATE jobs SET status = 'awaiting_review', review_reasons = %(reasons)s,
                           error = NULL, locked_by = NULL, locked_at = NULL, updated_at = now(),
                           waiting_since = NULL
                     WHERE {_MINE}""",
                {"reasons": json.dumps(reasons), "id": job.id, "claimed": job.claimed_at},
            )
            if cur.rowcount == 0:
                return  # cancelled meanwhile: record nothing
            self._record_outputs(job, outputs, outputs_bucket, "draft")

    def record_drafts(self, job: ClaimedJob, outputs: list[RenderedOutput], bucket: str) -> None:
        self._record_outputs(job, outputs, bucket, "draft")

    def record_published(
        self,
        job: ClaimedJob,
        outputs: list[RenderedOutput],
        target: Target,
        delivery_id: str | None,
        *,
        primary: bool = True,
    ) -> None:
        with self._conn.transaction():
            if primary:
                # One primary per job: a round naming other targets (a retry under a new version)
                # leaves the old target's rows live for withdrawal, but no longer read back.
                self._conn.execute(
                    """UPDATE job_outputs SET is_primary = false
                        WHERE job_id = %s AND stage = 'published' AND target_id <> %s
                          AND is_primary""",
                    (job.id, target.id),
                )
            self._record_outputs(
                job, outputs, target.bucket, "published", target.id, delivery_id, primary
            )

    def delivering(
        self,
        job: ClaimedJob,
        outputs: list[RenderedOutput],
        outputs_bucket: str,
        deliveries: list[tuple[str, str]],
    ) -> None:
        with self._conn.transaction():
            # Cancelled meanwhile: the job keeps its status, but the bridge accepted the package
            # and delivers it, so its deliveries are recorded (their events are applied, not
            # resent for ever). A job deleted meanwhile has nothing to record them on.
            if self._finish(job, "delivering", None):
                self._record_outputs(job, outputs, outputs_bucket, "draft")
            for target_id, delivery_id in deliveries:
                self._conn.execute(
                    """INSERT INTO job_deliveries (delivery_id, job_id, target_id, status)
                       SELECT %s, id, %s, 'queued' FROM jobs WHERE id = %s
                       ON CONFLICT (delivery_id) DO NOTHING""",
                    (delivery_id, target_id, job.id),
                )

    def reviewer(self, job_id: str) -> ActingUser | None:
        # By id (recorded since phase 6), else by the name a job approved before then carries.
        row = self._conn.execute(
            """SELECT u.id::text, u.name, u.email FROM jobs j
                 JOIN users u ON (j.reviewer_user_id IS NOT NULL AND u.id = j.reviewer_user_id)
                              OR (j.reviewer_user_id IS NULL
                                  AND lower(btrim(u.name)) = lower(btrim(j.reviewer)))
                WHERE j.id = %s AND j.reviewed_at IS NOT NULL""",
            (job_id,),
        ).fetchone()
        return ActingUser(id=row[0], name=row[1], email=row[2]) if row else None

    def flag_connection_needed(self, job_id: str) -> None:
        # Only a job that is waiting in review now (not one cancelled meanwhile).
        self._conn.execute(
            """UPDATE jobs SET connection_needed = true
                WHERE id = %s AND status = 'awaiting_review'""",
            (job_id,),
        )

    def record_delivered_as(self, job_id: str, user_id: str) -> None:
        self._conn.execute(
            "UPDATE jobs SET delivered_as_user = %s WHERE id = %s", (user_id, job_id)
        )

    def last_deliverer(self, job_id: str) -> ActingUser | None:
        row = self._conn.execute(
            """SELECT u.id::text, u.name, u.email FROM jobs j
                 JOIN users u ON u.id = j.delivered_as_user WHERE j.id = %s""",
            (job_id,),
        ).fetchone()
        return ActingUser(id=row[0], name=row[1], email=row[2]) if row else None

    def uploader(self, job_id: str) -> ActingUser | None:
        row = self._conn.execute(
            """SELECT j.created_by_user::text, COALESCE(u.name, j.created_by, ''), u.email
                 FROM jobs j LEFT JOIN users u ON u.id = j.created_by_user
                WHERE j.id = %s AND j.created_by_user IS NOT NULL""",
            (job_id,),
        ).fetchone()
        return ActingUser(id=row[0], name=row[1], email=row[2]) if row else None

    def delivery_overrides(self, job_id: str) -> dict[str, dict[str, str]]:
        row = self._conn.execute(
            "SELECT delivery_overrides FROM jobs WHERE id = %s", (job_id,)
        ).fetchone()
        return dict(row[0] or {}) if row else {}

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

    def load_template(self, template_id: str, version: int) -> dict[str, Any] | None:
        row = self._conn.execute(
            "SELECT definition FROM templates WHERE id = %s AND version = %s",
            (template_id, version),
        ).fetchone()
        return row[0] if row else None

    def record_step_run(self, job_id: str, run: dict[str, Any]) -> None:
        self._conn.execute(
            """INSERT INTO step_runs (job_id, step_id, trigger, model, attempts, input_tokens,
                                      output_tokens, cached, status, error, started_at, finished_at)
               VALUES (%(job_id)s, %(step_id)s, %(trigger)s, %(model)s, %(attempts)s,
                       %(input_tokens)s, %(output_tokens)s, %(cached)s, %(status)s, %(error)s,
                       %(started_at)s, %(finished_at)s)""",
            {"job_id": job_id, "error": None, "cached": False, **run},
        )

    def needs_review(self, job: ClaimedJob, reason: str) -> None:
        self._finish(job, "needs_review", reason)

    def fail(self, job: ClaimedJob, error: str) -> None:
        if job.attempts < job.max_attempts:
            self._conn.execute(
                f"""UPDATE jobs SET status = 'queued', error = %(error)s, locked_by = NULL,
                           locked_at = NULL, updated_at = now(), waiting_since = NULL,
                           run_after = now() + make_interval(secs => %(backoff)s)
                     WHERE {_MINE}""",
                {
                    "error": error,
                    "backoff": backoff_seconds(job.attempts),
                    "id": job.id,
                    "claimed": job.claimed_at,
                },
            )
        else:
            self._finish(job, "failed", error)

    def wait(self, job: ClaimedJob, reason: str, delay_s: float) -> None:
        self._conn.execute(
            f"""UPDATE jobs SET status = 'queued', error = %(error)s, locked_by = NULL,
                       locked_at = NULL, heartbeat_at = NULL, updated_at = now(),
                       attempts = GREATEST(attempts - 1, 0),
                       waiting_since = COALESCE(waiting_since, now()),
                       run_after = now() + make_interval(secs => %(delay)s)
                 WHERE {_MINE}""",
            {"error": reason, "delay": delay_s, "id": job.id, "claimed": job.claimed_at},
        )

    def stop_waiting(self, job: ClaimedJob) -> None:
        self._conn.execute(
            f"UPDATE jobs SET waiting_since = NULL WHERE {_MINE} AND waiting_since IS NOT NULL",
            {"id": job.id, "claimed": job.claimed_at},
        )

    def give_up(self, job: ClaimedJob, error: str) -> None:
        self._finish(job, "failed", error)

    def _finish(self, job: ClaimedJob, status: str, error: str | None) -> bool:
        """Final status for this run. False when the job is no longer its claim (cancelled)."""
        cur = self._conn.execute(
            f"""UPDATE jobs SET status = %(status)s, error = %(error)s, locked_by = NULL,
                       locked_at = NULL, updated_at = now(), waiting_since = NULL
                 WHERE {_MINE}""",
            {"status": status, "error": error, "id": job.id, "claimed": job.claimed_at},
        )
        return cur.rowcount > 0

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

    def queue_suggest(self, project_id: str, params: dict[str, Any]) -> tuple[str, list[str]]:
        # As PgRepo.createSuggestJob (TS): one per project, serialized with its previews.
        with self._conn.transaction():
            self._conn.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (project_id,))
            removed = self._conn.execute(
                "DELETE FROM jobs WHERE project_id = %s AND task = 'suggest' RETURNING id::text",
                (project_id,),
            ).fetchall()
            row = self._conn.execute(
                """INSERT INTO jobs (project_id, task, test, priority, max_attempts, params)
                   VALUES (%s, 'suggest', true, %s, 3, %s) RETURNING id::text""",
                (project_id, SUGGEST_PRIORITY, json.dumps(params)),
            ).fetchone()
        assert row is not None
        return str(row[0]), [str(r[0]) for r in removed]

    def queue_decompose_waited(self, item_id: str) -> str | None:
        with self._conn.transaction():
            # The item's row lock: two dispatchers queueing one item take turns, and the second
            # finds the first one's job.
            row = self._conn.execute(
                """SELECT i.batch_id::text, i.source_key, b.target_id, b.force, b.auto_approve,
                          COALESCE(j.params->>'waited' = 'true', false),
                          j.created_by, j.created_by_user
                     FROM decomposition_items i
                     JOIN decomposition_batches b ON b.id = i.batch_id
                     LEFT JOIN jobs j ON j.id = i.job_id
                    WHERE i.id = %s::uuid AND i.outcome = 'waiting_to_deliver'
                      AND i.lane_claimed_at IS NOT NULL
                      FOR UPDATE OF i""",
                (item_id,),
            ).fetchone()
            if row is None or row[5]:
                return None
            batch_id, source_key, target_id, force, auto_approve, _, by, by_user = row
            # As startBatch (TS): autoApprove only when the batch has it.
            params: dict[str, Any] = {
                "batchId": batch_id,
                "itemId": item_id,
                "targetId": target_id,
                "sourceKey": source_key,
                "force": bool(force),
            }
            if auto_approve:
                params["autoApprove"] = True
            params["waited"] = True
            # Queued by whoever queued the item's first run (the Jobs page's "Queued by").
            job = self._conn.execute(
                """INSERT INTO jobs (task, priority, max_attempts, params, created_by,
                                    created_by_user)
                   VALUES ('decompose', %s, %s, %s, %s, %s) RETURNING id::text""",
                (DECOMPOSE_PRIORITY, DECOMPOSE_MAX_ATTEMPTS, json.dumps(params), by, by_user),
            ).fetchone()
            assert job is not None
            self._conn.execute(
                "UPDATE decomposition_items SET job_id = %s WHERE id = %s", (job[0], item_id)
            )
        return str(job[0])

    def lanes_without_job(self) -> list[str]:
        rows = self._conn.execute(
            """SELECT i.id::text FROM decomposition_items i
                 LEFT JOIN jobs j ON j.id = i.job_id
                WHERE i.outcome = 'waiting_to_deliver' AND i.lane_claimed_at IS NOT NULL
                  AND i.lane_claimed_at < now() - make_interval(secs => %s)
                  AND (j.id IS NULL OR j.params->>'waited' IS DISTINCT FROM 'true')
                ORDER BY i.lane_claimed_at, i.id""",
            (ORPHAN_GRACE_S,),
        ).fetchall()
        return [str(r[0]) for r in rows]

    def lanes_of_ended_jobs(self) -> list[EndedLane]:
        rows = self._conn.execute(
            """SELECT i.id::text, i.batch_id::text, j.status::text, j.error
                 FROM decomposition_items i
                 LEFT JOIN jobs j ON j.id = i.job_id
                WHERE i.lane_claimed_at IS NOT NULL
                  AND ((i.outcome = 'decomposing'
                        AND (j.id IS NULL OR j.status::text = ANY(%(ended)s)))
                    OR (i.outcome = 'waiting_to_deliver'
                        AND j.params->>'waited' = 'true' AND j.status::text = ANY(%(ended)s)))
                ORDER BY i.lane_claimed_at, i.id""",
            {"ended": list(ENDED_JOB_STATUSES)},
        ).fetchall()
        return [EndedLane(str(r[0]), str(r[1]), r[2], r[3]) for r in rows]

    def reap_stale(self, older_than_s: float) -> int:
        """Re-queue jobs whose worker died mid-run: no heartbeat (heartbeat.py) for
        `older_than_s`, or no claim time for a claim from before migration 0042. Whatever their
        attempts: a restart (a redeploy) is rarely the job's fault, and `run_once` logs a job
        run past its limit."""
        cur = self._conn.execute(
            """UPDATE jobs SET status = 'queued', locked_by = NULL, locked_at = NULL,
                      heartbeat_at = NULL, error = 'worker lock expired', updated_at = now()
                WHERE status = 'running'
                  AND COALESCE(heartbeat_at, locked_at) < now() - make_interval(secs => %s)""",
            (older_than_s,),
        )
        return cur.rowcount
