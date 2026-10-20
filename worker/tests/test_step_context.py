"""Increment 4: context from earlier steps, step run records, re-running one step."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore
from ingest_worker.template import Template, compile_step

from .fakes import FakeProvider, FakeQueue
from .test_template_pipeline import JOB, PAGES, RESPONSES, TEMPLATE

# The date step runs after the results table and is given its batch values as context.
PIPELINE = [
    TEMPLATE["pipeline"][0],
    TEMPLATE["pipeline"][2],  # data (results table, chunked)
    {**TEMPLATE["pipeline"][1], "context": {"batches_seen": "results.batch"}},  # date
    TEMPLATE["pipeline"][3],
]
CONTEXT_TEMPLATE = {**TEMPLATE, "pipeline": PIPELINE}
CONTEXT_RESPONSES = [RESPONSES[0], RESPONSES[2], RESPONSES[3], RESPONSES[1]]


def make(tmp_path: Path, responses: list[Any]):  # type: ignore[no-untyped-def]
    store = MemoryObjectStore()
    store.put("inbox", JOB.object_key, b"%PDF", "application/pdf")
    providers = {
        "local": FakeProvider("local", responses=list(responses)),
        "other": FakeProvider("other"),
    }
    deps = PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=ModelRegistry(
            providers,  # type: ignore[arg-type]
            {n: ProviderConfig(name=n, kind="openai-chat") for n in providers},
            {"default": "local/qwen"},
        ),
        extract_text=lambda _pdf: PAGES,
        buckets=Buckets("inbox", "outputs", "runs"),
        render_preview=lambda pdf, i: b"jpg",
    )
    return deps, providers


# --- template format ------------------------------------------------------------------------


def test_context_must_come_from_an_earlier_step() -> None:
    Template.model_validate(CONTEXT_TEMPLATE)  # data (earlier) -> date: fine
    too_early = [
        {**TEMPLATE["pipeline"][0], "context": {"x": "results.batch"}},
        *TEMPLATE["pipeline"][1:],
    ]
    with pytest.raises(ValidationError, match="not filled by an earlier step"):
        Template.model_validate({**TEMPLATE, "pipeline": too_early})
    unknown = [{**PIPELINE[2], "context": {"x": "results.nope"}}]
    with pytest.raises(ValidationError, match="unknown field or column"):
        Template.model_validate({**TEMPLATE, "pipeline": [*PIPELINE[:2], *unknown, PIPELINE[3]]})


def test_a_bare_table_path_says_to_name_a_column() -> None:
    # Drafting models ask for a whole table ("results") as context or a check path; the error
    # they get back must say how to fix it, or they repeat it on the retry.
    bare = [{**PIPELINE[2], "context": {"x": "results"}}]
    with pytest.raises(ValidationError) as exc:
        Template.model_validate({**TEMPLATE, "pipeline": [*PIPELINE[:2], *bare, PIPELINE[3]]})
    assert (
        "context 'x': unknown field or column 'results': 'results' is a table, "
        "so name one of its columns: results.batch"
    ) in str(exc.value)
    check = {**TEMPLATE["pipeline"][3], "values": "results"}
    with pytest.raises(ValidationError, match="'results' is a table, so name one of its columns"):
        Template.model_validate({**TEMPLATE, "pipeline": [*TEMPLATE["pipeline"][:3], check]})


def test_compiled_steps_always_carry_a_context_list() -> None:
    t = Template.model_validate(TEMPLATE)
    assert compile_step(t, t.extract_steps()[0]).prompt_context["step_context"] == []


# --- running ---------------------------------------------------------------------------------


def test_context_values_with_counts_reach_the_prompt(tmp_path: Path) -> None:
    deps, providers = make(tmp_path, CONTEXT_RESPONSES)
    queue = FakeQueue(jobs=[JOB], templates={("demo", 1): CONTEXT_TEMPLATE})
    run_once(queue, deps, "w1")
    assert queue.awaiting, queue.reviewed or queue.failed
    date_prompt = providers["local"].calls[3][1].prompt
    assert "Context from earlier steps" in date_prompt
    assert "batches_seen (results.batch): G1 (1x), G2 (1x)" in date_prompt
    assert "Context from earlier steps" not in providers["local"].calls[0][1].prompt


def test_every_step_run_is_recorded(tmp_path: Path) -> None:
    deps, _ = make(tmp_path, RESPONSES)
    queue = FakeQueue(jobs=[JOB], templates={("demo", 1): TEMPLATE})
    run_once(queue, deps, "w1")
    runs = {r["step_id"]: r for r in queue.step_runs}
    assert set(runs) == {"header", "date", "data"}
    assert (runs["data"]["trigger"], runs["data"]["model"], runs["data"]["status"]) == (
        "process",
        "local/qwen",
        "succeeded",
    )
    assert runs["data"]["attempts"] == 2  # one per chunk
    assert runs["header"]["input_tokens"] == 10 and runs["header"]["started_at"]


def test_rerunning_one_step_replaces_only_its_outputs(tmp_path: Path) -> None:
    deps, providers = make(tmp_path, RESPONSES)
    queue = FakeQueue(jobs=[JOB], templates={("demo", 1): TEMPLATE})
    run_once(queue, deps, "w1")  # -> awaiting review ('Complies' issue in results row 2)
    calls_before = len(providers["local"].calls)

    providers["other"].responses = [
        {"rows": [{"batch": "G1", "value": "137.8", "aliases": []}]},
        {"rows": [{"batch": "G2", "value": "98.5", "aliases": ["G-2"]}]},
    ]
    rerun = {"step": "data", "model": "other/better", "instructions": "Results are numeric."}
    queue.jobs = [replace(JOB, task="rerun", rerun=rerun)]
    run_once(queue, deps, "w1")

    assert len(providers["local"].calls) == calls_before  # nothing else re-ran
    assert [m for m, _ in providers["other"].calls] == ["better", "better"]
    assert "Results are numeric." in providers["other"].calls[0][1].prompt
    [_, (job_id, outputs, reasons)] = queue.awaiting  # back in review, with fresh drafts
    assert job_id == "job-1"
    document = json.loads(next(o.body for o in outputs if o.output_id == "document"))
    assert [r["value"] for r in document["tables"]["results"]] == [137.8, 98.5]
    assert document["issues"] == [] and document["fields"]["product"]["value"] == "Richfer capsules"
    assert document["models"]["data"] == "other/better"
    assert (
        document["reruns"][0]["step"] == "data" and document["reruns"][0]["model"] == "other/better"
    )
    assert reasons == ["re-run of step data"]
    assert queue.step_runs[-1]["trigger"] == "rerun"


def test_rerun_of_an_unknown_step_goes_to_operator_review(tmp_path: Path) -> None:
    deps, _ = make(tmp_path, RESPONSES)
    queue = FakeQueue(jobs=[JOB], templates={("demo", 1): TEMPLATE})
    run_once(queue, deps, "w1")
    queue.jobs = [replace(JOB, task="rerun", rerun={"step": "nope"})]
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "no extract or plugin step 'nope'" in reason


def test_rerun_can_show_the_model_page_images(tmp_path: Path) -> None:
    """For handwriting OCR misread, the reviewer sends the page itself to a vision model."""
    deps, providers = make(tmp_path, RESPONSES)
    deps.render_page = lambda pdf, index, dim, rotation: b"\x89PNG" + bytes([index])
    queue = FakeQueue(jobs=[JOB], templates={("demo", 1): TEMPLATE})
    run_once(queue, deps, "w1")

    providers["other"].responses = [
        {"executed_on": {"value": "06/10/2023", "evidence": "06/10/23", "page": 3}}
    ]
    rerun = {"step": "date", "model": "other/vision", "pageImages": [3, 9]}
    queue.jobs = [replace(JOB, task="rerun", rerun=rerun)]
    run_once(queue, deps, "w1")

    [(_, request)] = providers["other"].calls
    assert request.images == (b"\x89PNG\x02",)  # page 9 does not exist: skipped
    document = json.loads(next(o.body for o in queue.awaiting[-1][1] if o.output_id == "document"))
    assert document["fields"]["executed_on"]["value"] == "2023-10-06"
    assert document["reruns"][0]["page_images"] == [3, 9]
