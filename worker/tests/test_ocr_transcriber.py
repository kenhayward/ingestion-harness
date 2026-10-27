"""The OCR loop as a page transcriber, for the PDF reader's scanned pages (spec section 15.1)."""

from __future__ import annotations

import pytest

from ingest_worker.decompose.pdf.transcript import Transcript, TranscriptionFailed
from ingest_worker.llm.base import RefusalError
from ingest_worker.pipeline import JobTranscriber, PipelineDeps, _ocr_cache_keyer
from ingest_worker.storage import ocr_rotation_key, ocr_run_key
from tests.fakes import FakeProvider, FakeQueue
from tests.test_pipeline import OLMOCR_OK, job, setup, with_ocr  # noqa: F401

PDF = b"%PDF-fake"
SHA = "a" * 64
ROTATED = "---\nprimary_language: en\nis_rotation_valid: false\nrotation_correction: 90\n---\n"


def _shared_key(deps: PipelineDeps, page: int) -> str:
    assert deps.ocr is not None
    return _ocr_cache_keyer(SHA, "local/olmocr-2-7b-1025", deps.ocr)(page)


def _transcriber(deps: PipelineDeps, queue: FakeQueue, **kwargs: object) -> JobTranscriber:
    return JobTranscriber(job(), deps, queue, PDF, sha256=SHA, **kwargs)  # type: ignore[arg-type]


def test_transcribes_with_raw_markdown(setup) -> None:  # type: ignore[no-untyped-def]  # noqa: F811
    _, store, deps = setup
    ocr = FakeProvider("local")
    ocr.vision_responses = [OLMOCR_OK + "# Title\n\n<table><tr><td>a</td></tr></table>"]
    with_ocr(deps, ocr)
    queue = FakeQueue()

    out = _transcriber(deps, queue).transcribe([1])

    assert out == {1: Transcript(OLMOCR_OK + "# Title\n\n<table><tr><td>a</td></tr></table>", 0)}
    assert store.get("runs", ocr_run_key("job-1", 2)).decode().startswith(OLMOCR_OK)
    assert any(msg == "ocr" for _, _, msg in queue.events)


def test_cached_without_rotation_reads_upright(setup) -> None:  # type: ignore[no-untyped-def]  # noqa: F811
    _, store, deps = setup
    ocr = FakeProvider("local")
    with_ocr(deps, ocr)
    store.put("runs", _shared_key(deps, 1), (OLMOCR_OK + "Cached.").encode(), "text/markdown")

    out = _transcriber(deps, FakeQueue()).transcribe([0])

    assert out == {0: Transcript(OLMOCR_OK + "Cached.", 0)}
    assert ocr.vision_calls == []


def test_rotation_round_trips(setup) -> None:  # type: ignore[no-untyped-def]  # noqa: F811
    _, store, deps = setup
    ocr = FakeProvider("local")
    ocr.vision_responses = [ROTATED + "sideways", OLMOCR_OK + "Upright now."]
    with_ocr(deps, ocr)

    first = _transcriber(deps, FakeQueue()).transcribe([0])

    assert first == {0: Transcript(OLMOCR_OK + "Upright now.", 90)}
    assert store.get("runs", ocr_rotation_key(_shared_key(deps, 1))) == b"90"
    calls = len(ocr.vision_calls)

    again = JobTranscriber(job(id="job-2"), deps, FakeQueue(), PDF, sha256=SHA).transcribe([0])
    assert again == first
    assert len(ocr.vision_calls) == calls  # read from the shared cache


def test_refusal_fails_decomposition_page(setup) -> None:  # type: ignore[no-untyped-def]  # noqa: F811
    _, _, deps = setup
    ocr = FakeProvider("local")
    ocr.vision_responses = [RefusalError("refused")]
    with_ocr(deps, ocr)
    transcriber = _transcriber(
        deps,
        FakeQueue(),
        failure=lambda message, page: TranscriptionFailed(message, at=f"page {page}"),
    )

    with pytest.raises(TranscriptionFailed) as info:
        transcriber.transcribe([1])
    assert info.value.at == "page 2"
