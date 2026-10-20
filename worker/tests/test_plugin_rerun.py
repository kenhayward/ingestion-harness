"""Re-running a plugin step from review (docs/design/recipe-plugins.md, follow-up P3): like an
extract step's re-run, only that step runs again (with the reviewer's guidance as
`ctx.instructions`, and `params.model` for a plugin that asks a model), its outputs and issues
are replaced, the checks re-run, `reruns` grows and the job goes back to review."""

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

from .fakes import FakeProvider, FakeQueue
from .test_template_pipeline import JOB

SUPPLIER = {
    "type": "object",
    "properties": {"supplier": {"type": "string"}},
    "required": ["supplier"],
    "additionalProperties": False,
}


class NoSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")


seen: list[PluginContext] = []


def ask_run(ctx: PluginContext, _settings: NoSettings) -> dict[str, Any]:
    seen.append(ctx)
    assert ctx.model is not None
    reply = ctx.model.ask(f"Who is the supplier? {ctx.instructions or ''}\n{ctx.text()}", SUPPLIER)
    return {"supplier": {"value": reply["supplier"], "evidence": None, "page": None}}


def ref_run(ctx: PluginContext, _settings: NoSettings) -> dict[str, Any]:
    seen.append(ctx)
    value = "INV-4021" if ctx.instructions else "lots"
    return {"amount": {"value": value, "evidence": None, "page": None}}


def plugin(name: str, egress: Any, run: Any) -> Plugin:
    return Plugin(
        spec=NodeSpec(name, 1, run, dict, "pure", egress, False, name),
        settings=NoSettings,
        check=lambda *_: [],
        run_settings=run,
    )


@pytest.fixture(autouse=True)
def registry(monkeypatch: pytest.MonkeyPatch) -> None:
    seen.clear()
    registered = {
        **BUILTINS,
        "acme.ask@1": plugin("acme.ask", "model", ask_run),
        "acme.ref@1": plugin("acme.ref", "none", ref_run),
    }
    monkeypatch.setattr(plugins_module, "plugins", lambda: registered)


RECIPE: dict[str, Any] = {
    "id": "demo",
    "version": 1,
    "name": "Demo",
    "review": {"required": "always"},
    "document": {"sections": [{"id": "head", "anchor": r"\A"}]},
    "outputs": {
        "fields": [{"id": "supplier", "type": "text"}, {"id": "amount", "type": "integer"}]
    },
    "pipeline": [
        {
            "type": "plugin",
            "id": "who",
            "uses": "acme.ask@1",
            "fields": ["supplier"],
            "sections": ["head"],
        },
        {
            "type": "plugin",
            "id": "amount",
            "uses": "acme.ref@1",
            "fields": ["amount"],
            "sections": ["head"],
        },
    ],
}


def reviewed(tmp_path: Path) -> tuple[FakeQueue, PipelineDeps, dict[str, FakeProvider]]:
    """The job processed once and waiting in review."""
    directory = tmp_path / "demo" / "v1"
    directory.mkdir(parents=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(RECIPE), encoding="utf-8")
    providers = {
        "local": FakeProvider("local", responses=[{"supplier": "ACME LTD"}]),
        "cloud": FakeProvider("cloud", responses=[]),
    }
    store = MemoryObjectStore()
    store.put("inbox", JOB.object_key, b"%PDF", "application/pdf")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=ModelRegistry(
            providers,  # type: ignore[arg-type]
            {
                "local": ProviderConfig(name="local", kind="openai-chat", location="local"),
                "cloud": ProviderConfig(name="cloud", kind="anthropic", location="external"),
            },
            {"default": "local/qwen", "fast": "local/small", "big": "cloud/claude"},
        ),
        extract_text=lambda _pdf: ["ACME LTD\nRef: INV-4021\n"],
        buckets=Buckets("inbox", "outputs", "runs"),
    )
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    assert queue.awaiting
    seen.clear()
    return queue, deps, providers


def rerun(queue: FakeQueue, deps: PipelineDeps, step: dict[str, Any], **job: Any) -> None:
    queue.jobs = [replace(JOB, task="rerun", rerun=step, **job)]
    run_once(queue, deps, "w1")


def document(queue: FakeQueue) -> dict[str, Any]:
    outputs = queue.awaiting[-1][1]
    return json.loads(next(o.body for o in outputs if o.output_id == "document"))  # type: ignore[no-any-return]


def test_only_the_plugin_step_runs_again_with_the_reviewers_guidance(tmp_path: Path) -> None:
    queue, deps, providers = reviewed(tmp_path)
    before = document(queue)
    assert [i["target"] for i in before["issues"]] == ["amount"]  # "lots" is no integer
    rerun(queue, deps, {"step": "amount", "instructions": "Read the Ref line."})
    [ctx] = seen
    assert ctx.instructions == "Read the Ref line." and ctx.step.id == "amount"
    assert len(providers["local"].calls) == 1  # the asking step did not run again
    after = document(queue)
    assert after["fields"]["supplier"] == before["fields"]["supplier"]
    assert after["fields"]["amount"]["value"] == "INV-4021"
    [issue] = after["issues"]  # the step's issues were replaced, not added to
    assert issue["target"] == "amount" and issue["raw"] == "INV-4021"
    assert after["reruns"][-1]["step"] == "amount"
    assert after["reruns"][-1]["instructions"] == "Read the Ref line."
    assert queue.awaiting[-1][2][0] == "re-run of step amount"
    assert queue.step_runs[-1]["step_id"] == "amount"
    assert queue.step_runs[-1]["trigger"] == "rerun"


def test_a_plain_run_has_no_instructions(tmp_path: Path) -> None:
    queue, deps, _ = reviewed(tmp_path)
    rerun(queue, deps, {"step": "amount"})
    [ctx] = seen
    assert ctx.instructions is None


def test_a_plugin_that_asks_a_model_takes_the_reviewers_model(tmp_path: Path) -> None:
    queue, deps, providers = reviewed(tmp_path)
    providers["local"].responses = [{"supplier": "ACME LIMITED"}]
    rerun(queue, deps, {"step": "who", "model": "fast", "instructions": "Use the full name."})
    [(model, request)] = providers["local"].calls[1:]
    assert model == "small" and "Use the full name." in request.prompt
    after = document(queue)
    assert after["fields"]["supplier"]["value"] == "ACME LIMITED"
    assert after["models"]["who"] == "local/small"
    assert after["reruns"][-1]["model"] == "local/small"
    assert queue.step_runs[-1]["model"] == "local/small"
    assert queue.step_runs[-1]["trigger"] == "rerun"


def test_a_local_only_project_never_reruns_a_plugin_on_an_external_model(
    tmp_path: Path,
) -> None:
    queue, deps, providers = reviewed(tmp_path)
    rerun(
        queue,
        deps,
        {"step": "who", "model": "big"},
        project_id="demo",
        test=True,
        params={"dataPolicy": "local"},
    )
    assert providers["cloud"].calls == []
    [(_, reason)] = queue.reviewed
    assert "data policy" in reason


def test_an_unknown_step_names_both_kinds(tmp_path: Path) -> None:
    queue, deps, _ = reviewed(tmp_path)
    rerun(queue, deps, {"step": "nope"})
    [(_, reason)] = queue.reviewed
    assert "no extract or plugin step 'nope'" in reason
