"""The decomposition register (spec §8; table `decomposition_register`): which document in a
target each source became, on one tenant (a sink and instance; plan ruling R5).

The worker writes only `pending` entries, under a row lock over the decision (R6): it looks the
source up with `by_key` (which locks the row), decides, and `put_pending` before delivering, then
records the bridge's delivery with `set_delivery`. The API settles the entry from the bridge's
events as `delivered`, `incomplete`, `changed` or `failed`; the worker never writes those.
"""

from __future__ import annotations

import threading
import uuid
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, contextmanager
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal, Protocol

from ingest_worker.bridge.models import Receipt

if TYPE_CHECKING:
    import psycopg

RegisterState = Literal["pending", "delivered", "incomplete", "changed", "failed"]


@dataclass(frozen=True)
class RegisterEntry:
    """A `decomposition_register` row."""

    id: str
    sink_id: str
    #: None for a sink without instances.
    instance_id: str | None
    #: The file's path relative to the batch's source folder (its name, uploaded on its own).
    source_key: str
    content_sha256: str
    #: Once known, never cleared.
    persistent_id: str | None
    state: RegisterState
    idempotency_key: str
    #: The latest delivery (None until the bridge accepted it).
    delivery_id: str | None
    #: The last receipt with a document: the components an update expects unchanged.
    last_receipt: Receipt | None
    last_error: dict[str, Any] | None
    batch_id: str | None
    created_at: datetime
    updated_at: datetime
    delivered_at: datetime | None


class RegisterRaced(Exception):
    """Another delivery registered the same source between the look-up and the write (a new
    source, so there was no row to lock): this one is refused as in flight."""


class RegisterTx(Protocol):
    def by_key(
        self, sink_id: str, instance_id: str | None, source_key: str
    ) -> RegisterEntry | None:
        """The source's entry on the tenant, locked until the transaction ends."""
        ...

    def by_hash(self, sink_id: str, instance_id: str | None, sha: str) -> list[RegisterEntry]:
        """Every entry on the tenant with this content, oldest first. The content is locked on
        the tenant until the transaction ends, so two new sources with the same bytes are
        decided one after the other (the second sees the first's entry)."""
        ...

    def put_pending(
        self,
        *,
        replacing: RegisterEntry | None,
        sink_id: str,
        instance_id: str | None,
        source_key: str,
        content_sha256: str,
        idempotency_key: str,
        batch_id: str | None,
    ) -> RegisterEntry:
        """The source's entry, now `pending` under `idempotency_key`. `replacing` (the entry
        `by_key` found and locked) is reset: its delivery and error cleared, its persistent id
        and last receipt kept. Without it a new entry is inserted, and RegisterRaced raised when
        one appeared meanwhile."""
        ...

    def set_delivery(self, entry_id: str, delivery_id: str) -> None:
        """Record the delivery the bridge accepted for a pending entry."""
        ...

    def set_failed(self, entry_id: str, error: dict[str, Any]) -> None:
        """A pending entry the bridge refused outright (nothing was accepted): `failed`, with
        the refusal as its last error."""
        ...


class RegisterStore(Protocol):
    def transaction(self) -> AbstractContextManager[RegisterTx]:
        """One transaction: committed when the block ends, rolled back when it raises."""
        ...


# --- In memory ---------------------------------------------------------------------------------


class _MemoryTx:
    def __init__(self, rows: dict[str, RegisterEntry], clock: Callable[[], datetime]) -> None:
        self.rows = rows
        self._clock = clock

    def by_key(
        self, sink_id: str, instance_id: str | None, source_key: str
    ) -> RegisterEntry | None:
        return next(
            (
                e
                for e in self.rows.values()
                if (e.sink_id, e.instance_id, e.source_key) == (sink_id, instance_id, source_key)
            ),
            None,
        )

    def by_hash(self, sink_id: str, instance_id: str | None, sha: str) -> list[RegisterEntry]:
        return [
            e
            for e in self.rows.values()
            if (e.sink_id, e.instance_id, e.content_sha256) == (sink_id, instance_id, sha)
        ]

    def put_pending(
        self,
        *,
        replacing: RegisterEntry | None,
        sink_id: str,
        instance_id: str | None,
        source_key: str,
        content_sha256: str,
        idempotency_key: str,
        batch_id: str | None,
    ) -> RegisterEntry:
        now = self._clock()
        current = self.by_key(sink_id, instance_id, source_key)
        if replacing is None:
            if current is not None:
                raise RegisterRaced(source_key)
            entry = RegisterEntry(
                id=str(uuid.uuid4()),
                sink_id=sink_id,
                instance_id=instance_id,
                source_key=source_key,
                content_sha256=content_sha256,
                persistent_id=None,
                state="pending",
                idempotency_key=idempotency_key,
                delivery_id=None,
                last_receipt=None,
                last_error=None,
                batch_id=batch_id,
                created_at=now,
                updated_at=now,
                delivered_at=None,
            )
        else:
            base = self.rows[replacing.id]
            entry = replace(
                base,
                content_sha256=content_sha256,
                state="pending",
                idempotency_key=idempotency_key,
                delivery_id=None,
                last_error=None,
                batch_id=batch_id,
                updated_at=now,
            )
        self.rows[entry.id] = entry
        return entry

    def set_delivery(self, entry_id: str, delivery_id: str) -> None:
        entry = self.rows[entry_id]
        self.rows[entry_id] = replace(entry, delivery_id=delivery_id, updated_at=self._clock())

    def set_failed(self, entry_id: str, error: dict[str, Any]) -> None:
        entry = self.rows[entry_id]
        if entry.state == "pending":
            self.rows[entry_id] = replace(
                entry, state="failed", last_error=error, updated_at=self._clock()
            )


class MemoryRegisterStore:
    """The register in memory, for tests: one transaction at a time (so content is locked as on
    Postgres, trivially), each on a copy of the rows that replaces them when it commits."""

    def __init__(self, clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self._rows: dict[str, RegisterEntry] = {}
        self._lock = threading.Lock()
        self._clock = clock

    @contextmanager
    def transaction(self) -> Iterator[RegisterTx]:
        with self._lock:
            tx = _MemoryTx(dict(self._rows), self._clock)
            yield tx
            self._rows = tx.rows

    def entries(self) -> list[RegisterEntry]:
        return list(self._rows.values())

    def settle(
        self,
        entry_id: str,
        *,
        state: RegisterState,
        persistent_id: str | None = None,
        last_receipt: Receipt | None = None,
    ) -> None:
        """What the API does on a delivery's final event (tests stand in for it)."""
        with self._lock:
            entry = self._rows[entry_id]
            self._rows[entry_id] = replace(
                entry,
                state=state,
                persistent_id=persistent_id or entry.persistent_id,
                last_receipt=last_receipt if last_receipt is not None else entry.last_receipt,
            )


# --- Postgres ----------------------------------------------------------------------------------

_COLUMNS = """id::text, sink_id, instance_id, source_key, content_sha256, persistent_id, state,
  idempotency_key, delivery_id, last_receipt, last_error, batch_id, created_at, updated_at,
  delivered_at"""


def _entry(row: tuple[Any, ...]) -> RegisterEntry:
    (id_, sink_id, instance_id, source_key, sha, persistent_id, state, key, delivery_id) = row[:9]
    receipt, error, batch_id, created_at, updated_at, delivered_at = row[9:]
    return RegisterEntry(
        id=id_,
        sink_id=sink_id,
        instance_id=instance_id,
        source_key=source_key,
        content_sha256=sha,
        persistent_id=persistent_id,
        state=state,
        idempotency_key=key,
        delivery_id=delivery_id,
        last_receipt=Receipt.model_validate(receipt) if receipt is not None else None,
        last_error=error,
        batch_id=batch_id,
        created_at=created_at,
        updated_at=updated_at,
        delivered_at=delivered_at,
    )


class _PgTx:
    def __init__(self, conn: psycopg.Connection[Any]) -> None:
        self._conn = conn

    def by_key(
        self, sink_id: str, instance_id: str | None, source_key: str
    ) -> RegisterEntry | None:
        row = self._conn.execute(
            f"""SELECT {_COLUMNS} FROM decomposition_register
                 WHERE sink_id = %s AND instance_id IS NOT DISTINCT FROM %s AND source_key = %s
                 FOR UPDATE""",
            (sink_id, instance_id, source_key),
        ).fetchone()
        return _entry(row) if row else None

    def by_hash(self, sink_id: str, instance_id: str | None, sha: str) -> list[RegisterEntry]:
        self._conn.execute(
            "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
            (f"decomposition_register\n{sink_id}\n{instance_id or ''}\n{sha}",),
        )
        rows = self._conn.execute(
            f"""SELECT {_COLUMNS} FROM decomposition_register
                 WHERE sink_id = %s AND instance_id IS NOT DISTINCT FROM %s
                   AND content_sha256 = %s
                 ORDER BY created_at, id""",
            (sink_id, instance_id, sha),
        ).fetchall()
        return [_entry(r) for r in rows]

    def put_pending(
        self,
        *,
        replacing: RegisterEntry | None,
        sink_id: str,
        instance_id: str | None,
        source_key: str,
        content_sha256: str,
        idempotency_key: str,
        batch_id: str | None,
    ) -> RegisterEntry:
        if replacing is not None:
            row = self._conn.execute(
                f"""UPDATE decomposition_register
                       SET content_sha256 = %s, state = 'pending', idempotency_key = %s,
                           delivery_id = NULL, last_error = NULL, batch_id = %s,
                           updated_at = now()
                     WHERE id = %s
                 RETURNING {_COLUMNS}""",
                (content_sha256, idempotency_key, batch_id, replacing.id),
            ).fetchone()
        else:
            # No row to lock: a delivery that inserted one meanwhile wins, and this one refuses.
            row = self._conn.execute(
                f"""INSERT INTO decomposition_register
                       (sink_id, instance_id, source_key, content_sha256, state,
                        idempotency_key, batch_id)
                    VALUES (%s, %s, %s, %s, 'pending', %s, %s)
                    ON CONFLICT (sink_id, instance_id, source_key) DO NOTHING
                 RETURNING {_COLUMNS}""",
                (sink_id, instance_id, source_key, content_sha256, idempotency_key, batch_id),
            ).fetchone()
            if row is None:
                raise RegisterRaced(source_key)
        if row is None:
            raise LookupError(f"register entry {replacing and replacing.id} is gone")
        return _entry(row)

    def set_delivery(self, entry_id: str, delivery_id: str) -> None:
        self._conn.execute(
            """UPDATE decomposition_register SET delivery_id = %s, updated_at = now()
                WHERE id = %s AND state = 'pending'""",
            (delivery_id, entry_id),
        )

    def set_failed(self, entry_id: str, error: dict[str, Any]) -> None:
        from psycopg.types.json import Jsonb

        self._conn.execute(
            """UPDATE decomposition_register
                  SET state = 'failed', last_error = %s, updated_at = now()
                WHERE id = %s AND state = 'pending'""",
            (Jsonb(error), entry_id),
        )


class PgRegisterStore:
    """The register on Postgres: each transaction on its own connection from `conn_factory`
    (closed afterwards), so `by_key`'s `SELECT … FOR UPDATE` holds until it ends."""

    def __init__(self, conn_factory: Callable[[], psycopg.Connection[Any]]) -> None:
        self._connect = conn_factory

    @classmethod
    def for_url(cls, database_url: str) -> PgRegisterStore:
        import psycopg

        return cls(lambda: psycopg.connect(database_url, autocommit=True))

    @contextmanager
    def transaction(self) -> Iterator[RegisterTx]:
        conn = self._connect()
        try:
            with conn.transaction():
                yield _PgTx(conn)
        finally:
            conn.close()
