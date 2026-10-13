"""Workbench prepare task: text + OCR only, written to the runs bucket by PDF sha256."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

import pytest
from pypdf.errors import EmptyFileError, FileNotDecryptedError, PdfReadError, WrongPasswordError

from ingest_worker.convert import DOCX_MIME, ConversionRejected
from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.ocr import OcrSettings
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore, prepared_text_key, prepared_triage_key
from ingest_worker.workbench import PREPARE_FAILED, PREPARE_PROGRESS

from .fakes import FakeConverter, FakeProvider, FakeQueue
from .test_convert import DOCX

PDF = b"%PDF-workbench-sample"
SHA = hashlib.sha256(PDF).hexdigest()
TEXT_PAGE = "PROCESS VALIDATION PROTOCOL\nProduct: Folic acid tablets 5 mg\n"
OLMOCR_OK = "---\nprimary_language: en\nis_rotation_valid: true\nrotation_correction: 0\n---\n"


def prepare_job(**overrides: object) -> ClaimedJob:
    base = dict(
        id="job-p",
        document_id="doc-s",
        spec_id="letter",
        spec_version=1,
        bucket="inbox",
        object_key="letter/v1/doc-s.pdf",
        model_override=None,
        attempts=1,
        max_attempts=3,
        task="prepare",
        test=True,
    )
    return ClaimedJob(**{**base, **overrides})  # type: ignore[arg-type]


def make_deps(specs_dir: Path, pages: list[str], ocr: FakeProvider | None = None) -> PipelineDeps:
    store = MemoryObjectStore()
    store.put("inbox", "letter/v1/doc-s.pdf", PDF, "application/pdf")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(specs_dir),
        models=ModelRegistry(
            {"local": ocr} if ocr else {},
            {"local": ProviderConfig(name="local", kind="openai-chat")} if ocr else {},
            {},
        ),
        extract_text=lambda _pdf: pages,
        buckets=Buckets("inbox", "outputs", "runs"),
    )
    if ocr:
        deps.ocr = OcrSettings(model="local/olmocr-2-7b-1025")
        deps.render_page = lambda pdf, index, dim, rotation: b"\x89PNG" + bytes([index])
    return deps


def stored(deps: PipelineDeps, key: str) -> dict[str, Any]:
    data: dict[str, Any] = json.loads(deps.store.get("runs", key))
    return data


def test_text_layer_pdf_is_prepared_without_ocr(fixture_specs_dir: Path) -> None:
    deps = make_deps(fixture_specs_dir, [TEXT_PAGE, TEXT_PAGE + "page two"])
    queue = FakeQueue(jobs=[prepare_job()])

    assert run_once(queue, deps, "w1") is True

    assert queue.completed == [("job-p", [])]  # no extraction, no outputs
    assert stored(deps, prepared_text_key(SHA)) == {
        "sha256": SHA,
        "pages": [
            {"number": 1, "text": TEXT_PAGE, "ocr": False},
            {"number": 2, "text": TEXT_PAGE + "page two", "ocr": False},
        ],
    }
    assert stored(deps, prepared_triage_key(SHA)) == {
        "sha256": SHA,
        "pageCount": 2,
        "ocrPages": [],
        "chars": len(TEXT_PAGE) * 2 + len("page two"),
        "ocrModel": None,
    }
    assert ("job-p", "info", "prepared") in queue.events


def test_low_text_pages_are_ocrd_and_flagged(fixture_specs_dir: Path) -> None:
    ocr = FakeProvider("local")
    ocr.vision_responses = [OLMOCR_OK + "Scanned batch record"]
    deps = make_deps(fixture_specs_dir, [TEXT_PAGE, ""], ocr)
    queue = FakeQueue(jobs=[prepare_job()])

    run_once(queue, deps, "w1")

    assert queue.completed, queue.reviewed or queue.failed
    pages = stored(deps, prepared_text_key(SHA))["pages"]
    assert pages[0]["ocr"] is False
    assert pages[1]["ocr"] is True and "Scanned batch record" in pages[1]["text"]
    triage = stored(deps, prepared_triage_key(SHA))
    assert triage["ocrPages"] == [2]
    assert triage["ocrModel"] == "local/olmocr-2-7b-1025"


def test_image_only_pdf_without_ocr_needs_review_and_writes_nothing(
    fixture_specs_dir: Path,
) -> None:
    deps = make_deps(fixture_specs_dir, ["", "  "])
    queue = FakeQueue(jobs=[prepare_job()])

    run_once(queue, deps, "w1")

    [(_, reason)] = queue.reviewed
    assert "OCR" in reason
    assert deps.store.get_optional("runs", prepared_text_key(SHA)) is None
    assert events_named(queue, PREPARE_FAILED) == [{"code": "other", "message": reason}]


def test_a_word_sample_is_prepared_from_its_pdf_under_its_own_sha(fixture_specs_dir: Path) -> None:
    deps = make_deps(fixture_specs_dir, [TEXT_PAGE])
    deps.store.put("inbox", "letter/v1/doc-s.pdf", DOCX, DOCX_MIME)
    deps.converter = FakeConverter()
    seen: list[bytes] = []
    deps.extract_text = lambda pdf: seen.append(pdf) or [TEXT_PAGE]

    run_once(FakeQueue(jobs=[prepare_job()]), deps, "w1")

    sha = hashlib.sha256(DOCX).hexdigest()  # the uploaded file, which the API records
    assert seen == [b"%PDF-converted"]
    assert stored(deps, prepared_text_key(sha))["sha256"] == sha
    assert stored(deps, prepared_triage_key(sha))["pageCount"] == 1


def events_named(queue: FakeQueue, message: str) -> list[dict[str, Any]]:
    return [data for _, _, name, data in queue.event_details if name == message]


def test_prepare_reports_the_text_layer_then_each_ocr_page(fixture_specs_dir: Path) -> None:
    ocr = FakeProvider("local")
    ocr.vision_responses = [OLMOCR_OK + "Scanned one", OLMOCR_OK + "Scanned two"]
    deps = make_deps(fixture_specs_dir, [TEXT_PAGE, "", ""], ocr)
    queue = FakeQueue(jobs=[prepare_job()])

    run_once(queue, deps, "w1")

    assert queue.completed
    assert events_named(queue, PREPARE_PROGRESS) == [
        {"stage": "text", "page": 3, "of": 3},
        {"stage": "ocr", "page": 1, "of": 2},
        {"stage": "ocr", "page": 2, "of": 2},
    ]
    assert events_named(queue, PREPARE_FAILED) == []


def test_prepare_without_ocr_reports_the_text_layer_only(fixture_specs_dir: Path) -> None:
    deps = make_deps(fixture_specs_dir, [TEXT_PAGE, TEXT_PAGE])
    queue = FakeQueue(jobs=[prepare_job()])

    run_once(queue, deps, "w1")

    assert events_named(queue, PREPARE_PROGRESS) == [{"stage": "text", "page": 2, "of": 2}]


@pytest.mark.parametrize(
    ("error", "code", "message"),
    [
        (
            FileNotDecryptedError("File has not been decrypted"),
            "password",
            "PDF is password-protected",
        ),
        (WrongPasswordError("Wrong password"), "password", "PDF is password-protected"),
        (
            PdfReadError("EOF marker not found"),
            "corrupt",
            "PDF could not be read: EOF marker not found",
        ),
        (
            EmptyFileError("Cannot read an empty file"),
            "corrupt",
            "PDF could not be read: Cannot read an empty file",
        ),
    ],
)
def test_an_unreadable_pdf_goes_to_review_with_its_reason(
    fixture_specs_dir: Path, error: Exception, code: str, message: str
) -> None:
    deps = make_deps(fixture_specs_dir, [])

    def unreadable(_pdf: bytes) -> list[str]:
        raise error

    deps.extract_text = unreadable
    queue = FakeQueue(jobs=[prepare_job()])

    run_once(queue, deps, "w1")

    assert queue.reviewed == [("job-p", message)]
    assert queue.failed == []  # not retried: the file will not read better next time
    assert events_named(queue, PREPARE_FAILED) == [{"code": code, "message": message}]
    assert deps.store.get_optional("runs", prepared_text_key(SHA)) is None


@pytest.mark.parametrize(
    ("rejection", "code"),
    [("413: Request Entity Too Large", "too_large"), ("400: not a Word file", "corrupt")],
)
def test_a_word_sample_the_converter_rejects_says_why(
    fixture_specs_dir: Path, rejection: str, code: str
) -> None:
    deps = make_deps(fixture_specs_dir, [TEXT_PAGE])
    deps.store.put("inbox", "letter/v1/doc-s.pdf", DOCX, DOCX_MIME)
    deps.converter = FakeConverter(error=ConversionRejected(rejection))
    queue = FakeQueue(jobs=[prepare_job()])

    run_once(queue, deps, "w1")

    [(_, reason)] = queue.reviewed
    assert events_named(queue, PREPARE_FAILED) == [{"code": code, "message": reason}]
