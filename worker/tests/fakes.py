from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from ingest_worker.llm.base import (
    CompletionRequest,
    CompletionResult,
    ModelDescriptor,
    ProviderKind,
)
from ingest_worker.outputs import RenderedOutput
from ingest_worker.queue import ClaimedJob


class FakeProvider:
    """Returns queued responses in order (str or dict -> JSON); exceptions are raised."""

    def __init__(
        self,
        name: str = "fake",
        responses: list[Any] | None = None,
        models: list[str] | None = None,
        kind: ProviderKind = "openai-chat",
    ) -> None:
        self.name = name
        self.kind: ProviderKind = kind
        self.responses = list(responses or [])
        self.models = models or []
        self.calls: list[tuple[str, CompletionRequest]] = []
        self.list_models_error: Exception | None = None

    def list_models(self) -> list[ModelDescriptor]:
        if self.list_models_error:
            raise self.list_models_error
        return [ModelDescriptor(self.name, self.kind, m, m.upper()) for m in self.models]

    def complete_json(self, model: str, request: CompletionRequest) -> CompletionResult:
        self.calls.append((model, request))
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        text = response if isinstance(response, str) else json.dumps(response)
        return CompletionResult(text=text, model=model, input_tokens=10, output_tokens=5)


@dataclass
class FakeQueue:
    jobs: list[ClaimedJob] = field(default_factory=list)
    completed: list[tuple[str, list[RenderedOutput]]] = field(default_factory=list)
    reviewed: list[tuple[str, str]] = field(default_factory=list)
    failed: list[tuple[str, str]] = field(default_factory=list)
    events: list[tuple[str, str, str]] = field(default_factory=list)
    models: list[ModelDescriptor] = field(default_factory=list)

    def claim(self, worker_id: str) -> ClaimedJob | None:
        return self.jobs.pop(0) if self.jobs else None

    def complete(self, job: ClaimedJob, outputs: list[RenderedOutput], outputs_bucket: str) -> None:
        self.completed.append((job.id, outputs))

    def needs_review(self, job: ClaimedJob, reason: str) -> None:
        self.reviewed.append((job.id, reason))

    def fail(self, job: ClaimedJob, error: str) -> None:
        self.failed.append((job.id, error))

    def event(
        self, job_id: str, level: str, message: str, data: dict[str, Any] | None = None
    ) -> None:
        self.events.append((job_id, level, message))

    def upsert_models(self, models: list[ModelDescriptor]) -> None:
        self.models = models

    def reap_stale(self, older_than_s: float) -> int:
        return 0
