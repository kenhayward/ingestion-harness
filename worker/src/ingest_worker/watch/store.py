"""What the watch cycle reads and writes (migration 202610291400): the watches, their pickups
(one file seen in a folder root and how far it got), the finishes the throughput counts, the
watch's events, and the conversion batch, item and `decompose` job a pickup becomes.

A pickup's steps: `seen` (listed), `stored` (a copy in the runs bucket, its working name, item id
and object key chosen), `moved` (in `processing/`), `queued` (its item and job created),
`refusing` (a file conversion refuses: its `failed` item recorded, the file still to go to
`failed/`), `finished` (moved out of `processing/`, or refused and filed) or `abandoned`. Each step
is written before the next action, so a cycle that stops anywhere is completed by the next one
(cycle.py)."""

from __future__ import annotations

import hashlib
import uuid
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Any, Literal, Protocol

from psycopg.types.json import Jsonb

from ingest_worker.bridge.models import ActingUser, SourceFile

if TYPE_CHECKING:
    import psycopg

WatchState = Literal["running", "draining", "stopped"]
PickupStep = Literal["seen", "stored", "moved", "queued", "refusing", "finished", "abandoned"]
EventLevel = Literal["info", "warn", "error"]

#: Steps of a pickup on its way: its original name is in progress in the watch.
IN_PROGRESS: tuple[PickupStep, ...] = ("stored", "moved", "queued", "refusing")

#: The API's `DECOMPOSE_JOB` (apps/api/src/repositories/types.ts).
DECOMPOSE_PRIORITY = 0
DECOMPOSE_MAX_ATTEMPTS = 3

#: The content hash of a refused file that was never read (over the size limit).
UNREAD = "unread"


@dataclass(frozen=True)
class Watch:
    id: str
    name: str
    target_id: str
    source: dict[str, str]
    source_path: str
    run_as: ActingUser
    force: bool
    auto_approve: bool
    reason_files: bool
    sleep_seconds: int
    admit: int
    state: WatchState
    batch_id: str | None
    problem: str | None
    next_look_at: datetime


@dataclass(frozen=True)
class Pickup:
    id: str
    watch_id: str
    original_name: str
    size: int
    modified_at: datetime
    etag: str | None
    first_seen_at: datetime
    step: PickupStep
    working_name: str | None = None
    item_id: str | None = None
    object_key: str | None = None
    #: Moves (and resume's listings) the sink refused (store.py `move_failed`).
    move_failures: int = 0


@dataclass(frozen=True)
class ItemState:
    """A watched item as the finish step reads it."""

    outcome: str
    detail: str | None
    batch_id: str


def modified_of(f: SourceFile) -> datetime:
    return datetime.fromisoformat(f.modified_at)


def sha256_of(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def job_params(watch: Watch, batch_id: str, item_id: str, source_key: str) -> dict[str, Any]:
    """The `decompose` job's params, as the API's batch start writes them."""
    params: dict[str, Any] = {
        "batchId": batch_id,
        "itemId": item_id,
        "targetId": watch.target_id,
        "sourceKey": source_key,
        "force": watch.force,
    }
    if watch.auto_approve:
        params["autoApprove"] = True
    return params


def batch_creator(watch: Watch) -> dict[str, Any]:
    """The batch's creator, the run-as user, as the API's `batchCreator` writes it."""
    return {"id": watch.run_as.id, "name": watch.run_as.name}


class WatchStore(Protocol):
    def due(self, now: datetime) -> list[Watch]:
        """Running and draining watches whose next look is at or before `now`."""
        ...

    def watch(self, watch_id: str) -> Watch | None: ...

    def pickups(self, watch_id: str) -> list[Pickup]:
        """The watch's pickups that are neither finished nor abandoned."""
        ...

    def see(self, watch_id: str, f: SourceFile, now: datetime) -> None:
        """Record a listed file (`seen` at `now`), unless a pickup of the same name, size and
        modified time exists; a finished or abandoned one is seen afresh (a new upload)."""
        ...

    def forget_unlisted(self, watch_id: str, listed: set[str]) -> None:
        """Drop `seen` pickups whose ids are not in `listed`: files gone or changed since."""
        ...

    def advance(self, pickup_id: str, step: PickupStep, **fields: str | None) -> None:
        """Move a pickup to `step`, setting `working_name`, `item_id`, `object_key` if given. A
        new working name also renames the pickup's item, when it has one."""
        ...

    def batch_of(self, watch: Watch) -> str:
        """The watch's batch, created (started, its creator the run-as user) when it has none."""
        ...

    def admit(
        self,
        watch: Watch,
        pickup: Pickup,
        item_id: str,
        object_key: str,
        working_name: str,
        content_sha256: str,
        source_key: str,
        now: datetime,
    ) -> bool:
        """In one transaction: the watch's batch, the watched item, its `decompose` job, the
        pickup `queued`. A pickup no longer `stored` or `moved` is left alone (False). Does
        nothing unless the watch is `running` now (the pickup is abandoned: False)."""
        ...

    def refuse(
        self,
        watch: Watch,
        pickup: Pickup,
        working_name: str,
        reason: str,
        content_sha256: str,
        source_key: str,
        now: datetime,
    ) -> str:
        """In one transaction, before the file moves: a `failed` item with no stored copy, and
        the pickup `refusing` with its working name and item. A pickup no longer `seen` is left
        alone. The item id (the existing one when left alone; "" when the watch is no longer
        `running`, and the file stays in the root). The finish comes once the file is in
        `failed/` (`finish`)."""
        ...

    def item_state(self, item_id: str) -> ItemState | None: ...

    def move_failed(self, pickup_id: str) -> int:
        """Count a move the sink refused; the count so far."""
        ...

    def finish(
        self, watch_id: str, delivered: bool, at: datetime, pickup_id: str | None = None
    ) -> None:
        """Count a finished document (a `watch_finishes` row and the total), and mark its pickup
        `finished`, in one transaction."""
        ...

    def set_health(
        self, watch_id: str, problem: str | None, root_waiting: int | None, now: datetime
    ) -> None: ...

    def schedule(self, watch_id: str, next_look_at: datetime) -> None: ...

    def event(
        self,
        watch_id: str,
        level: EventLevel,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None: ...

    def set_state(self, watch_id: str, state: WatchState, expect: WatchState | None = None) -> None:
        """Set the watch's state; with `expect`, only while it is in that state (an admin's
        change meanwhile wins)."""
        ...


# --- Postgres ---------------------------------------------------------------------------------

_WATCH_COLUMNS = """id::text, name, target_id, source, source_path, run_as, force, auto_approve,
    reason_files, sleep_seconds, admit, state, batch_id::text, problem, next_look_at"""

_PICKUP_COLUMNS = """id::text, watch_id::text, original_name, size, modified_at, etag,
    first_seen_at, step, working_name, item_id::text, object_key, move_failures"""


def _watch(row: tuple[Any, ...]) -> Watch:
    run_as = row[5]
    return Watch(
        id=row[0],
        name=row[1],
        target_id=row[2],
        source=dict(row[3]),
        source_path=row[4],
        run_as=ActingUser(id=run_as["id"], name=run_as["name"], email=run_as.get("email")),
        force=row[6],
        auto_approve=row[7],
        reason_files=row[8],
        sleep_seconds=row[9],
        admit=row[10],
        state=row[11],
        batch_id=row[12],
        problem=row[13],
        next_look_at=row[14],
    )


def _pickup(row: tuple[Any, ...]) -> Pickup:
    return Pickup(
        id=row[0],
        watch_id=row[1],
        original_name=row[2],
        size=row[3],
        modified_at=row[4],
        etag=row[5],
        first_seen_at=row[6],
        step=row[7],
        working_name=row[8],
        item_id=row[9],
        object_key=row[10],
        move_failures=row[11],
    )


class PgWatchStore:
    """On one autocommit connection; the writes that must hold together run in a transaction."""

    def __init__(self, conn: psycopg.Connection[Any]) -> None:
        self._conn = conn

    def due(self, now: datetime) -> list[Watch]:
        rows = self._conn.execute(
            f"""SELECT {_WATCH_COLUMNS} FROM watched_folders
                 WHERE state IN ('running', 'draining') AND next_look_at <= %s
                 ORDER BY next_look_at, id""",
            (now,),
        ).fetchall()
        return [_watch(r) for r in rows]

    def watch(self, watch_id: str) -> Watch | None:
        row = self._conn.execute(
            f"SELECT {_WATCH_COLUMNS} FROM watched_folders WHERE id = %s", (watch_id,)
        ).fetchone()
        return _watch(row) if row else None

    def pickups(self, watch_id: str) -> list[Pickup]:
        rows = self._conn.execute(
            f"""SELECT {_PICKUP_COLUMNS} FROM watch_pickups
                 WHERE watch_id = %s AND step NOT IN ('finished', 'abandoned')
                 ORDER BY first_seen_at, id""",
            (watch_id,),
        ).fetchall()
        return [_pickup(r) for r in rows]

    def see(self, watch_id: str, f: SourceFile, now: datetime) -> None:
        self._conn.execute(
            """INSERT INTO watch_pickups
                 (watch_id, original_name, size, modified_at, etag, first_seen_at, updated_at)
               VALUES (%(w)s, %(n)s, %(s)s, %(m)s, %(e)s, %(now)s, %(now)s)
               ON CONFLICT (watch_id, original_name, size, modified_at) DO UPDATE
                 SET step = 'seen', first_seen_at = %(now)s, etag = EXCLUDED.etag,
                     working_name = NULL, item_id = NULL, object_key = NULL, updated_at = %(now)s
               WHERE watch_pickups.step IN ('finished', 'abandoned')""",
            {
                "w": watch_id,
                "n": f.name,
                "s": f.size,
                "m": modified_of(f),
                "e": f.etag,
                "now": now,
            },
        )

    def forget_unlisted(self, watch_id: str, listed: set[str]) -> None:
        self._conn.execute(
            """DELETE FROM watch_pickups
                WHERE watch_id = %s AND step = 'seen' AND NOT (id = ANY(%s::uuid[]))""",
            (watch_id, sorted(listed)),
        )

    def advance(self, pickup_id: str, step: PickupStep, **fields: str | None) -> None:
        unknown = set(fields) - {"working_name", "item_id", "object_key"}
        if unknown:
            raise ValueError(f"no pickup field {sorted(unknown)}")
        sets = "".join(f", {name} = %({name})s" for name in fields)
        with self._conn.transaction():
            row = self._conn.execute(
                f"""UPDATE watch_pickups SET step = %(step)s, updated_at = now(){sets}
                     WHERE id = %(id)s RETURNING item_id::text, working_name""",
                {"step": step, "id": pickup_id, **fields},
            ).fetchone()
            if "working_name" in fields and row is not None and row[0] is not None:
                self._conn.execute(
                    "UPDATE decomposition_items SET filename = %s WHERE id = %s", (row[1], row[0])
                )

    def _running(self, watch: Watch) -> bool:
        """Inside a transaction: lock the watch and say whether it is `running` now. The watch
        a cycle holds may be older than a Stop that has committed since."""
        row = self._conn.execute(
            "SELECT state FROM watched_folders WHERE id = %s FOR UPDATE", (watch.id,)
        ).fetchone()
        return row is not None and row[0] == "running"

    def _ensure_batch(self, watch: Watch) -> str:
        """Inside a transaction: lock the watch and return its batch, creating one if none."""
        row = self._conn.execute(
            "SELECT batch_id::text FROM watched_folders WHERE id = %s FOR UPDATE", (watch.id,)
        ).fetchone()
        if row is None:
            raise LookupError(f"no watch {watch.id}")
        if row[0] is not None:
            return str(row[0])
        created = self._conn.execute(
            """INSERT INTO decomposition_batches
                 (target_id, created_by, state, force, auto_approve, started_at, watch_id)
               VALUES (%s, %s, 'started', %s, %s, now(), %s) RETURNING id::text""",
            (
                watch.target_id,
                Jsonb(batch_creator(watch)),
                watch.force,
                watch.auto_approve,
                watch.id,
            ),
        ).fetchone()
        assert created is not None
        self._conn.execute(
            "UPDATE watched_folders SET batch_id = %s, updated_at = now() WHERE id = %s",
            (created[0], watch.id),
        )
        return str(created[0])

    def batch_of(self, watch: Watch) -> str:
        with self._conn.transaction():
            return self._ensure_batch(watch)

    def admit(
        self,
        watch: Watch,
        pickup: Pickup,
        item_id: str,
        object_key: str,
        working_name: str,
        content_sha256: str,
        source_key: str,
        now: datetime,
    ) -> bool:
        with self._conn.transaction():
            if not self._running(watch):
                # Stopped or draining since the cycle began: nothing new is admitted, and the
                # file is let go (a stop leaves files in `processing/`, never taken again).
                self._conn.execute(
                    """UPDATE watch_pickups SET step = 'abandoned', updated_at = now()
                        WHERE id = %s AND step IN ('stored', 'moved')""",
                    (pickup.id,),
                )
                return False
            batch_id = self._ensure_batch(watch)
            row = self._conn.execute(
                "SELECT step, item_id::text FROM watch_pickups WHERE id = %s FOR UPDATE",
                (pickup.id,),
            ).fetchone()
            if row is None or row[0] not in ("stored", "moved"):
                return False
            self._conn.execute(
                """INSERT INTO decomposition_items
                     (id, batch_id, source_key, filename, content_sha256, size_bytes, object_key,
                      watched)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, true)""",
                (
                    item_id,
                    batch_id,
                    source_key,
                    working_name,
                    content_sha256,
                    pickup.size,
                    object_key,
                ),
            )
            job = self._conn.execute(
                """INSERT INTO jobs (task, priority, max_attempts, params, created_by,
                                     created_by_user)
                   VALUES ('decompose', %s, %s, %s, %s, %s) RETURNING id::text""",
                (
                    DECOMPOSE_PRIORITY,
                    DECOMPOSE_MAX_ATTEMPTS,
                    Jsonb(job_params(watch, batch_id, item_id, source_key)),
                    watch.run_as.name,
                    watch.run_as.id,
                ),
            ).fetchone()
            assert job is not None
            self._conn.execute(
                "UPDATE decomposition_items SET job_id = %s WHERE id = %s", (job[0], item_id)
            )
            self._conn.execute(
                """UPDATE watch_pickups SET step = 'queued', item_id = %s, object_key = %s,
                          working_name = %s, updated_at = now()
                    WHERE id = %s""",
                (item_id, object_key, working_name, pickup.id),
            )
            self._conn.execute(
                """UPDATE watched_folders SET last_pickup_at = %s, updated_at = now()
                    WHERE id = %s""",
                (now, watch.id),
            )
        return True

    def refuse(
        self,
        watch: Watch,
        pickup: Pickup,
        working_name: str,
        reason: str,
        content_sha256: str,
        source_key: str,
        now: datetime,
    ) -> str:
        item_id = str(uuid.uuid4())
        with self._conn.transaction():
            if not self._running(watch):
                return ""  # the file stays in the root
            batch_id = self._ensure_batch(watch)
            row = self._conn.execute(
                "SELECT step, item_id::text FROM watch_pickups WHERE id = %s FOR UPDATE",
                (pickup.id,),
            ).fetchone()
            if row is None or row[0] != "seen":
                return str(row[1]) if row and row[1] else ""
            self._conn.execute(
                """INSERT INTO decomposition_items
                     (id, batch_id, source_key, filename, content_sha256, size_bytes, object_key,
                      watched, outcome, detail, finished_at)
                   VALUES (%s, %s, %s, %s, %s, %s, NULL, true, 'failed', %s, %s)""",
                (
                    item_id,
                    batch_id,
                    source_key,
                    working_name,
                    content_sha256,
                    pickup.size,
                    reason,
                    now,
                ),
            )
            self._conn.execute(
                """UPDATE watch_pickups SET step = 'refusing', working_name = %s, item_id = %s,
                          updated_at = now()
                    WHERE id = %s""",
                (working_name, item_id, pickup.id),
            )
            self._conn.execute(
                "UPDATE watched_folders SET last_pickup_at = %s WHERE id = %s", (now, watch.id)
            )
        return item_id

    def item_state(self, item_id: str) -> ItemState | None:
        row = self._conn.execute(
            "SELECT outcome, detail, batch_id::text FROM decomposition_items WHERE id = %s",
            (item_id,),
        ).fetchone()
        return ItemState(outcome=row[0], detail=row[1], batch_id=row[2]) if row else None

    def move_failed(self, pickup_id: str) -> int:
        row = self._conn.execute(
            """UPDATE watch_pickups SET move_failures = move_failures + 1, updated_at = now()
                WHERE id = %s RETURNING move_failures""",
            (pickup_id,),
        ).fetchone()
        return int(row[0]) if row else 0

    def _finish(self, watch_id: str, delivered: bool, at: datetime, pickup_id: str | None) -> None:
        self._conn.execute(
            "INSERT INTO watch_finishes (watch_id, finished_at, delivered) VALUES (%s, %s, %s)",
            (watch_id, at, delivered),
        )
        column = "total_delivered" if delivered else "total_failed"
        self._conn.execute(
            f"""UPDATE watched_folders SET {column} = {column} + 1, updated_at = now()
                 WHERE id = %s""",
            (watch_id,),
        )
        if pickup_id is not None:
            self._conn.execute(
                "UPDATE watch_pickups SET step = 'finished', updated_at = now() WHERE id = %s",
                (pickup_id,),
            )

    def finish(
        self, watch_id: str, delivered: bool, at: datetime, pickup_id: str | None = None
    ) -> None:
        with self._conn.transaction():
            if pickup_id is not None:
                row = self._conn.execute(
                    "SELECT step FROM watch_pickups WHERE id = %s FOR UPDATE", (pickup_id,)
                ).fetchone()
                if row is None or row[0] in ("finished", "abandoned"):
                    return  # counted already (another runner, or stop now)
            self._finish(watch_id, delivered, at, pickup_id)

    def set_health(
        self, watch_id: str, problem: str | None, root_waiting: int | None, now: datetime
    ) -> None:
        self._conn.execute(
            """UPDATE watched_folders
                  SET problem = %s, root_waiting = COALESCE(%s, root_waiting),
                      last_look_at = %s, updated_at = now()
                WHERE id = %s""",
            (problem, root_waiting, now, watch_id),
        )

    def schedule(self, watch_id: str, next_look_at: datetime) -> None:
        self._conn.execute(
            "UPDATE watched_folders SET next_look_at = %s WHERE id = %s",
            (next_look_at, watch_id),
        )

    def event(
        self,
        watch_id: str,
        level: EventLevel,
        message: str,
        details: dict[str, Any] | None = None,
    ) -> None:
        self._conn.execute(
            "INSERT INTO watch_events (watch_id, level, message, details) VALUES (%s, %s, %s, %s)",
            (watch_id, level, message, Jsonb(details) if details is not None else None),
        )

    def set_state(self, watch_id: str, state: WatchState, expect: WatchState | None = None) -> None:
        self._conn.execute(
            """UPDATE watched_folders SET state = %s, updated_at = now()
                WHERE id = %s AND (%s::text IS NULL OR state = %s)""",
            (state, watch_id, expect, expect),
        )
