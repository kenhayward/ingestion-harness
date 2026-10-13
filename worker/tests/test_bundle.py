"""Workbench drafting bundle: the export task (phase 6)."""

from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path
from typing import Any

import pytest
import yaml

from ingest_worker.bundle import build_bundle, run_export
from ingest_worker.drafting import MAX_CONTEXT_SAMPLES, STAGES, DraftSample, build_context
from ingest_worker.llm.registry import ModelRegistry
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, DocumentError, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore, export_key, prepared_text_key

from .fakes import FakeQueue

PDF = b"%PDF-1.7\n% sample\n%%EOF\n"
SHA = hashlib.sha256(PDF).hexdigest()
BRIEF = {"purpose": "Letters to extract"}
# SurveyBodySchema (packages/shared/src/workbench.ts) / drafting.SURVEY_SCHEMA.
SURVEY = {
    "summary": "Letters",
    "structure": [{"name": "Header", "description": "Sender", "howToFind": "Top"}],
    "variants": [],
    "candidates": [],
    "questions": [],
}
DRAFT = {"id": "letter", "version": 2, "name": "Letter", "outputs": {"fields": [], "tables": []}}


def export_job(**params: Any) -> ClaimedJob:
    base: dict[str, Any] = {
        "stage": "export",
        "dataPolicy": "local",
        "briefVersion": 3,
        "brief": BRIEF,
        "draft": DRAFT,
        "projectName": "Letter",
        "samples": [
            {
                "sampleId": "s1",
                "filename": "a.pdf",
                "sha256": SHA,
                "role": "dev",
                "bucket": "inbox",
                "objectKey": "letter/a.pdf",
            }
        ],
    }
    return ClaimedJob(
        id="job-x",
        document_id="",
        spec_id="letter",
        spec_version=0,
        bucket="",
        object_key="",
        model_override=None,
        attempts=1,
        max_attempts=3,
        task="export",
        test=True,
        project_id="letter",
        params={**base, **params},
    )


def make(specs_dir: Path) -> tuple[MemoryObjectStore, PipelineDeps]:
    store = MemoryObjectStore()
    text = {"sha256": SHA, "pages": [{"number": 1, "text": "Dear Sir", "ocr": False}]}
    store.put("runs", prepared_text_key(SHA), json.dumps(text).encode(), "application/json")
    store.put("inbox", "letter/a.pdf", PDF, "application/pdf")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(specs_dir),
        models=ModelRegistry({}, {}, {}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        example_template="id: example\n",
    )
    return store, deps


def read_zip(data: bytes) -> dict[str, bytes]:
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        return {name: z.read(name) for name in z.namelist()}


def test_export_writes_the_bundle_with_the_drafters_exact_context(
    fixture_specs_dir: Path,
) -> None:
    store, deps = make(fixture_specs_dir)
    manifest = run_export(export_job(), deps, FakeQueue())
    files = read_zip(store.get("runs", export_key("letter", "job-x")))
    expected_context = build_context(
        brief=BRIEF,
        draft=DRAFT,
        samples=[DraftSample("s1", "a.pdf", "dev", ["Dear Sir"])],
        example_yaml="id: example\n",
    )
    assert files["context.md"].decode() == expected_context
    assert files[f"samples/{SHA}.pdf"] == PDF
    assert json.loads(files["brief.json"]) == BRIEF
    assert yaml.safe_load(files["template.yaml"]) == DRAFT
    for stage in STAGES.values():
        assert files[f"stages/{stage.id}.md"].decode() == stage.instructions
        assert json.loads(files[f"stages/{stage.id}.schema.json"]) == stage.schema
    # Same manifest as packages/shared/test/bundle.test.ts parses (keep in step).
    assert (
        json.loads(files["manifest.json"])
        == manifest
        == {
            "format": "ih-workbench-bundle",
            "formatVersion": 1,
            "project": {"id": "letter", "name": "Letter"},
            "templateVersion": 2,
            "briefVersion": 3,
            "samples": [
                {
                    "sampleId": "s1",
                    "filename": "a.pdf",
                    "sha256": SHA,
                    "file": f"samples/{SHA}.pdf",
                    "inContext": True,
                }
            ],
            "stages": list(STAGES),
            "completedStages": [],
        }
    )
    assert "README.md" in files
    assert "survey.json" not in files


def test_export_carries_the_survey_and_completed_stages(fixture_specs_dir: Path) -> None:
    store, deps = make(fixture_specs_dir)
    job = export_job(survey=SURVEY, completedStages=["survey", "outputs"])
    manifest = run_export(job, deps, FakeQueue())
    files = read_zip(store.get("runs", export_key("letter", "job-x")))
    assert json.loads(files["survey.json"]) == SURVEY
    assert manifest["completedStages"] == ["survey", "outputs"]
    assert json.loads(files["manifest.json"])["completedStages"] == ["survey", "outputs"]


def test_export_without_a_survey_has_no_survey_entry(fixture_specs_dir: Path) -> None:
    store, deps = make(fixture_specs_dir)
    manifest = run_export(export_job(), deps, FakeQueue())
    files = read_zip(store.get("runs", export_key("letter", "job-x")))
    assert "survey.json" not in files
    assert manifest["completedStages"] == []


def test_export_refuses_holdout_samples(fixture_specs_dir: Path) -> None:
    _, deps = make(fixture_specs_dir)
    job = export_job(
        samples=[
            {
                "sampleId": "h",
                "filename": "h.pdf",
                "sha256": SHA,
                "role": "holdout",
                "bucket": "inbox",
                "objectKey": "letter/a.pdf",
            }
        ]
    )
    with pytest.raises(DocumentError, match="holdout"):
        run_export(job, deps, FakeQueue())


def test_export_refuses_a_pdf_that_does_not_match_its_sha(fixture_specs_dir: Path) -> None:
    store, deps = make(fixture_specs_dir)
    store.put("inbox", "letter/a.pdf", b"%PDF-other", "application/pdf")
    with pytest.raises(DocumentError, match=r"a\.pdf"):
        run_export(export_job(), deps, FakeQueue())


@pytest.mark.parametrize("stage", ["revise", "references", "Survey", ""])
def test_export_refuses_a_completed_stage_outside_stage_order(
    fixture_specs_dir: Path, stage: str
) -> None:
    # STAGE_ORDER (packages/shared/src/drafting.ts): the import's BundleManifestSchema refuses
    # anything else, so the export must not write it.
    _, deps = make(fixture_specs_dir)
    with pytest.raises(DocumentError, match="invalid export parameters"):
        run_export(export_job(completedStages=["survey", stage]), deps, FakeQueue())


def test_export_refuses_an_empty_project_name(fixture_specs_dir: Path) -> None:
    _, deps = make(fixture_specs_dir)
    with pytest.raises(DocumentError, match="invalid export parameters"):
        run_export(export_job(projectName=""), deps, FakeQueue())


def test_readme_says_what_the_stages_read_and_what_revise_misses() -> None:
    files = read_zip(build_bundle(manifest={}, context="", brief={}, draft=None, pdfs={}))
    readme = files["README.md"].decode()
    assert "survey, outputs, sections and steps" in readme
    assert "revise" in readme and "feedback" in readme and "evaluation failures" in readme


def test_only_the_first_samples_are_in_context(fixture_specs_dir: Path) -> None:
    store, deps = make(fixture_specs_dir)
    samples = []
    for i in range(MAX_CONTEXT_SAMPLES + 1):
        pdf = PDF + str(i).encode()
        sha = hashlib.sha256(pdf).hexdigest()
        store.put("inbox", f"letter/{i}.pdf", pdf, "application/pdf")
        text = {"sha256": sha, "pages": [{"number": 1, "text": f"text {i}", "ocr": False}]}
        store.put("runs", prepared_text_key(sha), json.dumps(text).encode(), "application/json")
        samples.append(
            {
                "sampleId": f"s{i}",
                "filename": f"{i}.pdf",
                "sha256": sha,
                "role": "dev",
                "bucket": "inbox",
                "objectKey": f"letter/{i}.pdf",
            }
        )
    manifest = run_export(export_job(samples=samples), deps, FakeQueue())
    assert [s["inContext"] for s in manifest["samples"]] == [True] * MAX_CONTEXT_SAMPLES + [False]
    files = read_zip(store.get("runs", export_key("letter", "job-x")))
    assert len([n for n in files if n.startswith("samples/")]) == MAX_CONTEXT_SAMPLES + 1


def test_bundle_bytes_are_deterministic() -> None:
    args: dict[str, Any] = dict(
        manifest={"format": "ih-workbench-bundle"},
        context="c",
        brief=BRIEF,
        draft=DRAFT,
        pdfs={SHA: PDF},
    )
    assert build_bundle(**args) == build_bundle(**args)


def test_an_export_cancelled_during_the_write_removes_its_zip(fixture_specs_dir: Path) -> None:
    store, deps = make(fixture_specs_dir)
    calls: list[int] = []

    def cancel_after_first_check() -> bool:
        calls.append(1)
        return len(calls) > 1

    queue = FakeQueue(jobs=[export_job()], cancel_when=cancel_after_first_check)
    run_once(queue, deps, "w1")
    assert len(calls) == 2
    assert store.get_optional("runs", export_key("letter", "job-x")) is None
    assert queue.completed == []


def test_run_once_completes_an_export_job(fixture_specs_dir: Path) -> None:
    store, deps = make(fixture_specs_dir)
    queue = FakeQueue(jobs=[export_job()])
    run_once(queue, deps, "w1")
    assert [job_id for job_id, _ in queue.completed] == ["job-x"]
    assert store.get_optional("runs", export_key("letter", "job-x")) is not None


def test_run_once_sends_a_refused_export_to_review(fixture_specs_dir: Path) -> None:
    _, deps = make(fixture_specs_dir)
    queue = FakeQueue(jobs=[export_job(stage="survey")])
    run_once(queue, deps, "w1")
    [(job_id, reason)] = queue.reviewed
    assert job_id == "job-x" and "stage" in reason
    assert queue.completed == []
