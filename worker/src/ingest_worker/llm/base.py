from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal, Protocol

ProviderKind = Literal["anthropic", "openai-chat", "openai-responses"]


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
    max_tokens: int = 16000


@dataclass(frozen=True)
class CompletionResult:
    text: str
    model: str
    stop_reason: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    raw: dict[str, Any] = field(default_factory=dict)


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
