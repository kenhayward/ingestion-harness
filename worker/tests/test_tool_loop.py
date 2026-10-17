from __future__ import annotations

from typing import Any

import pytest

from ingest_worker.extract import ExtractionFailedError, OutputTruncatedError
from ingest_worker.llm.base import RefusalError, ToolSpec, TurnResult
from ingest_worker.tool_loop import (
    MAX_TOOL_RESULT_CHARS,
    SUBMIT,
    Tool,
    ToolError,
    run_tool_extraction,
)

from .fakes import ScriptedTurn, ToolFakeProvider

SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {"answer": {"type": "string"}},
    "required": ["answer"],
    "additionalProperties": False,
}


def echo_tool(calls: list[dict[str, Any]] | None = None) -> Tool:
    def run(args: dict[str, Any]) -> str:
        if calls is not None:
            calls.append(args)
        return f"you said {args.get('text')}"

    return Tool(
        spec=ToolSpec(
            "echo",
            "Echo the text back.",
            {"type": "object", "properties": {"text": {"type": "string"}}, "required": ["text"]},
        ),
        run=run,
        describe=lambda args: f"Echoing {args.get('text')}",
    )


def run(
    turns: list[ScriptedTurn], tools: list[Tool] | None = None, **kwargs: Any
) -> tuple[Any, ToolFakeProvider]:
    provider = ToolFakeProvider(turns=turns)
    result = run_tool_extraction(
        extraction_id="draft-test",
        provider=provider,
        model_id="m",
        prompt="Do the thing.",
        schema=SCHEMA,
        max_attempts=2,
        tools=tools if tools is not None else [echo_tool()],
        **kwargs,
    )
    return result, provider


def test_a_valid_submit_is_the_answer() -> None:
    result, provider = run([[(SUBMIT, {"answer": "yes"})]])
    assert result.data == {"answer": "yes"}
    assert result.model_ref == "fake/m"
    assert len(result.attempts) == 1 and result.attempts[0].errors == []
    assert result.tool_calls == 0
    ((_, request),) = provider.converse_calls
    assert [t.name for t in request.tools] == ["echo", SUBMIT]
    submit = request.tools[-1]
    assert submit.input_schema == SCHEMA and submit.strict
    assert request.messages[0].role == "user" and request.messages[0].text == "Do the thing."


def test_a_tool_runs_and_its_result_goes_back_before_the_answer() -> None:
    seen: list[dict[str, Any]] = []
    starts: list[tuple[str | None, str, int]] = []
    result, provider = run(
        [[("echo", {"text": "hi"})], [(SUBMIT, {"answer": "done"})]],
        tools=[echo_tool(seen)],
        on_tool=lambda name, summary, calls: starts.append((name, summary, calls)),
    )
    assert result.data == {"answer": "done"}
    assert seen == [{"text": "hi"}]
    assert starts == [("echo", "Echoing hi", 1), (None, "", 1)]
    assert result.tool_calls == 1
    _, second = provider.converse_calls[1]
    assistant, results = second.messages[1], second.messages[2]
    assert assistant.role == "assistant" and assistant.tool_calls[0].name == "echo"
    assert results.role == "user"
    assert results.tool_results[0].call_id == assistant.tool_calls[0].id
    assert results.tool_results[0].content == "you said hi"
    assert not results.tool_results[0].is_error


def test_a_rejected_answer_is_fed_back_as_an_error_and_counts_as_an_attempt() -> None:
    attempts: list[int] = []
    result, provider = run(
        [[(SUBMIT, {"wrong": 1})], [(SUBMIT, {"answer": "ok"})]],
        on_attempt=attempts.append,
        retry_note="Fix it.",
    )
    assert result.data == {"answer": "ok"}
    assert attempts == [1, 2]
    assert [bool(a.errors) for a in result.attempts] == [True, False]
    feedback = provider.converse_calls[1][1].messages[-1].tool_results[0]
    assert feedback.is_error
    assert "'answer' is a required property" in feedback.content
    assert feedback.content.endswith("Fix it.")


def test_check_errors_are_fed_back_like_schema_errors() -> None:
    result, provider = run(
        [[(SUBMIT, {"answer": "no"})], [(SUBMIT, {"answer": "yes"})]],
        check=lambda data: [] if data["answer"] == "yes" else ["answer must be yes"],
    )
    assert result.data == {"answer": "yes"}
    assert (
        "answer must be yes" in provider.converse_calls[1][1].messages[-1].tool_results[0].content
    )


def test_too_many_rejected_answers_fail_the_extraction() -> None:
    with pytest.raises(ExtractionFailedError) as caught:
        run([[(SUBMIT, {"wrong": 1})], [(SUBMIT, {"wrong": 2})]])
    assert len(caught.value.attempts) == 2


@pytest.mark.parametrize(
    ("call", "message"),
    [
        (("nope", {"x": 1}), "unknown tool nope"),
        (("echo", "{not json"), "arguments are not a JSON object"),
    ],
)
def test_a_bad_tool_call_is_told_to_the_model(
    call: tuple[str, dict[str, Any] | str], message: str
) -> None:
    result, provider = run([[call], [(SUBMIT, {"answer": "a"})]])
    error = provider.converse_calls[1][1].messages[-1].tool_results[0]
    assert error.is_error and message in error.content
    assert result.data == {"answer": "a"}


def test_a_failing_tool_is_told_to_the_model() -> None:
    def broken(_args: dict[str, Any]) -> str:
        raise ToolError("that sample is not a dev sample")

    tool = Tool(echo_tool().spec, broken, lambda _a: "Echoing")
    result, provider = run([[("echo", {"text": "x"})], [(SUBMIT, {"answer": "a"})]], tools=[tool])
    error = provider.converse_calls[1][1].messages[-1].tool_results[0]
    assert error.is_error and error.content == "that sample is not a dev sample"
    assert result.data == {"answer": "a"}


def test_a_long_tool_result_is_cut() -> None:
    tool = Tool(echo_tool().spec, lambda _a: "x" * (MAX_TOOL_RESULT_CHARS + 50), lambda _a: "")
    _, provider = run([[("echo", {"text": "x"})], [(SUBMIT, {"answer": "a"})]], tools=[tool])
    content = provider.converse_calls[1][1].messages[-1].tool_results[0].content
    assert content.startswith("x" * MAX_TOOL_RESULT_CHARS)
    assert content.endswith("[... truncated: 50 more characters]")


def test_a_text_reply_holding_a_valid_answer_is_accepted() -> None:
    result, _ = run(['{"answer": "plain"}'])
    assert result.data == {"answer": "plain"}


def test_a_text_reply_without_an_answer_is_asked_to_submit() -> None:
    result, provider = run(["Let me think about it.", [(SUBMIT, {"answer": "a"})]])
    nudge = provider.converse_calls[1][1].messages[-1]
    assert nudge.role == "user" and "submit" in nudge.text
    assert result.data == {"answer": "a"}


def test_once_the_tool_budget_is_spent_only_submit_is_offered() -> None:
    _, provider = run([[("echo", {"text": "1"})], [(SUBMIT, {"answer": "a"})]], max_tool_calls=1)
    assert [t.name for t in provider.converse_calls[1][1].tools] == [SUBMIT]


def test_the_last_turn_offers_only_submit_and_no_answer_fails() -> None:
    with pytest.raises(ExtractionFailedError, match="no answer submitted within 3 turns"):
        run([[("echo", {"text": "1"})], [("echo", {"text": "2"})], "thinking"], max_turns=3)


def test_the_last_turn_offers_only_submit() -> None:
    _, provider = run([[("echo", {"text": "1"})], [(SUBMIT, {"answer": "a"})]], max_turns=2)
    assert [t.name for t in provider.converse_calls[1][1].tools] == [SUBMIT]


def test_a_truncated_turn_raises() -> None:
    truncated = TurnResult(text="{", tool_calls=(), model="m", truncated=True)
    with pytest.raises(OutputTruncatedError):
        run([truncated], max_tokens=100)


def test_a_refusal_propagates() -> None:
    with pytest.raises(RefusalError):
        run([RefusalError("no")])


def test_tokens_are_counted_over_the_whole_conversation() -> None:
    provider = ToolFakeProvider(turns=[[("echo", {"text": "a"})], [(SUBMIT, {"answer": "b"})]])
    provider.token_stream = [10, 600]
    seen: list[int] = []
    run_tool_extraction(
        extraction_id="draft-test",
        provider=provider,
        model_id="m",
        prompt="p",
        schema=SCHEMA,
        max_attempts=2,
        tools=[echo_tool()],
        on_tokens=seen.append,
    )
    assert seen == [10, 600, 610, 1200]


def test_the_transcript_records_every_turn() -> None:
    transcript: list[dict[str, Any]] = []
    run(
        [[("echo", {"text": "hi"})], [(SUBMIT, {"wrong": 1})], [(SUBMIT, {"answer": "a"})]],
        transcript=transcript,
    )
    assert [e["kind"] for e in transcript] == [
        "prompt",
        "reply",
        "toolCall",
        "toolResult",
        "reply",
        "toolCall",
        "rejected",
        "reply",
        "toolCall",
    ]
    assert transcript[2] == {
        "kind": "toolCall",
        "id": "call-1-0",
        "name": "echo",
        "input": {"text": "hi"},
        "summary": "Echoing hi",
    }
    assert transcript[3]["text"] == "you said hi" and transcript[3]["isError"] is False
    assert "<root>: 'answer' is a required property" in transcript[6]["errors"]


def test_the_checkpoint_runs_before_every_turn_and_can_stop_the_conversation() -> None:
    class Stop(Exception):
        pass

    turns = {"n": 0}

    def checkpoint() -> None:
        turns["n"] += 1
        if turns["n"] == 2:
            raise Stop

    with pytest.raises(Stop):
        run([[("echo", {"text": "1"})], [(SUBMIT, {"answer": "a"})]], checkpoint=checkpoint)
    assert turns["n"] == 2  # the second turn was never asked for
