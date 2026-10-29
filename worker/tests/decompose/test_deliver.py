"""deliver_decomposition: the register's decision, the version 2 package and its hand-off."""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType
from typing import Any

import pytest

from ingest_worker.bridge.client import BridgeRefused, BridgeUnavailable
from ingest_worker.bridge.models import (
    ActingUser,
    BridgeError,
    ComponentVersion,
    CreateDeliveriesRequest,
    CreateDeliveriesResult,
    DecompositionProvenance,
    DeliveryRef,
    DocumentReceipt,
    ReadBack,
    Receipt,
    decomposition_idempotency_key,
)
from ingest_worker.decompose import DECOMPOSER_VERSION
from ingest_worker.decompose.deliver import DeliverDeps, deliver_decomposition
from ingest_worker.decompose.register import (
    MemoryRegisterStore,
    RegisterEntry,
    RegisterStore,
    RegisterTx,
)
from tests.decompose.docx import build_docx
from tests.decompose.fakes import FakeRenderer
from tests.decompose.pdf.fakes import two_pages
from tests.decompose.test_media import PNG, picture

AT = datetime(2026, 10, 23, 9, 0, tzinfo=UTC)
USER = ActingUser(id="u1", name="Operator", email=None)
TARGET = "docs-target"


def report_docx(title: str = "Results") -> bytes:
    body = (
        f'<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>{title}</w:t></w:r></w:p>'
        "<w:p><w:r><w:t>Some text.</w:t></w:r></w:p>"
        f"<w:p><w:r>{picture('rIdPng', descr='A plot')}</w:r></w:p>"
    )
    return build_docx(
        body, media={"image1.png": PNG}, rels=[("rIdPng", "image", "media/image1.png")]
    )


def test_report_docx_is_the_same_bytes_whenever_it_is_built(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Tests compare a fixture's sha with a later build's (the idempotency key derives from it),
    so the bytes must not depend on the clock: a zip entry's time once flaked them."""
    import time

    first = report_docx("Two")
    later = time.time() + 3600
    monkeypatch.setattr(time, "time", lambda: later)

    assert report_docx("Two") == first


REFUSAL = BridgeError.model_validate(
    {"class": "needs_user", "code": "content_rejected", "message": "too large"}
)


class FakeBridge:
    """A BridgeClient that records each request; with `raise_after_accepting`, it records the
    request and then loses the response; with `refuse`, it refuses it outright; with
    `no_deliveries`, it accepts it and names no delivery."""

    def __init__(
        self,
        *,
        raise_after_accepting: bool = False,
        refuse: bool = False,
        no_deliveries: bool = False,
    ) -> None:
        self.requests: list[CreateDeliveriesRequest] = []
        self._raise = raise_after_accepting
        self._refuse = refuse
        self._none = no_deliveries

    def deliver(self, request: CreateDeliveriesRequest) -> CreateDeliveriesResult:
        self.requests.append(request)
        if self._raise:
            raise BridgeUnavailable("the bridge could not be reached: response lost")
        if self._refuse:
            raise BridgeRefused(REFUSAL)
        n = len(self.requests)
        return CreateDeliveriesResult(
            package_id=f"p{n}",
            deliveries=[]
            if self._none
            else [DeliveryRef(target_id=t, delivery_id=f"d{n}") for t in request.targets],
        )

    def read_object(self, target_id: str, bucket: str, key: str) -> bytes | None:
        raise NotImplementedError

    def put_object(
        self, target_id: str, bucket: str, key: str, body: bytes, content_type: str
    ) -> None:
        raise NotImplementedError

    def delete_objects(self, target_id: str, objects: list[tuple[str, str]]) -> int:
        raise NotImplementedError


def make_deps(bridge: FakeBridge, register: RegisterStore | None = None) -> DeliverDeps:
    return DeliverDeps(
        renderer=FakeRenderer(),
        register=register or MemoryRegisterStore(clock=lambda: AT),
        bridge=bridge,
        target_lookup=lambda target_id: ("docs", "tenant-1"),
        clock=lambda: AT,
        deployment="test",
    )


def test_create_sends_v2_package_without_update() -> None:
    bridge = FakeBridge()
    deps = make_deps(bridge)
    data = report_docx()
    sha = hashlib.sha256(data).hexdigest()

    out = deliver_decomposition(
        deps, data=data, source_key="reports/r1.docx", target_id=TARGET, started_by=USER
    )

    assert (out.outcome, out.delivery_id) == ("created", "d1")
    [request] = bridge.requests
    assert request.targets == [TARGET] and request.update is None
    assert request.acting_user == USER
    package = request.package
    assert package.contract_version == 2 and package.document is not None
    assert package.files == [] and package.data is None and package.narrative is None
    assert package.idempotency_key == decomposition_idempotency_key(
        sha, None, DECOMPOSER_VERSION, None
    )
    provenance = package.provenance
    assert isinstance(provenance, DecompositionProvenance)
    assert (provenance.source_key, provenance.source_filename, provenance.source_sha256) == (
        "reports/r1.docx",
        "r1.docx",
        sha,
    )
    assert provenance.started_by == USER and provenance.batch_id is None
    assert provenance.decomposed_at == "2026-10-23T09:00:00.000Z"
    assert package.naming["source.filename"] == "r1.docx"
    assert package.naming["source.stem"] == "r1"
    [image] = package.images or []
    [modelled] = package.document.images
    assert (image.id, image.content_type) == (modelled.id, modelled.content_type)
    assert base64.b64decode(image.content)
    # Contract JSON: camelCase, and it round-trips the model's own checks.
    wire = request.model_dump(by_alias=True, mode="json")
    assert "update" not in wire and wire["package"]["contractVersion"] == 2
    CreateDeliveriesRequest.model_validate(wire)

    [stored] = deps.register.entries()  # type: ignore[attr-defined]
    assert (stored.state, stored.delivery_id, stored.id) == ("pending", "d1", out.entry_id)
    assert (stored.sink_id, stored.instance_id, stored.content_sha256) == ("docs", "tenant-1", sha)
    assert stored.idempotency_key == package.idempotency_key


def test_update_sends_expected_versions_from_last_receipt() -> None:
    bridge = FakeBridge()
    store = MemoryRegisterStore(clock=lambda: AT)
    deps = make_deps(bridge, store)
    first = deliver_decomposition(
        deps, data=report_docx("One"), source_key="r1.docx", target_id=TARGET, started_by=USER
    )
    components = [
        ComponentVersion(kind="document", id="DOC-1", version="1", element=None),
        ComponentVersion(kind="section", id="S-1", version="3", element="sec-results"),
    ]
    receipt = Receipt(
        written=[],
        document=DocumentReceipt(
            persistent_id="DOC-1",
            components=components,
            read_back=ReadBack(ok=True, at=None, detail=None),
        ),
    )
    assert first.entry_id is not None
    store.settle(first.entry_id, state="delivered", persistent_id="DOC-1", last_receipt=receipt)

    data = report_docx("Two")
    out = deliver_decomposition(
        deps, data=data, source_key="r1.docx", target_id=TARGET, started_by=USER
    )

    assert (out.outcome, out.delivery_id, out.entry_id) == ("updated", "d2", first.entry_id)
    request = bridge.requests[1]
    assert request.update is not None
    assert request.update.persistent_id == "DOC-1"
    assert request.update.expected == components
    # The run token is what the update expects: the digest of its sorted `id@version` lines.
    expects = hashlib.sha256(b"DOC-1@1\nS-1@3").hexdigest()
    assert request.package.idempotency_key == decomposition_idempotency_key(
        hashlib.sha256(data).hexdigest(), "DOC-1", DECOMPOSER_VERSION, expects
    )
    [stored] = store.entries()
    assert (stored.state, stored.persistent_id, stored.last_receipt) == (
        "pending",
        "DOC-1",
        receipt,
    )


def _receipt(persistent_id: str = "DOC-1") -> Receipt:
    return Receipt(
        written=[],
        document=DocumentReceipt(
            persistent_id=persistent_id,
            components=[
                ComponentVersion(kind="document", id=persistent_id, version="1", element=None)
            ],
            read_back=ReadBack(ok=True, at=None, detail=None),
        ),
    )


def test_every_forced_update_is_a_new_delivery() -> None:
    bridge = FakeBridge()
    store = MemoryRegisterStore(clock=lambda: AT)
    deps = make_deps(bridge, store)
    data = report_docx()
    first = deliver_decomposition(
        deps, data=data, source_key="r1.docx", target_id=TARGET, started_by=USER
    )
    assert first.entry_id is not None
    store.settle(first.entry_id, state="delivered", persistent_id="DOC-1", last_receipt=_receipt())

    skipped = deliver_decomposition(
        deps, data=data, source_key="r1.docx", target_id=TARGET, started_by=USER
    )
    forced = []
    for batch in ("b7", None):
        out = deliver_decomposition(
            deps,
            data=data,
            source_key="r1.docx",
            target_id=TARGET,
            started_by=USER,
            batch_id=batch,
            force=True,
        )
        forced.append(out.outcome)
        store.settle(first.entry_id, state="delivered")

    assert skipped.outcome == "already_loaded" and forced == ["updated", "updated"]
    sha = hashlib.sha256(data).hexdigest()
    unforced = decomposition_idempotency_key(sha, "DOC-1", DECOMPOSER_VERSION, None)
    keys = [r.package.idempotency_key for r in bridge.requests[1:]]
    assert len({unforced, *keys}) == 3
    assert keys[0] != decomposition_idempotency_key(sha, "DOC-1", DECOMPOSER_VERSION, "b7")
    provenance = bridge.requests[1].package.provenance
    assert isinstance(provenance, DecompositionProvenance) and provenance.batch_id == "b7"


def test_every_forced_duplicate_is_a_new_document() -> None:
    bridge = FakeBridge()
    deps = make_deps(bridge)
    data = report_docx()
    deliver_decomposition(deps, data=data, source_key="r1.docx", target_id=TARGET, started_by=USER)

    outcomes = [
        deliver_decomposition(
            deps,
            data=data,
            source_key=key,
            target_id=TARGET,
            started_by=USER,
            batch_id="b1",
            force=True,
        ).outcome
        for key in ("copy/r1.docx", "other/r1.docx")
    ]

    assert outcomes == ["created", "created"]
    keys = [r.package.idempotency_key for r in bridge.requests]
    assert len(set(keys)) == 3
    assert all(r.update is None for r in bridge.requests)


def test_already_loaded_sends_nothing() -> None:
    bridge = FakeBridge()
    store = MemoryRegisterStore(clock=lambda: AT)
    deps = make_deps(bridge, store)
    data = report_docx()
    first = deliver_decomposition(
        deps, data=data, source_key="r1.docx", target_id=TARGET, started_by=USER
    )
    assert first.entry_id is not None
    store.settle(first.entry_id, state="delivered", persistent_id="DOC-1")

    out = deliver_decomposition(
        deps, data=data, source_key="r1.docx", target_id=TARGET, started_by=USER
    )
    duplicate = deliver_decomposition(
        deps, data=data, source_key="copy/r1.docx", target_id=TARGET, started_by=USER
    )

    assert (out.outcome, out.delivery_id, out.entry_id) == ("already_loaded", None, first.entry_id)
    assert duplicate.outcome == "duplicate" and "DOC-1" in duplicate.detail
    assert len(bridge.requests) == 1
    assert [e.state for e in store.entries()] == ["delivered"]


def test_decomposition_failure_touches_nothing() -> None:
    bridge = FakeBridge()
    deps = make_deps(bridge)

    out = deliver_decomposition(
        deps, data=b"not a word file", source_key="r1.docx", target_id=TARGET, started_by=USER
    )

    assert (out.outcome, out.delivery_id, out.entry_id) == ("failed", None, None)
    assert out.detail
    assert bridge.requests == []
    assert deps.register.entries() == []  # type: ignore[attr-defined]


def test_retry_after_lost_response_keeps_one_document() -> None:
    store = MemoryRegisterStore(clock=lambda: AT)
    lost = FakeBridge(raise_after_accepting=True)
    data = report_docx()

    first = deliver_decomposition(
        make_deps(lost, store), data=data, source_key="r1.docx", target_id=TARGET, started_by=USER
    )
    retried = deliver_decomposition(
        make_deps(lost, store), data=data, source_key="r1.docx", target_id=TARGET, started_by=USER
    )

    assert first.outcome == "failed" and "response lost" in first.detail
    assert retried.outcome == "in_flight" and retried.entry_id == first.entry_id
    assert len(lost.requests) == 1
    [stored] = store.entries()
    assert (stored.state, stored.delivery_id) == ("pending", None)


def test_an_entry_without_component_versions_is_unresolved() -> None:
    """The target holds the document, but nothing says which versions an update may overwrite:
    nothing is sent, and the item offers detach (spec §8)."""
    bridge = FakeBridge()
    store = MemoryRegisterStore(clock=lambda: AT)
    deps = make_deps(bridge, store)
    first = deliver_decomposition(
        deps, data=report_docx("One"), source_key="r1.docx", target_id=TARGET, started_by=USER
    )
    assert first.entry_id is not None
    store.settle(first.entry_id, state="incomplete", persistent_id="DOC-1")

    out = deliver_decomposition(
        deps, data=report_docx("Two"), source_key="r1.docx", target_id=TARGET, started_by=USER
    )

    assert (out.outcome, out.entry_id) == ("unresolved", first.entry_id)
    assert out.detail == (
        "the target holds this document but its versions were never recorded; "
        "detach to create a new one, or resolve it in the target"
    )
    assert len(bridge.requests) == 1
    assert [e.state for e in store.entries()] == ["incomplete"]


def test_a_resend_of_an_update_without_versions_fails_its_own_pending_entry() -> None:
    """This batch's own earlier run left the entry pending with no delivery, and the entry has a
    document but no recorded versions: no update can have been sent, so nothing is on its way
    and the entry is failed now, not left pending for the reconcile."""
    bridge = FakeBridge()
    store = MemoryRegisterStore(clock=lambda: AT)
    data = report_docx()
    first = deliver_decomposition(
        make_deps(bridge, store), data=data, source_key="r1.docx", target_id=TARGET, started_by=USER
    )
    assert first.entry_id is not None
    store.settle(first.entry_id, state="incomplete", persistent_id="DOC-1")
    with store.transaction() as tx:
        [entry] = store.entries()
        tx.rows[entry.id] = replace(  # type: ignore[attr-defined]
            entry, state="pending", batch_id="b2", delivery_id=None
        )

    out = deliver_decomposition(
        make_deps(bridge, store),
        data=data,
        source_key="r1.docx",
        target_id=TARGET,
        started_by=USER,
        batch_id="b2",
    )

    assert (out.outcome, out.entry_id) == ("unresolved", first.entry_id)
    assert len(bridge.requests) == 1
    [stored] = store.entries()
    assert (stored.state, stored.persistent_id) == ("failed", "DOC-1")
    assert stored.last_error is not None and stored.last_error["code"] == "no_versions"


def test_a_definite_refusal_fails_the_entry() -> None:
    store = MemoryRegisterStore(clock=lambda: AT)
    refusing = FakeBridge(refuse=True)
    data = report_docx()

    out = deliver_decomposition(
        make_deps(refusing, store),
        data=data,
        source_key="r1.docx",
        target_id=TARGET,
        started_by=USER,
    )

    assert out.outcome == "failed" and "too large" in out.detail
    [stored] = store.entries()
    assert (stored.state, stored.delivery_id) == ("failed", None)
    assert stored.last_error == {
        **REFUSAL.model_dump(by_alias=True, mode="json"),
        "details": {"refusedBeforeAcceptance": True},
    }
    # Nothing was made: the next run creates again under the same entry, with the same key for
    # the same file and a new one for a changed file.
    bridge = FakeBridge()
    for n, source in enumerate((data, report_docx("Two"))):
        again = deliver_decomposition(
            make_deps(FakeBridge(refuse=True) if n == 0 else bridge, store),
            data=source,
            source_key="r1.docx",
            target_id=TARGET,
            started_by=USER,
        )
        assert again.entry_id == out.entry_id
    assert again.outcome == "created"
    assert bridge.requests[0].package.idempotency_key == decomposition_idempotency_key(
        hashlib.sha256(report_docx("Two")).hexdigest(), None, DECOMPOSER_VERSION, None
    )


def _lost_then_expired(
    store: MemoryRegisterStore, data: bytes, *, force: bool = False
) -> tuple[str, str]:
    """A create the bridge took but whose response was lost, then failed by the API's reconcile
    (no persistent id): the entry's id and the key the sink may have created a document under."""
    lost = FakeBridge(raise_after_accepting=True)
    out = deliver_decomposition(
        make_deps(lost, store),
        data=data,
        source_key="r1.docx",
        target_id=TARGET,
        started_by=USER,
        batch_id="b1",
        force=force,
    )
    assert out.entry_id is not None
    store.settle(out.entry_id, state="failed")
    return out.entry_id, lost.requests[0].package.idempotency_key


def test_a_lost_create_run_again_reuses_its_key() -> None:
    store = MemoryRegisterStore(clock=lambda: AT)
    data = report_docx()
    entry_id, key = _lost_then_expired(store, data)
    bridge = FakeBridge()

    out = deliver_decomposition(
        make_deps(bridge, store), data=data, source_key="r1.docx", target_id=TARGET, started_by=USER
    )

    assert (out.outcome, out.entry_id) == ("created", entry_id)
    assert [r.package.idempotency_key for r in bridge.requests] == [key]
    assert [e.idempotency_key for e in store.entries()] == [key]


def test_a_lost_forced_create_run_again_unforced_reuses_its_key() -> None:
    """The Task 8 residual: the forced key carried a token no later run derives."""
    store = MemoryRegisterStore(clock=lambda: AT)
    data = report_docx()
    _, key = _lost_then_expired(store, data, force=True)
    sha = hashlib.sha256(data).hexdigest()
    assert key != decomposition_idempotency_key(sha, None, DECOMPOSER_VERSION, None)
    bridge = FakeBridge()

    for force in (False, True):
        out = deliver_decomposition(
            make_deps(bridge, store),
            data=data,
            source_key="r1.docx",
            target_id=TARGET,
            started_by=USER,
            force=force,
        )
        assert out.outcome == "created"
        [entry] = store.entries()
        store.settle(entry.id, state="failed")

    assert [r.package.idempotency_key for r in bridge.requests] == [key, key]


def test_a_lost_create_of_a_changed_file_is_unresolved() -> None:
    store = MemoryRegisterStore(clock=lambda: AT)
    entry_id, key = _lost_then_expired(store, report_docx())
    bridge = FakeBridge()

    for force in (False, True):
        out = deliver_decomposition(
            make_deps(bridge, store),
            data=report_docx("Two"),
            source_key="r1.docx",
            target_id=TARGET,
            started_by=USER,
            force=force,
        )
        assert (out.outcome, out.delivery_id, out.entry_id) == ("unresolved", None, entry_id)
        assert "may have created a document in the target" in out.detail

    assert bridge.requests == []
    assert [(e.state, e.idempotency_key) for e in store.entries()] == [("failed", key)]


def test_a_refused_retry_under_a_stored_key_stays_unresolved() -> None:
    """A refusal of a run that reused a key an earlier delivery may have created under says
    nothing about that earlier delivery."""
    store = MemoryRegisterStore(clock=lambda: AT)
    data = report_docx()
    _lost_then_expired(store, data)
    refusing = FakeBridge(refuse=True)
    deliver_decomposition(
        make_deps(refusing, store),
        data=data,
        source_key="r1.docx",
        target_id=TARGET,
        started_by=USER,
    )
    [stored] = store.entries()
    assert stored.last_error == REFUSAL.model_dump(by_alias=True, mode="json")

    out = deliver_decomposition(
        make_deps(FakeBridge(), store),
        data=report_docx("Two"),
        source_key="r1.docx",
        target_id=TARGET,
        started_by=USER,
    )
    assert out.outcome == "unresolved"


def test_an_acceptance_without_a_delivery_fails_and_stays_pending() -> None:
    store = MemoryRegisterStore(clock=lambda: AT)

    out = deliver_decomposition(
        make_deps(FakeBridge(no_deliveries=True), store),
        data=report_docx(),
        source_key="r1.docx",
        target_id=TARGET,
        started_by=USER,
    )

    assert out.outcome == "failed" and TARGET in out.detail
    assert [(e.state, e.delivery_id) for e in store.entries()] == [("pending", None)]


@pytest.mark.parametrize("force", [False, True])
def test_a_refusal_names_the_entry(force: bool) -> None:
    bridge = FakeBridge()
    store = MemoryRegisterStore(clock=lambda: AT)
    deps = make_deps(bridge, store)
    first = deliver_decomposition(
        deps, data=report_docx(), source_key="r1.docx", target_id=TARGET, started_by=USER
    )
    assert first.entry_id is not None
    store.settle(first.entry_id, state="changed", persistent_id="DOC-1")

    out = deliver_decomposition(
        deps,
        data=report_docx("Two"),
        source_key="r1.docx",
        target_id=TARGET,
        started_by=USER,
        force=force,
    )

    assert (out.outcome, out.entry_id) == ("changed_in_target", first.entry_id)
    assert len(bridge.requests) == 1


class _StaleByKeyTx:
    def __init__(self, tx: RegisterTx, before: RegisterEntry | None) -> None:
        self._tx = tx
        self._before = before

    def by_key(
        self, sink_id: str, instance_id: str | None, source_key: str
    ) -> RegisterEntry | None:
        return self._before

    def by_hash(self, sink_id: str, instance_id: str | None, sha: str) -> list[RegisterEntry]:
        return self._tx.by_hash(sink_id, instance_id, sha)

    def put_pending(self, **kwargs: Any) -> RegisterEntry:
        return self._tx.put_pending(**kwargs)

    def set_delivery(self, entry_id: str, delivery_id: str) -> None:
        self._tx.set_delivery(entry_id, delivery_id)

    def set_failed(self, entry_id: str, error: dict[str, Any]) -> None:
        self._tx.set_failed(entry_id, error)


class StaleByKey:
    """Run B's view of the register when run A wrote between B's `by_key` and its `by_hash`, as
    on Postgres: B's `by_key` read the source before A's entry was committed (`before`: no row,
    or the detached tombstone A then replaced), and B's `by_hash`, which waited on A's content
    lock, reads A's entry. Only B's decision transaction is stale."""

    def __init__(self, store: MemoryRegisterStore, before: RegisterEntry | None) -> None:
        self._store = store
        self._before = before
        self._stale = True

    @contextmanager
    def transaction(self) -> Iterator[RegisterTx]:
        with self._store.transaction() as tx:
            if self._stale:
                self._stale = False
                yield _StaleByKeyTx(tx, self._before)
            else:
                yield tx


def test_two_batches_with_the_same_file_at_once_report_in_flight() -> None:
    """Review Focus 1's race: two batches deliver the same bytes under the same source key at
    once. The second waits on the first's content lock and finds the first's pending entry,
    which is its own source's: in flight, not a duplicate of itself."""
    bridge = FakeBridge()
    store = MemoryRegisterStore(clock=lambda: AT)
    data = report_docx()
    first = deliver_decomposition(
        make_deps(bridge, store),
        data=data,
        source_key="manual/a.docx",
        target_id=TARGET,
        started_by=USER,
        batch_id="b1",
    )
    assert first.outcome == "created"

    second = deliver_decomposition(
        make_deps(bridge, StaleByKey(store, None)),
        data=data,
        source_key="manual/a.docx",
        target_id=TARGET,
        started_by=USER,
        batch_id="b2",
    )

    assert (second.outcome, second.entry_id) == ("in_flight", first.entry_id)
    assert len(bridge.requests) == 1


def test_two_runs_replacing_a_detached_tombstone_at_once_report_in_flight() -> None:
    """Both runs read the tombstone; the first replaces it with a new pending entry (the row
    the second's FOR UPDATE waited on is gone, so on Postgres it reads nothing)."""
    bridge = FakeBridge()
    store = MemoryRegisterStore(clock=lambda: AT)
    data = report_docx()
    made = deliver_decomposition(
        make_deps(bridge, store), data=data, source_key="a.docx", target_id=TARGET, started_by=USER
    )
    assert made.entry_id is not None
    store.settle(made.entry_id, state="changed", persistent_id="DOC-1")
    store.detach(made.entry_id, action_id="detach-1")
    [tombstone] = store.entries()

    first = deliver_decomposition(
        make_deps(bridge, store),
        data=data,
        source_key="a.docx",
        target_id=TARGET,
        started_by=USER,
        batch_id="b1",
    )
    second = deliver_decomposition(
        make_deps(bridge, StaleByKey(store, tombstone)),
        data=data,
        source_key="a.docx",
        target_id=TARGET,
        started_by=USER,
        batch_id="b2",
    )

    assert first.outcome == "created"
    assert (second.outcome, second.entry_id) == ("in_flight", first.entry_id)
    assert len(bridge.requests) == 2


# --- The CLI (scripts/deliver_decomposition.py) -----------------------------------------------


def _cli() -> ModuleType:
    script = Path(__file__).parents[2] / "scripts" / "deliver_decomposition.py"
    spec = importlib.util.spec_from_file_location("deliver_decomposition_cli", script)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_cli_prints_one_json_line(tmp_path: Path, capsys: pytest.CaptureFixture[str]) -> None:
    cli = _cli()
    source = tmp_path / "r1.docx"
    source.write_bytes(report_docx())
    bridge = FakeBridge()
    deps = make_deps(bridge)

    first = cli.main([str(source), "--target", TARGET], deps=deps)
    again = cli.main([str(source), "--target", TARGET, "--source-key", "r1.docx"], deps=deps)

    lines = capsys.readouterr().out.splitlines()
    assert (first, again) == (0, 1)
    assert [json.loads(line)["outcome"] for line in lines] == ["created", "in_flight"]
    assert json.loads(lines[0])["deliveryId"] == "d1"
    assert bridge.requests[0].package.provenance.source_key == "r1.docx"  # type: ignore[union-attr]


def test_a_pdf_delivered_without_a_decomposition_is_read_by_the_pdf_reader() -> None:
    data, layout = two_pages()
    bridge = FakeBridge()
    deps = replace(make_deps(bridge), layout=layout)

    out = deliver_decomposition(
        deps, data=data, source_key="two-pages.pdf", target_id=TARGET, started_by=USER
    )

    assert out.outcome == "created"
    [request] = bridge.requests
    assert request.package.idempotency_key == decomposition_idempotency_key(
        hashlib.sha256(data).hexdigest(), None, 1009, None
    )
    assert request.package.provenance.decomposer_version == 1009  # type: ignore[union-attr]


def test_a_pdf_without_a_layout_service_fails_when_delivered() -> None:
    data, _ = two_pages()
    out = deliver_decomposition(
        make_deps(FakeBridge()), data=data, source_key="a.pdf", target_id=TARGET, started_by=USER
    )

    assert out.outcome == "failed" and "no layout service (LAYOUT_URL)" in (out.detail or "")
