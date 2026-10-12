"""Change stages: flat model output -> typed changes, validated against the draft."""

from __future__ import annotations

from typing import Any

from ingest_worker.draft_stages import OUTPUTS, STEPS, Stage

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
