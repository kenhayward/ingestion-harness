from __future__ import annotations

import base64
from typing import Any, Literal

import anthropic

from .base import (
    CompletionRequest,
    CompletionResult,
    LLMError,
    ModelDescriptor,
    RefusalError,
    VisionRequest,
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
            for m in self._client.models.list()
        ]

    def complete_json(self, model: str, request: CompletionRequest) -> CompletionResult:
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
            }
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

    def _send(self, params: dict[str, Any]) -> CompletionResult:
        try:
            if self._server_fallbacks:
                message: Any = self._client.beta.messages.create(
                    **params, betas=[FALLBACK_BETA], fallbacks="default"
                )
            else:
                message = self._client.messages.create(**params)
        except anthropic.APIStatusError as exc:
            if exc.status_code in (408, 409, 429) or exc.status_code >= 500:
                raise LLMError(f"anthropic {exc.status_code}: {exc.message}") from exc
            raise
        except anthropic.APIConnectionError as exc:
            raise LLMError(f"anthropic connection error: {exc}") from exc

        if message.stop_reason == "refusal":
            details = getattr(message, "stop_details", None)
            category = getattr(details, "category", None)
            raise RefusalError(f"model refused the request (category={category})")

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
