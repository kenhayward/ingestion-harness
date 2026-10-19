"""Withdrawing and re-delivering what was published (ADR 0011 step 7)."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import yaml

from ingest_worker.bridge.models import ActingUser
from ingest_worker.graph_registry import MemoryGraphRegistry
from ingest_worker.graph_store import GraphStoreUnavailable
from ingest_worker.llm.registry import ModelRegistry
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps, Target
from ingest_worker.queue import ClaimedJob
from ingest_worker.rdf_rebuild import DeliveredJob, MemoryRebuildSource
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore, graph_version_key

from .fakes import FakeBridge, FakeGraphStore, FakeQueue, FakeTargets, MemoryLinkedDataSettings

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
        targets=FakeTargets({"default": Target("default", "published", "pvp/")}),
        bridge=FakeBridge({"default": ("published", "pvp/")}, stores={"default": target}),
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
    "objects": [
        {"bucket": "published", "key": "pvp/letter/v1/fields/doc.csv", "target": "default"}
    ],
    "graphs": [
        {
            "sha256": SHA,
            "templateId": "letter",
            "graphIri": GRAPH,
            "target": "default",
            "versions": [1, 2],
        }
    ],
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
    assert queue.finished
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
    pressed = ActingUser(id="u-9", name="Ria", email=None)
    republish = background("republish", {"templateId": "letter"})
    queue = FakeQueue(jobs=[republish], uploaders={republish.id: pressed})
    run_once(queue, deps, "w1")
    # The republish job waits for the bridge to finish its deliveries.
    [(waiting, _, deliveries)] = queue.handed_over
    assert waiting == republish.id and not queue.completed
    [(job_id, published, target_id)] = queue.published
    assert job_id == DELIVERED.job_id and target_id == "default"
    assert deliveries == [("default", queue.published_deliveries[0][2])]
    assert isinstance(deps.bridge, FakeBridge)
    [request] = deps.bridge.requests
    assert request.acting_user == pressed  # who pressed Republish
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

    record = GraphPublish(
        SHA, "letter", GRAPH, DELIVERED.job_id, DELIVERED.document_id, 1, BASE, 1,
        target_id="default",
    )  # fmt: skip
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


def test_a_withdrawal_spares_what_was_published_again_since(tmp_path: Path) -> None:
    from ingest_worker.graph_registry import GraphPublish

    deps, target = setup(tmp_path)
    registry = deps.graph_registry
    assert isinstance(registry, MemoryGraphRegistry)
    source = deps.delivered_jobs
    assert isinstance(source, MemoryRebuildSource)
    # Since the withdrawal was queued: another job published v1 of the graph again, and a live
    # output now has the withdrawn object's key.
    record = GraphPublish(SHA, "letter", GRAPH, "j2", "d2", 1, BASE, 1, target_id="default")
    registry.publish(record, lambda _v: None)
    store_of(deps).graphs[GRAPH] = b"<a> <b> <c> ."
    for key in ["pvp/letter/v1/fields/doc.csv", "pvp/" + graph_version_key(SHA, "letter", 1),
                "pvp/" + graph_version_key(SHA, "letter", 2)]:  # fmt: skip
        target.put("published", key, b"x", "text/plain")
    source.live.add(("default", "published", "pvp/letter/v1/fields/doc.csv"))
    queue = FakeQueue(jobs=[background("withdraw", WITHDRAW)])
    run_once(queue, deps, "w1")
    assert queue.finished
    assert GRAPH in store_of(deps).graphs  # the current graph is not dropped
    assert set(target.objects) == {
        ("published", "pvp/letter/v1/fields/doc.csv"),
        ("published", "pvp/" + graph_version_key(SHA, "letter", 1)),
    }


def test_republish_does_nothing_for_a_type_retired_again(tmp_path: Path) -> None:
    deps, _ = setup(tmp_path)
    assert isinstance(deps.delivered_jobs, MemoryRebuildSource)
    deps.delivered_jobs.retired.add("letter")
    queue = FakeQueue(jobs=[background("republish", {"templateId": "letter"})])
    run_once(queue, deps, "w1")
    assert queue.completed and not queue.published and not store_of(deps).graphs
    assert any(m == "republish skipped: retired" for _, _, m in queue.events)


def test_a_republish_whose_graph_fails_stays_withdrawn_for_the_retry(tmp_path: Path) -> None:
    deps, _ = setup(tmp_path)
    store_of(deps).fail = GraphStoreUnavailable("graph store answered 503")
    queue = FakeQueue(jobs=[background("republish", {"templateId": "letter"})])
    run_once(queue, deps, "w1")
    assert queue.failed and not queue.published  # not recorded: the retry finds it again


def test_republish_skips_a_job_it_cannot_render_and_goes_on(tmp_path: Path) -> None:
    deps, _ = setup(tmp_path)
    source = deps.delivered_jobs
    assert isinstance(source, MemoryRebuildSource)
    legacy = replace(DELIVERED, job_id="44444444-4444-4444-8444-444444444444", template_id="letter",
                     template_version=9)  # fmt: skip
    source.withdrawn.insert(0, legacy)
    reviewed = deps.store.get("runs", f"{DELIVERED.job_id}/reviewed-document.json")
    deps.store.put("runs", f"{legacy.job_id}/reviewed-document.json", reviewed, "application/json")
    queue = FakeQueue(jobs=[background("republish", {"templateId": "letter"})])
    run_once(queue, deps, "w1")
    assert queue.finished
    assert [j for j, _, _ in queue.published] == [DELIVERED.job_id]
    skipped = [d for _, _, m, d in queue.event_details if m == "republish skipped"]
    assert skipped and skipped[0]["job"] == legacy.job_id


# --- publishing targets: everything is withdrawn through the target it was delivered to ---------


def two_targets(deps: PipelineDeps) -> MemoryObjectStore:
    """Adds finance-lake (prefix fin/) next to the default target; its store."""
    assert isinstance(deps.targets, FakeTargets)
    finance = MemoryObjectStore()
    deps.targets.targets["finance-lake"] = Target("finance-lake", "finance", "fin/")
    assert isinstance(deps.bridge, FakeBridge)
    deps.bridge.targets["finance-lake"] = ("finance", "fin/")
    deps.bridge.stores["finance-lake"] = finance
    return finance


def test_outputs_delivered_to_two_targets_are_withdrawn_from_each(tmp_path: Path) -> None:
    deps, default = setup(tmp_path)
    finance = two_targets(deps)
    default.put("published", "pvp/letter/v1/fields/doc.csv", b"x", "text/csv")
    finance.put("finance", "fin/letter/v2/fields/doc.csv", b"x", "text/csv")
    finance.put("published", "pvp/letter/v1/fields/doc.csv", b"same key, other store", "text/csv")
    params = {
        "objects": [
            {"bucket": "published", "key": "pvp/letter/v1/fields/doc.csv", "target": "default"},
            {"bucket": "finance", "key": "fin/letter/v2/fields/doc.csv", "target": "finance-lake"},
        ],
        "graphs": [],
    }
    queue = FakeQueue(jobs=[background("withdraw", params)])
    run_once(queue, deps, "w1")
    assert queue.finished
    assert not default.objects
    assert list(finance.objects) == [("published", "pvp/letter/v1/fields/doc.csv")]


def test_graph_copies_are_withdrawn_through_their_recorded_targets(tmp_path: Path) -> None:
    deps, default = setup(tmp_path)
    finance = two_targets(deps)
    default.put("published", "pvp/" + graph_version_key(SHA, "letter", 1), b"x", "text/turtle")
    finance.put("finance", "fin/" + graph_version_key(SHA, "letter", 2), b"x", "text/turtle")
    store_of(deps).graphs[GRAPH] = b"<a> <b> <c> ."
    entry = {"sha256": SHA, "templateId": "letter"}
    params = {
        "objects": [],
        "graphs": [
            {**entry, "graphIri": None, "target": "default", "versions": [1]},
            {**entry, "graphIri": GRAPH, "target": "finance-lake", "versions": [2]},
        ],
    }
    queue = FakeQueue(jobs=[background("withdraw", params)])
    run_once(queue, deps, "w1")
    assert queue.finished, queue.reviewed or queue.failed
    assert not default.objects and not finance.objects
    assert GRAPH not in store_of(deps).graphs
    [data] = [d for _, _, m, d in queue.event_details if m == "withdrawn"]
    assert data == {"objects": 0, "graphs": 1}


def test_a_withdrawal_naming_a_missing_target_goes_to_review(tmp_path: Path) -> None:
    deps, default = setup(tmp_path)
    default.put("published", "pvp/letter/v1/fields/doc.csv", b"x", "text/csv")
    params = {
        "objects": [
            {"bucket": "published", "key": "pvp/letter/v1/fields/doc.csv", "target": "default"},
            {"bucket": "finance", "key": "fin/a.csv", "target": "finance-lake"},
        ],
        "graphs": [],
    }
    queue = FakeQueue(jobs=[background("withdraw", params)])
    run_once(queue, deps, "w1")
    assert queue.reviewed == [(background("withdraw", {}).id, "no publishing target finance-lake")]
    # Every target is resolved before anything is deleted: the default's object is still there.
    assert default.get_optional("published", "pvp/letter/v1/fields/doc.csv") == b"x"


def test_republish_delivers_to_the_target_of_the_jobs_version(tmp_path: Path) -> None:
    deps, default = setup(tmp_path)
    finance = two_targets(deps)
    v1 = {**TEMPLATE, "delivery": {**TEMPLATE["delivery"], "publishTo": "finance-lake"}}
    queue = FakeQueue(
        jobs=[background("republish", {"templateId": "letter"})],
        templates={("letter", 1): v1},
    )
    run_once(queue, deps, "w1")
    assert queue.finished, queue.reviewed or queue.failed
    [(_, published, target_id)] = queue.published
    assert target_id == "finance-lake"
    assert all(finance.get_optional("finance", o.key) for o in published)
    assert ("finance", "fin/" + graph_version_key(SHA, "letter", 1)) in finance.objects
    assert not default.objects
    registry = deps.graph_registry
    assert isinstance(registry, MemoryGraphRegistry)
    assert registry.current(SHA, "letter").target_id == "finance-lake"  # type: ignore[union-attr]


def test_a_live_output_spares_only_its_own_targets_object(tmp_path: Path) -> None:
    deps, default = setup(tmp_path)
    two_targets(deps)
    source = deps.delivered_jobs
    assert isinstance(source, MemoryRebuildSource)
    default.put("published", "pvp/letter/v1/fields/doc.csv", b"x", "text/csv")
    source.live.add(("finance-lake", "published", "pvp/letter/v1/fields/doc.csv"))
    queue = FakeQueue(jobs=[background("withdraw", {**WITHDRAW, "graphs": []})])
    run_once(queue, deps, "w1")
    assert queue.completed and not default.objects
