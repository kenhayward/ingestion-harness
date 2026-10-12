"""Templates stored in the database (phase 2): loaded per job, drafts runnable as test jobs."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

import yaml

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps, Target
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore

from .fakes import FakeProvider, FakeQueue
from .test_template_pipeline import JOB, PAGES, RESPONSES, TEMPLATE


def make(tmp_path: Path, file_template: dict[str, Any] | None = None):  # type: ignore[no-untyped-def]
    if file_template:
        directory = tmp_path / "demo" / "v1"
        directory.mkdir(parents=True)
        (directory / "template.yaml").write_text(yaml.safe_dump(file_template), encoding="utf-8")
    provider = FakeProvider("local", responses=list(RESPONSES))
    store, target = MemoryObjectStore(), MemoryObjectStore()
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
        render_preview=lambda pdf, i: b"jpg",
        target=Target(target, "published"),
    )
    return deps, provider, target


def test_templates_are_loaded_from_the_database(tmp_path: Path) -> None:
    deps, provider, _ = make(tmp_path)  # no template files at all
    queue = FakeQueue(jobs=[JOB], templates={("demo", 1): TEMPLATE})
    run_once(queue, deps, "w1")
    assert queue.awaiting, queue.reviewed or queue.failed
    assert len(provider.calls) == 4


def test_the_database_wins_over_a_template_file(tmp_path: Path) -> None:
    deps, _, _ = make(tmp_path, file_template={**TEMPLATE, "name": "File version"})
    queue = FakeQueue(jobs=[JOB], templates={("demo", 1): {**TEMPLATE, "name": "DB version"}})
    run_once(queue, deps, "w1")
    [(_, outputs, _)] = queue.awaiting
    document = next(o for o in outputs if o.output_id == "document")
    assert b'"name": "DB version"' in document.body


def test_invalid_database_templates_go_to_review(tmp_path: Path) -> None:
    deps, _, _ = make(tmp_path)
    broken = {**TEMPLATE, "pipeline": []}
    queue = FakeQueue(jobs=[JOB], templates={("demo", 1): broken})
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "template demo v1 is invalid" in reason


def test_custom_prompt_files_are_rejected_for_database_templates(tmp_path: Path) -> None:
    deps, _, _ = make(tmp_path)
    pipeline = [{**TEMPLATE["pipeline"][0], "prompt": "prompts/x.j2"}, *TEMPLATE["pipeline"][1:]]
    queue = FakeQueue(jobs=[JOB], templates={("demo", 1): {**TEMPLATE, "pipeline": pipeline}})
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "custom prompt files" in reason


def test_test_runs_are_never_published(tmp_path: Path) -> None:
    deps, _, target = make(tmp_path)
    never = {**TEMPLATE, "review": {"required": "never"}}
    queue = FakeQueue(jobs=[replace(JOB, test=True)], templates={("demo", 1): never})
    run_once(queue, deps, "w1")
    assert queue.completed and not queue.published and not target.objects

    # Approving a test run (a workbench reference) finishes review without delivering.
    queue.jobs = [replace(JOB, test=True, task="publish")]
    run_once(queue, deps, "w1")
    assert not queue.reviewed and len(queue.completed) == 2
    assert not queue.published and not target.objects
    assert ("runs", "job-1/reviewed-document.json") in deps.store.objects
