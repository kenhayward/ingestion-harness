"""Pipeline mechanics against a test-only invoice spec (tests/fixtures/specs) with fakes."""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path

import pytest

from ingest_worker.llm.base import CompletionResult, LLMError, VisionRequest
from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.ocr import OcrSettings
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.prompts import render_prompt
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import (
    Check,
    CopySelection,
    CsvOutput,
    LoadedSpec,
    SpecRegistry,
    load_specs,
)
from ingest_worker.storage import MemoryObjectStore

from .fakes import FakeProvider, FakeQueue

PAGES = [
    "INVOICE INV-001\nAcme Supplies Ltd\nDate: 2026-03-01\n"
    "Description          Qty   Unit   Amount\nWidget               2     5.00   10.00\n",
    "Gadget               1     3.00   3.00\nSubtotal 13.00\nVAT 2.60\nTotal 15.60 GBP\n",
]

HEADER = {
    "invoice_number": "INV-001",
    "invoice_date": "2026-03-01",
    "supplier_name": "Acme Supplies Ltd",
    "currency": "GBP",
    "subtotal": 13.0,
    "tax": 2.6,
    "total": 15.6,
}
LINES = {
    "items": [
        {"sku": None, "description": "Widget", "quantity": 2, "unit_price": 5.0, "amount": 10.0},
        {"sku": None, "description": "Gadget", "quantity": 1, "unit_price": 3.0, "amount": 3.0},
    ]
}


def job(**overrides: object) -> ClaimedJob:
    base = dict(
        id="job-1",
        document_id="doc-1",
        spec_id="example-invoice",
        spec_version=1,
        bucket="inbox",
        object_key="example-invoice/v1/doc-1.pdf",
        model_override=None,
        attempts=1,
        max_attempts=3,
    )
    return ClaimedJob(**{**base, **overrides})  # type: ignore[arg-type]


@pytest.fixture
def setup(fixture_specs_dir: Path):  # type: ignore[no-untyped-def]
    provider = FakeProvider("anthropic", kind="anthropic")
    store = MemoryObjectStore()
    store.put("inbox", "example-invoice/v1/doc-1.pdf", b"%PDF-fake", "application/pdf")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(fixture_specs_dir),
        models=ModelRegistry(
            {"anthropic": provider},
            {"anthropic": ProviderConfig(name="anthropic", kind="anthropic")},
            {"default": "anthropic/claude-opus-5-5"},
        ),
        extract_text=lambda _pdf: PAGES,
        buckets=Buckets("inbox", "outputs", "runs"),
    )
    return provider, store, deps


def test_happy_path_writes_csv_and_json_outputs(setup) -> None:  # type: ignore[no-untyped-def]
    provider, store, deps = setup
    provider.responses = [HEADER, LINES]
    queue = FakeQueue(jobs=[job()])

    assert run_once(queue, deps, "w1") is True

    [(job_id, outputs)] = queue.completed
    assert job_id == "job-1"
    assert {o.output_id: o.row_count for o in outputs} == {
        "invoices": 1,
        "invoice_lines": 2,
        "invoice_full": None,
    }
    lines_csv = store.get("outputs", "example-invoice/v1/invoice_lines/doc-1.csv").decode()
    assert lines_csv.splitlines()[0] == "document_id,sku,description,quantity,unit_price,amount"
    assert lines_csv.splitlines()[1] == "doc-1,,Widget,2,5.0,10.0"

    full = json.loads(store.get("outputs", "example-invoice/v1/invoice_full/doc-1.json"))
    assert full["data"]["invoice_header"]["total"] == 15.6
    assert full["models"] == {
        "invoice_header": "anthropic/claude-opus-5-5",
        "line_items": "anthropic/claude-opus-5-5",
    }

    # Header prompt received only the header + totals sections.
    header_prompt = provider.calls[0][1].prompt
    assert "Acme Supplies" in header_prompt and "Subtotal 13.00" in header_prompt
    assert "Widget" not in header_prompt

    # Every attempt is audited to the runs bucket.
    assert ("runs", "job-1/invoice_header/attempt-1.json") in store.objects


def test_model_override_wins_over_spec_model(setup) -> None:  # type: ignore[no-untyped-def]
    provider, _, deps = setup
    provider.responses = [HEADER, LINES]
    run_once(FakeQueue(jobs=[job(model_override="anthropic/claude-haiku-5-5")]), deps, "w1")
    assert [model for model, _ in provider.calls] == ["claude-haiku-5-5"] * 2


def test_missing_sections_route_to_needs_review(setup) -> None:  # type: ignore[no-untyped-def]
    _, _, deps = setup
    deps.extract_text = lambda _pdf: ["INVOICE only, nothing else"]
    queue = FakeQueue(jobs=[job()])
    run_once(queue, deps, "w1")
    assert queue.reviewed and "line_items" in queue.reviewed[0][1]
    assert not queue.completed and not queue.failed


def test_schema_failures_route_to_needs_review(setup) -> None:  # type: ignore[no-untyped-def]
    provider, _, deps = setup
    provider.responses = [{"bad": 1}, {"bad": 2}]
    queue = FakeQueue(jobs=[job()])
    run_once(queue, deps, "w1")
    assert queue.reviewed and "invoice_header" in queue.reviewed[0][1]


def test_unexpected_errors_are_retryable_failures(setup) -> None:  # type: ignore[no-untyped-def]
    provider, _, deps = setup
    provider.responses = [ConnectionError("reset")]
    queue = FakeQueue(jobs=[job()])
    run_once(queue, deps, "w1")
    assert queue.failed and "ConnectionError" in queue.failed[0][1]


def test_empty_queue_returns_false(setup) -> None:  # type: ignore[no-untyped-def]
    _, _, deps = setup
    assert run_once(FakeQueue(), deps, "w1") is False


def test_unconfigured_model_override_goes_to_review_without_llm_calls(setup) -> None:  # type: ignore[no-untyped-def]
    provider, _, deps = setup
    queue = FakeQueue(jobs=[job(model_override="openai/gpt-5")])
    run_once(queue, deps, "w1")
    assert not queue.failed, "config errors must not be retried"
    [(_, reason)] = queue.reviewed
    assert "openai" in reason and "not configured" in reason
    assert provider.calls == []


def test_models_are_resolved_before_any_extraction_runs(setup, fixture_specs_dir: Path) -> None:  # type: ignore[no-untyped-def]
    """A bad model on a later extraction must not waste tokens on earlier ones."""
    provider, _, deps = setup
    loaded = load_specs(fixture_specs_dir).get("example-invoice", 1)
    extractions = list(loaded.spec.extractions)
    extractions[1] = extractions[1].model_copy(update={"model": "missing-alias"})
    bad = LoadedSpec(loaded.spec.model_copy(update={"extractions": extractions}), loaded.directory)
    deps.specs = SpecRegistry([bad])
    provider.responses = [HEADER, LINES]

    queue = FakeQueue(jobs=[job()])
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "line_items" in reason and "missing-alias" in reason
    assert provider.calls == []


# --- OCR -----------------------------------------------------------------------------------

OLMOCR_OK = "---\nprimary_language: en\nis_rotation_valid: true\nrotation_correction: 0\n---\n"


def with_ocr(deps: PipelineDeps, ocr_provider: FakeProvider) -> None:
    deps.models = ModelRegistry(
        {"anthropic": deps.models.resolve("default")[0], "local": ocr_provider},
        {
            "anthropic": ProviderConfig(name="anthropic", kind="anthropic"),
            "local": ProviderConfig(name="local", kind="openai-chat"),
        },
        {"default": "anthropic/claude-opus-5-5"},
    )
    deps.ocr = OcrSettings(model="local/olmocr-2-7b-1025")
    deps.render_page = lambda pdf, index, dim, rotation: b"\x89PNG" + bytes([index])


def test_image_only_pages_are_ocrd_then_extracted(setup) -> None:  # type: ignore[no-untyped-def]
    provider, store, deps = setup
    ocr = FakeProvider("local")
    ocr.vision_responses = [OLMOCR_OK + PAGES[0], OLMOCR_OK + PAGES[1]]
    with_ocr(deps, ocr)
    deps.extract_text = lambda _pdf: ["", "   "]
    provider.responses = [HEADER, LINES]

    queue = FakeQueue(jobs=[job()])
    run_once(queue, deps, "w1")

    assert queue.completed, queue.reviewed or queue.failed
    assert [m for m, _ in ocr.vision_calls] == ["olmocr-2-7b-1025"] * 2
    assert "Acme Supplies" in provider.calls[0][1].prompt  # OCR text reached extraction
    audit = store.get("runs", "job-1/ocr/page-2.md").decode()  # raw model output, unparsed
    assert audit.startswith(OLMOCR_OK) and "Total 15.60 GBP" in audit
    assert any(msg == "ocr" for _, _, msg in queue.events)


def test_only_low_text_pages_are_ocrd_in_auto_mode(setup) -> None:  # type: ignore[no-untyped-def]
    provider, _, deps = setup
    ocr = FakeProvider("local")
    ocr.vision_responses = [OLMOCR_OK + PAGES[1]]
    with_ocr(deps, ocr)
    deps.extract_text = lambda _pdf: [PAGES[0], ""]
    provider.responses = [HEADER, LINES]

    queue = FakeQueue(jobs=[job()])
    run_once(queue, deps, "w1")

    assert queue.completed
    [(_, request)] = ocr.vision_calls
    assert request.image_png == b"\x89PNG\x01"  # page index 1 only


def test_image_only_pdf_without_ocr_configured_needs_review(setup) -> None:  # type: ignore[no-untyped-def]
    provider, _, deps = setup
    deps.extract_text = lambda _pdf: ["", ""]
    queue = FakeQueue(jobs=[job()])
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "OCR" in reason
    assert provider.calls == []


def test_unresolvable_ocr_model_needs_review(setup) -> None:  # type: ignore[no-untyped-def]
    _, _, deps = setup
    deps.ocr = OcrSettings(model="nowhere/olmocr")
    deps.extract_text = lambda _pdf: ["", ""]
    queue = FakeQueue(jobs=[job()])
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "nowhere" in reason


def test_transient_ocr_errors_are_retried(setup) -> None:  # type: ignore[no-untyped-def]
    _, _, deps = setup
    ocr = FakeProvider("local")
    ocr.vision_responses = [LLMError("503 model loading")]
    with_ocr(deps, ocr)
    deps.extract_text = lambda _pdf: ["", ""]
    queue = FakeQueue(jobs=[job()])
    run_once(queue, deps, "w1")
    assert queue.failed and "503" in queue.failed[0][1]


# --- page images, copy selection, OCR concurrency -------------------------------------------


def with_spec_changes(deps: PipelineDeps, fixture_specs_dir: Path, **changes: object) -> None:
    """Swap in a modified copy of the fixture spec (specs are immutable models)."""
    loaded = deps.specs.get("example-invoice", 1)
    spec = loaded.spec
    document = spec.document.model_copy(update=changes.pop("document", {}))  # type: ignore[arg-type]
    spec = spec.model_copy(update={"document": document, **changes})
    deps.specs = SpecRegistry([LoadedSpec(spec, loaded.directory)])


def test_page_images_are_rendered_for_extractions_that_ask_for_them(
    setup, fixture_specs_dir: Path
) -> None:  # type: ignore[no-untyped-def]
    provider, _, deps = setup
    loaded = deps.specs.get("example-invoice", 1)
    extractions = list(loaded.spec.extractions)
    extractions[0] = extractions[0].model_copy(update={"page_images": [1, 2, 9]})
    with_spec_changes(deps, fixture_specs_dir, extractions=extractions)
    renders: list[tuple[int, int]] = []
    deps.render_page = lambda pdf, i, dim, rot: renders.append((i, dim)) or b"\x89PNG" + bytes([i])  # type: ignore[func-returns-value]
    provider.responses = [HEADER, LINES]

    queue = FakeQueue(jobs=[job()])
    run_once(queue, deps, "w1")

    assert queue.completed
    header_req, lines_req = provider.calls[0][1], provider.calls[1][1]
    assert header_req.images == (b"\x89PNG\x00", b"\x89PNG\x01")  # page 9 doesn't exist: skipped
    assert lines_req.images == ()
    assert renders == [(0, 1288), (1, 1288)]


def test_copy_selection_segments_only_the_selected_copy(setup, fixture_specs_dir: Path) -> None:  # type: ignore[no-untyped-def]
    provider, _, deps = setup
    blank = ["INVOICE DRAFT\nDescription Qty\n(blank)\nSubtotal 0.00"]
    deps.extract_text = lambda _pdf: blank + PAGES
    copies = CopySelection(anchor=r"^\s*INVOICE\b", select="last")
    with_spec_changes(deps, fixture_specs_dir, document={"copies": copies})
    provider.responses = [HEADER, LINES]

    queue = FakeQueue(jobs=[job()])
    run_once(queue, deps, "w1")

    assert queue.completed
    assert "DRAFT" not in provider.calls[0][1].prompt
    assert "Acme Supplies" in provider.calls[0][1].prompt
    assert ("job-1", "info", "selected copy") in queue.events


def test_chunked_extraction_runs_per_page_and_merges_arrays(setup, fixture_specs_dir: Path) -> None:  # type: ignore[no-untyped-def]
    provider, store, deps = setup
    loaded = deps.specs.get("example-invoice", 1)
    extractions = list(loaded.spec.extractions)
    extractions[1] = extractions[1].model_copy(
        update={"chunk_pages": 1, "merge_path": "items", "max_tokens": 4000}
    )
    with_spec_changes(deps, fixture_specs_dir, extractions=extractions)
    first, second = LINES["items"]
    provider.responses = [HEADER, {"items": [first]}, {"items": [second]}]

    queue = FakeQueue(jobs=[job()])
    run_once(queue, deps, "w1")

    assert queue.completed, queue.reviewed or queue.failed
    chunk_calls = provider.calls[1:]
    assert len(chunk_calls) == 2
    assert "Widget" in chunk_calls[0][1].prompt and "Gadget" not in chunk_calls[0][1].prompt
    assert "Gadget" in chunk_calls[1][1].prompt and "Widget" not in chunk_calls[1][1].prompt
    assert all(req.max_tokens == 4000 for _, req in chunk_calls)
    lines_csv = store.get("outputs", "example-invoice/v1/invoice_lines/doc-1.csv").decode()
    assert [row.split(",")[2] for row in lines_csv.splitlines()[1:]] == ["Widget", "Gadget"]
    assert ("runs", "job-1/line_items.chunk-2/attempt-1.json") in store.objects


def test_chunk_info_is_available_to_prompt_templates(tmp_path: Path) -> None:
    (tmp_path / "p.j2").write_text(
        "{% if chunk %}part {{ chunk.index }}/{{ chunk.count }}{% else %}whole{% endif %}",
        encoding="utf-8",
    )
    assert render_prompt(tmp_path, "p.j2", {"s": "x"}, ["s"]) == "whole"
    assert (
        render_prompt(tmp_path, "p.j2", {"s": "x"}, ["s"], chunk={"index": 2, "count": 5})
        == "part 2/5"
    )


def test_checks_run_after_extraction_and_feed_outputs(setup, fixture_specs_dir: Path) -> None:  # type: ignore[no-untyped-def]
    provider, store, deps = setup
    loaded = deps.specs.get("example-invoice", 1)
    check = Check.model_validate(
        {
            "id": "descriptions",
            "values": "line_items.items[*].description",
            "reference": "invoice_header.supplier_name",
        }
    )
    csv_out = CsvOutput.model_validate(
        {
            "id": "description_check",
            "format": "csv",
            "from": "descriptions",
            "rowsPath": "rows",
            "columns": [{"name": "value", "path": "value"}, {"name": "status", "path": "status"}],
        }
    )
    with_spec_changes(
        deps, fixture_specs_dir, checks=[check], outputs=[*loaded.spec.outputs, csv_out]
    )
    provider.responses = [HEADER, LINES]

    queue = FakeQueue(jobs=[job()])
    run_once(queue, deps, "w1")

    assert queue.completed, queue.reviewed or queue.failed
    csv = store.get("outputs", "example-invoice/v1/description_check/doc-1.csv").decode()
    assert "doc-1,Widget,unmatched" in csv and "doc-1,Acme Supplies Ltd,unused" in csv
    assert ("job-1", "warn", "check descriptions: 2 unmatched") in queue.events
    full = json.loads(store.get("outputs", "example-invoice/v1/invoice_full/doc-1.json"))
    assert full["data"]["descriptions"]["rows"]


class ConcurrentOcr(FakeProvider):
    def __init__(self) -> None:
        super().__init__("local")
        self.in_flight = 0
        self.max_in_flight = 0
        self._lock = threading.Lock()

    def complete_vision(self, model: str, request: VisionRequest) -> CompletionResult:
        with self._lock:
            self.in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self.in_flight)
        time.sleep(0.05)
        with self._lock:
            self.in_flight -= 1
        page = request.image_png[-1]
        text = PAGES[page] if page < 2 else f"page {page}"
        return CompletionResult(text=OLMOCR_OK + text, model=model)


def test_ocr_runs_pages_concurrently_and_keeps_page_order(setup) -> None:  # type: ignore[no-untyped-def]
    provider, _, deps = setup
    ocr = ConcurrentOcr()
    with_ocr(deps, ocr)
    deps.ocr = OcrSettings(model="local/olmocr-2-7b-1025", concurrency=3)
    deps.extract_text = lambda _pdf: [""] * 6
    provider.responses = [HEADER, LINES]

    queue = FakeQueue(jobs=[job()])
    run_once(queue, deps, "w1")

    assert queue.completed, queue.reviewed or queue.failed
    assert ocr.max_in_flight == 3
    prompt = provider.calls[0][1].prompt
    assert prompt.index("INVOICE INV-001") < prompt.index("Subtotal 13.00")


def test_ocr_reuses_pages_already_transcribed_for_this_job(setup) -> None:  # type: ignore[no-untyped-def]
    """A retried job must not pay for OCR again (60-page scans take minutes)."""
    provider, store, deps = setup
    ocr = FakeProvider("local")
    ocr.vision_responses = [OLMOCR_OK + PAGES[1]]  # only page 2 still needs OCR
    with_ocr(deps, ocr)
    deps.extract_text = lambda _pdf: ["", ""]
    store.put("runs", "job-1/ocr/page-1.md", (OLMOCR_OK + PAGES[0]).encode(), "text/markdown")
    provider.responses = [HEADER, LINES]

    queue = FakeQueue(jobs=[job(attempts=2)])
    run_once(queue, deps, "w1")

    assert queue.completed, queue.reviewed or queue.failed
    [(_, request)] = ocr.vision_calls
    assert request.image_png == b"\x89PNG\x01"
    assert "Acme Supplies" in provider.calls[0][1].prompt  # cached page 1 text was used
