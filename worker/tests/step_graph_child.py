"""A worker process for tests/test_step_graph_integration.py to kill.

python -m tests.step_graph_child DATABASE_URL WORK_DIR MARKER JOB_ID runs the demo recipe's job
JOB_ID with steps checkpointed in DATABASE_URL, finishes the `header` step, then blocks in the
model call for `date` (after writing MARKER) until it is killed.
"""

from __future__ import annotations

import sys
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import yaml

from ingest_worker.llm.base import CompletionRequest, CompletionResult
from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.step_graph import postgres_checkpointer
from ingest_worker.storage import MemoryObjectStore

from .fakes import FakeProvider, FakeQueue
from .test_template_pipeline import JOB, PAGES, RESPONSES, TEMPLATE


def job_named(job_id: str) -> ClaimedJob:
    return ClaimedJob(job_id, *[getattr(JOB, f) for f in JOB.__dataclass_fields__][1:])


def deps_for(work: Path, provider: FakeProvider, checkpointer: Any) -> PipelineDeps:
    directory = work / "demo" / "v1"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "template.yaml").write_text(yaml.safe_dump(TEMPLATE), encoding="utf-8")
    store = MemoryObjectStore()
    store.put("inbox", JOB.object_key, b"%PDF", "application/pdf")
    return PipelineDeps(
        store=store,
        specs=load_specs(work),
        models=ModelRegistry(
            {"local": provider},
            {"local": ProviderConfig(name="local", kind="openai-chat")},
            {"default": "local/qwen"},
        ),
        extract_text=lambda _pdf: PAGES,
        buckets=Buckets("inbox", "outputs", "runs"),
        step_checkpointer=checkpointer,
    )


class BlocksOnDate(FakeProvider):
    def __init__(self, marker: Path) -> None:
        super().__init__("local", responses=list(RESPONSES))
        self.marker = marker

    def complete_json(
        self,
        model: str,
        request: CompletionRequest,
        on_tokens: Callable[[int], None] | None = None,
    ) -> CompletionResult:
        if request.schema_name == "date":
            self.marker.write_text("in the date step", encoding="utf-8")
            time.sleep(600)  # killed long before this ends
        return super().complete_json(model, request, on_tokens)


def main(database_url: str, work: str, marker: str, job_id: str) -> None:
    saver, _ = postgres_checkpointer(database_url)
    deps = deps_for(Path(work), BlocksOnDate(Path(marker)), saver)
    run_once(FakeQueue(jobs=[job_named(job_id)]), deps, "child")


if __name__ == "__main__":
    main(*sys.argv[1:5])
