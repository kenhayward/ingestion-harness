"""Conversion batch items (table `decomposition_items`, migration 202610251200): the worker's side
of an item, written by the `decompose` job (job.py).

The worker moves an item from `queued` to `decomposing`, records its report key, and records the
outcome it decided: `delivering` (the bridge took the document), or a final one at once
(`already_loaded`, `duplicate`, `in_flight`, `changed_in_target`, `unresolved`, `failed`). The
API settles a `delivering` item from the bridge's events (apps/api/src/bridge/register.ts), and
an event may arrive before the worker's write, so every worker write moves only an item that is
still `queued` or `decomposing`: it never overwrites an outcome the API already settled.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass, replace
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


class ItemStore(Protocol):
    def start(self, item_id: str) -> ConversionItem | None:
        """The item as it was (None: no such item); moved to `decomposing` when it was still
        `queued` or `decomposing`."""
        ...

    def set_report(self, item_id: str, report_key: str) -> None:
        """Record where the item's report was written."""
        ...

    def decide(self, item_id: str, outcome: ItemOutcome, detail: str, entry_id: str | None) -> bool:
        """Record the worker's outcome (and the register entry it is about, when given), only
        while the item is still `queued` or `decomposing`. False when it had moved on."""
        ...


class MemoryItemStore:
    """The items in memory, for tests."""

    def __init__(self) -> None:
        self.items: dict[str, ConversionItem] = {}
        self._lock = threading.Lock()

    def add(self, item: ConversionItem) -> None:
        self.items[item.id] = item

    def start(self, item_id: str) -> ConversionItem | None:
        with self._lock:
            item = self.items.get(item_id)
            if item is not None and item.outcome in UNDECIDED:
                self.items[item_id] = replace(item, outcome="decomposing")
            return item

    def set_report(self, item_id: str, report_key: str) -> None:
        with self._lock:
            item = self.items.get(item_id)
            if item is not None:  # as on Postgres: a missing item is no error
                self.items[item_id] = replace(item, report_key=report_key)

    def decide(self, item_id: str, outcome: ItemOutcome, detail: str, entry_id: str | None) -> bool:
        with self._lock:
            item = self.items.get(item_id)
            if item is None or item.outcome not in UNDECIDED:
                return False
            self.items[item_id] = replace(
                item,
                outcome=outcome,
                detail=detail,
                register_entry_id=entry_id or item.register_entry_id,
            )
            return True


class PgItemStore:
    """The items on Postgres, on one autocommit connection."""

    def __init__(self, conn: psycopg.Connection[Any]) -> None:
        self._conn = conn

    def start(self, item_id: str) -> ConversionItem | None:
        with self._conn.transaction():
            row = self._conn.execute(
                """SELECT id::text, batch_id::text, source_key, object_key, outcome, detail,
                          register_entry_id::text, report_key
                     FROM decomposition_items WHERE id = %s FOR UPDATE""",
                (item_id,),
            ).fetchone()
            if row is None:
                return None
            item = ConversionItem(*row)
            if item.outcome in UNDECIDED:
                self._conn.execute(
                    "UPDATE decomposition_items SET outcome = 'decomposing' WHERE id = %s",
                    (item_id,),
                )
            return item

    def set_report(self, item_id: str, report_key: str) -> None:
        self._conn.execute(
            "UPDATE decomposition_items SET report_key = %s WHERE id = %s", (report_key, item_id)
        )

    def decide(self, item_id: str, outcome: ItemOutcome, detail: str, entry_id: str | None) -> bool:
        cur = self._conn.execute(
            """UPDATE decomposition_items
                  SET outcome = %s, detail = %s,
                      register_entry_id = COALESCE(%s::uuid, register_entry_id)
                WHERE id = %s AND outcome IN ('queued', 'decomposing')""",
            (outcome, detail, entry_id, item_id),
        )
        return cur.rowcount > 0
