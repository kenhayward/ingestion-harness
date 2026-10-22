"""Building the bridge package from what the worker renders, and delivering it."""

from __future__ import annotations

import base64
import hashlib
import json
from typing import Any

import pytest

from ingest_worker.bridge.client import BridgeRefused, BridgeUnavailable
from ingest_worker.bridge.models import (
    ActingUser,
    BridgeError,
    BridgePackage,
    graph_idempotency_key,
    idempotency_key,
)
from ingest_worker.bridge.package import (
    GraphVersion,
    acting_user_for,
    build_graph_package,
    build_package,
    deliver_document,
    deliver_graph_package,
    deliver_outputs,
)
from ingest_worker.outputs import RenderedOutput
from ingest_worker.pipeline import Buckets, PipelineDeps, Target
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import SpecRegistry
from ingest_worker.storage import MemoryObjectStore, graph_version_key, output_key
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
    # What the sinks' name patterns resolve against (fixture naming.json pins the rules).
    assert package.naming["field:product"] == "Richfer"
    assert package.naming["field:dose"] == "2.5"
    assert package.naming["recipe.id"] == package.provenance.recipe_id
    assert package.naming["job.id"] == package.provenance.job_id
    assert package.naming["date"] == package.provenance.published_at[:10]
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
    delivered = deliver_outputs(deps(bridge), JOB, package(), [TARGET], PAT, rendered())
    [request] = bridge.requests
    assert request.targets == ["finance-lake"]
    assert request.acting_user == PAT
    assert [o.key for o in delivered.outputs] == ["fin/" + o.key for o in rendered()]
    assert delivered.s3[0] == "finance-lake" and delivered.s3[1]
    assert delivered.deliveries == [delivered.s3]
    assert bridge.objects[("finance", "fin/demo/v1/fields/doc-1.csv")][0] == b"fields body"


def test_a_refusal_needs_review_and_an_unreachable_bridge_is_retried() -> None:
    bridge = FakeBridge()
    bridge.refusals = [
        BridgeError(class_="needs_user", code="target_missing", message="no target finance-lake"),
        BridgeUnavailable("connection refused"),
    ]
    with pytest.raises(BridgeRefused, match="no target finance-lake"):
        deliver_outputs(deps(bridge), JOB, package(), [TARGET], None, rendered())
    with pytest.raises(BridgeUnavailable):
        deliver_outputs(deps(bridge), JOB, package(), [TARGET], None, rendered())


def test_without_a_bridge_nothing_can_be_delivered() -> None:
    with pytest.raises(RuntimeError, match="bridge"):
        deliver_outputs(deps(None), JOB, package(), [TARGET], None, rendered())


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


GRAPH_NAME = f"https://data.example/ct/graph/source/{SHA}/demo"
TURTLE = f"<{GRAPH_NAME}> <https://id.stocks-hayward.com/ns/ct#graphVersion> 2 .\n".encode()
GRAPH = GraphVersion(
    graph_name=GRAPH_NAME,
    version=2,
    turtle=TURTLE,
    copy_key=graph_version_key(SHA, "demo", 2),
)
TRIPLES = Target("rdf-default", "ct", "")


def test_a_package_with_a_graph_carries_graph_version_at_todays_key_and_the_rdf_part() -> None:
    pkg = build_package(
        job=JOB, template=TEMPLATE, document=DOCUMENT, outputs=rendered(), approver=None,
        deployment="default", graph=GRAPH,
    )  # fmt: skip
    copy = next(f for f in pkg.files if f.output == "graph-version")
    assert copy.name == f"graphs/{SHA}/demo/v2.ttl"
    assert copy.content_type == "text/turtle"
    assert base64.b64decode(copy.content) == TURTLE
    assert pkg.rdf is not None
    assert (pkg.rdf.graph_name, pkg.rdf.version, pkg.rdf.turtle) == (
        GRAPH_NAME,
        2,
        TURTLE.decode(),
    )


def test_one_request_names_every_target_and_the_graph_copy_is_never_recorded() -> None:
    bridge = FakeBridge({"finance-lake": ("finance", "fin/")}, rdf={"rdf-default"})
    delivered = deliver_document(
        deps(bridge), JOB, template=TEMPLATE, document=DOCUMENT, outputs=rendered(),
        targets=[TARGET, TRIPLES], acting=PAT, approver=None, graph=GRAPH,
    )  # fmt: skip
    [request] = bridge.requests
    assert request.targets == ["finance-lake", "rdf-default"]
    assert [o.output_id for o in delivered.outputs] == ["fields", "results", "document"]
    assert [t for t, _ in delivered.deliveries] == ["finance-lake", "rdf-default"]
    assert delivered.s3 == delivered.deliveries[0]
    # The S3 sink writes the copy at the target's prefix + today's key; the store gets the graph.
    assert bridge.objects[("finance", f"fin/graphs/{SHA}/demo/v2.ttl")][0] == TURTLE
    assert bridge.graphs[GRAPH_NAME] == TURTLE.decode()


def test_a_graph_package_has_kind_graph_no_provenance_and_the_graph_key() -> None:
    pkg = build_graph_package(GRAPH_NAME, 2, TURTLE.decode(), deployment="default")
    assert pkg.kind == "graph"
    assert pkg.provenance is None
    assert pkg.files == [] and pkg.data is None
    assert pkg.idempotency_key == graph_idempotency_key(GRAPH_NAME, 2)
    bridge = FakeBridge(rdf={"rdf-default"})
    delivery_id = deliver_graph_package(deps(bridge), pkg, TRIPLES, PAT)
    assert delivery_id
    assert bridge.requests[0].targets == ["rdf-default"]
    assert bridge.graphs[GRAPH_NAME] == TURTLE.decode()


def test_a_sink_target_is_in_the_request_and_records_no_outputs() -> None:
    bridge = FakeBridge({"finance-lake": ("finance", "fin/")}, sinks={"fake-target"})
    sink = Target("fake-target", "", "", layout="sink", sink_id="fake")
    delivered = deliver_outputs(deps(bridge), JOB, package(), [TARGET, sink], PAT, rendered())
    [request] = bridge.requests
    assert request.targets == ["finance-lake", "fake-target"]
    assert [t for t, _ in delivered.deliveries] == ["finance-lake", "fake-target"]
    assert "fake-target" not in delivered.outputs_by_target
    assert delivered.primary == "finance-lake"
