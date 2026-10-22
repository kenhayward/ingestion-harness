"""Document type templates: outputs-first (fields + tables), ordered steps, review policy."""

from __future__ import annotations

import copy
import json
import re
from typing import Any

import pytest
from pydantic import ValidationError

from ingest_worker.config import REPO_ROOT
from ingest_worker.template import OutputMapping, Semantics, Template, compile_step

from .covalidation import FIXTURE as REPEAT_FIXTURE

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
        (mutate("outputs.tables.0.id", "graph"), "reserved"),
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


@pytest.mark.parametrize(
    ("template_model", "step_model", "runs"),
    [
        (None, None, "default"),  # nothing set: the default model choice
        ("fast", None, "fast"),  # the document type's model, inherited
        ("fast", "default", "fast"),  # `default` on a step means "inherit" too
        ("fast", "main", "main"),  # a step's own model wins
        (None, "main", "main"),
    ],
)
def test_steps_inherit_the_document_types_model(
    template_model: str | None, step_model: str | None, runs: str
) -> None:
    raw = template()
    if template_model is not None:
        raw["model"] = template_model
    if step_model is not None:
        raw["pipeline"][0]["model"] = step_model
    t = Template.model_validate(raw)
    assert t.step_model(t.extract_steps()[0]) == runs
    assert compile_step(t, t.extract_steps()[0]).model == runs


@pytest.mark.parametrize(
    ("template_model", "step_model", "runs"),
    [
        (None, None, "default"),
        ("fast", None, "fast"),
        ("fast", "default", "fast"),
        ("fast", "main", "main"),
    ],
)
def test_plugin_steps_inherit_the_document_types_model(
    template_model: str | None, step_model: str | None, runs: str
) -> None:
    raw = template()
    first = raw["pipeline"][0]
    plugin: dict[str, Any] = {
        "type": "plugin",
        "id": "ask",
        "uses": "acme.ask@1",
        "fields": first["fields"],
        "sections": first["sections"],
    }
    if template_model is not None:
        raw["model"] = template_model
    if step_model is not None:
        plugin["model"] = step_model
    raw["pipeline"] = [plugin, *raw["pipeline"][1:]]
    t = Template.model_validate(raw)
    assert t.step_model(t.plugin_steps()[0]) == runs


SEMANTICS_FIXTURE = json.loads(
    (REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "template-semantics.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize(
    "case", SEMANTICS_FIXTURE["cases"], ids=[c["name"] for c in SEMANTICS_FIXTURE["cases"]]
)
def test_semantics_and_delivery_match_the_shared_fixture(case: dict[str, Any]) -> None:
    definition = {**SEMANTICS_FIXTURE["base"], **case["patch"]}
    if case["valid"]:
        Template.model_validate(definition)
    else:
        with pytest.raises(ValidationError):
            Template.model_validate(definition)


def test_delivered_formats_default_to_csv_and_json() -> None:
    base = Template.model_validate(SEMANTICS_FIXTURE["base"])
    assert base.delivery_formats() == ["csv", "json"]
    json_only = Template.model_validate(
        {**SEMANTICS_FIXTURE["base"], "delivery": {"formats": ["json"]}}
    )
    assert json_only.delivery_formats() == ["json"]


def _repeat_definition(case: dict[str, Any]) -> dict[str, Any]:
    base = copy.deepcopy(REPEAT_FIXTURE["base"])
    if "sections" in case:
        base["document"]["sections"] = case["sections"]
    if "pipeline" in case:
        base["pipeline"] = case["pipeline"]
    return base


@pytest.mark.parametrize(
    "case", REPEAT_FIXTURE["cases"], ids=[c["name"] for c in REPEAT_FIXTURE["cases"]]
)
def test_repeating_sections_match_the_shared_fixture(case: dict[str, Any]) -> None:
    if case["valid"]:
        Template.model_validate(_repeat_definition(case))
    else:
        with pytest.raises(ValidationError, match=re.escape(case["error"])):
            Template.model_validate(_repeat_definition(case))


def test_repeating_section_of_a_step() -> None:
    t = Template.model_validate(REPEAT_FIXTURE["base"])
    steps = {s.id: s for s in t.extract_steps()}
    assert t.repeating_section(steps["header"]) is None
    section = t.repeating_section(steps["appearance"])
    assert section is not None and section.id == "appearance"


def test_compile_step_merges_rows_for_a_repeating_step() -> None:
    t = Template.model_validate(REPEAT_FIXTURE["base"])
    steps = {s.id: s for s in t.extract_steps()}
    assert compile_step(t, steps["appearance"]).merge_path == "rows"
    assert compile_step(t, steps["header"]).merge_path is None


PUBLISH_FIXTURE = json.loads(
    (REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "publish-targets.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize(
    "case", PUBLISH_FIXTURE["delivery"], ids=[c["name"] for c in PUBLISH_FIXTURE["delivery"]]
)
def test_delivery_cases_match_the_shared_fixture(case: dict[str, Any]) -> None:
    t = Template.model_validate({**SEMANTICS_FIXTURE["base"], **case["definition"]})
    assert t.delivery_formats() == case["formats"]
    assert t.publish_targets() == case["publishTargets"]
    assert t.delivery_settings() == case.get("settings", {})


@pytest.mark.parametrize("bad", ["Lake", "-x", "a b", "x" * 41, ""])
def test_publish_to_must_be_a_target_id(bad: str) -> None:
    with pytest.raises(ValidationError):
        Template.model_validate({**SEMANTICS_FIXTURE["base"], "delivery": {"publishTo": bad}})


@pytest.mark.parametrize(
    "bad",
    [[], [f"t{i}" for i in range(9)], ["lake", "archive", "lake"], ["lake", "Bad Id"]],
    ids=["empty", "nine", "duplicate", "bad id"],
)
def test_publish_to_list_is_one_to_eight_distinct_ids(bad: list[str]) -> None:
    with pytest.raises(ValidationError):
        Template.model_validate({**SEMANTICS_FIXTURE["base"], "delivery": {"publishTo": bad}})


def test_publish_to_takes_eight_distinct_ids() -> None:
    ids = [f"t{i}" for i in range(8)]
    t = Template.model_validate({**SEMANTICS_FIXTURE["base"], "delivery": {"publishTo": ids}})
    assert t.publish_targets() == ids


def test_delivery_still_refuses_unknown_keys_and_empty_formats() -> None:
    for delivery in ({"target": "x"}, {"formats": []}):
        with pytest.raises(ValidationError):
            Template.model_validate({**SEMANTICS_FIXTURE["base"], "delivery": delivery})


VALUE_NODES_FIXTURE = json.loads(
    (REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "value-nodes.json").read_text(
        encoding="utf-8"
    )
)


def _mapping_at(semantics: Semantics, path: str) -> OutputMapping:
    head, _, column = path.partition(".")
    return semantics.tables[head].columns[column] if column else semantics.fields[head]


@pytest.mark.parametrize("path", list(VALUE_NODES_FIXTURE["expected"]))
def test_value_nodes_resolve_as_the_shared_fixture_says(path: str) -> None:
    semantics = Semantics.model_validate(VALUE_NODES_FIXTURE["semantics"])
    resolved = semantics.resolve_node(_mapping_at(semantics, path))
    expected = VALUE_NODES_FIXTURE["expected"][path]
    assert (resolved.to_json() if resolved else None) == expected


@pytest.mark.parametrize("path", list(VALUE_NODES_FIXTURE["links"]))
def test_a_mappings_link_resolves_as_the_shared_fixture_says(path: str) -> None:
    semantics = Semantics.model_validate(VALUE_NODES_FIXTURE["semantics"])
    assert semantics.link_of(_mapping_at(semantics, path)) == VALUE_NODES_FIXTURE["links"][path]


PLUGIN_FIXTURE = json.loads(
    (REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "plugin-steps.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize(
    "case", PLUGIN_FIXTURE["cases"], ids=[c["name"] for c in PLUGIN_FIXTURE["cases"]]
)
def test_plugin_steps_match_the_shared_fixture(case: dict[str, Any]) -> None:
    definition = {**PLUGIN_FIXTURE["base"], "pipeline": case["pipeline"]}
    if case["valid"]:
        Template.model_validate(definition)
    elif "error" in case:
        with pytest.raises(ValidationError, match=re.escape(case["error"])):
            Template.model_validate(definition)
    else:
        with pytest.raises(ValidationError):
            Template.model_validate(definition)


def test_a_plugin_filled_output_resolves_to_its_step() -> None:
    from ingest_worker.template import PluginStep

    case = next(c for c in PLUGIN_FIXTURE["cases"] if c["name"].startswith("a check reads"))
    t = Template.model_validate({**PLUGIN_FIXTURE["base"], "pipeline": case["pipeline"]})
    [plugin] = [s for s in t.pipeline if isinstance(s, PluginStep)]
    assert t.filler_of_table("lines") is plugin
    assert [s.id for s in t.filling_steps()] == ["head", "rows"]
    assert [s.id for s in t.extract_steps()] == ["head"]
    check = t.compile_check(next(s for s in t.pipeline if s.type == "check"))
    assert check.values == "rows.rows[*].sku"


ENRICH_FIXTURE = json.loads(
    (REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "enrich-steps.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize(
    "case", ENRICH_FIXTURE["cases"], ids=[c["name"] for c in ENRICH_FIXTURE["cases"]]
)
def test_enriching_steps_match_the_shared_fixture(case: dict[str, Any]) -> None:
    definition = {**ENRICH_FIXTURE["base"], "pipeline": case["pipeline"]}
    if case["valid"]:
        Template.model_validate(definition)
    else:
        with pytest.raises(ValidationError, match=re.escape(case["error"])):
            Template.model_validate(definition)


@pytest.mark.parametrize(
    "case",
    [c for c in ENRICH_FIXTURE["cases"] if "columns" in c],
    ids=[c["name"] for c in ENRICH_FIXTURE["cases"] if "columns" in c],
)
def test_each_column_resolves_to_the_step_filling_it(case: dict[str, Any]) -> None:
    t = Template.model_validate({**ENRICH_FIXTURE["base"], "pipeline": case["pipeline"]})
    assert {c: [t.filler_of_column("lines", c).id] for c in case["columns"]} == case["columns"]
    assert t.filler_of_table("lines").id == "rows"
    step = next(s for s in t.filling_steps() if s.id == case["columns"]["expiry"][0])
    assert t._resolve("lines.expiry") == (f"{step.id}.rows[*].expiry", t.table("lines").columns[2])


CONSTRAINT_FIXTURE = json.loads(
    (REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "value-constraints.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize(
    "case", CONSTRAINT_FIXTURE["cases"], ids=[c["name"] for c in CONSTRAINT_FIXTURE["cases"]]
)
def test_output_constraints_match_the_shared_fixture(case: dict[str, Any]) -> None:
    base = CONSTRAINT_FIXTURE["base"]
    definition = {**base, "outputs": {**base["outputs"], "fields": case["fields"]}}
    if case["valid"]:
        Template.model_validate(definition)
    else:
        with pytest.raises(ValidationError, match=re.escape(case["error"])):
            Template.model_validate(definition)


FILTER_FIXTURE = json.loads(
    (REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "occurrence-filter.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize(
    "case", FILTER_FIXTURE["cases"], ids=[c["name"] for c in FILTER_FIXTURE["cases"]]
)
def test_occurrence_filters_match_the_shared_fixture(case: dict[str, Any]) -> None:
    definition = {**FILTER_FIXTURE["base"], "pipeline": case["pipeline"]}
    if case["valid"]:
        Template.model_validate(definition)
    else:
        with pytest.raises(ValidationError, match=re.escape(case["error"])):
            Template.model_validate(definition)


def test_an_occurrence_filter_round_trips_and_stays_absent_when_not_set() -> None:
    definition = {**FILTER_FIXTURE["base"], "pipeline": FILTER_FIXTURE["cases"][0]["pipeline"]}
    dumped = Template.model_validate(definition).model_dump(by_alias=True, exclude_none=True)
    assert dumped["pipeline"][1]["occurrences"] == {"match": r"Appearance\s+and\s+Water"}
    assert "occurrences" not in dumped["pipeline"][0]
