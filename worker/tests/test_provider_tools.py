"""Conversations with tools (Workbench drafting): request shapes and reply parsing per adapter,
against the same stub SDK clients as test_providers."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import httpx
import openai
import pytest

from ingest_worker.llm.anthropic_provider import AnthropicProvider
from ingest_worker.llm.base import (
    ConversationRequest,
    Message,
    RefusalError,
    ToolCall,
    ToolCapable,
    ToolResult,
    ToolSpec,
)
from ingest_worker.llm.openai_providers import OpenAIChatProvider, OpenAIResponsesProvider

from .test_providers import Recorder, StreamingRecorder, StreamRecorder

SCHEMA = {"type": "object", "properties": {"q": {"type": "string"}}, "required": ["q"]}
TOOLS = (
    ToolSpec("search", "Search things.", SCHEMA),
    ToolSpec("submit", "Answer.", {"type": "object"}, strict=True),
)
FIRST = ConversationRequest(
    system="sys", messages=(Message("user", text="go"),), tools=TOOLS, max_tokens=900
)
CALL = ToolCall("t1", "search", {"q": "x"}, '{"q": "x"}')
HISTORY = ConversationRequest(
    system="sys",
    messages=(
        Message("user", text="go"),
        Message("assistant", text="Looking.", tool_calls=(CALL,)),
        Message(
            "user",
            text="Call submit.",
            tool_results=(ToolResult("t1", "found 2"), ToolResult("t2", "bad", is_error=True)),
        ),
    ),
    tools=TOOLS,
    max_tokens=900,
)


def test_every_adapter_can_hold_a_conversation_with_tools() -> None:
    client: Any = SimpleNamespace()
    assert isinstance(AnthropicProvider("a", client), ToolCapable)
    assert isinstance(OpenAIChatProvider("c", client), ToolCapable)
    assert isinstance(OpenAIResponsesProvider("r", client), ToolCapable)


# --- Anthropic -------------------------------------------------------------------------------


def anthropic_turn(*blocks: Any, stop_reason: str = "tool_use") -> Any:
    return SimpleNamespace(
        id="msg_1",
        model="claude-opus-5-5",
        stop_reason=stop_reason,
        stop_details=None,
        content=list(blocks),
        usage=SimpleNamespace(input_tokens=50, output_tokens=9),
    )


def test_anthropic_offers_tools_and_parses_tool_use() -> None:
    reply = anthropic_turn(
        SimpleNamespace(type="thinking", thinking="hmm", signature="sig"),
        SimpleNamespace(type="text", text="Searching."),
        SimpleNamespace(type="tool_use", id="tu1", name="search", input={"q": "date"}),
    )
    messages = StreamRecorder(reply)
    client: Any = SimpleNamespace(messages=messages)
    turn = AnthropicProvider("a", client, server_fallbacks=False).converse("m", FIRST)

    assert messages.kwargs["tools"] == [
        {"name": "search", "description": "Search things.", "input_schema": SCHEMA},
        {
            "name": "submit",
            "description": "Answer.",
            "input_schema": {"type": "object"},
            "strict": True,
        },
    ]
    assert messages.kwargs["tool_choice"] == {"type": "auto"}
    assert messages.kwargs["output_config"] == {"effort": "high"}  # no JSON format on tool turns
    assert messages.kwargs["messages"] == [{"role": "user", "content": "go"}]
    assert messages.kwargs["max_tokens"] == 900
    assert turn.text == "Searching."
    assert turn.tool_calls == (ToolCall("tu1", "search", {"q": "date"}, '{"q": "date"}'),)
    assert (turn.input_tokens, turn.output_tokens, turn.truncated) == (50, 9, False)
    # The whole reply goes back next turn: thinking blocks must be returned unchanged.
    assert turn.echo == [
        {"type": "thinking", "thinking": "hmm", "signature": "sig"},
        {"type": "text", "text": "Searching."},
        {"type": "tool_use", "id": "tu1", "name": "search", "input": {"q": "date"}},
    ]


def test_anthropic_sends_the_history_back() -> None:
    messages = StreamRecorder(anthropic_turn(SimpleNamespace(type="text", text="ok")))
    client: Any = SimpleNamespace(messages=messages)
    echo = [{"type": "thinking", "thinking": "t", "signature": "s"}]
    request = ConversationRequest(
        system="sys",
        messages=(
            HISTORY.messages[0],
            Message("assistant", text="Looking.", tool_calls=(CALL,), echo=echo),
            HISTORY.messages[2],
        ),
        tools=TOOLS,
    )
    AnthropicProvider("a", client, server_fallbacks=False).converse("m", request)
    sent = messages.kwargs["messages"]
    assert sent[1] == {"role": "assistant", "content": echo}
    assert sent[2] == {
        "role": "user",
        "content": [
            {"type": "tool_result", "tool_use_id": "t1", "content": "found 2", "is_error": False},
            {"type": "tool_result", "tool_use_id": "t2", "content": "bad", "is_error": True},
            {"type": "text", "text": "Call submit."},
        ],
    }


def test_anthropic_builds_the_assistant_turn_when_there_is_no_echo() -> None:
    messages = StreamRecorder(anthropic_turn(SimpleNamespace(type="text", text="ok")))
    client: Any = SimpleNamespace(messages=messages)
    AnthropicProvider("a", client, server_fallbacks=False).converse("m", HISTORY)
    assert messages.kwargs["messages"][1] == {
        "role": "assistant",
        "content": [
            {"type": "text", "text": "Looking."},
            {"type": "tool_use", "id": "t1", "name": "search", "input": {"q": "x"}},
        ],
    }


def test_anthropic_counts_tool_arguments_as_they_stream() -> None:
    events = [
        SimpleNamespace(type="content_block_delta", delta=SimpleNamespace(text="ab")),
        SimpleNamespace(
            type="content_block_delta", delta=SimpleNamespace(partial_json='{"q": "date"}')
        ),
    ]
    messages = StreamRecorder(anthropic_turn(SimpleNamespace(type="text", text="ab")), events)
    client: Any = SimpleNamespace(messages=messages)
    seen: list[int] = []
    AnthropicProvider("a", client, server_fallbacks=False).converse(
        "m", FIRST, on_tokens=seen.append
    )
    assert seen == [1, 4]


def test_anthropic_tool_turn_refusal_and_truncation() -> None:
    client: Any = SimpleNamespace(messages=StreamRecorder(anthropic_turn(stop_reason="refusal")))
    with pytest.raises(RefusalError):
        AnthropicProvider("a", client, server_fallbacks=False).converse("m", FIRST)
    client = SimpleNamespace(messages=StreamRecorder(anthropic_turn(stop_reason="max_tokens")))
    assert AnthropicProvider("a", client, server_fallbacks=False).converse("m", FIRST).truncated


# --- OpenAI chat -----------------------------------------------------------------------------


def chat_tool_reply(
    content: str | None, calls: list[tuple[str, str, str]], finish: str = "tool_calls"
) -> Any:
    tool_calls = [
        SimpleNamespace(id=i, type="function", function=SimpleNamespace(name=n, arguments=a))
        for i, n, a in calls
    ]
    return SimpleNamespace(
        id="c1",
        model="qwen",
        choices=[
            SimpleNamespace(
                message=SimpleNamespace(
                    content=content, refusal=None, tool_calls=tool_calls or None
                ),
                finish_reason=finish,
            )
        ],
        usage=SimpleNamespace(prompt_tokens=30, completion_tokens=6),
    )


def test_openai_chat_offers_functions_and_parses_tool_calls() -> None:
    completions = Recorder(
        chat_tool_reply(None, [("c-1", "search", '{"q": "date"}'), ("c-2", "search", "{oops")])
    )
    client: Any = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    turn = OpenAIChatProvider(
        "local", client, temperature=0, max_tokens_param="max_tokens"
    ).converse("m", FIRST)
    kwargs = completions.kwargs
    assert kwargs["tools"] == [
        {
            "type": "function",
            "function": {"name": "search", "description": "Search things.", "parameters": SCHEMA},
        },
        {
            "type": "function",
            "function": {
                "name": "submit",
                "description": "Answer.",
                "parameters": {"type": "object"},
                "strict": True,
            },
        },
    ]
    assert kwargs["tool_choice"] == "auto"
    assert "response_format" not in kwargs
    assert kwargs["messages"] == [
        {"role": "system", "content": "sys"},
        {"role": "user", "content": "go"},
    ]
    assert (kwargs["temperature"], kwargs["max_tokens"]) == (0, 900)
    assert turn.tool_calls == (
        ToolCall("c-1", "search", {"q": "date"}, '{"q": "date"}'),
        ToolCall("c-2", "search", None, "{oops"),
    )
    assert (turn.text, turn.input_tokens, turn.output_tokens) == ("", 30, 6)


def test_openai_chat_strict_follows_the_endpoint_setting() -> None:
    completions = Recorder(chat_tool_reply("hi", []))
    client: Any = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    OpenAIChatProvider("local", client, strict=False).converse("m", FIRST)
    assert "strict" not in completions.kwargs["tools"][1]["function"]


def test_openai_chat_sends_the_history_back() -> None:
    completions = Recorder(chat_tool_reply("done", [], finish="stop"))
    client: Any = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    OpenAIChatProvider("local", client).converse("m", HISTORY)
    assert completions.kwargs["messages"][2:] == [
        {
            "role": "assistant",
            "content": "Looking.",
            "tool_calls": [
                {
                    "id": "t1",
                    "type": "function",
                    "function": {"name": "search", "arguments": '{"q": "x"}'},
                }
            ],
        },
        {"role": "tool", "tool_call_id": "t1", "content": "found 2"},
        {"role": "tool", "tool_call_id": "t2", "content": "Error: bad"},
        {"role": "user", "content": "Call submit."},
    ]


def tool_chunk(
    index: int, *, id: str | None = None, name: str | None = None, args: str = ""
) -> Any:
    call = SimpleNamespace(index=index, id=id, function=SimpleNamespace(name=name, arguments=args))
    delta = SimpleNamespace(content=None, reasoning_content=None, refusal=None, tool_calls=[call])
    return SimpleNamespace(
        id="c1",
        model="qwen",
        choices=[SimpleNamespace(delta=delta, finish_reason=None)],
        usage=None,
    )


def test_openai_chat_streams_tool_calls_by_index() -> None:
    chunks = [
        tool_chunk(0, id="c-1", name="search", args='{"q": '),
        tool_chunk(1, id="c-2", name="submit", args="{}"),
        tool_chunk(0, args='"date"}'),
        SimpleNamespace(
            id="c1",
            model="qwen",
            choices=[
                SimpleNamespace(
                    delta=SimpleNamespace(
                        content=None, reasoning_content=None, refusal=None, tool_calls=None
                    ),
                    finish_reason="tool_calls",
                )
            ],
            usage=SimpleNamespace(prompt_tokens=3, completion_tokens=4),
        ),
    ]
    completions = StreamingRecorder(chat_tool_reply(None, []), chunks)
    client: Any = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    seen: list[int] = []
    turn = OpenAIChatProvider("local", client).converse("m", FIRST, on_tokens=seen.append)
    assert completions.kwargs["stream"] is True
    assert turn.tool_calls == (
        ToolCall("c-1", "search", {"q": "date"}, '{"q": "date"}'),
        ToolCall("c-2", "submit", {}, "{}"),
    )
    assert seen == [2, 2, 4]
    assert (turn.stop_reason, turn.output_tokens) == ("tool_calls", 4)


def test_openai_chat_tool_turn_falls_back_to_one_reply() -> None:
    refused = openai.BadRequestError(
        "streaming with tools is not supported",
        response=httpx.Response(400, request=httpx.Request("POST", "http://local/v1")),
        body=None,
    )
    completions = StreamingRecorder(chat_tool_reply("hi", []), [], refuse=refused)
    client: Any = SimpleNamespace(chat=SimpleNamespace(completions=completions))
    turn = OpenAIChatProvider("local", client).converse("m", FIRST, on_tokens=lambda _n: None)
    assert turn.text == "hi"
    assert [c.get("stream", False) for c in completions.calls] == [True, False]


# --- OpenAI responses ------------------------------------------------------------------------


def responses_turn(*items: Any, text: str = "") -> Any:
    return SimpleNamespace(
        id="r1",
        model="gpt-x",
        status="completed",
        output_text=text,
        output=list(items),
        usage=SimpleNamespace(input_tokens=5, output_tokens=2),
        incomplete_details=None,
    )


def test_openai_responses_offers_functions_and_parses_function_calls() -> None:
    reasoning = SimpleNamespace(type="reasoning", id="rs1", summary=[])
    call = SimpleNamespace(
        type="function_call", id="fc1", call_id="call-1", name="search", arguments='{"q": "date"}'
    )
    responses = Recorder(responses_turn(reasoning, call))
    client: Any = SimpleNamespace(responses=responses)
    turn = OpenAIResponsesProvider("o", client).converse("m", FIRST)
    assert responses.kwargs["tools"] == [
        {
            "type": "function",
            "name": "search",
            "description": "Search things.",
            "parameters": SCHEMA,
        },
        {
            "type": "function",
            "name": "submit",
            "description": "Answer.",
            "parameters": {"type": "object"},
            "strict": True,
        },
    ]
    assert responses.kwargs["input"] == [{"role": "user", "content": "go"}]
    assert responses.kwargs["instructions"] == "sys"
    assert responses.kwargs["max_output_tokens"] == 900
    assert "text" not in responses.kwargs
    assert turn.tool_calls == (ToolCall("call-1", "search", {"q": "date"}, '{"q": "date"}'),)
    assert turn.echo == [
        {"type": "reasoning", "id": "rs1", "summary": []},
        {
            "type": "function_call",
            "id": "fc1",
            "call_id": "call-1",
            "name": "search",
            "arguments": '{"q": "date"}',
        },
    ]


def test_openai_responses_sends_the_history_back() -> None:
    responses = Recorder(responses_turn(text="ok"))
    client: Any = SimpleNamespace(responses=responses)
    echo = [{"type": "function_call", "call_id": "t1", "name": "search", "arguments": '{"q": "x"}'}]
    request = ConversationRequest(
        system="sys",
        messages=(
            HISTORY.messages[0],
            Message("assistant", tool_calls=(CALL,), echo=echo),
            HISTORY.messages[2],
        ),
        tools=TOOLS,
    )
    OpenAIResponsesProvider("o", client).converse("m", request)
    assert responses.kwargs["input"][1:] == [
        *echo,
        {"type": "function_call_output", "call_id": "t1", "output": "found 2"},
        {"type": "function_call_output", "call_id": "t2", "output": "Error: bad"},
        {"role": "user", "content": "Call submit."},
    ]


def test_openai_responses_builds_the_assistant_turn_when_there_is_no_echo() -> None:
    responses = Recorder(responses_turn(text="ok"))
    client: Any = SimpleNamespace(responses=responses)
    OpenAIResponsesProvider("o", client).converse("m", HISTORY)
    assert responses.kwargs["input"][1:3] == [
        {"role": "assistant", "content": "Looking."},
        {"type": "function_call", "call_id": "t1", "name": "search", "arguments": '{"q": "x"}'},
    ]


def test_openai_responses_counts_function_arguments_as_they_stream() -> None:
    final = responses_turn(text="ok")
    events = [
        SimpleNamespace(type="response.function_call_arguments.delta", delta='{"q": "date"}'),
        SimpleNamespace(type="response.completed", response=final),
    ]
    responses = StreamingRecorder(final, events)
    client: Any = SimpleNamespace(responses=responses)
    seen: list[int] = []
    turn = OpenAIResponsesProvider("o", client).converse("m", FIRST, on_tokens=seen.append)
    assert seen == [4] and turn.text == "ok"
