"""Review workflow: documents needing review wait (awaiting_review); approval publishes the
draft with the reviewer's edits applied (re-normalised, checks re-run) to the final target."""

from __future__ import annotations

import csv
import io
import json
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
import yaml

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps, Target
from ingest_worker.review import apply_edits
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore
from ingest_worker.template import Template

from .fakes import FakeProvider, FakeQueue
from .test_template_pipeline import JOB, PAGES, RESPONSES, TEMPLATE


def make_deps(tmp_path: Path, template: dict[str, Any]) -> tuple[PipelineDeps, MemoryObjectStore]:
    directory = tmp_path / "demo" / "v1"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(template), encoding="utf-8")
    store, target = MemoryObjectStore(), MemoryObjectStore()
    store.put("inbox", JOB.object_key, b"%PDF", "application/pdf")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=ModelRegistry(
            {"local": FakeProvider("local", responses=list(RESPONSES))},
            {"local": ProviderConfig(name="local", kind="openai-chat")},
            {"default": "local/qwen"},
        ),
        extract_text=lambda _pdf: PAGES,
        buckets=Buckets("inbox", "outputs", "runs"),
        target=Target(store=target, bucket="published", prefix="pvp/"),
    )
    return deps, target


def target_csv(target: MemoryObjectStore, key: str) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(target.get("published", key).decode("utf-8-sig"))))


# --- applying edits to a draft document ------------------------------------------------------

DRAFT = {
    "fields": {
        "product": {"value": "Richfer", "evidence": "Product: Richfer", "page": 1},
        "executed_on": {"value": "2023-02-16", "evidence": "Made 16/02/2023", "page": 1},
        "kind": {"value": "protocol", "evidence": None, "page": None},
    },
    "tables": {
        "results": [
            {"batch": "G1", "value": 137.8, "aliases": []},
            {"batch": "GX", "value": "Complies", "aliases": []},
        ]
    },
    "checks": {},
    "issues": [
        {
            "step": "data",
            "target": "results",
            "row": 2,
            "column": "value",
            "raw": "Complies",
            "message": "'Complies' is not a valid decimal",
        }
    ],
}

EDITS = [
    {
        "field": "executed_on",
        "table": None,
        "row": None,
        "column": None,
        "value": "17/02/2023",
        "editor": "kh",
        "reason": "date misread",
        "at": "2026-10-09T10:00:00Z",
    },
    {
        "field": None,
        "table": "results",
        "row": 2,
        "column": "value",
        "value": "98·5",
        "editor": "kh",
        "reason": None,
        "at": "2026-10-09T10:01:00Z",
    },
    {
        "field": None,
        "table": "results",
        "row": 2,
        "column": "batch",
        "value": "G1",
        "editor": "kh",
        "reason": "batch misread",
        "at": "2026-10-09T10:02:00Z",
    },
]


@pytest.fixture
def template() -> Template:
    return Template.model_validate(TEMPLATE)


def test_edits_are_normalised_and_keep_evidence(template: Template) -> None:
    doc = apply_edits(template, DRAFT, EDITS)
    assert doc["fields"]["executed_on"] == {
        "value": "2023-02-17",
        "evidence": "Made 16/02/2023",
        "page": 1,
        "edited": True,
    }
    assert doc["tables"]["results"][1]["value"] == 98.5
    assert "edited" not in doc["fields"]["product"]


def test_edited_cells_drop_their_issues_and_checks_are_rerun(template: Template) -> None:
    doc = apply_edits(template, DRAFT, EDITS)
    assert doc["issues"] == []
    rows = {r["value"]: r for r in doc["checks"]["batch_check"]["rows"]}
    assert rows["G1"]["count"] == 2 and "GX" not in rows


def test_invalid_edit_values_are_kept_and_reported(template: Template) -> None:
    doc = apply_edits(template, DRAFT, [{**EDITS[0], "value": "soon"}])
    assert doc["fields"]["executed_on"]["value"] == "soon"
    assert any(i["step"] == "review" and i["target"] == "executed_on" for i in doc["issues"])


def test_later_edits_to_the_same_value_win(template: Template) -> None:
    doc = apply_edits(template, DRAFT, [EDITS[0], {**EDITS[0], "value": "18/02/2023"}])
    assert doc["fields"]["executed_on"]["value"] == "2023-02-18"


def test_edits_to_unknown_targets_are_rejected(template: Template) -> None:
    with pytest.raises(ValueError, match="unknown"):
        apply_edits(template, DRAFT, [{**EDITS[0], "field": "nope"}])
    with pytest.raises(ValueError, match="row 9"):
        apply_edits(template, DRAFT, [{**EDITS[1], "row": 9}])


# --- the job lifecycle ----------------------------------------------------------------------


def test_documents_needing_review_wait_and_are_not_published(tmp_path: Path) -> None:
    deps, target = make_deps(tmp_path, TEMPLATE)  # 'Complies' is an issue -> review
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    [(job_id, outputs, reasons)] = queue.awaiting
    assert job_id == "job-1" and reasons == ["1 normalisation issue(s)"]
    assert {o.output_id for o in outputs} >= {"fields", "document", "issues"}
    assert not queue.completed and not queue.published and not target.objects


def test_documents_without_review_are_published_straight_away(tmp_path: Path) -> None:
    deps, target = make_deps(tmp_path, {**TEMPLATE, "review": {"required": "never"}})
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    assert queue.completed and not queue.awaiting
    [(_, published, bucket)] = queue.published
    assert bucket == "published"
    assert published[0].key.startswith("pvp/demo/v1/")
    assert target_csv(target, "pvp/demo/v1/fields/doc-1.csv")[0]["product"] == "Richfer capsules"


def test_approval_publishes_the_draft_with_edits_applied(tmp_path: Path) -> None:
    deps, target = make_deps(tmp_path, TEMPLATE)
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")  # -> awaiting review; draft written to the outputs bucket
    drafts_before = dict(deps.store.objects)

    queue.jobs = [replace(JOB, task="publish")]
    queue.edits["job-1"] = [
        {
            "field": "executed_on",
            "table": None,
            "row": None,
            "column": None,
            "value": "17/02/2023",
            "editor": "kh",
            "reason": "misread",
            "at": "2026-10-09T10:00:00Z",
        },
        {
            "field": None,
            "table": "results",
            "row": 2,
            "column": "value",
            "value": "98.5",
            "editor": "kh",
            "reason": None,
            "at": "2026-10-09T10:01:00Z",
        },
    ]
    queue.decisions["job-1"] = {
        "reviewer": "kh",
        "note": "checked against scan",
        "reviewed_at": "2026-10-09T10:05:00Z",
    }
    run_once(queue, deps, "w1")

    assert queue.completed and queue.published
    fields = target_csv(target, "pvp/demo/v1/fields/doc-1.csv")[0]
    assert fields["executed_on"] == "2023-02-17"
    assert [r["value"] for r in target_csv(target, "pvp/demo/v1/results/doc-1.csv")] == [
        "137.8",
        "98.5",
    ]
    assert target_csv(target, "pvp/demo/v1/issues/doc-1.csv") == []
    published = json.loads(target.get("published", "pvp/demo/v1/document/doc-1.json"))
    assert published["review"]["decision"] == "approved"
    assert published["review"]["reviewer"] == "kh" and len(published["review"]["edits"]) == 2
    reviewed = json.loads(deps.store.get("runs", "job-1/reviewed-document.json"))
    assert reviewed["review"]["decision"] == "approved"  # kept for references/regression
    assert reviewed["fields"]["executed_on"]["value"] == "2023-02-17"
    drafts_after = {k: v for k, v in deps.store.objects.items() if k[0] != "runs"}
    assert drafts_after == {k: v for k, v in drafts_before.items() if k[0] != "runs"}
    # the LLM is not called again on publish
    assert len(deps.models.resolve("default")[0].calls) == 4  # type: ignore[attr-defined]
