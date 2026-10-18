"""The per-output matcher on a class-centric ontology (value nodes, docs/design/value-node-mapping.md):
an AFO-shaped vocabulary where the meaning is in data classes under information content entity
(IAO), beside processes, qualities and roles with similar labels, and generic link and value
properties. Covers the fixes found on the covalidation gold (docs/design/mapping-automation.md)."""

from __future__ import annotations

from typing import Any

from ingest_worker.mapping_match import ChoiceRequest, class_queries, propose, rerank
from ingest_worker.mapping_stage import MappingInputs, outputs_of
from ingest_worker.ontology import parse_ontology

from .fakes import MemoryOntologyStore

EX = "https://ex.example/afo#"
OBO = "http://purl.obolibrary.org/obo/"
VERSIONS = [("afo", 1)]
ONTOLOGY = f"""
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .
@prefix obo: <{OBO}> .
@prefix ex: <{EX}> .
obo:IAO_0000030 a owl:Class ; rdfs:label "information content entity" .
obo:BFO_0000015 a owl:Class ; rdfs:label "process" .
obo:BFO_0000019 a owl:Class ; rdfs:label "quality" .
ex:Report a owl:Class ; rdfs:label "study report" ; rdfs:subClassOf obo:IAO_0000030 .
ex:Datum a owl:Class ; rdfs:label "datum" ; rdfs:subClassOf obo:IAO_0000030 .
ex:AssayResult a owl:Class ; rdfs:label "assay result" ; rdfs:subClassOf ex:Datum .
ex:Assay a owl:Class ; rdfs:label "assay" ; rdfs:subClassOf obo:BFO_0000015 .
ex:MassFraction a owl:Class ; rdfs:label "mass fraction" ; rdfs:subClassOf ex:Datum .
ex:WaterMassFraction a owl:Class ; rdfs:label "water mass fraction" ;
    rdfs:subClassOf ex:MassFraction .
ex:Composition a owl:Class ; rdfs:label "composition" ; rdfs:subClassOf obo:BFO_0000019 .
ex:AbsoluteWaterContent a owl:Class ; rdfs:label "absolute water content" ;
    rdfs:subClassOf ex:Datum .
ex:ArithmeticMean a owl:Class ; rdfs:label "arithmetic mean" ; rdfs:subClassOf ex:Datum .
ex:ArithmeticMeanRole a owl:Class ; rdfs:label "arithmetic mean role" ;
    rdfs:subClassOf ex:Datum .
ex:ResultRow a owl:Class ; rdfs:label "result row" ; rdfs:subClassOf ex:Datum .
ex:Identifier a owl:Class ; rdfs:label "identifier" ; rdfs:subClassOf ex:Datum .
ex:BatchIdentifier a owl:Class ; rdfs:label "batch identifier" ; rdfs:subClassOf ex:Identifier .
ex:SupplierLotNumber a owl:Class ; rdfs:label "supplier lot number" ;
    rdfs:subClassOf ex:BatchIdentifier .
obo:IAO_0000028 a owl:Class ; rdfs:label "symbol" ; rdfs:subClassOf obo:IAO_0000030 .
ex:LotNumber a owl:Class ; rdfs:label "lot number" ; rdfs:subClassOf obo:IAO_0000028 .
ex:hasDataOutput a owl:ObjectProperty ; rdfs:label "has data output" ;
    rdfs:range obo:IAO_0000030 .
ex:hasOutputMaterial a owl:ObjectProperty ; rdfs:label "has output material" .
ex:hasResultPart a owl:ObjectProperty ; rdfs:label "has result part" .
ex:hasValue a owl:DatatypeProperty ; rdfs:label "has value" .
ex:hasNumericValue a owl:DatatypeProperty ; rdfs:label "has numeric value" ;
    rdfs:range xsd:double .
ex:assayValue a owl:DatatypeProperty ; rdfs:label "assay value" ; rdfs:range xsd:decimal .
"""

FIELDS = [
    {"id": "assay", "name": "Assay (%)", "type": "decimal", "description": "Numeric assay value."},
    {"id": "water_content_kf", "name": "Water Content by KF (% w/w)", "type": "decimal",
     "description": "Numeric value if present."},
    {"id": "mean_percent", "name": "Mean (%)", "type": "decimal",
     "description": "Mean dissolution percentage."},
]  # fmt: skip
DRAFT: dict[str, Any] = {
    "id": "stability",
    "version": 1,
    "name": "Study report",
    "document": {"sections": [{"id": "all", "anchor": "\\A"}]},
    "outputs": {
        "fields": FIELDS,
        "tables": [
            {
                "id": "results",
                "name": "Results",
                "description": "Each result row of the study, with its value",
                "columns": [
                    {
                        "id": "batch_number",
                        "name": "Batch Number",
                        "type": "text",
                        "description": "Batch identifier this row belongs to.",
                    },
                    {
                        "id": "assay",
                        "name": "Assay (%)",
                        "type": "decimal",
                        "description": "Numeric value; null if below reporting threshold.",
                    },
                    {
                        "id": "assay_below_threshold",
                        "name": "Assay Below Threshold",
                        "type": "boolean",
                        "description": "True if the cell shows a '<' value (e.g. '<0.05').",
                    },
                ],
            }
        ],
    },
    "pipeline": [
        {"type": "extract", "id": "h", "fields": [f["id"] for f in FIELDS], "sections": ["all"]},
        {"type": "extract", "id": "r", "table": "results", "sections": ["all"]},
    ],
}
INPUTS = MappingInputs.model_validate(
    {"versions": [{"id": "afo", "version": 1, "localOnly": False, "label": "AFO"}], "observed": {}}
)
DEFAULTS = {
    "#valueNodes.link": f"{EX}hasDataOutput",
    "#valueNodes.value": f"{EX}hasNumericValue",
}


def store() -> MemoryOntologyStore:
    s = MemoryOntologyStore()
    s.saved[("afo", 1)] = parse_ontology(ONTOLOGY.encode(), "text/turtle", "afo.ttl")
    return s


def run(answers: dict[str, str]) -> tuple[list[ChoiceRequest], dict[str, Any]]:
    """propose() with a chooser that answers from `answers`, a table's link and row class with
    their first option, and records every request."""
    requests: list[ChoiceRequest] = []

    def choose(request: ChoiceRequest) -> dict[str, str]:
        requests.append(request)
        out = {}
        for path, options in request.items:
            first = options[0] if options and path.startswith("results") and "." not in path else ""
            out[path] = answers.get(path, first or "none")
        return out

    return requests, propose(DRAFT, INPUTS, store(), VERSIONS, choose=choose, embed=None)


def options_for(requests: list[ChoiceRequest], path: str) -> list[str]:
    return next(dict(r.items)[path] for r in requests if path in dict(r.items))


def output(path: str) -> Any:
    return next(o for o in outputs_of(DRAFT) if o.path == path)


def test_value_node_defaults_are_not_offered_as_rival_options() -> None:
    requests, _ = run(DEFAULTS)
    for path in ("assay", "water_content_kf", "mean_percent", "results.assay"):
        options = options_for(requests, path)
        assert f"{EX}hasNumericValue" not in options, path
        assert f"{EX}hasDataOutput" not in options, path


def test_a_value_node_keeps_the_default_link_after_a_table_is_mapped() -> None:
    """A table's link must never become the value nodes' link (a variable was reused)."""
    _, picks = run({**DEFAULTS, "results.assay": f"{EX}AssayResult"})
    assert picks["results"].term is not None
    assert picks["results.assay"].value_as == "node"
    assert picks["results.assay"].term == f"{EX}hasDataOutput"


def test_node_classes_prefer_data_classes_to_processes_qualities_and_roles() -> None:
    s = store()
    assay = rerank(
        s, VERSIONS, output("assay"), [f"{EX}Assay", f"{EX}AssayResult"], owner=[], node=True
    )
    assert assay[0].iri == f"{EX}AssayResult"
    assert any("process" in n for n in assay[1].notes)
    mean = rerank(
        s,
        VERSIONS,
        output("mean_percent"),
        [f"{EX}ArithmeticMeanRole", f"{EX}ArithmeticMean"],
        owner=[],
        node=True,
    )
    assert mean[0].iri == f"{EX}ArithmeticMean"
    water = rerank(
        s,
        VERSIONS,
        output("water_content_kf"),
        [f"{EX}Composition", f"{EX}WaterMassFraction"],
        owner=[],
        node=True,
    )
    assert water[0].iri == f"{EX}WaterMassFraction"
    # Without node=True (a table's row class, the document's class) nothing changes.
    plain = rerank(s, VERSIONS, output("assay"), [f"{EX}Assay", f"{EX}AssayResult"], owner=[])
    assert plain[0].iri == f"{EX}Assay"


def test_class_queries_try_the_bare_name_a_result_and_the_units_quantity() -> None:
    assay = class_queries(output("assay"), [])
    assert "Assay result" in assay and "Assay" in assay
    water = class_queries(output("water_content_kf"), [])
    assert "Water Content by KF" in water
    assert "mass fraction" in water  # % w/w is a mass fraction
    assert class_queries(output("mean_percent"), [])[0].startswith(
        "Mean (%)"
    )  # the full query first


def test_class_options_find_the_result_and_the_quantity_classes() -> None:
    requests, _ = run(DEFAULTS)
    assert f"{EX}AssayResult" in options_for(requests, "assay")
    assert f"{EX}WaterMassFraction" in options_for(requests, "water_content_kf")
    assert options_for(requests, "assay")[0] == f"{EX}AssayResult"  # a decimal: classes first


def test_the_default_link_and_value_prefer_their_own_phrases_and_a_data_range() -> None:
    requests, _ = run({})
    assert options_for(requests, "#valueNodes.link")[0] == f"{EX}hasDataOutput"
    # Either generic value property will do; both come before a property named for an output.
    assert set(options_for(requests, "#valueNodes.value")[:2]) == {
        f"{EX}hasValue",
        f"{EX}hasNumericValue",
    }


def test_an_identifier_class_is_an_entity_shared_across_documents() -> None:
    """An identifier names a thing other documents name too: one entity per value, not a value
    node per row. A class under "identifier" (or IAO's symbol, as a lot number) is an entity."""
    requests, picks = run({**DEFAULTS, "results.batch_number": f"{EX}BatchIdentifier"})
    assert f"{EX}BatchIdentifier" in options_for(requests, "results.batch_number")
    pick = picks["results.batch_number"]
    assert (pick.value_as, pick.entity_class) == ("entity", f"{EX}BatchIdentifier")
    assert pick.term == f"{EX}hasDataOutput"


def test_identifier_classes_are_found_by_their_ancestors() -> None:
    from ingest_worker.mapping_match import _Terms, is_identifier

    terms = _Terms(store(), VERSIONS)
    assert is_identifier(terms, f"{EX}BatchIdentifier")  # under a class labelled "identifier"
    assert is_identifier(terms, f"{EX}LotNumber")  # under IAO symbol
    assert not is_identifier(terms, f"{EX}AssayResult")


def test_a_qualifier_column_is_left_unmapped_without_asking() -> None:
    """A boolean flag on a sibling value ("<0.05" below the reporting threshold) qualifies that
    value; until value nodes carry qualifiers it is left unmapped, by rule, at high confidence."""
    requests, picks = run(DEFAULTS)
    assert all("results.assay_below_threshold" not in dict(r.items) for r in requests)
    pick = picks["results.assay_below_threshold"]
    assert (pick.term, pick.confidence) == (None, "high")


def test_qualifier_columns_need_a_sibling_they_qualify() -> None:
    from ingest_worker.mapping_match import qualifier_of

    columns = [o for o in outputs_of(DRAFT) if o.path.startswith("results.")]
    flag = next(o for o in columns if o.path == "results.assay_below_threshold")
    assert qualifier_of(flag, columns) == "results.assay"
    alone = [o for o in columns if o.path != "results.assay"]
    assert qualifier_of(flag, alone) is None
    assay = next(o for o in columns if o.path == "results.assay")
    assert qualifier_of(assay, columns) is None


def confirming(first: dict[str, str], second: dict[str, str]) -> tuple[list[ChoiceRequest], Any]:
    """A chooser answering `first` on a question's first asking and `second` when the same
    outputs are asked again (options reversed); tables take their first option."""
    requests: list[ChoiceRequest] = []
    asked: set[tuple[str, ...]] = set()

    def choose(request: ChoiceRequest) -> dict[str, str]:
        requests.append(request)
        key = tuple(p for p, _ in request.items)
        answers = second if key in asked else first
        asked.add(key)
        out = {}
        for path, options in request.items:
            table = path.startswith("results") and "." not in path
            out[path] = answers.get(path, options[0] if table and options else "none")
        return out

    return requests, choose


def test_confirmation_asks_again_with_the_options_reversed() -> None:
    requests, choose = confirming(DEFAULTS, DEFAULTS)
    propose(DRAFT, INPUTS, store(), VERSIONS, choose=choose, embed=None, confirm=True)
    for path in ("assay", "results.assay"):
        asked = [dict(r.items)[path] for r in requests if path in dict(r.items)]
        assert len(asked) == 2 and asked[1] == list(reversed(asked[0])), path


def test_a_confirmed_pick_goes_up_a_tier_and_a_changed_one_is_low() -> None:
    pick = {"assay": f"{EX}AssayResult", "water_content_kf": f"{EX}WaterMassFraction"}
    again = {"assay": f"{EX}AssayResult", "water_content_kf": f"{EX}MassFraction"}
    _, plain = run({**DEFAULTS, **pick})
    _, choose = confirming({**DEFAULTS, **pick}, {**DEFAULTS, **again})
    confirmed = propose(DRAFT, INPUTS, store(), VERSIONS, choose=choose, embed=None, confirm=True)
    up = {"low": "medium", "medium": "high", "high": "high"}
    assert confirmed["assay"].confidence == up[plain["assay"].confidence]
    assert confirmed["water_content_kf"].confidence == "low"
    assert confirmed["water_content_kf"].entity_class == f"{EX}WaterMassFraction"  # first answer


def test_without_confirmation_each_question_is_asked_once() -> None:
    requests, _ = run(DEFAULTS)
    assert sum("assay" in dict(r.items) for r in requests) == 1


def test_a_class_too_general_for_the_name_becomes_its_retrieved_subclass() -> None:
    """The "too general" error: water content picked as *mass fraction* while *water mass
    fraction*, its subclass sharing the output's word "water", was retrieved but not among the
    few options shown. The subclass is taken, at medium confidence."""
    _, picks = run({**DEFAULTS, "water_content_kf": f"{EX}MassFraction"})
    pick = picks["water_content_kf"]
    assert (pick.entity_class, pick.confidence) == (f"{EX}WaterMassFraction", "medium")


def test_a_specific_pick_is_kept() -> None:
    _, picks = run({**DEFAULTS, "assay": f"{EX}AssayResult"})
    assert picks["assay"].entity_class == f"{EX}AssayResult"


def test_narrowing_never_takes_a_subclass_adding_words_the_name_lacks() -> None:
    """*supplier lot number* shares "number" with "Batch Number" but adds "supplier" and "lot":
    another concept, not a narrower reading of *batch identifier*."""
    from ingest_worker.mapping_match import _narrower, _Terms

    s = store()
    batch = output("results.batch_number")
    retrieved = rerank(
        s, VERSIONS, batch, [f"{EX}BatchIdentifier", f"{EX}SupplierLotNumber"], owner=[], node=True
    )
    assert _narrower(f"{EX}BatchIdentifier", retrieved, batch, _Terms(s, VERSIONS)) is None


def test_narrowing_finds_a_subclass_anywhere_in_the_retrieved_classes() -> None:
    """`_narrower` reads every retrieved class, the options shown or not: propose passes it the
    union of all class queries' results, not only the fused best few."""
    from ingest_worker.mapping_match import _narrower, _Terms

    s = store()
    retrieved = rerank(
        s,
        VERSIONS,
        output("water_content_kf"),
        [f"{EX}MassFraction", f"{EX}Composition", f"{EX}ArithmeticMean", f"{EX}WaterMassFraction"],
        owner=[],
        node=True,
    )
    terms = _Terms(s, VERSIONS)
    water = output("water_content_kf")
    assert _narrower(f"{EX}MassFraction", retrieved, water, terms) == f"{EX}WaterMassFraction"
    assert _narrower(f"{EX}WaterMassFraction", retrieved, water, terms) is None
    # A subclass that shares no word of the name is no narrower answer.
    assay = output("assay")
    assert _narrower(f"{EX}MassFraction", retrieved, assay, terms) is None


def test_a_class_sharing_no_word_with_the_name_is_never_high() -> None:
    requests, picks = run({**DEFAULTS, "mean_percent": f"{EX}AssayResult"})
    assert f"{EX}AssayResult" in options_for(requests, "mean_percent")
    assert picks["mean_percent"].value_as == "node"
    assert picks["mean_percent"].confidence != "high"
