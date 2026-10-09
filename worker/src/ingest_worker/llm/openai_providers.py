from __future__ import annotations

import base64
import re
from typing import Any, Literal

import openai

from .base import (
    CompletionRequest,
    CompletionResult,
    LLMError,
    ModelDescriptor,
    ProviderKind,
    RefusalError,
    VisionRequest,
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
    if isinstance(exc, openai.APIStatusError) and (
        exc.status_code in (408, 409, 429) or exc.status_code >= 500
    ):
        return LLMError(f"openai {exc.status_code}: {exc.message}")
    if isinstance(exc, openai.APIConnectionError):
        return LLMError(f"openai connection error: {exc}")
    return exc


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
    ) -> None:
        self.name = name
        self._client = client
        self._model_filter = re.compile(model_filter) if model_filter else None
        self._strict = strict
        self._response_format = response_format
        self._max_tokens_param = max_tokens_param

    def list_models(self) -> list[ModelDescriptor]:
        return [
            ModelDescriptor(self.name, self.kind, m.id, None)
            for m in self._client.models.list()
            if not self._model_filter or self._model_filter.search(m.id)
        ]


class OpenAIChatProvider(_OpenAIBase):
    """Chat Completions API — OpenAI or any OpenAI-compatible server (vLLM, Ollama, ...)."""

    kind: Literal["openai-chat"] = "openai-chat"

    def complete_json(self, model: str, request: CompletionRequest) -> CompletionResult:
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

        return self._create(params)

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
            input_tokens=resp.usage.prompt_tokens if resp.usage else None,
            output_tokens=resp.usage.completion_tokens if resp.usage else None,
            raw={"id": resp.id},
        )


class OpenAIResponsesProvider(_OpenAIBase):
    """Responses API — OpenAI, or compatible servers that implement /v1/responses."""

    kind: Literal["openai-responses"] = "openai-responses"

    def complete_json(self, model: str, request: CompletionRequest) -> CompletionResult:
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

        return self._create(params)

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

        for item in resp.output or []:
            for part in getattr(item, "content", None) or []:
                if getattr(part, "type", None) == "refusal":
                    raise RefusalError(f"model refused the request: {part.refusal}")
        return CompletionResult(
            text=resp.output_text,
            model=resp.model,
            stop_reason=resp.status,
            input_tokens=resp.usage.input_tokens if resp.usage else None,
            output_tokens=resp.usage.output_tokens if resp.usage else None,
            raw={"id": resp.id},
        )
