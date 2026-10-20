"""Output constraints (docs/design/output-roles.md §1): a value outside its field's or column's
range, pattern or length is kept as captured and raised as a normalisation issue, both from a
step's reply and from a reviewer's edit."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import yaml

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.review import apply_edits
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore
from ingest_worker.template import Template

from .fakes import FakeProvider, FakeQueue
from .test_template_pipeline import JOB

RECIPE: dict[str, Any] = {
    "id": "demo",
    "version": 1,
    "name": "Demo",
    "document": {"sections": [{"id": "head", "anchor": r"\A"}]},
    "outputs": {
        "fields": [{"id": "assay", "type": "decimal", "range": {"min": 90, "max": 110}}],
        "tables": [
            {
                "id": "lines",
                "columns": [{"id": "batch", "type": "text", "pattern": r"^[A-Z]{2}\d{4}$"}],
            }
        ],
    },
    "pipeline": [
        {"type": "extract", "id": "head", "fields": ["assay"], "sections": ["head"]},
        {"type": "extract", "id": "rows", "table": "lines", "sections": ["head"]},
    ],
}

ASSAY = {"assay": {"value": "87.5", "evidence": "Assay 87.5%", "page": 1}}
ROWS = {"rows": [{"batch": "AB1234"}, {"batch": "ab12"}]}


def run(tmp_path: Path, responses: list[Any]) -> FakeQueue:
    directory = tmp_path / "demo" / "v1"
    directory.mkdir(parents=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(RECIPE), encoding="utf-8")
    store = MemoryObjectStore()
    store.put("inbox", JOB.object_key, b"%PDF", "application/pdf")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=ModelRegistry(
            {"local": FakeProvider("local", responses=responses)},
            {"local": ProviderConfig(name="local", kind="openai-chat", location="local")},
            {"default": "local/qwen"},
        ),
        extract_text=lambda _pdf: ["Assay 87.5%. Batches AB1234, ab12.\n"],
        buckets=Buckets("inbox", "outputs", "runs"),
    )
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    return queue


def test_values_outside_their_constraints_are_review_issues(tmp_path: Path) -> None:
    queue = run(tmp_path, [ASSAY, ROWS])
    [(_, outputs, reasons)] = queue.awaiting
    document = json.loads(next(o.body for o in outputs if o.output_id == "document"))
    assert document["fields"]["assay"]["value"] == 87.5  # kept as captured
    assert [(i["step"], i["target"], i["row"], i["message"]) for i in document["issues"]] == [
        ("head", "assay", None, "87.5 is below 90"),
        ("rows", "lines", 2, r"'ab12' does not match ^[A-Z]{2}\d{4}$"),
    ]
    assert "2 normalisation issue(s)" in reasons


def test_the_model_is_never_told_the_limits(tmp_path: Path) -> None:
    provider_calls = []

    class Spy(FakeProvider):
        def complete_json(self, model: str, request: Any, on_tokens: Any = None) -> Any:
            provider_calls.append(request)
            return super().complete_json(model, request, on_tokens)

    directory = tmp_path / "demo" / "v1"
    directory.mkdir(parents=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(RECIPE), encoding="utf-8")
    store = MemoryObjectStore()
    store.put("inbox", JOB.object_key, b"%PDF", "application/pdf")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=ModelRegistry(
            {"local": Spy("local", responses=[ASSAY, ROWS])},
            {"local": ProviderConfig(name="local", kind="openai-chat", location="local")},
            {"default": "local/qwen"},
        ),
        extract_text=lambda _pdf: ["Assay 87.5%.\n"],
        buckets=Buckets("inbox", "outputs", "runs"),
    )
    run_once(FakeQueue(jobs=[JOB]), deps, "w1")
    schemas = json.dumps([r.json_schema for r in provider_calls])
    assert "minimum" not in schemas and "pattern" not in schemas


def _reviewed(edits: list[dict[str, Any]]) -> dict[str, Any]:
    template = Template.model_validate(RECIPE)
    draft = {
        "fields": {"assay": {"value": 87.5, "evidence": None, "page": 1}},
        "tables": {"lines": [{"batch": "AB1234"}]},
        "checks": {},
        "issues": [
            {
                "step": "head",
                "target": "assay",
                "row": None,
                "column": None,
                "raw": "87.5",
                "message": "87.5 is below 90",
            }
        ],
    }
    return apply_edits(template, draft, edits)


def test_a_reviewer_edit_into_range_drops_the_constraint_issue() -> None:
    doc = _reviewed([{"field": "assay", "value": "95"}])
    assert doc["fields"]["assay"]["value"] == 95.0 and doc["issues"] == []


def test_a_reviewer_edit_outside_the_constraints_is_an_issue() -> None:
    doc = _reviewed([{"table": "lines", "row": 1, "column": "batch", "value": "zz"}])
    [_, issue] = doc["issues"]
    assert (issue["step"], issue["row"], issue["column"]) == ("review", 1, "batch")
    assert issue["message"] == r"'zz' does not match ^[A-Z]{2}\d{4}$"
