"""Conversion items' outcomes as the worker writes them (decompose/items.py), and the
`decompose` job's params (decompose/job.py): the `waiting_to_deliver` outcome of tenant lanes."""

from __future__ import annotations

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
