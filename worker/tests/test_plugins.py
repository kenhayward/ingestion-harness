"""Recipe plugins, slice 3a (docs/design/recipe-plugins.md): the registry, the context a plugin
reads, the first built-in plugin `text.pattern@1`, and plugin steps in a recipe's run."""

from __future__ import annotations

import json
import re
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
import yaml

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, DocumentError, PipelineDeps
from ingest_worker.plugins import BUILTINS, PluginContext, plugins, resolve_plugins
from ingest_worker.review import step_results
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore
from ingest_worker.template import PluginStep, Template
from ingest_worker.template_pipeline import step_inputs

from .fakes import FakeProvider, FakeQueue
from .test_template_pipeline import JOB

PATTERN = BUILTINS["text.pattern@1"]

RECIPE: dict[str, Any] = {
    "id": "demo",
    "version": 1,
    "name": "Demo",
    "review": {"required": "always"},
    "document": {
        "sections": [{"id": "head", "anchor": r"\A"}, {"id": "body", "anchor": "^ITEMS"}],
    },
    "outputs": {
        "fields": [
            {"id": "reference", "type": "text"},
            {"id": "issued", "type": "date"},
            {"id": "supplier", "type": "text"},
        ],
        "tables": [
            {"id": "lines", "columns": [{"id": "sku", "type": "text"}, {"id": "qty", "type": "integer"}]}
        ],
    },
    "pipeline": [
        {
            "type": "plugin",
            "id": "refs",
            "uses": "text.pattern@1",
            "fields": ["reference", "issued"],
            "sections": ["head"],
            "with": {
                "patterns": {
                    "reference": r"Ref:\s*(?P<value>[A-Z]+-\d+)",
                    "issued": r"Issued\s+(\d{4}-\d{2}-\d{2})",
                }
            },
        },
        {"type": "extract", "id": "who", "fields": ["supplier"], "sections": ["head"],
         "context": {"ref": "reference"}},
        {
            "type": "plugin",
            "id": "rows",
            "uses": "text.pattern@1",
            "table": "lines",
            "sections": ["body"],
            "with": {"row": r"^(?P<sku>[A-Z]{3}\d+)\s+x(?P<qty>\d+)$"},
        },
        {"type": "check", "id": "sku_check", "values": "lines.sku", "reference": "lines.sku"},
    ],
}  # fmt: skip

PAGES = [
    "ACME LTD\nRef: INV-4021\nIssued 2026-03-01\n",
    "ITEMS\nABC1 x2\nXYZ22 x10\nnot a line\n",
]


def template(**changes: Any) -> Template:
    return Template.model_validate({**RECIPE, **changes})


def step(t: Template, step_id: str) -> PluginStep:
    found = next(s for s in t.plugin_steps() if s.id == step_id)
    return found


def context(t: Template, step_id: str, sections: dict[str, str]) -> PluginContext:
    return PluginContext(JOB, t, step(t, step_id), sections, [], lambda *_: None)


# --- text.pattern@1 ---------------------------------------------------------------------------


def run_pattern(step_id: str, sections: dict[str, str], **with_: Any) -> dict[str, Any]:
    t = template()
    s = step(t, step_id)
    if with_:
        s = s.model_copy(update={"with_": with_})
    settings = PATTERN.settings_for(t, s)
    return PATTERN.run(PluginContext(JOB, t, s, sections, [], lambda *_: None), settings)


def test_fields_take_the_first_match_with_its_line_and_page() -> None:
    head = "[page 1]\nACME LTD\nRef: INV-4021\n[page 2]\nIssued 2026-03-01\nRef: INV-9999"
    assert run_pattern("refs", {"head": head}) == {
        "reference": {"value": "INV-4021", "evidence": "Ref: INV-4021", "page": 1},
        "issued": {"value": "2026-03-01", "evidence": "Issued 2026-03-01", "page": 2},
    }


@pytest.mark.parametrize(
    ("pattern", "value"),
    [
        (r"Ref:\s*(?P<value>\S+)", "INV-4021"),  # the group named value
        (r"Ref:\s*(\S+)", "INV-4021"),  # else group 1
        (r"INV-\d+", "INV-4021"),  # else the whole match
    ],
)
def test_the_value_is_the_named_group_else_group_one_else_the_match(
    pattern: str, value: str
) -> None:
    out = run_pattern("refs", {"head": "Ref: INV-4021"}, patterns={"reference": pattern})
    assert out["reference"]["value"] == value


def test_no_match_is_an_empty_value_and_no_page_marker_is_no_page() -> None:
    out = run_pattern("refs", {"head": "nothing here"})
    assert out["reference"] == {"value": None, "evidence": None, "page": None}
    assert run_pattern("refs", {"head": "Ref: INV-1"})["reference"]["page"] is None


def test_a_field_without_a_pattern_stays_empty() -> None:
    out = run_pattern("refs", {"head": "Ref: INV-4021"}, patterns={"reference": r"INV-\d+"})
    assert out["issued"] == {"value": None, "evidence": None, "page": None}


def test_a_table_row_is_each_match_by_named_groups() -> None:
    assert run_pattern("rows", {"body": PAGES[1]}) == {
        "rows": [{"sku": "ABC1", "qty": "2"}, {"sku": "XYZ22", "qty": "10"}]
    }


def test_matching_ignores_case_only_when_asked() -> None:
    body = "abc1 x2"
    assert run_pattern("rows", {"body": body}) == {"rows": []}
    out = run_pattern("rows", {"body": body}, row=r"^(?P<sku>[A-Z]{3}\d+)", ignoreCase=True)
    assert out == {"rows": [{"sku": "abc1"}]}


def test_sections_are_read_in_the_steps_order() -> None:
    t = template()
    s = step(t, "refs").model_copy(update={"sections": ["body", "head"]})
    settings = PATTERN.settings_for(t, s)
    sections = {"head": "Ref: INV-1", "body": "Ref: INV-2"}
    out = PATTERN.run(PluginContext(JOB, t, s, sections, [], lambda *_: None), settings)
    assert out["reference"]["value"] == "INV-2"


@pytest.mark.parametrize(
    ("step_id", "with_", "error"),
    [
        ("refs", {"patterns": {"nope": "x"}}, "'nope' is not a field of this step"),
        ("refs", {"patterns": {"reference": "("}}, "reference: not a regular expression"),
        ("refs", {"patterns": {}}, "patterns: give a pattern for at least one field"),
        ("refs", {"row": "x"}, "a field step takes patterns, not row"),
        ("rows", {}, "a table step needs row"),
        ("rows", {"row": "(?P<nope>x)"}, "'nope' is not a column of lines"),
        ("rows", {"row": "x", "patterns": {"sku": "x"}}, "a table step takes row, not patterns"),
        ("refs", {"patterns": {"reference": "x"}, "extra": 1}, "extra"),
    ],
)
def test_settings_are_checked_against_the_step(step_id: str, with_: Any, error: str) -> None:
    t = template()
    s = step(t, step_id).model_copy(update={"with_": with_})
    with pytest.raises(ValueError, match=error):
        PATTERN.settings_for(t, s)


# --- the registry and resolving a recipe's plugins -------------------------------------------


def test_every_plugin_is_registered_under_its_id_and_major() -> None:
    for ref, plugin in plugins().items():
        assert ref == f"{plugin.spec.id}@{plugin.spec.version}"
        assert plugin.spec.egress in ("none", "model")
        json.dumps(plugin.settings.model_json_schema())  # what the catalogue will publish


def test_a_recipes_plugins_resolve_before_any_model_call() -> None:
    resolved = resolve_plugins(template())
    assert set(resolved) == {"refs", "rows"}
    assert resolved["refs"].plugin is PATTERN


def test_a_plugin_this_worker_lacks_is_a_document_problem() -> None:
    pipeline = [{**RECIPE["pipeline"][0], "uses": "acme.magic@3"}, *RECIPE["pipeline"][1:]]
    with pytest.raises(
        DocumentError, match=re.escape("step 'refs': no plugin acme.magic@3 on this worker")
    ):
        resolve_plugins(template(pipeline=pipeline))


def test_bad_settings_are_a_document_problem_naming_the_step() -> None:
    bad = {**RECIPE["pipeline"][0], "with": {"patterns": {"reference": "("}}}
    with pytest.raises(
        DocumentError, match=re.escape("step 'refs': text.pattern@1: reference: not a")
    ):
        resolve_plugins(template(pipeline=[bad, *RECIPE["pipeline"][1:]]))


# --- plugin steps in a recipe's run ------------------------------------------------------------


def run_recipe(
    tmp_path: Path, recipe: dict[str, Any] = RECIPE
) -> tuple[FakeProvider, FakeQueue, PipelineDeps]:
    directory = tmp_path / "demo" / "v1"
    directory.mkdir(parents=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(recipe), encoding="utf-8")
    provider = FakeProvider(
        "local", responses=[{"supplier": {"value": "ACME LTD", "evidence": "ACME LTD", "page": 1}}]
    )
    store = MemoryObjectStore()
    store.put("inbox", JOB.object_key, b"%PDF", "application/pdf")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=ModelRegistry(
            {"local": provider},
            {"local": ProviderConfig(name="local", kind="openai-chat")},
            {"default": "local/qwen"},
        ),
        extract_text=lambda _pdf: PAGES,
        buckets=Buckets("inbox", "outputs", "runs"),
    )
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    return provider, queue, deps  # fmt: skip


def test_a_recipe_with_plugin_steps_runs_end_to_end(tmp_path: Path) -> None:
    provider, queue, deps = run_recipe(tmp_path)
    assert queue.awaiting, queue.reviewed or queue.failed
    assert [r.schema_name for _, r in provider.calls] == ["who"]  # plugins call no model
    assert "INV-4021" in provider.calls[0][1].prompt  # the extract step's context
    document = json.loads(deps.store.get("outputs", "demo/v1/document/doc-1.json"))
    assert document["fields"]["reference"]["value"] == "INV-4021"
    assert document["fields"]["issued"]["value"] == "2026-03-01"
    assert document["tables"]["lines"] == [{"sku": "ABC1", "qty": 2}, {"sku": "XYZ22", "qty": 10}]
    assert document["checks"]["sku_check"]["rows"]
    assert document["models"] == {"who": "local/qwen"}


def test_a_plugin_step_records_a_step_run_without_a_model(tmp_path: Path) -> None:
    _, queue, _ = run_recipe(tmp_path)
    runs = {r["step_id"]: r for r in queue.step_runs}
    assert runs["refs"]["model"] is None and runs["refs"]["status"] == "succeeded"
    assert runs["rows"]["model"] is None
    assert runs["who"]["model"] == "local/qwen"
    ran = [d for _, _, m, d in queue.event_details if m == "ran refs"]
    assert ran == [{"plugin": "text.pattern@1"}]


def test_a_plugin_missing_from_the_worker_stops_before_any_model_call(tmp_path: Path) -> None:
    recipe = {
        **RECIPE,
        "pipeline": [{**RECIPE["pipeline"][0], "uses": "acme.magic@3"}, *RECIPE["pipeline"][1:]],
    }
    provider, queue, _ = run_recipe(tmp_path, recipe)
    [(_, reason)] = queue.reviewed
    assert reason == "step 'refs': no plugin acme.magic@3 on this worker"
    assert provider.calls == [] and queue.step_runs == []  # fmt: skip


def test_checks_on_plugin_outputs_run_again_at_publish(tmp_path: Path) -> None:
    t = template()
    tables = {"lines": [{"sku": "ABC1", "qty": 2}]}
    fields = {"reference": {"value": "INV-1"}}
    results = step_results(t, fields, tables)
    assert results["rows"] == {"rows": tables["lines"]}
    assert results["refs"] == {"reference": {"value": "INV-1"}}


def test_a_plugin_step_is_a_dependency_like_any_other() -> None:
    t = template()
    who = next(s for s in t.extract_steps() if s.id == "who")
    assert step_inputs(t, who) == ["refs"]


def test_the_review_publish_and_rerun_keep_working(tmp_path: Path) -> None:
    _, queue, deps = run_recipe(tmp_path)
    queue.jobs = [replace(JOB, task="publish")]
    queue.decisions["job-1"] = {
        "reviewer": "kh",
        "note": None,
        "reviewed_at": "2026-10-19T10:00:00Z",
    }
    run_once(queue, deps, "w1")
    assert queue.completed, queue.reviewed or queue.failed  # fmt: skip
