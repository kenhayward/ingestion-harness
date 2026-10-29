"""The per-tenant lane gate (decompose/lanes.py): memory always, Postgres with
IH_TEST_DATABASE_URL (a throwaway database with db/migrations applied; the test adds its own
targets, batches and items and removes them)."""

from __future__ import annotations

import os
import uuid
from collections.abc import Iterator
from typing import Any, Protocol

import pytest

from ingest_worker.decompose.items import ItemOutcome
from ingest_worker.decompose.lanes import LaneStore, PgLaneStore, Tenant, lanes_for
from ingest_worker.publish_targets import Target

from .fakes import MemoryLaneStore

DB = os.environ.get("IH_TEST_DATABASE_URL")

DOCS: Tenant = ("docs-sink", "acme")
OTHER: Tenant = ("docs-sink", "globex")
BARE: Tenant = ("other-sink", None)


class World(Protocol):
    """A lane store and the items it reads, as the tests set them up."""

    store: LaneStore

    def batch(self, tenant: Tenant) -> str: ...

    def item(self, batch: str, outcome: ItemOutcome = "decomposing") -> str: ...

    def set_outcome(self, item_id: str, outcome: ItemOutcome) -> None: ...

    def claim_lane(self, item_id: str) -> None:
        """The item holds a lane already (set directly, as an earlier claim would)."""
        ...


class MemoryWorld:
    def __init__(self) -> None:
        self.store = MemoryLaneStore()
        self.tenants: dict[str, Tenant] = {}

    def batch(self, tenant: Tenant) -> str:
        batch = str(uuid.uuid4())
        self.store.add_batch(batch, tenant)
        return batch

    def item(self, batch: str, outcome: ItemOutcome = "decomposing") -> str:
        item_id = str(uuid.uuid4())
        self.store.add_item(item_id, batch, outcome)
        return item_id

    def set_outcome(self, item_id: str, outcome: ItemOutcome) -> None:
        self.store.set_outcome(item_id, outcome)

    def claim_lane(self, item_id: str) -> None:
        self.store.mark_claimed(item_id)


class PgWorld:
    def __init__(self, url: str) -> None:
        import psycopg

        self.conn: psycopg.Connection[Any] = psycopg.connect(url, autocommit=True)
        self.store = PgLaneStore(self.conn)
        self.targets: dict[Tenant, str] = {}
        self.batches: list[str] = []

    def _target(self, tenant: Tenant) -> str:
        if tenant not in self.targets:
            target_id = f"lanes-{uuid.uuid4().hex[:12]}"
            self.conn.execute(
                """INSERT INTO publish_targets (id, label, kind, sink_id, instance_id, destination)
                   VALUES (%s, %s, 'sink', %s, %s, '{}')""",
                (target_id, target_id, tenant[0], tenant[1]),
            )
            self.targets[tenant] = target_id
        return self.targets[tenant]

    def batch(self, tenant: Tenant) -> str:
        row = self.conn.execute(
            """INSERT INTO decomposition_batches (target_id, created_by, state, created_at)
               VALUES (%s, '{"id": null, "name": null}', 'started', clock_timestamp())
               RETURNING id::text""",
            (self._target(tenant),),
        ).fetchone()
        assert row is not None
        self.batches.append(row[0])
        return str(row[0])

    def item(self, batch: str, outcome: ItemOutcome = "decomposing") -> str:
        item_id = str(uuid.uuid4())
        self.conn.execute(
            """INSERT INTO decomposition_items
                 (id, batch_id, source_key, filename, content_sha256, size_bytes, object_key,
                  outcome, created_at)
               VALUES (%s, %s, %s, 'f.docx', %s, 10, 'decompositions/b/i.docx', %s,
                       clock_timestamp())""",
            (item_id, batch, f"k/{item_id}.docx", "a" * 64, outcome),
        )
        return item_id

    def set_outcome(self, item_id: str, outcome: ItemOutcome) -> None:
        self.conn.execute(
            "UPDATE decomposition_items SET outcome = %s WHERE id = %s", (outcome, item_id)
        )

    def claim_lane(self, item_id: str) -> None:
        self.conn.execute(
            "UPDATE decomposition_items SET lane_claimed_at = now() WHERE id = %s", (item_id,)
        )

    def close(self) -> None:
        for batch in self.batches:
            self.conn.execute("DELETE FROM decomposition_items WHERE batch_id = %s", (batch,))
            self.conn.execute("DELETE FROM decomposition_batches WHERE id = %s", (batch,))
        for target_id in self.targets.values():
            self.conn.execute("DELETE FROM publish_targets WHERE id = %s", (target_id,))
        self.conn.close()


@pytest.fixture(params=["memory", pytest.param("pg", marks=pytest.mark.integration)])
def world(request: pytest.FixtureRequest) -> Iterator[World]:
    if request.param == "memory":
        yield MemoryWorld()
        return
    if DB is None:
        pytest.skip("IH_TEST_DATABASE_URL not set")
    pg = PgWorld(DB)
    try:
        yield pg
    finally:
        pg.close()


def test_one_lane_takes_one_item_until_it_is_done(world: World) -> None:
    batch = world.batch(DOCS)
    first, second = world.item(batch), world.item(batch)
    assert world.store.try_claim(first, DOCS, 1)
    assert world.store.in_flight(DOCS) == 1
    assert not world.store.try_claim(second, DOCS, 1)
    world.set_outcome(first, "delivering")
    assert not world.store.try_claim(second, DOCS, 1)
    world.set_outcome(first, "created")
    assert world.store.in_flight(DOCS) == 0
    assert world.store.try_claim(second, DOCS, 1)


def test_a_claim_is_kept_when_asked_again(world: World) -> None:
    batch = world.batch(DOCS)
    item = world.item(batch)
    assert world.store.try_claim(item, DOCS, 1)
    assert world.store.try_claim(item, DOCS, 1)  # a retry of its job keeps its lane
    assert world.store.in_flight(DOCS) == 1


def test_fewer_lanes_than_in_flight_waits(world: World) -> None:
    batch = world.batch(DOCS)
    for _ in range(3):
        held = world.item(batch, "delivering")
        world.claim_lane(held)
    assert world.store.in_flight(DOCS) == 3
    assert not world.store.try_claim(world.item(batch), DOCS, 1)


def test_a_waiting_item_blocks_a_newcomer(world: World) -> None:
    batch = world.batch(DOCS)
    world.item(batch, "waiting_to_deliver")
    assert world.store.in_flight(DOCS) == 0
    assert not world.store.try_claim(world.item(world.batch(DOCS)), DOCS, 2)
    assert world.store.waiting_tenants() == [DOCS]


@pytest.mark.parametrize(
    ("outcome", "held"),
    [
        ("decomposing", 1),
        ("waiting_to_deliver", 1),
        ("delivering", 1),
        ("failed", 0),
        ("created", 0),
        ("updated", 0),
        ("awaiting_review", 0),
        ("unresolved", 0),
    ],
)
def test_a_lane_is_held_only_while_the_item_is_on_its_way(
    world: World, outcome: ItemOutcome, held: int
) -> None:
    item = world.item(world.batch(DOCS), outcome)
    world.claim_lane(item)
    assert world.store.in_flight(DOCS) == held


def test_items_without_a_lane_are_not_in_flight(world: World) -> None:
    batch = world.batch(DOCS)
    world.item(batch, "delivering")
    world.item(batch, "decomposing")
    assert world.store.in_flight(DOCS) == 0


def test_dispatch_takes_turns_between_batches(world: World) -> None:
    a = world.batch(DOCS)
    a_items = [world.item(a, "waiting_to_deliver") for _ in range(3)]
    b = world.batch(DOCS)
    b_items = [world.item(b, "waiting_to_deliver")]
    order: list[str] = []
    for _ in range(4):
        claimed = world.store.dispatch(DOCS, 1)
        assert len(claimed) == 1
        assert world.store.dispatch(DOCS, 1) == []  # the lane is taken
        order.extend(claimed)
        world.set_outcome(claimed[0], "created")
    assert order == [a_items[0], b_items[0], a_items[1], a_items[2]]
    assert world.store.dispatch(DOCS, 1) == []
    assert world.store.waiting_tenants() == []


def test_dispatch_fills_every_free_lane(world: World) -> None:
    a, b = world.batch(DOCS), world.batch(DOCS)
    a_items = [world.item(a, "waiting_to_deliver") for _ in range(2)]
    b_items = [world.item(b, "waiting_to_deliver") for _ in range(2)]
    held = world.item(a, "delivering")
    world.claim_lane(held)
    assert world.store.dispatch(DOCS, 3) == [a_items[0], b_items[0]]
    assert world.store.in_flight(DOCS) == 3
    assert world.store.dispatch(DOCS, 3) == []


def test_tenants_do_not_block_each_other(world: World) -> None:
    docs, other, bare = world.batch(DOCS), world.batch(OTHER), world.batch(BARE)
    assert world.store.try_claim(world.item(docs), DOCS, 1)
    world.item(docs, "waiting_to_deliver")
    assert world.store.try_claim(world.item(other), OTHER, 1)
    assert world.store.try_claim(world.item(bare), BARE, 1)
    assert world.store.in_flight(DOCS) == 1
    assert world.store.in_flight(OTHER) == 1
    assert world.store.in_flight(BARE) == 1
    assert world.store.waiting_tenants() == [DOCS]
    assert world.store.dispatch(OTHER, 2) == []


@pytest.mark.parametrize(("lanes", "expected"), [(None, 1), (1, 1), (4, 4)])
def test_lanes_for_a_target(lanes: int | None, expected: int) -> None:
    assert lanes_for(Target("t", "", layout="sink", sink_id="docs", lanes=lanes)) == expected
