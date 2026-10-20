"""Plugins that call a model (docs/design/recipe-plugins.md, follow-ups): a plugin whose egress
is "model" asks the step's model through `ctx.model`, under the same rules as an extract step:
the model resolves and the data policy is checked before the job calls any model, every attempt
is audited in the runs bucket, and the step run records the model and its tokens."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
import yaml
from pydantic import BaseModel, ConfigDict

from ingest_worker import plugins as plugins_module
from ingest_worker.errors import DocumentError
from ingest_worker.llm.base import ModelUnavailableError
from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.nodes import NodeSpec
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.plugins import BUILTINS, Plugin, PluginContext, check_plugin
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore
from ingest_worker.template import Template

from .fakes import FakeProvider, FakeQueue
from .test_template_pipeline import JOB

SUPPLIER_SCHEMA = {
    "type": "object",
    "properties": {"supplier": {"type": "string"}},
    "required": ["supplier"],
    "additionalProperties": False,
}


class AskSettings(BaseModel):
    model_config = ConfigDict(extra="forbid")
    question: str = "Who is the supplier?"


seen: list[PluginContext] = []


def ask_run(ctx: PluginContext, settings: AskSettings) -> dict[str, Any]:
    seen.append(ctx)
    assert ctx.model is not None
    reply = ctx.model.ask(f"{settings.question}\n\n{ctx.text()}", SUPPLIER_SCHEMA)
    return {"supplier": {"value": reply["supplier"], "evidence": None, "page": None}}


ASK = Plugin(
    spec=NodeSpec("acme.ask", 1, ask_run, dict, "pure", "model", False, "Ask a model."),
    settings=AskSettings,
    check=lambda *_: [],
    run_settings=ask_run,
)


@pytest.fixture(autouse=True)
def registry(monkeypatch: pytest.MonkeyPatch) -> None:
    seen.clear()
    monkeypatch.setattr(plugins_module, "plugins", lambda: {**BUILTINS, "acme.ask@1": ASK})


RECIPE: dict[str, Any] = {
    "id": "demo",
    "version": 1,
    "name": "Demo",
    "review": {"required": "always"},
    "document": {"sections": [{"id": "head", "anchor": r"\A"}]},
    "outputs": {"fields": [{"id": "supplier", "type": "text"}]},
    "pipeline": [
        {
            "type": "plugin",
            "id": "who",
            "uses": "acme.ask@1",
            "fields": ["supplier"],
            "sections": ["head"],
        }
    ],
}

PAGES = ["ACME LTD\nRef: INV-4021\n"]


def run(
    tmp_path: Path,
    responses: list[Any],
    recipe: dict[str, Any] = RECIPE,
    job_changes: dict[str, Any] | None = None,
) -> tuple[dict[str, FakeProvider], FakeQueue, PipelineDeps]:
    directory = tmp_path / "demo" / "v1"
    directory.mkdir(parents=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(recipe), encoding="utf-8")
    local = FakeProvider("local", responses=list(responses))
    cloud = FakeProvider("cloud", responses=list(responses))
    store = MemoryObjectStore()
    store.put("inbox", JOB.object_key, b"%PDF", "application/pdf")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=ModelRegistry(
            {"local": local, "cloud": cloud},
            {
                "local": ProviderConfig(name="local", kind="openai-chat", location="local"),
                "cloud": ProviderConfig(name="cloud", kind="anthropic", location="external"),
            },
            {"default": "local/qwen", "fast": "local/small", "big": "cloud/claude"},
        ),
        extract_text=lambda _pdf: PAGES,
        buckets=Buckets("inbox", "outputs", "runs"),
    )
    queue = FakeQueue(jobs=[replace(JOB, **(job_changes or {}))])
    run_once(queue, deps, "w1")
    return {"local": local, "cloud": cloud}, queue, deps


def with_step(**changes: Any) -> dict[str, Any]:
    return {**RECIPE, "pipeline": [{**RECIPE["pipeline"][0], **changes}]}


def test_a_plugin_asks_the_steps_model_and_fills_its_outputs(tmp_path: Path) -> None:
    providers, queue, deps = run(tmp_path, [{"supplier": "ACME LTD"}])
    assert queue.awaiting, queue.reviewed or queue.failed
    [(model, request)] = providers["local"].calls
    assert model == "qwen"
    assert "Who is the supplier?" in request.prompt
    assert "ACME LTD" in request.prompt
    document = json.loads(deps.store.get("outputs", "demo/v1/document/doc-1.json"))
    assert document["fields"]["supplier"]["value"] == "ACME LTD"
    assert document["models"] == {"who": "local/qwen"}


def test_the_step_run_records_the_model_attempts_and_tokens(tmp_path: Path) -> None:
    _, queue, _ = run(tmp_path, [{"wrong": 1}, {"supplier": "ACME LTD"}])
    [step_run] = [r for r in queue.step_runs if r["step_id"] == "who"]
    assert step_run["model"] == "local/qwen"
    assert step_run["attempts"] == 2
    assert step_run["input_tokens"] == 20
    assert step_run["output_tokens"] == 10
    assert step_run["status"] == "succeeded"


def test_every_attempt_is_audited_in_the_runs_bucket(tmp_path: Path) -> None:
    _, _, deps = run(tmp_path, [{"wrong": 1}, {"supplier": "ACME LTD"}])
    first = json.loads(deps.store.get("runs", "job-1/who.ask-1/attempt-1.json"))
    second = json.loads(deps.store.get("runs", "job-1/who.ask-1/attempt-2.json"))
    assert first["errors"] and not second["errors"]


@pytest.mark.parametrize(
    ("recipe", "job_changes", "expected"),
    [
        (RECIPE, None, ("local", "qwen")),
        (with_step(model="fast"), None, ("local", "small")),
        ({**RECIPE, "model": "fast"}, None, ("local", "small")),
        (with_step(model="fast"), {"model_override": "big"}, ("cloud", "claude")),
    ],
    ids=["default", "step model", "document type's model", "job override"],
)
def test_the_model_is_the_jobs_else_the_steps_else_the_document_types(
    tmp_path: Path, recipe: dict[str, Any], job_changes: dict[str, Any] | None, expected: Any
) -> None:
    providers, _, _ = run(tmp_path, [{"supplier": "ACME LTD"}], recipe, job_changes)
    provider, model = expected
    assert [m for m, _ in providers[provider].calls] == [model]


def test_a_local_only_project_never_sends_a_plugins_prompt_to_an_external_model(
    tmp_path: Path,
) -> None:
    providers, queue, _ = run(
        tmp_path,
        [{"supplier": "ACME LTD"}],
        with_step(model="big"),
        {"project_id": "demo", "test": True, "params": {"dataPolicy": "local"}},
    )
    assert providers["cloud"].calls == [] and providers["local"].calls == []
    [(_, reason)] = queue.reviewed
    assert "data policy" in reason


def test_a_model_that_does_not_resolve_stops_the_job_before_any_call(tmp_path: Path) -> None:
    providers, queue, _ = run(tmp_path, [{"supplier": "X"}], with_step(model="nope"))
    assert providers["local"].calls == []
    [(_, reason)] = queue.reviewed
    assert "step 'who'" in reason and "nope" in reason


def test_a_reply_that_never_fits_goes_to_review_naming_the_step(tmp_path: Path) -> None:
    providers, queue, deps = run(tmp_path, [{"wrong": 1}, {"wrong": 2}])
    assert len(providers["local"].calls) == 2
    [(_, reason)] = queue.reviewed
    assert "who.ask-1" in reason
    assert deps.store.get("runs", "job-1/who.ask-1/attempt-2.json")


def test_a_model_the_server_lacks_goes_to_review(tmp_path: Path) -> None:
    _, queue, _ = run(tmp_path, [ModelUnavailableError("Invalid model identifier")])
    [(_, reason)] = queue.reviewed
    assert "plugin step 'who'" in reason and "not available on its server" in reason


def test_a_plugin_that_calls_no_model_records_none(tmp_path: Path) -> None:
    recipe: dict[str, Any] = {
        **RECIPE,
        "pipeline": [
            {
                "type": "plugin",
                "id": "who",
                "uses": "text.pattern@1",
                "fields": ["supplier"],
                "sections": ["head"],
                "with": {"patterns": {"supplier": r"^([A-Z ]+)$"}},
            }
        ],
    }
    providers, queue, _ = run(tmp_path, [], recipe)
    assert queue.awaiting
    [step_run] = queue.step_runs
    assert step_run["model"] is None
    assert providers["local"].calls == []


def test_plugins_that_call_a_model_keep_the_contract() -> None:
    assert check_plugin(ASK) == []


def test_a_plugin_step_may_name_a_model_choice() -> None:
    template = Template.model_validate(with_step(model="fast"))
    step = template.plugin_steps()[0]
    assert step.model == "fast"
    assert template.step_model(step) == "fast"
    plain = Template.model_validate(RECIPE)
    assert plain.step_model(plain.plugin_steps()[0]) == "default"


def test_document_errors_raised_by_a_plugin_go_to_review(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(_ctx: PluginContext, _s: AskSettings) -> dict[str, Any]:
        raise DocumentError("no supplier block on this letter")

    failing = replace(ASK, run_settings=refuse)
    monkeypatch.setattr(plugins_module, "plugins", lambda: {**BUILTINS, "acme.ask@1": failing})
    _, queue, _ = run(tmp_path, [])
    [(_, reason)] = queue.reviewed
    assert reason == "no supplier block on this letter"
