"""Conversion items' outcomes as the worker writes them (decompose/items.py), and the
`decompose` job's params (decompose/job.py): the `waiting_to_deliver` outcome of tenant lanes."""

from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

import pytest
from pydantic import ValidationError

from ingest_worker.decompose.items import ConversionItem, ItemOutcome, MemoryItemStore
from ingest_worker.decompose.job import OUTCOME_LABELS, RUNNABLE, DecomposeParams

BATCH = "0f6c1c52-3a54-4c7e-9a43-6a1d1f0e2b11"
ITEM = "9b2e4a7d-5c10-4f2e-8d3a-1e7c5a9b4f20"


def store_with(outcome: ItemOutcome) -> MemoryItemStore:
    store = MemoryItemStore()
    store.add(ConversionItem(ITEM, BATCH, "a.docx", f"decompositions/{BATCH}/{ITEM}.docx", outcome))
    return store


def test_a_decomposed_item_waits_to_deliver_then_delivers() -> None:
    store = store_with("decomposing")
    assert store.decide(ITEM, "waiting_to_deliver", "waiting for a lane", None)
    waiting = store.items[ITEM]
    assert (waiting.outcome, waiting.finished_at) == ("waiting_to_deliver", None)
    assert store.decide(ITEM, "delivering", "handed to the bridge", None)
    assert store.items[ITEM].outcome == "delivering"
    assert store.items[ITEM].finished_at is None


@pytest.mark.parametrize("outcome", ["already_loaded", "failed", "unresolved"])
def test_a_waiting_item_may_be_decided_afresh(outcome: ItemOutcome) -> None:
    store = store_with("waiting_to_deliver")
    assert store.decide(ITEM, outcome, "decided after the wait", None)
    assert store.items[ITEM].outcome == outcome
    assert store.items[ITEM].finished_at is not None


def test_a_settled_item_never_goes_back_to_waiting() -> None:
    store = store_with("created")
    assert not store.decide(ITEM, "waiting_to_deliver", "waiting for a lane", None)
    assert store.items[ITEM].outcome == "created"


def test_a_waiting_item_is_not_decomposed_again_by_start() -> None:
    store = store_with("waiting_to_deliver")
    store.start(ITEM)
    assert store.items[ITEM].outcome == "waiting_to_deliver"


def test_a_waiting_item_is_runnable_and_has_a_label() -> None:
    assert "waiting_to_deliver" in RUNNABLE
    assert OUTCOME_LABELS["waiting_to_deliver"] == "waiting to deliver"


PARAMS = {
    "batchId": BATCH,
    "itemId": ITEM,
    "targetId": "docs",
    "sourceKey": "a.docx",
    "force": False,
}


def test_params_say_whether_the_run_waited_for_a_lane() -> None:
    assert DecomposeParams.model_validate(PARAMS).waited is False
    assert DecomposeParams.model_validate({**PARAMS, "waited": True}).waited is True
    with pytest.raises(ValidationError):
        DecomposeParams.model_validate({**PARAMS, "waited": True, "lane": 1})


def _clocked(outcome: ItemOutcome, *minutes: int) -> MemoryItemStore:
    """A store whose clock reads 09:00 plus each of `minutes` in turn."""
    times = iter(datetime(2026, 10, 30, 9, m, tzinfo=UTC) for m in minutes)
    store = MemoryItemStore(clock=lambda: next(times))
    store.add(ConversionItem(ITEM, BATCH, "a.docx", f"decompositions/{BATCH}/{ITEM}.docx", outcome))
    return store


def test_a_wait_for_a_lane_is_timed_until_the_waited_run_resumes() -> None:
    store = _clocked("queued", 0, 1, 6)
    store.start(ITEM)
    assert store.wait(ITEM, "a" * 64, None)
    assert store.items[ITEM].waiting_since == datetime(2026, 10, 30, 9, 1, tzinfo=UTC)
    store.resume(ITEM)
    item = store.items[ITEM]
    assert (item.waiting_since, item.waited_ms) == (None, 5 * 60_000)
    assert item.outcome == "waiting_to_deliver"  # the run decides it from here


def test_a_hold_is_timed_until_the_approved_run_starts() -> None:
    store = _clocked("queued", 0, 2, 32)
    store.start(ITEM)
    assert store.hold(ITEM, "a" * 64, None)
    assert store.items[ITEM].waiting_since == datetime(2026, 10, 30, 9, 2, tzinfo=UTC)
    # Approving queues the item again (the API's write); its run starts it.
    store.items[ITEM] = replace(store.items[ITEM], outcome="queued")
    store.start(ITEM)
    item = store.items[ITEM]
    assert (item.outcome, item.waiting_since, item.waited_ms) == ("decomposing", None, 30 * 60_000)


def test_waits_add_up_and_resuming_without_a_wait_changes_nothing() -> None:
    store = _clocked("queued", 0, 1, 3, 4, 10)
    store.start(ITEM)
    assert store.hold(ITEM, "a" * 64, None)
    store.items[ITEM] = replace(store.items[ITEM], outcome="queued")
    store.start(ITEM)  # 2 minutes in review
    assert store.wait(ITEM, "b" * 64, None)
    store.resume(ITEM)  # 6 minutes for a lane
    store.resume(ITEM)  # nothing open: no clock read, nothing added
    assert store.items[ITEM].waited_ms == 8 * 60_000


def test_a_waiting_item_started_again_by_a_retry_keeps_waiting() -> None:
    store = _clocked("queued", 0, 1)
    store.start(ITEM)
    assert store.wait(ITEM, "a" * 64, None)
    store.start(ITEM)  # a retry of the first run, which leaves it to the dispatcher
    item = store.items[ITEM]
    assert (item.waiting_since, item.waited_ms) == (datetime(2026, 10, 30, 9, 1, tzinfo=UTC), 0)
