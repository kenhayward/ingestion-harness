from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

ProviderKind = Literal["anthropic", "openai-chat", "openai-responses"]

#: Model listing (discovery) runs in the worker loop before each claim: a down or unreachable
#: endpoint must fail fast, not wait out the extraction timeout (`timeoutS`) and its retries.
DISCOVERY_TIMEOUT_S = 10.0


@dataclass(frozen=True)
class ModelDescriptor:
    provider: str
    provider_kind: ProviderKind
    model_id: str
    display_name: str | None = None

    @property
    def ref(self) -> str:
        return f"{self.provider}/{self.model_id}"


@dataclass(frozen=True)
class CompletionRequest:
    system: str
    prompt: str
    json_schema: dict[str, Any]
    schema_name: str
    #: Output budget per call. Large documents need room: the Anthropic adapter streams so
    #: budgets this size don't hit request timeouts.
    max_tokens: int = 64000
    #: PNG page images sent alongside the prompt (vision-capable models only).
    images: tuple[bytes, ...] = ()


@dataclass(frozen=True)
class VisionRequest:
    """Free-text completion over one image (used for OCR). No JSON constraint."""

    prompt: str
    image_png: bytes
    max_tokens: int = 8000
    #: None = provider default. Ignored by providers whose models reject sampling params.
    temperature: float | None = None


@dataclass(frozen=True)
class CompletionResult:
    text: str
    model: str
    stop_reason: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    raw: dict[str, Any] = field(default_factory=dict)
    #: Generation stopped at the output token limit, so the text is incomplete.
    truncated: bool = False


class LLMError(Exception):
    """Provider call failed in a way that may succeed on retry (rate limit, 5xx, network)."""


class RefusalError(LLMError):
    """The model declined the request. Not retried within a job — routed to needs_review."""


class LLMProvider(Protocol):
    name: str

    @property
    def kind(self) -> ProviderKind: ...

    def list_models(self) -> list[ModelDescriptor]: ...

    def complete_json(self, model: str, request: CompletionRequest) -> CompletionResult: ...

    def complete_vision(self, model: str, request: VisionRequest) -> CompletionResult: ...


#: Provider kinds whose endpoints serve embeddings (`embed`); Anthropic has none.
EMBEDDING_KINDS: frozenset[str] = frozenset({"openai-chat", "openai-responses"})


class EmbeddingProvider(Protocol):
    """A provider that can embed text (the OpenAI-compatible kinds)."""

    name: str

    def embed(self, model: str, texts: list[str]) -> list[list[float]]: ...
