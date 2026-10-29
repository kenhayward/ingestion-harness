"""The lane gate of conversions (watched folders plan 2, migration 202610291300): a tenant (a sink
and its instance) takes at most `lanes` documents at once, as the bridge's sink catalog says.

An item takes a lane (`decomposition_items.lane_claimed_at`) before its document is handed to the
bridge, and holds it while it is `decomposing`, `waiting_to_deliver` or `delivering`: leaving
those states releases it, so nothing ever clears a lane. An item that finds no free lane waits
(`waiting_to_deliver`); `dispatch` gives freed lanes to waiting items, the batches taking turns
(the one longest since its last lane first, `decomposition_batches.last_lane_at`), each batch's
oldest waiting item first. A newcomer never jumps the queue: while any item of the tenant waits
without a lane, `try_claim` refuses.

The tenant of an item is `decomposition_items → decomposition_batches.target_id →
publish_targets (sink_id, instance_id)`.
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Protocol

from ingest_worker.decompose.items import _is_uuid

if TYPE_CHECKING:
    import psycopg

    from ingest_worker.publish_targets import Target

#: A sink id and its instance (None for a sink without instances).
Tenant = tuple[str, str | None]

#: The outcomes in which an item with a lane holds it.
HOLDING = ("decomposing", "waiting_to_deliver", "delivering")


def lanes_for(target: Target) -> int:
    """How many documents the target's tenant takes at once: one when the sink says nothing."""
    return target.lanes or 1


class LaneStore(Protocol):
    def try_claim(self, item_id: str, tenant: Tenant, lanes: int) -> bool:
        """Take a lane for the item: only while fewer than `lanes` are in flight and no other item
        of the tenant waits without one. True as well when the item holds a lane already."""
        ...

    def in_flight(self, tenant: Tenant) -> int:
        """The tenant's items holding a lane."""
        ...

    def dispatch(self, tenant: Tenant, lanes: int) -> list[str]:
        """Give the tenant's free lanes to its waiting items, in turn; the ids that got one."""
        ...

    def waiting_tenants(self) -> list[Tenant]:
        """The tenants with an item waiting without a lane, sorted."""
        ...


class PgLaneStore:
    """The lanes on Postgres. Every tenant's method runs in one transaction holding the tenant's
    advisory lock, so two workers never hand out the same lane."""

    def __init__(self, conn: psycopg.Connection[Any]) -> None:
        self._conn = conn

    def _lock(self, tenant: Tenant) -> None:
        self._conn.execute(
            "SELECT pg_advisory_xact_lock(hashtext('lanes:' || %s || ':' || coalesce(%s, '')))",
            (tenant[0], tenant[1]),
        )

    _TENANT_ITEMS = """FROM decomposition_items i
                         JOIN decomposition_batches b ON b.id = i.batch_id
                         JOIN publish_targets t ON t.id = b.target_id
                        WHERE t.sink_id = %(sink)s
                          AND t.instance_id IS NOT DISTINCT FROM %(instance)s::text"""

    def _count(self, tenant: Tenant) -> int:
        row = self._conn.execute(
            f"""SELECT count(*) {self._TENANT_ITEMS}
                  AND i.lane_claimed_at IS NOT NULL
                  AND i.outcome IN ('decomposing', 'waiting_to_deliver', 'delivering')""",
            {"sink": tenant[0], "instance": tenant[1]},
        ).fetchone()
        return int(row[0]) if row is not None else 0

    def _claim(self, item_id: str, batch_id: str) -> None:
        self._conn.execute(
            "UPDATE decomposition_items SET lane_claimed_at = now() WHERE id = %s", (item_id,)
        )
        # clock_timestamp: two claims of one transaction still take turns.
        self._conn.execute(
            "UPDATE decomposition_batches SET last_lane_at = clock_timestamp() WHERE id = %s",
            (batch_id,),
        )

    def try_claim(self, item_id: str, tenant: Tenant, lanes: int) -> bool:
        if not _is_uuid(item_id):  # names no item
            return False
        with self._conn.transaction():
            self._lock(tenant)
            row = self._conn.execute(
                """SELECT batch_id::text, lane_claimed_at IS NOT NULL AND outcome = ANY(%s)
                     FROM decomposition_items WHERE id = %s::uuid""",
                (list(HOLDING), item_id),
            ).fetchone()
            if row is None:
                return False
            batch_id, holding = str(row[0]), bool(row[1])
            if holding:
                return True
            if self._count(tenant) >= lanes:
                return False
            waiting = self._conn.execute(
                f"""SELECT 1 {self._TENANT_ITEMS}
                      AND i.outcome = 'waiting_to_deliver' AND i.lane_claimed_at IS NULL
                      AND i.id <> %(item)s::uuid
                    LIMIT 1""",
                {"sink": tenant[0], "instance": tenant[1], "item": item_id},
            ).fetchone()
            if waiting is not None:
                return False
            self._claim(item_id, batch_id)
            return True

    def in_flight(self, tenant: Tenant) -> int:
        with self._conn.transaction():
            self._lock(tenant)
            return self._count(tenant)

    def dispatch(self, tenant: Tenant, lanes: int) -> list[str]:
        claimed: list[str] = []
        with self._conn.transaction():
            self._lock(tenant)
            free = lanes - self._count(tenant)
            while free > 0:
                row = self._conn.execute(
                    f"""SELECT i.id::text, b.id::text {self._TENANT_ITEMS}
                          AND i.outcome = 'waiting_to_deliver' AND i.lane_claimed_at IS NULL
                        ORDER BY b.last_lane_at NULLS FIRST, b.created_at, b.id,
                                 i.created_at, i.id
                        LIMIT 1""",
                    {"sink": tenant[0], "instance": tenant[1]},
                ).fetchone()
                if row is None:
                    break
                self._claim(str(row[0]), str(row[1]))
                claimed.append(str(row[0]))
                free -= 1
        return claimed

    def waiting_tenants(self) -> list[Tenant]:
        rows = self._conn.execute(
            """SELECT DISTINCT t.sink_id, t.instance_id
                 FROM decomposition_items i
                 JOIN decomposition_batches b ON b.id = i.batch_id
                 JOIN publish_targets t ON t.id = b.target_id
                WHERE i.outcome = 'waiting_to_deliver' AND i.lane_claimed_at IS NULL
                ORDER BY t.sink_id, t.instance_id NULLS FIRST"""
        ).fetchall()
        return [(str(sink), None if instance is None else str(instance)) for sink, instance in rows]
