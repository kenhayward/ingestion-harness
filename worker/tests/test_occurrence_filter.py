"""A step's occurrence filter (plan 2026-10-21-occurrence-filter): the head it is judged on, the
match, and a job's calls and rows when steps filter one repeating section."""

from __future__ import annotations

import copy
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
import yaml

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps, RepeatPlan
from ingest_worker.segment import (
    OCCURRENCE_HEAD_CHARS,
    Occurrence,
    occurrence_head,
    occurrence_matches,
)
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore
from ingest_worker.template import PluginStep
from ingest_worker.template_pipeline import STEP_PROGRESS, filtered_plan

from .covalidation import BATCHES, PAGES, RECIPE
from .fakes import FakeProvider, FakeQueue
from .test_template_repeat import BATCH_ROWS, HEADER, JOB, TABLE_ROWS, document, responses


def _occ(text: str) -> Occurrence:
    return Occurrence(1, 1, None, None, None, text)


@pytest.mark.parametrize(
    ("text", "head"),
    [
        ("Table 1: Appearance\nResults", "Table 1: Appearance Results"),
        # A title wrapped over lines, OCR spacing and a page break read as one line.
        (
            "Table 2:   Assay and\n   Chromatographic\tPurity\n\f\nResults",
            "Table 2: Assay and Chromatographic Purity Results",
        ),
        # Page markers are not part of the heading.
        ("[page 37]\nTable 3: Dissolution\n[page 38]\nResults", "Table 3: Dissolution Results"),
        ("  \n Table 4  ", "Table 4"),
    ],
)
def test_occurrence_head(text: str, head: str) -> None:
    assert occurrence_head(text) == head


def test_occurrence_head_is_cut_at_its_length() -> None:
    assert len(occurrence_head("word " * 400)) <= OCCURRENCE_HEAD_CHARS


@pytest.mark.parametrize(
    ("pattern", "text", "matches"),
    [
        (
            "Appearance and Water Content",
            "Table 1: Study 9 - Appearance and Water\nContent Results",
            True,
        ),
        (r"appearance\s+and\s+water", "Table 1: APPEARANCE AND WATER CONTENT", True),
        ("Microbial Purity", "Table 1: Appearance and Water Content Results\nT0 Complies", False),
        # The body is not the heading: words of another kind far below it never match.
        (
            "Microbial Purity",
            "Table 1: Appearance Results\n" + "T0 Complies\n" * 80 + "Microbial Purity",
            False,
        ),
        (
            r"Assay.*\(Niraparib",
            "Table 2: Assay and Chromatographic Purity\n(Niraparib tosylate) Results",
            True,
        ),
    ],
)
def test_occurrence_matches(pattern: str, text: str, matches: bool) -> None:
    assert occurrence_matches(pattern, _occ(text)) is matches


# A job over the covalidation pages with the appearance and microbial tables in one repeating
# section, each step filtering its own kind.
def _recipe(appearance: str | None, microbial: str | None, **step: Any) -> dict[str, Any]:
    recipe = copy.deepcopy(RECIPE)
    sections = [
        s for s in recipe["document"]["sections"] if s["id"] not in ("appearance", "microbial")
    ]
    sections.insert(
        2,
        {
            "id": "tables",
            "anchor": r"^Table \d+:",
            "repeat": True,
            "key": r"Batch\s+(\w+)",
            "keyFrom": "batch",
        },
    )
    recipe["document"]["sections"] = sections
    for s in recipe["pipeline"]:
        if s["id"] in ("appearance", "microbial"):
            s["sections"] = ["tables"]
            match = appearance if s["id"] == "appearance" else microbial
            if match is not None:
                s["occurrences"] = {"match": match}
            if s["id"] == "appearance":
                s.update(step)
    return recipe


def _run(
    tmp_path: Path, recipe: dict[str, Any], replies: list[Any], pages: list[str] = PAGES
) -> tuple[FakeProvider, PipelineDeps, FakeQueue]:
    directory = tmp_path / "covalidation" / "v1"
    directory.mkdir(parents=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(recipe), encoding="utf-8")
    provider = FakeProvider("local", responses=list(replies))
    store = MemoryObjectStore()
    store.put("inbox", JOB.object_key, b"%PDF", "application/pdf")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=ModelRegistry(
            {"local": provider},
            {"local": ProviderConfig(name="local", kind="openai-chat")},
            {"default": "local/qwen"},
        ),
        extract_text=lambda _pdf: pages,
        buckets=Buckets("inbox", "outputs", "runs"),
        render_preview=lambda pdf, i: b"jpg",
    )
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    return provider, deps, queue


def _prompts(provider: FakeProvider, needle: str) -> list[str]:
    return [r.prompt for _, r in provider.calls if needle in r.prompt]


def _extracted(queue: FakeQueue) -> dict[str, dict[str, Any]]:
    return {m: d for _, _, m, d in queue.event_details if m.startswith("extracted ")}


def test_each_step_calls_the_model_only_for_its_own_kind(tmp_path: Path) -> None:
    recipe = _recipe("Appearance and Water Content", "Microbial Purity")
    provider, deps, _ = _run(tmp_path, recipe, responses())
    # Without the filters both steps would read all six tables: 1 + 3 + 6 + 6 calls.
    assert len(provider.calls) == 10
    appearance = _prompts(provider, 'Task: extract the table "appearance_results"')
    assert len(appearance) == 3
    assert all("Appearance and Water Content Results" in p for p in appearance)
    assert not any("Microbial Purity Results" in p for p in appearance)
    doc = document(deps.store)  # type: ignore[arg-type]
    assert [r["batch"] for r in doc["tables"]["appearance_results"]] == BATCHES
    assert [r["batch"] for r in doc["tables"]["microbial_results"]] == BATCHES


def test_the_extracted_event_says_how_many_occurrences_matched(tmp_path: Path) -> None:
    _, _, queue = _run(
        tmp_path, _recipe("Appearance", None), [HEADER, *[BATCH_ROWS] * 3, *[TABLE_ROWS] * 9]
    )
    by_step = _extracted(queue)
    assert by_step["extracted appearance"]["occurrences"] == {"matched": 3, "of": 6}
    assert by_step["extracted appearance"]["calls"] == 3
    assert "occurrences" not in by_step["extracted microbial"]
    assert by_step["extracted microbial"]["calls"] == 6


def test_a_filter_matching_nothing_makes_no_call_and_no_rows(tmp_path: Path) -> None:
    replies = [HEADER, *[BATCH_ROWS] * 3, *[TABLE_ROWS] * 3]
    provider, deps, queue = _run(tmp_path, _recipe("Dissolution", "Microbial Purity"), replies)
    assert len(provider.calls) == 7
    assert document(deps.store)["tables"]["appearance_results"] == []  # type: ignore[arg-type]
    event = _extracted(queue)["extracted appearance"]
    assert event["occurrences"] == {"matched": 0, "of": 6}
    assert event["calls"] == 0


def test_progress_counts_the_matched_occurrences(tmp_path: Path) -> None:
    _, _, queue = _run(tmp_path, _recipe("Appearance", "Microbial"), responses())
    events = [d for _, _, m, d in queue.event_details if m == STEP_PROGRESS]
    assert [e["occurrence"] for e in events if e["step"] == "microbial"] == [
        {"n": i + 1, "of": 3, "key": b} for i, b in enumerate(BATCHES)
    ]


def test_a_rerun_of_a_filtered_step_reads_only_its_kind(tmp_path: Path) -> None:
    provider, deps, queue = _run(tmp_path, _recipe("Appearance", "Microbial"), responses())
    provider.responses.extend([TABLE_ROWS] * 3)
    calls = len(provider.calls)
    queue.jobs = [replace(JOB, task="rerun", rerun={"step": "appearance"})]
    run_once(queue, deps, "w1")
    assert len(provider.calls) == calls + 3


def test_a_continuation_chunk_quotes_its_occurrence_start_as_tagged_text(tmp_path: Path) -> None:
    batch = BATCHES[0]
    pages = [
        "STABILITY REPORT\nStudy STUDY-202432",
        f"1. STUDY-202432 - BATCH {batch} (LDLS000) PACKED AS HDPE BOTTLE\n"
        f"Table 1: Study-202432 - Batch {batch} - Appearance and Water Content Results\n"
        "T0 Complies",
        "T3 <b>Complies</b>",
        f"Table 2: Study-202432 - Batch {batch} - Microbial Purity Results\nT0 Complies",
    ]
    recipe = _recipe("Appearance", "Microbial", chunkPages=1)
    replies = [HEADER, BATCH_ROWS, TABLE_ROWS, TABLE_ROWS, TABLE_ROWS]
    provider, _, _ = _run(tmp_path, recipe, replies, pages)
    # Two chunks: the page holding only the next table's page marker is not sent.
    first, second = _prompts(provider, 'Task: extract the table "appearance_results"')
    assert "<occurrence_start>" not in first
    start = second.split("<occurrence_start>\n", 1)[1].split("\n</occurrence_start>", 1)[0]
    assert start.startswith(f"Table 1: Study-202432 - Batch {batch} - Appearance and Water")
    assert "<b>" not in start and "bComplies/b" in start


def test_a_plugin_steps_plan_is_filtered_like_an_extract_steps() -> None:
    """Plugin steps (jobs and the plugin preview) go through the same filter."""
    step = PluginStep.model_validate(
        {
            "type": "plugin",
            "id": "microbial",
            "uses": "text.pattern@1",
            "table": "microbial_results",
            "sections": ["tables"],
            "occurrences": {"match": "Microbial"},
        }
    )
    occurrences = [
        Occurrence(1, 2, "A", None, None, "Table 1: Appearance Results"),
        Occurrence(2, 2, "A", None, None, "Table 2: Microbial Purity Results"),
    ]
    plan = filtered_plan(RepeatPlan("tables", occurrences, None), step)
    assert [o.index for o in plan.occurrences] == [2]
    assert plan.of == 2
    unfiltered = RepeatPlan("tables", occurrences, None)
    assert filtered_plan(unfiltered, step.model_copy(update={"occurrences": None})) is unfiltered
