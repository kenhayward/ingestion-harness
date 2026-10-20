"""Plugin steps reading a repeating section (docs/design/recipe-plugins.md, follow-up P2): like an
extract step, the plugin runs once per occurrence with that occurrence's text as the section and
`ctx.occurrence` set, the rows are concatenated and `keyColumn` is filled with each occurrence's
key. No occurrence: no call and no rows. The preview does the same."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
import yaml
from pydantic import BaseModel, ConfigDict

from ingest_worker import plugin_preview
from ingest_worker import plugins as plugins_module
from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.nodes import NodeSpec
from ingest_worker.pipeline import Buckets, PipelineDeps, RepeatPlan
from ingest_worker.plugin_preview import preview_samples
from ingest_worker.plugins import (
    BUILTINS,
    Plugin,
    PluginContext,
    PluginOccurrence,
    plugin_context,
    run_plugin,
)
from ingest_worker.segment import Occurrence
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore
from ingest_worker.template import Template

from .fakes import FakeProvider, FakeQueue
from .test_template_pipeline import JOB


class NoSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")


seen: list[PluginContext] = []


def echo_run(ctx: PluginContext, _settings: NoSettings) -> dict[str, Any]:
    """One row per line of the section, the plugin's own key column value overwritten."""
    seen.append(ctx)
    lines = [ln for ln in ctx.text().splitlines() if ln.startswith("T")]
    return {"rows": [{"timepoint": ln, "batch": "plugin's own"} for ln in lines]}


ECHO = Plugin(
    spec=NodeSpec("acme.echo", 1, echo_run, dict, "pure", "none", False, "Echo rows."),
    settings=NoSettings,
    check=lambda *_: [],
    run_settings=echo_run,
)


@pytest.fixture(autouse=True)
def registry(monkeypatch: pytest.MonkeyPatch) -> None:
    seen.clear()
    registered = {**BUILTINS, "acme.echo@1": ECHO}
    monkeypatch.setattr(plugins_module, "plugins", lambda: registered)
    monkeypatch.setattr(plugin_preview, "plugins", lambda: registered)


RECIPE: dict[str, Any] = {
    "id": "demo",
    "version": 1,
    "name": "Demo",
    "review": {"required": "always"},
    "document": {
        "sections": [
            {"id": "head", "anchor": r"\A"},
            {"id": "batches", "anchor": r"^Batch ", "repeat": True, "key": r"^Batch (\S+)"},
        ]
    },
    "outputs": {
        "tables": [
            {
                "id": "results",
                "columns": [
                    {"id": "batch", "type": "text"},
                    {"id": "timepoint", "type": "text"},
                ],
            }
        ]
    },
    "pipeline": [
        {
            "type": "plugin",
            "id": "rows",
            "uses": "acme.echo@1",
            "table": "results",
            "sections": ["batches"],
            "keyColumn": "batch",
        }
    ],
}

PAGES = ["STABILITY REPORT\nBatch B1\nT0 ok\nT6 ok\nBatch B2\nT0 ok\n"]


def run(
    tmp_path: Path, recipe: dict[str, Any] = RECIPE, pages: list[str] = PAGES
) -> tuple[FakeQueue, PipelineDeps]:
    directory = tmp_path / "demo" / "v1"
    directory.mkdir(parents=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(recipe), encoding="utf-8")
    store = MemoryObjectStore()
    store.put("inbox", JOB.object_key, b"%PDF", "application/pdf")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=ModelRegistry(
            {"local": FakeProvider("local", responses=[])},
            {"local": ProviderConfig(name="local", kind="openai-chat", location="local")},
            {"default": "local/qwen"},
        ),
        extract_text=lambda _pdf: pages,
        buckets=Buckets("inbox", "outputs", "runs"),
    )
    queue = FakeQueue(jobs=[replace(JOB)])
    run_once(queue, deps, "w1")
    return queue, deps


def document(deps: PipelineDeps) -> dict[str, Any]:
    return json.loads(deps.store.get("outputs", "demo/v1/document/doc-1.json"))  # type: ignore[no-any-return]


def test_the_plugin_runs_once_per_occurrence_on_that_occurrences_text(tmp_path: Path) -> None:
    queue, _ = run(tmp_path)
    assert queue.awaiting, queue.reviewed or queue.failed
    assert len(seen) == 2
    assert "Batch B1" in seen[0].sections["batches"] and "B2" not in seen[0].sections["batches"]
    assert "Batch B2" in seen[1].sections["batches"] and "B1" not in seen[1].sections["batches"]
    assert [ctx.occurrence for ctx in seen] == [
        PluginOccurrence(index=1, count=2, key="B1", section="batches"),
        PluginOccurrence(index=2, count=2, key="B2", section="batches"),
    ]


def test_the_rows_are_concatenated_with_the_key_column_filled(tmp_path: Path) -> None:
    _, deps = run(tmp_path)
    assert document(deps)["tables"]["results"] == [
        {"batch": "B1", "timepoint": "T0 ok"},
        {"batch": "B1", "timepoint": "T6 ok"},
        {"batch": "B2", "timepoint": "T0 ok"},
    ]


def test_one_step_run_records_the_whole_step(tmp_path: Path) -> None:
    queue, _ = run(tmp_path)
    assert [r["step_id"] for r in queue.step_runs] == ["rows"]


def test_a_plain_step_has_no_occurrence(tmp_path: Path) -> None:
    step = {k: v for k, v in RECIPE["pipeline"][0].items() if k != "keyColumn"}
    run(tmp_path, {**RECIPE, "pipeline": [{**step, "sections": ["head"]}]})
    [ctx] = seen
    assert ctx.occurrence is None


def test_an_occurrence_without_a_key_is_an_issue_on_its_rows(tmp_path: Path) -> None:
    recipe: dict[str, Any] = json.loads(json.dumps(RECIPE))
    recipe["document"]["sections"][1]["key"] = r"^Batch (B1)\b"
    _, deps = run(tmp_path, recipe)
    rows = document(deps)["tables"]["results"]
    assert [r["batch"] for r in rows] == ["B1", "B1", None]
    [issue] = [i for i in document(deps)["issues"] if i["step"] == "rows"]
    assert (issue["row"], issue["column"]) == (3, "batch")
    assert "no key found" in issue["message"]


def _ctx() -> PluginContext:
    template = Template.model_validate(RECIPE)
    step = template.plugin_steps()[0]
    return plugin_context(template, step, {"batches": "everything"})


def test_no_occurrence_makes_no_call_and_no_rows() -> None:
    data = run_plugin(ECHO, NoSettings(), _ctx(), RepeatPlan("batches", [], "batch"))
    assert data == {"rows": []} and seen == []


def test_without_a_plan_the_plugin_runs_once() -> None:
    run_plugin(ECHO, NoSettings(), _ctx(), None)
    [ctx] = seen
    assert ctx.sections == {"batches": "everything"} and ctx.occurrence is None


def test_a_reply_without_rows_names_the_occurrence() -> None:
    def bad(_ctx: PluginContext, _s: NoSettings) -> dict[str, Any]:
        return {"nope": 1}

    plugin = replace(ECHO, run_settings=bad)
    occurrence = Occurrence(1, 1, "B1", None, None, "Batch B1")
    with pytest.raises(ValueError, match=r"occurrence 1 of 1 \(B1\).*rows"):
        run_plugin(plugin, NoSettings(), _ctx(), RepeatPlan("batches", [occurrence], "batch"))


def test_the_preview_runs_over_every_occurrence() -> None:
    [one] = preview_samples(RECIPE, "rows", "p1", [("id-a", "a.pdf", PAGES)])["samples"]
    assert one["error"] is None
    assert [r["batch"] for r in one["rows"]] == ["B1", "B1", "B2"]
    assert [ctx.occurrence.key for ctx in seen if ctx.occurrence] == ["B1", "B2"]
