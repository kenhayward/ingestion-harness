from __future__ import annotations

import base64
import json
import re
from collections.abc import Callable
from typing import Any, Literal, TypeVar

import openai

from .base import (
    DISCOVERY_TIMEOUT_S,
    CompletionRequest,
    CompletionResult,
    ContextExceededError,
    ConversationRequest,
    LLMError,
    ModelDescriptor,
    ModelUnavailableError,
    ProviderKind,
    RefusalError,
    TokenCallback,
    TokenCounter,
    ToolCall,
    ToolSpec,
    TurnResult,
    VisionRequest,
    dump_echo,
    is_context_exceeded,
    is_model_unavailable,
    parse_tool_arguments,
)

_R = TypeVar("_R")

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
    if (
        isinstance(exc, openai.APIStatusError)
        and exc.status_code in (400, 404)
        and is_model_unavailable(exc.message, exc.body)
    ):
        return ModelUnavailableError(f"openai {exc.status_code}: {exc.message}")
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


def _error_text(content: str, is_error: bool) -> str:
    """A tool result as text: OpenAI-compatible APIs have no error flag, so it is said."""
    return f"Error: {content}" if is_error else content


def _call(id: str, name: str, raw: str | None) -> ToolCall:
    raw = raw or ""
    return ToolCall(id, name, parse_tool_arguments(raw), raw)


def _arguments(call: ToolCall) -> str:
    return call.raw or json.dumps(call.input or {})


def _chat_messages(request: ConversationRequest) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = [{"role": "system", "content": request.system}]
    for m in request.messages:
        if m.role == "assistant":
            entry: dict[str, Any] = {"role": "assistant", "content": m.text or None}
            if m.tool_calls:
                entry["tool_calls"] = [
                    {
                        "id": c.id,
                        "type": "function",
                        "function": {"name": c.name, "arguments": _arguments(c)},
                    }
                    for c in m.tool_calls
                ]
            out.append(entry)
            continue
        out += [
            {
                "role": "tool",
                "tool_call_id": r.call_id,
                "content": _error_text(r.content, r.is_error),
            }
            for r in m.tool_results
        ]
        if m.text or not m.tool_results:
            out.append({"role": "user", "content": _chat_content(m.text, m.images)})
    return out


def _responses_messages(request: ConversationRequest) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for m in request.messages:
        if m.role == "assistant":
            if m.echo is not None:
                out += m.echo
                continue
            if m.text:
                out.append({"role": "assistant", "content": m.text})
            out += [
                {
                    "type": "function_call",
                    "call_id": c.id,
                    "name": c.name,
                    "arguments": _arguments(c),
                }
                for c in m.tool_calls
            ]
            continue
        out += [
            {
                "type": "function_call_output",
                "call_id": r.call_id,
                "output": _error_text(r.content, r.is_error),
            }
            for r in m.tool_results
        ]
        if m.text or not m.tool_results:
            content = _responses_input(m.text, m.images)
            out += content if isinstance(content, list) else [{"role": "user", "content": content}]
    return out


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
        stream: Callable[[dict[str, Any], TokenCounter], _R],
        whole: Callable[[dict[str, Any]], _R],
    ) -> _R:
        """A call that streams when counting, else (or once the server refused to stream)
        one whole reply."""
        if on_tokens is None or not self._streams:
            return whole(params)
        try:
            return stream(params, TokenCounter(on_tokens))
        except openai.APIStatusError as exc:
            # A request too long for the context would not fit whole either, and a model the
            # server does not have is not there for a whole reply.
            if (
                is_context_exceeded(exc.message, exc.body)
                or is_model_unavailable(exc.message, exc.body)
                or not isinstance(exc, openai.BadRequestError)
            ):
                wrapped = _wrap_errors(exc)
                if wrapped is exc:
                    raise
                raise wrapped from exc
            result = whole(params)  # the same request whole: a real 400 raises again here
            self._streams = False
            return result

    def _function(self, spec: ToolSpec) -> dict[str, Any]:
        function: dict[str, Any] = {
            "name": spec.name,
            "description": spec.description,
            "parameters": spec.input_schema,
        }
        if spec.strict and self._strict:
            function["strict"] = True
        return function

    def _sampling(self, params: dict[str, Any]) -> None:
        if self._temperature is not None:
            params["temperature"] = self._temperature

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
        self._sampling(params)
        return self._counted(params, on_tokens, self._stream, self._create)

    def converse(
        self, model: str, request: ConversationRequest, on_tokens: TokenCallback | None = None
    ) -> TurnResult:
        """One turn of a conversation with tools (Workbench drafting): functions offered, no
        response_format (the answer arrives as the `submit` function's arguments)."""
        params: dict[str, Any] = {
            "model": model,
            "messages": _chat_messages(request),
            "tools": [{"type": "function", "function": self._function(t)} for t in request.tools],
            "tool_choice": "auto",
        }
        if self._max_tokens_param:
            params[self._max_tokens_param] = request.max_tokens
        self._sampling(params)
        return self._counted(params, on_tokens, self._stream_turn, self._create_turn)

    def _create_turn(self, params: dict[str, Any]) -> TurnResult:
        try:
            resp = self._client.chat.completions.create(**params)
        except Exception as exc:
            raise _wrap_errors(exc) from exc
        choice = resp.choices[0]
        message = choice.message
        if getattr(message, "refusal", None):
            raise RefusalError(f"model refused the request: {message.refusal}")
        calls = tuple(
            _call(c.id, c.function.name, c.function.arguments)
            for c in getattr(message, "tool_calls", None) or []
        )
        return TurnResult(
            text=message.content or "",
            tool_calls=calls,
            model=resp.model,
            stop_reason=choice.finish_reason,
            truncated=choice.finish_reason == "length",
            input_tokens=resp.usage.prompt_tokens if resp.usage else None,
            output_tokens=resp.usage.completion_tokens if resp.usage else None,
        )

    def _stream_turn(self, params: dict[str, Any], counter: TokenCounter) -> TurnResult:
        """The turn streamed: content, reasoning and each tool call's arguments (assembled by
        their index) counted."""
        chunks = self._client.chat.completions.create(
            **params, stream=True, stream_options={"include_usage": True}
        )
        content: list[str] = []
        refusal: list[str] = []
        calls: dict[int, dict[str, Any]] = {}
        finish: str | None = None
        model = ""
        usage: Any = None
        try:
            for chunk in chunks:
                model = model or chunk.model
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
                    for part in getattr(delta, "tool_calls", None) or []:
                        call = calls.setdefault(part.index, {"id": "", "name": "", "args": []})
                        call["id"] = call["id"] or (part.id or "")
                        function = getattr(part, "function", None)
                        if function is not None:
                            call["name"] = call["name"] or (function.name or "")
                            if function.arguments:
                                call["args"].append(function.arguments)
                                counter.add(function.arguments)
                    finish = choice.finish_reason or finish
        except openai.BadRequestError:
            raise
        except Exception as exc:
            raise _wrap_errors(exc) from exc
        if refusal:
            raise RefusalError("model refused the request: " + "".join(refusal))
        return TurnResult(
            text="".join(content),
            tool_calls=tuple(
                _call(c["id"], c["name"], "".join(c["args"])) for _, c in sorted(calls.items())
            ),
            model=model,
            stop_reason=finish,
            truncated=finish == "length",
            input_tokens=usage.prompt_tokens if usage else None,
            output_tokens=usage.completion_tokens if usage else None,
        )

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
        "response.function_call_arguments.delta",
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
        self._sampling(params)
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

    def converse(
        self, model: str, request: ConversationRequest, on_tokens: TokenCallback | None = None
    ) -> TurnResult:
        """One turn of a conversation with tools (Workbench drafting). The reply's output items
        (reasoning, messages, function calls) go back next turn as they came."""
        params: dict[str, Any] = {
            "model": model,
            "instructions": request.system,
            "input": _responses_messages(request),
            "tools": [{"type": "function", **self._function(t)} for t in request.tools],
            "max_output_tokens": request.max_tokens,
        }
        self._sampling(params)
        return self._counted(
            params,
            on_tokens,
            lambda p, counter: self._turn(self._stream_raw(p, counter)),
            lambda p: self._turn(self._create_raw(p)),
        )

    def _turn(self, resp: Any) -> TurnResult:
        result = self._result(resp)
        calls = tuple(
            _call(item.call_id, item.name, item.arguments)
            for item in resp.output or []
            if getattr(item, "type", None) == "function_call"
        )
        return TurnResult(
            text=result.text or "",
            tool_calls=calls,
            model=result.model,
            stop_reason=result.stop_reason,
            truncated=result.truncated,
            input_tokens=result.input_tokens,
            output_tokens=result.output_tokens,
            echo=dump_echo(list(resp.output or [])),
        )

    def _create_raw(self, params: dict[str, Any]) -> Any:
        try:
            return self._client.responses.create(**params)
        except Exception as exc:
            raise _wrap_errors(exc) from exc

    def _create(self, params: dict[str, Any]) -> CompletionResult:
        return self._result(self._create_raw(params))

    def _stream(self, params: dict[str, Any], counter: TokenCounter) -> CompletionResult:
        return self._result(self._stream_raw(params, counter))

    def _stream_raw(self, params: dict[str, Any], counter: TokenCounter) -> Any:
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
        return final

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
