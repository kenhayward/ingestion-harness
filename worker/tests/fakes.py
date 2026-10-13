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
from ingest_worker.llm.endpoints import Choice, Seed
from ingest_worker.llm.registry import ProviderConfig
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
    #: Timeouts passed to wait_for_work (it returns immediately).
    waits: list[float] = field(default_factory=list)

    def is_cancelled(self, job: ClaimedJob) -> bool:
        return bool(self.cancel_when and self.cancel_when())

    def wait_for_work(self, timeout_s: float) -> None:
        self.waits.append(timeout_s)

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


@dataclass
class FakeConverter:
    """DocumentConverter double: records each .docx it converts and returns `pdf`."""

    pdf: bytes = b"%PDF-converted"
    version: str = "fake-1"
    calls: list[bytes] = field(default_factory=list)
    #: Raised by to_pdf instead of converting (ConversionRejected, ConverterUnavailable).
    error: Exception | None = None

    def to_pdf(self, docx: bytes) -> bytes:
        self.calls.append(docx)
        if self.error is not None:
            raise self.error
        return self.pdf

    def fingerprint(self) -> str:
        return self.version


@dataclass
class _StoredEndpoint:
    cfg: ProviderConfig  # models live in MemoryLlmConfigStore.curated
    source: str = "env"
    edited: bool = False


class MemoryLlmConfigStore:
    """In-memory LlmConfigStore with PgLlmConfigStore's seeding rules: .env seeds, edited rows
    (and rows added in the UI) are left alone. The contract test runs both."""

    def __init__(self, seed: Seed | None = None) -> None:
        self.endpoints: dict[str, _StoredEndpoint] = {}
        #: (provider, model_id) -> (curated, edited)
        self.curated: dict[tuple[str, str], tuple[bool, bool]] = {}
        #: id -> (choice, source, edited)
        self.choices: dict[str, tuple[Choice, str, bool]] = {}
        #: name -> (value, edited)
        self.settings: dict[str, tuple[str, bool]] = {}
        #: (provider, model_id) disabled by an admin: not offered even when curated
        self.disabled: set[tuple[str, str]] = set()
        self._version = 0
        if seed is not None:
            self.seed(seed)

    def _changed(self, before: object) -> None:
        if self._snapshot() != before:
            self._version += 1

    def _snapshot(self) -> object:
        return (
            {n: (e.cfg.model_dump(), e.source, e.edited) for n, e in self.endpoints.items()},
            dict(self.curated),
            dict(self.choices),
            dict(self.settings),
            frozenset(self.disabled),
        )

    def seed(self, seed: Seed) -> None:
        before = self._snapshot()
        names = [e.name for e in seed.endpoints]
        for e in seed.endpoints:
            stored = self.endpoints.get(e.name)
            if stored is None or (stored.source == "env" and not stored.edited):
                self.endpoints[e.name] = _StoredEndpoint(e.model_copy(update={"models": []}))
        removed = [
            n
            for n, e in self.endpoints.items()
            if e.source == "env" and not e.edited and n not in names
        ]
        for n in removed:
            del self.endpoints[n]
        owned = [
            n for n in names if self.endpoints[n].source == "env" and not self.endpoints[n].edited
        ]
        wanted = {(e.name, m) for e in seed.endpoints if e.name in owned for m in e.models}
        for key in wanted:
            curated, edited = self.curated.get(key, (False, False))
            if not edited:
                self.curated[key] = (True, False)
        for key, (curated, edited) in list(self.curated.items()):
            if curated and not edited and key[0] in [*owned, *removed] and key not in wanted:
                self.curated[key] = (False, False)
        ids = [c.id for c in seed.choices]
        for c in seed.choices:
            stored = self.choices.get(c.id)
            if stored is None or (stored[1] == "env" and not stored[2]):
                self.choices[c.id] = (c, "env", False)
        for choice_id, (_, source, edited) in list(self.choices.items()):
            if source == "env" and not edited and choice_id not in ids:
                del self.choices[choice_id]
        for name, value in seed.settings.items():
            if not self.settings.get(name, ("", False))[1]:
                self.settings[name] = (value, False)
        for name, (_, edited) in list(self.settings.items()):
            if not edited and name not in seed.settings:
                del self.settings[name]
        self._changed(before)

    def load(self) -> Seed:
        endpoints = [
            self.endpoints[n].cfg.model_copy(
                update={
                    "optional": True,
                    "models": sorted(
                        m
                        for (p, m), (curated, _) in self.curated.items()
                        if p == n and curated and (p, m) not in self.disabled
                    ),
                }
            )
            for n in sorted(self.endpoints)
        ]
        return Seed(
            endpoints,
            [c for _, (c, _, _) in sorted(self.choices.items())],
            {n: v for n, (v, _) in sorted(self.settings.items())},
        )

    def version(self) -> int:
        return self._version

    # --- what the admin API will do (edits win over .env) ---

    def edit_endpoint(self, name: str, **fields: Any) -> None:
        before = self._snapshot()
        stored = self.endpoints[name]
        stored.cfg = stored.cfg.model_copy(update=fields)
        stored.edited = True
        self._changed(before)

    def edit_choice(self, choice_id: str, ref: str) -> None:
        before = self._snapshot()
        choice, source, _ = self.choices[choice_id]
        self.choices[choice_id] = (
            Choice(choice.id, choice.label, ref, choice.description),
            source,
            True,
        )
        self._changed(before)

    def add_ui_choice(self, choice: Choice) -> None:
        before = self._snapshot()
        self.choices[choice.id] = (choice, "ui", True)
        self._changed(before)

    def set_setting(self, name: str, value: str) -> None:
        before = self._snapshot()
        self.settings[name] = (value, True)
        self._changed(before)

    def disable_model(self, provider: str, model_id: str) -> None:
        before = self._snapshot()
        self.disabled.add((provider, model_id))
        self._changed(before)

    def uncurate(self, provider: str, model_id: str) -> None:
        before = self._snapshot()
        self.curated[(provider, model_id)] = (False, True)
        self._changed(before)

    def add_ui_endpoint(self, cfg: ProviderConfig) -> None:
        before = self._snapshot()
        self.endpoints[cfg.name] = _StoredEndpoint(
            cfg.model_copy(update={"models": []}), source="ui", edited=True
        )
        self._changed(before)
