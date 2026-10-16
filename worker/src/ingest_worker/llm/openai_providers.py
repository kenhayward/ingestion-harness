from __future__ import annotations

import base64
import re
from collections.abc import Callable
from typing import Any, Literal

import openai

from .base import (
    DISCOVERY_TIMEOUT_S,
    CompletionRequest,
    CompletionResult,
    ContextExceededError,
    LLMError,
    ModelDescriptor,
    ProviderKind,
    RefusalError,
    TokenCallback,
    TokenCounter,
    VisionRequest,
    is_context_exceeded,
)

#: How to ask an OpenAI-compatible server for JSON. Many local servers lack json_schema.
ResponseFormat = Literal["json_schema", "json_object", "none"]


def _data_url(png: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def _chat_content(prompt: str, images: tuple[bytes, ...]) -> str | list[dict[str, Any]]:
    if not images:
        return prompt
    return [
        {"type": "text", "text": prompt},
        *({"type": "image_url", "image_url": {"url": _data_url(png)}} for png in images),
    ]


def _responses_input(prompt: str, images: tuple[bytes, ...]) -> str | list[dict[str, Any]]:
    if not images:
        return prompt
    content = [
        {"type": "input_text", "text": prompt},
        *({"type": "input_image", "image_url": _data_url(png)} for png in images),
    ]
    return [{"role": "user", "content": content}]


def _wrap_errors(exc: Exception) -> Exception:
    if isinstance(exc, openai.APIStatusError) and is_context_exceeded(exc.message, exc.body):
        return ContextExceededError(f"openai {exc.status_code}: {_server_message(exc)}")
    if isinstance(exc, openai.APIStatusError) and (
        exc.status_code in (408, 409, 429) or exc.status_code >= 500
    ):
        return LLMError(f"openai {exc.status_code}: {exc.message}")
    if isinstance(exc, openai.APIConnectionError):
        return LLMError(f"openai connection error: {exc}")
    return exc


def _server_message(exc: openai.APIStatusError) -> str:
    """The part of a context error that says why (LM Studio nests it in a JSON string)."""
    for text in (exc.message, str(exc.body)):
        match = re.search(r'"message"\s*:\s*"([^"]+)"', text)
        if match and is_context_exceeded(match.group(1)):
            return match.group(1)
    return exc.message


class _OpenAIBase:
    kind: ProviderKind

    def __init__(
        self,
        name: str,
        client: openai.OpenAI,
        *,
        model_filter: str | None = None,
        strict: bool = True,
        response_format: ResponseFormat = "json_schema",
        max_tokens_param: str | None = None,
        temperature: float | None = None,
    ) -> None:
        self.name = name
        self._client = client
        self._model_filter = re.compile(model_filter) if model_filter else None
        self._strict = strict
        self._response_format = response_format
        self._max_tokens_param = max_tokens_param
        #: Extraction temperature (None = server default). 0 makes local models deterministic.
        self._temperature = temperature
        #: False once the server refused a streamed request that it then answered whole: some
        #: local servers cannot stream with a JSON schema. Progress then has no token count.
        self._streams = True

    def _counted(
        self,
        params: dict[str, Any],
        on_tokens: TokenCallback | None,
        stream: Callable[[dict[str, Any], TokenCounter], CompletionResult],
        whole: Callable[[dict[str, Any]], CompletionResult],
    ) -> CompletionResult:
        """A call that streams when counting, else (or once the server refused to stream)
        one whole reply."""
        if on_tokens is None or not self._streams:
            return whole(params)
        try:
            return stream(params, TokenCounter(on_tokens))
        except openai.APIStatusError as exc:
            # A request too long for the context would not fit whole either.
            if is_context_exceeded(exc.message, exc.body) or not isinstance(
                exc, openai.BadRequestError
            ):
                wrapped = _wrap_errors(exc)
                if wrapped is exc:
                    raise
                raise wrapped from exc
            result = whole(params)  # the same request whole: a real 400 raises again here
            self._streams = False
            return result

    def embed(self, model: str, texts: list[str]) -> list[list[float]]:
        """Embeddings in input order (`/v1/embeddings`; LM Studio, vLLM and OpenAI serve it)."""
        if not texts:
            return []
        try:
            response = self._client.embeddings.create(model=model, input=texts)
        except Exception as exc:
            raise _wrap_errors(exc) from exc
        ordered = sorted(response.data, key=lambda d: d.index)
        return [[float(x) for x in d.embedding] for d in ordered]

    def list_models(self) -> list[ModelDescriptor]:
        return [
            ModelDescriptor(self.name, self.kind, m.id, None)
            for m in self._client.with_options(
                timeout=DISCOVERY_TIMEOUT_S, max_retries=0
            ).models.list()
            if not self._model_filter or self._model_filter.search(m.id)
        ]


class OpenAIChatProvider(_OpenAIBase):
    """Chat Completions API — OpenAI or any OpenAI-compatible server (vLLM, Ollama, ...)."""

    kind: Literal["openai-chat"] = "openai-chat"

    def complete_json(
        self, model: str, request: CompletionRequest, on_tokens: TokenCallback | None = None
    ) -> CompletionResult:
        params: dict[str, Any] = {
            "model": model,
            "messages": [
                {"role": "system", "content": request.system},
                {"role": "user", "content": _chat_content(request.prompt, request.images)},
            ],
        }
        if self._response_format == "json_schema":
            params["response_format"] = {
                "type": "json_schema",
                "json_schema": {
                    "name": request.schema_name,
                    "schema": request.json_schema,
                    "strict": self._strict,
                },
            }
        elif self._response_format == "json_object":
            params["response_format"] = {"type": "json_object"}
        if self._max_tokens_param:
            params[self._max_tokens_param] = request.max_tokens
        if self._temperature is not None:
            params["temperature"] = self._temperature

        return self._counted(params, on_tokens, self._stream, self._create)

    def complete_vision(self, model: str, request: VisionRequest) -> CompletionResult:
        params: dict[str, Any] = {
            "model": model,
            "messages": [
                {
                    "role": "user",
                    "content": _chat_content(request.prompt, (request.image_png,)),
                }
            ],
        }
        if request.temperature is not None:
            params["temperature"] = request.temperature
        if self._max_tokens_param:
            params[self._max_tokens_param] = request.max_tokens
        return self._create(params)

    def _create(self, params: dict[str, Any]) -> CompletionResult:
        try:
            resp = self._client.chat.completions.create(**params)
        except Exception as exc:
            raise _wrap_errors(exc) from exc

        choice = resp.choices[0]
        if getattr(choice.message, "refusal", None):
            raise RefusalError(f"model refused the request: {choice.message.refusal}")
        return CompletionResult(
            text=choice.message.content or "",
            model=resp.model,
            stop_reason=choice.finish_reason,
            truncated=choice.finish_reason == "length",
            input_tokens=resp.usage.prompt_tokens if resp.usage else None,
            output_tokens=resp.usage.completion_tokens if resp.usage else None,
            raw={"id": resp.id},
        )

    def _stream(self, params: dict[str, Any], counter: TokenCounter) -> CompletionResult:
        """The same call streamed: the reply assembled from its chunks, the content and any
        reasoning (`reasoning_content` or `reasoning`, as local servers name it) counted."""
        chunks = self._client.chat.completions.create(
            **params, stream=True, stream_options={"include_usage": True}
        )
        content: list[str] = []
        refusal: list[str] = []
        finish: str | None = None
        model = rid = ""
        usage: Any = None
        try:
            for chunk in chunks:
                model, rid = model or chunk.model, rid or chunk.id
                usage = chunk.usage or usage
                for choice in chunk.choices or []:
                    delta = choice.delta
                    if delta.content:
                        content.append(delta.content)
                    counter.add(delta.content)
                    counter.add(getattr(delta, "reasoning_content", None))
                    counter.add(getattr(delta, "reasoning", None))
                    if getattr(delta, "refusal", None):
                        refusal.append(delta.refusal)
                    finish = choice.finish_reason or finish
        except openai.BadRequestError:
            raise
        except Exception as exc:
            raise _wrap_errors(exc) from exc
        if refusal:
            raise RefusalError("model refused the request: " + "".join(refusal))
        return CompletionResult(
            text="".join(content),
            model=model,
            stop_reason=finish,
            truncated=finish == "length",
            input_tokens=usage.prompt_tokens if usage else None,
            output_tokens=usage.completion_tokens if usage else None,
            raw={"id": rid},
        )


#: Responses API stream events whose `delta` is reply text, reasoning or a refusal (counted).
_COUNTED_DELTAS = frozenset(
    {
        "response.output_text.delta",
        "response.reasoning_text.delta",
        "response.reasoning_summary_text.delta",
        "response.refusal.delta",
    }
)


class OpenAIResponsesProvider(_OpenAIBase):
    """Responses API — OpenAI, or compatible servers that implement /v1/responses."""

    kind: Literal["openai-responses"] = "openai-responses"

    def complete_json(
        self, model: str, request: CompletionRequest, on_tokens: TokenCallback | None = None
    ) -> CompletionResult:
        params: dict[str, Any] = {
            "model": model,
            "instructions": request.system,
            "input": _responses_input(request.prompt, request.images),
            "max_output_tokens": request.max_tokens,
        }
        if self._response_format == "json_schema":
            params["text"] = {
                "format": {
                    "type": "json_schema",
                    "name": request.schema_name,
                    "schema": request.json_schema,
                    "strict": self._strict,
                }
            }
        elif self._response_format == "json_object":
            params["text"] = {"format": {"type": "json_object"}}
        if self._temperature is not None:
            params["temperature"] = self._temperature

        return self._counted(params, on_tokens, self._stream, self._create)

    def complete_vision(self, model: str, request: VisionRequest) -> CompletionResult:
        params: dict[str, Any] = {
            "model": model,
            "input": _responses_input(request.prompt, (request.image_png,)),
            "max_output_tokens": request.max_tokens,
        }
        if request.temperature is not None:
            params["temperature"] = request.temperature
        return self._create(params)

    def _create(self, params: dict[str, Any]) -> CompletionResult:
        try:
            resp = self._client.responses.create(**params)
        except Exception as exc:
            raise _wrap_errors(exc) from exc
        return self._result(resp)

    def _stream(self, params: dict[str, Any], counter: TokenCounter) -> CompletionResult:
        """The same call streamed: text and reasoning deltas counted, the result read from the
        final `response.completed` or `response.incomplete` event's response."""
        events = self._client.responses.create(**params, stream=True)
        final: Any = None
        try:
            for event in events:
                kind = getattr(event, "type", "")
                if kind in _COUNTED_DELTAS:
                    counter.add(event.delta)
                elif kind in ("response.completed", "response.incomplete"):
                    final = event.response
                elif kind in ("response.failed", "error"):
                    raise LLMError(f"openai stream failed: {kind}")
        except (openai.BadRequestError, LLMError):
            raise
        except Exception as exc:
            raise _wrap_errors(exc) from exc
        if final is None:
            raise LLMError("openai stream ended without a final response")
        return self._result(final)

    def _result(self, resp: Any) -> CompletionResult:
        for item in resp.output or []:
            for part in getattr(item, "content", None) or []:
                if getattr(part, "type", None) == "refusal":
                    raise RefusalError(f"model refused the request: {part.refusal}")
        return CompletionResult(
            text=resp.output_text,
            model=resp.model,
            stop_reason=resp.status,
            truncated=resp.status == "incomplete"
            and getattr(getattr(resp, "incomplete_details", None), "reason", None)
            == "max_output_tokens",
            input_tokens=resp.usage.input_tokens if resp.usage else None,
            output_tokens=resp.usage.output_tokens if resp.usage else None,
            raw={"id": resp.id},
        )
