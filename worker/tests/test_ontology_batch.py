"""Ontology imports from a folder or zip: merged into one version, or one version per file."""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.llm.registry import ModelRegistry
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore, ontology_normalized_key

from .fakes import FakeQueue, MemoryOntologyStore

CORE = b"""@prefix owl: <http://www.w3.org/2002/07/owl#> .
<https://w3id.org/idmp/core> a owl:Ontology .
<https://w3id.org/idmp/core#Product> a owl:Class .
"""
PROD = b"""@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<https://w3id.org/idmp/prod> a owl:Ontology ;
  owl:imports <https://w3id.org/idmp/core>, <https://w3id.org/external> .
<https://w3id.org/idmp/prod#Medicine> a owl:Class ;
  rdfs:subClassOf <https://w3id.org/idmp/core#Product> .
"""
BAD = b"this is { not turtle"
FILES = {"idmp/core.ttl": CORE, "idmp/sub/prod.ttl": PROD, "idmp/bad.ttl": BAD}


def make(fixture_specs_dir: Path) -> tuple[PipelineDeps, MemoryOntologyStore]:
    store = MemoryObjectStore()
    for name, data in FILES.items():
        store.put("runs", f"src/{name}", data, "text/turtle")
    ontologies = MemoryOntologyStore()
    deps = PipelineDeps(
        store=store,
        specs=load_specs(fixture_specs_dir),
        models=ModelRegistry({}, {}, {}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        ontologies=ontologies,
    )
    return deps, ontologies


def job(params: dict[str, Any]) -> ClaimedJob:
    return ClaimedJob(
        "job-b", "", "", 0, "", "", None, 1, 3, task="ontology", params=params
    )  # fmt: skip


def source(name: str) -> dict[str, str]:
    return {"sourceKey": f"src/{name}", "fileName": name, "mediaType": "text/turtle"}


def merged(*names: str) -> dict[str, Any]:
    return {
        "ontologyId": "idmp",
        "version": 1,
        "fileName": "idmp",
        "sources": [source(n) for n in names],
    }


def member(oid: str, name: str) -> dict[str, Any]:
    return {"ontologyId": oid, "version": 1, **source(name)}


def entry(entries: list[dict[str, Any]], iri: str) -> dict[str, Any]:
    return next(e for e in entries if e["iri"] == iri)


def test_merged_files_are_one_version_whose_inner_imports_are_included(
    fixture_specs_dir: Path,
) -> None:
    deps, ontologies = make(fixture_specs_dir)
    queue = FakeQueue(jobs=[job(merged("idmp/sub/prod.ttl", "idmp/core.ttl"))])
    run_once(queue, deps, "w1")
    assert queue.completed and ontologies.status[("idmp", 1)] == "ready"
    parsed = ontologies.saved[("idmp", 1)]
    iris = {t.iri for t in parsed.terms}
    assert {"https://w3id.org/idmp/core#Product", "https://w3id.org/idmp/prod#Medicine"} <= iris
    assert all(t.defined_in is None for t in parsed.terms)  # all its own
    assert parsed.ontology_iris == ["https://w3id.org/idmp/core", "https://w3id.org/idmp/prod"]
    core = entry(parsed.import_entries, "https://w3id.org/idmp/core")
    assert core["resolution"] == "included" and core["reason"] is None
    external = entry(parsed.import_entries, "https://w3id.org/external")
    assert external["resolution"] == "unresolved"
    normalized = deps.store.get("runs", ontology_normalized_key("idmp", 1))
    assert b"core#Product" in normalized and b"prod#Medicine" in normalized


def test_a_merged_version_fails_on_a_file_it_cannot_read(fixture_specs_dir: Path) -> None:
    deps, ontologies = make(fixture_specs_dir)
    queue = FakeQueue(jobs=[job(merged("idmp/core.ttl", "idmp/bad.ttl"))])
    run_once(queue, deps, "w1")
    assert queue.reviewed and "idmp/bad.ttl" in queue.reviewed[0][1]
    assert ontologies.status[("idmp", 1)] == "failed"


def test_one_version_per_file_resolves_imports_between_them_in_any_order(
    fixture_specs_dir: Path,
) -> None:
    deps, ontologies = make(fixture_specs_dir)
    members = [member("idmp-prod", "idmp/sub/prod.ttl"), member("idmp-core", "idmp/core.ttl")]
    queue = FakeQueue(jobs=[job({"members": members})])
    run_once(queue, deps, "w1")
    assert queue.completed
    assert ontologies.status[("idmp-prod", 1)] == ontologies.status[("idmp-core", 1)] == "ready"
    prod = ontologies.saved[("idmp-prod", 1)]
    core = entry(prod.import_entries, "https://w3id.org/idmp/core")
    assert (core["resolution"], core["ontologyId"], core["version"]) == ("library", "idmp-core", 1)
    product = next(t for t in prod.terms if t.iri == "https://w3id.org/idmp/core#Product")
    assert product.defined_in == "idmp-core@1"
    assert deps.store.get_optional("runs", ontology_normalized_key("idmp-core", 1))
    indexed = [d for _, _, m, d in queue.event_details if m == "ontology indexed"]
    assert len(indexed) == 2


def test_one_unreadable_file_fails_only_its_own_version(fixture_specs_dir: Path) -> None:
    deps, ontologies = make(fixture_specs_dir)
    members = [member("idmp-core", "idmp/core.ttl"), member("idmp-bad", "idmp/bad.ttl")]
    queue = FakeQueue(jobs=[job({"members": members})])
    run_once(queue, deps, "w1")
    assert queue.completed and not queue.reviewed
    assert ontologies.status[("idmp-core", 1)] == "ready"
    assert ontologies.status[("idmp-bad", 1)] == "failed"
    assert "idmp/bad.ttl" in ontologies.errors[("idmp-bad", 1)]


@pytest.mark.parametrize(
    "params",
    [
        {"members": []},
        {"members": [member("a-b", "idmp/core.ttl")], "sourceKey": "src/x"},
        {**merged(), "sources": []},
        {**merged("idmp/core.ttl"), "sourceKey": "src/x"},
        {"members": [member("a-b", "idmp/core.ttl")], "ontologyId": "x", "version": 1},
    ],
)
def test_params_name_exactly_one_kind_of_source(
    fixture_specs_dir: Path, params: dict[str, Any]
) -> None:
    deps, _ = make(fixture_specs_dir)
    queue = FakeQueue(jobs=[job(params)])
    run_once(queue, deps, "w1")
    assert "invalid ontology import parameters" in queue.reviewed[0][1]


@pytest.mark.integration
def test_pg_store_finds_a_version_by_any_of_its_ontology_iris() -> None:
    """Needs IH_TEST_DATABASE_URL with db/migrations applied."""
    url = os.environ.get("IH_TEST_DATABASE_URL")
    if not url:
        pytest.skip("IH_TEST_DATABASE_URL not set")
    import psycopg

    from ingest_worker.ontology import PgOntologyStore, index_graph, read_graph

    conn = psycopg.connect(url, autocommit=True)
    conn.execute("DELETE FROM ontologies WHERE id = 'idmp-merged'")
    conn.execute("INSERT INTO ontologies (id, label) VALUES ('idmp-merged', 'IDMP')")
    conn.execute(
        """INSERT INTO ontology_versions (ontology_id, version, file_name, media_type, source_kind)
           VALUES ('idmp-merged', 1, 'idmp', '', 'files')"""
    )
    store = PgOntologyStore(conn)
    graph = read_graph(CORE, "text/turtle", "core.ttl", max_triples=1000)
    graph.parse(data=PROD, format="turtle")
    store.save("idmp-merged", 1, index_graph(graph))
    assert store.find_ready("https://w3id.org/idmp/prod") == ("idmp-merged", 1)
    assert store.find_ready("https://w3id.org/idmp/core") == ("idmp-merged", 1)
    conn.execute("DELETE FROM ontologies WHERE id = 'idmp-merged'")
    conn.close()
