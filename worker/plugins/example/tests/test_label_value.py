"""A plugin author's own tests: the contract (`check_plugin`), the settings rules, and what `run`
answers for some text, through `plugin_context` (no worker, database or model needed)."""

from __future__ import annotations

from typing import Any

import pytest
from ct_plugin_example import LABEL_VALUE

from ingest_worker.plugins import check_plugin, plugin_context
from ingest_worker.template import Template

RECIPE = Template.model_validate(
    {
        "id": "letter",
        "version": 1,
        "name": "Letter",
        "document": {"sections": [{"id": "head", "anchor": r"\A"}]},
        "outputs": {
            "fields": [{"id": "reference", "type": "text"}, {"id": "dated", "type": "date"}]
        },
        "pipeline": [
            {
                "type": "plugin",
                "id": "labels",
                "uses": "example.label_value@1",
                "fields": ["reference", "dated"],
                "sections": ["head"],
                "with": {"labels": {"reference": "Our ref", "dated": "Date"}},
            }
        ],
    }
)
STEP = RECIPE.plugin_steps()[0]


def run(text: str, **with_: Any) -> dict[str, Any]:
    step = STEP.model_copy(update={"with_": with_ or STEP.with_})
    settings = LABEL_VALUE.settings_for(RECIPE, step)
    ctx = plugin_context(RECIPE, step, {"head": text})
    return LABEL_VALUE.run(ctx, settings)


def test_the_plugin_keeps_the_contract() -> None:
    assert check_plugin(LABEL_VALUE) == []


def test_each_field_takes_the_rest_of_its_labelled_line() -> None:
    out = run("[page 1]\nACME LTD\nOur ref: INV-4021\n[page 2]\nDate  2026-03-01\n")
    assert out["reference"] == {"value": "INV-4021", "evidence": "Our ref: INV-4021", "page": 1}
    assert out["dated"] == {"value": "2026-03-01", "evidence": "Date  2026-03-01", "page": 2}


def test_a_label_not_found_is_an_empty_value() -> None:
    assert run("nothing here")["reference"] == {"value": None, "evidence": None, "page": None}


@pytest.mark.parametrize(
    ("with_", "error"),
    [
        ({"labels": {"nope": "Ref"}}, "'nope' is not a field of this step"),
        ({"labels": {"reference": " "}}, "reference: the label is empty"),
        ({"labels": {}, "colour": "red"}, "colour: Extra inputs are not permitted"),
    ],
)
def test_bad_settings_say_what_is_wrong(with_: dict[str, Any], error: str) -> None:
    step = STEP.model_copy(update={"with_": with_})
    with pytest.raises(ValueError, match=error):
        LABEL_VALUE.settings_for(RECIPE, step)
