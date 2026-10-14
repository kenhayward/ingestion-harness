from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
from rdflib import Graph, Literal, URIRef

from ingest_worker.graph_preview import run_graph_preview
from ingest_worker.llm.registry import ModelRegistry
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, DocumentError, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore, graph_preview_key, reviewed_document_key

from .fakes import FakeQueue, MemoryLinkedDataSettings

BASE = "https://data.acme.example/"
DEFINITION: dict[str, Any] = {
    "id": "letter",
    "version": 2,
    "name": "Letter",
    "document": {"sections": [{"id": "all", "anchor": "\\A"}]},
    "outputs": {"fields": [{"id": "sender", "type": "text"}]},
    "pipeline": [{"type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"]}],
    "semantics": {
        "prefixes": {"ex": "https://ex.example/def/"},
        "document": {"class": "ex:Letter"},
        "fields": {"sender": {"property": "ex:sender"}},
    },
}


def sample(n: int) -> dict[str, Any]:
    return {
        "sampleId": f"s{n}",
        "jobId": f"run-{n}",
        "fileName": f"s{n}.pdf",
        "sha256": f"{n:064x}",
        "documentKey": f"letter/v1/document/doc-{n}.json",
    }


def draft(sender: str) -> bytes:
    return json.dumps(
        {
            "document_id": "doc",
            "job_id": "run",
            "template": {"id": "letter", "version": 1, "name": "Letter"},
            "fields": {"sender": {"value": sender, "evidence": None, "page": None}},
            "tables": {},
            "issues": [],
            "models": {"head": "local/qwen"},
        }
    ).encode()


def job(**params: Any) -> ClaimedJob:
    return ClaimedJob(
        "g1",
        None,
        "",
        0,
        "",
        "",
        None,
        0,
        1,  # type: ignore[arg-type]
        task="graph",
        project_id="letter",
        params={"samples": [sample(1), sample(2)], "definition": DEFINITION, **params},
    )


def make(
    fixture_specs_dir: Path, base: str | None = BASE
) -> tuple[PipelineDeps, MemoryObjectStore]:
    store = MemoryObjectStore()
    deps = PipelineDeps(
        store=store,
        specs=load_specs(fixture_specs_dir),
        models=ModelRegistry({}, {}, {}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        linked_data=MemoryLinkedDataSettings(base),
    )
    store.put("outputs", sample(1)["documentKey"], draft("Draft Ltd"), "application/json")
    store.put("outputs", sample(2)["documentKey"], draft("Second Ltd"), "application/json")
    store.put("runs", reviewed_document_key("run-2"), draft("Reviewed Ltd"), "application/json")
    return deps, store


def sender_of(turtle: str, sha: str) -> list[Any]:
    graph = Graph().parse(data=turtle, format="turtle")
    return list(graph.objects(URIRef(f"{BASE}doc/{sha}"), URIRef("https://ex.example/def/sender")))


def test_renders_each_run_with_the_draft_mapping(fixture_specs_dir: Path) -> None:
    deps, store = make(fixture_specs_dir)
    result = run_graph_preview(job(), deps, FakeQueue())
    assert [s["sampleId"] for s in result["samples"]] == ["s1", "s2"]
    one, two = result["samples"]
    assert one["fileName"] == "s1.pdf" and one["triples"] > 0
    assert sender_of(one["turtle"], sample(1)["sha256"]) == [Literal("Draft Ltd")]
    # An approved run's reviewed document wins over its draft.
    assert sender_of(two["turtle"], sample(2)["sha256"]) == [Literal("Reviewed Ltd")]
    stored = json.loads(store.get("runs", graph_preview_key("letter", "g1")))
    assert stored == result


def test_a_missing_document_is_left_out(fixture_specs_dir: Path) -> None:
    deps, store = make(fixture_specs_dir)
    store.delete("outputs", sample(1)["documentKey"])
    queue = FakeQueue()
    result = run_graph_preview(job(), deps, queue)
    assert [s["sampleId"] for s in result["samples"]] == ["s2"]
    assert any(e[2] == "graph preview skipped a sample" for e in queue.events)


@pytest.mark.parametrize(
    ("base", "params", "message"),
    [
        (None, {}, "set the customer on the Linked data page"),
        (BASE, {"definition": {**DEFINITION, "semantics": None}}, "no ontology mapping"),
        (BASE, {"definition": {"id": "letter"}}, "invalid graph preview parameters"),
    ],
)
def test_problems_go_to_review(
    fixture_specs_dir: Path, base: str | None, params: dict[str, Any], message: str
) -> None:
    deps, _ = make(fixture_specs_dir, base)
    with pytest.raises(DocumentError, match=message):
        run_graph_preview(job(**params), deps, FakeQueue())


def test_the_worker_runs_graph_jobs(fixture_specs_dir: Path) -> None:
    deps, store = make(fixture_specs_dir)
    queue = FakeQueue(jobs=[job()])
    run_once(queue, deps, "w1")
    assert queue.completed
    assert ("runs", graph_preview_key("letter", "g1")) in store.objects


def test_a_preview_carries_each_samples_shacl_report(fixture_specs_dir: Path) -> None:
    from ingest_worker.storage import ontology_normalized_key

    deps, store = make(fixture_specs_dir)
    shapes = Graph().parse(
        data="""@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <https://ex.example/def/> .
        ex:S a sh:NodeShape ; sh:targetClass ex:Letter ;
          sh:property [ sh:path ex:sender ; sh:maxLength 9 ] .""",
        format="turtle",
    )
    store.put(
        "runs",
        ontology_normalized_key("s", 1),
        shapes.serialize(format="nt", encoding="utf-8"),
        "x",
    )
    definition = {
        **DEFINITION,
        "semantics": {**DEFINITION["semantics"], "shapes": [{"id": "s", "version": 1}]},
    }
    result = run_graph_preview(job(definition=definition), deps, FakeQueue())
    one, two = result["samples"]
    assert one["report"]["conforms"] is True  # "Draft Ltd"
    assert two["report"]["conforms"] is False  # "Reviewed Ltd" is longer than 9
    assert run_graph_preview(job(), deps, FakeQueue())["samples"][0]["report"] is None
