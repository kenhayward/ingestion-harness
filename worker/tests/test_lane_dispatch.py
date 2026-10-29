"""The lane dispatcher (decompose/dispatch.py): free lanes go to waiting documents, each through a
`waited` decompose job. Memory always; Postgres with IH_TEST_DATABASE_URL (a throwaway database
with db/migrations applied; the tests add their own targets, batches, items and jobs and remove
them)."""

from __future__ import annotations

import os
import threading
import uuid
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.decompose.dispatch import dispatch_lanes
from ingest_worker.decompose.items import (
    ConversionItem,
    ItemOutcome,
    MemoryItemStore,
    PgItemStore,
)
from ingest_worker.decompose.job import DecomposeParams, DecompositionStores
from ingest_worker.decompose.lanes import PgLaneStore, Tenant
from ingest_worker.decompose.register import MemoryRegisterStore
from ingest_worker.main import lane_round, run_once
from ingest_worker.publish_targets import Target, TargetNotSynced
from ingest_worker.queue import PgJobQueue

from .fakes import FakeQueue, FakeTargets, MemoryLaneStore

DB = os.environ.get("IH_TEST_DATABASE_URL")

DOCS: Tenant = ("docs-sink", "acme")


def target(target_id: str = "docs", lanes: int | None = 1) -> Target:
    return Target(target_id, "", layout="sink", sink_id=DOCS[0], instance_id=DOCS[1], lanes=lanes)


class SharedItems(MemoryItemStore):
    """The item store over the same rows as the lane store, as on Postgres."""

    def __init__(self, lanes: MemoryLaneStore) -> None:
        super().__init__()
        self._lanes = lanes

    def decide(self, item_id: str, outcome: ItemOutcome, detail: str, entry_id: str | None) -> bool:
        done = super().decide(item_id, outcome, detail, entry_id)
        if done:
            self._lanes.set_outcome(item_id, outcome)
        return done


class MemoryWorld:
    def __init__(self) -> None:
        self.lanes = MemoryLaneStore()
        self.items = SharedItems(self.lanes)
        self.queue = FakeQueue()

    def batch(self, target_id: str = "docs") -> str:
        batch = str(uuid.uuid4())
        self.lanes.add_batch(batch, DOCS, target_id)
        return batch

    def waiting(self, batch: str) -> str:
        item_id = str(uuid.uuid4())
        self.lanes.add_item(item_id, batch, "waiting_to_deliver")
        self.items.add(
            ConversionItem(item_id, batch, f"k/{item_id}.docx", "o", "waiting_to_deliver")
        )
        return item_id


def test_a_free_lane_goes_to_the_waiting_item() -> None:
    world = MemoryWorld()
    item = world.waiting(world.batch())
    queued = dispatch_lanes(world.lanes, FakeTargets({"docs": target()}), world.queue, world.items)
    assert queued == 1
    assert world.queue.waited_items == [item]
    assert world.lanes.items[item].claimed is not None
    assert world.lanes.items[item].outcome == "waiting_to_deliver"


def test_no_free_lane_queues_nothing() -> None:
    world = MemoryWorld()
    batch = world.batch()
    busy = str(uuid.uuid4())
    world.lanes.add_item(busy, batch, "delivering")
    world.lanes.mark_claimed(busy)
    item = world.waiting(batch)
    queued = dispatch_lanes(world.lanes, FakeTargets({"docs": target()}), world.queue, world.items)
    assert queued == 0
    assert world.queue.waited_items == []
    assert world.lanes.items[item].claimed is None


def test_every_free_lane_is_given() -> None:
    world = MemoryWorld()
    batch = world.batch()
    items = [world.waiting(batch) for _ in range(3)]
    targets = FakeTargets({"docs": target(lanes=2)})
    assert dispatch_lanes(world.lanes, targets, world.queue, world.items) == 2
    assert world.queue.waited_items == items[:2]


def test_a_missing_target_fails_its_waiting_items() -> None:
    world = MemoryWorld()
    gone = [world.waiting(world.batch("gone")) for _ in range(2)]
    kept = world.waiting(world.batch())
    queued = dispatch_lanes(world.lanes, FakeTargets({"docs": target()}), world.queue, world.items)
    for item_id in gone:
        assert world.items.items[item_id].outcome == "failed"
        assert world.items.items[item_id].detail == "no publishing target gone"
        assert world.lanes.items[item_id].claimed is None
    assert queued == 1
    assert world.queue.waited_items == [kept]


class UnsyncedTargets(FakeTargets):
    def get(self, target_id: str) -> Target:
        raise TargetNotSynced(target_id)


def test_a_target_not_synced_is_skipped_this_round() -> None:
    world = MemoryWorld()
    item = world.waiting(world.batch())
    queued = dispatch_lanes(world.lanes, UnsyncedTargets({}), world.queue, world.items)
    assert queued == 0
    assert world.items.items[item].outcome == "waiting_to_deliver"
    assert world.lanes.items[item].claimed is None


def test_an_item_with_a_lane_but_no_job_is_queued_again() -> None:
    # The worker stopped between the lane's claim and the job's insert: the next round queues it.
    world = MemoryWorld()
    world.queue.lane_orphans = ["orphan"]
    assert dispatch_lanes(world.lanes, FakeTargets({}), world.queue, world.items) == 1
    assert world.queue.waited_items == ["orphan"]


def test_an_item_is_queued_once() -> None:
    queue = FakeQueue()
    assert queue.queue_decompose_waited("a") is not None
    assert queue.queue_decompose_waited("a") is None


# --- Postgres -------------------------------------------------------------------------------


class PgWorld:
    def __init__(self, url: str) -> None:
        import psycopg

        self.url = url
        self.conn: psycopg.Connection[Any] = psycopg.connect(url, autocommit=True)
        self.target_id = f"dispatch-{uuid.uuid4().hex[:12]}"
        self.conn.execute(
            """INSERT INTO publish_targets (id, label, kind, sink_id, instance_id, destination)
               VALUES (%s, %s, 'sink', %s, %s, '{}')""",
            (self.target_id, self.target_id, DOCS[0], DOCS[1]),
        )
        self.batches: list[str] = []

    def batch(self, *, force: bool = False, auto_approve: bool = False) -> str:
        row = self.conn.execute(
            """INSERT INTO decomposition_batches
                 (target_id, created_by, state, force, auto_approve, created_at)
               VALUES (%s, '{"id": null, "name": null}', 'started', %s, %s, clock_timestamp())
               RETURNING id::text""",
            (self.target_id, force, auto_approve),
        ).fetchone()
        assert row is not None
        self.batches.append(str(row[0]))
        return str(row[0])

    def waiting(self, batch: str, *, created_by: str | None = None) -> str:
        item_id = str(uuid.uuid4())
        job = self.conn.execute(
            """INSERT INTO jobs (task, priority, max_attempts, params, status, created_by)
               VALUES ('decompose', 0, 3, %s, 'succeeded', %s) RETURNING id""",
            (
                f'{{"batchId": "{batch}", "itemId": "{item_id}", "targetId": "{self.target_id}",'
                f' "sourceKey": "k/{item_id}.docx", "force": false}}',
                created_by,
            ),
        ).fetchone()
        assert job is not None
        self.conn.execute(
            """INSERT INTO decomposition_items
                 (id, batch_id, source_key, filename, content_sha256, size_bytes, object_key,
                  outcome, job_id, created_at)
               VALUES (%s, %s, %s, 'f.docx', %s, 10, 'decompositions/b/i.docx',
                       'waiting_to_deliver', %s, clock_timestamp())""",
            (item_id, batch, f"k/{item_id}.docx", "a" * 64, job[0]),
        )
        return item_id

    def item(self, item_id: str) -> tuple[str, bool, str | None]:
        row = self.conn.execute(
            """SELECT outcome, lane_claimed_at IS NOT NULL, job_id::text
                 FROM decomposition_items WHERE id = %s""",
            (item_id,),
        ).fetchone()
        assert row is not None
        return str(row[0]), bool(row[1]), row[2]

    def job(self, job_id: str) -> tuple[str, int, int, dict[str, Any], str, str | None]:
        row = self.conn.execute(
            """SELECT task, priority, max_attempts, params, status, created_by
                 FROM jobs WHERE id = %s""",
            (job_id,),
        ).fetchone()
        assert row is not None
        return str(row[0]), int(row[1]), int(row[2]), dict(row[3]), str(row[4]), row[5]

    def targets(self, lanes: int = 1) -> FakeTargets:
        return FakeTargets({self.target_id: target(self.target_id, lanes)})

    def close(self) -> None:
        for batch in self.batches:
            self.conn.execute("DELETE FROM decomposition_items WHERE batch_id = %s", (batch,))
            self.conn.execute("DELETE FROM decomposition_batches WHERE id = %s", (batch,))
            self.conn.execute(
                "DELETE FROM jobs WHERE task = 'decompose' AND params->>'batchId' = %s", (batch,)
            )
        self.conn.execute("DELETE FROM publish_targets WHERE id = %s", (self.target_id,))
        self.conn.close()


@pytest.fixture
def pg() -> Any:
    if DB is None:
        pytest.skip("IH_TEST_DATABASE_URL not set")
    world = PgWorld(DB)
    try:
        yield world
    finally:
        world.close()


@pytest.mark.integration
def test_pg_dispatch_queues_a_waited_job_as_the_batch_started_it(pg: PgWorld) -> None:
    batch = pg.batch(force=True, auto_approve=True)
    item = pg.waiting(batch, created_by="Ada")
    queue = PgJobQueue(pg.url)
    try:
        queued = dispatch_lanes(PgLaneStore(pg.conn), pg.targets(), queue, PgItemStore(pg.conn))
        assert queued == 1
        outcome, claimed, job_id = pg.item(item)
        assert (outcome, claimed) == ("waiting_to_deliver", True)
        assert job_id is not None
        task, priority, attempts, params, status, by = pg.job(job_id)
        assert (task, priority, attempts, status, by) == ("decompose", 0, 3, "queued", "Ada")
        assert params == {
            "batchId": batch,
            "itemId": item,
            "targetId": pg.target_id,
            "sourceKey": f"k/{item}.docx",
            "force": True,
            "autoApprove": True,
            "waited": True,
        }
        assert DecomposeParams.model_validate(params).waited
        # Queued once: asking again, or the sweep for lanes without a job, adds nothing.
        assert queue.queue_decompose_waited(item) is None
        assert queue.lanes_without_job() == []
    finally:
        queue.close()


@pytest.mark.integration
def test_pg_params_leave_auto_approve_out_unless_the_batch_has_it(pg: PgWorld) -> None:
    item = pg.waiting(pg.batch())
    queue = PgJobQueue(pg.url)
    try:
        dispatch_lanes(PgLaneStore(pg.conn), pg.targets(), queue, PgItemStore(pg.conn))
        job_id = pg.item(item)[2]
        assert job_id is not None
        params = pg.job(job_id)[3]
        assert "autoApprove" not in params
        assert params["force"] is False
    finally:
        queue.close()


@pytest.mark.integration
def test_pg_a_lane_claimed_without_a_job_is_queued_by_the_next_round(pg: PgWorld) -> None:
    item = pg.waiting(pg.batch())
    lanes = PgLaneStore(pg.conn)
    assert lanes.dispatch(DOCS, 1) == [item]  # ...and the worker stopped here
    queue = PgJobQueue(pg.url)
    try:
        assert queue.lanes_without_job() == [item]
        assert dispatch_lanes(lanes, pg.targets(), queue, PgItemStore(pg.conn)) == 1
        job_id = pg.item(item)[2]
        assert job_id is not None
        assert pg.job(job_id)[3]["waited"] is True
        assert queue.lanes_without_job() == []
    finally:
        queue.close()


@pytest.mark.integration
def test_pg_a_missing_target_fails_its_items(pg: PgWorld) -> None:
    item = pg.waiting(pg.batch())
    queue = PgJobQueue(pg.url)
    try:
        queued = dispatch_lanes(PgLaneStore(pg.conn), FakeTargets({}), queue, PgItemStore(pg.conn))
        assert queued == 0
        outcome, claimed, _ = pg.item(item)
        assert (outcome, claimed) == ("failed", False)
    finally:
        queue.close()


@pytest.mark.integration
def test_pg_two_dispatchers_never_over_claim(pg: PgWorld) -> None:
    import psycopg

    batch = pg.batch()
    items = [pg.waiting(batch) for _ in range(5)]
    conns = [psycopg.connect(pg.url, autocommit=True) for _ in range(2)]
    queues = [PgJobQueue(pg.url) for _ in range(2)]
    start = threading.Barrier(2)
    results = [0, 0]

    def run(n: int) -> None:
        start.wait()
        results[n] = dispatch_lanes(
            PgLaneStore(conns[n]), pg.targets(), queues[n], PgItemStore(conns[n])
        )

    try:
        threads = [threading.Thread(target=run, args=(n,)) for n in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert sum(results) == 1
        waited = pg.conn.execute(
            """SELECT count(*) FROM jobs
                WHERE task = 'decompose' AND params->>'batchId' = %s
                  AND params->>'waited' = 'true'""",
            (batch,),
        ).fetchone()
        assert waited is not None and waited[0] == 1
        assert sum(1 for i in items if pg.item(i)[1]) == 1
    finally:
        for q in queues:
            q.close()
        for c in conns:
            c.close()


# --- The worker's rounds ----------------------------------------------------------------------


def test_run_once_tells_the_caller_which_job_ended(tmp_path: Path) -> None:
    from .test_template_db import make
    from .test_template_pipeline import JOB

    deps, _, _ = make(tmp_path)
    job = replace(JOB, task="decompose", params={})
    ended: list[str] = []
    assert run_once(FakeQueue(jobs=[job]), deps, "w1", after=lambda j: ended.append(j.task))
    assert ended == ["decompose"]


def test_a_lane_round_dispatches_through_the_workers_stores(tmp_path: Path) -> None:
    from .test_template_db import make

    deps, _, _ = make(tmp_path)
    world = MemoryWorld()
    item = world.waiting(world.batch())
    deps = replace(
        deps,
        targets=FakeTargets({"docs": target()}),
        decomposition=DecompositionStores(
            register=MemoryRegisterStore(), items=world.items, lanes=world.lanes
        ),
    )
    assert lane_round(deps, world.queue) == 1
    assert world.queue.waited_items == [item]


def test_a_lane_round_without_conversions_does_nothing(tmp_path: Path) -> None:
    from .test_template_db import make

    deps, _, _ = make(tmp_path)
    assert lane_round(replace(deps, decomposition=None), FakeQueue()) == 0


class BrokenLanes(MemoryLaneStore):
    def waiting_tenants(self) -> list[Tenant]:
        raise RuntimeError("database gone")


def test_a_failing_lane_round_never_stops_the_worker(tmp_path: Path) -> None:
    from .test_template_db import make

    deps, _, _ = make(tmp_path)
    deps = replace(
        deps,
        targets=FakeTargets({}),
        decomposition=DecompositionStores(
            register=MemoryRegisterStore(), items=MemoryItemStore(), lanes=BrokenLanes()
        ),
    )
    assert lane_round(deps, FakeQueue()) == 0
