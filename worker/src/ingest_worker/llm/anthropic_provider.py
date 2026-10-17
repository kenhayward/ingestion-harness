from __future__ import annotations

import base64
import json
from typing import Any, Literal

import anthropic

from .base import (
    DISCOVERY_TIMEOUT_S,
    CompletionRequest,
    CompletionResult,
    ContextExceededError,
    ConversationRequest,
    LLMError,
    Message,
    ModelDescriptor,
    ModelUnavailableError,
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
)

#: Beta enabling server-side refusal fallbacks (`fallbacks="default"`).
FALLBACK_BETA = "server-side-fallback-2026-07-01"


def _content(prompt: str, images: tuple[bytes, ...]) -> str | list[dict[str, Any]]:
    """Plain string when there are no images; otherwise image blocks first, then the text."""
    if not images:
        return prompt
    blocks: list[dict[str, Any]] = [
        {
            "type": "image",
            "source": {
                "type": "base64",
                "media_type": "image/png",
                "data": base64.b64encode(png).decode("ascii"),
            },
        }
        for png in images
    ]
    return [*blocks, {"type": "text", "text": prompt}]


class AnthropicProvider:
    """Claude via the Messages API with structured outputs (output_config.format)."""

    kind: Literal["anthropic"] = "anthropic"

    def __init__(
        self,
        name: str,
        client: anthropic.Anthropic,
        *,
        effort: str | None = "high",
        server_fallbacks: bool = True,
    ) -> None:
        self.name = name
        self._client = client
        self._effort = effort
        self._server_fallbacks = server_fallbacks

    def list_models(self) -> list[ModelDescriptor]:
        return [
            ModelDescriptor(self.name, "anthropic", m.id, m.display_name)
            for m in self._client.with_options(
                timeout=DISCOVERY_TIMEOUT_S, max_retries=0
            ).models.list()
        ]

    def complete_json(
        self, model: str, request: CompletionRequest, on_tokens: TokenCallback | None = None
    ) -> CompletionResult:
        output_config: dict[str, Any] = {
            "format": {"type": "json_schema", "schema": request.json_schema}
        }
        if self._effort:
            output_config["effort"] = self._effort
        return self._send(
            {
                "model": model,
                "max_tokens": request.max_tokens,
                "system": request.system,
                "messages": [{"role": "user", "content": _content(request.prompt, request.images)}],
                "output_config": output_config,
            },
            on_tokens,
        )

    def complete_vision(self, model: str, request: VisionRequest) -> CompletionResult:
        # request.temperature is deliberately not sent: current Claude models reject it.
        params: dict[str, Any] = {
            "model": model,
            "max_tokens": request.max_tokens,
            "messages": [
                {"role": "user", "content": _content(request.prompt, (request.image_png,))}
            ],
        }
        if self._effort:
            params["output_config"] = {"effort": self._effort}
        return self._send(params)

    def converse(
        self, model: str, request: ConversationRequest, on_tokens: TokenCallback | None = None
    ) -> TurnResult:
        """One turn of a conversation with tools (Workbench drafting). No JSON format: the
        answer arrives as the `submit` tool's arguments, held to its schema by `strict`."""
        params: dict[str, Any] = {
            "model": model,
            "max_tokens": request.max_tokens,
            "system": request.system,
            "messages": [_message(m) for m in request.messages],
            "tools": [_tool(t) for t in request.tools],
            "tool_choice": {"type": "auto"},
        }
        if self._effort:
            params["output_config"] = {"effort": self._effort}
        message = self._final(params, on_tokens)
        calls = tuple(
            ToolCall(b.id, b.name, dict(b.input), json.dumps(b.input))
            for b in message.content
            if b.type == "tool_use"
        )
        return TurnResult(
            text="".join(b.text for b in message.content if b.type == "text"),
            tool_calls=calls,
            model=message.model,
            stop_reason=message.stop_reason,
            input_tokens=message.usage.input_tokens,
            output_tokens=message.usage.output_tokens,
            truncated=message.stop_reason == "max_tokens",
            echo=dump_echo(list(message.content)),
        )

    def _send(
        self, params: dict[str, Any], on_tokens: TokenCallback | None = None
    ) -> CompletionResult:
        message = self._final(params, on_tokens)
        text = next((b.text for b in message.content if b.type == "text"), "")
        return CompletionResult(
            text=text,
            model=message.model,
            stop_reason=message.stop_reason,
            truncated=message.stop_reason == "max_tokens",
            input_tokens=message.usage.input_tokens,
            output_tokens=message.usage.output_tokens,
            raw={"id": message.id},
        )

    def _final(self, params: dict[str, Any], on_tokens: TokenCallback | None) -> Any:
        """The streamed reply, collected with get_final_message(): large output budgets (64K)
        can run long, and the SDK refuses non-streaming requests it estimates exceed ~10
        minutes. With `on_tokens`, the text, thinking and tool-argument deltas are counted on
        the way. A refusal raises."""
        try:
            if self._server_fallbacks:
                stream: Any = self._client.beta.messages.stream(
                    **params, betas=[FALLBACK_BETA], fallbacks="default"
                )
            else:
                stream = self._client.messages.stream(**params)
            with stream as s:
                if on_tokens is not None:
                    counter = TokenCounter(on_tokens)
                    for event in s:
                        if getattr(event, "type", None) == "content_block_delta":
                            delta = event.delta
                            counter.add(getattr(delta, "text", None))
                            counter.add(getattr(delta, "thinking", None))
                            counter.add(getattr(delta, "partial_json", None))
                message: Any = s.get_final_message()
        except anthropic.APIStatusError as exc:
            if is_context_exceeded(exc.message, exc.body):
                raise ContextExceededError(f"anthropic {exc.status_code}: {exc.message}") from exc
            if exc.status_code in (400, 404) and (
                exc.status_code == 404 or is_model_unavailable(exc.message, exc.body)
            ):
                raise ModelUnavailableError(f"anthropic {exc.status_code}: {exc.message}") from exc
            if exc.status_code in (408, 409, 429) or exc.status_code >= 500:
                raise LLMError(f"anthropic {exc.status_code}: {exc.message}") from exc
            raise
        except anthropic.APIConnectionError as exc:
            raise LLMError(f"anthropic connection error: {exc}") from exc

        if message.stop_reason == "refusal":
            details = getattr(message, "stop_details", None)
            category = getattr(details, "category", None)
            raise RefusalError(f"model refused the request (category={category})")
        return message


def _tool(spec: ToolSpec) -> dict[str, Any]:
    tool: dict[str, Any] = {
        "name": spec.name,
        "description": spec.description,
        "input_schema": spec.input_schema,
    }
    if spec.strict:
        tool["strict"] = True
    return tool


def _message(message: Message) -> dict[str, Any]:
    """A conversation message as the Messages API takes it: tool results first in a user turn;
    an assistant turn sent back exactly as it came (thinking blocks must be)."""
    if message.role == "assistant":
        if message.echo is not None:
            return {"role": "assistant", "content": message.echo}
        blocks: list[dict[str, Any]] = (
            [{"type": "text", "text": message.text}] if message.text else []
        )
        blocks += [
            {"type": "tool_use", "id": c.id, "name": c.name, "input": c.input or {}}
            for c in message.tool_calls
        ]
        return {"role": "assistant", "content": blocks}
    if not message.tool_results:
        return {"role": "user", "content": _content(message.text, message.images)}
    content: list[dict[str, Any]] = [
        {
            "type": "tool_result",
            "tool_use_id": r.call_id,
            "content": r.content,
            "is_error": r.is_error,
        }
        for r in message.tool_results
    ]
    if message.text:
        content.append({"type": "text", "text": message.text})
    return {"role": "user", "content": content}
