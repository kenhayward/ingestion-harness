"""Operator commands for the triple store (ADR 0011 step 6): rebuild, backfill and re-mint."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from rdflib import Graph, URIRef

from ingest_worker.graph_registry import MemoryGraphRegistry
from ingest_worker.llm.registry import ModelRegistry
from ingest_worker.pipeline import Buckets, PipelineDeps, Target
from ingest_worker.rdf_rebuild import DeliveredJob, MemoryRebuildSource, backfill, rebuild, remint
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore, ontology_normalized_key
from ingest_worker.template import Template

from .fakes import FakeGraphStore, FakeQueue, FakeTargets, MemoryLinkedDataSettings

BASE = "https://data.acme.example/"
NEW_BASE = "https://data.acme.com/ct/"

TEMPLATE: dict[str, Any] = {
    "id": "letter",
    "version": 1,
    "name": "Letter",
    "document": {"sections": [{"id": "all", "anchor": "\\A"}]},
    "outputs": {"fields": [{"id": "sender", "type": "text"}]},
    "pipeline": [{"type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"]}],
}
MAPPED: dict[str, Any] = {
    **TEMPLATE,
    "version": 2,
    "delivery": {"formats": ["json", "rdf"]},
    "semantics": {
        "ontologies": [{"id": "acme", "version": 1}],
        "prefixes": {"acme": "https://acme.example/def/"},
        "document": {"class": "acme:Letter"},
        "fields": {
            "sender": {
                "property": "acme:sentBy",
                "object": {"class": "acme:Party", "iri": "party/{value|slug}"},
            }
        },
    },
}
ONTOLOGY = (
    b'<https://acme.example/def/Party> <http://www.w3.org/2000/01/rdf-schema#label> "Party" .\n'
)


def job(n: int, sha: str) -> DeliveredJob:
    return DeliveredJob(
        job_id=f"00000000-0000-4000-8000-00000000000{n}",
        document_id=f"10000000-0000-4000-8000-00000000000{n}",
        template_id="letter",
        template_version=1,
        sha256=sha,
        bucket="inbox",
        object_key=f"letter/v1/{n}.pdf",
    )


def setup(tmp_path: Path, *jobs: DeliveredJob) -> tuple[PipelineDeps, MemoryRebuildSource]:
    store, target = MemoryObjectStore(), MemoryObjectStore()
    deps = PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=ModelRegistry({}, {}, {}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        targets=FakeTargets({"default": Target(store=target, bucket="published", prefix="pvp/")}),
        linked_data=MemoryLinkedDataSettings(BASE),
        graph_registry=MemoryGraphRegistry(),
        graph_store=FakeGraphStore(),
    )
    store.put("runs", ontology_normalized_key("acme", 1), ONTOLOGY, "application/n-triples")
    for j in jobs:
        setup_reviewed(deps, j)
    source = MemoryRebuildSource(
        jobs=list(jobs),
        templates={1: TEMPLATE, 2: MAPPED},
    )
    return deps, source


def setup_reviewed(deps: PipelineDeps, j: DeliveredJob) -> None:
    reviewed = {
        "document_id": j.document_id,
        "job_id": j.job_id,
        "fields": {"sender": {"value": f"Sender {j.sha256[:2]}", "evidence": None, "page": 1}},
        "tables": {},
        "issues": [],
        "models": {"head": "main"},
        "review": {"reviewer": "kh"},
    }
    deps.store.put(
        "runs",
        f"{j.job_id}/reviewed-document.json",
        json.dumps(reviewed).encode(),
        "application/json",
    )


def store_of(deps: PipelineDeps) -> FakeGraphStore:
    assert isinstance(deps.graph_store, FakeGraphStore)
    return deps.graph_store


def registry_of(deps: PipelineDeps) -> MemoryGraphRegistry:
    assert isinstance(deps.graph_registry, MemoryGraphRegistry)
    return deps.graph_registry


def test_backfill_publishes_delivered_documents_with_the_newest_mapping(tmp_path: Path) -> None:
    deps, source = setup(tmp_path, job(1, "aa" * 32), job(2, "bb" * 32))
    lines = backfill(deps, FakeQueue(), source, "letter")
    assert lines[-1] == "backfill letter v2: 2 published, 0 skipped"
    current = registry_of(deps).all_current()
    assert [(g.sha256, g.version, g.template_version) for g in current] == [
        ("aa" * 32, 1, 2),
        ("bb" * 32, 1, 2),
    ]
    graph_iri = f"{BASE}graph/source/{'aa' * 32}/letter"
    body = store_of(deps).graphs[graph_iri]
    g = Graph().parse(data=body, format="turtle")
    assert (URIRef(f"{BASE}doc/{'aa' * 32}"), None, URIRef(f"{BASE}party/sender-aa")) in g
    assert f"{BASE}graph/ontology/acme/1" in store_of(deps).graphs  # the TBox came with it


def test_backfill_skips_documents_already_published_or_without_a_review(tmp_path: Path) -> None:
    deps, source = setup(tmp_path, job(1, "aa" * 32))
    backfill(deps, FakeQueue(), source, "letter")
    missing = job(3, "cc" * 32)
    source.jobs.append(missing)  # its reviewed document was never written
    lines = backfill(deps, FakeQueue(), source, "letter")
    assert lines[-1] == "backfill letter v2: 0 published, 2 skipped"
    assert registry_of(deps).current("aa" * 32, "letter").version == 1  # type: ignore[union-attr]


def test_backfill_needs_a_published_mapping(tmp_path: Path) -> None:
    deps, source = setup(tmp_path, job(1, "aa" * 32))
    source.templates = {1: TEMPLATE}
    assert backfill(deps, FakeQueue(), source, "letter") == [
        "letter has no published recipe with an ontology mapping that delivers rdf"
    ]


def test_rebuild_reloads_the_ontologies_and_the_current_graphs(tmp_path: Path) -> None:
    deps, source = setup(tmp_path, job(1, "aa" * 32))
    backfill(deps, FakeQueue(), source, "letter")
    store = store_of(deps)
    before = dict(store.graphs)
    store.graphs.clear()
    store.requests.clear()
    lines = rebuild(deps)
    assert store.graphs == before
    assert [r[0] for r in store.requests] == ["PUT", "PUT"]
    assert lines[-1] == "rebuild: 1 ontology graphs, 1 document graphs, 0 missing"


def test_remint_moves_every_graph_under_the_new_base(tmp_path: Path) -> None:
    deps, source = setup(tmp_path, job(1, "aa" * 32))
    backfill(deps, FakeQueue(), source, "letter")
    old = f"{BASE}graph/source/{'aa' * 32}/letter"
    deps.linked_data = MemoryLinkedDataSettings(NEW_BASE)
    lines = remint(deps, FakeQueue(), source)
    new = f"{NEW_BASE}graph/source/{'aa' * 32}/letter"
    store = store_of(deps)
    assert old not in store.graphs and new in store.graphs
    assert f"{NEW_BASE}graph/ontology/acme/1" in store.graphs
    current = registry_of(deps).current("aa" * 32, "letter")
    assert current is not None and (current.graph_iri, current.version) == (new, 2)
    assert current.template_version == 2  # the mapping version the graph was rendered with
    assert lines[-1] == f"remint under {NEW_BASE}: 1 re-minted, 0 already there, 0 failed"
    assert (
        remint(deps, FakeQueue(), source)[-1]
        == f"remint under {NEW_BASE}: 0 re-minted, 1 already there, 0 failed"
    )


def test_the_templates_are_read_as_recipes() -> None:
    Template.model_validate(MAPPED)  # the fixture is a valid recipe


def test_backfill_ignores_mappings_that_do_not_deliver_rdf(tmp_path: Path) -> None:
    deps, source = setup(tmp_path, job(1, "aa" * 32))
    source.templates = {1: TEMPLATE, 2: {**MAPPED, "delivery": {"formats": ["json"]}}}
    assert backfill(deps, FakeQueue(), source, "letter") == [
        "letter has no published recipe with an ontology mapping that delivers rdf"
    ]
    assert store_of(deps).requests == []


def test_backfill_reads_a_document_delivered_without_review(tmp_path: Path) -> None:
    from ingest_worker.storage import output_key

    direct = job(4, "dd" * 32)
    deps, source = setup(tmp_path, direct)
    reviewed = deps.store.get("runs", f"{direct.job_id}/reviewed-document.json")
    deps.store.delete("runs", f"{direct.job_id}/reviewed-document.json")
    draft = output_key("letter", 1, "document", direct.document_id, "json")
    deps.store.put("outputs", draft, reviewed, "application/json")
    assert backfill(deps, FakeQueue(), source, "letter")[-1].endswith("1 published, 0 skipped")


def test_remint_drops_the_old_graph_first_and_a_failure_is_retried_by_the_next_run(
    tmp_path: Path,
) -> None:
    from ingest_worker.graph_store import GraphStoreUnavailable

    deps, source = setup(tmp_path, job(1, "aa" * 32), job(2, "bb" * 32))
    backfill(deps, FakeQueue(), source, "letter")
    deps.linked_data = MemoryLinkedDataSettings(NEW_BASE)
    store_of(deps).fail = GraphStoreUnavailable("graph store answered 503")
    lines = remint(deps, FakeQueue(), source)
    assert lines[-1] == f"remint under {NEW_BASE}: 0 re-minted, 0 already there, 2 failed"
    assert all(g.base_iri == BASE for g in registry_of(deps).all_current())
    store_of(deps).fail = None
    assert remint(deps, FakeQueue(), source)[-1] == (
        f"remint under {NEW_BASE}: 2 re-minted, 0 already there, 0 failed"
    )
    assert not any(iri.startswith(f"{BASE}graph/source/") for iri in store_of(deps).graphs)


# --- publishing targets: the job's own recipe version decides where copies go -----------------


def to_finance(deps: PipelineDeps, source: MemoryRebuildSource) -> MemoryObjectStore:
    """v1 (the jobs' version) names finance-lake (prefix fin/); its store."""
    assert isinstance(deps.targets, FakeTargets)
    finance = MemoryObjectStore()
    deps.targets.targets["finance-lake"] = Target(finance, "finance", "fin/", "finance-lake")
    source.templates[1] = {**TEMPLATE, "delivery": {"publishTo": "finance-lake"}}
    return finance


def default_store(deps: PipelineDeps) -> MemoryObjectStore:
    assert isinstance(deps.targets, FakeTargets)
    store = deps.targets.targets["default"].store
    assert isinstance(store, MemoryObjectStore)
    return store


def test_backfill_publishes_to_the_target_of_the_jobs_version(tmp_path: Path) -> None:
    from ingest_worker.storage import graph_version_key

    deps, source = setup(tmp_path, job(1, "aa" * 32))
    finance = to_finance(deps, source)
    assert backfill(deps, FakeQueue(), source, "letter")[-1].endswith("1 published, 0 skipped")
    assert ("finance", "fin/" + graph_version_key("aa" * 32, "letter", 1)) in finance.objects
    assert not default_store(deps).objects
    [current] = registry_of(deps).all_current()
    assert current.target_id == "finance-lake"


def test_rebuild_reads_each_copy_from_its_recorded_target(tmp_path: Path) -> None:
    deps, source = setup(tmp_path, job(1, "aa" * 32), job(2, "bb" * 32))
    backfill(deps, FakeQueue(), source, "letter")  # both to the default
    finance = to_finance(deps, source)
    source.jobs.append(job(3, "cc" * 32))
    setup_reviewed(deps, job(3, "cc" * 32))
    backfill(deps, FakeQueue(), source, "letter")  # the third to finance-lake
    assert len(finance.objects) == 1
    store = store_of(deps)
    before = dict(store.graphs)
    store.graphs.clear()
    lines = rebuild(deps)
    assert store.graphs == before
    assert lines[-1] == "rebuild: 1 ontology graphs, 3 document graphs, 0 missing"


def test_remint_publishes_to_the_target_of_the_jobs_version(tmp_path: Path) -> None:
    deps, source = setup(tmp_path, job(1, "aa" * 32))
    finance = to_finance(deps, source)
    backfill(deps, FakeQueue(), source, "letter")
    deps.linked_data = MemoryLinkedDataSettings(NEW_BASE)
    remint(deps, FakeQueue(), source)
    current = registry_of(deps).current("aa" * 32, "letter")
    assert current is not None and current.version == 2 and current.target_id == "finance-lake"
    assert len(finance.objects) == 2 and not default_store(deps).objects
