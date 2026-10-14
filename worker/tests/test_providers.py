"""Adapter tests against stub SDK clients: assert request shape and response mapping."""

from __future__ import annotations

import base64
from types import SimpleNamespace
from typing import Any, cast

import pytest

from ingest_worker.llm.anthropic_provider import FALLBACK_BETA, AnthropicProvider
from ingest_worker.llm.base import (
    DISCOVERY_TIMEOUT_S,
    CompletionRequest,
    RefusalError,
    VisionRequest,
)
from ingest_worker.llm.openai_providers import OpenAIChatProvider, OpenAIResponsesProvider

REQ = CompletionRequest(system="sys", prompt="doc", json_schema={"type": "object"}, schema_name="x")


class Recorder:
    def __init__(self, result: Any) -> None:
        self.result = result
        self.kwargs: dict[str, Any] = {}

    def create(self, **kwargs: Any) -> Any:
        self.kwargs = kwargs
        return self.result


class StreamRecorder:
    """Anthropic messages stub: only streaming is allowed (large max_tokens can't be sent
    non-streaming - the SDK raises before sending)."""

    def __init__(self, result: Any) -> None:
        self.result = result
        self.kwargs: dict[str, Any] = {}

    def create(self, **kwargs: Any) -> Any:
        raise AssertionError("anthropic calls must stream")

    def stream(self, **kwargs: Any) -> Any:
        self.kwargs = kwargs
        final = self.result

        class _Stream:
            def __enter__(self) -> Any:
                return self

            def __exit__(self, *exc: object) -> None:
                return None

            def get_final_message(self) -> Any:
                return final

        return _Stream()


def anthropic_message(stop_reason: str = "end_turn", text: str = '{"a": 1}') -> Any:
    return SimpleNamespace(
        id="msg_1",
        model="claude-opus-5-5",
        stop_reason=stop_reason,
        stop_details=SimpleNamespace(category="cyber") if stop_reason == "refusal" else None,
        content=[SimpleNamespace(type="thinking"), SimpleNamespace(type="text", text=text)],
        usage=SimpleNamespace(input_tokens=100, output_tokens=20),
    )


def test_anthropic_uses_structured_outputs_and_server_fallbacks() -> None:
    beta = StreamRecorder(anthropic_message())
    client: Any = SimpleNamespace(beta=SimpleNamespace(messages=beta))
    result = AnthropicProvider("anthropic", client, effort="high").complete_json(
        "claude-opus-5-5", REQ
    )

    assert result.text == '{"a": 1}'
    assert result.input_tokens == 100
    assert beta.kwargs["output_config"] == {
        "format": {"type": "json_schema", "schema": {"type": "object"}},
        "effort": "high",
    }
    assert beta.kwargs["betas"] == [FALLBACK_BETA]
    assert beta.kwargs["fallbacks"] == "default"
    assert beta.kwargs["system"] == "sys"


def test_anthropic_without_fallbacks_uses_messages_api() -> None:
    messages = StreamRecorder(anthropic_message())
    client: Any = SimpleNamespace(messages=messages)
    AnthropicProvider("a", client, server_fallbacks=False).complete_json("m", REQ)
    assert "betas" not in messages.kwargs


def test_anthropic_refusal_raises() -> None:
    client: Any = SimpleNamespace(
        beta=SimpleNamespace(messages=StreamRecorder(anthropic_message("refusal")))
    )
    with pytest.raises(RefusalError, match="cyber"):
        AnthropicProvider("a", client).complete_json("m", REQ)


class ListingClient:
    """Stub SDK client for model listing: records the options discovery asks for."""

    def __init__(self, models: list[Any]) -> None:
        self.options: dict[str, Any] | None = None
        self.models = SimpleNamespace(list=self._unbounded)
        self._listed = models

    def _unbounded(self) -> list[Any]:
        raise AssertionError("models.list() without with_options: inherits the request timeout")

    def with_options(self, **options: Any) -> Any:
        self.options = options
        return SimpleNamespace(models=SimpleNamespace(list=lambda: self._listed))


def test_anthropic_list_models() -> None:
    client = ListingClient([SimpleNamespace(id="claude-opus-5-5", display_name="Claude Opus 5.5")])
    [d] = AnthropicProvider("anthropic", cast(Any, client)).list_models()
    assert (d.ref, d.display_name, d.provider_kind) == (
        "anthropic/claude-opus-5-5",
        "Claude Opus 5.5",
        "anthropic",
    )
    # A down endpoint must not hold the worker loop for the extraction timeout and retries.
    assert client.options == {"timeout": DISCOVERY_TIMEOUT_S, "max_retries": 0}


def chat_response(content: str | None = '{"a": 1}', refusal: str | None = None) -> Any:
    return SimpleNamespace(
        id="c1",
        model="gpt-x",
        choices=[
            SimpleNamespace(
                finish_reason="stop",
                message=SimpleNamespace(content=content, refusal=refusal),
            )
        ],
        usage=SimpleNamespace(prompt_tokens=7, completion_tokens=3),
    )


@pytest.mark.parametrize(
    ("fmt", "expected"),
    [
        (
            "json_schema",
            {
                "type": "json_schema",
                "json_schema": {"name": "x", "schema": {"type": "object"}, "strict": True},
            },
        ),
        ("json_object", {"type": "json_object"}),
        ("none", None),
    ],
)
def test_openai_chat_response_formats(fmt: Any, expected: Any) -> None:
    completions = Recorder(chat_response())
    client: Any = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    result = OpenAIChatProvider("local", client, response_format=fmt).complete_json("llama", REQ)
    assert result.text == '{"a": 1}'
    assert completions.kwargs.get("response_format") == expected
    assert completions.kwargs["messages"][0] == {"role": "system", "content": "sys"}


def test_openai_chat_max_tokens_param_is_configurable() -> None:
    completions = Recorder(chat_response())
    client: Any = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    OpenAIChatProvider("l", client, max_tokens_param="max_tokens").complete_json("m", REQ)
    assert completions.kwargs["max_tokens"] == REQ.max_tokens


def test_openai_chat_refusal_raises() -> None:
    client: Any = SimpleNamespace(
        chat=SimpleNamespace(completions=Recorder(chat_response(None, "no")))
    )
    with pytest.raises(RefusalError):
        OpenAIChatProvider("o", client).complete_json("m", REQ)


def test_openai_responses_maps_request_and_output() -> None:
    resp = SimpleNamespace(
        id="r1",
        model="gpt-x",
        status="completed",
        output_text='{"a": 1}',
        output=[],
        usage=SimpleNamespace(input_tokens=5, output_tokens=2),
    )
    responses = Recorder(resp)
    client: Any = SimpleNamespace(responses=responses)
    result = OpenAIResponsesProvider("openai", client).complete_json("gpt-x", REQ)
    assert result.text == '{"a": 1}' and result.output_tokens == 2
    assert responses.kwargs["instructions"] == "sys"
    assert responses.kwargs["text"]["format"]["type"] == "json_schema"


def test_openai_model_filter() -> None:
    client = ListingClient(
        [SimpleNamespace(id=i) for i in ("gpt-5", "text-embedding-3", "o4-mini")]
    )
    found = OpenAIResponsesProvider(
        "openai", cast(Any, client), model_filter=r"^(gpt-|o\d)"
    ).list_models()
    assert [d.model_id for d in found] == ["gpt-5", "o4-mini"]
    assert client.options == {"timeout": DISCOVERY_TIMEOUT_S, "max_retries": 0}


VISION = VisionRequest(
    prompt="read this", image_png=b"\x89PNGdata", max_tokens=8000, temperature=0.1
)
DATA_URL = "data:image/png;base64," + base64.b64encode(b"\x89PNGdata").decode()


def test_openai_chat_vision_sends_image_url_without_response_format() -> None:
    completions = Recorder(chat_response("page text"))
    client: Any = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    provider = OpenAIChatProvider("local", client, max_tokens_param="max_tokens")
    result = provider.complete_vision("olmocr-2-7b-1025", VISION)

    assert result.text == "page text"
    [message] = completions.kwargs["messages"]
    assert message["content"] == [
        {"type": "text", "text": "read this"},
        {"type": "image_url", "image_url": {"url": DATA_URL}},
    ]
    assert "response_format" not in completions.kwargs
    assert completions.kwargs["max_tokens"] == 8000
    assert completions.kwargs["temperature"] == 0.1


def test_openai_responses_vision_uses_input_image() -> None:
    resp = SimpleNamespace(
        id="r", model="m", status="completed", output_text="t", output=[], usage=None
    )
    responses = Recorder(resp)
    client: Any = SimpleNamespace(responses=responses)
    OpenAIResponsesProvider("openai", client).complete_vision("m", VISION)
    [message] = responses.kwargs["input"]
    assert message["content"][1] == {"type": "input_image", "image_url": DATA_URL}


def test_anthropic_vision_sends_base64_image_block() -> None:
    messages = StreamRecorder(anthropic_message(text="page text"))
    client: Any = SimpleNamespace(messages=messages)
    provider = AnthropicProvider("a", client, server_fallbacks=False)
    result = provider.complete_vision("claude-opus-5-5", VISION)
    assert result.text == "page text"
    content = messages.kwargs["messages"][0]["content"]
    assert content[0] == {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": "image/png",
            "data": base64.b64encode(b"\x89PNGdata").decode(),
        },
    }
    assert content[1] == {"type": "text", "text": "read this"}
    assert "temperature" not in messages.kwargs  # rejected by current Claude models


# --- extraction requests that carry page images ---------------------------------------------

REQ_IMG = CompletionRequest(
    system="sys",
    prompt="doc",
    json_schema={"type": "object"},
    schema_name="x",
    images=(b"\x89PNGdata",),
)


def test_openai_chat_json_with_images_keeps_response_format() -> None:
    completions = Recorder(chat_response())
    client: Any = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    OpenAIChatProvider("local", client).complete_json("qwen", REQ_IMG)
    user = completions.kwargs["messages"][1]
    assert user["content"] == [
        {"type": "text", "text": "doc"},
        {"type": "image_url", "image_url": {"url": DATA_URL}},
    ]
    assert completions.kwargs["response_format"]["type"] == "json_schema"


def test_openai_chat_json_without_images_sends_plain_string() -> None:
    completions = Recorder(chat_response())
    client: Any = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    OpenAIChatProvider("local", client).complete_json("qwen", REQ)
    assert completions.kwargs["messages"][1] == {"role": "user", "content": "doc"}


def test_openai_responses_json_with_images() -> None:
    resp = SimpleNamespace(
        id="r", model="m", status="completed", output_text="{}", output=[], usage=None
    )
    responses = Recorder(resp)
    client: Any = SimpleNamespace(responses=responses)
    OpenAIResponsesProvider("openai", client).complete_json("m", REQ_IMG)
    [message] = responses.kwargs["input"]
    assert message["content"] == [
        {"type": "input_text", "text": "doc"},
        {"type": "input_image", "image_url": DATA_URL},
    ]
    assert responses.kwargs["text"]["format"]["type"] == "json_schema"


def test_anthropic_json_with_images_puts_images_before_text() -> None:
    messages = StreamRecorder(anthropic_message())
    client: Any = SimpleNamespace(messages=messages)
    AnthropicProvider("a", client, server_fallbacks=False).complete_json("m", REQ_IMG)
    content = messages.kwargs["messages"][0]["content"]
    assert content[0]["type"] == "image" and content[0]["source"]["media_type"] == "image/png"
    assert content[1] == {"type": "text", "text": "doc"}
    assert "format" in messages.kwargs["output_config"]


# --- truncation (output hit max tokens) -----------------------------------------------------


def test_truncation_is_reported_by_every_provider() -> None:
    chat = Recorder(chat_response())
    chat.result.choices[0].finish_reason = "length"
    client: Any = SimpleNamespace(chat=SimpleNamespace(completions=chat))
    assert OpenAIChatProvider("l", client).complete_json("m", REQ).truncated

    resp = SimpleNamespace(
        id="r",
        model="m",
        status="incomplete",
        output_text='{"a"',
        output=[],
        usage=None,
        incomplete_details=SimpleNamespace(reason="max_output_tokens"),
    )
    client = SimpleNamespace(responses=Recorder(resp))
    assert OpenAIResponsesProvider("o", client).complete_json("m", REQ).truncated

    client = SimpleNamespace(messages=StreamRecorder(anthropic_message(stop_reason="max_tokens")))
    assert AnthropicProvider("a", client, server_fallbacks=False).complete_json("m", REQ).truncated


def test_complete_responses_are_not_truncated() -> None:
    client: Any = SimpleNamespace(chat=SimpleNamespace(completions=Recorder(chat_response())))
    assert not OpenAIChatProvider("l", client).complete_json("m", REQ).truncated


def test_openai_providers_send_a_configured_temperature() -> None:
    completions = Recorder(chat_response())
    client: Any = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    OpenAIChatProvider("local", client, temperature=0.0).complete_json("m", REQ)
    assert completions.kwargs["temperature"] == 0.0

    completions = Recorder(chat_response())
    client = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    OpenAIChatProvider("local", client).complete_json("m", REQ)
    assert "temperature" not in completions.kwargs  # server default unless configured

    resp = SimpleNamespace(
        id="r", model="m", status="completed", output_text="{}", output=[], usage=None
    )
    responses = Recorder(resp)
    client = SimpleNamespace(responses=responses)
    OpenAIResponsesProvider("o", client, temperature=0.0).complete_json("m", REQ)
    assert responses.kwargs["temperature"] == 0.0


def test_anthropic_streams_with_a_large_output_budget() -> None:
    messages = StreamRecorder(anthropic_message())
    client: Any = SimpleNamespace(messages=messages)
    result = AnthropicProvider("a", client, server_fallbacks=False).complete_json("m", REQ)
    assert messages.kwargs["max_tokens"] == 64000 == REQ.max_tokens
    assert result.text == '{"a": 1}' and result.output_tokens == 20


# --- embeddings (ADR 0011: ontology term retrieval) -------------------------------------------


def embeddings_response(vectors: list[list[float]]) -> Any:
    # The API may return items out of order: each carries its input index.
    data = [SimpleNamespace(index=i, embedding=v) for i, v in enumerate(vectors)]
    return SimpleNamespace(data=list(reversed(data)))


@pytest.mark.parametrize("provider_class", [OpenAIChatProvider, OpenAIResponsesProvider])
def test_openai_providers_embed_in_input_order(provider_class: Any) -> None:
    embeddings = Recorder(embeddings_response([[1.0, 0.0], [0.0, 1.0]]))
    client: Any = SimpleNamespace(embeddings=embeddings)
    vectors = provider_class("local", client).embed("nomic-embed", ["a", "b"])
    assert vectors == [[1.0, 0.0], [0.0, 1.0]]
    assert embeddings.kwargs == {"model": "nomic-embed", "input": ["a", "b"]}


def test_embedding_nothing_calls_nothing() -> None:
    client: Any = SimpleNamespace(embeddings=None)
    assert OpenAIChatProvider("local", client).embed("m", []) == []


def test_anthropic_has_no_embeddings() -> None:
    assert not hasattr(AnthropicProvider, "embed")
