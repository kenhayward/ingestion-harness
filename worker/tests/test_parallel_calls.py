"""A step's occurrence and chunk calls in parallel, up to the model's parallel calls
(Administration > Models): the same rows, in the same order, as one call at a time."""

from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from typing import Any

import pytest
import yaml

from ingest_worker.llm.base import CompletionRequest, CompletionResult
from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps, run_in_order
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore

from .covalidation import BATCHES
from .fakes import FakeProvider, FakeQueue
from .test_occurrence_filter import _recipe
from .test_template_repeat import BATCH_ROWS, DOC_KEY, HEADER, JOB

# --- run_in_order ---------------------------------------------------------------------------


class Tracker:
    """Counts the calls running at once."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.now = 0
        self.most = 0
        self.started: list[int] = []

    def call(self, n: int, delay: float = 0.02, fail: bool = False) -> Any:
        def run() -> int:
            with self.lock:
                self.now += 1
                self.most = max(self.most, self.now)
                self.started.append(n)
            time.sleep(delay)
            with self.lock:
                self.now -= 1
            if fail:
                raise ValueError(f"call {n} failed")
            return n

        return run


@pytest.mark.parametrize("limit", [1, 2, 4])
def test_run_in_order_keeps_the_order_and_the_limit(limit: int) -> None:
    t = Tracker()
    # Later calls finish first: the results still come back in the calls' order.
    calls = [t.call(n, delay=0.05 - n * 0.005) for n in range(8)]
    assert run_in_order(calls, limit) == list(range(8))
    assert t.most == limit


def test_run_in_order_raises_the_first_failure_in_order_and_starts_nothing_after() -> None:
    t = Tracker()
    calls = [
        t.call(0, delay=0.1),
        t.call(1, delay=0.01, fail=True),
        t.call(2, delay=0.0, fail=True),
        *[t.call(n, delay=0.05) for n in range(3, 12)],
    ]
    with pytest.raises(ValueError, match="call 1 failed"):
        run_in_order(calls, 2)
    # Calls already running when the failure happened may finish; none is started after.
    assert len(t.started) < 12


# --- a step's occurrences in a job ----------------------------------------------------------


class SlowProvider(FakeProvider):
    """Answers by what the prompt asks, so the answers do not depend on call order, and counts
    the calls running at once."""

    def __init__(self) -> None:
        super().__init__("local")
        self.lock = threading.Lock()
        self.now = 0
        self.most = 0

    def complete_json(self, model: str, request: CompletionRequest, **_: Any) -> CompletionResult:
        with self.lock:
            self.calls.append((model, request))
            self.now += 1
            self.most = max(self.most, self.now)
        time.sleep(0.02)
        with self.lock:
            self.now -= 1
        prompt = request.prompt
        if "Task: extract these fields" in prompt:
            reply: Any = HEADER
        elif 'Task: extract the table "batches"' in prompt:
            reply = BATCH_ROWS
        else:
            n = re.search(r'<section id="tables" occurrence="(\d+)"', prompt)
            assert n is not None, prompt
            reply = {"rows": [{"timepoint": "T0", "result": f"table {n.group(1)}"}]}
        return CompletionResult(
            text=json.dumps(reply), model=model, input_tokens=10, output_tokens=5
        )


def _job(tmp_path: Path, parallel: dict[str, int]) -> tuple[SlowProvider, dict[str, Any]]:
    directory = tmp_path / "covalidation" / "v1"
    directory.mkdir(parents=True)
    # Both table steps read all six tables (no filters): six occurrence calls each.
    (directory / "template.yaml").write_text(yaml.safe_dump(_recipe(None, None)), encoding="utf-8")
    provider = SlowProvider()
    store = MemoryObjectStore()
    store.put("inbox", JOB.object_key, b"%PDF", "application/pdf")
    from .covalidation import PAGES

    deps = PipelineDeps(
        store=store,
        specs=load_specs(tmp_path),
        models=ModelRegistry(
            {"local": provider},
            {
                "local": ProviderConfig(
                    name="local", kind="openai-chat", maxConcurrentCalls=parallel
                )
            },
            {"default": "local/qwen"},
        ),
        extract_text=lambda _pdf: PAGES,
        buckets=Buckets("inbox", "outputs", "runs"),
        render_preview=lambda pdf, i: b"jpg",
    )
    queue = FakeQueue(jobs=[JOB])
    run_once(queue, deps, "w1")
    assert queue.awaiting or queue.completed or queue.handed_over, queue.reviewed or queue.failed
    return provider, json.loads(store.get("outputs", DOC_KEY))


def test_occurrence_calls_run_one_at_a_time_unless_the_model_allows_more(tmp_path: Path) -> None:
    provider, _ = _job(tmp_path, {})
    assert provider.most == 1


def test_occurrence_calls_run_in_parallel_up_to_the_models_limit(tmp_path: Path) -> None:
    provider, _ = _job(tmp_path, {"qwen": 3})
    assert provider.most == 3
    assert len(provider.calls) == 1 + 3 + 6 + 6


def test_parallel_calls_give_the_same_document_as_one_at_a_time(tmp_path: Path) -> None:
    _, one = _job(tmp_path / "one", {})
    _, many = _job(tmp_path / "many", {"qwen": 4})
    assert many["tables"] == one["tables"]
    assert [r["result"] for r in many["tables"]["appearance_results"]] == [
        f"table {n}" for n in range(1, 7)
    ]
    assert [r["batch"] for r in many["tables"]["appearance_results"]] == [
        b for b in BATCHES for _ in range(2)
    ]
