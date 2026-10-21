from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

from jsonschema import Draft202012Validator

from .llm.base import CompletionRequest, LLMProvider

SYSTEM_PROMPT = (
    "You extract structured data from business documents. Respond only with JSON that "
    "satisfies the provided schema. Copy values exactly as they appear in the document; "
    "never invent values that are not present."
)


@dataclass
class Attempt:
    n: int
    prompt: str
    response: str
    errors: list[str]
    input_tokens: int | None = None
    output_tokens: int | None = None


@dataclass
class ExtractionResult:
    data: dict[str, Any]
    model_ref: str
    attempts: list[Attempt] = field(default_factory=list)
    #: Reused from the step cache: no model call was made and `attempts` is empty.
    cached: bool = False
    #: Tool calls the model made before answering (drafting with tools; 0 otherwise).
    tool_calls: int = 0
    #: Rows each model call's validated reply returned, in call order (a step reading a repeating
    #: section calls once per occurrence); empty for a cache hit and for steps without rows.
    call_rows: tuple[int, ...] = ()


class ExtractionFailedError(Exception):
    """Every attempt returned invalid JSON or schema-invalid output (a document/spec problem)."""

    def __init__(self, extraction_id: str, attempts: list[Attempt]) -> None:
        last = attempts[-1].errors if attempts else []
        super().__init__(
            f"extraction {extraction_id!r} failed after {len(attempts)} attempts: {'; '.join(last[:5])}"
        )
        self.attempts = attempts


class OutputTruncatedError(ExtractionFailedError):
    """The model hit the output token limit. Retrying with a longer prompt cannot help; split
    the extraction (chunkPages) or raise its maxTokens."""

    def __init__(self, extraction_id: str, attempts: list[Attempt], max_tokens: int) -> None:
        Exception.__init__(
            self,
            f"extraction {extraction_id!r}: output truncated at {max_tokens} max tokens "
            "(split it with chunkPages or raise maxTokens)",
        )
        self.attempts = attempts


def validate(text: str, validator: Draft202012Validator) -> tuple[dict[str, Any] | None, list[str]]:
    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        return None, [f"response is not valid JSON: {exc}"]
    if not isinstance(data, dict):
        return None, ["response must be a JSON object"]
    errors = [
        f"{'/'.join(map(str, e.absolute_path)) or '<root>'}: {e.message}"
        for e in sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path))
    ]
    return (data if not errors else None), errors


def run_extraction(
    *,
    extraction_id: str,
    provider: LLMProvider,
    model_id: str,
    prompt: str,
    schema: dict[str, Any],
    max_attempts: int,
    images: tuple[bytes, ...] = (),
    max_tokens: int = 64000,
    system: str = SYSTEM_PROMPT,
    check: Callable[[dict[str, Any]], list[str]] | None = None,
    on_attempt: Callable[[int], None] | None = None,
    on_tokens: Callable[[int], None] | None = None,
    retry_note: str = "Return corrected JSON only.",
    transcript: list[dict[str, Any]] | None = None,
    checkpoint: Callable[[], None] | None = None,
) -> ExtractionResult:
    """Call the model, validate against the JSON Schema, and retry with the validation errors
    fed back until the output is valid or attempts run out. `check` adds rules JSON Schema
    cannot express; its errors are fed back the same way. `on_attempt(n)` is called before each
    model call (progress reporting). With `on_tokens` the reply streams and its estimated
    tokens so far are reported as they arrive (providers that cannot stream answer whole).
    `retry_note` ends a retry prompt, after the errors. `transcript` (drafting's model log), when
    given, is appended to as the calls go: the prompt, each reply, each rejection. `checkpoint`
    runs before every call (a cancel check)."""
    validator = Draft202012Validator(schema)
    entries: list[dict[str, Any]] = transcript if transcript is not None else []
    entries.append({"kind": "prompt", "text": prompt, "images": len(images)})
    # Only a counting caller asks to stream: every other call is made exactly as before.
    counting = {"on_tokens": on_tokens} if on_tokens is not None else {}
    attempts: list[Attempt] = []
    current_prompt = prompt
    for n in range(1, max_attempts + 1):
        if checkpoint is not None:
            checkpoint()
        if on_attempt is not None:
            on_attempt(n)
        result = provider.complete_json(
            model_id,
            CompletionRequest(
                system=system,
                prompt=current_prompt,
                json_schema=schema,
                schema_name=extraction_id,
                images=images,
                max_tokens=max_tokens,
            ),
            **counting,
        )
        entries.append(
            {
                "kind": "reply",
                "text": result.text,
                "inputTokens": result.input_tokens,
                "outputTokens": result.output_tokens,
            }
        )
        if result.truncated:
            attempts.append(
                Attempt(
                    n,
                    current_prompt,
                    result.text,
                    ["output truncated at max tokens"],
                    result.input_tokens,
                    result.output_tokens,
                )
            )
            raise OutputTruncatedError(extraction_id, attempts, max_tokens)
        data, errors = validate(result.text, validator)
        if data is not None and check is not None:
            errors = check(data)
            if errors:
                data = None
        attempts.append(
            Attempt(
                n, current_prompt, result.text, errors, result.input_tokens, result.output_tokens
            )
        )
        if data is not None:
            return ExtractionResult(data, f"{provider.name}/{model_id}", attempts)
        entries.append({"kind": "rejected", "errors": errors})
        if n < max_attempts:
            entries.append({"kind": "note", "text": "Asked again with these errors."})
        current_prompt = (
            f"{prompt}\n\nYour previous response was rejected:\n<previous_response>\n"
            f"{result.text}\n</previous_response>\n<validation_errors>\n"
            + "\n".join(errors)
            + f"\n</validation_errors>\n{retry_note}"
        )
    raise ExtractionFailedError(extraction_id, attempts)
