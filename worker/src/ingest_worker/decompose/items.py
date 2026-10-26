"""Conversion batch items (table `decomposition_items`, migration 202610251200): the worker's side
of an item, written by the `decompose` job (job.py).

The worker moves an item from `queued` to `decomposing`, records its report key, and records the
outcome it decided: `delivering` (the bridge took the document), or a final one at once
(`already_loaded`, `duplicate`, `in_flight`, `changed_in_target`, `unresolved`, `failed`). The
API settles a `delivering` item from the bridge's events (apps/api/src/bridge/register.ts), and
an event may arrive before the worker's write, so every worker write moves only an item that is
still `queued` or `decomposing` (or, for a retry resuming its delivery, records `delivering` over
`delivering`): it never overwrites an outcome the API already settled.

An item records when it started (`started_at`, migration 202610261331: its first move to
`decomposing`, kept on a retry) and finished (`finished_at`: a final outcome the worker decides;
the API's settle sets it for a delivered or refused one).
"""

from __future__ import annotations

import threading
import uuid
from collections.abc import Callable
from dataclasses import dataclass, replace
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal, Protocol

if TYPE_CHECKING:
    import psycopg

#: The item outcomes (TS ITEM_OUTCOMES in packages/shared/src/conversions.ts).
ItemOutcome = Literal[
    "queued",
    "decomposing",
    "delivering",
    "created",
    "updated",
    "already_loaded",
    "duplicate",
    "in_flight",
    "changed_in_target",
    "read_back_mismatch",
    "unresolved",
    "failed",
]

#: The outcomes the worker may still move an item from: nothing decided yet.
UNDECIDED: tuple[ItemOutcome, ...] = ("queued", "decomposing")


def _writable(current: ItemOutcome, outcome: ItemOutcome) -> bool:
    """Whether the worker may record `outcome` over `current`: only while nothing is decided,
    or `delivering` again over `delivering` (a retry resuming its own delivery)."""
    return current in UNDECIDED or (current == outcome == "delivering")


def _is_uuid(text: str) -> bool:
    try:
        uuid.UUID(text)
    except ValueError:
        return False
    return True


@dataclass(frozen=True)
class ConversionItem:
    """The parts of a `decomposition_items` row the job reads."""

    id: str
    batch_id: str
    source_key: str
    #: The uploaded file in the runs bucket.
    object_key: str
    outcome: ItemOutcome
    detail: str | None = None
    register_entry_id: str | None = None
    report_key: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None


class ItemStore(Protocol):
    def start(self, item_id: str) -> ConversionItem | None:
        """The item as it was (None: no such item); moved to `decomposing` when it was still
        `queued` or `decomposing`, recording when it started unless a try already did."""
        ...

    def set_report(self, item_id: str, report_key: str) -> None:
        """Record where the item's report was written."""
        ...

    def decide(self, item_id: str, outcome: ItemOutcome, detail: str, entry_id: str | None) -> bool:
        """Record the worker's outcome (and the register entry it is about, when given), only
        while the item is still `queued` or `decomposing`, or `delivering` again over
        `delivering`. A final outcome (anything but `delivering`) records when it finished.
        False when it had moved on (the bridge's event settled it, say)."""
        ...


class MemoryItemStore:
    """The items in memory, for tests."""

    def __init__(self, clock: Callable[[], datetime] = lambda: datetime.now(UTC)) -> None:
        self.items: dict[str, ConversionItem] = {}
        self._lock = threading.Lock()
        self._clock = clock

    def add(self, item: ConversionItem) -> None:
        self.items[item.id] = item

    def start(self, item_id: str) -> ConversionItem | None:
        with self._lock:
            item = self.items.get(item_id)
            if item is not None and item.outcome in UNDECIDED:
                self.items[item_id] = replace(
                    item, outcome="decomposing", started_at=item.started_at or self._clock()
                )
            return item

    def set_report(self, item_id: str, report_key: str) -> None:
        with self._lock:
            item = self.items.get(item_id)
            if item is not None:  # as on Postgres: a missing item is no error
                self.items[item_id] = replace(item, report_key=report_key)

    def decide(self, item_id: str, outcome: ItemOutcome, detail: str, entry_id: str | None) -> bool:
        with self._lock:
            item = self.items.get(item_id)
            if item is None or not _writable(item.outcome, outcome):
                return False
            self.items[item_id] = replace(
                item,
                outcome=outcome,
                detail=detail,
                register_entry_id=entry_id or item.register_entry_id,
                finished_at=item.finished_at if outcome == "delivering" else self._clock(),
            )
            return True


class PgItemStore:
    """The items on Postgres, on one autocommit connection. An item id that is not a UUID names
    no item, as an unknown one does."""

    def __init__(self, conn: psycopg.Connection[Any]) -> None:
        self._conn = conn

    def start(self, item_id: str) -> ConversionItem | None:
        if not _is_uuid(item_id):
            return None
        with self._conn.transaction():
            row = self._conn.execute(
                """SELECT id::text, batch_id::text, source_key, object_key, outcome, detail,
                          register_entry_id::text, report_key, started_at, finished_at
                     FROM decomposition_items WHERE id = %s FOR UPDATE""",
                (item_id,),
            ).fetchone()
            if row is None:
                return None
            item = ConversionItem(*row)
            if item.outcome in UNDECIDED:
                self._conn.execute(
                    """UPDATE decomposition_items
                          SET outcome = 'decomposing', started_at = COALESCE(started_at, now())
                        WHERE id = %s""",
                    (item_id,),
                )
            return item

    def set_report(self, item_id: str, report_key: str) -> None:
        if not _is_uuid(item_id):
            return
        self._conn.execute(
            "UPDATE decomposition_items SET report_key = %s WHERE id = %s", (report_key, item_id)
        )

    def decide(self, item_id: str, outcome: ItemOutcome, detail: str, entry_id: str | None) -> bool:
        if not _is_uuid(item_id):
            return False
        cur = self._conn.execute(
            """UPDATE decomposition_items
                  SET outcome = %(outcome)s, detail = %(detail)s,
                      register_entry_id = COALESCE(%(entry)s::uuid, register_entry_id),
                      finished_at = CASE WHEN %(outcome)s = 'delivering' THEN finished_at
                                         ELSE now() END
                WHERE id = %(id)s
                  AND (outcome IN ('queued', 'decomposing')
                       OR (outcome = 'delivering' AND %(outcome)s = 'delivering'))""",
            {"outcome": outcome, "detail": detail, "entry": entry_id, "id": item_id},
        )
        return cur.rowcount > 0
