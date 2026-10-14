"""Withdrawing and re-delivering what was published (ADR 0011 step 7)."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import yaml

from ingest_worker.graph_registry import MemoryGraphRegistry
from ingest_worker.graph_store import GraphStoreUnavailable
from ingest_worker.llm.registry import ModelRegistry
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps, Target
from ingest_worker.queue import ClaimedJob
from ingest_worker.rdf_rebuild import DeliveredJob, MemoryRebuildSource
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore, graph_version_key

from .fakes import FakeGraphStore, FakeQueue, MemoryLinkedDataSettings

BASE = "https://data.acme.example/"
SHA = "ab" * 32
GRAPH = f"{BASE}graph/source/{SHA}/letter"

TEMPLATE: dict[str, Any] = {
    "id": "letter",
    "version": 1,
    "name": "Letter",
    "document": {"sections": [{"id": "all", "anchor": "\\A"}]},
    "outputs": {"fields": [{"id": "sender", "type": "text"}]},
    "pipeline": [{"type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"]}],
    "delivery": {"formats": ["csv", "rdf"]},
    "semantics": {
        "prefixes": {"acme": "https://acme.example/def/"},
        "document": {"class": "acme:Letter"},
        "fields": {"sender": {"property": "acme:sentBy"}},
    },
}
DELIVERED = DeliveredJob(
    job_id="11111111-1111-4111-8111-111111111111",
    document_id="22222222-2222-4222-8222-222222222222",
    template_id="letter",
    template_version=1,
    sha256=SHA,
    bucket="inbox",
    object_key="letter/v1/a.pdf",
)


def setup(tmp_path: Path) -> tuple[PipelineDeps, MemoryObjectStore]:
    directory = tmp_path / "letter" / "v1"
    directory.mkdir(parents=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(TEMPLATE), encoding="utf-8")
    store, target = MemoryObjectStore(), MemoryObjectStore()
    deps = PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=ModelRegistry({}, {}, {}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        target=Target(store=target, bucket="published", prefix="pvp/"),
        linked_data=MemoryLinkedDataSettings(BASE),
        graph_registry=MemoryGraphRegistry(),
        graph_store=FakeGraphStore(),
        delivered_jobs=MemoryRebuildSource(withdrawn=[DELIVERED]),
    )
    reviewed = {
        "document_id": DELIVERED.document_id,
        "job_id": DELIVERED.job_id,
        "fields": {"sender": {"value": "Acme", "evidence": None, "page": 1}},
        "tables": {},
        "checks": {},
        "issues": [],
        "models": {},
    }
    store.put(
        "runs",
        f"{DELIVERED.job_id}/reviewed-document.json",
        json.dumps(reviewed).encode(),
        "application/json",
    )
    return deps, target


def background(task: str, params: dict[str, Any]) -> ClaimedJob:
    return ClaimedJob(
        "33333333-3333-4333-8333-333333333333", "", "", 0, "", "", None, 1, 100,
        task=task, params=params,
    )  # fmt: skip


def store_of(deps: PipelineDeps) -> FakeGraphStore:
    assert isinstance(deps.graph_store, FakeGraphStore)
    return deps.graph_store


WITHDRAW = {
    "objects": [{"bucket": "published", "key": "pvp/letter/v1/fields/doc.csv"}],
    "graphs": [{"sha256": SHA, "templateId": "letter", "graphIri": GRAPH, "versions": [1, 2]}],
}


def test_a_withdrawal_removes_the_objects_the_copies_and_the_graph(tmp_path: Path) -> None:
    deps, target = setup(tmp_path)
    for key in [
        "pvp/letter/v1/fields/doc.csv",
        "pvp/" + graph_version_key(SHA, "letter", 1),
        "pvp/" + graph_version_key(SHA, "letter", 2),
        "pvp/other.csv",
    ]:
        target.put("published", key, b"x", "text/plain")
    store_of(deps).graphs[GRAPH] = b"<a> <b> <c> ."
    queue = FakeQueue(jobs=[background("withdraw", WITHDRAW)])
    run_once(queue, deps, "w1")
    assert queue.completed
    assert list(target.objects) == [("published", "pvp/other.csv")]
    assert GRAPH not in store_of(deps).graphs
    [data] = [d for _, _, m, d in queue.event_details if m == "withdrawn"]
    assert data == {"objects": 1, "graphs": 1}
    # Again (a retry after a crash): nothing left, still a success.
    queue.jobs = [background("withdraw", WITHDRAW)]
    run_once(queue, deps, "w1")
    assert len(queue.completed) == 2


def test_a_version_only_withdrawal_keeps_the_graph(tmp_path: Path) -> None:
    deps, _ = setup(tmp_path)
    store_of(deps).graphs[GRAPH] = b"<a> <b> <c> ."
    params = {"objects": [], "graphs": [{**WITHDRAW["graphs"][0], "graphIri": None}]}  # type: ignore[dict-item]
    queue = FakeQueue(jobs=[background("withdraw", params)])
    run_once(queue, deps, "w1")
    assert queue.completed and GRAPH in store_of(deps).graphs


def test_a_store_outage_retries_the_withdrawal(tmp_path: Path) -> None:
    deps, _ = setup(tmp_path)
    store_of(deps).fail = GraphStoreUnavailable("graph store answered 503")
    queue = FakeQueue(jobs=[background("withdraw", WITHDRAW)])
    run_once(queue, deps, "w1")
    assert queue.failed and not queue.completed


def test_invalid_params_go_to_review(tmp_path: Path) -> None:
    deps, _ = setup(tmp_path)
    queue = FakeQueue(jobs=[background("withdraw", {"objects": []})])
    run_once(queue, deps, "w1")
    assert queue.reviewed and "invalid withdraw parameters" in queue.reviewed[0][1]


def test_republish_delivers_the_withdrawn_jobs_again(tmp_path: Path) -> None:
    deps, target = setup(tmp_path)
    registry = deps.graph_registry
    assert isinstance(registry, MemoryGraphRegistry)
    queue = FakeQueue(jobs=[background("republish", {"templateId": "letter"})])
    run_once(queue, deps, "w1")
    assert queue.completed
    [(job_id, published, bucket)] = queue.published
    assert job_id == DELIVERED.job_id and bucket == "published"
    assert {o.format for o in published} == {"csv", "rdf"}
    assert all(target.get_optional("published", o.key) for o in published)
    current = registry.current(SHA, "letter")
    assert current is not None and current.job_id == DELIVERED.job_id
    assert GRAPH in store_of(deps).graphs
    [data] = [d for _, _, m, d in queue.event_details if m == "republished"]
    assert data == {"jobs": 1}


def test_republish_continues_the_version_numbers(tmp_path: Path) -> None:
    deps, _ = setup(tmp_path)
    registry = deps.graph_registry
    assert isinstance(registry, MemoryGraphRegistry)
    from ingest_worker.graph_registry import GraphPublish

    record = GraphPublish(SHA, "letter", GRAPH, DELIVERED.job_id, DELIVERED.document_id, 1, BASE, 1)
    registry.publish(record, lambda _v: None)
    registry.graphs.clear()  # retired: the current row is forgotten, the versions kept
    queue = FakeQueue(jobs=[background("republish", {"templateId": "letter"})])
    run_once(queue, deps, "w1")
    assert registry.current(SHA, "letter").version == 2  # type: ignore[union-attr]


def test_republish_with_nothing_withdrawn(tmp_path: Path) -> None:
    deps, _ = setup(tmp_path)
    deps = replace(deps, delivered_jobs=MemoryRebuildSource())
    queue = FakeQueue(jobs=[background("republish", {"templateId": "letter"})])
    run_once(queue, deps, "w1")
    assert queue.completed and not queue.published
