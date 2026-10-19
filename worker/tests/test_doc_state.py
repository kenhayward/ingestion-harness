"""State passed between a recipe's steps (docs/design/worker-nodes-refactor.md, part 2):
normalise_step returns a StepOutcome, DocState.apply returns a new state, nothing is shared."""

from __future__ import annotations

import copy
from typing import Any

import pytest

from ingest_worker.template import ExtractStep, Template
from ingest_worker.template_pipeline import (
    DocState,
    StepOutcome,
    normalise_step,
    step_inputs,
)

from .test_template_pipeline import TEMPLATE

RECIPE = Template.model_validate(TEMPLATE)


def step(step_id: str) -> ExtractStep:
    found = next(s for s in RECIPE.extract_steps() if s.id == step_id)
    return found


HEADER = {
    "product": {"value": "Richfer capsules", "evidence": "Product: Richfer", "page": 1},
    "kind": {"value": "protocol", "evidence": None, "page": None},
}
ROWS = {"rows": [{"batch": "G1", "value": "137·8", "aliases": []}, {"batch": "G2", "value": "x"}]}


def test_a_field_step_becomes_fields_and_the_result_checks_read() -> None:
    data = copy.deepcopy(HEADER)
    outcome = normalise_step(RECIPE, step("header"), data, model="local/qwen")
    product = {"value": "Richfer capsules", "evidence": "Product: Richfer", "page": 1}
    kind = {"value": "protocol", "evidence": None, "page": None}
    assert outcome == StepOutcome(
        step_id="header",
        result={"product": product, "kind": kind},
        fields={"product": product, "kind": kind},
        tables={},
        issues=(),
        model="local/qwen",
    )
    assert data == HEADER  # the model's reply is read, never changed


def test_a_value_that_cannot_be_normalised_is_kept_and_listed() -> None:
    outcome = normalise_step(RECIPE, step("data"), copy.deepcopy(ROWS))
    assert outcome.tables == {
        "results": [
            {"batch": "G1", "value": 137.8, "aliases": []},
            {"batch": "G2", "value": "x", "aliases": []},
        ]
    }
    assert outcome.result == {"rows": outcome.tables["results"]}
    [issue] = outcome.issues
    assert issue["step"] == "data" and issue["target"] == "results"
    assert (issue["row"], issue["column"], issue["raw"]) == (2, "value", "x")


def test_apply_returns_a_new_state_and_leaves_the_old_one_alone() -> None:
    start = DocState(issues=({"step": "segment", "message": "no key"},))
    header = normalise_step(RECIPE, step("header"), copy.deepcopy(HEADER), model="m1")
    data = normalise_step(RECIPE, step("data"), copy.deepcopy(ROWS), model="m2")

    state = start.apply(header).apply(data)

    assert start == DocState(issues=({"step": "segment", "message": "no key"},))
    assert list(state.fields) == ["product", "kind"]
    assert list(state.tables) == ["results"]
    assert [i["step"] for i in state.issues] == ["segment", "data"]
    assert state.step_results == {"header": header.result, "data": data.result}
    assert state.models == {"header": "m1", "data": "m2"}


def test_a_step_run_again_replaces_its_values_in_place() -> None:
    first = DocState().apply(normalise_step(RECIPE, step("header"), copy.deepcopy(HEADER)))
    first = first.apply(normalise_step(RECIPE, step("date"), {"executed_on": {"value": None}}))
    again: dict[str, Any] = copy.deepcopy(HEADER)
    again["product"]["value"] = "Ferric capsules"

    state = first.apply(normalise_step(RECIPE, step("header"), again, model="m3"))

    assert list(state.fields) == ["product", "kind", "executed_on"]  # order kept
    assert state.fields["product"]["value"] == "Ferric capsules"
    assert first.fields["product"]["value"] == "Richfer capsules"
    assert state.models == {"header": "m3"}


def test_a_check_result_is_both_a_check_and_a_step_result() -> None:
    result = {"rows": [{"value": "G1", "status": "matched"}]}
    state = DocState().with_check("batch_check", result)
    assert state.checks == {"batch_check": result}
    assert state.step_results == {"batch_check": result}


def test_a_stored_draft_becomes_a_state() -> None:
    document = {
        "fields": {"product": {"value": "A"}},
        "tables": {"results": [{"batch": "G1"}]},
        "checks": {"batch_check": {"rows": []}},
        "issues": [{"step": "data"}],
        "models": {"header": "m1"},
        "review_required": True,
    }
    state = DocState.from_document(document)
    assert state == DocState(
        fields={"product": {"value": "A"}},
        tables={"results": [{"batch": "G1"}]},
        checks={"batch_check": {"rows": []}},
        issues=({"step": "data"},),
        models={"header": "m1"},
    )
    assert DocState.from_document({"fields": {}, "tables": {}}) == DocState()


def late_step(context: dict[str, str]) -> dict[str, Any]:
    """An extract step after header and data, in place of `date` (each output has one step)."""
    return {
        "type": "extract",
        "id": "late",
        "fields": ["executed_on"],
        "sections": ["head"],
        "context": context,
    }


@pytest.mark.parametrize(
    ("context", "inputs"),
    [
        ({}, []),
        ({"product": "product"}, ["header"]),
        ({"batches": "results.batch", "product": "product"}, ["header", "data"]),
    ],
)
def test_step_inputs_name_the_earlier_steps_a_step_reads(
    context: dict[str, str], inputs: list[str]
) -> None:
    header, _, data, check = TEMPLATE["pipeline"]
    pipeline = [header, data, late_step(context), check]
    recipe = Template.model_validate({**TEMPLATE, "pipeline": pipeline})
    late = next(s for s in recipe.extract_steps() if s.id == "late")
    assert step_inputs(recipe, late) == inputs
