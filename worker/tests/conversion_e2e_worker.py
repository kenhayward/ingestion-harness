"""The worker side of the conversion and watched folder end to ends
(apps/api/test/integration/conversion-e2e-pg.test.ts and watch-e2e-pg.test.ts run
`python -m tests.conversion_e2e_worker` for each run): the worker's own `run_once` claims and
runs every queued `decompose` job on the shared Postgres, with its Pg item and register stores
and its HTTP bridge client, until none is left. With E2E_WATCH_NOW set, the run first looks at
every due watched folder once (the worker's `WatchRunner.tick` over its Pg watch store, the
bridge's watched folder relay and the same object store), as of that time: the test moves its
clock on between runs, so a file settles without waiting.

Faked: the object store (a MemoryObjectStore filled from the files the test lists, and written
back when the run ends, so a hold's files reach the API and an approved run finds them), the
target cache (the one target, as the test names it) and the layout analyser (each PDF fixture in
tests/decompose/pdf/fixtures answered with its saved Docling output). Only `decompose` jobs are
claimed, so another suite's rows left in the throwaway database are never run. Documents waiting
for a lane are dispatched as the worker does (`lane_round`), once the test's earlier runs'
deliveries are settled.

Environment: E2E_DATABASE_URL, E2E_BRIDGE_URL, E2E_BRIDGE_KEY, E2E_OBJECTS (a JSON list of
{bucket, key, path}), E2E_OBJECTS_AFTER (where the store is written back, a JSON list of
{bucket, key, contentType, body} with the body in base64), E2E_TARGET ({id, sinkId}) and,
for the watched folders, E2E_WATCH_NOW (an ISO time) and E2E_MAX_BYTES (the upload limit).
"""

from __future__ import annotations

import base64
import hashlib
import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import Any

import psycopg

from ingest_worker.bridge.client import HttpBridgeClient
from ingest_worker.decompose.items import PgItemStore
from ingest_worker.decompose.job import DecompositionStores
from ingest_worker.decompose.lanes import PgLaneStore
from ingest_worker.decompose.register import PgRegisterStore
from ingest_worker.main import lane_round, run_once
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.publish_targets import Target, TargetMissing
from ingest_worker.queue import CLAIM_SQL, ClaimedJob, PgJobQueue
from ingest_worker.storage import MemoryObjectStore
from ingest_worker.watch.cycle import WatchDeps
from ingest_worker.watch.runner import MemoryWatchLocks, WatchRunner
from ingest_worker.watch.store import PgWatchStore
from tests.decompose.pdf.fakes import PDF_FIXTURES

#: The worker's claim, of `decompose` jobs only.
DECOMPOSE_CLAIM = CLAIM_SQL.replace(
    "WHERE status = 'queued'", "WHERE status = 'queued' AND task = 'decompose'", 1
)
assert DECOMPOSE_CLAIM != CLAIM_SQL, "the worker's claim changed: update the end to end"


class DecomposeQueue(PgJobQueue):
    def claim(self, worker_id: str) -> ClaimedJob | None:
        row = self._conn.execute(DECOMPOSE_CLAIM, {"worker": worker_id}).fetchone()
        return ClaimedJob(*row) if row else None


class OneTarget:
    def __init__(self, target_id: str, sink_id: str) -> None:
        self._target = Target(target_id, "", layout="sink", sink_id=sink_id, instance_id=None)

    def get(self, target_id: str) -> Target:
        if target_id != self._target.id:
            raise TargetMissing(target_id)
        return self._target

    def removed(self, target_id: str) -> bool:
        return False

    def rdf(self) -> Target | None:
        return None


class FixtureLayout:
    """The layout service for the PDF fixtures: each answered with its saved Docling output."""

    def __init__(self) -> None:
        self._answers: dict[str, dict[str, Any]] = {}
        for pdf in PDF_FIXTURES.glob("*.pdf"):
            saved = pdf.with_suffix(".docling.json").read_text("utf-8")
            self._answers[hashlib.sha256(pdf.read_bytes()).hexdigest()] = json.loads(saved)

    def analyse(self, pdf: bytes, first: int, last: int) -> dict[str, Any]:
        return self._answers[hashlib.sha256(pdf).hexdigest()]

    def fingerprint(self) -> str:
        return "fixtures"


def cache_target(conn: psycopg.Connection[Any], target_id: str, sink_id: str) -> None:
    """The target's row in the API's cache (`publish_targets`): the lane gate finds an item's
    tenant through it (lanes.py). The API side of the test keeps its targets in memory."""
    conn.execute(
        """INSERT INTO publish_targets (id, label, kind, sink_id, destination, synced_at)
           VALUES (%s, %s, 'sink', %s, '{}', now())
           ON CONFLICT (id) DO NOTHING""",
        (target_id, target_id, sink_id),
    )


def run_until_settled(queue: DecomposeQueue, deps: PipelineDeps) -> None:
    """Every queued job run, documents waiting for a lane given the free ones as the worker's
    dispatcher does (`lane_round`), until nothing more can run. A lane held by a delivery frees
    only once the bridge's event settles it, after this run: the test's next run dispatches it."""
    while True:
        while run_once(queue, deps, "conversion-e2e", after=lambda _job: lane_round(deps, queue)):
            pass
        if not lane_round(deps, queue):
            return


def look_at_watches(
    conn: psycopg.Connection[Any], bridge: HttpBridgeClient, store: MemoryObjectStore
) -> None:
    """Every due watched folder looked at once, as of E2E_WATCH_NOW (none without it)."""
    now = os.environ.get("E2E_WATCH_NOW")
    if not now:
        return
    at = datetime.fromisoformat(now)
    runner = WatchRunner(
        WatchDeps(
            store=PgWatchStore(conn),
            bridge=bridge,
            objects=store,
            runs_bucket="runs",
            max_bytes=int(os.environ.get("E2E_MAX_BYTES", str(1024 * 1024))),
            app_url=None,
        ),
        MemoryWatchLocks(),
        clock=lambda: at,
    )
    runner.tick()


def write_back(store: MemoryObjectStore, path: Path) -> None:
    objects = [
        {
            "bucket": bucket,
            "key": key,
            "contentType": content_type,
            "body": base64.b64encode(body).decode("ascii"),
        }
        for (bucket, key), (body, content_type) in store.objects.items()
    ]
    path.write_text(json.dumps(objects), encoding="utf-8")


def main() -> None:
    logging.basicConfig(level=logging.WARNING)
    database_url = os.environ["E2E_DATABASE_URL"]
    target = json.loads(os.environ["E2E_TARGET"])
    store = MemoryObjectStore()
    for o in json.loads(Path(os.environ["E2E_OBJECTS"]).read_text(encoding="utf-8")):
        store.put(o["bucket"], o["key"], Path(o["path"]).read_bytes(), "application/octet-stream")
    queue = DecomposeQueue(database_url)
    bridge = HttpBridgeClient(os.environ["E2E_BRIDGE_URL"], os.environ["E2E_BRIDGE_KEY"])
    with (
        psycopg.connect(database_url, autocommit=True) as items_conn,
        psycopg.connect(database_url, autocommit=True) as lanes_conn,
        psycopg.connect(database_url, autocommit=True) as watch_conn,
    ):
        cache_target(lanes_conn, target["id"], target["sinkId"])
        look_at_watches(watch_conn, bridge, store)
        deps = PipelineDeps(
            store=store,
            specs=None,  # type: ignore[arg-type]
            models=None,  # type: ignore[arg-type]
            extract_text=lambda _pdf: [],
            buckets=Buckets("inbox", "outputs", "runs"),
            targets=OneTarget(target["id"], target["sinkId"]),
            bridge=bridge,
            layout=FixtureLayout(),
            decomposition=DecompositionStores(
                register=PgRegisterStore.for_url(database_url),
                items=PgItemStore(items_conn),
                lanes=PgLaneStore(lanes_conn),
            ),
        )
        run_until_settled(queue, deps)
    write_back(store, Path(os.environ["E2E_OBJECTS_AFTER"]))


if __name__ == "__main__":
    main()
