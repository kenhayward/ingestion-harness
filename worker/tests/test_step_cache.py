"""Step cache (ADR 0007, phase 4b): keyed by the step's full input; reused by workbench runs."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.extract import ExtractionResult
from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import run_step_extraction
from ingest_worker.segment import PAGE_BREAK
from ingest_worker.step_cache import CachedStep, StepCache, step_cache_key
from ingest_worker.storage import MemoryObjectStore, step_cache_object_key
from ingest_worker.template import Template, compile_step

from .fakes import FakeQueue
from .test_step_context import CONTEXT_RESPONSES, CONTEXT_TEMPLATE, make
from .test_template_pipeline import JOB, PAGES, RESPONSES, TEMPLATE

BASE: dict[str, Any] = dict(
    model_ref="local/qwen",
    options={"temperature": 0},
    system="sys",
    schema={"type": "object"},
    prompts=["prompt one"],
    images=(b"img",),
    max_tokens=1000,
    max_attempts=2,
)


@pytest.mark.parametrize(
    "change",
    [
        {"model_ref": "local/other"},
        {"options": {"temperature": 0.2}},
        {"system": "other system"},
        {"schema": {"type": "object", "required": ["a"]}},
        {"prompts": ["prompt one (edited)"]},
        {"prompts": ["prompt one", "chunk two"]},
        {"images": (b"other",)},
        {"images": ()},
        {"max_tokens": 2000},
        {"max_attempts": 3},
    ],
)
def test_every_input_changes_the_key(change: dict[str, Any]) -> None:
    assert step_cache_key(**{**BASE, **change}) != step_cache_key(**BASE)


def test_the_key_is_stable_and_ignores_option_order() -> None:
    a = step_cache_key(**{**BASE, "options": {"temperature": 0, "strict": False}})
    b = step_cache_key(**{**BASE, "options": {"strict": False, "temperature": 0}})
    assert a == b and len(a) == 64


def test_registry_options_drop_operational_settings() -> None:
    registry = ModelRegistry(
        {},
        {
            "local": ProviderConfig(
                name="local",
                kind="openai-chat",
                options={"temperature": 0, "timeoutS": 900, "maxRetries": 1},
            )
        },
        {},
    )
    assert registry.options("local") == {"temperature": 0}
    assert registry.options("nope") == {}


def test_cache_round_trip_and_unreadable_entries_are_misses() -> None:
    store = MemoryObjectStore()
    cache = StepCache(store, "runs")
    entry = CachedStep(data={"a": 1}, model_ref="local/qwen", input_tokens=10, output_tokens=5)
    cache.put("k1", entry)
    assert cache.get("k1") == entry
    assert cache.get("missing") is None
    store.put("runs", step_cache_object_key("bad"), b"{not json", "application/json")
    assert cache.get("bad") is None
    assert StepCache(store, "runs", read=False).get("k1") is None


# --- run_step_extraction with a cache ---------------------------------------------------------

DATA_ROWS = [RESPONSES[2], RESPONSES[3]]  # one response per chunk of the `data` step
SECTIONS = {"head": PAGES[0], "body": PAGE_BREAK.join(PAGES[1:])}


def run_data_step(tmp_path: Path, responses: list[Any], cache: StepCache) -> tuple[Any, Any]:
    """Run the chunked `data` step against fresh fakes sharing the cache's store."""
    deps, providers = make(tmp_path, responses)
    template = Template.model_validate(TEMPLATE)
    step = next(s for s in template.extract_steps() if s.id == "data")
    result = run_step_extraction(
        JOB,
        deps,
        None,
        compile_step(template, step),
        providers["local"],
        "qwen",
        SECTIONS,
        (),
        cache=cache,
    )
    return result, providers["local"]


def cache_keys(store: MemoryObjectStore) -> list[str]:
    return [k for (b, k) in store.objects if b == "runs" and k.startswith("step-cache/")]


def test_a_cached_chunked_step_returns_the_merged_rows_without_calling_the_model(
    tmp_path: Path,
) -> None:
    store = MemoryObjectStore()
    cache = StepCache(store, "runs")
    first, provider = run_data_step(tmp_path, DATA_ROWS, cache)
    assert len(provider.calls) == 2  # one call per chunk
    assert first.cached is False
    expected = {"rows": [*RESPONSES[2]["rows"], *RESPONSES[3]["rows"]]}
    assert first.data == expected
    [key] = cache_keys(store)
    stored = json.loads(store.get("runs", key))
    assert stored["data"] == expected and stored["modelRef"] == "local/qwen"
    assert (stored["inputTokens"], stored["outputTokens"]) == (20, 10)  # summed over chunks

    second, provider = run_data_step(tmp_path, [], cache)
    assert provider.calls == []
    assert isinstance(second, ExtractionResult)
    assert second.cached is True
    assert second.attempts == []
    assert second.data == expected
    assert second.model_ref == "local/qwen"


def test_a_cache_that_does_not_read_still_calls_the_model_and_refreshes_the_entry(
    tmp_path: Path,
) -> None:
    store = MemoryObjectStore()
    run_data_step(tmp_path, DATA_ROWS, StepCache(store, "runs"))
    changed = [
        {"rows": [{"batch": "G9", "value": "1", "aliases": []}]},
        {"rows": []},
    ]
    result, provider = run_data_step(tmp_path, changed, StepCache(store, "runs", read=False))
    assert len(provider.calls) == 2 and result.cached is False
    [key] = cache_keys(store)
    assert json.loads(store.get("runs", key))["data"] == {"rows": changed[0]["rows"]}


def test_a_corrupt_cache_entry_is_a_miss_and_is_overwritten(tmp_path: Path) -> None:
    store = MemoryObjectStore()
    cache = StepCache(store, "runs")
    run_data_step(tmp_path, DATA_ROWS, cache)
    [key] = cache_keys(store)
    store.put("runs", key, b"{garbage", "application/json")

    result, provider = run_data_step(tmp_path, DATA_ROWS, cache)
    assert len(provider.calls) == 2
    assert result.cached is False
    expected = {"rows": [*RESPONSES[2]["rows"], *RESPONSES[3]["rows"]]}
    assert result.data == expected
    assert cache_keys(store) == [key]
    cache_key = key.removeprefix("step-cache/").removesuffix(".json")
    assert cache.get(cache_key) == CachedStep(
        data=expected, model_ref="local/qwen", input_tokens=20, output_tokens=10
    )


# --- which jobs use the cache -----------------------------------------------------------------

WORKBENCH = replace(JOB, test=True, project_id="demo", params={"dataPolicy": "external"})


def run(deps, job, template):  # type: ignore[no-untyped-def]
    queue = FakeQueue(jobs=[job], templates={("demo", 1): template})
    run_once(queue, deps, "w1")
    return queue


def test_an_unchanged_workbench_run_reuses_every_step(tmp_path: Path) -> None:
    deps, providers = make(tmp_path, RESPONSES)
    run(deps, WORKBENCH, TEMPLATE)
    calls = len(providers["local"].calls)
    queue = run(deps, replace(WORKBENCH, id="job-2"), TEMPLATE)
    assert len(providers["local"].calls) == calls
    runs = {r["step_id"]: r for r in queue.step_runs}
    assert set(runs) == {"header", "date", "data"}
    assert all(r["cached"] and r["attempts"] == 0 for r in runs.values())
    assert any(msg == "reused cached header" for _, _, msg in queue.events)


def test_production_and_regression_jobs_never_use_the_cache(tmp_path: Path) -> None:
    deps, providers = make(tmp_path, RESPONSES * 3)
    regression = replace(JOB, id="job-3", test=True)  # a test run without a project
    run(deps, JOB, TEMPLATE)
    run(deps, replace(JOB, id="job-2"), TEMPLATE)
    run(deps, regression, TEMPLATE)
    assert len(providers["local"].calls) == 3 * 4  # header, date, two data chunks each
    assert not cache_keys(deps.store)  # type: ignore[arg-type]


def test_a_rerun_neither_reads_nor_writes_the_cache(tmp_path: Path) -> None:
    deps, providers = make(tmp_path, RESPONSES)
    run(deps, WORKBENCH, TEMPLATE)
    stored = cache_keys(deps.store)  # type: ignore[arg-type]
    assert stored
    providers["local"].responses = [RESPONSES[0]]
    before = len(providers["local"].calls)
    queue = run(deps, replace(WORKBENCH, task="rerun", rerun={"step": "header"}), TEMPLATE)
    assert len(providers["local"].calls) == before + 1  # called the model despite a cached entry
    assert cache_keys(deps.store) == stored  # type: ignore[arg-type]
    assert queue.step_runs[-1]["cached"] is False


def test_uncached_calls_the_models_and_refreshes_the_cache(tmp_path: Path) -> None:
    deps, providers = make(tmp_path, RESPONSES * 2)
    run(deps, WORKBENCH, TEMPLATE)
    uncached = {"dataPolicy": "external", "uncached": True}
    queue = run(deps, replace(WORKBENCH, id="job-2", params=uncached), TEMPLATE)
    assert len(providers["local"].calls) == 8
    assert not any(r["cached"] for r in queue.step_runs)


def test_changing_one_step_reruns_it_and_the_steps_that_use_its_values(tmp_path: Path) -> None:
    # data (chunked) feeds the date step's context; header is independent.
    changed_rows = [
        {"rows": [{"batch": "G9", "value": "1.0", "aliases": []}]},
        {"rows": [{"batch": "G8", "value": "2.0", "aliases": []}]},
    ]
    deps, providers = make(tmp_path, [*CONTEXT_RESPONSES, *changed_rows, CONTEXT_RESPONSES[3]])
    run(deps, WORKBENCH, CONTEXT_TEMPLATE)
    first = len(providers["local"].calls)
    pipeline = [dict(s) for s in CONTEXT_TEMPLATE["pipeline"]]
    pipeline[1] = {**pipeline[1], "instructions": "Results are numeric."}  # the data step
    queue = run(deps, replace(WORKBENCH, id="job-2"), {**CONTEXT_TEMPLATE, "pipeline": pipeline})
    cached = {r["step_id"]: r["cached"] for r in queue.step_runs}
    assert cached == {"header": True, "data": False, "date": False}
    assert len(providers["local"].calls) == first + 3  # two data chunks + date
