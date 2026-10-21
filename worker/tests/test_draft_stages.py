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
    if not errors and stage.fit is not None:
        body = stage.fit(body, draft)
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


CHUNK_DRAFT: dict[str, Any] = {
    **DRAFT,
    "document": {"sections": [{"id": "all", "anchor": "\\A"}, {"id": "end", "anchor": "^End"}]},
    "outputs": {"fields": [{"id": "sender"}], "tables": [{"id": "rows", "columns": [{"id": "x"}]}]},
}


@pytest.mark.parametrize(
    ("item", "kept"),
    [
        (step_item(id="t", fields=None, table="rows", chunkPages=5), True),
        (step_item(chunkPages=5), False),  # a field step
        (
            step_item(id="t", fields=None, table="rows", sections=["all", "end"], chunkPages=5),
            False,
        ),
    ],
)
def test_chunk_pages_where_it_cannot_apply_is_dropped_with_a_note(
    item: dict[str, Any], kept: bool
) -> None:
    other = (
        step_item(id="o", fields=None, table="rows")
        if item["table"] is None
        else step_item(id="o", fields=["sender"])
    )
    body, errors = run(STEPS, {"notes": "n", "changes": [item, other]}, CHUNK_DRAFT)
    assert errors == []
    step = body["changes"][0]["step"]
    if kept:
        assert step["chunkPages"] == 5 and body["notes"] == "n"
    else:
        assert "chunkPages" not in step
        assert body["notes"].startswith("n\n") and repr(item["id"]) in body["notes"]


def test_revise_keeps_the_note_about_dropped_chunk_pages() -> None:
    step = {k: v for k, v in step_item(chunkPages=5).items() if k not in ("op", "reason")}
    body, errors = REVISE.convert(
        {
            "notes": "",
            "changes": [{"op": "putStep", "step": step, "answers": [], "reason": "r"}],
        }
    )
    assert errors == [] and "chunkPages" not in body["changes"][0]["step"]
    assert "'head'" in body["notes"]


def test_steps_ignore_an_unfinished_mapping_they_cannot_fix() -> None:
    """A mapping started without a document class (MappingEditor, a partial mapping proposal)
    is the Mapping stage's to finish: it must not fail the steps, nor hide their own errors."""
    draft = {
        **DRAFT,
        "outputs": {"fields": [{"id": "sender"}, {"id": "ref"}], "tables": []},
        "semantics": {
            "document": {"class": "", "iri": "doc/{source}"},
            "fields": {"sender": {"property": "ex:sender"}},
        },
        "delivery": {"formats": ["csv", "rdf"]},
    }
    both = step_item(fields=["sender", "ref"])
    _, errors = run(STEPS, {"notes": "", "changes": [both]}, draft)
    assert errors == []
    _, errors = run(STEPS, {"notes": "", "changes": [step_item()]}, draft)
    assert errors and all("semantics" not in e for e in errors)
    assert any("not filled" in e for e in errors)


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


# --- repeating sections (spec 2026-10-16) ----------------------------------------------------

REPEAT_DRAFT: dict[str, Any] = {
    **DRAFT,
    "document": {
        "sections": [
            {"id": "all", "anchor": r"\A"},
            {"id": "batch", "anchor": r"^\d+\. STUDY", "repeat": True, "key": r"BATCH (\w+)"},
        ]
    },
}


def test_sections_convert_carries_repeat_key_and_key_from() -> None:
    item = section_item(
        id="appearance",
        anchor=r"^Table \d+:.*Appearance",
        description=None,
        repeat=True,
        key=r"Batch\s+(\w+)",
        keyFrom="batch",
    )
    body, errors = run(SECTIONS, {"notes": "", "changes": [item]}, REPEAT_DRAFT)
    assert errors == []
    assert body["changes"][0]["section"] == {
        "id": "appearance",
        "anchor": r"^Table \d+:.*Appearance",
        "repeat": True,
        "key": r"Batch\s+(\w+)",
        "keyFrom": "batch",
    }


def test_sections_convert_leaves_out_unset_repeat_keys() -> None:
    item = section_item(repeat=None, key=None, keyFrom=None)
    body, errors = run(SECTIONS, {"notes": "", "changes": [item]})
    assert errors == []
    assert not {"repeat", "key", "keyFrom"} & set(body["changes"][0]["section"])


def test_check_sections_refuses_an_invalid_key() -> None:
    item = section_item(id="t", anchor="^Table", repeat=True, key=r"Batch (\w+")
    _, errors = run(SECTIONS, {"notes": "", "changes": [item]})
    assert any("'t': key: invalid regular expression" in e for e in errors), errors


def test_steps_convert_carries_key_column() -> None:
    draft = {
        **REPEAT_DRAFT,
        "outputs": {
            "fields": [],
            "tables": [{"id": "batches", "columns": [{"id": "batch"}, {"id": "packaging"}]}],
        },
    }
    item = step_item(
        id="batches", fields=None, table="batches", sections=["batch"], keyColumn="batch"
    )
    body, errors = run(STEPS, {"notes": "", "changes": [item]}, draft)
    assert errors == []
    assert body["changes"][0]["step"]["keyColumn"] == "batch"


KEY_DRAFT: dict[str, Any] = {
    **DRAFT,
    "document": {
        "sections": [
            {"id": "all", "anchor": r"\A"},
            {"id": "keyed", "anchor": "^1", "repeat": True, "key": r"BATCH (\w+)"},
            {"id": "keyless", "anchor": "^2", "repeat": True},
            {"id": "plain", "anchor": "^3"},
        ]
    },
    "outputs": {"fields": [], "tables": [{"id": "rows", "columns": [{"id": "batch"}]}]},
}


@pytest.mark.parametrize(
    ("section", "kept", "note"),
    [
        ("keyed", True, None),
        (
            "keyless",
            False,
            "Ignored keyColumn on 'rows_step': section 'keyless' has no key or keyFrom, so the "
            "worker cannot fill the column; the step's instructions should say where the "
            "identifier is.",
        ),
        (
            "plain",
            False,
            "Ignored keyColumn on 'rows_step': it reads no repeating section.",
        ),
    ],
)
def test_steps_drop_a_key_column_the_section_cannot_fill(
    section: str, kept: bool, note: str | None
) -> None:
    """The model keeps setting keyColumn; like chunkPages, an unusable one is dropped with a
    note instead of failing the stage."""
    item = step_item(
        id="rows_step", fields=None, table="rows", sections=[section], keyColumn="batch"
    )
    body, errors = run(STEPS, {"notes": "", "changes": [item]}, KEY_DRAFT)
    assert errors == []
    assert ("keyColumn" in body["changes"][0]["step"]) is kept
    assert (note in body["notes"]) if note else body["notes"] == ""


def test_steps_keep_a_key_column_whose_section_the_same_body_gives_a_key() -> None:
    """A revise body can add the key and the keyColumn together: fit to the draft as changed."""
    assert REVISE.fit is not None
    body = {
        "notes": "",
        "changes": [
            {
                "op": "putSection",
                "section": {"id": "keyless", "anchor": "^2", "repeat": True, "key": "B (.+)"},
                "reason": "r",
            },
            {
                "op": "putStep",
                "step": {
                    "type": "extract",
                    "id": "rows_step",
                    "table": "rows",
                    "sections": ["keyless"],
                    "keyColumn": "batch",
                },
                "reason": "r",
            },
        ],
    }
    fitted = REVISE.fit(body, KEY_DRAFT)
    assert fitted["changes"][1]["step"]["keyColumn"] == "batch"
    assert fitted["notes"] == ""


CHECK_DRAFT: dict[str, Any] = {
    **DRAFT,
    "outputs": {
        "fields": [],
        "tables": [
            {"id": "batches", "columns": [{"id": "batch_number"}]},
            {"id": "assay", "columns": [{"id": "batch_number"}]},
            {"id": "nir", "columns": [{"id": "batch_number"}]},
        ],
    },
    "pipeline": [
        {"type": "extract", "id": t, "table": t, "sections": ["all"]}
        for t in ("batches", "assay", "nir")
    ],
}


def check_item(values: str, reference: str) -> dict[str, Any]:
    return step_item(
        id="check_batch_consistency",
        type="check",
        fields=None,
        sections=None,
        instructions=None,
        values=values,
        reference=reference,
        description="Batch numbers match the batch headings",
    )


@pytest.mark.parametrize(
    ("values", "reference"),
    [
        ('["assay.batch_number","nir.batch_number"]', '"batches.batch_number'),
        ("assay.batch_number, nir.batch_number", "batches.batch_number"),
        ("['assay.batch_number', 'nir.batch_number']", "'batches.batch_number'"),
    ],
)
def test_a_check_listing_several_paths_becomes_one_check_per_path(
    values: str, reference: str
) -> None:
    """The model packed every table into one check's values (a JSON list, with a stray quote on
    the reference): a check compares one path with its reference, so it is split."""
    body, errors = run(
        STEPS, {"notes": "", "changes": [check_item(values, reference)]}, CHECK_DRAFT
    )
    assert errors == []
    steps = [c["step"] for c in body["changes"]]
    assert [(s["id"], s["values"], s["reference"]) for s in steps] == [
        ("check_batch_consistency_1", "assay.batch_number", "batches.batch_number"),
        ("check_batch_consistency_2", "nir.batch_number", "batches.batch_number"),
    ]
    assert all(s["description"] == "Batch numbers match the batch headings" for s in steps)
    assert "Split check 'check_batch_consistency' into 2 checks" in body["notes"]


def test_a_check_with_one_quoted_path_is_cleaned_not_split() -> None:
    item = check_item('"assay.batch_number"', '"batches.batch_number"')
    body, errors = run(STEPS, {"notes": "", "changes": [item]}, CHECK_DRAFT)
    assert errors == []
    [change] = body["changes"]
    assert (change["step"]["id"], change["step"]["values"], change["step"]["reference"]) == (
        "check_batch_consistency",
        "assay.batch_number",
        "batches.batch_number",
    )
    assert body["notes"] == ""


def test_the_steps_prompt_says_a_check_compares_one_path() -> None:
    assert "one path each" in STEPS.instructions


def test_revise_sentinels_mean_no_repeat_keys() -> None:
    assert REVISE.convert is not None
    section = {**section_item(), "repeat": False, "key": "", "keyFrom": ""}
    section = {k: v for k, v in section.items() if k not in ("op", "reason")}
    step = {**step_item(), "keyColumn": ""}
    step = {k: v for k, v in step.items() if k not in ("op", "reason")}
    body, errors = REVISE.convert(
        {
            "notes": "",
            "changes": [nested("putSection", "section", section), nested("putStep", "step", step)],
        }
    )
    assert errors == []
    assert not {"repeat", "key", "keyFrom"} & set(body["changes"][0]["section"])
    assert "keyColumn" not in body["changes"][1]["step"]


def test_drafting_prompts_explain_repeating_sections() -> None:
    assert "repeat true" in SECTIONS.instructions and "keyFrom" in SECTIONS.instructions
    assert "keyColumn" in STEPS.instructions


# --- step order: a step runs after the steps whose outputs its context reads -----------------

ORDER_DRAFT: dict[str, Any] = {
    **DRAFT,
    "outputs": {
        "fields": [{"id": "owning_location"}, {"id": "document_type"}],
        "tables": [{"id": "stability", "columns": [{"id": "test"}, {"id": "result"}]}],
    },
    # The stability step exists already; nothing fills the header fields yet.
    "pipeline": [{"type": "extract", "id": "stability", "table": "stability", "sections": ["all"]}],
}
CONTEXT = [
    {"name": "owning_location", "path": "owning_location"},
    {"name": "document_type", "path": "document_type"},
]


def pipeline_after(body: dict[str, Any], draft: dict[str, Any]) -> list[str]:
    from ingest_worker.draft_changes import apply_changes

    return [s["id"] for s in apply_changes(draft, body["changes"])["pipeline"]]


@pytest.mark.parametrize("stage", [STEPS, REVISE], ids=["steps", "revise"])
def test_a_new_step_that_fills_context_is_moved_before_the_steps_reading_it(stage: Stage) -> None:
    """A new step goes last and a changed one keeps its place, so a header step added to fill
    what an existing step's context reads would run after it: the reported failure (both tries
    rejected with 'not filled by an earlier step'). The fit reorders instead."""
    data = {
        "notes": "",
        "changes": [
            step_item(id="stability", fields=None, table="stability", context=CONTEXT),
            step_item(id="header", fields=["owning_location", "document_type"]),
        ],
    }
    if stage is REVISE:
        data["changes"] = [nested("putStep", "step", c) for c in data["changes"]]
    body, errors = run(stage, data, ORDER_DRAFT)
    assert errors == []
    assert pipeline_after(body, ORDER_DRAFT) == ["header", "stability"]
    ops = [(c["op"], c.get("id") or c["step"]["id"]) for c in body["changes"]]
    assert ops == [("putStep", "header"), ("removeStep", "stability"), ("putStep", "stability")]
    assert "Moved 'stability' after 'header', which fills what its context reads." in body["notes"]


def test_an_untouched_step_reading_a_new_step_is_moved_too() -> None:
    draft = {
        **ORDER_DRAFT,
        "pipeline": [
            {
                "type": "extract",
                "id": "stability",
                "table": "stability",
                "sections": ["all"],
                "context": {"owning_location": "owning_location"},
            }
        ],
    }
    data = {
        "notes": "",
        "changes": [step_item(id="header", fields=["owning_location", "document_type"])],
    }
    body, errors = run(STEPS, data, draft)
    assert errors == []
    assert pipeline_after(body, draft) == ["header", "stability"]
    moved = body["changes"][-1]
    assert moved["step"] == draft["pipeline"][0]  # its definition as it was
    assert moved["reason"] == "Moved after 'header', which fills what its context reads."


def test_steps_already_in_order_are_left_alone() -> None:
    data = {
        "notes": "",
        "changes": [
            step_item(id="header", fields=["owning_location", "document_type"]),
            step_item(id="stability", fields=None, table="stability", context=CONTEXT),
        ],
    }
    draft = {**ORDER_DRAFT, "pipeline": []}
    body, errors = run(STEPS, data, draft)
    assert errors == [] and body["notes"] == ""
    assert [c["op"] for c in body["changes"]] == ["putStep", "putStep"]


def test_a_context_cycle_is_left_for_the_check_to_report() -> None:
    draft = {
        **ORDER_DRAFT,
        "outputs": {"fields": [{"id": "a"}, {"id": "b"}], "tables": []},
        "pipeline": [],
    }
    data = {
        "notes": "",
        "changes": [
            step_item(id="one", fields=["a"], context=[{"name": "b", "path": "b"}]),
            step_item(id="two", fields=["b"], context=[{"name": "a", "path": "a"}]),
        ],
    }
    body, errors = run(STEPS, data, draft)
    assert [c["op"] for c in body["changes"]] == ["putStep", "putStep"]
    assert any("not filled by an earlier step" in e for e in errors)


def test_revise_instructions_explain_run_diagnostics() -> None:
    assert "run_diagnostics are what the dev test runs of this draft showed" in REVISE.instructions
    assert "Fix what they show; reason names the diagnostic." in REVISE.instructions
