"""The per-output mapping matcher (spike, docs/design/mapping-automation.md): structure-aware
re-ranking of retrieval candidates, one narrow model choice per output, the value's publishing
derived from the chosen property, and confidence from agreeing signals."""

from __future__ import annotations

from typing import Any

import pytest

from ingest_worker.mapping_match import (
    ChoiceRequest,
    choice_prompt,
    choice_schema,
    propose,
    rerank,
)
from ingest_worker.mapping_stage import MappingInputs, outputs_of
from ingest_worker.ontology import parse_ontology

from .fakes import MemoryOntologyStore
from .test_mapping_stage import DRAFT, FIXTURE, PARAMS_MAPPING, PH

VERSIONS = [("pharma", 1)]


@pytest.fixture
def store() -> MemoryOntologyStore:
    s = MemoryOntologyStore()
    s.saved[("pharma", 1)] = parse_ontology(FIXTURE.read_bytes(), "text/turtle", "o.ttl")
    return s


def by_path() -> dict[str, Any]:
    return {o.path: o for o in outputs_of(DRAFT)}


def test_a_date_output_prefers_a_date_property_and_never_an_object_property(
    store: MemoryOntologyStore,
) -> None:
    expires = by_path()["expires"]
    ranked = rerank(
        store, VERSIONS, expires, [f"{PH}approvedBy", f"{PH}expiryDate", f"{PH}batchSize"], owner=[]
    )
    assert ranked[0].iri == f"{PH}expiryDate"
    approved = next(r for r in ranked if r.iri == f"{PH}approvedBy")
    assert "object property for a date" in approved.notes


def test_an_exact_label_or_synonym_is_a_strong_signal(store: MemoryOntologyStore) -> None:
    # "lot" is not the label of batchNumber, but the output's name "Lot number" is its synonym.
    lot = by_path()["lot"]
    ranked = rerank(store, VERSIONS, lot, [f"{PH}productName", f"{PH}batchNumber"], owner=[])
    assert ranked[0].iri == f"{PH}batchNumber"
    assert ranked[0].exact


def test_a_fitting_domain_lifts_a_property_but_a_different_one_never_sinks_it(
    store: MemoryOntologyStore,
) -> None:
    """Every field hangs off the document node, so a right property often has another domain
    (batchNumber's is Batch, the document a BatchRecord): domain fit may help, never hurt."""
    assay = by_path()["tests.assay"]
    fit = rerank(store, VERSIONS, assay, [f"{PH}testName"], owner=[f"{PH}TestResult"])[0]
    other = rerank(store, VERSIONS, assay, [f"{PH}testName"], owner=[f"{PH}Batch"])[0]
    assert fit.score > other.score
    assert other.score == rerank(store, VERSIONS, assay, [f"{PH}testName"], owner=[])[0].score


def test_deprecated_terms_are_dropped(store: MemoryOntologyStore) -> None:
    from dataclasses import replace

    parsed = store.saved[("pharma", 1)]
    terms = [replace(t, deprecated=True) if t.iri == f"{PH}batchSize" else t for t in parsed.terms]
    store.saved[("pharma", 1)] = replace(parsed, terms=terms)
    ranked = rerank(
        store, VERSIONS, by_path()["lot"], [f"{PH}batchSize", f"{PH}batchNumber"], owner=[]
    )
    assert [r.iri for r in ranked] == [f"{PH}batchNumber"]


def test_the_choice_schema_is_one_enum_per_output_with_none() -> None:
    request = ChoiceRequest(
        what="property",
        items=[("lot", ["a", "b"]), ("tests.ok", ["c"])],
    )
    schema = choice_schema(request)
    assert schema["properties"]["lot"] == {"type": "string", "enum": ["a", "b", "none"]}
    assert schema["required"] == ["lot", "tests.ok"]
    assert schema["additionalProperties"] is False


def test_the_choice_prompt_describes_outputs_and_options(store: MemoryOntologyStore) -> None:
    lot = by_path()["lot"]
    options = rerank(store, VERSIONS, lot, [f"{PH}batchNumber"], owner=[])
    text = choice_prompt("property", [(lot, options, ["G17230211"])])
    assert "lot (Lot number, text): The batch id" in text
    assert "seen: G17230211" in text
    assert f"{PH}batchNumber" in text and "batch number" in text and "also: lot number" in text


def fake_choose(answers: dict[str, str]) -> Any:
    def choose(request: ChoiceRequest) -> dict[str, str]:
        return {path: answers.get(path, "none") for path, _ in request.items}

    return choose


def described_tests() -> dict[str, Any]:
    """DRAFT with its table described, as a real recipe's would be: "tests" alone shares no word
    with "has result" (a retrieval miss the evaluation measures)."""
    outputs = dict(DRAFT["outputs"])
    table = outputs["tables"][0]
    columns = [
        {**c, "description": "Whether the result conforms"} if c["id"] == "ok" else c
        for c in table["columns"]
    ]
    outputs["tables"] = [
        {**table, "description": "Each test result of the batch", "columns": columns}
    ]
    return {**DRAFT, "outputs": outputs}


def test_an_output_retrieval_finds_nothing_for_stays_unmapped(store: MemoryOntologyStore) -> None:
    """DRAFT's boolean column "ok" has no description: no candidate, so no option and no call."""
    picks = propose(
        DRAFT,
        MappingInputs.model_validate(PARAMS_MAPPING),
        store,
        VERSIONS,
        choose=fake_choose({"tests.ok": f"{PH}conforms"}),
        embed=None,
    )
    assert picks["tests.ok"].term is None and picks["tests.ok"].candidates == ()


def test_propose_maps_every_output_and_derives_how_values_are_published(
    store: MemoryOntologyStore,
) -> None:
    answers = {
        "": f"{PH}BatchRecord",
        "lot": f"{PH}batchNumber",
        "expires": f"{PH}expiryDate",
        "form": f"{PH}dosageForm",
        "tests": f"{PH}hasResult",
        "tests#class": f"{PH}TestResult",
        "tests.assay": f"{PH}testName",
        "tests.ok": f"{PH}conforms",
    }
    draft = described_tests()
    picks = propose(
        draft,
        MappingInputs.model_validate(PARAMS_MAPPING),
        store,
        VERSIONS,
        choose=fake_choose(answers),
        embed=None,
    )
    assert (picks[""].term, picks[""].value_as) == (f"{PH}BatchRecord", "")
    assert picks["lot"].term == f"{PH}batchNumber" and picks["lot"].value_as == "literal"
    assert picks["tests"].term == f"{PH}hasResult" and picks["tests"].row_class == f"{PH}TestResult"
    assert picks["tests.ok"].term == f"{PH}conforms"
    # An exact synonym the model also picked as the top candidate: high confidence.
    assert picks["lot"].confidence == "high"
    for path, pick in picks.items():
        assert pick.term in pick.candidates or path == "tests", path


def test_an_object_property_publishes_an_entity_of_its_range(store: MemoryOntologyStore) -> None:
    draft = {
        **DRAFT,
        "outputs": {
            "fields": [{"id": "approver", "name": "Approved by", "type": "text"}],
            "tables": [],
        },
        "pipeline": [{"type": "extract", "id": "h", "fields": ["approver"], "sections": ["all"]}],
    }
    inputs = MappingInputs.model_validate({**PARAMS_MAPPING, "observed": {}})
    picks = propose(
        draft,
        inputs,
        store,
        VERSIONS,
        choose=fake_choose({"": f"{PH}BatchRecord", "approver": f"{PH}approvedBy"}),
        embed=None,
    )
    assert picks["approver"].value_as == "entity"
    assert picks["approver"].entity_class == f"{PH}Person"


def test_a_model_answer_outside_the_options_counts_as_none(store: MemoryOntologyStore) -> None:
    picks = propose(
        DRAFT,
        MappingInputs.model_validate(PARAMS_MAPPING),
        store,
        VERSIONS,
        choose=fake_choose({"": f"{PH}BatchRecord", "lot": "https://made.up/term"}),
        embed=None,
    )
    assert picks["lot"].term is None


def test_a_class_option_names_its_parents_and_the_prompt_prefers_the_specific(
    store: MemoryOntologyStore,
) -> None:
    document = by_path()[""]
    options = rerank(store, VERSIONS, document, [f"{PH}BatchRecord", f"{PH}Document"], owner=[])
    text = choice_prompt("class", [(document, options, [])])
    assert f"subclass of {PH}Document" in text
    assert "a subclass beats its parent" in text


def test_a_parent_class_picked_over_an_exact_offered_subclass_becomes_the_subclass(
    store: MemoryOntologyStore,
) -> None:
    """The "too general" error: the model picks Document though Batch record, its subclass and
    the exact label match, was offered first. The specific class is taken, at medium confidence."""
    draft = {**DRAFT, "name": "Batch record"}
    picks = propose(
        draft,
        MappingInputs.model_validate(PARAMS_MAPPING),
        store,
        VERSIONS,
        choose=fake_choose({"": f"{PH}Document"}),
        embed=None,
    )
    assert picks[""].term == f"{PH}BatchRecord"
    assert picks[""].confidence == "medium"
