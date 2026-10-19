"""The nodes prepare_document is made of (docs/design/worker-nodes-refactor.md, part 1):
read_pages, select_pages and segment_pages, each usable on its own."""

from __future__ import annotations

import re
from typing import Any

import pytest

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.ocr import OcrSettings
from ingest_worker.pipeline import (
    PREPARE_PROGRESS,
    SEGMENTED,
    Buckets,
    DocumentError,
    PageText,
    PipelineDeps,
    Selected,
    Source,
    read_pages,
    segment_pages,
    select_pages,
)
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import CopySelection, DocumentLayout, PageRange
from ingest_worker.storage import MemoryObjectStore
from ingest_worker.template import TemplateDocument

from .fakes import FakeProvider, FakeQueue

OLMOCR_OK = "---\nprimary_language: en\nis_rotation_valid: true\nrotation_correction: 0\n---\n"
JOB = ClaimedJob("job-1", "doc-1", "demo", 1, "inbox", "demo/v1/doc-1.pdf", None, 1, 3)
SOURCE = Source(b"%PDF", "sha-1", "pdf", b"%PDF")
LONG = "Product: Richfer capsules, made at the Ware site on 16/02/2023 for the validation run.\n"


def deps(pages: list[str], ocr: FakeProvider | None = None) -> PipelineDeps:
    made = PipelineDeps(
        store=MemoryObjectStore(),
        specs=None,  # type: ignore[arg-type]
        models=ModelRegistry(
            {"local": ocr} if ocr else {},
            {"local": ProviderConfig(name="local", kind="openai-chat")} if ocr else {},
            {},
        ),
        extract_text=lambda _pdf: pages,
        buckets=Buckets("inbox", "outputs", "runs"),
    )
    if ocr is not None:
        made.ocr = OcrSettings(model="local/olmocr-2-7b-1025", cache=False)
        made.render_page = lambda pdf, index, dim, rotation: b"\x89PNG" + bytes([index])
    return made


def layout(**extra: Any) -> DocumentLayout:
    return DocumentLayout.model_validate(
        {"sections": [{"id": "head", "anchor": r"\A"}, {"id": "body", "anchor": "^BODY"}], **extra}
    )


def progress(queue: FakeQueue) -> list[dict[str, Any]]:
    return [d for _, _, m, d in queue.event_details if m == PREPARE_PROGRESS]


# --- read_pages -------------------------------------------------------------------------------


def test_read_pages_keeps_the_text_layer_and_the_pages_after_ocr() -> None:
    ocr = FakeProvider("local")
    ocr.vision_responses = [OLMOCR_OK + "BODY\nG1 137.8"]
    queue = FakeQueue()

    read = read_pages(JOB, deps([LONG, ""], ocr), queue, SOURCE, "auto")

    assert read == PageText(layer=[LONG, ""], pages=[LONG, "BODY\nG1 137.8"])
    assert read.total == 2
    assert progress(queue) == [
        {"stage": "text", "page": 2, "of": 2, "pages": 2},
        {"stage": "ocr", "page": 0, "of": 1, "pages": 2},
        {"stage": "ocr", "page": 1, "of": 1, "pages": 2},
    ]


def test_read_pages_refuses_a_page_count_outside_the_range_before_any_ocr() -> None:
    ocr = FakeProvider("local")
    queue = FakeQueue()
    with pytest.raises(DocumentError, match="page count 2 outside expected range 3-5"):
        read_pages(
            JOB, deps(["", ""], ocr), queue, SOURCE, "auto", expected=PageRange(min=3, max=5)
        )
    assert ocr.vision_calls == []
    assert [d["stage"] for d in progress(queue)] == ["text"]


def test_read_pages_reads_the_text_layer_with_the_reader_it_is_given() -> None:
    seen: list[bytes] = []

    def reader(pdf: bytes) -> list[str]:
        seen.append(pdf)
        return [LONG]

    read = read_pages(JOB, deps(["unused"]), FakeQueue(), SOURCE, "never", text_layer=reader)
    assert seen == [b"%PDF"] and read.pages == [LONG]


# --- select_pages ----------------------------------------------------------------------------


def test_select_pages_keeps_the_last_copy_and_says_so() -> None:
    queue = FakeQueue()
    copies = CopySelection(anchor=r"^COPY", select="last")
    selected = select_pages(
        JOB, deps([]), queue, ["COPY one", "COPY two", "more"], layout(copies=copies)
    )
    assert selected == Selected(pages=["COPY two", "more"], first=1)
    assert ("job-1", "info", "selected copy", {"first_page": 2}) in queue.event_details


def test_select_pages_marks_pages_with_their_original_numbers() -> None:
    document = TemplateDocument.model_validate(
        {
            "sections": [{"id": "head", "anchor": r"\A"}],
            "copies": {"anchor": "^COPY", "select": "last"},
            "pageMarkers": True,
        }
    )
    selected = select_pages(JOB, deps([]), FakeQueue(), ["COPY a", "COPY b", "c"], document)
    assert selected.pages == ["[page 2]\nCOPY b", "[page 3]\nc"]
    assert selected.first == 1


@pytest.mark.parametrize(
    ("ocr", "mode", "hint"),
    [
        (False, "auto", "OCR is not configured"),
        (True, "never", "OCR disabled by spec (document.ocr: never)"),
        (True, "auto", "OCR returned no text"),
    ],
)
def test_select_pages_refuses_a_document_without_text(ocr: bool, mode: str, hint: str) -> None:
    made = deps([], FakeProvider("local") if ocr else None)
    with pytest.raises(DocumentError, match=f"^no extractable text .*; {re.escape(hint)}$"):
        select_pages(JOB, made, FakeQueue(), ["", "  "], layout(ocr=mode))


# --- segment_pages ---------------------------------------------------------------------------


def test_segment_pages_cuts_sections_and_reports_them() -> None:
    queue = FakeQueue()
    segmented = segment_pages(JOB, queue, Selected(["Head", "BODY\nrows"], 0), layout())
    assert list(segmented.sections) == ["head", "body"]
    assert segmented.sections["head"].startswith("Head")
    assert segmented.sections["body"] == "BODY\nrows"
    assert ("job-1", "info", SEGMENTED, {"pages": 2, "sections": ["head", "body"]}) in (
        queue.event_details
    )


def test_segment_pages_sends_missing_sections_to_review() -> None:
    with pytest.raises(DocumentError, match="body"):
        segment_pages(JOB, FakeQueue(), Selected(["Head only"], 0), layout())
