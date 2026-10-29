"""The lane dispatcher (watched folders plan 2): gives the free lanes of each tenant to its
waiting documents, in turn (lanes.py `dispatch`), and queues a `waited` decompose run for each,
which delivers the stored decomposition (job.py `_from_wait`).

The worker runs it in its loop between jobs, every `LANE_DISPATCH_S`, and right after each
`decompose` job ends (main.py): the periodic round is the backstop for a lane freed by the API's
settle, or between a refusal and its `waiting_to_deliver` write. A worker busy with a long job
(OCR, a recipe) dispatches nothing until it finishes, so with one worker a freed lane may wait
that long; another idle worker dispatches it within `LANE_DISPATCH_S`.

Each round first frees the lanes nothing will release: an item holding one whose job ended
without deciding it (given up while its target never synced, cancelled by a restore, sent to
review) is failed, its stored copy deleted (`JobQueue.lanes_of_ended_jobs`). So is a converting
item with no lane whose job ended a while ago (a Stop now cancelled it). Then an item that
got a lane but no job (the worker stopped in between) is queued again
(`JobQueue.lanes_without_job`); queueing is once per item, so two dispatchers never queue one
item twice.

A tenant's lane count is its targets' (`lanes_for`; the fewest when its waiting items name more
than one target). A target that is gone (`TargetMissing`) fails its waiting items with the
target's message and deletes their stored copies; a target the cache has not synced yet
(`TargetNotSynced`) leaves the tenant for the next round.
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from ingest_worker.decompose.hold import delete_stored
from ingest_worker.decompose.lanes import LaneStore, lanes_for
from ingest_worker.publish_targets import TargetMissing, TargetNotSynced

if TYPE_CHECKING:
    from ingest_worker.decompose.items import ItemStore
    from ingest_worker.pipeline import Targets
    from ingest_worker.queue import EndedLane, JobQueue
    from ingest_worker.storage import ObjectStore

log = logging.getLogger(__name__)

#: How often the worker dispatches lanes, in seconds.
LANE_DISPATCH_S = 5.0


def ended_reason(ended: EndedLane) -> str:
    """Why an item whose job ended undecided failed."""
    if ended.status is None:
        return "its conversion job is gone: the document was not delivered"
    reason = f"its conversion job ended ({ended.status}) before the document was delivered"
    return f"{reason}: {ended.error}" if ended.error else reason


def dispatch_lanes(
    lanes: LaneStore,
    targets: Targets,
    queue: JobQueue,
    items: ItemStore,
    *,
    store: ObjectStore,
    runs_bucket: str,
) -> int:
    """Give free lanes to waiting items, queueing each one's `waited` run; the jobs queued.
    `store` and `runs_bucket` hold the waiting items' stored copies, deleted with a failed
    item."""
    for ended in queue.lanes_of_ended_jobs():
        if items.decide(ended.item_id, "failed", ended_reason(ended), None):
            log.warning("failed conversion item %s: %s", ended.item_id, ended_reason(ended))
            delete_stored(store, runs_bucket, ended.batch_id, ended.item_id)
    queued = 0
    for item_id in queue.lanes_without_job():
        if queue.queue_decompose_waited(item_id) is not None:
            log.warning("re-queued conversion item %s: it had a lane but no job", item_id)
            queued += 1
    for tenant in lanes.waiting_tenants():
        waiting = lanes.waiting_items(tenant)
        counts: list[int] = []
        unsynced = False
        for target_id in dict.fromkeys(target for _, target, _ in waiting):
            try:
                counts.append(lanes_for(targets.get(target_id)))
            except TargetMissing as exc:
                for item_id, of, batch_id in waiting:
                    if of == target_id and items.decide(item_id, "failed", str(exc), None):
                        delete_stored(store, runs_bucket, batch_id, item_id)
            except TargetNotSynced:
                unsynced = True
        if unsynced or not counts:
            continue
        for item_id in lanes.dispatch(tenant, min(counts)):
            if queue.queue_decompose_waited(item_id) is not None:
                queued += 1
    return queued
