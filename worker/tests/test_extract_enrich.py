"""Extract steps that enrich an earlier table (docs/design/recipe-plugins.md, P4): the prompt
lists the rows found so far and asks for one entry per row with only the step's columns; a
reply with another number of rows is fed back like a schema error."""

from __future__ import annotations

import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import yaml

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore

from .fakes import FakeProvider, FakeQueue
from .test_template_pipeline import JOB

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
                    {"id": "expiry", "type": "date", "description": "Use by date"},
                ],
            }
        ]
    },
    "pipeline": [
        {"type": "extract", "id": "rows", "table": "lines", "sections": ["head"]},
        {
            "type": "extract",
            "id": "expiry",
            "table": "lines",
            "columns": ["expiry"],
            "sections": ["head"],
        },
    ],
}

FOUND = {"rows": [{"sku": "A1", "qty": "2"}, {"sku": "B2", "qty": "3"}]}
DATES = {"rows": [{"expiry": "2027-01-31"}, {"expiry": "2027-12-31"}]}


def run(tmp_path: Path, responses: list[Any]) -> tuple[FakeQueue, PipelineDeps, FakeProvider]:
    directory = tmp_path / "demo" / "v1"
    directory.mkdir(parents=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(RECIPE), encoding="utf-8")
    provider = FakeProvider("local", responses=responses)
    store = MemoryObjectStore()
    store.put("inbox", JOB.object_key, b"%PDF", "application/pdf")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=ModelRegistry(
            {"local": provider},
            {"local": ProviderConfig(name="local", kind="openai-chat", location="local")},
            {"default": "local/qwen"},
        ),
        extract_text=lambda _pdf: ["A1 x2, B2 x3. Use by: A1 31/01/2027, B2 31/12/2027\n"],
        buckets=Buckets("inbox", "outputs", "runs"),
    )
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    return queue, deps, provider


def document(queue: FakeQueue) -> dict[str, Any]:
    outputs = queue.awaiting[-1][1]
    return json.loads(next(o.body for o in outputs if o.output_id == "document"))  # type: ignore[no-any-return]


def test_the_prompt_lists_the_rows_and_asks_only_for_the_steps_columns(tmp_path: Path) -> None:
    queue, _, provider = run(tmp_path, [FOUND, DATES])
    assert queue.awaiting, queue.reviewed or queue.failed
    _, request = provider.calls[1]
    assert "for each of the 2 rows an earlier step found" in request.prompt
    assert "1. sku: A1 · qty: 2" in request.prompt and "2. sku: B2 · qty: 3" in request.prompt
    assert "- expiry [date]: Use by date" in request.prompt and "- sku [" not in request.prompt
    row = request.json_schema["properties"]["rows"]["items"]
    assert list(row["properties"]) == ["expiry"] and row["required"] == ["expiry"]


def test_the_creating_step_is_not_asked_for_the_enriched_columns(tmp_path: Path) -> None:
    _, _, provider = run(tmp_path, [FOUND, DATES])
    _, request = provider.calls[0]
    row = request.json_schema["properties"]["rows"]["items"]
    assert list(row["properties"]) == ["sku", "qty"]
    assert "- expiry" not in request.prompt


def test_the_enriched_columns_are_merged_into_the_rows(tmp_path: Path) -> None:
    queue, _, _ = run(tmp_path, [FOUND, DATES])
    assert document(queue)["tables"]["lines"] == [
        {"sku": "A1", "qty": 2, "expiry": "2027-01-31"},
        {"sku": "B2", "qty": 3, "expiry": "2027-12-31"},
    ]
    assert document(queue)["models"]["expiry"] == "local/qwen"


def test_another_number_of_rows_is_fed_back(tmp_path: Path) -> None:
    short = {"rows": [{"expiry": "2027-01-31"}]}
    queue, _, provider = run(tmp_path, [FOUND, short, DATES])
    assert len(provider.calls) == 3
    assert queue.awaiting
    assert [r["expiry"] for r in document(queue)["tables"]["lines"]] == ["2027-01-31", "2027-12-31"]


def test_a_reply_that_never_has_the_rows_goes_to_review(tmp_path: Path) -> None:
    short = {"rows": [{"expiry": "2027-01-31"}]}
    queue, _, _ = run(tmp_path, [FOUND, short, short])
    [(_, reason)] = queue.reviewed
    assert "expiry" in reason and "2 rows" in reason


def test_rerunning_the_creating_step_reruns_an_extract_enricher(tmp_path: Path) -> None:
    queue, deps, provider = run(tmp_path, [FOUND, DATES])
    provider.responses = [
        {"rows": [{"sku": "B2", "qty": "3"}]},
        {"rows": [{"expiry": "2027-12-31"}]},
    ]
    queue.jobs = [replace(JOB, task="rerun", rerun={"step": "rows"})]
    run_once(queue, deps, "w1")
    assert len(provider.calls) == 4
    assert document(queue)["tables"]["lines"] == [{"sku": "B2", "qty": 3, "expiry": "2027-12-31"}]
    assert [(r["step_id"], r["trigger"]) for r in queue.step_runs[-2:]] == [
        ("rows", "rerun"),
        ("expiry", "rerun"),
    ]
