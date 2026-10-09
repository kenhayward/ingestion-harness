from __future__ import annotations

import json
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


class ExtractionFailedError(Exception):
    """Every attempt returned invalid JSON or schema-invalid output (a document/spec problem)."""

    def __init__(self, extraction_id: str, attempts: list[Attempt]) -> None:
        last = attempts[-1].errors if attempts else []
        super().__init__(
            f"extraction {extraction_id!r} failed after {len(attempts)} attempts: {'; '.join(last[:5])}"
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
) -> ExtractionResult:
    """Call the model, validate against the JSON Schema, and retry with the validation errors
    fed back until the output is valid or attempts run out."""
    validator = Draft202012Validator(schema)
    attempts: list[Attempt] = []
    current_prompt = prompt
    for n in range(1, max_attempts + 1):
        result = provider.complete_json(
            model_id,
            CompletionRequest(
                system=SYSTEM_PROMPT,
                prompt=current_prompt,
                json_schema=schema,
                schema_name=extraction_id,
                images=images,
            ),
        )
        data, errors = validate(result.text, validator)
        attempts.append(
            Attempt(
                n, current_prompt, result.text, errors, result.input_tokens, result.output_tokens
            )
        )
        if data is not None:
            return ExtractionResult(data, f"{provider.name}/{model_id}", attempts)
        current_prompt = (
            f"{prompt}\n\nYour previous response was rejected:\n<previous_response>\n"
            f"{result.text}\n</previous_response>\n<validation_errors>\n"
            + "\n".join(errors)
            + "\n</validation_errors>\nReturn corrected JSON only."
        )
    raise ExtractionFailedError(extraction_id, attempts)
