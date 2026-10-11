from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from ingest_worker.llm.base import (
    CompletionRequest,
    CompletionResult,
    ModelDescriptor,
    ProviderKind,
    VisionRequest,
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
        self.vision_responses: list[str | Exception] = []
        self.vision_calls: list[tuple[str, VisionRequest]] = []
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

    def complete_vision(self, model: str, request: VisionRequest) -> CompletionResult:
        self.vision_calls.append((model, request))
        response = self.vision_responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return CompletionResult(text=response, model=model)


@dataclass
class FakeQueue:
    jobs: list[ClaimedJob] = field(default_factory=list)
    completed: list[tuple[str, list[RenderedOutput]]] = field(default_factory=list)
    reviewed: list[tuple[str, str]] = field(default_factory=list)
    failed: list[tuple[str, str]] = field(default_factory=list)
    events: list[tuple[str, str, str]] = field(default_factory=list)
    #: Same events with their data payloads.
    event_details: list[tuple[str, str, str, dict[str, Any]]] = field(default_factory=list)
    models: list[ModelDescriptor] = field(default_factory=list)
    awaiting: list[tuple[str, list[RenderedOutput], list[str]]] = field(default_factory=list)
    published: list[tuple[str, list[RenderedOutput], str]] = field(default_factory=list)
    edits: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    decisions: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: Templates stored in the database, keyed by (id, version).
    templates: dict[tuple[str, int], dict[str, Any]] = field(default_factory=dict)
    step_runs: list[dict[str, Any]] = field(default_factory=list)
    #: Draft outputs recorded as soon as they were written (job id, outputs).
    drafts: list[tuple[str, list[RenderedOutput]]] = field(default_factory=list)
    #: Simulates an operator cancel: is_cancelled() returns cancel_when() for every job.
    cancel_when: Callable[[], bool] | None = None

    def is_cancelled(self, job: ClaimedJob) -> bool:
        return bool(self.cancel_when and self.cancel_when())

    def claim(self, worker_id: str) -> ClaimedJob | None:
        return self.jobs.pop(0) if self.jobs else None

    def complete(self, job: ClaimedJob, outputs: list[RenderedOutput], outputs_bucket: str) -> None:
        self.completed.append((job.id, outputs))

    def await_review(
        self,
        job: ClaimedJob,
        outputs: list[RenderedOutput],
        outputs_bucket: str,
        reasons: list[str],
    ) -> None:
        self.awaiting.append((job.id, outputs, reasons))

    def record_drafts(self, job: ClaimedJob, outputs: list[RenderedOutput], bucket: str) -> None:
        self.drafts.append((job.id, outputs))

    def record_published(self, job: ClaimedJob, outputs: list[RenderedOutput], bucket: str) -> None:
        self.published.append((job.id, outputs, bucket))

    def review_edits(self, job_id: str) -> list[dict[str, Any]]:
        return self.edits.get(job_id, [])

    def review_decision(self, job_id: str) -> dict[str, Any] | None:
        return self.decisions.get(job_id)

    def record_step_run(self, job_id: str, run: dict[str, Any]) -> None:
        self.step_runs.append({"job_id": job_id, **run})

    def load_template(self, template_id: str, version: int) -> dict[str, Any] | None:
        return self.templates.get((template_id, version))

    def needs_review(self, job: ClaimedJob, reason: str) -> None:
        self.reviewed.append((job.id, reason))

    def fail(self, job: ClaimedJob, error: str) -> None:
        self.failed.append((job.id, error))

    def event(
        self, job_id: str, level: str, message: str, data: dict[str, Any] | None = None
    ) -> None:
        self.events.append((job_id, level, message))
        self.event_details.append((job_id, level, message, data or {}))

    def upsert_models(self, models: list[ModelDescriptor]) -> None:
        self.models = models

    def reap_stale(self, older_than_s: float) -> int:
        return 0
