from __future__ import annotations

import re
from collections.abc import Callable
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


#: Called with the estimated output tokens received so far while a reply streams (progress).
TokenCallback = Callable[[int], None]


class TokenCounter:
    """A streamed reply's characters, its text and any thinking or reasoning, reported as a
    growing token estimate (about four characters a token: tokenizers differ, and thinking is
    not always counted in usage, so it is said as approximate)."""

    def __init__(self, on_tokens: TokenCallback) -> None:
        self._on_tokens = on_tokens
        self._chars = 0

    def add(self, text: str | None) -> None:
        if not text:
            return
        self._chars += len(text)
        self._on_tokens((self._chars + 3) // 4)


class LLMError(Exception):
    """Provider call failed in a way that may succeed on retry (rate limit, 5xx, network)."""


class RefusalError(LLMError):
    """The model declined the request. Not retried within a job — routed to needs_review."""


class ContextExceededError(Exception):
    """The request (prompt, images and the output budget) does not fit the model's context
    window as its server loaded it. Deterministic: a retry repeats it, so callers route it to
    needs_review with what to change (`context_exceeded_reason`)."""


#: How servers say a request is too long for the context window: LM Studio ("Context size has
#: been exceeded"), OpenAI and vLLM ("maximum context length", `context_length_exceeded`),
#: llama.cpp ("exceeds the available context size", `exceed_context_size_error`), Ollama and
#: Anthropic ("prompt is too long", "exceed context limit").
_CONTEXT_EXCEEDED = re.compile(
    r"context[ _-]?(size|length|window|limit)[^.]{0,60}exceed"
    r"|exceed[\w ]{0,60}context"
    r"|maximum context length"
    r"|prompt is too long",
    re.IGNORECASE,
)


def is_context_exceeded(*texts: object) -> bool:
    """Whether an error's message or body says the request did not fit the context window."""
    return any(_CONTEXT_EXCEEDED.search(str(t)) for t in texts if t)


def context_exceeded_reason(where: str, model_ref: str, fix: str, error: Exception) -> str:
    """The needs_review reason for a `ContextExceededError`: where, which model, what to change."""
    return (
        f"{where}: the request does not fit the context window of {model_ref} as loaded on its "
        f"server; {fix} (server said: {error})"
    )


class LLMProvider(Protocol):
    name: str

    @property
    def kind(self) -> ProviderKind: ...

    def list_models(self) -> list[ModelDescriptor]: ...

    def complete_json(
        self, model: str, request: CompletionRequest, on_tokens: TokenCallback | None = None
    ) -> CompletionResult:
        """With `on_tokens`, the reply streams and is counted as it arrives (progress only:
        the result is the same). Without it, providers call as they always have."""
        ...

    def complete_vision(self, model: str, request: VisionRequest) -> CompletionResult: ...


#: Provider kinds whose endpoints serve embeddings (`embed`); Anthropic has none.
EMBEDDING_KINDS: frozenset[str] = frozenset({"openai-chat", "openai-responses"})


class EmbeddingProvider(Protocol):
    """A provider that can embed text (the OpenAI-compatible kinds)."""

    name: str

    def embed(self, model: str, texts: list[str]) -> list[list[float]]: ...
