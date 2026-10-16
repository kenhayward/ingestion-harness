"""Template jobs over repeating sections (spec 2026-10-16): the covalidation worked example."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import yaml

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore
from ingest_worker.template_pipeline import STEP_PROGRESS

from .covalidation import BATCHES, PAGES, RECIPE, edited
from .fakes import FakeProvider, FakeQueue

JOB = ClaimedJob(
    "job-1", "doc-1", "covalidation", 1, "inbox", "covalidation/v1/doc-1.pdf", None, 1, 3
)
DOC_KEY = "covalidation/v1/document/doc-1.json"
HEADER = {"study": {"value": "STUDY-202432", "evidence": "Study STUDY-202432", "page": 1}}
BATCH_ROWS = {"rows": [{"packaging": "HDPE bottle"}]}
TABLE_ROWS = {"rows": [{"timepoint": "T0", "result": "Complies"}]}


def responses(batches: int = 3, appearance: int = 3, microbial: int = 3) -> list[Any]:
    return [
        HEADER,
        *[BATCH_ROWS] * batches,
        *[TABLE_ROWS] * appearance,
        *[TABLE_ROWS] * microbial,
    ]


def run_covalidation(
    tmp_path: Path, pages: list[str] = PAGES, replies: list[Any] | None = None
) -> tuple[FakeProvider, MemoryObjectStore, FakeQueue]:
    provider, deps = covalidation_deps(tmp_path, pages, replies)
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    return provider, deps.store, queue  # type: ignore[return-value]


def covalidation_deps(
    tmp_path: Path, pages: list[str], replies: list[Any] | None
) -> tuple[FakeProvider, PipelineDeps]:
    directory = tmp_path / "covalidation" / "v1"
    directory.mkdir(parents=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(RECIPE), encoding="utf-8")
    provider = FakeProvider("local", responses=list(responses() if replies is None else replies))
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
    return provider, deps


def document(store: MemoryObjectStore) -> dict[str, Any]:
    result: dict[str, Any] = json.loads(store.get("outputs", DOC_KEY))
    return result


def messages(doc: dict[str, Any]) -> list[str]:
    return [i["message"] for i in doc["issues"]]


def test_covalidation_rows_carry_the_batch(tmp_path: Path) -> None:
    provider, store, queue = run_covalidation(tmp_path)
    assert len(provider.calls) == 10
    doc = document(store)
    for table in ("batches", "appearance_results", "microbial_results"):
        assert [r["batch"] for r in doc["tables"][table]] == BATCHES
    assert doc["issues"] == [] and doc["review_reasons"] == []
    assert queue.completed


def test_inherited_key_fills_the_key_column(tmp_path: Path) -> None:
    pages = edited(
        f"Study-202432 - Batch {BATCHES[1]} - Appearance", "Study-202432 - Appearance", 2
    )
    _, store, _ = run_covalidation(tmp_path, pages=pages)
    doc = document(store)
    assert [r["batch"] for r in doc["tables"]["appearance_results"]] == BATCHES
    assert doc["issues"] == []


def test_a_table_missed_for_one_batch_goes_to_review(tmp_path: Path) -> None:
    pages = edited("Microbial Purity", "Microbal Purity", 3)
    provider, store, queue = run_covalidation(tmp_path, pages=pages, replies=responses(microbial=2))
    assert len(provider.calls) == 9
    doc = document(store)
    assert {
        "step": "segment",
        "target": "microbial",
        "row": None,
        "column": None,
        "raw": None,
        "message": f"microbial: no occurrence for batch {BATCHES[2]}",
    } in doc["issues"]
    assert "1 section key issue(s)" in doc["review_reasons"]
    assert queue.awaiting and not queue.failed
    assert len(doc["tables"]["appearance_results"]) == 3


def test_list_of_tables_is_an_extra_occurrence_and_a_key_issue(tmp_path: Path) -> None:
    pages = edited(
        "Study STUDY-202432", "Table 0: Study-202432 - Appearance and Water Content Results", 0
    )
    replies = [HEADER, *[BATCH_ROWS] * 3, {"rows": []}, *[TABLE_ROWS] * 6]
    provider, store, queue = run_covalidation(tmp_path, pages=pages, replies=replies)
    assert len(provider.calls) == 11
    doc = document(store)
    assert "appearance occurrence 1: no key" in messages(doc)
    assert [r["batch"] for r in doc["tables"]["appearance_results"]] == BATCHES
    assert queue.awaiting and not queue.failed


def test_a_row_without_a_key_is_an_issue(tmp_path: Path) -> None:
    # A caption without a batch before the first heading: neither key nor keyFrom finds one.
    pages = edited(
        "Study STUDY-202432", "Table 0: Study-202432 - Appearance and Water Content Results", 0
    )
    replies = [HEADER, *[BATCH_ROWS] * 3, *[TABLE_ROWS] * 7]
    _, store, queue = run_covalidation(tmp_path, pages=pages, replies=replies)
    doc = document(store)
    assert [r["batch"] for r in doc["tables"]["appearance_results"]] == [None, *BATCHES]
    assert {
        "step": "appearance",
        "target": "appearance_results",
        "row": 1,
        "column": "batch",
        "raw": None,
        "message": "no key found in this row's occurrence of appearance",
    } in doc["issues"]
    assert queue.awaiting


def test_step_progress_events_carry_the_occurrence(tmp_path: Path) -> None:
    _, _, queue = run_covalidation(tmp_path)
    events = [d for _, _, m, d in queue.event_details if m == STEP_PROGRESS]
    assert [e["occurrence"] for e in events if e["step"] == "appearance"] == [
        {"n": i + 1, "of": 3, "key": b} for i, b in enumerate(BATCHES)
    ]
    assert all(e["occurrence"] is None for e in events if e["step"] == "header")


def test_rerun_keeps_segment_issues_once(tmp_path: Path) -> None:
    pages = edited("Microbial Purity", "Microbal Purity", 3)
    provider, deps = covalidation_deps(tmp_path, pages, responses(microbial=2))
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    provider.responses.extend([TABLE_ROWS] * 3)
    calls = len(provider.calls)
    queue.jobs = [replace(JOB, task="rerun", rerun={"step": "appearance"})]
    run_once(queue, deps, "w1")
    assert len(provider.calls) == calls + 3
    doc = json.loads(deps.store.get("outputs", DOC_KEY))
    assert messages(doc).count(f"microbial: no occurrence for batch {BATCHES[2]}") == 1
    assert [r["batch"] for r in doc["tables"]["appearance_results"]] == BATCHES


def test_review_reasons_name_the_key_issues(tmp_path: Path) -> None:
    """Final review 4: the reviewer sees which key issue sent the job to review."""
    pages = edited("Microbial Purity", "Microbal Purity", 3)
    _, store, _ = run_covalidation(tmp_path, pages=pages, replies=responses(microbial=2))
    reasons = document(store)["review_reasons"]
    assert f"section key issue: microbial: no occurrence for batch {BATCHES[2]}" in reasons
