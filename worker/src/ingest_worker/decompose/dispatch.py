"""The lane dispatcher (watched folders plan 2): gives the free lanes of each tenant to its
waiting documents, in turn (lanes.py `dispatch`), and queues a `waited` decompose run for each,
which delivers the stored decomposition (job.py `_from_wait`).

The worker runs it every `LANE_DISPATCH_S` and right after a decompose job ends (main.py): the
periodic round is the backstop for a lane freed by the API's settle, or between a refusal and its
`waiting_to_deliver` write.

A tenant's lane count is its targets' (`lanes_for`; the fewest when its waiting items name more
than one target). A target that is gone (`TargetMissing`) fails its waiting items with the
target's message; a target the cache has not synced yet (`TargetNotSynced`) leaves the tenant
for the next round. An item that got a lane but no job (the worker stopped in between) is queued
again first (`JobQueue.lanes_without_job`); queueing is once per item, so two dispatchers never
queue one item twice.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from ingest_worker.decompose.lanes import LaneStore, lanes_for
from ingest_worker.publish_targets import TargetMissing, TargetNotSynced

if TYPE_CHECKING:
    from ingest_worker.decompose.items import ItemStore
    from ingest_worker.pipeline import Targets
    from ingest_worker.queue import JobQueue

log = logging.getLogger(__name__)

#: How often the worker dispatches lanes, in seconds.
LANE_DISPATCH_S = 5.0


def dispatch_lanes(lanes: LaneStore, targets: Targets, queue: JobQueue, items: ItemStore) -> int:
    """Give free lanes to waiting items, queueing each one's `waited` run; the jobs queued."""
    queued = 0
    for item_id in queue.lanes_without_job():
        if queue.queue_decompose_waited(item_id) is not None:
            log.warning("re-queued conversion item %s: it had a lane but no job", item_id)
            queued += 1
    for tenant in lanes.waiting_tenants():
        waiting = lanes.waiting_items(tenant)
        counts: list[int] = []
        unsynced = False
        for target_id in dict.fromkeys(target for _, target in waiting):
            try:
                counts.append(lanes_for(targets.get(target_id)))
            except TargetMissing as exc:
                for item_id, of in waiting:
                    if of == target_id:
                        items.decide(item_id, "failed", str(exc), None)
            except TargetNotSynced:
                unsynced = True
        if unsynced or not counts:
            continue
        for item_id in lanes.dispatch(tenant, min(counts)):
            if queue.queue_decompose_waited(item_id) is not None:
                queued += 1
    return queued
