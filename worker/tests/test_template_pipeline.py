"""Running a template end to end with fakes: fields (atoms), a chunked table, normalisation,
issues, page markers and the review flag."""

from __future__ import annotations

import csv
import io
import json
from pathlib import Path

import pytest
import yaml

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps, mark_pages
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore

from .fakes import FakeProvider, FakeQueue

TEMPLATE = {
    "id": "demo",
    "version": 1,
    "name": "Demo document",
    "preamble": "You read demo documents.",
    "document": {
        "sections": [{"id": "head", "anchor": r"\A"}, {"id": "body", "anchor": "^BODY"}],
    },
    "outputs": {
        "fields": [
            {"id": "product", "type": "text", "description": "Medicinal product name"},
            {"id": "executed_on", "type": "date"},
            {"id": "kind", "type": "enum", "enum": ["protocol", "report"]},
        ],
        "tables": [
            {
                "id": "results",
                "columns": [
                    {"id": "batch", "type": "text"},
                    {"id": "value", "type": "decimal"},
                    {"id": "aliases", "type": "list"},
                ],
            }
        ],
    },
    "pipeline": [
        {"type": "extract", "id": "header", "fields": ["product", "kind"], "sections": ["head"]},
        {
            "type": "extract",
            "id": "date",
            "fields": ["executed_on"],
            "sections": ["head"],
            "instructions": "The execution date is the date the first batch was made.",
        },
        {
            "type": "extract",
            "id": "data",
            "table": "results",
            "sections": ["body"],
            "chunkPages": 1,
        },
        {
            "type": "check",
            "id": "batch_check",
            "values": "results.batch",
            "reference": "results.batch",
        },
    ],
}

PAGES = ["Product: Richfer capsules\nMade 16/02/2023", "BODY\nG1 137·8", "G2 Complies"]

RESPONSES = [
    {
        "product": {
            "value": "Richfer capsules",
            "evidence": "Product: Richfer capsules",
            "page": 1,
        },
        "kind": {"value": "protocol", "evidence": None, "page": None},
    },
    {"executed_on": {"value": "16/02/2023", "evidence": "Made 16/02/2023", "page": 1}},
    {"rows": [{"batch": "G1", "value": "137·8", "aliases": []}]},
    {"rows": [{"batch": "G2", "value": "Complies", "aliases": ["G-2"]}]},
]

JOB = ClaimedJob("job-1", "doc-1", "demo", 1, "inbox", "demo/v1/doc-1.pdf", None, 1, 3)


@pytest.fixture
def run(tmp_path: Path):  # type: ignore[no-untyped-def]
    directory = tmp_path / "demo" / "v1"
    directory.mkdir(parents=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(TEMPLATE), encoding="utf-8")
    provider = FakeProvider("local", responses=list(RESPONSES))
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
        extract_text=lambda _pdf: PAGES,
        buckets=Buckets("inbox", "outputs", "runs"),
    )
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    return provider, store, queue


def read_csv(store: MemoryObjectStore, key: str) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(store.get("outputs", key).decode())))


def test_job_completes_with_one_call_per_step_and_chunk(run) -> None:  # type: ignore[no-untyped-def]
    provider, _, queue = run
    assert queue.completed, queue.reviewed or queue.failed
    assert len(provider.calls) == 4


def test_fields_are_normalised_into_one_wide_row(run) -> None:  # type: ignore[no-untyped-def]
    _, store, _ = run
    assert read_csv(store, "demo/v1/fields/doc-1.csv") == [
        {
            "document_id": "doc-1",
            "product": "Richfer capsules",
            "executed_on": "2023-02-16",
            "kind": "protocol",
        }
    ]


def test_table_rows_are_merged_across_chunks_and_normalised(run) -> None:  # type: ignore[no-untyped-def]
    _, store, _ = run
    rows = read_csv(store, "demo/v1/results/doc-1.csv")
    assert [(r["batch"], r["value"], r["aliases"]) for r in rows] == [
        ("G1", "137.8", "[]"),
        ("G2", "Complies", '["G-2"]'),
    ]


def test_unparseable_values_are_kept_and_listed_as_issues(run) -> None:  # type: ignore[no-untyped-def]
    _, store, queue = run
    [issue] = read_csv(store, "demo/v1/issues/doc-1.csv")
    assert (issue["step"], issue["target"], issue["row"], issue["column"], issue["raw"]) == (
        "data",
        "results",
        "2",
        "value",
        "Complies",
    )
    assert any(msg == "review required" for _, _, msg in queue.events)


def test_document_json_carries_evidence_checks_and_review_flag(run) -> None:  # type: ignore[no-untyped-def]
    _, store, _ = run
    doc = json.loads(store.get("outputs", "demo/v1/document/doc-1.json"))
    assert doc["fields"]["product"] == {
        "value": "Richfer capsules",
        "evidence": "Product: Richfer capsules",
        "page": 1,
    }
    assert doc["fields"]["kind"]["value"] == "protocol"
    assert len(doc["tables"]["results"]) == 2
    assert doc["checks"]["batch_check"]["rows"]
    assert doc["review_required"] is True and doc["review_reasons"] == ["1 normalisation issue(s)"]
    assert doc["template"] == {"id": "demo", "version": 1, "name": "Demo document"}


def test_prompts_carry_page_markers_definitions_and_instructions(run) -> None:  # type: ignore[no-untyped-def]
    provider, _, _ = run
    header, date, chunk1, chunk2 = (req.prompt for _, req in provider.calls)
    assert "You read demo documents." in header
    assert "[page 1]" in header and "Medicinal product name" in header
    assert "The execution date is the date the first batch was made." in date
    assert "[page 2]" in chunk1 and "[page 3]" not in chunk1
    assert "page 2 of 2" in chunk2


def test_mark_pages_uses_original_page_numbers() -> None:
    assert mark_pages(["a", "b"], first_page=32) == ["[page 32]\na", "[page 33]\nb"]
