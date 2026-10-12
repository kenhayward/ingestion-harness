from __future__ import annotations

import dataclasses

import pytest

from ingest_worker.extract import ExtractionFailedError, run_extraction
from ingest_worker.llm.base import LLMError

from .fakes import FakeProvider

SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["total"],
    "properties": {"total": {"type": "number"}},
}


def extract(provider: FakeProvider, max_attempts: int = 2):  # type: ignore[no-untyped-def]
    return run_extraction(
        extraction_id="totals",
        provider=provider,
        model_id="m1",
        prompt="extract",
        schema=SCHEMA,
        max_attempts=max_attempts,
    )


def test_returns_valid_output_first_time() -> None:
    provider = FakeProvider(responses=[{"total": 12.5}])
    result = extract(provider)
    assert result.data == {"total": 12.5}
    assert result.model_ref == "fake/m1"
    assert len(result.attempts) == 1
    assert provider.calls[0][1].json_schema == SCHEMA


def test_retries_with_validation_errors_fed_back() -> None:
    provider = FakeProvider(responses=[{"total": "twelve"}, {"total": 12}])
    result = extract(provider)
    assert result.data == {"total": 12}
    retry_prompt = provider.calls[1][1].prompt
    assert "twelve" in retry_prompt and "is not of type 'number'" in retry_prompt


def test_retries_on_non_json() -> None:
    provider = FakeProvider(responses=["not json", {"total": 1}])
    assert extract(provider).data == {"total": 1}


def test_raises_after_max_attempts() -> None:
    provider = FakeProvider(responses=[{"x": 1}, {"y": 2}])
    with pytest.raises(ExtractionFailedError) as exc:
        extract(provider)
    assert len(exc.value.attempts) == 2


def test_transient_provider_errors_propagate() -> None:
    with pytest.raises(LLMError):
        extract(FakeProvider(responses=[LLMError("429")]))


def test_truncated_output_raises_without_retrying() -> None:
    from ingest_worker.extract import OutputTruncatedError

    class Truncating(FakeProvider):
        def complete_json(self, model, request):  # type: ignore[no-untyped-def]
            result = super().complete_json(model, request)
            return dataclasses.replace(result, truncated=True)

    provider = Truncating(responses=['{"total": 1', '{"total": 1}'])
    with pytest.raises(OutputTruncatedError, match="max tokens"):
        extract(provider, max_attempts=3)
    assert len(provider.calls) == 1  # a longer retry prompt can only make it worse


def test_check_errors_are_fed_back_like_schema_errors() -> None:
    provider = FakeProvider("p", responses=[{"n": 1}, {"n": 2}])
    result = run_extraction(
        extraction_id="x",
        provider=provider,
        model_id="m",
        prompt="P",
        schema={"type": "object"},
        max_attempts=2,
        check=lambda data: [] if data["n"] == 2 else ["n must be 2"],
    )
    assert result.data == {"n": 2}
    assert result.attempts[0].errors == ["n must be 2"]
    assert "n must be 2" in provider.calls[1][1].prompt


def test_check_failing_every_attempt_raises() -> None:
    provider = FakeProvider("p", responses=[{"n": 1}, {"n": 1}])
    with pytest.raises(ExtractionFailedError, match="n must be 2"):
        run_extraction(
            extraction_id="x",
            provider=provider,
            model_id="m",
            prompt="P",
            schema={"type": "object"},
            max_attempts=2,
            check=lambda data: ["n must be 2"],
        )
