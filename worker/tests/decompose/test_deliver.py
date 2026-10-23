"""deliver_decomposition: the register's decision, the version 2 package and its hand-off."""

from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType

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
from ingest_worker.decompose.register import MemoryRegisterStore
from tests.decompose.docx import build_docx
from tests.decompose.fakes import FakeRenderer
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


def make_deps(bridge: FakeBridge, register: MemoryRegisterStore | None = None) -> DeliverDeps:
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
    assert request.package.idempotency_key == decomposition_idempotency_key(
        hashlib.sha256(data).hexdigest(), "DOC-1", DECOMPOSER_VERSION, None
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


def test_an_entry_without_component_versions_is_changed_in_target() -> None:
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

    assert (out.outcome, out.entry_id) == ("changed_in_target", first.entry_id)
    assert out.detail == (
        "no component versions are recorded for this document; resolve it in the target"
    )
    assert len(bridge.requests) == 1
    assert [e.state for e in store.entries()] == ["incomplete"]


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
    assert stored.last_error == REFUSAL.model_dump(by_alias=True, mode="json")
    # Nothing was made: the next run creates again under the same entry.
    bridge = FakeBridge()
    again = deliver_decomposition(
        make_deps(bridge, store),
        data=data,
        source_key="r1.docx",
        target_id=TARGET,
        started_by=USER,
    )
    assert (again.outcome, again.entry_id) == ("created", out.entry_id)
    assert (
        bridge.requests[0].package.idempotency_key == refusing.requests[0].package.idempotency_key
    )


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
