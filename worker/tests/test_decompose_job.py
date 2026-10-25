"""The `decompose` job (phase 3): an uploaded Word file decomposed, its report written beside it,
delivered through the register, and the item's outcome recorded."""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

import pytest

import ingest_worker.decompose as decompose_module
from ingest_worker.bridge.models import ActingUser
from ingest_worker.decompose import DecompositionFailed
from ingest_worker.decompose.deliver import DeliverDeps
from ingest_worker.decompose.items import ConversionItem, ItemOutcome, MemoryItemStore
from ingest_worker.decompose.job import DecomposeDeps, DecompositionStores, run_decompose
from ingest_worker.decompose.register import MemoryRegisterStore
from ingest_worker.errors import DocumentError
from ingest_worker.main import TASKS
from ingest_worker.outcomes import Complete, Delivering
from ingest_worker.pipeline import Buckets, JobCancelled, PipelineDeps
from ingest_worker.publish_targets import Target, TargetNotSynced
from ingest_worker.queue import ClaimedJob
from ingest_worker.storage import (
    MemoryObjectStore,
    decomposition_report_key,
    decomposition_source_key,
)
from tests.decompose.fakes import FakeRenderer
from tests.decompose.test_deliver import FakeBridge, report_docx
from tests.fakes import FakeQueue

AT = datetime(2026, 10, 25, 9, 0, tzinfo=UTC)
TARGET = "manuals"
USER = ActingUser(id="u1", name="Operator", email=None)
BATCH_A = "00000000-0000-4000-8000-00000000000a"
BATCH_B = "00000000-0000-4000-8000-00000000000b"


class World:
    """The runs bucket, the items, the register, the bridge and the queue one worker shares."""

    def __init__(self) -> None:
        self.store = MemoryObjectStore()
        self.items = MemoryItemStore()
        self.register = MemoryRegisterStore(clock=lambda: AT)
        self.bridge = FakeBridge()
        self.queue = FakeQueue()
        self.renderer = FakeRenderer()
        self._n = 0

    def deps(self) -> DecomposeDeps:
        return DecomposeDeps(
            store=self.store,
            runs_bucket="runs",
            items=self.items,
            queue=self.queue,
            deliver=DeliverDeps(
                renderer=self.renderer,
                register=self.register,
                bridge=self.bridge,
                target_lookup=lambda target_id: ("documents", "tenant-1"),
                clock=lambda: AT,
                deployment="test",
            ),
        )

    def upload(
        self, data: bytes, source_key: str, *, batch: str = BATCH_A, force: bool = False
    ) -> ClaimedJob:
        """An item uploaded to `batch` and its queued job, as the API's start writes them."""
        self._n += 1
        item_id = f"00000000-0000-4000-8000-{self._n:012d}"
        key = decomposition_source_key(batch, item_id, "docx")
        self.store.put("runs", key, data, "application/octet-stream")
        self.items.add(ConversionItem(item_id, batch, source_key, key, "queued"))
        job = ClaimedJob(
            id=f"job-{self._n}",
            document_id="",
            spec_id="",
            spec_version=0,
            bucket="",
            object_key="",
            model_override=None,
            attempts=1,
            max_attempts=3,
            task="decompose",
            params={
                "batchId": batch,
                "itemId": item_id,
                "targetId": TARGET,
                "sourceKey": source_key,
                "force": force,
            },
        )
        self.queue.uploaders[job.id] = USER
        return job

    def item(self, job: ClaimedJob) -> ConversionItem:
        assert job.params is not None
        return self.items.items[job.params["itemId"]]

    def messages(self, job: ClaimedJob) -> list[str]:
        return [message for job_id, _level, message in self.queue.events if job_id == job.id]


def test_decomposes_and_delivers_a_new_file_as_delivering() -> None:
    world = World()
    job = world.upload(report_docx(), "reports/r1.docx")

    outcome = run_decompose(job, world.deps())

    assert outcome == Delivering([], [(TARGET, "d1")], note="handed reports/r1.docx to the bridge")
    item = world.item(job)
    [entry] = world.register.entries()
    assert (item.outcome, item.register_entry_id) == ("delivering", entry.id)
    assert (entry.state, entry.delivery_id, entry.batch_id) == ("pending", "d1", BATCH_A)
    [request] = world.bridge.requests
    assert request.acting_user == USER and request.update is None
    assert request.package.provenance.source_key == "reports/r1.docx"  # type: ignore[union-attr]
    # The live view moves through each stage.
    assert world.messages(job) == ["decomposing", "decomposed", "report written", "delivering"]


def test_the_file_is_decomposed_once(monkeypatch: pytest.MonkeyPatch) -> None:
    """The delivery takes the job's decomposition rather than rendering everything again."""
    import ingest_worker.decompose.deliver as deliver_module
    import ingest_worker.decompose.job as job_module

    calls: list[bytes] = []
    real = decompose_module.decompose_docx

    def counted(data: bytes, *, renderer: Any) -> Any:
        calls.append(data)
        return real(data, renderer=renderer)

    monkeypatch.setattr(job_module, "decompose_docx", counted)
    monkeypatch.setattr(deliver_module, "decompose_docx", counted)
    world = World()

    run_decompose(world.upload(report_docx(), "r1.docx"), world.deps())

    assert len(calls) == 1 and len(world.bridge.requests) == 1


def test_a_repeat_is_already_loaded() -> None:
    world = World()
    data = report_docx()
    first = world.upload(data, "r1.docx")
    run_decompose(first, world.deps())
    [entry] = world.register.entries()
    world.register.settle(entry.id, state="delivered", persistent_id="DOC-1")

    again = world.upload(data, "r1.docx", batch=BATCH_B)
    outcome = run_decompose(again, world.deps())

    assert isinstance(outcome, Complete)
    item = world.item(again)
    assert (item.outcome, item.register_entry_id) == ("already_loaded", entry.id)
    assert item.detail is not None and "DOC-1" in item.detail
    assert len(world.bridge.requests) == 1
    # The job's last event names the outcome.
    assert world.messages(again)[-1] == "already loaded: already loaded as DOC-1"


def test_same_bytes_under_another_key_is_duplicate_naming_the_first() -> None:
    world = World()
    data = report_docx()
    first = world.upload(data, "reports/r1.docx")
    run_decompose(first, world.deps())
    [entry] = world.register.entries()
    world.register.settle(entry.id, state="delivered", persistent_id="DOC-1")

    copy = world.upload(data, "copies/r1-copy.docx")
    outcome = run_decompose(copy, world.deps())

    assert isinstance(outcome, Complete)
    item = world.item(copy)
    assert item.outcome == "duplicate"
    assert item.detail is not None
    assert "DOC-1" in item.detail and "reports/r1.docx" in item.detail
    # The item is not linked to the other source's entry.
    assert item.register_entry_id is None
    assert len(world.bridge.requests) == 1
    assert world.messages(copy)[-1] == f"duplicate: {item.detail}"


def test_a_fidelity_failure_fails_the_item_with_the_check(monkeypatch: pytest.MonkeyPatch) -> None:
    def text_differs(*_args: Any) -> None:
        raise DecompositionFailed("text differs at unit 4: 'Three.'", "sec-beta")

    monkeypatch.setattr(decompose_module, "check", text_differs)
    world = World()
    job = world.upload(report_docx(), "r1.docx")

    outcome = run_decompose(job, world.deps())

    assert isinstance(outcome, Complete)  # an outcome was decided: the job succeeds (R3)
    item = world.item(job)
    assert item.outcome == "failed"
    assert item.detail == "decomposition failed at sec-beta: text differs at unit 4: 'Three.'"
    assert item.report_key is None
    assert world.bridge.requests == [] and world.register.entries() == []
    assert world.messages(job) == ["decomposing", f"failed: {item.detail}"]


def test_an_unreadable_file_fails_its_own_item() -> None:
    world = World()
    job = world.upload(b"not a word file", "broken.docx")

    run_decompose(job, world.deps())

    item = world.item(job)
    assert item.outcome == "failed" and item.detail is not None
    assert item.detail.startswith("rejected: ")


def test_a_second_batch_for_a_pending_entry_reports_in_flight() -> None:
    world = World()
    data = report_docx()
    first = world.upload(data, "r1.docx", batch=BATCH_A)
    second = world.upload(report_docx("Edited"), "r1.docx", batch=BATCH_B)

    run_decompose(first, world.deps())
    outcome = run_decompose(second, world.deps())

    assert isinstance(outcome, Complete)
    [entry] = world.register.entries()
    item = world.item(second)
    assert (item.outcome, item.register_entry_id) == ("in_flight", entry.id)
    # Never a second create: the bridge was called once.
    assert len(world.bridge.requests) == 1
    assert world.item(first).outcome == "delivering"


def test_a_retry_after_the_hand_off_resumes_its_own_delivery() -> None:
    """The worker stopped after the bridge took the document but before it recorded the item
    (a redeploy): the retry finds its own pending delivery, not another batch's."""
    world = World()
    job = world.upload(report_docx(), "r1.docx")
    run_decompose(job, world.deps())
    [entry] = world.register.entries()
    # As if that run's item write were lost.
    item = world.item(job)
    world.items.items[item.id] = ConversionItem(
        item.id, item.batch_id, item.source_key, item.object_key, "decomposing"
    )

    outcome = run_decompose(job, world.deps())

    assert outcome == Delivering([], [(TARGET, "d1")], note="handed r1.docx to the bridge")
    assert (world.item(job).outcome, world.item(job).register_entry_id) == (
        "delivering",
        entry.id,
    )
    assert len(world.bridge.requests) == 1


def test_a_crash_before_the_delivery_was_recorded_resumes_it_under_its_key() -> None:
    """The worker stopped after the bridge accepted the document but before `set_delivery`
    committed: the entry is this batch's own, pending, with no delivery. The retry hands it to
    the bridge again under the entry's stored key (the sink answers with the same document),
    and never reports its own delivery as in flight."""
    world = World()
    job = world.upload(report_docx(), "r1.docx")
    run_decompose(job, world.deps())
    [entry] = world.register.entries()
    with world.register.transaction() as tx:
        tx.rows[entry.id] = replace(entry, delivery_id=None)  # type: ignore[attr-defined]
    item = world.item(job)
    world.items.items[item.id] = replace(item, outcome="decomposing", register_entry_id=None)

    outcome = run_decompose(job, world.deps())

    assert outcome == Delivering([], [(TARGET, "d2")], note="handed r1.docx to the bridge")
    first, second = world.bridge.requests
    assert second.package.idempotency_key == first.package.idempotency_key
    assert (world.item(job).outcome, world.item(job).register_entry_id) == (
        "delivering",
        entry.id,
    )
    [resumed] = world.register.entries()
    assert (resumed.state, resumed.delivery_id) == ("pending", "d2")


def test_a_retry_of_an_item_already_delivering_waits_for_its_delivery() -> None:
    """The worker recorded the item delivering, then stopped before the job did: the retry
    waits for that delivery rather than finishing the job before any outcome exists."""
    world = World()
    job = world.upload(report_docx(), "r1.docx")
    run_decompose(job, world.deps())

    outcome = run_decompose(job, world.deps())

    assert outcome == Delivering([], [(TARGET, "d1")], note="handed r1.docx to the bridge")
    assert world.item(job).outcome == "delivering"
    assert len(world.bridge.requests) == 1


def test_an_item_settled_before_the_worker_records_it_ends_the_job() -> None:
    """The bridge's event settled the item before the worker's `delivering` write: the job has
    nothing left to wait for."""

    class SettledFirst(MemoryItemStore):
        def decide(
            self, item_id: str, outcome: ItemOutcome, detail: str, entry_id: str | None
        ) -> bool:
            if outcome == "delivering":
                self.items[item_id] = replace(self.items[item_id], outcome="created")
            return super().decide(item_id, outcome, detail, entry_id)

    world = World()
    world.items = SettledFirst()
    job = world.upload(report_docx(), "r1.docx")

    outcome = run_decompose(job, world.deps())

    assert isinstance(outcome, Complete)
    assert world.item(job).outcome == "created"


def test_invalid_params_fail_the_item_with_the_reason() -> None:
    world = World()
    job = world.upload(report_docx(), "r1.docx")
    assert job.params is not None
    broken = replace(job, params={**job.params, "force": "sometimes"})

    outcome = run_decompose(broken, world.deps())

    assert isinstance(outcome, Complete)
    item = world.item(job)
    assert item.outcome == "failed"
    assert item.detail is not None and item.detail.startswith("invalid decompose parameters")
    assert world.bridge.requests == []


def test_params_too_broken_to_find_the_item_go_to_review() -> None:
    world = World()
    job = replace(world.upload(report_docx(), "r1.docx"), params={"itemId": 7})

    with pytest.raises(DocumentError):
        run_decompose(job, world.deps())


def test_a_source_key_unlike_the_items_fails_the_item() -> None:
    world = World()
    job = world.upload(report_docx(), "r1.docx")
    assert job.params is not None
    other = replace(job, params={**job.params, "sourceKey": "elsewhere.docx"})

    outcome = run_decompose(other, world.deps())

    assert isinstance(outcome, Complete)
    item = world.item(job)
    assert item.outcome == "failed" and item.detail is not None
    assert "elsewhere.docx" in item.detail and "r1.docx" in item.detail
    assert world.bridge.requests == []


def test_the_memory_store_ignores_a_missing_item_like_postgres() -> None:
    items = MemoryItemStore()
    items.set_report("nope", "k")
    assert items.decide("nope", "failed", "x", None) is False


def test_writes_the_report_beside_the_source() -> None:
    world = World()
    job = world.upload(report_docx(), "r1.docx")

    run_decompose(job, world.deps())

    item = world.item(job)
    key = decomposition_report_key(item.batch_id, item.id)
    assert item.report_key == key
    report = json.loads(world.store.get("runs", key))
    request = world.bridge.requests[0]
    assert request.package.document is not None
    flags = [f.model_dump(mode="json", by_alias=True) for f in request.package.document.report]
    assert report == {"flags": flags}


def test_an_item_already_decided_is_left_alone() -> None:
    world = World()
    job = world.upload(report_docx(), "r1.docx")
    item = world.item(job)
    world.items.items[item.id] = ConversionItem(
        item.id, item.batch_id, item.source_key, item.object_key, "created"
    )

    outcome = run_decompose(job, world.deps())

    assert isinstance(outcome, Complete)
    assert world.item(job).outcome == "created"
    assert world.bridge.requests == []


def test_a_cancelled_job_delivers_nothing_and_fails_its_item() -> None:
    world = World()
    job = world.upload(report_docx(), "r1.docx")
    world.queue.cancel_when = lambda: True

    with pytest.raises(JobCancelled):
        run_decompose(job, world.deps())

    assert world.bridge.requests == []
    assert world.item(job).outcome == "failed"


def test_the_last_attempt_of_an_error_fails_the_item() -> None:
    world = World()
    job = world.upload(report_docx(), "r1.docx")
    world.store.objects.clear()  # the upload is gone
    last = ClaimedJob(**{**job.__dict__, "attempts": 3})

    with pytest.raises(KeyError):
        run_decompose(job, world.deps())
    assert world.item(job).outcome == "decomposing"  # retried: nothing decided yet
    with pytest.raises(KeyError):
        run_decompose(last, world.deps())
    item = world.item(job)
    assert item.outcome == "failed" and item.detail is not None and "not found" in item.detail


def test_a_target_not_synced_yet_decides_nothing_even_on_the_last_attempt() -> None:
    world = World()
    job = ClaimedJob(**{**world.upload(report_docx(), "r1.docx").__dict__, "attempts": 3})

    def not_synced(target_id: str) -> tuple[str, str | None]:
        raise TargetNotSynced(target_id)

    deps = world.deps()
    deps = DecomposeDeps(
        store=deps.store,
        runs_bucket=deps.runs_bucket,
        items=deps.items,
        queue=deps.queue,
        deliver=replace(deps.deliver, target_lookup=not_synced),
    )

    with pytest.raises(TargetNotSynced):
        run_decompose(job, deps)
    assert world.item(job).outcome == "decomposing"


def test_the_task_runs_through_the_worker() -> None:
    world = World()
    job = world.upload(report_docx(), "r1.docx")
    deps = PipelineDeps(
        store=world.store,
        specs=None,  # type: ignore[arg-type]
        models=None,  # type: ignore[arg-type]
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        targets=_Targets(),
        bridge=world.bridge,
        decomposition=DecompositionStores(register=world.register, items=world.items),
    )

    outcome = TASKS["decompose"](job, deps, world.queue)

    assert isinstance(outcome, Delivering) and outcome.deliveries == [(TARGET, "d1")]
    [entry] = world.register.entries()
    assert (entry.sink_id, entry.instance_id) == ("documents", "tenant-1")


class _Targets:
    def get(self, target_id: str) -> Target:
        return Target(target_id, "", layout="sink", sink_id="documents", instance_id="tenant-1")

    def rdf(self) -> Target | None:
        return None
