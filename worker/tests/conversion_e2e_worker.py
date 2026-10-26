"""The worker side of the conversion end to end (apps/api/test/integration/conversion-e2e-pg.test.ts
runs `python -m tests.conversion_e2e_worker` for each run): the worker's own `run_once` claims
and runs every queued `decompose` job on the shared Postgres, with its Pg item and register
stores and its HTTP bridge client, until none is left.

Faked: the object store (a MemoryObjectStore filled from the files the test lists) and the
target cache (the one target, as the test names it). Only `decompose` jobs are claimed, so
another suite's rows left in the throwaway database are never run.

Environment: E2E_DATABASE_URL, E2E_BRIDGE_URL, E2E_BRIDGE_KEY, E2E_OBJECTS (a JSON list of
{bucket, key, path}) and E2E_TARGET ({id, sinkId}).
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import psycopg

from ingest_worker.bridge.client import HttpBridgeClient
from ingest_worker.decompose.items import PgItemStore
from ingest_worker.decompose.job import DecompositionStores
from ingest_worker.decompose.register import PgRegisterStore
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.publish_targets import Target, TargetMissing
from ingest_worker.queue import CLAIM_SQL, ClaimedJob, PgJobQueue
from ingest_worker.storage import MemoryObjectStore

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

    def rdf(self) -> Target | None:
        return None


def main() -> None:
    logging.basicConfig(level=logging.WARNING)
    database_url = os.environ["E2E_DATABASE_URL"]
    target = json.loads(os.environ["E2E_TARGET"])
    store = MemoryObjectStore()
    for o in json.loads(Path(os.environ["E2E_OBJECTS"]).read_text(encoding="utf-8")):
        store.put(o["bucket"], o["key"], Path(o["path"]).read_bytes(), "application/octet-stream")
    queue = DecomposeQueue(database_url)
    with psycopg.connect(database_url, autocommit=True) as items_conn:
        deps = PipelineDeps(
            store=store,
            specs=None,  # type: ignore[arg-type]
            models=None,  # type: ignore[arg-type]
            extract_text=lambda _pdf: [],
            buckets=Buckets("inbox", "outputs", "runs"),
            targets=OneTarget(target["id"], target["sinkId"]),
            bridge=HttpBridgeClient(os.environ["E2E_BRIDGE_URL"], os.environ["E2E_BRIDGE_KEY"]),
            decomposition=DecompositionStores(
                register=PgRegisterStore.for_url(database_url),
                items=PgItemStore(items_conn),
            ),
        )
        while run_once(queue, deps, "conversion-e2e"):
            pass


if __name__ == "__main__":
    main()
