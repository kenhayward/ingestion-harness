from __future__ import annotations

import base64
import hashlib
import json
import math
import re
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import Any

from ingest_worker.bridge.client import BridgeRefused
from ingest_worker.bridge.models import (
    ActingUser,
    BridgeError,
    CreateDeliveriesRequest,
    CreateDeliveriesResult,
    DeliveryRef,
)
from ingest_worker.embeddings import EmbeddingTerm
from ingest_worker.llm.base import (
    CompletionRequest,
    CompletionResult,
    ConversationRequest,
    ModelDescriptor,
    ProviderKind,
    ToolCall,
    TurnResult,
    VisionRequest,
)
from ingest_worker.llm.endpoints import Choice, Seed
from ingest_worker.llm.registry import ProviderConfig
from ingest_worker.ontology import (
    DuplicateSource,
    ParsedOntology,
    Term,
    TermHit,
    trigram_similarity,
)
from ingest_worker.outputs import RenderedOutput
from ingest_worker.publish_targets import (
    DefaultSeed,
    RdfSeed,
    SeedOutcome,
    Target,
    TargetMissing,
    TargetRow,
    rdf_seed_differences,
    seed_differences,
)
from ingest_worker.queue import ClaimedJob
from ingest_worker.storage import MemoryObjectStore


def fake_vector(text: str, dims: int = 16) -> list[float]:
    """Hashed bag of words, L2-normalised: a stand-in embedding for retrieval tests."""
    vector = [0.0] * dims
    for word in re.findall(r"[a-z0-9]+", text.lower()):
        vector[int(hashlib.sha256(word.encode()).hexdigest(), 16) % dims] += 1.0
    norm = math.sqrt(sum(v * v for v in vector)) or 1.0
    return [v / norm for v in vector]


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
        self.embed_calls: list[tuple[str, list[str]]] = []
        #: Token estimates a streamed reply reports, in order, when the caller counts them.
        self.token_stream: list[int] = []

    def list_models(self) -> list[ModelDescriptor]:
        if self.list_models_error:
            raise self.list_models_error
        return [ModelDescriptor(self.name, self.kind, m, m.upper()) for m in self.models]

    def embed(self, model: str, texts: list[str]) -> list[list[float]]:
        """Deterministic vectors: hashed word counts in 16 dimensions (same words, same vector),
        so texts that share words come out close."""
        if self.kind == "anthropic":
            raise AttributeError("anthropic endpoints have no embeddings")
        self.embed_calls.append((model, list(texts)))
        return [fake_vector(t) for t in texts]

    def complete_json(
        self,
        model: str,
        request: CompletionRequest,
        on_tokens: Callable[[int], None] | None = None,
    ) -> CompletionResult:
        self.calls.append((model, request))
        if on_tokens is not None:
            for n in self.token_stream:
                on_tokens(n)
        response = self.responses.pop(0)
        if isinstance(response, Exception):
            raise response
        if isinstance(response, CompletionResult):  # e.g. a truncated reply
            return response
        text = response if isinstance(response, str) else json.dumps(response)
        return CompletionResult(text=text, model=model, input_tokens=10, output_tokens=5)

    def complete_vision(self, model: str, request: VisionRequest) -> CompletionResult:
        self.vision_calls.append((model, request))
        response = self.vision_responses.pop(0)
        if isinstance(response, Exception):
            raise response
        return CompletionResult(text=response, model=model)


#: A scripted conversation turn: a TurnResult, an Exception (raised), a str (a text-only reply)
#: or a list of (tool name, arguments) calls, the arguments a dict or a raw string.
ScriptedTurn = TurnResult | Exception | str | list[tuple[str, dict[str, Any] | str]]


class ToolFakeProvider(FakeProvider):
    """A FakeProvider that can also hold a conversation with tools: `turns` replay in order.
    Plain FakeProvider has no `converse`, so code under test treats it as tool-less."""

    def __init__(self, *args: Any, turns: list[ScriptedTurn] | None = None, **kwargs: Any) -> None:
        super().__init__(*args, **kwargs)
        self.turns: list[ScriptedTurn] = list(turns or [])
        self.converse_calls: list[tuple[str, ConversationRequest]] = []

    def converse(
        self,
        model: str,
        request: ConversationRequest,
        on_tokens: Callable[[int], None] | None = None,
    ) -> TurnResult:
        self.converse_calls.append((model, request))
        if on_tokens is not None:
            for n in self.token_stream:
                on_tokens(n)
        turn = self.turns.pop(0)
        if isinstance(turn, Exception):
            raise turn
        if isinstance(turn, TurnResult):
            return turn
        if isinstance(turn, str):
            return TurnResult(
                text=turn, tool_calls=(), model=model, input_tokens=10, output_tokens=5
            )
        n = len(self.converse_calls)
        calls = tuple(
            ToolCall(
                id=f"call-{n}-{i}",
                name=name,
                input=args if isinstance(args, dict) else None,
                raw=json.dumps(args) if isinstance(args, dict) else args,
            )
            for i, (name, args) in enumerate(turn)
        )
        return TurnResult(text="", tool_calls=calls, model=model, input_tokens=10, output_tokens=5)


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
    #: Published outputs recorded (job id, outputs, the publishing target's id).
    published: list[tuple[str, list[RenderedOutput], str]] = field(default_factory=list)
    #: The delivery id each published record carried (job id, target id, delivery id).
    published_deliveries: list[tuple[str, str, str | None]] = field(default_factory=list)
    #: Jobs handed to the bridge (job id, outputs, [(target id, delivery id)]).
    handed_over: list[tuple[str, list[RenderedOutput], list[tuple[str, str]]]] = field(
        default_factory=list
    )
    #: Who reviewed and who uploaded each job, by job id (acting users).
    reviewers: dict[str, ActingUser] = field(default_factory=dict)
    uploaders: dict[str, ActingUser] = field(default_factory=dict)
    edits: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    decisions: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: Templates stored in the database, keyed by (id, version).
    templates: dict[tuple[str, int], dict[str, Any]] = field(default_factory=dict)
    step_runs: list[dict[str, Any]] = field(default_factory=list)
    #: Draft outputs recorded as soon as they were written (job id, outputs).
    drafts: list[tuple[str, list[RenderedOutput]]] = field(default_factory=list)
    #: `suggest` jobs queued (project, params); suggest_removed: the ids each one replaced.
    suggested: list[tuple[str, dict[str, Any]]] = field(default_factory=list)
    suggest_removed: list[str] = field(default_factory=list)
    suggest_error: Exception | None = None
    #: Simulates an operator cancel: is_cancelled() returns cancel_when() for every job.
    cancel_when: Callable[[], bool] | None = None
    #: Timeouts passed to wait_for_work (it returns immediately).
    waits: list[float] = field(default_factory=list)
    #: Like `queue_control.paused`: claim() hands out nothing while set.
    paused: bool = False

    def is_cancelled(self, job: ClaimedJob) -> bool:
        return bool(self.cancel_when and self.cancel_when())

    def wait_for_work(self, timeout_s: float) -> None:
        self.waits.append(timeout_s)

    def claim(self, worker_id: str) -> ClaimedJob | None:
        return self.jobs.pop(0) if self.jobs and not self.paused else None

    def complete(self, job: ClaimedJob, outputs: list[RenderedOutput], outputs_bucket: str) -> None:
        self.completed.append((job.id, outputs))

    def delivering(
        self,
        job: ClaimedJob,
        outputs: list[RenderedOutput],
        outputs_bucket: str,
        deliveries: list[tuple[str, str]],
    ) -> None:
        self.handed_over.append((job.id, outputs, deliveries))

    @property
    def finished(self) -> list[str]:
        """Jobs whose run ended well: completed, or handed to the bridge to finish."""
        return [j for j, _ in self.completed] + [j for j, _, _ in self.handed_over]

    def reviewer(self, job_id: str) -> ActingUser | None:
        return self.reviewers.get(job_id)

    def uploader(self, job_id: str) -> ActingUser | None:
        return self.uploaders.get(job_id)

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

    def record_published(
        self,
        job: ClaimedJob,
        outputs: list[RenderedOutput],
        target: Target,
        delivery_id: str | None,
    ) -> None:
        self.published.append((job.id, outputs, target.id))
        self.published_deliveries.append((job.id, target.id, delivery_id))

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

    def queue_suggest(self, project_id: str, params: dict[str, Any]) -> tuple[str, list[str]]:
        if self.suggest_error is not None:
            raise self.suggest_error
        self.suggested.append((project_id, params))
        return f"suggest-{len(self.suggested)}", list(self.suggest_removed)


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
        #: (provider, model_id) -> an admin's output limit (Administration > Models)
        self.limits: dict[tuple[str, str], int] = {}
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
            dict(self.limits),
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
                        offered := [
                            m
                            for (p, m), (curated, _) in self.curated.items()
                            if p == n and curated and (p, m) not in self.disabled
                        ]
                    ),
                    "max_output_tokens": {
                        m: self.limits[(n, m)] for m in offered if (n, m) in self.limits
                    },
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

    def set_output_limit(self, provider: str, model_id: str, limit: int | None) -> None:
        before = self._snapshot()
        if limit is None:
            self.limits.pop((provider, model_id), None)
        else:
            self.limits[(provider, model_id)] = limit
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


@dataclass
class MemoryOntologyStore:
    """OntologyStore over dicts: what the ontology job wrote, for assertions."""

    status: dict[tuple[str, int], str] = field(default_factory=dict)
    errors: dict[tuple[str, int], str] = field(default_factory=dict)
    saved: dict[tuple[str, int], ParsedOntology] = field(default_factory=dict)
    #: Ready library versions by ontology or version IRI.
    library: dict[str, tuple[str, int]] = field(default_factory=dict)
    imports_of: dict[tuple[str, int], list[dict[str, Any]]] = field(default_factory=dict)
    sources: dict[tuple[str, int], dict[str, Any]] = field(default_factory=dict)
    created: dict[str, dict[str, Any]] = field(default_factory=dict)
    #: Set to make set_source report that another version has the same bytes.
    duplicate_of: int | None = None
    #: Ontologies that may only go to local models.
    local_only_ids: set[str] = field(default_factory=set)
    #: (id, version, model) -> (kind, iri) -> (text_sha256, vector)
    embeddings: dict[tuple[str, int, str], dict[tuple[str, str], tuple[str, list[float]]]] = field(
        default_factory=dict
    )

    def local_only(self, ontology_id: str) -> bool:
        return ontology_id in self.local_only_ids

    def local_only_sources(self, versions: list[tuple[str, int]]) -> list[str]:
        ids = {v[0] for v in versions}
        for version in versions:
            parsed = self.saved.get(version)
            ids |= {
                t.defined_in.split("@")[0] for t in (parsed.terms if parsed else []) if t.defined_in
            }
        return sorted(i for i in ids if i in self.local_only_ids)

    def embedding_terms(self, ontology_id: str, version: int) -> list[EmbeddingTerm]:
        parsed = self.saved.get((ontology_id, version))
        terms = [t for t in (parsed.terms if parsed else []) if t.kind != "shape"]
        labels = {t.iri: t.label for t in terms}
        return [
            EmbeddingTerm(
                t.kind, t.iri, t.label, list(t.alt_labels), t.definition,
                [labels.get(p, p) for p in t.parents],
            )
            for t in terms
        ]  # fmt: skip

    def existing_embeddings(
        self, ontology_id: str, version: int, model_ref: str
    ) -> dict[tuple[str, str], str]:
        rows = self.embeddings.get((ontology_id, version, model_ref), {})
        return {key: sha for key, (sha, _) in rows.items()}

    def store_embeddings(
        self,
        ontology_id: str,
        version: int,
        model_ref: str,
        rows: list[tuple[str, str, str, list[float]]],
    ) -> None:
        stored = self.embeddings.setdefault((ontology_id, version, model_ref), {})
        for kind, iri, sha, vector in rows:
            stored[(kind, iri)] = (sha, vector)

    def _terms(self, versions: list[tuple[str, int]], kinds: list[str]) -> list[Term]:
        out: list[Term] = []
        for version in versions:
            parsed = self.saved.get(version)
            out += [t for t in (parsed.terms if parsed else []) if t.kind in kinds]
        return out

    def lexical(
        self, versions: list[tuple[str, int]], query: str, kinds: list[str], limit: int
    ) -> list[Term]:
        """Word overlap: label and synonym words count double, definition words once."""
        words = set(re.findall(r"[a-z0-9]+", query.lower()))

        def score(t: Term) -> float:
            names = set(re.findall(r"[a-z0-9]+", " ".join([t.label, *t.alt_labels]).lower()))
            defined = set(re.findall(r"[a-z0-9]+", t.definition.lower()))
            exact = 1.0 if t.label.lower() in query.lower() else 0.0  # the label, said whole
            return (
                exact
                + 2 * len(words & names) / max(1, len(names))
                + 0.5 * len(words & defined) / max(1, len(defined))
            )

        ranked = sorted(
            ((score(t), t) for t in self._terms(versions, kinds)),
            key=lambda st: (-st[0], st[1].label),
        )
        return [t for s, t in ranked if s > 0][:limit]

    def semantic(
        self,
        versions: list[tuple[str, int]],
        model_ref: str,
        vector: list[float],
        kinds: list[str],
        limit: int,
    ) -> list[Term]:
        def cosine(a: list[float], b: list[float]) -> float:
            dot = sum(x * y for x, y in zip(a, b, strict=True))
            norm = math.sqrt(sum(x * x for x in a)) * math.sqrt(sum(y * y for y in b))
            return dot / norm if norm else 0.0

        scored = []
        for version in versions:
            stored = self.embeddings.get((*version, model_ref), {})
            for t in self._terms([version], kinds):
                if (t.kind, t.iri) in stored:
                    scored.append((cosine(vector, stored[(t.kind, t.iri)][1]), t))
        scored.sort(key=lambda st: (-st[0], st[1].label))
        return [t for _, t in scored[:limit]]

    def lexical_best(
        self, versions: list[tuple[str, int]], text: str, kinds: list[str], min_similarity: float
    ) -> list[TermHit]:
        hits: list[TermHit] = []
        for version in versions:
            scored = [
                (max(trigram_similarity(n, text) for n in [t.label, *t.alt_labels]), t)
                for t in self._terms([version], kinds)
            ]
            scored = [(s, t) for s, t in scored if s >= min_similarity]
            if scored:
                s, t = sorted(scored, key=lambda st: (-st[0], st[1].label, st[1].iri))[0]
                hits.append(TermHit(version[0], version[1], t, s))
        return sorted(hits, key=lambda h: (-h.similarity, h.ontology_id, h.version))

    def semantic_best(
        self,
        versions: list[tuple[str, int]],
        model_ref: str,
        vectors: list[list[float]],
        kinds: list[list[str]],
        min_similarity: float,
    ) -> list[list[TermHit]]:
        return [
            self._semantic_best_one(versions, model_ref, v, k, min_similarity) if v else []
            for v, k in zip(vectors, kinds, strict=True)
        ]

    def _semantic_best_one(
        self,
        versions: list[tuple[str, int]],
        model_ref: str,
        vector: list[float],
        kinds: list[str],
        min_similarity: float,
    ) -> list[TermHit]:
        hits: list[TermHit] = []
        for version in versions:
            best = self.semantic([version], model_ref, vector, kinds, 1)
            if not best:
                continue
            stored = self.embeddings[(*version, model_ref)][(best[0].kind, best[0].iri)][1]
            dot = sum(x * y for x, y in zip(vector, stored, strict=True))
            norm = math.sqrt(sum(x * x for x in vector)) * math.sqrt(sum(y * y for y in stored))
            similarity = dot / norm if norm else 0.0
            if similarity >= min_similarity:
                hits.append(TermHit(version[0], version[1], best[0], similarity))
        return sorted(hits, key=lambda h: (-h.similarity, h.ontology_id, h.version))

    def has_embeddings(self, versions: list[tuple[str, int]], model_ref: str) -> bool:
        return any(self.embeddings.get((*v, model_ref)) for v in versions)

    def term(self, versions: list[tuple[str, int]], iri: str) -> Term | None:
        for version in versions:
            parsed = self.saved.get(version)
            for term in parsed.terms if parsed else []:
                if term.iri == iri:
                    return term
        return None

    def concept_by_label(
        self, versions: list[tuple[str, int]], scheme: str, label: str
    ) -> str | None:
        wanted = label.strip().lower()
        for version in versions:
            parsed = self.saved.get(version)
            for term in parsed.terms if parsed else []:
                names = [term.label, *term.alt_labels]
                if (
                    term.kind == "concept"
                    and term.scheme == scheme
                    and any(n.strip().lower() == wanted for n in names)
                ):
                    return term.iri
        return None

    def set_source(
        self,
        ontology_id: str,
        version: int,
        *,
        file_name: str,
        media_type: str,
        sha256: str,
        size: int,
    ) -> None:
        if self.duplicate_of is not None:
            raise DuplicateSource(self.duplicate_of)
        self.sources[(ontology_id, version)] = {
            "file_name": file_name,
            "media_type": media_type,
            "sha256": sha256,
            "size": size,
        }

    def find_ready(self, iri: str) -> tuple[str, int] | None:
        return self.library.get(iri)

    def version_imports(self, ontology_id: str, version: int) -> list[dict[str, Any]]:
        return self.imports_of.get((ontology_id, version), [])

    def create_imported(
        self,
        *,
        iri: str,
        title: str | None,
        file_name: str,
        media_type: str,
        sha256: str,
        size: int,
        source_url: str,
        parsed: ParsedOntology,
        root_id: str,
        before_commit: Callable[[str, int], None],
    ) -> tuple[str, int]:
        oid = f"import-{len(self.created) + 1}"
        before_commit(oid, 1)
        self.created[oid] = {"iri": iri, "title": title, "root_id": root_id, "parsed": parsed}
        self.library[iri] = (oid, 1)
        self.imports_of[(oid, 1)] = parsed.import_entries
        return oid, 1

    def start(self, ontology_id: str, version: int) -> bool:
        if self.status.get((ontology_id, version), "queued") not in ("queued", "parsing"):
            return False
        self.status[(ontology_id, version)] = "parsing"
        return True

    def ready(self, ontology_id: str, version: int) -> bool:
        return self.status.get((ontology_id, version)) == "ready"

    def save(self, ontology_id: str, version: int, parsed: ParsedOntology) -> None:
        self.saved[(ontology_id, version)] = parsed
        self.status[(ontology_id, version)] = "ready"
        # Like Postgres: the version's terms are replaced and their embeddings cascade with them.
        for key in [k for k in self.embeddings if k[:2] == (ontology_id, version)]:
            del self.embeddings[key]

    def fail(self, ontology_id: str, version: int, error: str) -> None:
        if self.status.get((ontology_id, version)) == "ready":
            return  # like Postgres: a ready version never fails
        self.status[(ontology_id, version)] = "failed"
        self.errors[(ontology_id, version)] = error


@dataclass
class MemoryLinkedDataSettings:
    """LinkedDataSettings with a fixed effective base (None: RDF is skipped)."""

    base: str | None

    def effective_base(self) -> str | None:
        return self.base


@dataclass
class FakeGraphStore:
    """GraphStore that records every request (`(method, graph, body, content type)`) and holds
    the graphs; `fail` (an exception) is raised by the next requests instead."""

    graphs: dict[str, bytes] = field(default_factory=dict)
    requests: list[tuple[str, str, bytes | None, str | None]] = field(default_factory=list)
    fail: Exception | None = None

    def put(self, graph_iri: str, body: bytes, content_type: str) -> None:
        if self.fail is not None:
            raise self.fail
        self.requests.append(("PUT", graph_iri, body, content_type))
        self.graphs[graph_iri] = body

    def delete(self, graph_iri: str) -> bool:
        if self.fail is not None:
            raise self.fail
        self.requests.append(("DELETE", graph_iri, None, None))
        return self.graphs.pop(graph_iri, None) is not None


class MemoryPublishTargetStore:
    """In-memory PublishTargetStore with PgPublishTargetStore's seeding rule: the default row is
    written from .env once (while `seeded_at` is None), then only compared."""

    def __init__(self, rows: list[TargetRow] | None = None) -> None:
        self.rows = list(rows or [])
        self._version = 0

    def load(self) -> list[TargetRow]:
        return list(self.rows)

    def version(self) -> int:
        return self._version

    def set_rows(self, rows: list[TargetRow]) -> None:
        self.rows = list(rows)
        self._version += 1

    def seed_rdf(self, seed: RdfSeed) -> SeedOutcome:
        current = next((r for r in self.rows if r.id == "rdf-default"), None)
        if current is not None:
            return "differs" if rdf_seed_differences(current, seed) else "kept"
        self.rows.append(
            TargetRow(
                id="rdf-default",
                label="Triple store",
                kind="rdf",
                bucket=seed.dataset,
                prefix="",
                endpoint=seed.endpoint,
                region=None,
                access_key_id=seed.user,
                secret_key_enc=None,
                access_key_env=None,
                secret_key_env=None,
                path_style=False,
                sse="none",
                kms_key_id=None,
                storage_class=None,
                seeded_at=datetime.now(UTC),
            )
        )
        self._version += 1
        return "seeded"

    def seed_default(self, seed: DefaultSeed) -> SeedOutcome:
        i = next(n for n, r in enumerate(self.rows) if r.id == "default")
        current = self.rows[i]
        if current.seeded_at is not None:
            return "differs" if seed_differences(current, seed) else "kept"
        self.rows[i] = replace(
            current,
            kind=seed.kind,
            bucket=seed.bucket,
            prefix=seed.prefix,
            endpoint=seed.endpoint,
            region=seed.region,
            access_key_id=None,
            secret_key_enc=None,
            access_key_env=seed.access_key_env,
            secret_key_env=seed.secret_key_env,
            path_style=seed.force_path_style,
            seeded_at=datetime.now(UTC),
        )
        self._version += 1
        return "seeded"


class FakeTargets:
    """Stands in for LiveTargets: a fixed map of target id to Target (`gets`: the ids asked for),
    and the triple store target when there is one."""

    def __init__(self, targets: dict[str, Target], rdf: Target | None = None) -> None:
        self.targets = targets
        self.gets: list[str] = []
        self.triple_store = rdf

    def rdf(self) -> Target | None:
        return self.triple_store

    def refresh(self) -> bool:
        return False

    def get(self, target_id: str) -> Target:
        self.gets.append(target_id)
        try:
            return self.targets[target_id]
        except KeyError:
            raise TargetMissing(target_id) from None


class FakeBridge:
    """BridgeClient over a dict of objects keyed (bucket, key), or, for a target in `stores`, over
    that target's own MemoryObjectStore (separate S3 endpoints). A delivery to a target in
    `targets` (id -> (bucket, prefix)) writes the package's files at prefix + name, as the S3
    sink does. A delivery to a target in `rdf` (a triple store) loads the package's graph into
    `graphs` (graph name -> Turtle), and deleting an object there drops the graph named by its key.
    `requests` records every delivery request; `refusals` are raised, in order, by the next calls
    (a BridgeError becomes BridgeRefused; an exception is raised as it is)."""

    def __init__(
        self,
        targets: dict[str, tuple[str, str]] | None = None,
        stores: dict[str, MemoryObjectStore] | None = None,
        rdf: set[str] | None = None,
    ) -> None:
        self.targets = dict(targets or {})
        self.stores = dict(stores or {})
        self.rdf = set(rdf or ())
        self.graphs: dict[str, str] = {}
        self.objects: dict[tuple[str, str], tuple[bytes, str]] = {}
        self.requests: list[CreateDeliveriesRequest] = []
        self.puts: list[tuple[str, str, str]] = []
        self.deletes: list[tuple[str, list[tuple[str, str]]]] = []
        self.refusals: list[BridgeError | Exception] = []
        self._ids = 0

    def _next_refusal(self) -> None:
        if self.refusals:
            refusal = self.refusals.pop(0)
            if isinstance(refusal, BridgeError):
                raise BridgeRefused(refusal)
            raise refusal

    def _id(self) -> str:
        self._ids += 1
        return f"00000000-0000-4000-8000-{self._ids:012d}"

    def deliver(self, request: CreateDeliveriesRequest) -> CreateDeliveriesResult:
        self._next_refusal()
        self.requests.append(request)
        for target_id in request.targets:
            if target_id in self.rdf:
                if request.package.rdf is not None:
                    self.graphs[request.package.rdf.graph_name] = request.package.rdf.turtle
                continue
            bucket, prefix = self.targets.get(target_id, ("", ""))
            for f in request.package.files:
                body = base64.b64decode(f.content)
                self._write(target_id, bucket, prefix + f.name, body, f.content_type)
        return CreateDeliveriesResult(
            package_id=self._id(),
            deliveries=[DeliveryRef(target_id=t, delivery_id=self._id()) for t in request.targets],
        )

    def _write(self, target_id: str, bucket: str, key: str, body: bytes, ctype: str) -> None:
        if target_id in self.stores:
            self.stores[target_id].put(bucket, key, body, ctype)
        else:
            self.objects[(bucket, key)] = (body, ctype)

    def get(self, bucket: str, key: str) -> bytes:
        """The bytes of a delivered object (KeyError when there is none)."""
        return self.objects[(bucket, key)][0]

    def read_object(self, target_id: str, bucket: str, key: str) -> bytes | None:
        self._next_refusal()
        if target_id in self.stores:
            return self.stores[target_id].get_optional(bucket, key)
        found = self.objects.get((bucket, key))
        return found[0] if found else None

    def put_object(
        self, target_id: str, bucket: str, key: str, body: bytes, content_type: str
    ) -> None:
        self._next_refusal()
        self.puts.append((target_id, bucket, key))
        self._write(target_id, bucket, key, body, content_type)

    def delete_objects(self, target_id: str, objects: list[tuple[str, str]]) -> int:
        self._next_refusal()
        self.deletes.append((target_id, list(objects)))
        for bucket, key in objects:
            if target_id in self.rdf:
                self.graphs.pop(key, None)
            elif target_id in self.stores:
                self.stores[target_id].delete(bucket, key)
            else:
                self.objects.pop((bucket, key), None)
        return len(objects)


class BucketView:
    """One bucket of a FakeBridge's objects, read like a MemoryObjectStore (`objects`, `get`)."""

    def __init__(self, bridge: FakeBridge, bucket: str) -> None:
        self.bridge = bridge
        self.bucket = bucket

    @property
    def objects(self) -> dict[tuple[str, str], tuple[bytes, str]]:
        return {k: v for k, v in self.bridge.objects.items() if k[0] == self.bucket}

    def get(self, bucket: str, key: str) -> bytes:
        return self.bridge.get(bucket, key)
