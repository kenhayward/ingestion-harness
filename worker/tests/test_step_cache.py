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

PROVIDER: dict[str, Any] = {
    "kind": "openai-chat",
    "baseUrl": "http://lmstudio:1234/v1",
    "options": {"temperature": 0},
}

BASE: dict[str, Any] = dict(
    model_ref="local/qwen",
    provider=PROVIDER,
    step_id="header",
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
        {"provider": {**PROVIDER, "options": {"temperature": 0.2}}},
        {"provider": {**PROVIDER, "kind": "openai-responses"}},
        {"provider": {**PROVIDER, "baseUrl": "http://other-host:1234/v1"}},
        {"provider": {**PROVIDER, "baseUrl": None}},
        {"step_id": "date"},
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
    a = step_cache_key(
        **{**BASE, "provider": {**PROVIDER, "options": {"temperature": 0, "strict": False}}}
    )
    b = step_cache_key(
        **{**BASE, "provider": {**PROVIDER, "options": {"strict": False, "temperature": 0}}}
    )
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


def test_registry_cache_fingerprint_covers_kind_endpoint_and_answer_options() -> None:
    registry = ModelRegistry(
        {},
        {
            "local": ProviderConfig(
                name="local",
                kind="openai-chat",
                baseUrl="http://lmstudio:1234/v1",
                options={"temperature": 0, "timeoutS": 900, "maxRetries": 1},
            )
        },
        {},
    )
    assert registry.cache_fingerprint("local") == {
        "kind": "openai-chat",
        "baseUrl": "http://lmstudio:1234/v1",
        "options": {"temperature": 0},
    }
    assert registry.cache_fingerprint("nope") == {"kind": None, "baseUrl": None, "options": {}}


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


def run_data_step(
    tmp_path: Path,
    responses: list[Any],
    cache: StepCache,
    provider_config: dict[str, Any] | None = None,
) -> tuple[Any, Any]:
    """Run the chunked `data` step against fresh fakes sharing the cache's store."""
    deps, providers = make(tmp_path, responses)
    if provider_config:
        deps = replace(
            deps,
            models=ModelRegistry(
                providers,  # type: ignore[arg-type]
                {"local": ProviderConfig(name="local", kind="openai-chat", **provider_config)},
                {},
            ),
        )
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


def stored_products(store: MemoryObjectStore) -> list[str]:
    entries = [json.loads(store.get("runs", k))["data"] for k in cache_keys(store)]
    return [e["product"]["value"] for e in entries if "product" in e]


RENAMED = [
    {**RESPONSES[0], "product": {**RESPONSES[0]["product"], "value": "Richfer forte"}},
    *RESPONSES[1:],
]


def test_uncached_calls_the_models_and_refreshes_the_cache(tmp_path: Path) -> None:
    deps, providers = make(tmp_path, [*RESPONSES, *RENAMED])
    run(deps, WORKBENCH, TEMPLATE)
    assert stored_products(deps.store) == ["Richfer capsules"]  # type: ignore[arg-type]
    uncached = {"dataPolicy": "external", "uncached": True}
    queue = run(deps, replace(WORKBENCH, id="job-2", params=uncached), TEMPLATE)
    assert len(providers["local"].calls) == 8
    assert not any(r["cached"] for r in queue.step_runs)
    assert stored_products(deps.store) == ["Richfer forte"]  # type: ignore[arg-type]


def test_reference_runs_call_the_models_and_refresh_the_cache(tmp_path: Path) -> None:
    deps, providers = make(tmp_path, [*RESPONSES, *RENAMED])
    run(deps, WORKBENCH, TEMPLATE)
    reference = {"dataPolicy": "external", "forceReview": True}
    queue = run(deps, replace(WORKBENCH, id="job-2", params=reference), TEMPLATE)
    assert len(providers["local"].calls) == 8  # every step called again despite a warm cache
    assert queue.step_runs and not any(r["cached"] for r in queue.step_runs)
    assert stored_products(deps.store) == ["Richfer forte"]  # type: ignore[arg-type]


def test_the_data_policy_is_enforced_before_the_cache_is_read(tmp_path: Path) -> None:
    deps, providers = make(tmp_path, RESPONSES)  # both fake providers count as external
    run(deps, WORKBENCH, TEMPLATE)
    assert cache_keys(deps.store)  # type: ignore[arg-type]
    calls = len(providers["local"].calls)
    queue = run(deps, replace(WORKBENCH, id="job-2", params={"dataPolicy": "local"}), TEMPLATE)
    assert len(providers["local"].calls) == calls
    assert [job_id for job_id, _ in queue.reviewed] == ["job-2"]
    assert "data policy" in queue.reviewed[0][1]
    assert queue.step_runs == []


def test_a_cached_entry_that_fails_the_step_schema_is_a_miss(tmp_path: Path) -> None:
    store = MemoryObjectStore()
    cache = StepCache(store, "runs")
    run_data_step(tmp_path, DATA_ROWS, cache)
    [key] = cache_keys(store)
    cache_key = key.removeprefix("step-cache/").removesuffix(".json")
    cache.put(cache_key, CachedStep({"rows": "not a list"}, "local/qwen", None, None))

    result, provider = run_data_step(tmp_path, DATA_ROWS, cache)
    assert len(provider.calls) == 2 and result.cached is False
    expected = {"rows": [*RESPONSES[2]["rows"], *RESPONSES[3]["rows"]]}
    assert result.data == expected
    assert json.loads(store.get("runs", key))["data"] == expected


def test_a_different_provider_endpoint_misses_the_cache(tmp_path: Path) -> None:
    store = MemoryObjectStore()
    cache = StepCache(store, "runs")
    run_data_step(tmp_path, DATA_ROWS, cache)
    moved = {"baseUrl": "http://elsewhere:1234/v1"}
    result, provider = run_data_step(tmp_path, DATA_ROWS, cache, provider_config=moved)
    assert len(provider.calls) == 2 and result.cached is False
    assert len(cache_keys(store)) == 2


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
