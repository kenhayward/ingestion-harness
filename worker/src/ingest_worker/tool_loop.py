"""A conversation with tools for Workbench drafting: the model may call the stage's tools
(test anchors, search the ontologies, read sample pages) before it answers by calling `submit`,
whose arguments are the stage's JSON. The answer is validated like `run_extraction`'s; a rejected
one goes back as the submit call's error result, so the model fixes it in the same conversation.

Production extraction never comes here: only `drafting` and `mapping_stage` call it, and only when
the endpoint can hold a conversation with tools (`ModelRegistry.supports_tools`)."""

from __future__ import annotations

import json
import logging
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any

from jsonschema import Draft202012Validator

from .extract import (
    SYSTEM_PROMPT,
    Attempt,
    ExtractionFailedError,
    ExtractionResult,
    OutputTruncatedError,
)
from .llm.base import (
    ConversationRequest,
    Message,
    ToolCall,
    ToolCapable,
    ToolResult,
    ToolSpec,
    TurnResult,
    parse_tool_arguments,
)

log = logging.getLogger(__name__)

SUBMIT = "submit"
#: Model turns in one conversation; the last offers only `submit`.
MAX_TURNS = 12
#: Tool calls in one conversation (submit not counted); once spent only `submit` is offered.
MAX_TOOL_CALLS = 20
#: A tool's result is cut here: the conversation is resent every turn.
MAX_TOOL_RESULT_CHARS = 6000
NUDGE = "Call the submit tool with your answer: it is the only way to answer."


class ToolError(Exception):
    """A tool could not do what was asked; the message goes back to the model as an error."""


@dataclass(frozen=True)
class Tool:
    spec: ToolSpec
    #: Runs the tool on parsed arguments and returns the text the model reads.
    run: Callable[[dict[str, Any]], str]
    #: One line saying what the call does, for the progress line ("Testing 4 anchors…").
    describe: Callable[[dict[str, Any]], str]


#: Called when a tool starts, with its name, its one-line summary and the calls so far; then with
#: (None, "", calls) once the turn's tools have finished.
ToolStart = Callable[[str | None, str, int], None]


def _cut(text: str) -> str:
    if len(text) <= MAX_TOOL_RESULT_CHARS:
        return text
    rest = len(text) - MAX_TOOL_RESULT_CHARS
    return f"{text[:MAX_TOOL_RESULT_CHARS]}\n[... truncated: {rest} more characters]"


def _rejection(errors: list[str], retry_note: str) -> str:
    return (
        "Your answer was rejected:\n<validation_errors>\n"
        + "\n".join(errors)
        + f"\n</validation_errors>\n{retry_note}"
    )


def run_tool_extraction(
    *,
    extraction_id: str,
    provider: ToolCapable,
    model_id: str,
    prompt: str,
    schema: dict[str, Any],
    max_attempts: int,
    tools: Sequence[Tool],
    images: tuple[bytes, ...] = (),
    max_tokens: int = 64000,
    system: str = SYSTEM_PROMPT,
    check: Callable[[dict[str, Any]], list[str]] | None = None,
    on_attempt: Callable[[int], None] | None = None,
    on_tokens: Callable[[int], None] | None = None,
    on_tool: ToolStart | None = None,
    retry_note: str = "Return corrected JSON only.",
    max_turns: int = MAX_TURNS,
    max_tool_calls: int = MAX_TOOL_CALLS,
    transcript: list[dict[str, Any]] | None = None,
    checkpoint: Callable[[], None] | None = None,
) -> ExtractionResult:
    """Hold the conversation until the model submits a valid answer. `max_attempts` counts
    rejected answers, as in `run_extraction`; `on_tokens` gets the whole conversation's estimated
    output tokens; `transcript` (when given) is appended to as the conversation goes, so it holds
    what happened even when this raises. `checkpoint` runs before every turn (a cancel check:
    whatever it raises ends the conversation)."""
    validator = Draft202012Validator(schema)
    by_name = {t.spec.name: t for t in tools}
    submit = ToolSpec(
        SUBMIT, "Submit your answer. Its arguments are the answer.", schema, strict=True
    )
    offered = (*[t.spec for t in tools], submit)
    entries: list[dict[str, Any]] = transcript if transcript is not None else []
    messages: list[Message] = [Message("user", text=prompt, images=images)]
    entries.append({"kind": "prompt", "text": prompt, "images": len(images)})
    attempts: list[Attempt] = []
    calls = 0
    spent = [0]  # tokens of the turns before this one

    def counted(estimate: int) -> None:
        current[0] = estimate
        if on_tokens is not None:
            on_tokens(spent[0] + estimate)

    current = [0]
    counting = {"on_tokens": counted} if on_tokens is not None else {}

    def answer(data: Any, raw: str, turn: TurnResult) -> tuple[dict[str, Any] | None, list[str]]:
        """Validate an answer; record the attempt; None and the errors when rejected."""
        if isinstance(data, dict):
            errors = [
                f"{'/'.join(map(str, e.absolute_path)) or '<root>'}: {e.message}"
                for e in sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path))
            ]
        else:
            errors = ["the answer must be a JSON object"]
        if not errors and check is not None:
            errors = check(data)
        attempts.append(
            Attempt(len(attempts) + 1, prompt, raw, errors, turn.input_tokens, turn.output_tokens)
        )
        if errors:
            entries.append({"kind": "rejected", "errors": errors})
            return None, errors
        return data, []

    def rejected(errors: list[str]) -> str:
        """The feedback for a rejected answer; raises once attempts run out."""
        if len(attempts) >= max_attempts:
            raise ExtractionFailedError(extraction_id, attempts)
        if on_attempt is not None:
            on_attempt(len(attempts) + 1)
        return _rejection(errors, retry_note)

    def result(data: dict[str, Any]) -> ExtractionResult:
        return ExtractionResult(data, f"{provider.name}/{model_id}", attempts, tool_calls=calls)

    if on_attempt is not None:
        on_attempt(1)
    for turn_n in range(1, max_turns + 1):
        if checkpoint is not None:
            checkpoint()
        last = turn_n == max_turns or calls >= max_tool_calls
        current[0] = 0
        turn = provider.converse(
            model_id,
            ConversationRequest(
                system=system,
                messages=tuple(messages),
                tools=(submit,) if last else offered,
                max_tokens=max_tokens,
            ),
            **counting,
        )
        spent[0] += current[0]
        entries.append(
            {
                "kind": "reply",
                "text": turn.text,
                "inputTokens": turn.input_tokens,
                "outputTokens": turn.output_tokens,
            }
        )
        if turn.truncated:
            attempts.append(
                Attempt(
                    len(attempts) + 1,
                    prompt,
                    turn.text,
                    ["output truncated at max tokens"],
                    turn.input_tokens,
                    turn.output_tokens,
                )
            )
            raise OutputTruncatedError(extraction_id, attempts, max_tokens)
        messages.append(
            Message("assistant", text=turn.text, tool_calls=turn.tool_calls, echo=turn.echo)
        )

        if not turn.tool_calls:
            # A model that answers in text instead of calling submit: take a JSON answer.
            parsed = parse_tool_arguments(turn.text) if turn.text.strip() else None
            if parsed is not None:
                data, errors = answer(parsed, turn.text, turn)
                if data is not None:
                    return result(data)
                feedback = rejected(errors)
            else:
                feedback = NUDGE
                entries.append({"kind": "note", "text": NUDGE})
            messages.append(Message("user", text=feedback))
            continue

        results: list[ToolResult] = []
        ran = False
        for call in turn.tool_calls:
            if call.name == SUBMIT:
                entries.append(_call_entry(call, "Submitting the answer"))
                if call.input is None:
                    data, errors = None, ["the answer is not a JSON object"]
                    attempts.append(
                        Attempt(
                            len(attempts) + 1,
                            prompt,
                            call.raw,
                            errors,
                            turn.input_tokens,
                            turn.output_tokens,
                        )
                    )
                    entries.append({"kind": "rejected", "errors": errors})
                else:
                    data, errors = answer(call.input, json.dumps(call.input), turn)
                if data is not None:
                    return result(data)
                results.append(ToolResult(call.id, rejected(errors), is_error=True))
                continue
            calls += 1
            text, is_error = _run_tool(call, by_name, calls, max_tool_calls, on_tool, entries)
            ran = ran or call.name in by_name
            results.append(ToolResult(call.id, text, is_error=is_error))
            entries.append(
                {
                    "kind": "toolResult",
                    "id": call.id,
                    "name": call.name,
                    "text": text,
                    "isError": is_error,
                }
            )
        if ran and on_tool is not None:
            on_tool(None, "", calls)
        messages.append(Message("user", tool_results=tuple(results)))

    attempts.append(
        Attempt(
            len(attempts) + 1,
            prompt,
            messages[-2].text if len(messages) > 1 else "",
            [f"no answer submitted within {max_turns} turns"],
        )
    )
    raise ExtractionFailedError(extraction_id, attempts)


def _call_entry(call: ToolCall, summary: str) -> dict[str, Any]:
    return {
        "kind": "toolCall",
        "id": call.id,
        "name": call.name,
        "input": call.input if call.input is not None else call.raw,
        "summary": summary,
    }


def _run_tool(
    call: ToolCall,
    by_name: dict[str, Tool],
    calls: int,
    max_tool_calls: int,
    on_tool: ToolStart | None,
    entries: list[dict[str, Any]],
) -> tuple[str, bool]:
    """Run one tool call: (the text the model reads, whether it is an error)."""
    tool = by_name.get(call.name)
    if tool is None:
        entries.append(_call_entry(call, ""))
        return f"unknown tool {call.name}: use only the tools offered", True
    if call.input is None:
        entries.append(_call_entry(call, ""))
        return f"{call.name}: the arguments are not a JSON object", True
    try:
        summary = tool.describe(call.input)
    except Exception:  # a summary is progress text only: never fail the call over it
        summary = call.name
    entries.append(_call_entry(call, summary))
    if calls > max_tool_calls:
        return "the tool budget is spent: submit your answer now", True
    if on_tool is not None:
        on_tool(call.name, summary, calls)
    try:
        return _cut(tool.run(call.input)), False
    except ToolError as exc:
        return str(exc), True
    except Exception as exc:  # a tool's own failure is the model's feedback, not the job's end
        log.warning("tool %s failed: %s", call.name, exc)
        return f"{call.name} failed: {exc}", True
