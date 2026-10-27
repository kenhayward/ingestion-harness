"""The dev tools' OCR transcriber, cached on disk (spec section 15.5)."""

from __future__ import annotations

from pathlib import Path

from ingest_worker.decompose.pdf.dev_ocr import DiskTranscriber
from ingest_worker.decompose.pdf.transcript import Transcript
from tests.decompose.pdf.make_pdf import Page, make_pdf
from tests.fakes import FakeProvider
from tests.test_pipeline import OLMOCR_OK

ROTATED = "---\nprimary_language: en\nis_rotation_valid: false\nrotation_correction: 90\n---\n"


def _transcriber(provider: FakeProvider, cache: Path) -> DiskTranscriber:
    pdf = make_pdf([Page(), Page()])
    return DiskTranscriber(pdf, provider=provider, model_id="olmocr", cache_dir=cache)


def test_disk_transcriber_caches(tmp_path: Path) -> None:
    provider = FakeProvider("local")
    provider.vision_responses = [OLMOCR_OK + "Page one."]
    first = _transcriber(provider, tmp_path).transcribe([0])
    assert first == {0: Transcript(OLMOCR_OK + "Page one.", 0)}

    again = _transcriber(provider, tmp_path).transcribe([0])
    assert again == first
    assert len(provider.vision_calls) == 1


def test_disk_transcriber_keeps_rotation(tmp_path: Path) -> None:
    provider = FakeProvider("local")
    provider.vision_responses = [ROTATED + "x", OLMOCR_OK + "Upright."]
    first = _transcriber(provider, tmp_path).transcribe([1])
    assert first == {1: Transcript(OLMOCR_OK + "Upright.", 90)}
    assert _transcriber(provider, tmp_path).transcribe([1]) == first
    assert len(provider.vision_calls) == 2
