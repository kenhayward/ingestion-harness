"""Change stages: flat model output -> typed changes, validated against the draft."""

from __future__ import annotations

from typing import Any

import pytest

from ingest_worker.draft_stages import (
    OUTPUTS,
    REVISE,
    REVISE_SCHEMA,
    SECTIONS,
    STEPS,
    Stage,
    resolve_answers,
)
from ingest_worker.drafting import SURVEY_SCHEMA

DRAFT: dict[str, Any] = {
    "id": "letter",
    "version": 2,
    "name": "Letter",
    "document": {"sections": [{"id": "all", "anchor": "\\A"}]},
    "outputs": {"fields": [], "tables": []},
    "pipeline": [],
}


def output_item(**kw: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "op": "putField",
        "id": "sender",
        "name": None,
        "type": "text",
        "description": "Who wrote it",
        "enum": None,
        "columns": None,
        "reason": "r",
    }
    return {**base, **kw}


def step_item(**kw: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "op": "putStep",
        "id": "head",
        "type": "extract",
        "fields": ["sender"],
        "table": None,
        "sections": ["all"],
        "instructions": "Top of page 1",
        "pageImages": None,
        "chunkPages": None,
        "context": None,
        "description": None,
        "values": None,
        "reference": None,
        "aliases": None,
        "preamble": None,
        "reason": "r",
    }
    return {**base, **kw}


def run(
    stage: Stage, data: dict[str, Any], draft: dict[str, Any] = DRAFT
) -> tuple[dict[str, Any], list[str]]:
    assert stage.convert is not None and stage.check is not None
    body, errors = stage.convert(data)
    return body, errors or stage.check(body, draft)


def test_outputs_convert_fields_and_tables_to_typed_changes() -> None:
    columns = [{"id": "name", "name": None, "type": "text", "description": None, "enum": None}]
    body, errors = run(
        OUTPUTS,
        {
            "notes": "n",
            "changes": [
                output_item(),
                output_item(
                    op="putTable", id="items", type=None, description=None, columns=columns
                ),
            ],
        },
    )
    assert errors == []
    assert body == {
        "notes": "n",
        "changes": [
            {
                "op": "putField",
                "field": {"id": "sender", "description": "Who wrote it"},
                "reason": "r",
            },
            {
                "op": "putTable",
                "table": {"id": "items", "columns": [{"id": "name"}]},
                "reason": "r",
            },
        ],
    }


def test_outputs_report_invalid_items_and_reserved_or_unknown_ids() -> None:
    _, errors = run(OUTPUTS, {"notes": "", "changes": [output_item(type="enum", enum=None)]})
    assert any("changes[0]" in e and "enum" in e for e in errors)
    col = {"id": "x", "name": None, "type": "text", "description": None, "enum": None}
    _, errors = run(
        OUTPUTS,
        {"notes": "", "changes": [output_item(op="putTable", id="issues", columns=[col])]},
    )
    assert any("reserved" in e for e in errors)
    _, errors = run(OUTPUTS, {"notes": "", "changes": [output_item(op="removeOutput", id="nope")]})
    assert any("no such output" in e for e in errors)


def test_steps_validate_the_whole_template_after_applying() -> None:
    draft = {**DRAFT, "outputs": {"fields": [{"id": "sender"}], "tables": []}}
    body, errors = run(STEPS, {"notes": "", "changes": [step_item()]}, draft)
    assert errors == []
    assert body["changes"][0]["step"] == {
        "type": "extract",
        "id": "head",
        "fields": ["sender"],
        "sections": ["all"],
        "instructions": "Top of page 1",
    }
    _, errors = run(STEPS, {"notes": "", "changes": [step_item(sections=["nope"])]}, draft)
    assert any("unknown section" in e for e in errors)
    _, errors = run(STEPS, {"notes": "", "changes": [step_item(fields=["other"])]}, draft)
    assert any("unknown field" in e for e in errors) and any("not filled" in e for e in errors)


@pytest.mark.parametrize("sections", [[], None])
def test_an_extract_step_without_sections_says_why_it_needs_one(sections: Any) -> None:
    """The model sent `sections: []` for outputs no section holds (a file name): the empty list
    was dropped and the feedback said "Field required", so the retry sent the same again."""
    draft = {**DRAFT, "outputs": {"fields": [{"id": "sender"}], "tables": []}}
    _, errors = run(STEPS, {"notes": "", "changes": [step_item(sections=sections)]}, draft)
    assert errors == [
        "changes[0]: step 'head': sections is empty: an extract step reads at least one section. "
        "For a value no section holds (a file name, a value these documents lack), fill it in "
        "the step that reads the section it belongs with; it may come back empty."
    ]
    assert not any("Field required" in e for e in errors)


def test_the_steps_prompt_says_every_extract_step_reads_a_section() -> None:
    assert "reads at least one section" in STEPS.instructions
    assert "may come back empty" in STEPS.instructions


def test_the_steps_prompt_says_steps_see_the_file_name_and_page_markers() -> None:
    assert "states the source file name" in STEPS.instructions
    assert "[page N]" in STEPS.instructions


def test_steps_convert_context_checks_and_preamble() -> None:
    draft = {**DRAFT, "outputs": {"fields": [{"id": "sender"}, {"id": "ref"}], "tables": []}}
    changes = [
        step_item(),
        step_item(id="tail", fields=["ref"], context=[{"name": "who", "path": "sender"}]),
        step_item(
            id="same", type="check", fields=None, sections=None, values="ref", reference="sender"
        ),
        step_item(op="setPreamble", id="", preamble="Letters to QA."),
    ]
    body, errors = run(STEPS, {"notes": "", "changes": changes}, draft)
    assert errors == []
    assert body["changes"][1]["step"]["context"] == {"who": "sender"}
    assert body["changes"][2]["step"] == {
        "type": "check",
        "id": "same",
        "values": "ref",
        "reference": "sender",
    }
    assert body["changes"][3] == {"op": "setPreamble", "preamble": "Letters to QA.", "reason": "r"}


def test_empty_strings_and_lists_are_treated_as_absent() -> None:
    body, errors = run(
        OUTPUTS, {"notes": "", "changes": [output_item(type="text", enum=[], description="")]}
    )
    assert errors == [] and body["changes"][0]["field"] == {"id": "sender"}
    draft = {**DRAFT, "outputs": {"fields": [{"id": "sender"}, {"id": "ref"}], "tables": []}}
    changes = [
        step_item(instructions=""),
        step_item(
            id="same",
            type="check",
            fields=None,
            sections=None,
            values="ref",
            reference="sender",
            aliases="",
        ),
    ]
    body, errors = run(STEPS, {"notes": "", "changes": changes}, draft)
    assert "instructions" not in body["changes"][0]["step"]
    assert "aliases" not in body["changes"][1]["step"]
    _, errors = run(STEPS, {"notes": "", "changes": [step_item(sections=[])]}, draft)
    assert any("sections" in e for e in errors)


def test_removes_are_checked_against_the_draft_after_earlier_changes() -> None:
    both = [output_item(), output_item(op="removeOutput")]
    _, errors = run(OUTPUTS, {"notes": "", "changes": both})
    assert not any("no such output" in e for e in errors)
    _, errors = run(OUTPUTS, {"notes": "", "changes": [*both[::-1]]})
    assert any("no such output" in e for e in errors)
    draft = {**DRAFT, "outputs": {"fields": [{"id": "sender"}], "tables": []}}
    steps = [step_item(), step_item(op="removeStep", id="head")]
    _, errors = run(STEPS, {"notes": "", "changes": steps}, draft)
    assert not any("no such step" in e for e in errors)


def section_item(**kw: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "op": "putSection",
        "id": "approval",
        "anchor": "^PROTOCOL APPROVAL",
        "required": None,
        "description": "Signatures",
        "copiesSelect": None,
        "reason": "r",
    }
    return {**base, **kw}


def test_sections_convert_sections_and_copies() -> None:
    body, errors = run(
        SECTIONS,
        {
            "notes": "",
            "changes": [
                section_item(),
                section_item(
                    op="setCopies",
                    id="copies",
                    anchor="^PROTOCOL$",
                    copiesSelect="first",
                    description=None,
                ),
                section_item(op="setCopies", id="copies", anchor=None, description=None),
            ],
        },
    )
    assert errors == []
    assert body["changes"] == [
        {
            "op": "putSection",
            "section": {
                "id": "approval",
                "anchor": "^PROTOCOL APPROVAL",
                "description": "Signatures",
            },
            "reason": "r",
        },
        {"op": "setCopies", "copies": {"anchor": "^PROTOCOL$", "select": "first"}, "reason": "r"},
        {"op": "setCopies", "copies": None, "reason": "r"},
    ]


def test_sections_report_bad_regexes_and_keep_one_section() -> None:
    _, errors = run(SECTIONS, {"notes": "", "changes": [section_item(anchor="(unclosed")]})
    assert any("approval" in e and "regular expression" in e for e in errors)
    _, errors = run(
        SECTIONS, {"notes": "", "changes": [section_item(op="removeSection", id="all")]}
    )
    assert any("at least one section" in e for e in errors)


def test_sections_remove_is_checked_against_the_draft_at_that_point() -> None:
    changes = [section_item(op="removeSection", id="approval"), section_item()]
    _, errors = run(SECTIONS, {"notes": "", "changes": changes})
    assert any("removeSection" in e and "no such section" in e for e in errors)
    changes = [section_item(), section_item(op="removeSection", id="approval")]
    _, errors = run(SECTIONS, {"notes": "", "changes": changes})
    assert errors == []


def _empty(schema: dict[str, Any]) -> dict[str, Any]:
    kinds: dict[str, Any] = {"string": "", "array": [], "integer": 0, "boolean": True}
    return {k: kinds[v["type"]] for k, v in schema["properties"].items()}


def nested(
    op: str, key: str, item: dict[str, Any], answers: list[str] | None = None
) -> dict[str, Any]:
    """A revise change: the chosen payload from a flat item, the rest filled with empties."""
    schema = REVISE_SCHEMA["properties"]["changes"]["items"]["properties"]
    change: dict[str, Any] = {"op": op, "reason": "r", "answers": answers or []}
    for k in ("field", "table", "section", "step"):
        change[k] = _empty(schema[k])
    for k, v in item.items():
        if k not in ("op", "reason") and v is not None:
            change[key][k] = v
    return change


REVISE_DRAFT = {
    **DRAFT,
    "outputs": {"fields": [{"id": "sender"}], "tables": []},
    "pipeline": [{"type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"]}],
}


def test_revise_converts_mixed_ops_in_order_and_validates_the_whole_template() -> None:
    changes = [
        nested("putField", "field", output_item(id="ref", description="Reference")),
        nested("putStep", "step", step_item(id="tail", fields=["ref"])),
        nested("putSection", "section", section_item(id="approval", anchor="^APPROVAL")),
    ]
    body, errors = run(REVISE, {"notes": "n", "changes": changes}, REVISE_DRAFT)
    assert errors == []
    assert [c["op"] for c in body["changes"]] == ["putField", "putStep", "putSection"]
    assert body["changes"][0]["field"] == {"id": "ref", "description": "Reference"}


def test_revise_reports_template_breakage_and_missing_payloads() -> None:
    orphan = nested("putField", "field", output_item(id="orphan"))
    _, errors = run(REVISE, {"notes": "", "changes": [orphan]}, REVISE_DRAFT)
    assert any("not filled by any step" in e for e in errors)
    missing = nested("putField", "field", {})
    _, errors = run(REVISE, {"notes": "", "changes": [missing]}, REVISE_DRAFT)
    assert any("changes[0]" in e and "field" in e for e in errors)


def test_revise_errors_carry_the_index_of_the_change_that_caused_them() -> None:
    good = nested("putField", "field", output_item(id="ref"))
    bad = nested("putField", "field", output_item(id="Bad Id!"))
    _, errors = run(REVISE, {"notes": "", "changes": [good, bad]}, REVISE_DRAFT)
    assert any(e.startswith("changes[1]") for e in errors)
    assert not any(e.startswith("changes[0]") for e in errors)


def test_revise_drops_empty_placeholders_before_converting() -> None:
    step = nested("putStep", "step", step_item(id="head", fields=["sender"]))
    body, errors = run(REVISE, {"notes": "", "changes": [step]}, REVISE_DRAFT)
    assert errors == []
    assert body["changes"][0]["step"] == {
        "type": "extract",
        "id": "head",
        "fields": ["sender"],
        "sections": ["all"],
        "instructions": "Top of page 1",
    }


def _union_count(node: Any) -> int:
    if isinstance(node, dict):
        own = int(isinstance(node.get("type"), list)) + sum(k in node for k in ("anyOf", "oneOf"))
        return own + sum(_union_count(v) for v in node.values())
    if isinstance(node, list):
        return sum(_union_count(v) for v in node)
    return 0


@pytest.mark.parametrize(
    ("stage_schema", "limit"),
    [
        (SURVEY_SCHEMA, 16),
        (OUTPUTS.schema, 16),
        (SECTIONS.schema, 16),
        (STEPS.schema, 16),
        (REVISE.schema, 0),
    ],
)
def test_schemas_stay_under_the_anthropic_union_type_limit(
    stage_schema: dict[str, Any], limit: int
) -> None:
    assert _union_count(stage_schema) <= limit


def test_revise_context_item_without_a_path_is_an_error_not_an_exception() -> None:
    step = nested("putStep", "step", step_item(context=[{"name": "n", "path": ""}]))
    _, errors = run(REVISE, {"notes": "", "changes": [step]}, REVISE_DRAFT)
    assert any("changes[0]" in e and "context item needs name and path" in e for e in errors)


def test_revise_set_preamble_with_empty_text_clears_the_preamble() -> None:
    clear = nested("setPreamble", "step", {})
    body, errors = run(REVISE, {"notes": "", "changes": [clear]}, REVISE_DRAFT)
    assert errors == []
    assert body["changes"] == [{"op": "setPreamble", "preamble": "", "reason": "r"}]


def test_revise_answers_are_a_required_plain_string_array() -> None:
    item = REVISE_SCHEMA["properties"]["changes"]["items"]
    assert item["properties"]["answers"] == {"type": "array", "items": {"type": "string"}}
    assert "answers" in item["required"]


def test_revise_carries_answer_labels_trimmed_and_once() -> None:
    assert REVISE.convert is not None
    change = nested("putField", "field", output_item(id="ref"), answers=[" F1 ", "", "F1", "F2"])
    body, errors = REVISE.convert({"notes": "", "changes": [change]})
    assert errors == []
    assert body["changes"][0]["answers"] == ["F1", "F2"]


def test_revise_change_that_answers_nothing_has_no_answers_key() -> None:
    assert REVISE.convert is not None
    body, _ = REVISE.convert({"notes": "", "changes": [nested("setPreamble", "step", {})]})
    assert "answers" not in body["changes"][0]


@pytest.mark.parametrize(
    ("answers", "expected"),
    [
        (["F2", "F1"], ["fb-2", "fb-1"]),
        (["f1"], ["fb-1"]),  # labels are case-insensitive
        (["F1", "F1"], ["fb-1"]),
        (["fb-2"], ["fb-2"]),  # an exact id is accepted
        (["F9", "nonsense"], None),  # unknown labels are dropped, and so is the key
    ],
)
def test_resolve_answers_maps_labels_to_feedback_ids(
    answers: list[str], expected: list[str] | None
) -> None:
    change = {"op": "removeStep", "id": "s", "reason": "r", "answers": answers}
    body = resolve_answers({"notes": "", "changes": [change]}, {"F1": "fb-1", "F2": "fb-2"})
    assert body["changes"][0].get("answers") == expected
    assert body["changes"][0]["id"] == "s"
