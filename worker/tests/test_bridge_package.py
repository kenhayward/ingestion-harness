"""Building the bridge package from what the worker renders, and delivering it."""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any

import pytest

from ingest_worker.bridge.client import BridgeRefused, BridgeUnavailable
from ingest_worker.bridge.models import ActingUser, BridgeError, BridgePackage, idempotency_key
from ingest_worker.bridge.package import acting_user_for, build_package, deliver_outputs
from ingest_worker.outputs import RenderedOutput
from ingest_worker.pipeline import Buckets, PipelineDeps, Target
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import SpecRegistry
from ingest_worker.storage import MemoryObjectStore, output_key
from ingest_worker.template import Template

from .fakes import FakeBridge, FakeQueue

SHA = hashlib.sha256(b"%PDF").hexdigest()
JOB = ClaimedJob(
    "8a6f1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b",
    "doc-1",
    "demo",
    1,
    "inbox",
    "demo/v1/doc-1.pdf",
    None,
    1,
    3,
    filename="protocol.pdf",
    source_sha256=SHA,
)

TEMPLATE = Template.model_validate(
    {
        "id": "demo",
        "version": 1,
        "name": "Demo",
        "preamble": "x",
        "document": {"sections": [{"id": "head", "anchor": r"\A"}]},
        "outputs": {
            "fields": [
                {"id": "product", "name": "Product", "type": "text"},
                {"id": "dose", "type": "decimal"},
            ],
            "tables": [
                {
                    "id": "results",
                    "name": "Results",
                    "columns": [
                        {"id": "batch", "type": "text"},
                        {"id": "value", "type": "decimal"},
                    ],
                }
            ],
        },
        "pipeline": [
            {"type": "extract", "id": "h", "fields": ["product", "dose"], "sections": ["head"]},
            {"type": "extract", "id": "t", "table": "results", "sections": ["head"]},
        ],
    }
)

DOCUMENT: dict[str, Any] = {
    "source_sha256": SHA,
    "extracted_at": "2026-10-19T11:00:00.123456+00:00",
    "published_at": "2026-10-19T12:00:00+00:00",
    "fields": {
        "product": {"value": "Richfer", "evidence": "…", "page": 1},
        "dose": {"value": 2.5, "evidence": None, "page": None},
    },
    "tables": {"results": [{"batch": "B1", "value": 1.0}]},
}


def rendered() -> list[RenderedOutput]:
    keys = [
        ("fields", "csv", output_key("demo", 1, "fields", "doc-1", "csv")),
        ("results", "csv", output_key("demo", 1, "results", "doc-1", "csv")),
        ("document", "json", output_key("demo", 1, "document", "doc-1", "json")),
    ]
    return [RenderedOutput(o, f, k, f"{o} body".encode(), None) for o, f, k in keys]  # type: ignore[arg-type]


PAT = ActingUser(id="u-1", name="Pat", email="pat@example.com")


def test_a_document_package_carries_files_at_todays_keys_and_the_data() -> None:
    package = build_package(
        job=JOB,
        template=TEMPLATE,
        document=DOCUMENT,
        outputs=rendered(),
        approver=PAT,
        deployment="default",
    )
    BridgePackage.model_validate(package.model_dump(by_alias=True, mode="json"))
    assert package.kind == "document"
    assert [f.name for f in package.files] == [o.key for o in rendered()]
    assert [f.output for f in package.files] == ["fields", "results", "document"]
    assert [f.content_type for f in package.files] == [
        "text/csv; charset=utf-8",
        "text/csv; charset=utf-8",
        "application/json",
    ]
    assert base64.b64decode(package.files[0].content) == b"fields body"
    assert package.idempotency_key == idempotency_key(SHA, "demo", 1)
    assert package.producer.name == "ct-studio"
    assert package.provenance is not None
    assert package.provenance.source_sha256 == SHA
    assert package.provenance.source_filename == "protocol.pdf"
    assert package.provenance.recipe_id == "demo"
    assert package.provenance.approver == PAT
    assert package.provenance.extracted_at == "2026-10-19T11:00:00.123456Z"
    assert package.provenance.published_at == "2026-10-19T12:00:00Z"
    assert package.data is not None
    assert [(f.id, f.title, f.type, f.value) for f in package.data.fields] == [
        ("product", "Product", "text", "Richfer"),
        ("dose", None, "decimal", 2.5),
    ]
    [table] = package.data.tables
    assert (table.id, table.title, [c.id for c in table.columns]) == (
        "results",
        "Results",
        ["batch", "value"],
    )
    assert table.rows == [{"batch": "B1", "value": 1.0}]
    assert package.naming == {}
    assert package.rdf is None and package.narrative is None and package.images is None


def test_a_legacy_spec_package_has_files_and_no_data() -> None:
    package = build_package(
        job=JOB, template=None, document=None, outputs=rendered(), approver=None, deployment="d"
    )
    assert package.data is None
    assert package.provenance is not None and package.provenance.approver is None
    assert package.idempotency_key == idempotency_key(SHA, "demo", 1)


def deps(bridge: FakeBridge | None) -> PipelineDeps:
    return PipelineDeps(
        store=MemoryObjectStore(),
        specs=SpecRegistry({}),
        models=None,  # type: ignore[arg-type]
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        bridge=bridge,
    )


TARGET = Target("finance-lake", "finance", "fin/")


def package() -> BridgePackage:
    return build_package(
        job=JOB, template=TEMPLATE, document=DOCUMENT, outputs=rendered(), approver=None,
        deployment="default",
    )  # fmt: skip


def test_deliver_outputs_submits_to_the_target_and_returns_prefixed_outputs() -> None:
    bridge = FakeBridge({"finance-lake": ("finance", "fin/")})
    published, delivery_id = deliver_outputs(deps(bridge), JOB, package(), TARGET, PAT, rendered())
    [request] = bridge.requests
    assert request.targets == ["finance-lake"]
    assert request.acting_user == PAT
    assert [o.key for o in published] == ["fin/" + o.key for o in rendered()]
    assert delivery_id
    assert bridge.objects[("finance", "fin/demo/v1/fields/doc-1.csv")][0] == b"fields body"


def test_a_refusal_needs_review_and_an_unreachable_bridge_is_retried() -> None:
    bridge = FakeBridge()
    bridge.refusals = [
        BridgeError(class_="needs_user", code="target_missing", message="no target finance-lake"),
        BridgeUnavailable("connection refused"),
    ]
    with pytest.raises(BridgeRefused, match="no target finance-lake"):
        deliver_outputs(deps(bridge), JOB, package(), TARGET, None, rendered())
    with pytest.raises(BridgeUnavailable):
        deliver_outputs(deps(bridge), JOB, package(), TARGET, None, rendered())


def test_without_a_bridge_nothing_can_be_delivered() -> None:
    with pytest.raises(RuntimeError, match="bridge"):
        deliver_outputs(deps(None), JOB, package(), TARGET, None, rendered())


def test_the_acting_user_is_the_reviewer_else_the_uploader() -> None:
    queue = FakeQueue()
    assert acting_user_for(JOB, queue) is None
    queue.uploaders[JOB.id] = PAT
    assert acting_user_for(JOB, queue) == PAT
    reviewer = ActingUser(id="u-2", name="Rev", email=None)
    queue.reviewers[JOB.id] = reviewer
    assert acting_user_for(JOB, queue) == reviewer


def test_the_package_is_valid_json_for_the_bridge() -> None:
    text = json.dumps(package().model_dump(by_alias=True, mode="json"))
    assert '"idempotencyKey"' in text and '"contentType"' in text
