"""SHACL validation of a document's graph (ADR 0011 step 5)."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
from rdflib import Graph

from ingest_worker.llm.registry import ModelRegistry
from ingest_worker.pipeline import Buckets, DocumentError, PipelineDeps
from ingest_worker.rdf import GraphContext, render_graph, validate
from ingest_worker.shacl import load_graphs, outputs_by_property, validate_with_timeout
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore, ontology_normalized_key
from ingest_worker.template import Template

A = "https://acme.example/def/"
BASE = "https://data.acme.example/"

TEMPLATE: dict[str, Any] = {
    "id": "letter",
    "version": 1,
    "name": "Letter",
    "document": {"sections": [{"id": "all", "anchor": "\\A"}]},
    "outputs": {
        "fields": [
            {"id": "sender", "type": "text"},
            {"id": "kind", "type": "enum", "enum": ["memo", "letter"]},
            {"id": "pages", "type": "integer"},
        ],
        "tables": [{"id": "lines", "columns": [{"id": "sku", "type": "text"}]}],
    },
    "pipeline": [
        {
            "type": "extract",
            "id": "head",
            "fields": ["sender", "kind", "pages"],
            "sections": ["all"],
        },
        {"type": "extract", "id": "rows", "table": "lines", "sections": ["all"]},
    ],
    "semantics": {
        "prefixes": {"acme": A},
        "document": {"class": "acme:Letter"},
        "fields": {
            "sender": {"property": "acme:sentBy"},
            "kind": {"property": "acme:kind", "concepts": {"values": {"memo": "acme:Memo"}}},
            "pages": {"property": "acme:pages"},
        },
        "tables": {
            "lines": {
                "link": "acme:hasLine",
                "class": "acme:Line",
                "columns": {"sku": {"property": "acme:sku"}},
            }
        },
    },
}

SHAPES = f"""@prefix sh: <http://www.w3.org/ns/shacl#> .
@prefix acme: <{A}> .
acme:LetterShape a sh:NodeShape ; sh:targetClass acme:Letter ;
  sh:property [ sh:path acme:sentBy ; sh:minCount 1 ; sh:message "a letter names its sender" ] ;
  sh:property [ sh:path acme:kind ; sh:class acme:Kind ] ;
  sh:property [ sh:path acme:pages ; sh:maxInclusive 3 ; sh:severity sh:Warning ] .
acme:LineShape a sh:NodeShape ; sh:targetClass acme:Line ;
  sh:property [ sh:path acme:sku ; sh:minLength 3 ] .
"""
ONTOLOGY = f"""@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix acme: <{A}> .
acme:Memo a acme:Note .
acme:Note rdfs:subClassOf acme:Kind .
"""


def graph(**fields: Any) -> Graph:
    document = {
        "document_id": "d",
        "job_id": "j",
        "source_sha256": "ab12",
        "fields": {
            "sender": {"value": "Acme Ltd", "evidence": None, "page": None},
            "kind": {"value": "memo", "evidence": None, "page": None},
            "pages": {"value": 2, "evidence": None, "page": None},
            **{k: {"value": v, "evidence": None, "page": None} for k, v in fields.items()},
        },
        "tables": {"lines": [{"sku": "AB-1"}]},
        "issues": [],
        "models": {},
    }
    return render_graph(
        Template.model_validate(TEMPLATE),
        document,
        GraphContext(BASE, lambda _scheme, _label: None),
    )


def shapes() -> Graph:
    return Graph().parse(data=SHAPES, format="turtle")


def ontology() -> Graph:
    return Graph().parse(data=ONTOLOGY, format="turtle")


def by_property() -> dict[str, str]:
    return outputs_by_property(Template.model_validate(TEMPLATE))


def test_outputs_by_property_maps_fields_columns_and_links() -> None:
    assert by_property() == {
        f"{A}sentBy": "sender",
        f"{A}kind": "kind",
        f"{A}pages": "pages",
        f"{A}hasLine": "lines",
        f"{A}sku": "lines.sku",
    }


def test_outputs_by_property_takes_a_value_nodes_default_link() -> None:
    template = {
        **TEMPLATE,
        "semantics": {
            **TEMPLATE["semantics"],
            "valueNodes": {"link": "acme:hasCount", "value": "acme:numericValue"},
            "fields": {
                **TEMPLATE["semantics"]["fields"],
                "pages": {"node": {"class": "acme:PageCount"}},
            },
        },
    }
    mapped = outputs_by_property(Template.model_validate(template))
    assert mapped[f"{A}hasCount"] == "pages"
    assert f"{A}pages" not in mapped


def test_a_conforming_graph() -> None:
    report = validate(graph(), shapes(), ontology(), by_property())
    assert report.conforms
    assert report.violations() == []


def test_a_violation_names_its_output_and_message() -> None:
    report = validate(graph(sender=None), shapes(), ontology(), by_property())
    assert not report.conforms
    [violation] = report.violations()
    assert violation.output == "sender"
    assert violation.message == "a letter names its sender"
    assert violation.shape.endswith("LetterShape")
    assert violation.reason() == "SHACL: LetterShape on sender: a letter names its sender"


def test_sh_class_sees_subclasses_in_the_ontology_graph() -> None:
    # acme:Memo is an acme:Note, a subclass of acme:Kind: only the ontology graph says so.
    assert validate(graph(), shapes(), Graph(), by_property()).violations()
    assert not validate(graph(), shapes(), ontology(), by_property()).violations()


def test_warnings_are_not_violations() -> None:
    report = validate(graph(pages=9), shapes(), ontology(), by_property())
    assert report.conforms is False or report.violations() == []
    [warning] = [r for r in report.results if r.severity == "Warning"]
    assert warning.output == "pages"
    assert report.violations() == []


def test_a_violation_on_an_unmapped_path_names_the_path() -> None:
    extra = shapes().parse(
        data=f"""@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix acme: <{A}> .
        acme:Extra a sh:NodeShape ; sh:targetClass acme:Letter ;
          sh:property [ sh:path acme:signedBy ; sh:minCount 1 ] .""",
        format="turtle",
    )
    [violation] = validate(graph(), extra, ontology(), by_property()).violations()
    assert violation.output == f"{A}signedBy"


def test_the_report_as_json() -> None:
    report = validate(graph(sender=None), shapes(), ontology(), by_property())
    data = report.to_json()
    assert data["conforms"] is False
    [result] = data["results"]
    assert set(result) == {"severity", "shape", "focus", "path", "output", "message", "value"}
    assert result["severity"] == "Violation"


def test_load_graphs_reads_the_pinned_versions_normalized_triples(fixture_specs_dir: Path) -> None:
    store = MemoryObjectStore()
    deps = PipelineDeps(
        store=store,
        specs=load_specs(fixture_specs_dir),
        models=ModelRegistry({}, {}, {}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
    )
    store.put(
        "runs",
        ontology_normalized_key("acme-shapes", 1),
        shapes().serialize(format="nt", encoding="utf-8"),
        "application/n-triples",
    )
    loaded = load_graphs(deps, [("acme-shapes", 1)])
    assert len(loaded) == len(shapes())
    with pytest.raises(DocumentError, match="acme-shapes v2 is not available"):
        load_graphs(deps, [("acme-shapes", 2)])


def test_results_on_ontology_nodes_are_left_out() -> None:
    # The ontology's acme:Memo has no label: not the document's to fix, so never its violation.
    labelled = shapes().parse(
        data=f"""@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix acme: <{A}> .
        @prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
        acme:NoteShape a sh:NodeShape ; sh:targetClass acme:Note ;
          sh:property [ sh:path rdfs:label ; sh:minCount 1 ] .""",
        format="turtle",
    )
    report = validate(graph(), labelled, ontology(), by_property())
    assert report.results == [] and report.conforms


def test_validation_in_a_capped_child_process() -> None:
    report = validate_with_timeout(graph(sender=None), shapes(), ontology(), by_property(), 60)
    assert [v.output for v in report.violations()] == ["sender"]
    with pytest.raises(DocumentError, match="took longer than 0s"):
        validate_with_timeout(graph(), shapes(), ontology(), by_property(), 0)
