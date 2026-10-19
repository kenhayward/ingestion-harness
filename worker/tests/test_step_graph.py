"""The LangGraph trial (docs/design/langgraph-trial.md): a recipe's steps run as a LangGraph
graph with a checkpoint after each step, so a job that stops part way (a crash, a lost worker,
an outage) resumes at the step it stopped at instead of calling the model again for the steps
it had finished. Every other observable behaviour is unchanged (tests/test_equivalence.py runs
its scenarios through both executors)."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
import yaml
from langgraph.checkpoint.memory import InMemorySaver

from ingest_worker.llm.base import RefusalError
from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.step_graph import doc_from_state, doc_to_state, thread_key
from ingest_worker.storage import MemoryObjectStore
from ingest_worker.template_pipeline import DocState

from .fakes import FakeProvider, FakeQueue
from .test_template_pipeline import JOB, PAGES, RESPONSES, TEMPLATE

HEADER, DATE, CHUNK_1, CHUNK_2 = RESPONSES


def setup(
    tmp_path: Path, template: dict[str, Any] = TEMPLATE, responses: list[Any] | None = None
) -> tuple[PipelineDeps, FakeProvider, InMemorySaver]:
    directory = tmp_path / template["id"] / f"v{template['version']}"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(template), encoding="utf-8")
    provider = FakeProvider("local", responses=list(responses or []))
    saver = InMemorySaver()
    store = MemoryObjectStore()
    store.put("inbox", JOB.object_key, b"%PDF", "application/pdf")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=ModelRegistry(
            {"local": provider},
            {"local": ProviderConfig(name="local", kind="openai-chat")},
            {"default": "local/qwen", "other": "local/other"},
        ),
        extract_text=lambda _pdf: PAGES,
        buckets=Buckets("inbox", "outputs", "runs"),
        step_checkpointer=saver,
    )
    return deps, provider, saver


def threads(saver: InMemorySaver) -> set[str]:
    return {c.config["configurable"]["thread_id"] for c in saver.list(None)}


def steps_called(provider: FakeProvider) -> list[str]:
    """The step each model call was for, read from the prompt's output schema name."""
    return [request.schema_name for _, request in provider.calls]


def test_a_job_that_stops_part_way_resumes_at_the_step_it_stopped_at(tmp_path: Path) -> None:
    deps, provider, saver = setup(tmp_path, responses=[HEADER, RuntimeError("worker lost")])
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    assert queue.failed and not queue.awaiting  # an outage: retried later
    assert len(threads(saver)) == 1  # its finished steps are kept

    provider.responses = [DATE, CHUNK_1, CHUNK_2]
    queue.jobs = [replace(JOB, attempts=2)]
    run_once(queue, deps, "w1")

    assert queue.awaiting, queue.reviewed or queue.failed
    assert steps_called(provider) == ["header", "date", "date", "data", "data"]
    assert [r["step_id"] for r in queue.step_runs if r["status"] == "succeeded"] == [
        "header",
        "date",
        "data",
    ]
    assert threads(saver) == set()  # finished: nothing left to resume


def test_the_resumed_document_equals_one_run_in_one_go(tmp_path: Path) -> None:
    deps, _, _ = setup(tmp_path / "once", responses=list(RESPONSES))
    once = FakeQueue(jobs=[JOB])
    run_once(once, deps, "w1")
    whole = deps.store.get("outputs", "demo/v1/document/doc-1.json")

    deps2, provider, _ = setup(tmp_path / "twice", responses=[HEADER, RuntimeError("lost")])
    twice = FakeQueue(jobs=[JOB])
    run_once(twice, deps2, "w1")
    provider.responses = [DATE, CHUNK_1, CHUNK_2]
    twice.jobs = [JOB]
    run_once(twice, deps2, "w1")
    resumed = deps2.store.get("outputs", "demo/v1/document/doc-1.json")

    def stable(body: bytes) -> str:
        return body.decode().split('"extracted_at"')[0] + body.decode().split('"page_count"')[1]

    assert stable(resumed) == stable(whole)


def test_a_document_problem_ends_the_thread(tmp_path: Path) -> None:
    deps, _, saver = setup(tmp_path, responses=[HEADER, RefusalError("no")])
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    assert queue.reviewed and threads(saver) == set()


def test_a_cancel_between_steps_wins_and_ends_the_thread(tmp_path: Path) -> None:
    deps, provider, saver = setup(tmp_path, responses=[HEADER, DATE, CHUNK_1, CHUNK_2])
    queue = FakeQueue(jobs=[JOB], cancel_when=lambda: len(provider.calls) >= 1)
    run_once(queue, deps, "w1")
    assert steps_called(provider) == ["header"]
    assert not queue.awaiting and not queue.completed and not queue.failed
    assert ("job-1", "warn", "cancelled") in queue.events
    assert threads(saver) == set()


def test_another_model_or_version_starts_afresh(tmp_path: Path) -> None:
    deps, provider, _ = setup(tmp_path, responses=[HEADER, RuntimeError("lost")])
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")

    provider.responses = [HEADER, DATE, CHUNK_1, CHUNK_2]
    queue.jobs = [replace(JOB, model_override="other")]
    run_once(queue, deps, "w1")
    assert steps_called(provider)[2:] == ["header", "date", "data", "data"]


def test_a_recipe_with_many_steps_runs_to_the_end(tmp_path: Path) -> None:
    n = 40  # LangGraph stops a run after 25 steps unless told otherwise
    template = {
        **TEMPLATE,
        "outputs": {"fields": [{"id": f"f{i}", "type": "text"} for i in range(n)]},
        "pipeline": [
            {"type": "extract", "id": f"s{i}", "fields": [f"f{i}"], "sections": ["head"]}
            for i in range(n)
        ],
        "review": {"required": "always"},
    }
    responses = [{f"f{i}": {"value": str(i), "evidence": None, "page": 1}} for i in range(n)]
    deps, provider, saver = setup(tmp_path, template, responses)
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    assert queue.awaiting, queue.reviewed or queue.failed
    assert len(provider.calls) == n and threads(saver) == set()


def test_without_a_checkpointer_the_steps_run_as_before(tmp_path: Path) -> None:
    deps, provider, _ = setup(tmp_path, responses=[HEADER, RuntimeError("lost")])
    deps.step_checkpointer = None
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    provider.responses = [HEADER, DATE, CHUNK_1, CHUNK_2]
    queue.jobs = [JOB]
    run_once(queue, deps, "w1")
    assert steps_called(provider) == ["header", "date", "header", "date", "data", "data"]


def test_the_state_round_trips_through_a_checkpoint() -> None:
    state = DocState(
        fields={"product": {"value": "A", "evidence": None, "page": 1}},
        tables={"results": [{"batch": "G1", "aliases": ["x"]}]},
        checks={"c": {"rows": []}},
        issues=({"step": "data", "row": 2},),
        step_results={"header": {"product": {"value": "A"}}},
        models={"header": "local/qwen"},
    )
    stored = doc_to_state(state)
    assert isinstance(stored["issues"], list)
    assert doc_from_state(stored) == state


def test_the_thread_key_names_the_job_and_what_it_runs() -> None:
    key = thread_key(JOB, "demo", 1, "sha-1")
    assert key.startswith("process:job-1:")
    assert thread_key(JOB, "demo", 1, "sha-1") == key
    assert thread_key(replace(JOB, model_override="other"), "demo", 1, "sha-1") != key
    assert thread_key(JOB, "demo", 2, "sha-1") != key
    assert thread_key(JOB, "demo", 1, "sha-2") != key
    assert thread_key(replace(JOB, params={"uncached": True}), "demo", 1, "sha-1") != key


def test_job_ids_never_share_a_thread() -> None:
    other = ClaimedJob("job-2", "doc-1", "demo", 1, "inbox", "demo/v1/doc-1.pdf", None, 1, 3)
    assert thread_key(other, "demo", 1, "sha-1") != thread_key(JOB, "demo", 1, "sha-1")


@pytest.mark.parametrize("value", [None, ""])
def test_the_flag_is_off_unless_set_to_langgraph(value: str | None) -> None:
    from ingest_worker.step_graph import step_graph_enabled

    assert step_graph_enabled({} if value is None else {"WORKER_STEP_GRAPH": value}) is False
    assert step_graph_enabled({"WORKER_STEP_GRAPH": "langgraph"}) is True


def test_nothing_is_traced_to_langsmith_whatever_the_environment_says(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from langsmith.utils import tracing_is_enabled

    from ingest_worker.step_graph import run_steps

    monkeypatch.setenv("LANGSMITH_TRACING", "true")
    monkeypatch.setenv("LANGCHAIN_TRACING_V2", "true")
    monkeypatch.setenv("LANGSMITH_API_KEY", "lsv2-not-a-key")
    assert tracing_is_enabled() is True  # what the environment asks for
    seen: list[bool] = []

    def probe(state: DocState) -> DocState:
        seen.append(bool(tracing_is_enabled()))
        return state

    run_steps(JOB, FakeQueue(), InMemorySaver(), "t", [("a", probe), ("b", probe)], DocState())
    assert seen == [False, False]


def test_a_last_attempt_that_fails_leaves_no_thread_behind(tmp_path: Path) -> None:
    deps, _, saver = setup(tmp_path, responses=[HEADER, RuntimeError("lost again")])
    queue = FakeQueue(jobs=[replace(JOB, attempts=3, max_attempts=3)])
    run_once(queue, deps, "w1")
    assert queue.failed and threads(saver) == set()  # no retry will come to resume it
