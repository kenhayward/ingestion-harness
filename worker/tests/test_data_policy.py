"""Data policy (ADR 0007): project jobs never reach an external provider unless allowed."""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.ocr import OcrSettings
from ingest_worker.pipeline import Buckets, PipelineDeps, job_data_policy
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore

from .fakes import FakeProvider, FakeQueue
from .test_pipeline import PAGES


def make_deps(specs_dir: Path, cloud: FakeProvider, local: FakeProvider) -> PipelineDeps:
    store = MemoryObjectStore()
    store.put("inbox", "example-invoice/v1/doc-1.pdf", b"%PDF-fake", "application/pdf")
    return PipelineDeps(
        store=store,
        specs=load_specs(specs_dir),
        models=ModelRegistry(
            {"cloud": cloud, "local": local},  # type: ignore[dict-item]
            {
                "cloud": ProviderConfig(name="cloud", kind="anthropic"),  # no location: external
                "local": ProviderConfig(name="local", kind="openai-chat", location="local"),
            },
            {"default": "cloud/big", "localdefault": "local/small"},
        ),
        extract_text=lambda _pdf: PAGES,
        buckets=Buckets("inbox", "outputs", "runs"),
    )


def project_job(**overrides: Any) -> ClaimedJob:
    base: dict[str, Any] = dict(
        id="job-1",
        document_id="doc-1",
        spec_id="example-invoice",
        spec_version=1,
        bucket="inbox",
        object_key="example-invoice/v1/doc-1.pdf",
        model_override=None,
        attempts=1,
        max_attempts=3,
        test=True,
        project_id="letter",
        params={"dataPolicy": "local"},
    )
    return ClaimedJob(**{**base, **overrides})


@pytest.mark.parametrize(
    ("project_id", "params", "expected"),
    [
        (None, None, None),
        ("p", None, "local"),
        ("p", {}, "local"),
        ("p", {"dataPolicy": "local"}, "local"),
        ("p", {"dataPolicy": "external"}, "external"),
        ("p", {"dataPolicy": "anything else"}, "local"),
    ],
)
def test_job_data_policy(
    project_id: str | None, params: dict[str, Any] | None, expected: str | None
) -> None:
    job = replace(project_job(), project_id=project_id, params=params)
    assert job_data_policy(job) == expected


def test_local_only_test_run_with_an_external_model_is_refused_before_any_call(
    fixture_specs_dir: Path,
) -> None:
    cloud, local = FakeProvider("cloud", kind="anthropic"), FakeProvider("local")
    queue = FakeQueue(jobs=[project_job()])  # spec models resolve via "default" -> cloud
    run_once(queue, make_deps(fixture_specs_dir, cloud, local), "w1")
    [(_, reason)] = queue.reviewed
    assert "data policy" in reason and "external provider cloud" in reason
    assert cloud.calls == [] and local.calls == []


def test_local_only_model_override_to_a_local_model_is_allowed(fixture_specs_dir: Path) -> None:
    cloud, local = FakeProvider("cloud", kind="anthropic"), FakeProvider("local")
    local.responses = [RuntimeError("called")]
    queue = FakeQueue(jobs=[project_job(model_override="localdefault")])
    run_once(queue, make_deps(fixture_specs_dir, cloud, local), "w1")
    assert len(local.calls) == 1 and cloud.calls == [] and not queue.reviewed


def test_external_policy_allows_external_models(fixture_specs_dir: Path) -> None:
    cloud, local = FakeProvider("cloud", kind="anthropic"), FakeProvider("local")
    cloud.responses = [RuntimeError("called")]  # proves the call is attempted
    queue = FakeQueue(jobs=[project_job(params={"dataPolicy": "external"})])
    run_once(queue, make_deps(fixture_specs_dir, cloud, local), "w1")
    assert len(cloud.calls) == 1 and not queue.reviewed


def test_production_jobs_have_no_policy(fixture_specs_dir: Path) -> None:
    cloud, local = FakeProvider("cloud", kind="anthropic"), FakeProvider("local")
    cloud.responses = [RuntimeError("called")]
    queue = FakeQueue(jobs=[project_job(project_id=None, params=None, test=False)])
    run_once(queue, make_deps(fixture_specs_dir, cloud, local), "w1")
    assert len(cloud.calls) == 1 and not queue.reviewed


def test_local_only_ocr_with_an_external_vision_model_is_refused(fixture_specs_dir: Path) -> None:
    cloud, local = FakeProvider("cloud", kind="anthropic"), FakeProvider("local")
    deps = make_deps(fixture_specs_dir, cloud, local)
    deps.extract_text = lambda _pdf: ["", ""]  # image-only: needs OCR
    deps.ocr = OcrSettings(model="cloud/vision")
    queue = FakeQueue(jobs=[project_job(task="prepare")])
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "data policy" in reason
    assert cloud.vision_calls == []


def test_local_only_rerun_with_an_external_model_is_refused(tmp_path: Path) -> None:
    from .test_step_context import JOB, RESPONSES, TEMPLATE, make

    deps, providers = make(tmp_path, RESPONSES)
    queue = FakeQueue(jobs=[JOB], templates={("demo", 1): TEMPLATE})
    run_once(queue, deps, "w1")  # a production run first, so there is a draft to re-run
    deps.models = ModelRegistry(
        providers,  # type: ignore[arg-type]
        {
            "local": ProviderConfig(name="local", kind="openai-chat", location="local"),
            "other": ProviderConfig(name="other", kind="openai-chat"),  # external
        },
        {"default": "local/qwen"},
    )
    rerun = {"step": "data", "model": "other/better"}
    queue.jobs = [
        replace(JOB, task="rerun", rerun=rerun, project_id="demo", params={"dataPolicy": "local"})
    ]
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "data policy" in reason and "external provider other" in reason
    assert providers["other"].calls == []
