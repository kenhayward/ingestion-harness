"""Check plugins (docs/design/recipe-plugins.md, phase 2): a check step naming a plugin
(`uses`) is judged by it, instead of compared with a reference. The plugin sees the distinct
values the step's `values` path names and answers a verdict per value; the worker checks the
verdicts, counts the values and records them as any check's rows."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest
import yaml
from pydantic import BaseModel, ConfigDict

from ingest_worker import plugins as plugins_module
from ingest_worker.errors import DocumentError
from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.nodes import NodeSpec
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.plugins import (
    BUILTINS,
    CheckContext,
    Plugin,
    PluginContext,
    resolve_checks,
    resolve_plugins,
)
from ingest_worker.review import apply_edits
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore
from ingest_worker.template import Template

from .fakes import FakeProvider, FakeQueue
from .test_template_pipeline import JOB


class NoSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")


seen: list[CheckContext] = []
#: What the judge answers for the values it is given (None: "match" for each).
ANSWER: list[list[dict[str, Any]] | None] = [None]
SKUS = [{"sku": "A1"}, {"sku": "A1"}, {"sku": "B9"}]


def rows_run(_ctx: PluginContext, _s: NoSettings) -> dict[str, Any]:
    return {"rows": [dict(r) for r in SKUS]}


def judge(ctx: CheckContext, _s: NoSettings) -> list[dict[str, Any]]:
    seen.append(ctx)
    if ANSWER[0] is not None:
        return ANSWER[0]
    return [{"value": v, "status": "match", "matched": v} for v in ctx.values]


def check_plugin(name: str) -> Plugin:
    return Plugin(
        spec=NodeSpec(name, 1, judge, dict, "pure", "none", False, name),
        settings=NoSettings,
        check=lambda *_: [],
        run_settings=lambda *_: {},
        kind="check",
        judge=judge,
    )


def step_plugin(name: str) -> Plugin:
    return Plugin(
        spec=NodeSpec(name, 1, rows_run, dict, "pure", "none", False, name),
        settings=NoSettings,
        check=lambda *_: [],
        run_settings=rows_run,
    )


@pytest.fixture(autouse=True)
def registry(monkeypatch: pytest.MonkeyPatch) -> None:
    seen.clear()
    ANSWER[0] = None
    registered = {
        **BUILTINS,
        "acme.rows@1": step_plugin("acme.rows"),
        "acme.judge@1": check_plugin("acme.judge"),
    }
    monkeypatch.setattr(plugins_module, "plugins", lambda: registered)


def recipe(check_uses: str = "acme.judge@1", values: str = "lines.sku") -> dict[str, Any]:
    return {
        "id": "demo",
        "version": 1,
        "name": "Demo",
        "review": {"required": "always"},
        "document": {"sections": [{"id": "head", "anchor": r"\A"}]},
        "outputs": {"tables": [{"id": "lines", "columns": [{"id": "sku", "type": "text"}]}]},
        "pipeline": [
            {"type": "plugin", "id": "rows", "uses": "acme.rows@1", "table": "lines"},
            {"type": "check", "id": "names", "values": values, "uses": check_uses},
        ],
    }


def run(
    tmp_path: Path, definition: dict[str, Any] | None = None
) -> tuple[FakeQueue, PipelineDeps, FakeProvider]:
    directory = tmp_path / "demo" / "v1"
    directory.mkdir(parents=True)
    (directory / "template.yaml").write_text(
        yaml.safe_dump(definition or recipe()), encoding="utf-8"
    )
    store = MemoryObjectStore()
    store.put("inbox", JOB.object_key, b"%PDF", "application/pdf")
    provider = FakeProvider("local", responses=[])
    deps = PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=ModelRegistry(
            {"local": provider},
            {"local": ProviderConfig(name="local", kind="openai-chat", location="local")},
            {"default": "local/qwen"},
        ),
        extract_text=lambda _pdf: ["Some text.\n"],
        buckets=Buckets("inbox", "outputs", "runs"),
    )
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    return queue, deps, provider


def document(queue: FakeQueue) -> dict[str, Any]:
    outputs = queue.awaiting[-1][1]
    return json.loads(next(o.body for o in outputs if o.output_id == "document"))  # type: ignore[no-any-return]


def test_a_check_plugin_judges_each_distinct_value_once(tmp_path: Path) -> None:
    queue, _, _ = run(tmp_path)
    assert queue.awaiting, queue.failed or queue.reviewed
    [ctx] = seen
    assert ctx.values == ["A1", "B9"]
    rows = document(queue)["checks"]["names"]["rows"]
    assert [(r["value"], r["count"]) for r in rows] == [("A1", 2), ("B9", 1)]
    assert rows[0] == {
        "value": "A1",
        "status": "match",
        "matched": "A1",
        "distance": None,
        "count": 2,
    }


def test_unmatched_values_are_review_reasons(tmp_path: Path) -> None:
    ANSWER[0] = [
        {"value": "A1", "status": "match", "matched": "A1"},
        {"value": "B9", "status": "unmatched", "message": "not in the list"},
    ]
    queue, _, _ = run(tmp_path)
    [(_, _, reasons)] = queue.awaiting
    assert "check names: 1 unmatched" in reasons
    row = document(queue)["checks"]["names"]["rows"][1]
    assert (row["status"], row["matched"], row["message"]) == (
        "unmatched",
        None,
        "not in the list",
    )


def test_the_plugin_gets_the_rows_when_values_is_a_column(tmp_path: Path) -> None:
    run(tmp_path)
    [ctx] = seen
    assert ctx.rows == [{"sku": "A1"}, {"sku": "A1"}, {"sku": "B9"}]
    assert ctx.step.id == "names" and ctx.template.id == "demo"


def test_a_status_outside_the_four_is_a_document_error(tmp_path: Path) -> None:
    ANSWER[0] = [{"value": "A1", "status": "maybe"}]
    queue, _, _ = run(tmp_path)
    [(_, reason)] = queue.reviewed
    assert "check 'names': acme.judge@1 answered status 'maybe'" in reason


def test_a_value_the_plugin_was_not_given_is_a_document_error(tmp_path: Path) -> None:
    ANSWER[0] = [{"value": "Z0", "status": "match"}]
    queue, _, _ = run(tmp_path)
    [(_, reason)] = queue.reviewed
    assert "check 'names': acme.judge@1 answered a value it was not given: 'Z0'" in reason


def test_a_missing_check_plugin_stops_the_job_before_any_model_call(tmp_path: Path) -> None:
    queue, _, provider = run(tmp_path, recipe("acme.gone@1"))
    [(_, reason)] = queue.reviewed
    assert reason == "check 'names': no plugin acme.gone@1 on this worker"
    assert provider.calls == []
    assert not queue.step_runs


def test_checks_rerun_after_a_reviewer_edit(tmp_path: Path) -> None:
    queue, _, _ = run(tmp_path)
    draft = document(queue)
    template = Template.model_validate(recipe())
    seen.clear()
    edited = apply_edits(
        template, draft, [{"table": "lines", "row": 3, "column": "sku", "value": "C3"}]
    )
    [ctx] = seen
    assert ctx.values == ["A1", "C3"]
    assert [r["value"] for r in edited["checks"]["names"]["rows"]] == ["A1", "C3"]


def test_a_step_plugin_is_not_a_check_plugin() -> None:
    template = Template.model_validate(recipe("acme.rows@1"))
    with pytest.raises(DocumentError, match=r"check .names.: acme.rows@1 is not a check plugin"):
        resolve_checks(template)


def test_a_check_plugin_is_not_a_step_plugin() -> None:
    definition = recipe()
    definition["pipeline"][0]["uses"] = "acme.judge@1"
    template = Template.model_validate(definition)
    with pytest.raises(
        DocumentError,
        match=r"step .rows.: acme.judge@1 is a check plugin: use it in a check step",
    ):
        resolve_plugins(template)


def test_settings_that_do_not_fit_are_a_document_error() -> None:
    definition = recipe()
    definition["pipeline"][1]["with"] = {"nope": 1}
    template = Template.model_validate(definition)
    with pytest.raises(DocumentError, match=r"check .names.: acme.judge@1: nope"):
        resolve_checks(template)


LISTED = {"values": ["G17230211", "G17230212"], "aliases": {"G17230211": ["GTT230211"]}}


@pytest.mark.parametrize(
    ("value", "status", "matched"),
    [
        (" g17230211 ", "match", "G17230211"),
        ("GTT230211", "alias", "G17230211"),
        ("G1T230212", "near", "G17230212"),
        ("ZZ999", "unmatched", None),
    ],
)
def test_list_lookup_matches_like_a_check(value: str, status: str, matched: str | None) -> None:
    lookup = BUILTINS["list.lookup@1"]
    definition = recipe("list.lookup@1")
    definition["pipeline"][1]["with"] = LISTED
    template = Template.model_validate(definition)
    step = template.pipeline[1]
    settings = lookup.settings_for(template, step)  # type: ignore[arg-type]
    ctx = CheckContext(JOB, template, step, [value.strip()], None)  # type: ignore[arg-type]
    assert lookup.judge is not None
    [verdict] = lookup.judge(ctx, settings)
    assert (verdict["value"], verdict["status"], verdict["matched"]) == (
        value.strip(),
        status,
        matched,
    )
