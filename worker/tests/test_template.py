"""Document type templates: outputs-first (fields + tables), ordered steps, review policy."""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from ingest_worker.template import Template, compile_step

SECTIONS = {"sections": [{"id": "head", "anchor": r"\A"}, {"id": "body", "anchor": "^BODY"}]}


def template(**overrides: Any) -> dict[str, Any]:
    base: dict[str, Any] = {
        "id": "demo",
        "version": 1,
        "name": "Demo document",
        "document": SECTIONS,
        "outputs": {
            "fields": [
                {"id": "product", "type": "text", "description": "Medicinal product name"},
                {"id": "executed_on", "type": "date"},
                {"id": "kind", "type": "enum", "enum": ["protocol", "report"]},
            ],
            "tables": [
                {
                    "id": "results",
                    "columns": [
                        {"id": "batch", "type": "text"},
                        {"id": "value", "type": "decimal"},
                        {"id": "aliases", "type": "list"},
                    ],
                }
            ],
        },
        "pipeline": [
            {
                "type": "extract",
                "id": "header",
                "fields": ["product", "kind"],
                "sections": ["head"],
            },
            {
                "type": "extract",
                "id": "date",
                "fields": ["executed_on"],
                "sections": ["head"],
                "instructions": "The execution date is the date the first batch was made.",
            },
            {
                "type": "extract",
                "id": "data",
                "table": "results",
                "sections": ["body"],
                "chunkPages": 1,
            },
        ],
    }
    return {**base, **overrides}


def test_parses_with_defaults() -> None:
    t = Template.model_validate(template())
    assert t.name == "Demo document"
    assert t.review.required == "on_warnings"
    assert t.document.page_markers is True
    assert [s.id for s in t.pipeline] == ["header", "date", "data"]
    assert t.field("executed_on").type == "date"
    assert t.filler_of_table("results").id == "data"


def mutate(path: str, value: Any) -> dict[str, Any]:
    t = template()
    target: Any = t
    *parents, last = path.split(".")
    for key in parents:
        target = target[int(key)] if key.isdigit() else target[key]
    target[int(last) if last.isdigit() else last] = value
    return t


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        (mutate("pipeline.1.fields", ["product"]), "filled by more than one step"),
        (mutate("pipeline.1.fields", ["kind"]), "filled by more than one step"),
        (mutate("pipeline.0.fields", ["product"]), "not filled by any step"),
        (mutate("pipeline.2.sections", ["nope"]), "unknown section"),
        (mutate("pipeline.0.chunkPages", 2), "only table steps can be chunked"),
        (mutate("pipeline.2.table", "missing"), "unknown table"),
        (mutate("outputs.fields.2.enum", None), "enum values"),
        (mutate("outputs.tables.0.id", "fields"), "reserved"),
        (mutate("pipeline.0.fields", []), "fields or a table"),
    ],
)
def test_validation(raw: dict[str, Any], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        Template.model_validate(raw)


def test_check_paths_refer_to_fields_and_table_columns() -> None:
    check = {
        "type": "check",
        "id": "batches",
        "values": "results.batch",
        "reference": "results.batch",
        "aliases": "results.aliases",
    }
    t = Template.model_validate(template(pipeline=[*template()["pipeline"], check]))
    assert t.pipeline[-1].id == "batches"
    bad = {**check, "values": "results.nope"}
    with pytest.raises(ValidationError, match="unknown field or column"):
        Template.model_validate(template(pipeline=[*template()["pipeline"], bad]))


# --- compiling steps into executable extractions ---------------------------------------------


def test_field_step_schema_returns_value_evidence_and_page_per_field() -> None:
    t = Template.model_validate(template())
    ex = compile_step(t, t.pipeline[0])  # type: ignore[arg-type]
    schema = ex.schema_
    assert schema["required"] == ["product", "kind"]
    product = schema["properties"]["product"]
    assert product["required"] == ["value", "evidence", "page"]
    assert product["additionalProperties"] is False
    assert product["properties"]["value"]["type"] == ["string", "null"]
    assert schema["properties"]["kind"]["properties"]["value"]["enum"] == [
        "protocol",
        "report",
        None,
    ]
    assert ex.prompt == "builtin/extract.md.j2"
    assert ex.prompt_context["fields"][0]["description"] == "Medicinal product name"


def test_table_step_schema_wraps_rows_and_is_chunkable() -> None:
    t = Template.model_validate(template())
    ex = compile_step(t, t.pipeline[2])  # type: ignore[arg-type]
    rows = ex.schema_["properties"]["rows"]
    assert ex.schema_["required"] == ["rows"]
    assert rows["items"]["required"] == ["batch", "value", "aliases"]
    # decimals may come back as strings ("137·8") and are normalised afterwards
    assert rows["items"]["properties"]["value"]["type"] == ["number", "string", "null"]
    assert rows["items"]["properties"]["aliases"] == {"type": "array", "items": {"type": "string"}}
    assert (ex.chunk_pages, ex.merge_path) == (1, "rows")
    assert ex.prompt_context["table"]["id"] == "results"


def test_step_instructions_and_template_preamble_reach_the_prompt_context() -> None:
    t = Template.model_validate(template(preamble="Pharma document rules."))
    ex = compile_step(t, t.pipeline[1])  # type: ignore[arg-type]
    assert ex.prompt_context["preamble"] == "Pharma document rules."
    assert ex.prompt_context["instructions"].startswith("The execution date")
