"""Steps that enrich an earlier table (docs/design/recipe-plugins.md, P4): one step creates the
rows, a later plugin step receives them as `ctx.rows` and fills only its `columns`, which the
worker merges into the rows by position. Re-running the creating step re-runs its enrichers."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
import yaml
from pydantic import BaseModel, ConfigDict

from ingest_worker import plugins as plugins_module
from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.nodes import NodeSpec
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.plugins import BUILTINS, Plugin, PluginContext
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore
from ingest_worker.template import Template
from ingest_worker.template_pipeline import DocState, normalise_step, step_inputs

from .fakes import FakeProvider, FakeQueue
from .test_template_pipeline import JOB


class NoSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")


seen: list[PluginContext] = []
#: What the creating plugin answers: changed by the re-run test.
ROWS: list[dict[str, Any]] = []
EXPIRY = {"A1": "2027-01-31", "B2": "31/12/2027", "C3": "2028-06-30"}
extra_row: list[bool] = [False]


def rows_run(ctx: PluginContext, _s: NoSettings) -> dict[str, Any]:
    seen.append(ctx)
    return {"rows": [dict(r) for r in ROWS]}


def expiry_run(ctx: PluginContext, _s: NoSettings) -> dict[str, Any]:
    seen.append(ctx)
    assert ctx.rows is not None
    rows = [{"expiry": EXPIRY.get(r["sku"], "soon"), "sku": "ignored"} for r in ctx.rows]
    return {"rows": rows + ([{"expiry": None}] if extra_row[0] else [])}


def plugin(name: str, run: Any) -> Plugin:
    return Plugin(
        spec=NodeSpec(name, 1, run, dict, "pure", "none", False, name),
        settings=NoSettings,
        check=lambda *_: [],
        run_settings=run,
    )


@pytest.fixture(autouse=True)
def registry(monkeypatch: pytest.MonkeyPatch) -> None:
    seen.clear()
    extra_row[0] = False
    ROWS[:] = [{"sku": "A1", "qty": "2"}, {"sku": "B2", "qty": "lots"}]
    registered = {
        **BUILTINS,
        "acme.rows@1": plugin("acme.rows", rows_run),
        "acme.expiry@1": plugin("acme.expiry", expiry_run),
    }
    monkeypatch.setattr(plugins_module, "plugins", lambda: registered)


RECIPE: dict[str, Any] = {
    "id": "demo",
    "version": 1,
    "name": "Demo",
    "review": {"required": "always"},
    "document": {"sections": [{"id": "head", "anchor": r"\A"}]},
    "outputs": {
        "tables": [
            {
                "id": "lines",
                "columns": [
                    {"id": "sku", "type": "text"},
                    {"id": "qty", "type": "integer"},
                    {"id": "expiry", "type": "date"},
                ],
            }
        ]
    },
    "pipeline": [
        {"type": "plugin", "id": "rows", "uses": "acme.rows@1", "table": "lines"},
        {
            "type": "plugin",
            "id": "expiry",
            "uses": "acme.expiry@1",
            "table": "lines",
            "columns": ["expiry"],
            "sections": ["head"],
        },
        {"type": "check", "id": "dates", "values": "lines.expiry", "reference": "lines.expiry"},
    ],
}


def run(tmp_path: Path) -> tuple[FakeQueue, PipelineDeps]:
    directory = tmp_path / "demo" / "v1"
    directory.mkdir(parents=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(RECIPE), encoding="utf-8")
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
        extract_text=lambda _pdf: ["Expiry dates are in the summary.\n"],
        buckets=Buckets("inbox", "outputs", "runs"),
    )
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    return queue, deps


def document(queue: FakeQueue) -> dict[str, Any]:
    outputs = queue.awaiting[-1][1]
    return json.loads(next(o.body for o in outputs if o.output_id == "document"))  # type: ignore[no-any-return]


def test_the_enriching_step_gets_the_rows_and_fills_only_its_columns(tmp_path: Path) -> None:
    queue, _ = run(tmp_path)
    assert queue.awaiting, queue.reviewed or queue.failed
    creating, enriching = seen
    assert creating.rows is None
    assert enriching.rows == [{"sku": "A1", "qty": 2}, {"sku": "B2", "qty": "lots"}]
    assert document(queue)["tables"]["lines"] == [
        {"sku": "A1", "qty": 2, "expiry": "2027-01-31"},
        {"sku": "B2", "qty": "lots", "expiry": "2027-12-31"},
    ]


def test_each_step_keeps_its_own_issues(tmp_path: Path) -> None:
    ROWS[1] = {"sku": "C9", "qty": "3"}
    queue, _ = run(tmp_path)
    [issue] = document(queue)["issues"]
    assert (issue["step"], issue["row"], issue["column"], issue["raw"]) == (
        "expiry",
        2,
        "expiry",
        "soon",
    )


def test_a_check_reads_the_enriched_column(tmp_path: Path) -> None:
    queue, _ = run(tmp_path)
    rows = document(queue)["checks"]["dates"]["rows"]
    assert [r["value"] for r in rows] == ["2027-01-31", "2027-12-31"]
    assert all(r["status"] != "unmatched" for r in rows)


def test_a_reply_with_other_rows_goes_to_review_naming_the_step(tmp_path: Path) -> None:
    extra_row[0] = True
    queue, _ = run(tmp_path)
    [(_, reason)] = queue.reviewed
    assert "step 'expiry'" in reason and "3 rows for the 2 rows of lines" in reason
    assert queue.step_runs[-1]["status"] == "failed"


def rerun(queue: FakeQueue, deps: PipelineDeps, step: str) -> None:
    queue.jobs = [replace(JOB, task="rerun", rerun={"step": step})]
    run_once(queue, deps, "w1")


def test_rerunning_the_creating_step_reruns_its_enrichers(tmp_path: Path) -> None:
    queue, deps = run(tmp_path)
    ROWS[:] = [{"sku": "C3", "qty": "1"}, {"sku": "A1", "qty": "4"}, {"sku": "B2", "qty": "5"}]
    seen.clear()
    rerun(queue, deps, "rows")
    assert [ctx.step.id for ctx in seen] == ["rows", "expiry"]
    assert [r["expiry"] for r in document(queue)["tables"]["lines"]] == [
        "2028-06-30",
        "2027-01-31",
        "2027-12-31",
    ]
    assert [(r["step_id"], r["trigger"]) for r in queue.step_runs[-2:]] == [
        ("rows", "rerun"),
        ("expiry", "rerun"),
    ]


def test_rerunning_an_enriching_step_keeps_the_rows(tmp_path: Path) -> None:
    queue, deps = run(tmp_path)
    ROWS[:] = []  # the creating step would answer nothing now: it must not run
    seen.clear()
    rerun(queue, deps, "expiry")
    assert [ctx.step.id for ctx in seen] == ["expiry"]
    assert [r["sku"] for r in document(queue)["tables"]["lines"]] == ["A1", "B2"]


def test_the_state_merges_an_enriching_steps_columns_by_position() -> None:
    template = Template.model_validate(RECIPE)
    creating, enriching = template.filling_steps()
    state = DocState().apply(normalise_step(template, creating, {"rows": ROWS}))
    state = state.apply(
        normalise_step(template, enriching, {"rows": [{"expiry": "2027-01-31"}, {}]})
    )
    assert state.tables["lines"] == [
        {"sku": "A1", "qty": 2, "expiry": "2027-01-31"},
        {"sku": "B2", "qty": "lots", "expiry": None},
    ]
    assert state.step_results["expiry"] == {"rows": state.tables["lines"]}
    assert state.step_results["rows"] == {
        "rows": [
            {"sku": "A1", "qty": 2, "expiry": None},
            {"sku": "B2", "qty": "lots", "expiry": None},
        ]
    }


def test_an_enriching_step_depends_on_the_creating_step() -> None:
    template = Template.model_validate(RECIPE)
    assert step_inputs(template, template.filling_steps()[1]) == ["rows"]


def test_the_preview_says_an_enriching_step_needs_a_test_run() -> None:
    from ingest_worker.plugin_preview import preview_problem

    template = Template.model_validate(RECIPE)
    step = template.plugin_steps()[1]
    assert preview_problem(template, step) == (
        "step expiry fills columns of lines, whose rows step rows creates: try it in a test run"
    )
    assert preview_problem(template, template.plugin_steps()[0]) is None
