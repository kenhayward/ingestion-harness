"""The `decompose` job (phase 3): an uploaded Word file decomposed, its report written beside it,
delivered through the register, and the item's outcome recorded."""

from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any

import pytest

import ingest_worker.decompose as decompose_module
from ingest_worker.bridge.client import BridgeRefused
from ingest_worker.bridge.models import (
    ActingUser,
    ComponentVersion,
    CreateDeliveriesRequest,
    CreateDeliveriesResult,
    DeliveryRef,
    DocumentReceipt,
    ReadBack,
    Receipt,
    decomposition_idempotency_key,
)
from ingest_worker.decompose import DECOMPOSER_VERSION, DecompositionFailed
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
from tests.decompose.test_deliver import REFUSAL, FakeBridge, report_docx
from tests.fakes import FakeQueue

AT = datetime(2026, 10, 25, 9, 0, tzinfo=UTC)
TARGET = "manuals"
USER = ActingUser(id="u1", name="Operator", email=None)
BATCH_A = "00000000-0000-4000-8000-00000000000a"
BATCH_B = "00000000-0000-4000-8000-00000000000b"
BATCH_C = "00000000-0000-4000-8000-00000000000c"
BATCH_D = "00000000-0000-4000-8000-00000000000d"
#: The register action that detached an entry (the API's `register_actions` row).
DETACH_ACTION = "00000000-0000-4000-8000-0000000000de"


class World:
    """The runs bucket, the items, the register, the bridge and the queue one worker shares."""

    def __init__(self, bridge: Any = None) -> None:
        self.store = MemoryObjectStore()
        self.items = MemoryItemStore(clock=lambda: AT)
        self.register = MemoryRegisterStore(clock=lambda: AT)
        self.bridge = bridge if bridge is not None else FakeBridge()
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

    def rerun(self, job: ClaimedJob, *, batch: str) -> ClaimedJob:
        """A force-load of `job`'s item, as the API's row action writes it: a new single-item
        batch, forced, whose item reuses the stored source object under the same source key."""
        original = self.item(job)
        self._n += 1
        item_id = f"00000000-0000-4000-8000-{self._n:012d}"
        self.items.add(
            ConversionItem(item_id, batch, original.source_key, original.object_key, "queued")
        )
        assert job.params is not None
        rerun = replace(
            job,
            id=f"job-{self._n}",
            params={**job.params, "batchId": batch, "itemId": item_id, "force": True},
        )
        self.queue.uploaders[rerun.id] = USER
        return rerun

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


def test_an_item_records_when_it_started_and_finished() -> None:
    """How long a document took (the Conversion tab's row): started when it goes to
    `decomposing`, finished at a final outcome the worker decides; `delivering` is not final
    (the API's settle finishes it)."""
    clock = iter([AT, AT.replace(minute=1), AT.replace(minute=2)])
    items = MemoryItemStore(clock=lambda: next(clock))
    items.add(ConversionItem("i1", BATCH_A, "r1.docx", "k1", "queued"))
    items.add(ConversionItem("i2", BATCH_A, "r2.docx", "k2", "queued"))

    items.start("i1")
    items.start("i1")  # a retry keeps the first start
    assert (items.items["i1"].started_at, items.items["i1"].finished_at) == (AT, None)
    assert items.decide("i1", "delivering", "a new source", None)
    assert items.items["i1"].finished_at is None

    items.start("i2")
    assert items.decide("i2", "duplicate", "the same content as a.docx", None)
    assert items.items["i2"].started_at == AT.replace(minute=1)
    assert items.items["i2"].finished_at == AT.replace(minute=2)


def test_a_decided_job_finishes_its_item_and_a_delivery_does_not() -> None:
    world = World()
    data = report_docx()
    first = world.upload(data, "r1.docx")
    run_decompose(first, world.deps())
    item = world.item(first)
    assert item.started_at == AT and item.finished_at is None
    [entry] = world.register.entries()
    world.register.settle(entry.id, state="delivered", persistent_id="DOC-1")

    again = world.upload(data, "r1.docx", batch=BATCH_B)
    run_decompose(again, world.deps())
    item = world.item(again)
    assert item.outcome == "already_loaded"
    assert (item.started_at, item.finished_at) == (AT, AT)


def test_a_create_again_under_the_earlier_key_says_so_plainly() -> None:
    """The earlier delivery failed without a document (the sink's 413, say): the same file is
    sent again under its key, and the row's detail says why that is safe."""
    world = World()
    data = report_docx()
    run_decompose(world.upload(data, "r1.docx"), world.deps())
    [entry] = world.register.entries()
    sink_failed = {"class": "permanent", "code": "sink_failed", "message": "too large"}
    world.register.settle(entry.id, state="failed", last_error=sink_failed)

    again = world.upload(data, "r1.docx", batch=BATCH_B)
    assert isinstance(run_decompose(again, world.deps()), Delivering)

    assert world.item(again).detail == (
        "sent again with the same key as the earlier attempt, so the target can't create it twice"
    )


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


COMPONENTS = [
    ComponentVersion(kind="map", id="DOC-1/map", version="1", element=None),
    ComponentVersion(kind="section", id="DOC-1/section/s1", version="1", element="s1"),
]


def _delivered(world: World, job: ClaimedJob) -> str:
    """The job's delivery settled as document DOC-1, as the API does from the bridge's event."""
    run_decompose(job, world.deps())
    entry = next(e for e in world.register.entries() if e.source_key == world.item(job).source_key)
    receipt = Receipt(
        written=[],
        document=DocumentReceipt(
            persistent_id="DOC-1",
            components=COMPONENTS,
            read_back=ReadBack(ok=True, at=None, detail=None),
        ),
    )
    world.register.settle(entry.id, state="delivered", persistent_id="DOC-1", last_receipt=receipt)
    return entry.id


def test_force_load_turns_already_loaded_into_an_update() -> None:
    """The row action's batch reuses the stored source: the same bytes, now an update."""
    world = World()
    first = world.upload(report_docx(), "r1.docx")
    entry_id = _delivered(world, first)

    forced = world.rerun(first, batch=BATCH_B)
    outcome = run_decompose(forced, world.deps())

    assert outcome == Delivering([], [(TARGET, "d2")], note="handed r1.docx to the bridge")
    item = world.item(forced)
    assert (item.outcome, item.register_entry_id) == ("delivering", entry_id)
    request = world.bridge.requests[1]
    assert request.update is not None
    assert (request.update.persistent_id, request.update.expected) == ("DOC-1", COMPONENTS)
    assert request.package.idempotency_key != world.bridge.requests[0].package.idempotency_key


def test_force_load_turns_a_duplicate_into_a_create() -> None:
    world = World()
    data = report_docx()
    _delivered(world, world.upload(data, "reports/r1.docx"))
    copy = world.upload(data, "copies/r1-copy.docx")
    run_decompose(copy, world.deps())
    assert world.item(copy).outcome == "duplicate"

    forced = world.rerun(copy, batch=BATCH_B)
    outcome = run_decompose(forced, world.deps())

    assert isinstance(outcome, Delivering)
    request = world.bridge.requests[-1]
    assert request.update is None  # a deliberate second document
    entry = next(e for e in world.register.entries() if e.source_key == "copies/r1-copy.docx")
    assert (entry.state, entry.persistent_id) == ("pending", None)
    assert world.item(forced).register_entry_id == entry.id


class DocumentSink:
    """A bridge in front of a document target that behaves like the bridge's fake document sink
    (apps/bridge/src/sinks/fake-documents.ts): idempotent by key (a replayed key answers with
    its first write's receipt), a conditional update refused when any component changed, and
    `edit` for a change made in the target. `settle` is the API applying the delivery's final
    event to the register."""

    def __init__(self) -> None:
        self.requests: list[CreateDeliveriesRequest] = []
        self.documents: dict[str, dict[str, int]] = {}
        self._replies: dict[str, Receipt] = {}
        self._results: dict[str, Receipt | dict[str, Any]] = {}
        #: The next request is refused outright (BridgeRefused): nothing reaches the target.
        self.refuse_next = False

    def deliver(self, request: CreateDeliveriesRequest) -> CreateDeliveriesResult:
        self.requests.append(request)
        if self.refuse_next:
            self.refuse_next = False
            raise BridgeRefused(REFUSAL)
        delivery_id = f"d{len(self.requests)}"
        self._results[delivery_id] = self._write(request)
        return CreateDeliveriesResult(
            package_id=f"p{len(self.requests)}",
            deliveries=[DeliveryRef(target_id=t, delivery_id=delivery_id) for t in request.targets],
        )

    def _write(self, request: CreateDeliveriesRequest) -> Receipt | dict[str, Any]:
        key = request.package.idempotency_key
        if key in self._replies:
            return self._replies[key]
        if request.update is not None:
            pid = request.update.persistent_id
            stored = self.documents[pid]
            expected = {c.id: c.version for c in request.update.expected}
            changed = [
                {"id": cid, "expected": expected.get(cid, "none"), "actual": str(v)}
                for cid, v in stored.items()
                if expected.get(cid) != str(v)
            ]
            if changed:
                return {
                    "class": "needs_user",
                    "code": "changed_in_target",
                    "message": f"{len(changed)} component(s) of {pid} changed in the target",
                    "details": {"changed": changed},
                }
            for cid in stored:
                stored[cid] += 1
        else:
            pid = f"doc-{len(self.documents) + 1}"
            self.documents[pid] = {f"{pid}/map": 1, f"{pid}/section/s1": 1}
        receipt = Receipt(
            written=[],
            document=DocumentReceipt(
                persistent_id=pid,
                components=[
                    ComponentVersion(kind="section", id=cid, version=str(v), element=None)
                    for cid, v in self.documents[pid].items()
                ],
                read_back=ReadBack(ok=True, at=None, detail=None),
            ),
        )
        self._replies[key] = receipt
        return receipt

    def edit(self, pid: str, component_id: str) -> None:
        self.documents[pid][component_id] += 1

    def settle(self, register: MemoryRegisterStore, delivery_id: str) -> None:
        entry = next(e for e in register.entries() if e.delivery_id == delivery_id)
        result = self._results[delivery_id]
        if isinstance(result, Receipt):
            assert result.document is not None
            register.settle(
                entry.id,
                state="delivered",
                persistent_id=result.document.persistent_id,
                last_receipt=result,
            )
        else:
            register.settle(entry.id, state="changed", last_error=result)

    def read_object(self, target_id: str, bucket: str, key: str) -> bytes | None:
        raise NotImplementedError

    def put_object(
        self, target_id: str, bucket: str, key: str, body: bytes, content_type: str
    ) -> None:
        raise NotImplementedError

    def delete_objects(self, target_id: str, objects: list[tuple[str, str]]) -> int:
        raise NotImplementedError


def _run(world: World, sink: DocumentSink, job: ClaimedJob) -> str:
    """The job's run, its delivery settled from the sink's answer; the delivery id."""
    outcome = run_decompose(job, world.deps())
    assert isinstance(outcome, Delivering)
    [(_, delivery_id)] = outcome.deliveries
    sink.settle(world.register, delivery_id)
    return delivery_id


def test_the_next_run_after_detach_creates_a_new_document() -> None:
    """Detach (the API's row action) leaves a tombstone; the identical file run again is a
    create under a new key, so the target can't answer with the detached document (spec §8)."""
    sink = DocumentSink()
    world = World(bridge=sink)
    data = report_docx()
    _run(world, sink, world.upload(data, "r1.docx"))
    [first] = world.register.entries()
    assert first.persistent_id == "doc-1"
    world.register.detach(first.id, action_id=DETACH_ACTION)

    again = world.upload(data, "r1.docx", batch=BATCH_B)
    _run(world, sink, again)

    create = sink.requests[-1]
    assert create.update is None
    assert create.package.idempotency_key != sink.requests[0].package.idempotency_key
    assert create.package.idempotency_key == decomposition_idempotency_key(
        first.content_sha256, None, DECOMPOSER_VERSION, DETACH_ACTION
    )
    # The tombstone was replaced by a new entry, for a new document.
    [entry] = world.register.entries()
    assert entry.id != first.id
    assert (entry.state, entry.persistent_id, entry.detach_action_id) == (
        "delivered",
        "doc-2",
        DETACH_ACTION,
    )
    assert world.item(again).register_entry_id == entry.id


def test_a_refused_create_after_detach_keeps_the_detach_token() -> None:
    """The first create after a detach is refused outright, so its entry has no document; the
    rerun of the identical file is created again under a new key, which must still carry the
    detach, or the target would answer with the detached document."""
    sink = DocumentSink()
    world = World(bridge=sink)
    data = report_docx()
    _run(world, sink, world.upload(data, "r1.docx"))
    [first] = world.register.entries()
    world.register.detach(first.id, action_id=DETACH_ACTION)
    sink.refuse_next = True
    refused = world.upload(data, "r1.docx", batch=BATCH_B)
    assert isinstance(run_decompose(refused, world.deps()), Complete)
    [failed] = world.register.entries()
    assert (failed.state, failed.persistent_id, failed.detach_action_id) == (
        "failed",
        None,
        DETACH_ACTION,
    )

    _run(world, sink, world.upload(data, "r1.docx", batch=BATCH_C))

    keys = [r.package.idempotency_key for r in sink.requests]
    assert keys[-1] != keys[0]
    [entry] = world.register.entries()
    assert (entry.state, entry.persistent_id) == ("delivered", "doc-2")


def test_a_detached_entry_is_absent_from_both_checks() -> None:
    """The same bytes under another source key are no duplicate of a detached document."""
    world = World()
    data = report_docx()
    entry_id = _delivered(world, world.upload(data, "r1.docx"))
    world.register.detach(entry_id, action_id=DETACH_ACTION)

    copy = world.upload(data, "copies/r1.docx", batch=BATCH_B)
    outcome = run_decompose(copy, world.deps())

    assert isinstance(outcome, Delivering)
    assert world.bridge.requests[-1].update is None
    # A file never detached keeps the content's own key ("same file, same result").
    assert world.bridge.requests[-1].package.idempotency_key == decomposition_idempotency_key(
        world.bridge.requests[0].package.provenance.source_sha256,  # type: ignore[union-attr]
        None,
        DECOMPOSER_VERSION,
        None,
    )


def test_an_accept_makes_the_next_run_of_the_same_file_an_update() -> None:
    """After the target's state is accepted, the file that was refused is run again: an update
    against the accepted versions, never already loaded, and it goes through."""
    sink = DocumentSink()
    world = World(bridge=sink)
    _run(world, sink, world.upload(report_docx("One"), "r1.docx"))
    sink.edit("doc-1", "doc-1/section/s1")
    edited = report_docx("Two")
    refused = _run(world, sink, world.upload(edited, "r1.docx", batch=BATCH_B))
    [entry] = world.register.entries()
    assert (entry.state, entry.delivery_id) == ("changed", refused)
    world.register.accept(entry.id)  # the API's accept, from the refusal's details

    again = world.upload(edited, "r1.docx", batch=BATCH_C)
    _run(world, sink, again)

    update = sink.requests[-1]
    assert update.update is not None and update.update.persistent_id == "doc-1"
    assert {c.id: c.version for c in update.update.expected} == {
        "doc-1/map": "1",
        "doc-1/section/s1": "2",
    }
    [after] = world.register.entries()
    assert after.state == "delivered"
    assert after.last_receipt is not None and after.last_receipt.document is not None
    assert {c.id: c.version for c in after.last_receipt.document.components} == {
        "doc-1/map": "2",
        "doc-1/section/s1": "3",
    }


def _versions(world: World) -> dict[str, str]:
    [entry] = world.register.entries()
    assert entry.last_receipt is not None and entry.last_receipt.document is not None
    return {c.id: c.version for c in entry.last_receipt.document.components}


def test_a_then_b_then_a_again_is_three_writes() -> None:
    """Updating with A over B is a different write from A's first update of the document: its
    key takes the versions it expects, so the target can't answer it with A's first receipt
    (which would write nothing and leave the register with stale versions)."""
    sink = DocumentSink()
    world = World(bridge=sink)
    a, b = report_docx("One"), report_docx("Two")
    _run(world, sink, world.upload(report_docx("Draft"), "r1.docx"))  # creates doc-1
    _run(world, sink, world.upload(a, "r1.docx", batch=BATCH_B))
    _run(world, sink, world.upload(b, "r1.docx", batch=BATCH_C))
    assert _versions(world) == {"doc-1/map": "3", "doc-1/section/s1": "3"}

    _run(world, sink, world.upload(a, "r1.docx", batch=BATCH_D))

    updates = sink.requests[1:]
    keys = [r.package.idempotency_key for r in updates]
    assert all(r.update is not None for r in updates) and len(set(keys)) == 3
    # A new write: the target holds a fourth version, and the register knows it.
    assert sink.documents["doc-1"] == {"doc-1/map": 4, "doc-1/section/s1": 4}
    assert _versions(world) == {"doc-1/map": "4", "doc-1/section/s1": "4"}
    assert keys[-1] == decomposition_idempotency_key(
        hashlib.sha256(a).hexdigest(),
        "doc-1",
        DECOMPOSER_VERSION,
        hashlib.sha256(b"doc-1/map@3\ndoc-1/section/s1@3").hexdigest(),
    )


def test_the_same_update_retried_replays() -> None:
    """A retry of the same update (the register as it was, the same file) has the same key, so
    the target answers it with the first write's receipt and writes nothing more."""
    sink = DocumentSink()
    world = World(bridge=sink)
    _run(world, sink, world.upload(report_docx("One"), "r1.docx"))
    with world.register.transaction() as tx:
        before = dict(tx.rows)  # type: ignore[attr-defined]
    edited = report_docx("Two")
    _run(world, sink, world.upload(edited, "r1.docx", batch=BATCH_B))
    written = dict(sink.documents["doc-1"])
    # As if the register never heard of that update (its answer lost), it is made again.
    with world.register.transaction() as tx:
        tx.rows.clear()  # type: ignore[attr-defined]
        tx.rows.update(before)  # type: ignore[attr-defined]

    _run(world, sink, world.upload(edited, "r1.docx", batch=BATCH_C))

    first, retry = sink.requests[1:]
    assert retry.package.idempotency_key == first.package.idempotency_key
    assert sink.documents["doc-1"] == written  # replayed: nothing more written
    assert _versions(world) == {"doc-1/map": "2", "doc-1/section/s1": "2"}


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


def test_a_retried_delivering_item_settled_meanwhile_ends_the_job() -> None:
    """A retry of an item already `delivering`, whose event settles it between the retry's
    `start` and its `delivering` write: nothing is left to wait for."""

    class SettledMeanwhile(MemoryItemStore):
        def decide(
            self, item_id: str, outcome: ItemOutcome, detail: str, entry_id: str | None
        ) -> bool:
            if outcome == "delivering":
                self.items[item_id] = replace(self.items[item_id], outcome="created")
            return super().decide(item_id, outcome, detail, entry_id)

    world = World()
    job = world.upload(report_docx(), "r1.docx")
    run_decompose(job, world.deps())
    assert world.item(job).outcome == "delivering"
    settled = SettledMeanwhile()
    settled.items = dict(world.items.items)
    world.items = settled

    outcome = run_decompose(job, world.deps())

    assert isinstance(outcome, Complete)
    assert world.item(job).outcome == "created"
    assert len(world.bridge.requests) == 1


def test_an_outcome_not_recorded_is_not_reported_as_the_items() -> None:
    """Invalid params on a retry of an item already `delivering`: the item is left as it is, and
    the job's events don't claim it failed."""
    world = World()
    job = world.upload(report_docx(), "r1.docx")
    run_decompose(job, world.deps())
    assert job.params is not None
    broken = replace(job, params={**job.params, "force": "sometimes"})

    outcome = run_decompose(broken, world.deps())

    assert isinstance(outcome, Complete)
    assert world.item(job).outcome == "delivering"
    assert not [m for m in world.messages(broken) if m.startswith("failed")]
    assert not [level for job_id, level, _ in world.queue.events if level == "warn"]


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
    items.set_report("nope", "k", 0)
    assert items.decide("nope", "failed", "x", None) is False


def test_the_memory_store_holds_an_undecided_item_for_review() -> None:
    items = MemoryItemStore(clock=lambda: AT)
    items.add(ConversionItem("i1", "b1", "a.pdf", "k", "queued"))
    items.add(ConversionItem("i2", "b1", "b.pdf", "k", "created"))
    items.start("i1")

    assert items.hold("i1", "f" * 64, {"id": "e1"})
    held = items.items["i1"]
    assert (held.outcome, held.held_sha256, held.held_entry) == (
        "awaiting_review",
        "f" * 64,
        {"id": "e1"},
    )
    assert held.finished_at is None  # waiting for a decision, not finished
    assert not items.hold("i1", "f" * 64, None)  # held already: only an undecided item is held
    assert not items.hold("i2", "f" * 64, None)  # settled already
    assert not items.hold("nope", "f" * 64, None)
    assert items.items["i2"].outcome == "created"


def test_the_memory_store_records_the_flag_count_with_the_report() -> None:
    items = MemoryItemStore()
    items.add(ConversionItem("i1", "b1", "a.docx", "k", "queued"))
    items.set_report("i1", "decompositions/b1/i1.report.json", 3)
    assert items.items["i1"].flag_count == 3
    assert items.items["i1"].report_key == "decompositions/b1/i1.report.json"


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
    assert item.flag_count == len(flags)


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
