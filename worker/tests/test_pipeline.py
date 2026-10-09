"""End-to-end pipeline against the committed example spec with in-memory fakes."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
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
def setup(specs_dir: Path):  # type: ignore[no-untyped-def]
    provider = FakeProvider("anthropic", kind="anthropic")
    store = MemoryObjectStore()
    store.put("inbox", "example-invoice/v1/doc-1.pdf", b"%PDF-fake", "application/pdf")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(specs_dir),
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
