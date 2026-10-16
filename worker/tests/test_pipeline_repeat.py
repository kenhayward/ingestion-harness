"""run_step_extraction over the occurrences of a repeating section (spec 2026-10-16)."""

from __future__ import annotations

from typing import Any

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.pipeline import (
    PAGE_MARKER,
    Buckets,
    PipelineDeps,
    RepeatPlan,
    mark_pages,
    run_step_extraction,
)
from ingest_worker.queue import ClaimedJob
from ingest_worker.segment import Occurrence, segment_occurrences
from ingest_worker.step_cache import StepCache
from ingest_worker.storage import MemoryObjectStore
from ingest_worker.template import Template, compile_step

from .covalidation import BATCHES, PAGES, RECIPE, SECTIONS, edited
from .fakes import FakeProvider

JOB = ClaimedJob("job-1", "doc-1", "covalidation", 1, "inbox", "k.pdf", None, 1, 3)
ROWS = {"rows": [{"timepoint": "T0", "result": "Complies"}]}


def _deps(store: MemoryObjectStore, provider: FakeProvider) -> PipelineDeps:
    return PipelineDeps(
        store=store,
        specs=None,  # type: ignore[arg-type]
        models=ModelRegistry(
            {"local": provider},
            {"local": ProviderConfig(name="local", kind="openai-chat")},
            {"default": "local/qwen"},
        ),
        extract_text=lambda _pdf: PAGES,
        buckets=Buckets("inbox", "outputs", "runs"),
    )


def _segmented(pages: list[str] = PAGES) -> tuple[dict[str, str], dict[str, list[Occurrence]]]:
    result = segment_occurrences(mark_pages(pages, 1), SECTIONS, page_marker=PAGE_MARKER)
    return result.sections, result.occurrences


def _run(
    responses: list[Any],
    *,
    pages: list[str] = PAGES,
    occurrences: list[Occurrence] | None = None,
    chunk_pages: int | None = None,
    store: MemoryObjectStore | None = None,
    cache: StepCache | None = None,
    progress: Any = None,
) -> tuple[Any, FakeProvider, MemoryObjectStore]:
    template = Template.model_validate(RECIPE)
    step = next(s for s in template.extract_steps() if s.id == "appearance")
    ex = compile_step(template, step)
    if chunk_pages:
        ex = ex.model_copy(update={"chunk_pages": chunk_pages})
    sections, found = _segmented(pages)
    provider = FakeProvider("local", responses=responses)
    store = store or MemoryObjectStore()
    plan = RepeatPlan(
        "appearance", found["appearance"] if occurrences is None else occurrences, "batch"
    )
    result = run_step_extraction(
        JOB,
        _deps(store, provider),
        None,
        ex,
        provider,
        "qwen",
        sections,
        (),
        cache=cache,
        progress=progress,
        repeat=plan,
    )
    return result, provider, store


def test_one_call_per_occurrence_with_the_key_filled_by_the_worker() -> None:
    result, provider, _ = _run([ROWS] * 3)
    assert len(provider.calls) == 3
    prompts = [r.prompt for _, r in provider.calls]
    assert "occurrence 2 of 3" in prompts[1] and f"key: {BATCHES[1]}" in prompts[1]
    assert f'<section id="appearance" occurrence="2" key="{BATCHES[1]}">' in prompts[1]
    assert f"Batch {BATCHES[0]}" not in prompts[1]
    row = provider.calls[0][1].json_schema["properties"]["rows"]["items"]
    assert "batch" not in row["properties"] and "batch" not in row["required"]
    assert [r["batch"] for r in result.data["rows"]] == BATCHES


def test_occurrences_times_chunks() -> None:
    _, provider, store = _run([ROWS] * 3, chunk_pages=1)
    assert len(provider.calls) == 3
    assert any(k.startswith("job-1/appearance.occ-2.chunk-1/") for _, k in store.objects)
    assert "page 1 of 1" in provider.calls[0][1].prompt


def test_no_occurrences_makes_no_call_and_no_cache_entry() -> None:
    store = MemoryObjectStore()
    cache = StepCache(store, "runs")
    result, provider, _ = _run([], occurrences=[], store=store, cache=cache)
    assert provider.calls == [] and result.data == {"rows": []}
    assert not [k for _, k in store.objects if k.startswith("step-cache/")]


def test_progress_reports_the_occurrence() -> None:
    seen: list[Any] = []
    _run([ROWS] * 3, progress=lambda attempt, chunk, occurrence: seen.append(occurrence))
    assert seen == [{"n": i + 1, "of": 3, "key": b} for i, b in enumerate(BATCHES)]


def test_step_cache_round_trip_with_key_column() -> None:
    store = MemoryObjectStore()
    cache = StepCache(store, "runs")
    _run([ROWS] * 3, store=store, cache=cache)
    again, provider, _ = _run([], store=store, cache=cache)
    assert provider.calls == [] and again.cached
    assert [r["batch"] for r in again.data["rows"]] == BATCHES
    changed = edited("T0 Complies", "T6 Complies", 2)
    _, provider, _ = _run([ROWS] * 3, pages=changed, store=store, cache=cache)
    assert len(provider.calls) == 3
