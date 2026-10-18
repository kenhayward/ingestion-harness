from __future__ import annotations

import json
from decimal import Decimal
from typing import Any

import pytest
from rdflib import RDF, RDFS, XSD, Graph, Literal, URIRef
from rdflib.compare import isomorphic

from ingest_worker.config import REPO_ROOT
from ingest_worker.linked_data import effective_base_iri
from ingest_worker.rdf import CT, PROV, GraphContext, mint_entity_iri, render_graph, slug, to_turtle
from ingest_worker.template import Template

BASE = "https://data.acme.example/ct/"
SHA = "ab12"
ACME = "https://acme.example/def/"

TEMPLATE: dict[str, Any] = {
    "id": "letter",
    "version": 3,
    "name": "Letter",
    "document": {"sections": [{"id": "head", "anchor": "\\A"}, {"id": "body", "anchor": "^Body"}]},
    "outputs": {
        "fields": [
            {"id": "sender", "type": "text"},
            {"id": "kind", "type": "enum", "enum": ["memo", "letter"]},
            {"id": "pages", "type": "integer"},
            {"id": "amount", "type": "decimal"},
            {"id": "sent", "type": "date"},
            {"id": "urgent", "type": "boolean"},
            {"id": "tags", "type": "list"},
            {"id": "stage", "type": "text"},
        ],
        "tables": [
            {
                "id": "lines",
                "columns": [{"id": "sku", "type": "text"}, {"id": "qty", "type": "integer"}],
            }
        ],
    },
    "pipeline": [
        {
            "type": "extract",
            "id": "head",
            "fields": ["sender", "kind", "pages", "amount", "sent", "urgent", "tags", "stage"],
            "sections": ["head"],
        },
        {"type": "extract", "id": "rows", "table": "lines", "sections": ["body"]},
    ],
    "semantics": {
        "ontologies": [{"id": "acme", "version": 1}],
        "prefixes": {"acme": ACME},
        "document": {"class": "acme:Letter"},
        "fields": {
            "sender": {
                "property": "acme:sentBy",
                "object": {"class": "acme:Party", "iri": "party/{value|slug}"},
            },
            "kind": {"property": "acme:kind", "concepts": {"values": {"memo": "acme:Memo"}}},
            "pages": {"property": "acme:pages"},
            "amount": {"property": "acme:amount"},
            "sent": {"property": "acme:sent"},
            "urgent": {"property": "acme:urgent"},
            "tags": {"property": "acme:tag"},
            "stage": {
                "property": "acme:stage",
                "concepts": {"scheme": "acme:Stages", "match": "label"},
            },
        },
        "tables": {
            "lines": {
                "link": "acme:hasLine",
                "class": "acme:Line",
                "iri": "line/{sku|upper}",
                "columns": {"sku": {"property": "acme:sku"}},
            }
        },
    },
}


def document(**over: Any) -> dict[str, Any]:
    doc: dict[str, Any] = {
        "document_id": "d-1",
        "job_id": "j-1",
        "source_sha256": SHA,
        "template": {"id": "letter", "version": 3, "name": "Letter"},
        "extracted_at": "2026-10-14T10:00:00+00:00",
        "models": {"head": "local/qwen", "rows": "local/qwen"},
        "fields": {
            "sender": {
                "value": "Ünïcorn Labs Ltd",
                "evidence": "From: Ünïcorn Labs Ltd",
                "page": 1,
            },
            "kind": {"value": "memo", "evidence": "MEMO", "page": 1},
            "pages": {"value": 2, "evidence": "2 pages", "page": 1},
            "amount": {"value": 12.5, "evidence": "12.50", "page": 2},
            "sent": {"value": "2023-02-11", "evidence": "11/02/2023", "page": 1},
            "urgent": {"value": True, "evidence": "URGENT", "page": 1},
            "tags": {"value": ["a", "b"], "evidence": "a, b", "page": 2},
            "stage": {"value": "Granulation", "evidence": "Granulation", "page": 2},
        },
        "tables": {"lines": [{"sku": "ab-1", "qty": 3}, {"sku": "", "qty": 4}]},
        "issues": [],
    }
    doc.update(over)
    return doc


def concepts(scheme: str, label: str) -> str | None:
    if scheme == ACME + "Stages" and label.lower() == "granulation":
        return ACME + "Granulation"
    return None


def render(template: dict[str, Any] | None = None, **over: Any) -> Graph:
    return render_graph(
        Template.model_validate(template or TEMPLATE),
        document(**over),
        GraphContext(BASE, concepts),
    )


DOC = URIRef(f"{BASE}doc/{SHA}")


def one(g: Graph, s: Any, p: Any) -> Any:
    [value] = list(g.objects(s, p))
    return value


def test_the_document_and_its_typed_literals() -> None:
    g = render()
    assert (DOC, RDF.type, URIRef(ACME + "Letter")) in g
    assert one(g, DOC, URIRef(ACME + "pages")) == Literal(2, datatype=XSD.integer)
    assert one(g, DOC, URIRef(ACME + "amount")) == Literal(Decimal("12.5"), datatype=XSD.decimal)
    assert one(g, DOC, URIRef(ACME + "sent")) == Literal("2023-02-11", datatype=XSD.date)
    assert one(g, DOC, URIRef(ACME + "urgent")) == Literal(True)
    assert set(g.objects(DOC, URIRef(ACME + "tag"))) == {Literal("a"), Literal("b")}


def test_entities_get_readable_iris_and_keep_their_values_as_labels() -> None:
    g = render()
    party = URIRef(f"{BASE}party/unicorn-labs-ltd")
    assert one(g, DOC, URIRef(ACME + "sentBy")) == party
    assert (party, RDF.type, URIRef(ACME + "Party")) in g
    assert one(g, party, RDFS.label) == Literal("Ünïcorn Labs Ltd")


def test_concepts_by_value_and_by_label() -> None:
    g = render()
    assert one(g, DOC, URIRef(ACME + "kind")) == URIRef(ACME + "Memo")
    assert one(g, DOC, URIRef(ACME + "stage")) == URIRef(ACME + "Granulation")


def test_an_unmatched_concept_is_a_literal_with_an_issue() -> None:
    fields = document()["fields"] | {"stage": {"value": "Drying", "evidence": "Drying", "page": 2}}
    g = render(fields=fields)
    assert one(g, DOC, URIRef(ACME + "stage")) == Literal("Drying")
    fact = URIRef(f"{BASE}doc/{SHA}/fact/letter/stage")
    assert "no concept" in str(one(g, fact, CT.normalisationIssue))


def test_rows_get_readable_iris_or_document_scoped_ones() -> None:
    g = render()
    rows = list(g.objects(DOC, URIRef(ACME + "hasLine")))
    assert URIRef(f"{BASE}line/AB-1") in rows
    # An empty key value: the row is named under the document instead.
    assert URIRef(f"{BASE}doc/{SHA}/letter/lines/2") in rows
    # Unmapped columns use the recipe's default vocabulary.
    qty = URIRef(f"{BASE}def/letter/lines.qty")
    assert one(g, URIRef(f"{BASE}line/AB-1"), qty) == Literal(3, datatype=XSD.integer)


def test_unmapped_outputs_use_the_default_vocabulary() -> None:
    template = json.loads(json.dumps(TEMPLATE))
    del template["semantics"]["fields"]["pages"]
    g = render(template)
    assert one(g, DOC, URIRef(f"{BASE}def/letter/pages")) == Literal(2, datatype=XSD.integer)


def test_facts_record_page_quote_section_and_step() -> None:
    g = render()
    fact = URIRef(f"{BASE}doc/{SHA}/fact/letter/sent")
    assert (fact, RDF.type, CT.Evidence) in g
    assert one(g, fact, CT.subject) == DOC
    assert one(g, fact, CT.property) == URIRef(ACME + "sent")
    page = URIRef(f"{BASE}doc/{SHA}/page/1")
    assert one(g, fact, CT.page) == page
    assert one(g, page, CT.pageNumber) == Literal(1, datatype=XSD.integer)
    assert one(g, fact, CT.quote) == Literal("11/02/2023")
    assert one(g, fact, CT.section) == URIRef(f"{BASE}doc/{SHA}/letter/section/head")
    assert one(g, fact, CT.step) == Literal("head")
    row_fact = URIRef(f"{BASE}doc/{SHA}/fact/letter/lines/1")
    assert one(g, row_fact, CT.section) == URIRef(f"{BASE}doc/{SHA}/letter/section/body")


def test_a_value_that_failed_normalisation_is_a_plain_literal() -> None:
    fields = document()["fields"] | {"pages": {"value": None, "evidence": "two", "page": 1}}
    issues = [
        {
            "step": "head",
            "target": "pages",
            "row": None,
            "column": None,
            "raw": "two",
            "message": "not an integer",
        }
    ]
    g = render(fields=fields, issues=issues)
    assert one(g, DOC, URIRef(ACME + "pages")) == Literal("two")
    fact = URIRef(f"{BASE}doc/{SHA}/fact/letter/pages")
    assert one(g, fact, CT.normalisationIssue) == Literal("not an integer")


def test_empty_values_add_nothing() -> None:
    fields = document()["fields"] | {"sender": {"value": None, "evidence": None, "page": None}}
    g = render(fields=fields)
    assert list(g.objects(DOC, URIRef(ACME + "sentBy"))) == []
    assert (URIRef(f"{BASE}doc/{SHA}/fact/letter/sender"), None, None) not in g


def test_provenance() -> None:
    reviewed = {"reviewer": "Jane", "reviewed_at": "2026-10-14T11:00:00+00:00"}
    g = render(review=reviewed, published_at="2026-10-14T11:01:00+00:00")
    job = URIRef(f"{BASE}job/j-1")
    assert one(g, DOC, PROV.wasGeneratedBy) == job
    assert one(g, DOC, URIRef("http://purl.org/dc/terms/source")) == URIRef(f"urn:sha256:{SHA}")
    assert one(g, job, CT.recipeVersion) == Literal(3, datatype=XSD.integer)
    assert one(g, job, CT.reviewedBy) == Literal("Jane")
    assert one(g, job, CT.baseIri) == Literal(BASE)
    assert one(g, job, PROV.endedAtTime) == Literal(
        "2026-10-14T11:01:00+00:00", datatype=XSD.dateTime
    )


def test_turtle_is_stable_and_round_trips() -> None:
    first, second = to_turtle(render()), to_turtle(render())
    assert first == second
    assert b"@prefix acme: <https://acme.example/def/>" in first
    assert isomorphic(Graph().parse(data=first, format="turtle"), render())


@pytest.mark.parametrize(
    ("template", "values", "iri"),
    [
        ("party/{value|slug}", {"value": "Ünïcorn  Labs, Ltd."}, f"{BASE}party/unicorn-labs-ltd"),
        ("line/{sku|upper}", {"sku": "ab 1"}, f"{BASE}line/AB%201"),
        (
            "batch/{site|slug}/{lot}",
            {"site": "Site 1", "lot": "PV/23"},
            f"{BASE}batch/site-1/PV%2F23",
        ),
        ("https://other.example/{value}", {"value": "x"}, "https://other.example/x"),
        ("party/{value|slug}", {"value": ""}, None),
        ("party/{value|slug}", {"value": None}, None),
        ("party/{value|slug}", {"value": "!!!"}, None),
    ],
)
def test_mint_entity_iri(template: str, values: dict[str, Any], iri: str | None) -> None:
    assert mint_entity_iri(BASE, template, values) == iri


def test_slug() -> None:
    assert slug("  Café_Ontologie v2.1 ") == "cafe-ontologie-v2-1"


BASE_FIXTURE = json.loads(
    (REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "base-iri.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize("case", BASE_FIXTURE["effective"])
def test_effective_base_matches_the_shared_fixture(case: dict[str, Any]) -> None:
    assert effective_base_iri(case["customerSlug"], case["baseIri"]) == case["base"]


def test_rendering_reports_the_entities_it_minted_with_their_key_values() -> None:
    from ingest_worker.graph_registry import EntityRecord
    from ingest_worker.rdf import render as render_with_entities

    rendering = render_with_entities(
        Template.model_validate(TEMPLATE), document(), GraphContext(BASE, concepts)
    )
    assert isomorphic(rendering.graph, render())
    # The document node is not an entity; the row without a key value mints none.
    assert rendering.entities == [
        EntityRecord(f"{BASE}line/AB-1", ACME + "Line", ["ab-1"]),
        EntityRecord(f"{BASE}party/unicorn-labs-ltd", ACME + "Party", ["Ünïcorn Labs Ltd"]),
    ]


@pytest.mark.parametrize(
    ("template", "values", "key"),
    [
        (
            "batch/{site|slug}/{batch|upper}",
            {"site": "Site 1", "batch": "pv-1"},
            ["Site 1", "pv-1"],
        ),
        ("party/{value}", {"value": " Acme "}, ["Acme"]),
        ("https://x.example/{a}", {"a": 3}, ["3"]),
    ],
)
def test_entity_key(template: str, values: dict[str, Any], key: list[str]) -> None:
    from ingest_worker.rdf import entity_key

    assert entity_key(template, values) == key


def test_with_version_states_the_graph_version_on_a_copy() -> None:
    from ingest_worker.rdf import DCTERMS, with_version

    g = render()
    versioned = with_version(g, 3, "2026-10-14T10:00:00+00:00")
    name = URIRef(f"{BASE}graph/source/{SHA}/letter")
    assert versioned.identifier == name
    assert one(versioned, name, CT.graphVersion) == Literal(3, datatype=XSD.integer)
    assert one(versioned, name, DCTERMS.modified) == Literal(
        "2026-10-14T10:00:00+00:00", datatype=XSD.dateTime
    )
    assert len(versioned) == len(g) + 2
    assert (name, CT.graphVersion, None) not in g


GOLDEN = REPO_ROOT / "worker" / "tests" / "fixtures" / "rdf" / "letter-graph.ttl"


def test_an_existing_recipe_renders_byte_identical_turtle() -> None:
    """Today's mappings (entities, concepts, a readable row IRI, an unmapped column, evidence)
    render exactly as before value nodes existed. Never regenerate the fixture to make this pass;
    `IH_REGEN_GOLDEN=1` writes it, for a deliberate change of every graph."""
    import os

    turtle = to_turtle(render())
    if os.environ.get("IH_REGEN_GOLDEN") == "1":
        GOLDEN.parent.mkdir(parents=True, exist_ok=True)
        GOLDEN.write_bytes(turtle)
    assert turtle == GOLDEN.read_bytes()


# --- value nodes ------------------------------------------------------------------------------


def node_template(**fields: dict[str, Any]) -> dict[str, Any]:
    """TEMPLATE with value-node defaults, `qty` as a node with a unit, and `fields` mapped."""
    template = json.loads(json.dumps(TEMPLATE))
    semantics = template["semantics"]
    semantics["valueNodes"] = {
        "link": "acme:hasResult",
        "value": "acme:numericValue",
        "unitProperty": "acme:unit",
    }
    semantics["fields"] |= fields
    semantics["tables"]["lines"]["columns"]["qty"] = {
        "node": {"class": "acme:Quantity", "unit": "acme:Each"}
    }
    return template


HAS_RESULT = URIRef(ACME + "hasResult")
NUMERIC = URIRef(ACME + "numericValue")


def field_node(field: str) -> URIRef:
    return URIRef(f"{BASE}doc/{SHA}/letter/value/{field}")


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("pages", Literal(2, datatype=XSD.integer)),
        ("amount", Literal(Decimal("12.5"), datatype=XSD.decimal)),
        ("sent", Literal("2023-02-11", datatype=XSD.date)),
        ("urgent", Literal(True)),
        ("sender", Literal("Ünïcorn Labs Ltd")),
        ("kind", Literal("memo")),
    ],
)
def test_a_value_node_carries_the_typed_literal(field: str, value: Literal) -> None:
    g = render(node_template(**{field: {"node": {"class": "acme:Measure"}}}))
    node = field_node(field)
    assert node in set(g.objects(DOC, HAS_RESULT))
    assert (node, RDF.type, URIRef(ACME + "Measure")) in g
    assert one(g, node, NUMERIC) == value
    assert one(g, node, CT.output) == Literal(field)
    # The plain property of the old mapping is gone.
    assert list(g.objects(DOC, URIRef(ACME + field))) == []


def test_a_unit_is_added_only_when_set() -> None:
    g = render(node_template(pages={"node": {"class": "acme:PageCount"}}))
    assert list(g.objects(field_node("pages"), URIRef(ACME + "unit"))) == []
    qty = URIRef(f"{BASE}doc/{SHA}/letter/lines/1/qty")
    assert one(g, qty, URIRef(ACME + "unit")) == URIRef(ACME + "Each")


def test_a_value_nodes_own_terms_beat_the_defaults() -> None:
    mapping = {
        "property": "acme:counted",
        "node": {"class": "acme:PageCount", "value": "acme:count", "unit": "acme:Page"},
    }
    g = render(node_template(pages=mapping))
    node = field_node("pages")
    assert one(g, DOC, URIRef(ACME + "counted")) == node
    assert one(g, node, URIRef(ACME + "count")) == Literal(2, datatype=XSD.integer)
    assert one(g, node, URIRef(ACME + "unit")) == URIRef(ACME + "Page")


@pytest.mark.parametrize("empty", [None, ""])
def test_an_empty_value_publishes_no_node_and_no_link(empty: Any) -> None:
    fields = document()["fields"] | {"pages": {"value": empty, "evidence": None, "page": None}}
    g = render(node_template(pages={"node": {"class": "acme:PageCount"}}), fields=fields)
    assert list(g.objects(DOC, HAS_RESULT)) == []
    assert (field_node("pages"), None, None) not in g


def test_a_failed_normalisation_puts_the_raw_text_on_the_node() -> None:
    fields = document()["fields"] | {"pages": {"value": None, "evidence": "two", "page": 1}}
    issues = [
        {"step": "head", "target": "pages", "row": None, "column": None, "raw": "two",
         "message": "not an integer"},
    ]  # fmt: skip
    g = render(
        node_template(pages={"node": {"class": "acme:PageCount"}}), fields=fields, issues=issues
    )
    assert one(g, field_node("pages"), NUMERIC) == Literal("two")
    fact = URIRef(f"{BASE}doc/{SHA}/fact/letter/pages")
    assert one(g, fact, CT.normalisationIssue) == Literal("not an integer")


def test_a_field_nodes_evidence_points_at_the_node() -> None:
    g = render(node_template(pages={"node": {"class": "acme:PageCount"}}))
    fact = URIRef(f"{BASE}doc/{SHA}/fact/letter/pages")
    assert one(g, fact, CT.property) == HAS_RESULT
    assert one(g, fact, CT.value) == field_node("pages")


def test_value_nodes_scope_to_the_document_under_a_readable_row() -> None:
    g = render(node_template())
    row = URIRef(f"{BASE}line/AB-1")  # a readable row IRI, an entity other documents may share
    qty = URIRef(f"{BASE}doc/{SHA}/letter/lines/1/qty")
    assert one(g, row, HAS_RESULT) == qty
    assert (qty, RDF.type, URIRef(ACME + "Quantity")) in g
    assert one(g, qty, NUMERIC) == Literal(3, datatype=XSD.integer)
    assert one(g, qty, CT.output) == Literal("lines.qty")
    second = URIRef(f"{BASE}doc/{SHA}/letter/lines/2")
    assert one(g, second, HAS_RESULT) == URIRef(f"{BASE}doc/{SHA}/letter/lines/2/qty")


def test_rendering_lists_its_value_nodes_and_mints_no_entities_for_them() -> None:
    from ingest_worker.rdf import render as render_with_entities

    rendering = render_with_entities(
        Template.model_validate(node_template(pages={"node": {"class": "acme:PageCount"}})),
        document(),
        GraphContext(BASE, concepts),
    )
    assert rendering.nodes == {
        str(field_node("pages")): "pages",
        f"{BASE}doc/{SHA}/letter/lines/1/qty": "lines.qty",
        f"{BASE}doc/{SHA}/letter/lines/2/qty": "lines.qty",
    }
    assert all("/value/" not in e.iri and "/qty" not in e.iri for e in rendering.entities)


def test_value_node_iris_follow_the_base() -> None:
    from ingest_worker.rdf import value_node_iri

    other = "https://data.other.example/"
    assert (
        value_node_iri(other, SHA, "letter", "pages", None)
        == f"{other}doc/{SHA}/letter/value/pages"
    )
    assert (
        value_node_iri(other, SHA, "letter", "lines.qty", 4)
        == f"{other}doc/{SHA}/letter/lines/4/qty"
    )
