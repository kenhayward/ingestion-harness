"""Equivalence traces for the worker nodes refactor (docs/design/worker-nodes-refactor.md).

Each scenario runs jobs through `run_once` with fakes and records a trace of everything they
did that anyone can observe: objects written (per bucket and target), job events, queue calls,
step runs, model and OCR requests, graph store requests. The trace must equal the golden file in
tests/fixtures/equivalence/, so a refactor that changes behaviour fails here even where no
behavioural test happens to look. Wall-clock values are replaced with placeholders.

A golden file is rewritten only on purpose: IH_UPDATE_GOLDEN=1 uv run pytest tests/test_equivalence.py
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import threading
from collections.abc import Callable
from dataclasses import replace
from pathlib import Path
from typing import Any

import pytest
from rdflib import Graph
from rdflib.compare import to_canonical_graph

from ingest_worker.graph_registry import MemoryGraphRegistry
from ingest_worker.llm.base import CompletionResult, VisionRequest
from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.ocr import OcrSettings
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.specs import CopySelection, load_specs
from ingest_worker.storage import MemoryObjectStore, ontology_normalized_key

from . import test_pipeline as legacy
from . import test_template_pipeline as recipes
from . import test_workbench as workbench
from .fakes import FakeGraphStore, FakeProvider, FakeQueue

GOLDEN = Path(__file__).parent / "fixtures" / "equivalence"
UPDATE = os.environ.get("IH_UPDATE_GOLDEN") == "1"

TIME = re.compile(r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?")
#: Keys whose numbers are durations measured by the clock.
CLOCK_KEYS = {"seconds", "duration_ms", "elapsed", "elapsed_s", "latency_ms"}
TURTLE = ("text/turtle", "application/n-triples")


def scrub(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            str(k): "<clock>" if k in CLOCK_KEYS and isinstance(v, int | float) else scrub(v)
            for k, v in value.items()
        }
    if isinstance(value, list | tuple):
        return [scrub(v) for v in value]
    if isinstance(value, str):
        return TIME.sub("<time>", value)
    return value


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def triples(data: bytes, fmt: str) -> list[str]:
    """A graph as sorted N-Triples with canonical blank nodes (serialisation order is free)."""
    graph = to_canonical_graph(Graph().parse(data=data, format=fmt))
    return sorted(scrub(line) for line in graph.serialize(format="nt").splitlines() if line)


def body(data: bytes, content_type: str) -> Any:
    if content_type.startswith("application/json"):
        return scrub(json.loads(data))
    if content_type.startswith(TURTLE):
        return triples(data, "nt" if "n-triples" in content_type else "turtle")
    if content_type.startswith("text/") or content_type.endswith("+xml"):
        return scrub(data.decode("utf-8"))
    return {"sha256": digest(data), "bytes": len(data)}


def objects(store: MemoryObjectStore) -> dict[str, Any]:
    return {
        f"{bucket}/{key}": {"type": ctype, "body": body(data, ctype)}
        for (bucket, key), (data, ctype) in sorted(store.objects.items())
    }


def outputs(rendered: list[Any]) -> list[str]:
    return [f"{o.format}:{o.key}" for o in rendered]


def queue_trace(queue: FakeQueue) -> dict[str, Any]:
    return {
        "events": scrub([list(e) for e in queue.event_details]),
        "drafts": [[j, outputs(o)] for j, o in queue.drafts],
        "awaiting": scrub([[j, outputs(o), reasons] for j, o, reasons in queue.awaiting]),
        "reviewed": scrub([list(r) for r in queue.reviewed]),
        "failed": [[j, re.sub(r"0x[0-9a-f]+", "<addr>", e)] for j, e in queue.failed],
        "completed": [[j, outputs(o)] for j, o in queue.completed],
        "published": [[j, outputs(o), t] for j, o, t in queue.published],
        "step_runs": scrub(queue.step_runs),
    }


def model_trace(provider: FakeProvider) -> dict[str, Any]:
    return {
        "calls": [
            {
                "model": model,
                "system": request.system,
                "prompt": request.prompt,
                "schema_name": request.schema_name,
                "schema": request.json_schema,
                "max_tokens": request.max_tokens,
                "images": [digest(i) for i in request.images],
            }
            for model, request in provider.calls
        ],
        "vision": [
            {"model": model, "prompt": r.prompt, "image": digest(r.image_png)}
            for model, r in provider.vision_calls
        ],
    }


def check(name: str, trace: dict[str, Any]) -> None:
    path = GOLDEN / f"{name}.json"
    text = json.dumps(trace, indent=1, sort_keys=True, ensure_ascii=False) + "\n"
    if UPDATE:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8", newline="\n")
        return
    assert path.exists(), f"no golden trace {path.name}: run with IH_UPDATE_GOLDEN=1 once"
    assert json.loads(text) == json.loads(path.read_text(encoding="utf-8")), (
        f"trace {name} differs from its golden file: behaviour changed"
    )


def provider_of(deps: PipelineDeps, name: str) -> FakeProvider:
    provider = deps.models._providers[name]  # type: ignore[attr-defined]
    assert isinstance(provider, FakeProvider)
    return provider


# --- scenarios -------------------------------------------------------------------------------


def test_template_review_rerun_publish(tmp_path: Path) -> None:
    """Mapped recipe with shapes and review: process, a step re-run, then publish with an edit."""
    template = {
        **recipes.TEMPLATE,
        "review": {"required": "always"},
        "semantics": {**recipes.ENTITY, "shapes": [{"id": "ex-shapes", "version": 1}]},
        "delivery": {"formats": ["csv", "json", "rdf"]},
    }
    deps, target = recipes.mapped_deps(tmp_path, template, recipes.BASE_IRI)
    deps = replace(deps, graph_registry=MemoryGraphRegistry(), graph_store=FakeGraphStore())
    key = ontology_normalized_key("ex-shapes", 1)
    deps.store.put("runs", key, recipes.WARNING_NT, "application/n-triples")
    provider = provider_of(deps, "local")
    queue = FakeQueue(jobs=[recipes.JOB])
    run_once(queue, deps, "w1")

    provider.responses = [recipes.RESPONSES[0]]
    rerun = {"step": "header", "instructions": "Read the product line only."}
    queue.jobs = [replace(recipes.JOB, task="rerun", rerun=rerun)]
    run_once(queue, deps, "w1")

    queue.jobs = [replace(recipes.JOB, task="publish")]
    queue.edits["job-1"] = [recipes.product_edit("Ferric capsules")]
    queue.decisions["job-1"] = {
        "reviewer": "kh",
        "note": "checked",
        "reviewed_at": "2026-10-14T10:05:00Z",
    }
    run_once(queue, deps, "w1")
    assert queue.completed, queue.reviewed or queue.failed

    assert isinstance(deps.store, MemoryObjectStore)
    assert isinstance(deps.graph_store, FakeGraphStore)
    check(
        "template-review-rerun-publish",
        {
            "store": objects(deps.store),
            "target": objects(target),
            "queue": queue_trace(queue),
            "models": model_trace(provider),
            "graph_store": [
                [m, g, triples(b, "turtle") if b else None, c]
                for m, g, b, c in deps.graph_store.requests
            ],
        },
    )


def test_template_delivered(tmp_path: Path) -> None:
    """Mapped recipe never reviewed: delivered at once, graph included."""
    template = recipes.mapped(delivery={"formats": ["csv", "json", "rdf"]})
    deps, target = recipes.mapped_deps(tmp_path, template, recipes.BASE_IRI)
    deps = replace(deps, graph_registry=MemoryGraphRegistry(), graph_store=FakeGraphStore())
    queue = FakeQueue(jobs=[recipes.JOB])
    run_once(queue, deps, "w1")
    assert queue.completed, queue.reviewed or queue.failed

    assert isinstance(deps.store, MemoryObjectStore)
    check(
        "template-delivered",
        {
            "store": objects(deps.store),
            "target": objects(target),
            "queue": queue_trace(queue),
            "models": model_trace(provider_of(deps, "local")),
        },
    )


class PagedVision(FakeProvider):
    """OCR answers chosen by the page in the image, not by call order: pages are OCR'd
    concurrently, so a queue of answers would make the trace depend on thread timing."""

    def __init__(self, name: str, responses: list[Any], pages: list[str]) -> None:
        super().__init__(name, responses=responses)
        self.pages = pages

    def complete_vision(self, model: str, request: VisionRequest) -> CompletionResult:
        with LOCK:
            self.vision_calls.append((model, request))
            self.vision_calls.sort(key=lambda c: c[1].image_png)
        return CompletionResult(
            text=legacy.OLMOCR_OK + self.pages[request.image_png[-1]], model=model
        )


LOCK = threading.Lock()


def test_template_ocr(tmp_path: Path) -> None:
    """Pages without enough text are OCR'd, then the recipe's steps read them."""
    deps, _ = recipes.mapped_deps(tmp_path, recipes.TEMPLATE, None)
    provider = PagedVision("local", list(recipes.RESPONSES), recipes.PAGES)
    deps.models = ModelRegistry(
        {"local": provider},
        {"local": ProviderConfig(name="local", kind="openai-chat")},
        {"default": "local/qwen"},
    )
    deps.ocr = OcrSettings(model="local/olmocr-2-7b-1025")
    deps.render_page = lambda pdf, index, dim, rotation: b"\x89PNG" + bytes([index])
    deps.extract_text = lambda _pdf: [recipes.PAGES[0], "", recipes.PAGES[2]]
    queue = FakeQueue(jobs=[recipes.JOB])
    run_once(queue, deps, "w1")
    assert queue.awaiting, queue.reviewed or queue.failed

    assert isinstance(deps.store, MemoryObjectStore)
    check(
        "template-ocr",
        {
            "store": objects(deps.store),
            "queue": queue_trace(queue),
            "models": model_trace(provider),
        },
    )


def test_template_missing_section(tmp_path: Path) -> None:
    """A document without a required section goes to review before any model call."""
    deps, _ = recipes.mapped_deps(tmp_path, recipes.TEMPLATE, None)
    deps.extract_text = lambda _pdf: ["Product: Richfer capsules", "nothing else"]
    queue = FakeQueue(jobs=[recipes.JOB])
    run_once(queue, deps, "w1")
    assert queue.reviewed

    assert isinstance(deps.store, MemoryObjectStore)
    check(
        "template-missing-section",
        {
            "store": objects(deps.store),
            "queue": queue_trace(queue),
            "models": model_trace(provider_of(deps, "local")),
        },
    )


def test_spec_copies(fixture_specs_dir: Path) -> None:
    """A legacy spec.yaml job that keeps the last of two copies."""
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
        extract_text=lambda _pdf: ["INVOICE DRAFT\nDescription Qty\n(blank)", *legacy.PAGES],
        buckets=Buckets("inbox", "outputs", "runs"),
    )
    copies = CopySelection(anchor=r"^\s*INVOICE\b", select="last")
    legacy.with_spec_changes(deps, fixture_specs_dir, document={"copies": copies})
    provider.responses = [legacy.HEADER, legacy.LINES]
    queue = FakeQueue(jobs=[legacy.job()])
    run_once(queue, deps, "w1")
    assert queue.completed, queue.reviewed or queue.failed

    check(
        "spec-copies",
        {"store": objects(store), "queue": queue_trace(queue), "models": model_trace(provider)},
    )


@pytest.mark.parametrize(
    ("name", "pages", "read"),
    [
        ("workbench-prepare", [workbench.TEXT_PAGE * 4, ""], ["", "Batch record page two"]),
        ("workbench-prepare-blank", ["", " "], ["", ""]),
    ],
)
def test_workbench_prepare(
    fixture_specs_dir: Path, name: str, pages: list[str], read: list[str]
) -> None:
    """Workbench prepare: text layer, OCR of the pages without text (or none readable)."""
    ocr = PagedVision("local", [], read)
    deps = workbench.make_deps(fixture_specs_dir, pages, ocr)
    queue = FakeQueue(jobs=[workbench.prepare_job()])
    run_once(queue, deps, "w1")

    assert isinstance(deps.store, MemoryObjectStore)
    check(
        name,
        {"store": objects(deps.store), "queue": queue_trace(queue), "models": model_trace(ocr)},
    )


def test_scrub_hides_clock_values_only() -> None:
    scrubbed: Callable[[Any], Any] = scrub
    assert scrubbed({"at": "2026-10-19T10:00:00.123+00:00", "seconds": 1.5, "pages": 2}) == {
        "at": "<time>",
        "seconds": "<clock>",
        "pages": 2,
    }
