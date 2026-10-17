"""A model the server does not have (not downloaded, not loaded, a typo) is a configuration
problem: a retry repeats it. Every adapter raises ModelUnavailableError for it, and every job
that meets it goes to review at once with what to change, instead of retrying with backoff."""

from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace
from typing import Any

import httpx
import openai
import pytest

from ingest_worker.llm.anthropic_provider import AnthropicProvider
from ingest_worker.llm.base import (
    ConversationRequest,
    Message,
    ModelUnavailableError,
    is_model_unavailable,
)
from ingest_worker.llm.openai_providers import OpenAIChatProvider, OpenAIResponsesProvider
from ingest_worker.main import run_once

from .fakes import FakeQueue
from .test_pipeline import setup  # noqa: F401  (the pipeline fixture)
from .test_providers import CONTEXT_EXCEEDED, NOT_CONTEXT, REQ, VISION_REQ, Raising

LM_STUDIO = (
    'Invalid model identifier "qwen3.8-27b-mtp". Please specify a valid downloaded model '
    "(e.g., allenai/olmocr-2-7b@q4_k_m, allenai/olmocr-2-7b, olmocr-2-7b-1025)."
)
MISSING = [
    pytest.param(400, LM_STUDIO, id="lm-studio"),
    pytest.param(
        404,
        "The model `gpt-9` does not exist or you do not have access to it.",
        id="openai",
    ),
    pytest.param(404, "The model `qwen-x` does not exist.", id="vllm"),
    pytest.param(404, 'model "llama9" not found, try pulling it first', id="ollama"),
    pytest.param(400, "model 'qwen-x' not found", id="llama-cpp"),
]


@pytest.mark.parametrize(("status", "message"), MISSING)
def test_server_wordings_for_a_missing_model(status: int, message: str) -> None:
    assert is_model_unavailable(message)


@pytest.mark.parametrize(
    "message",
    [*(p.values[0] for p in NOT_CONTEXT), *(p.values[1] for p in CONTEXT_EXCEEDED)],
)
def test_other_errors_are_not_a_missing_model(message: str) -> None:
    assert not is_model_unavailable(message)


def status_error(status: int, message: str) -> Exception:
    response = httpx.Response(status, request=httpx.Request("POST", "http://local/v1"))
    body = {"error": {"message": message, "type": "invalid_request_error"}}
    if status == 404:
        return openai.NotFoundError(message, response=response, body=body)
    return openai.BadRequestError(message, response=response, body=body)


CONVERSATION = ConversationRequest(system="s", messages=(Message("user", text="go"),), tools=())


@pytest.mark.parametrize(("status", "message"), MISSING)
def test_openai_chat_raises_model_unavailable_and_never_retries_whole(
    status: int, message: str
) -> None:
    completions = Raising(status_error(status, message))
    provider = OpenAIChatProvider(
        "local", SimpleNamespace(chat=SimpleNamespace(completions=completions))
    )  # type: ignore[arg-type]
    with pytest.raises(ModelUnavailableError, match="openai"):
        provider.complete_json("m", REQ)
    with pytest.raises(ModelUnavailableError):
        provider.complete_vision("m", VISION_REQ)
    before = completions.calls
    with pytest.raises(ModelUnavailableError):  # streamed: the 400 is not "cannot stream"
        provider.complete_json("m", REQ, on_tokens=lambda _n: None)
    assert completions.calls == before + 1
    with pytest.raises(ModelUnavailableError):
        provider.converse("m", CONVERSATION, on_tokens=lambda _n: None)


@pytest.mark.parametrize(("status", "message"), MISSING)
def test_openai_responses_raises_model_unavailable(status: int, message: str) -> None:
    responses = Raising(status_error(status, message))
    provider = OpenAIResponsesProvider("o", SimpleNamespace(responses=responses))  # type: ignore[arg-type]
    with pytest.raises(ModelUnavailableError):
        provider.complete_json("m", REQ)
    with pytest.raises(ModelUnavailableError):
        provider.converse("m", CONVERSATION)


def test_anthropic_raises_model_unavailable_for_an_unknown_model() -> None:
    import anthropic

    response = httpx.Response(404, request=httpx.Request("POST", "https://api.anthropic.com"))
    error = anthropic.NotFoundError(
        "model: claude-nope-9",
        response=response,
        body={
            "type": "error",
            "error": {"type": "not_found_error", "message": "model: claude-nope-9"},
        },
    )

    class RaisingStream:
        def stream(self, **_kwargs: Any) -> Any:
            raise error

    client: Any = SimpleNamespace(messages=RaisingStream())
    provider = AnthropicProvider("a", client, server_fallbacks=False)
    with pytest.raises(ModelUnavailableError, match="claude-nope-9"):
        provider.complete_json("claude-nope-9", REQ)
    with pytest.raises(ModelUnavailableError):
        provider.converse("claude-nope-9", CONVERSATION)


# --- jobs go to review at once ---------------------------------------------------------------

SERVER = f"openai 400: {LM_STUDIO}"


def test_a_drafting_model_missing_on_its_server_needs_review_at_once(
    fixture_specs_dir: Path,
) -> None:
    from .test_drafting import draft_job, make

    provider, _, deps = make(fixture_specs_dir)
    provider.responses = [ModelUnavailableError(SERVER)]
    queue = FakeQueue(jobs=[draft_job(stage="outputs")])
    run_once(queue, deps, "w1")
    assert not queue.failed and len(provider.calls) == 1  # never retried
    [(_, reason)] = queue.reviewed
    assert reason == (
        "The drafting model is not available on its server, so the stage cannot run: an admin "
        "can load it there (e.g. in LM Studio) or choose another drafting model under "
        f"Administration > Models. The server said: {SERVER}"
    )


def test_a_mapping_model_missing_on_its_server_needs_review_at_once(
    fixture_specs_dir: Path,
) -> None:
    from .test_mapping_stage import make, mapping_job, run

    drafting, _, _, deps = make(fixture_specs_dir, embedder=None, embedded=False)
    drafting.responses = [ModelUnavailableError(SERVER)]
    queue = run(deps, mapping_job())
    assert not queue.failed and len(drafting.calls) == 1
    [(_, reason)] = queue.reviewed
    assert reason.startswith("The drafting model is not available on its server")


def test_a_step_model_missing_on_its_server_needs_review_at_once(setup) -> None:  # type: ignore[no-untyped-def]  # noqa: F811
    from .test_pipeline import job

    provider, _, deps = setup
    provider.responses = [ModelUnavailableError(SERVER)]
    queue = FakeQueue(jobs=[job()])
    run_once(queue, deps, "w1")
    assert not queue.failed and len(provider.calls) == 1
    [(_, reason)] = queue.reviewed
    assert reason == (
        "extraction 'invoice_header': the model anthropic/claude-opus-5-5 is not available on "
        "its server; load it there (e.g. in LM Studio) or choose another model under "
        f"Administration > Models (server said: {SERVER})"
    )


def test_an_ocr_model_missing_on_its_server_needs_review_at_once(setup) -> None:  # type: ignore[no-untyped-def]  # noqa: F811
    from .fakes import FakeProvider
    from .test_pipeline import PAGES, job, with_ocr

    _, _, deps = setup
    ocr = FakeProvider("local")
    ocr.vision_responses = [ModelUnavailableError(SERVER)]
    with_ocr(deps, ocr)
    deps.extract_text = lambda _pdf: [PAGES[0], ""]
    queue = FakeQueue(jobs=[job()])
    run_once(queue, deps, "w1")
    assert not queue.failed
    [(_, reason)] = queue.reviewed
    assert reason.startswith(
        "OCR page 2: the model local/olmocr-2-7b-1025 is not available on its server"
    )
