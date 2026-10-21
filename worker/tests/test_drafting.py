"""Drafting: context assembly (holdout never included) and the survey stage."""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import Any

import pytest
from pydantic import ValidationError

from ingest_worker.config import REPO_ROOT
from ingest_worker.draft_stages import REVISE_SCHEMA
from ingest_worker.drafting import (
    DRAFT_MAX_TOKENS,
    DRAFT_PROGRESS,
    MAX_CONTEXT_SAMPLES,
    MAX_SAMPLE_CHARS,
    SURVEY,
    SURVEY_SCHEMA,
    DraftParams,
    DraftSample,
    anchor_check,
    build_context,
    clamp_seen_in,
    select_failures,
)
from ingest_worker.llm.base import LLMError
from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, DocumentError, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.specs import load_specs
from ingest_worker.storage import (
    MemoryObjectStore,
    draft_log_key,
    drafting_key,
    prepared_text_key,
)
from ingest_worker.workbench import segment_with_timeout as real_segment

from .fakes import FakeProvider, FakeQueue

BRIEF = {
    "purpose": "Batch release records for QA",
    "outputs": "Protocol number, product, batches",
    "exampleOutput": "",
    "glossary": "PVP = process validation protocol",
    "variants": "",
    "rules": "Placeholders are null",
    "answers": [{"question": "Which copy?", "answer": "The executed one"}],
}
DRAFT = {
    "id": "letter",
    "version": 1,
    "name": "Letter",
    "document": {"sections": [{"id": "all", "anchor": "\\A"}]},
}
SURVEY_BODY = {
    "summary": "Process validation protocols.",
    "structure": [
        {"name": "Approvals", "description": "Signatures", "howToFind": "PROTOCOL APPROVAL"}
    ],
    "variants": ["Executed copy follows the blank one"],
    "candidates": [
        {
            "name": "protocol_number",
            "description": "Id",
            "where": "header",
            "kind": "field",
            "seenIn": {"n": 1, "of": 1},
        }
    ],
    "questions": [{"question": "Which copy?", "why": "Two copies"}],
}


def sample(role: str = "dev", text: str = "PROTOCOL APPROVAL\nPVP/23/003") -> DraftSample:
    return DraftSample(
        sample_id=f"s-{role}", filename=f"{role}.pdf", role=role, pages=[text, "page two"]
    )


def test_context_holds_rules_brief_draft_example_and_dev_text() -> None:
    context = build_context(
        brief=BRIEF, draft=DRAFT, samples=[sample()], example_yaml="id: example\n"
    )
    assert "Batch release records for QA" in context
    assert "Which copy?" in context and "The executed one" in context
    assert "PVP/23/003" in context and "[page 1]" in context and "[page 2]" in context
    assert "id: example" in context
    assert "anchor" in context  # the current draft as YAML
    assert "Python regular expression" in context  # the rules section explains anchors


def test_context_refuses_holdout_samples() -> None:
    with pytest.raises(ValueError, match="holdout"):
        build_context(
            brief=BRIEF, draft=None, samples=[sample(), sample("holdout")], example_yaml=None
        )


def test_long_samples_are_truncated_with_a_note() -> None:
    long = sample(text="x" * (MAX_SAMPLE_CHARS + 500))
    context = build_context(brief={}, draft=None, samples=[long], example_yaml=None)
    assert "truncated: " in context
    assert "x" * MAX_SAMPLE_CHARS not in context  # the sample block itself was cut


# --- the draft job ---------------------------------------------------------------------


def draft_job(**params: Any) -> ClaimedJob:
    base: dict[str, Any] = {
        "stage": "survey",
        "dataPolicy": "local",
        "briefVersion": 3,
        "brief": BRIEF,
        "draft": DRAFT,
        "samples": [{"sampleId": "s1", "filename": "a.pdf", "sha256": "sha-a", "role": "dev"}],
    }
    return ClaimedJob(
        id="job-d",
        document_id="",
        spec_id="letter",
        spec_version=0,
        bucket="",
        object_key="",
        model_override=None,
        attempts=1,
        max_attempts=3,
        task="draft",
        test=True,
        project_id="letter",
        params={**base, **params},
    )


def make(
    specs_dir: Path, location: str = "local"
) -> tuple[FakeProvider, MemoryObjectStore, PipelineDeps]:
    provider = FakeProvider("drafter")
    store = MemoryObjectStore()
    text = {
        "sha256": "sha-a",
        "pages": [{"number": 1, "text": "PROTOCOL APPROVAL\nPVP/23/003", "ocr": False}],
    }
    store.put("runs", prepared_text_key("sha-a"), json.dumps(text).encode(), "application/json")
    deps = PipelineDeps(
        store=store,
        specs=load_specs(specs_dir),
        models=ModelRegistry(
            {"drafter": provider},
            {"drafter": ProviderConfig(name="drafter", kind="openai-chat", location=location)},  # type: ignore[arg-type]
            {"draft": "drafter/big"},
        ),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        example_template="id: example\n",
    )
    return provider, store, deps


@pytest.mark.parametrize(("limit", "budget"), [(None, 16_000), (48_000, 48_000)])
def test_a_drafting_reply_may_use_its_models_output_limit(
    fixture_specs_dir: Path, limit: int | None, budget: int
) -> None:
    provider, _, deps = make(fixture_specs_dir)
    limits = {} if limit is None else {"big": limit}
    deps = dataclasses.replace(
        deps,
        models=ModelRegistry(
            {"drafter": provider},
            {"drafter": ProviderConfig(name="drafter", kind="openai-chat", location="local",
                                       maxOutputTokens=limits)},  # type: ignore[arg-type]
            {"draft": "drafter/big"},
        ),
    )  # fmt: skip
    provider.responses = [SURVEY_BODY]
    queue = FakeQueue(jobs=[draft_job()])
    run_once(queue, deps, "w1")
    assert queue.completed
    assert provider.calls[0][1].max_tokens == budget


def test_a_drafting_reply_cut_off_at_the_limit_says_where_to_raise_it(
    fixture_specs_dir: Path,
) -> None:
    from ingest_worker.llm.base import CompletionResult

    provider, _, deps = make(fixture_specs_dir)
    cut = CompletionResult(text='{"notes": "32 tables', model="big", truncated=True)
    provider.responses = [cut]
    queue = FakeQueue(jobs=[draft_job(stage="outputs")])
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert reason == (
        "The drafting model's reply was cut off at its output limit (16,000 tokens). "
        "An admin can raise the model's Max output tokens under Administration > Models, or the stage "
        "can be run again with less to propose."
    )
    assert "chunkPages" not in reason


def test_a_drafting_request_too_long_for_the_loaded_context_says_what_to_change(
    fixture_specs_dir: Path,
) -> None:
    from ingest_worker.llm.base import ContextExceededError

    provider, _, deps = make(fixture_specs_dir)
    provider.responses = [ContextExceededError("openai 400: Context size has been exceeded.")]
    queue = FakeQueue(jobs=[draft_job(stage="outputs")])
    run_once(queue, deps, "w1")
    assert not queue.failed and len(provider.calls) == 1
    [(_, reason)] = queue.reviewed
    assert reason == (
        "The drafting model's context window, as loaded on its server, is too small for this "
        "stage's request and its output limit (16,000 tokens). An admin can raise the model's "
        "context length on its server (e.g. LM Studio) or lower its Max output tokens under "
        "Administration > Models."
    )


def test_survey_job_writes_the_validated_body(fixture_specs_dir: Path) -> None:
    provider, store, deps = make(fixture_specs_dir)
    provider.responses = [SURVEY_BODY]
    queue = FakeQueue(jobs=[draft_job()])

    run_once(queue, deps, "w1")

    assert queue.completed == [("job-d", [])]
    result = json.loads(store.get("runs", drafting_key("letter", "job-d")))
    assert result == {
        "stage": "survey",
        "model": "drafter/big",
        "body": SURVEY_BODY,
        "usage": {"inputTokens": 10, "outputTokens": 5},
    }
    [(model, request)] = provider.calls
    assert model == "big"
    assert "PVP/23/003" in request.prompt and SURVEY.instructions in request.prompt
    assert request.json_schema == SURVEY.schema
    assert DRAFT_MAX_TOKENS == 16_000
    assert request.max_tokens == DRAFT_MAX_TOKENS
    # The model log replaces the per-attempt audit files for drafting.
    model_log = json.loads(store.get("runs", draft_log_key("job-d")))
    assert model_log["stage"] == "survey" and model_log["tools"] is False
    [round_] = model_log["rounds"]
    assert round_["label"] == "draft-survey"
    assert [e["kind"] for e in round_["entries"]] == ["prompt", "reply"]
    assert store.get_optional("runs", "job-d/draft-survey/attempt-1.json") is None
    assert not any(msg == "external model call" for _, _, msg in queue.events)  # local provider


def test_external_drafting_is_logged_with_the_samples_sent(fixture_specs_dir: Path) -> None:
    provider, _, deps = make(fixture_specs_dir, location="external")
    provider.responses = [SURVEY_BODY]
    queue = FakeQueue(jobs=[draft_job(dataPolicy="external")])
    run_once(queue, deps, "w1")
    [details] = [d for _, _, msg, d in queue.event_details if msg == "external model call"]
    assert details == {
        "stage": "survey",
        "model": "drafter/big",
        "samples": ["s1"],
        "referencedSamples": [],
    }


def test_local_only_project_never_reaches_an_external_drafter(fixture_specs_dir: Path) -> None:
    provider, _, deps = make(fixture_specs_dir, location="external")
    queue = FakeQueue(jobs=[draft_job()])
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "data policy" in reason
    assert provider.calls == []


def test_holdout_sample_in_params_is_refused_before_any_call(fixture_specs_dir: Path) -> None:
    provider, _, deps = make(fixture_specs_dir)
    samples = [{"sampleId": "h1", "filename": "h.pdf", "sha256": "sha-a", "role": "holdout"}]
    queue = FakeQueue(jobs=[draft_job(samples=samples)])
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "holdout" in reason
    assert provider.calls == []


def test_invalid_output_is_fed_back_then_needs_review(fixture_specs_dir: Path) -> None:
    provider, _, deps = make(fixture_specs_dir)
    provider.responses = ["not json", {"summary": "only this"}]
    queue = FakeQueue(jobs=[draft_job()])
    run_once(queue, deps, "w1")
    assert len(provider.calls) == 2
    assert "previous response was rejected" in provider.calls[1][1].prompt
    [(_, reason)] = queue.reviewed
    assert "draft-survey" in reason


PROGRESS_FIXTURE = REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "draft-progress.json"


def progress(queue: FakeQueue) -> list[dict[str, Any]]:
    return [d for _, _, msg, d in queue.event_details if msg == DRAFT_PROGRESS]


def expected_progress(case: str) -> list[dict[str, Any]]:
    cases: dict[str, list[dict[str, Any]]] = json.loads(PROGRESS_FIXTURE.read_text("utf-8"))
    return cases[case]


def test_a_survey_reports_reading_the_samples_and_each_model_call(
    fixture_specs_dir: Path,
) -> None:
    """Issue #151: a running survey says what it is doing (TS DraftProgressSchema, shared
    fixture draft-progress.json): the samples read, then each model call with its attempt."""
    provider, _, deps = make(fixture_specs_dir)
    provider.responses = ["not json", SURVEY_BODY]
    queue = FakeQueue(jobs=[draft_job()])
    run_once(queue, deps, "w1")
    assert queue.completed
    assert progress(queue) == expected_progress("surveyRetried")


def test_a_streamed_reply_reports_the_tokens_received_now_and_then(
    fixture_specs_dir: Path,
) -> None:
    """The model's reply streams: its growing token count is reported on the model phase,
    the first at once, then every 500 tokens (or 5 s), never every token."""
    provider, _, deps = make(fixture_specs_dir)
    provider.responses = [SURVEY_BODY]
    provider.token_stream = [10, 600, 700, 1300]
    queue = FakeQueue(jobs=[draft_job()])
    run_once(queue, deps, "w1")
    assert queue.completed
    assert progress(queue) == expected_progress("surveyStreamed")


def test_progress_is_advisory_a_failed_write_never_fails_the_survey(
    fixture_specs_dir: Path,
) -> None:
    provider, _, deps = make(fixture_specs_dir)
    provider.responses = [SURVEY_BODY]

    class Flaky(FakeQueue):
        def event(
            self, job_id: str, level: str, message: str, data: dict[str, Any] | None = None
        ) -> None:
            if message == DRAFT_PROGRESS:
                raise RuntimeError("database blip")
            super().event(job_id, level, message, data)

    queue = Flaky(jobs=[draft_job()])
    run_once(queue, deps, "w1")
    assert queue.completed == [("job-d", [])]


def test_transient_provider_errors_retry_the_job(fixture_specs_dir: Path) -> None:
    provider, _, deps = make(fixture_specs_dir)
    provider.responses = [LLMError("503 overloaded")]
    queue = FakeQueue(jobs=[draft_job()])
    run_once(queue, deps, "w1")
    assert queue.failed and "503" in queue.failed[0][1]


def test_unknown_stage_needs_review(fixture_specs_dir: Path) -> None:
    provider, _, deps = make(fixture_specs_dir)
    queue = FakeQueue(jobs=[draft_job(stage="references")])
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "stage" in reason and provider.calls == []


def test_only_the_first_eight_samples_are_sent_and_logged(fixture_specs_dir: Path) -> None:
    provider, store, deps = make(fixture_specs_dir, location="external")
    provider.responses = [SURVEY_BODY]
    samples = []
    for i in range(9):
        sha = f"sha-{i}"
        text = {"sha256": sha, "pages": [{"number": 1, "text": f"UNIQUE-TEXT-{i}", "ocr": False}]}
        store.put("runs", prepared_text_key(sha), json.dumps(text).encode(), "application/json")
        samples.append({"sampleId": f"s{i}", "filename": f"{i}.pdf", "sha256": sha, "role": "dev"})
    queue = FakeQueue(jobs=[draft_job(dataPolicy="external", samples=samples)])
    run_once(queue, deps, "w1")
    [details] = [d for _, _, msg, d in queue.event_details if msg == "external model call"]
    assert details["samples"] == [f"s{i}" for i in range(8)]
    prompt = provider.calls[0][1].prompt
    assert "UNIQUE-TEXT-7" in prompt and "UNIQUE-TEXT-8" not in prompt


def test_missing_prepared_text_needs_review_without_a_call(fixture_specs_dir: Path) -> None:
    provider, store, deps = make(fixture_specs_dir)
    store.delete("runs", prepared_text_key("sha-a"))
    queue = FakeQueue(jobs=[draft_job()])
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "prepared text" in reason
    assert provider.calls == []


OUTPUTS_BODY = {
    "notes": "",
    "changes": [
        {
            "op": "putField",
            "id": "protocol_number",
            "name": None,
            "type": "text",
            "description": "Protocol id, e.g. PVP/23/003",
            "enum": None,
            "columns": None,
            "reason": "header of every sample",
        }
    ],
}


def test_outputs_job_writes_typed_changes_and_sees_the_accepted_survey(
    fixture_specs_dir: Path,
) -> None:
    provider, store, deps = make(fixture_specs_dir)
    provider.responses = [OUTPUTS_BODY]
    queue = FakeQueue(jobs=[draft_job(stage="outputs", survey=SURVEY_BODY)])
    run_once(queue, deps, "w1")
    result = json.loads(store.get("runs", drafting_key("letter", "job-d")))
    assert result["body"]["changes"] == [
        {
            "op": "putField",
            "field": {"id": "protocol_number", "description": "Protocol id, e.g. PVP/23/003"},
            "reason": "header of every sample",
        }
    ]
    [(_, request)] = provider.calls
    assert "<survey>" in request.prompt and "Process validation protocols." in request.prompt


def test_steps_errors_are_fed_back_then_need_review(fixture_specs_dir: Path) -> None:
    provider, _, deps = make(fixture_specs_dir)
    bad = {
        "notes": "",
        "changes": [
            {
                "op": "putStep",
                "id": "head",
                "type": "extract",
                "fields": ["missing"],
                "table": None,
                "sections": ["all"],
                "instructions": None,
                "pageImages": None,
                "chunkPages": None,
                "keyColumn": None,
                "occurrenceMatch": None,
                "context": None,
                "description": None,
                "values": None,
                "reference": None,
                "aliases": None,
                "preamble": None,
                "reason": "r",
            }
        ],
    }
    provider.responses = [bad, bad]
    queue = FakeQueue(jobs=[draft_job(stage="steps")])
    run_once(queue, deps, "w1")
    assert len(provider.calls) == 2
    assert "unknown field" in provider.calls[1][1].prompt
    [(_, reason)] = queue.reviewed
    assert "unknown field" in reason


def test_steps_with_an_unusable_key_column_complete_with_a_note(
    fixture_specs_dir: Path,
) -> None:
    """A repeating section without a key cannot fill keyColumn: the stage drops it and says so
    rather than failing both attempts."""
    provider, store, deps = make(fixture_specs_dir)
    draft = {
        **DRAFT,
        "document": {"sections": [{"id": "all", "anchor": "^A", "repeat": True}]},
        "outputs": {"fields": [], "tables": [{"id": "results", "columns": [{"id": "batch"}]}]},
    }
    step = {
        "op": "putStep",
        "id": "results_step",
        "type": "extract",
        "fields": None,
        "table": "results",
        "sections": ["all"],
        "instructions": "Batch from the caption",
        "pageImages": None,
        "chunkPages": None,
        "keyColumn": "batch",
        "occurrenceMatch": None,
        "context": None,
        "description": None,
        "values": None,
        "reference": None,
        "aliases": None,
        "preamble": None,
        "reason": "r",
    }
    provider.responses = [{"notes": "", "changes": [step]}]
    queue = FakeQueue(jobs=[draft_job(stage="steps", draft=draft)])
    run_once(queue, deps, "w1")
    assert queue.completed and len(provider.calls) == 1, queue.reviewed
    body = json.loads(store.get("runs", drafting_key("letter", "job-d")))["body"]
    assert "keyColumn" not in body["changes"][0]["step"]
    assert "Ignored keyColumn on 'results_step'" in body["notes"]


def _step(op: str, id: str, sections: list[str] | None, fields: list[str] | None) -> dict[str, Any]:
    return {
        "op": op,
        "id": id,
        "type": "extract",
        "fields": fields,
        "table": None,
        "sections": sections,
        "instructions": None,
        "pageImages": None,
        "chunkPages": None,
        "keyColumn": None,
        "occurrenceMatch": None,
        "context": None,
        "description": None,
        "values": None,
        "reference": None,
        "aliases": None,
        "preamble": None,
        "reason": "r",
    }


#: A draft whose pipeline later Sections and Outputs changes broke: its step reads a removed
#: section and fills a removed field (project aqn1-co-val-2, job 2e33d6ab).
BROKEN_DRAFT = {
    **DRAFT,
    "document": {"sections": [{"id": "header", "anchor": "^Owning"}]},
    "outputs": {"fields": [{"id": "title"}], "tables": []},
    "pipeline": [
        {"id": "old_title", "type": "extract", "sections": ["all"], "fields": ["title", "compound"]}
    ],
}


def test_steps_prompt_names_the_drafts_own_pipeline_problems(fixture_specs_dir: Path) -> None:
    provider, _, deps = make(fixture_specs_dir)
    provider.responses = [
        {
            "notes": "",
            "changes": [
                _step("removeStep", "old_title", None, None),
                _step("putStep", "title", ["header"], ["title"]),
            ],
        }
    ]
    queue = FakeQueue(jobs=[draft_job(stage="steps", draft=BROKEN_DRAFT)])
    run_once(queue, deps, "w1")
    assert queue.completed, queue.reviewed
    prompt = provider.calls[0][1].prompt
    assert "<current_draft_problems>" in prompt
    problems = prompt.split("<current_draft_problems>")[1].split("</current_draft_problems>")[0]
    assert "step 'old_title': unknown section 'all'" in problems
    assert "step 'old_title': unknown field 'compound'" in problems
    assert "putStep with an existing id replaces that step" in problems


def test_a_valid_or_empty_pipeline_has_no_problems_block(fixture_specs_dir: Path) -> None:
    provider, _, deps = make(fixture_specs_dir)
    draft = {**BROKEN_DRAFT, "pipeline": []}  # a first Steps run: nothing is filled yet
    provider.responses = [
        {"notes": "", "changes": [_step("putStep", "title", ["header"], ["title"])]}
    ]
    queue = FakeQueue(jobs=[draft_job(stage="steps", draft=draft)])
    run_once(queue, deps, "w1")
    assert queue.completed, queue.reviewed
    assert "<current_draft_problems>" not in provider.calls[0][1].prompt


def test_a_drafting_retry_says_the_reply_replaces_the_previous_one(
    fixture_specs_dir: Path,
) -> None:
    """Attempt 1 removed the broken step, attempt 2 added its replacement but forgot the
    removal: the retry must say a reply is the whole proposal, not a patch on the last one."""
    provider, _, deps = make(fixture_specs_dir)
    provider.responses = [
        {"notes": "", "changes": [_step("removeStep", "old_title", None, None)]},
        {
            "notes": "",
            "changes": [
                _step("removeStep", "old_title", None, None),
                _step("putStep", "title", ["header"], ["title"]),
            ],
        },
    ]
    queue = FakeQueue(jobs=[draft_job(stage="steps", draft=BROKEN_DRAFT)])
    run_once(queue, deps, "w1")
    assert queue.completed, queue.reviewed
    retry = provider.calls[1][1].prompt.split("</validation_errors>")[1]
    assert "replaces your previous response entirely" in retry
    assert "repeat every change from it that you still want" in retry


def test_change_stage_without_a_draft_needs_review(fixture_specs_dir: Path) -> None:
    provider, _, deps = make(fixture_specs_dir)
    queue = FakeQueue(jobs=[draft_job(stage="outputs", draft=None)])
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    assert "needs the current draft" in reason and provider.calls == []


def sections_body(anchor: str) -> dict[str, Any]:
    return {
        "notes": "",
        "changes": [
            {
                "op": "putSection",
                "id": "approval",
                "anchor": anchor,
                "required": None,
                "description": None,
                "repeat": None,
                "key": None,
                "keyFrom": None,
                "copiesSelect": None,
                "reason": "r",
            }
        ],
    }


def test_sections_anchor_misses_are_fed_back_once_and_the_grid_is_kept(
    fixture_specs_dir: Path,
) -> None:
    provider, store, deps = make(fixture_specs_dir)
    provider.responses = [sections_body("^SIGNATURES"), sections_body("^PROTOCOL APPROVAL")]
    queue = FakeQueue(jobs=[draft_job(stage="sections")])
    run_once(queue, deps, "w1")
    assert len(provider.calls) == 2
    assert "matched none of the dev samples" in provider.calls[1][1].prompt
    body = json.loads(store.get("runs", drafting_key("letter", "job-d")))["body"]
    [row] = body["anchorCheck"]["samples"]
    assert {c["id"]: c["found"] for c in row["sections"]}["approval"] is True
    rounds = json.loads(store.get("runs", draft_log_key("job-d")))["rounds"]
    assert [r["label"] for r in rounds] == ["draft-sections", "draft-sections-anchors"]
    assert progress(queue) == expected_progress("sectionsAnchorRound")


TIMEOUT = "preview took longer than 10s; an anchor may backtrack catastrophically"


def test_sections_timeout_in_both_rounds_needs_review(
    fixture_specs_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def stub(*_a: Any, **_k: Any) -> dict[str, Any]:
        raise DocumentError(TIMEOUT)

    monkeypatch.setattr("ingest_worker.drafting.segment_with_timeout", stub)
    provider, store, deps = make(fixture_specs_dir)
    provider.responses = [sections_body("^A"), sections_body("^B")]
    queue = FakeQueue(jobs=[draft_job(stage="sections")])
    run_once(queue, deps, "w1")
    assert len(provider.calls) == 2
    assert "backtrack" in provider.calls[1][1].prompt
    [(_, reason)] = queue.reviewed
    assert "backtrack" in reason
    assert store.get_optional("runs", drafting_key("letter", "job-d")) is None


def test_sections_timeout_then_success_completes_with_the_grid(
    fixture_specs_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls = {"n": 0}

    def stub(*a: Any, **k: Any) -> dict[str, Any]:
        calls["n"] += 1
        if calls["n"] == 1:
            raise DocumentError(TIMEOUT)
        return real_segment(*a, **k)

    monkeypatch.setattr("ingest_worker.drafting.segment_with_timeout", stub)
    provider, store, deps = make(fixture_specs_dir)
    provider.responses = [sections_body("^A"), sections_body("^PROTOCOL APPROVAL")]
    queue = FakeQueue(jobs=[draft_job(stage="sections")])
    run_once(queue, deps, "w1")
    assert queue.completed and len(provider.calls) == 2
    body = json.loads(store.get("runs", drafting_key("letter", "job-d")))["body"]
    assert body["anchorCheck"]["samples"]


def put(sid: str, anchor: str, **section: Any) -> dict[str, Any]:
    return {
        "op": "putSection",
        "section": {"id": sid, "anchor": anchor, **section},
        "reason": "r",
    }


@pytest.mark.parametrize(
    ("changes", "expected"),
    [
        ([put("a", "^ONLYA")], ["section \"a\" is required but anchor '^ONLYA' missed: b.pdf"]),
        ([put("a", "^ONLYA", required=False)], []),
        ([put("a", "^NOWHERE")], ["section \"a\": anchor '^NOWHERE' matched none"]),
        (
            [put("a", "^NOWHERE"), {"op": "removeSection", "id": "a", "reason": "r"}],
            [],
        ),
        (
            [put("a", "^NOWHERE"), put("a", "^NOWHERE")],
            ["section \"a\": anchor '^NOWHERE' matched none"],
        ),
    ],
)
def test_anchor_check_misses(changes: list[dict[str, Any]], expected: list[str]) -> None:
    samples = [
        DraftSample("s1", "a.pdf", "dev", ["ONLYA here"]),
        DraftSample("s2", "b.pdf", "dev", ["nothing"]),
    ]
    draft = {"document": {"sections": [{"id": "all", "anchor": "\\A"}]}}
    grid, misses = anchor_check(samples, draft, {"notes": "", "changes": changes})
    assert grid is not None
    assert len(misses) == len(expected)
    assert all(e in m for m, e in zip(misses, expected, strict=True))


def _covalidation_check(changes: list[dict[str, Any]], pages: list[str] | None = None) -> list[str]:
    from .covalidation import PAGES

    samples = [DraftSample("s1", "a.pdf", "dev", pages or PAGES)]
    draft = {"document": {"sections": [{"id": "all", "anchor": r"\A"}]}}
    grid, misses = anchor_check(samples, draft, {"notes": "", "changes": changes})
    assert grid is not None
    return misses


def test_repeated_blocks_feedback_suggests_repeating_sections() -> None:
    plain = [put("appearance", r"^Table \d+:.*Appearance"), put("micro", r"^Table \d+:.*Microbial")]
    [miss] = _covalidation_check(plain)
    assert 'sections "appearance", "micro" each match 3 times in a.pdf' in miss
    assert "Set repeat true on each of these sections" in miss


def test_repeating_sections_are_not_reported_as_repeated_blocks() -> None:
    repeating = [
        put("appearance", r"^Table \d+:.*Appearance", repeat=True),
        put("micro", r"^Table \d+:.*Microbial", repeat=True),
    ]
    assert _covalidation_check(repeating) == []


def test_anchor_check_feeds_back_key_issues_of_repeating_sections() -> None:
    from .covalidation import edited

    batch = put("batch", r"^\d+\. STUDY", repeat=True, key=r"BATCH\s+(\w+)")
    table = put(
        "micro", r"^Table \d+:.*Microbial", repeat=True, key=r"Batch\s+(\w+)", keyFrom="batch"
    )
    misses = _covalidation_check([batch, table], edited("Microbial Purity", "Microbal Purity", 3))
    assert misses == ["a.pdf: micro: no occurrence for batch 4586785"]


def test_anchor_check_reports_an_invalid_key() -> None:
    misses = _covalidation_check([put("batch", r"^\d+\. STUDY", repeat=True, key="BATCH (")])
    assert len(misses) == 1 and misses[0].startswith('section "batch": key: ')


REPEATED = [
    "1. BATCH 101\nAssay Results\nrows\nDissolution Results\nrows\n",
    "2. BATCH 102\nAssay Results\nrows\nDissolution Results\nrows\n",
]


@pytest.mark.parametrize(
    ("changes", "expected"),
    [
        # Two sections that each start once per batch: later batches fall into the last one.
        (
            [put("assay", "^Assay"), put("dissolution", "^Dissolution")],
            [
                'sections "assay", "dissolution" each match 2 times in a.pdf: the document '
                "repeats a block"
            ],
        ),
        # One anchor that happens to match twice is not a repeated block.
        ([put("assay", "^Assay"), put("first", r"^1\. BATCH")], []),
        # One section over every block is what the feedback asks for.
        ([put("batches", r"^1\. BATCH")], []),
    ],
)
def test_anchor_check_reports_repeated_blocks(
    changes: list[dict[str, Any]], expected: list[str]
) -> None:
    samples = [DraftSample("s1", "a.pdf", "dev", REPEATED)]
    draft = {"document": {"sections": [{"id": "all", "anchor": r"\A"}]}}
    grid, misses = anchor_check(samples, draft, {"notes": "", "changes": changes})
    assert grid is not None
    assert len(misses) == len(expected)
    assert all(e in m for m, e in zip(misses, expected, strict=True))


WRAPPED = (
    "Table 1: Study A - Assay Results\nrows\n"
    "Table 2: Study A - Assay and Purity (HDPE\nbottle) Results\nrows\n"
    "Table 3: Study B - Assay Results\nrows\n"
    "Table 4: Study B - Assay and Purity (HDPE\nbottle) Results\nrows\n"
)


def _missed_key_check(anchor: str) -> list[str]:
    samples = [DraftSample("s1", "a.pdf", "dev", [WRAPPED])]
    draft = {"document": {"sections": [{"id": "all", "anchor": r"\A"}]}}
    changes = [put("result_tables", anchor, repeat=True, key=r"^\s*Table\s+(\d+):")]
    grid, misses = anchor_check(samples, draft, {"notes": "", "changes": changes})
    assert grid is not None
    return misses


def test_anchor_check_feeds_back_missed_keys() -> None:
    [miss] = _missed_key_check(r"^\s*Table\s+\d+:\s.*Results\s*$")
    assert miss.startswith(r'sections "result_tables" have key ^\s*Table\s+(\d+):')
    assert "finds keys 2, 4 in a.pdf that no anchor matched" in miss
    assert 'e.g. "Table 2: Study A - Assay and Purity (HDPE"' in miss
    assert "If these are headings of the kind this section reads, widen the anchor" in miss
    assert "look ahead across them" in miss
    assert (
        r"(for example ^\s*Table\s+\d+:(?=(?:(?!<first column header>)[\s\S]){0,400}?"
        r"<last word of the title>[ \t]*$)) rather than requiring the whole title" in miss
    )
    assert "\t" not in miss
    assert "If they are headings of a kind the recipe does not read, make the key match" in miss
    assert _missed_key_check(r"^\s*Table\s+\d+:") == []


def test_missed_key_feedback_caps_the_keys_named() -> None:
    from ingest_worker.drafting import missed_key_feedback

    keys = [str(n) for n in range(1, 16)]
    row = {
        "sampleId": "s1",
        "missedKeys": [{"sections": ["t"], "key": k, "line": f"Table {k}: x"} for k in keys],
        "missedKeysTotal": 36,
    }
    sections = [{"id": "t", "anchor": "^x", "key": r"^Table (\d+)"}]
    [line] = missed_key_feedback([row], {"t"}, {"s1": "a.pdf"}, sections)
    assert "keys 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 (and 26 more) in a.pdf" in line
    assert missed_key_feedback([row], set(), {"s1": "a.pdf"}, sections) == []


CONTENTS_AND_BODY = [
    "Contents\nTable\xa01: Study A....25\nTable\xa02: Study B....26\n",
    "Table\xa01:   Study A - Assay\nrows\n",
    "Table\xa02:   Study B - Assay\nrows\n",
]


def _tables_check(anchor: str) -> list[str]:
    samples = [DraftSample("s1", "a.pdf", "dev", CONTENTS_AND_BODY)]
    draft = {"document": {"sections": [{"id": "all", "anchor": r"\A"}]}}
    changes = [put("result_tables", anchor, repeat=True, key=r"^\s*Table\s+(\d+):")]
    grid, misses = anchor_check(samples, draft, {"notes": "", "changes": changes})
    assert grid is not None
    return misses


def test_anchor_check_feeds_back_keys_caught_more_than_once() -> None:
    [miss] = _tables_check(r"^Table\s+\d+:\s*Study")
    assert miss.startswith(
        'section "result_tables" reads keys 1, 2 more than once in a.pdf, e.g. key 1 at '
        'p.1 "Table\xa01: Study A....25" and p.2 "Table\xa01:   Study A - Assay".'
    )
    assert "table-of-contents entries" in miss
    assert "one occurrence per key" in miss
    assert _tables_check(r"^Table\s+\d+:[ \t]{2,}Study") == []


def test_repeated_key_feedback_caps_the_keys_named() -> None:
    from ingest_worker.drafting import repeated_key_feedback

    occurrences = [{"page": n, "line": f"Table {n}", "key": str(n)} for n in range(1, 31)]
    row = {
        "sampleId": "s1",
        "sections": [{"id": "t", "found": True, "occurrences": occurrences}],
        "repeatedKeys": [
            {"section": "t", "key": str(n), "occurrences": [n, n + 15]} for n in range(1, 13)
        ],
        "repeatedKeysTotal": 14,
    }
    [line] = repeated_key_feedback([row], {"t"}, {"s1": "a.pdf"})
    assert "reads keys 1, 2, 3, 4, 5, 6, 7, 8, 9, 10 (and 4 more) more than once in a.pdf" in line
    assert 'e.g. key 1 at p.1 "Table 1" and p.16 "Table 16".' in line
    assert repeated_key_feedback([row], set(), {"s1": "a.pdf"}) == []


def test_anchor_check_offers_the_no_break_space_fix() -> None:
    [miss] = _tables_check(r"^Table \d+:[ \t]{2,}")
    assert miss.startswith("section \"result_tables\": anchor '^Table \\\\d+:[ \\\\t]{2,}' matched")
    assert miss.endswith(
        r" Suggested anchor for a.pdf: ^Table\s\d+:[ \u00a0\t]{2,} (This sample writes "
        '"Table 1:   Study A - Assay" with a no-break space (U+00A0) where the anchor has a '
        "plain space.)"
    )


def test_sections_keep_the_last_misses_visible(fixture_specs_dir: Path) -> None:
    provider, store, deps = make(fixture_specs_dir)
    provider.responses = [sections_body("^SIGNATURES"), sections_body("^STILL WRONG")]
    queue = FakeQueue(jobs=[draft_job(stage="sections")])
    run_once(queue, deps, "w1")
    assert queue.completed and len(provider.calls) == 2
    body = json.loads(store.get("runs", drafting_key("letter", "job-d")))["body"]
    [row] = body["anchorCheck"]["samples"]
    assert {c["id"]: c["found"] for c in row["sections"]}["approval"] is False


REVISE_DRAFT = {
    **DRAFT,
    "outputs": {"fields": [{"id": "sender"}], "tables": []},
    "pipeline": [{"type": "extract", "id": "head", "fields": ["sender"], "sections": ["all"]}],
}


def revise_response() -> dict[str, Any]:
    """A putStep change in the revise schema's shape: unused payloads hold empty values."""
    props = REVISE_SCHEMA["properties"]["changes"]["items"]["properties"]
    kinds: dict[str, Any] = {"string": "", "array": [], "integer": 0, "boolean": True}
    change: dict[str, Any] = {"op": "putStep", "reason": "feedback"}
    change["answers"] = []
    for key in ("field", "table", "section", "step"):
        change[key] = {k: kinds[v["type"]] for k, v in props[key]["properties"].items()}
    change["step"] |= {
        "id": "head",
        "type": "extract",
        "fields": ["sender"],
        "sections": ["all"],
        "instructions": "Use the letterhead",
    }
    return {"notes": "", "changes": [change]}


def revise_prompt(fixture_specs_dir: Path, **params: Any) -> str:
    provider, store, deps = make(fixture_specs_dir)
    provider.responses = [revise_response()]
    queue = FakeQueue(jobs=[draft_job(stage="revise", draft=REVISE_DRAFT, **params)])
    run_once(queue, deps, "w1")
    assert queue.completed
    [(_, request)] = provider.calls
    body = json.loads(store.get("runs", drafting_key("letter", "job-d")))["body"]
    assert body["changes"][0]["step"]["instructions"] == "Use the letterhead"
    assert "anchorCheck" not in body
    return str(request.prompt)


def test_revise_job_sees_feedback_and_dev_failures(fixture_specs_dir: Path) -> None:
    feedback = [
        {
            "target": "field",
            "targetId": "sender",
            "sample": "a.pdf",
            "body": "Take the letterhead name",
        }
    ]
    failures = [
        {
            "sample": "a.pdf",
            "score": 0.5,
            "fields": [{"id": "sender", "expected": "Acme", "actual": "Bob"}],
            "tables": [],
        }
    ]
    prompt = revise_prompt(
        fixture_specs_dir, feedback=feedback, failures=failures, feedbackIds=["f1"]
    )
    assert "<feedback>" in prompt and "Take the letterhead name" in prompt
    assert "<evaluation_failures>" in prompt and '"actual": "Bob"' in prompt


def test_revise_drops_feedback_and_failures_for_samples_that_are_not_dev(
    fixture_specs_dir: Path,
) -> None:
    feedback = [
        {"target": "field", "targetId": "x", "sample": "a.pdf", "body": "keep sample note"},
        {"target": "field", "targetId": "x", "sample": "holdout.pdf", "body": "leaky note"},
        {"target": "step", "targetId": "head", "body": "keep general note"},
    ]
    failures = [
        {"sample": "a.pdf", "score": 0.1, "fields": [], "tables": []},
        {"sample": "holdout.pdf", "score": 0.2, "fields": [], "tables": []},
    ]
    prompt = revise_prompt(fixture_specs_dir, feedback=feedback, failures=failures)
    assert "keep sample note" in prompt and "keep general note" in prompt
    assert "leaky note" not in prompt and "holdout.pdf" not in prompt


def test_revise_caps_failures_at_the_context_sample_limit(fixture_specs_dir: Path) -> None:
    failures = [
        {"sample": "a.pdf", "score": i / 100, "fields": [], "tables": []} for i in range(12)
    ]
    prompt = revise_prompt(fixture_specs_dir, failures=failures)
    assert prompt.count('"sample": "a.pdf"') == MAX_CONTEXT_SAMPLES


def test_revise_sends_the_lowest_scoring_failures_and_logs_every_sample_referenced(
    fixture_specs_dir: Path,
) -> None:
    provider, store, deps = make(fixture_specs_dir, location="external")
    provider.responses = [revise_response()]
    samples = []
    for i in range(MAX_CONTEXT_SAMPLES + 1):
        sha = f"sha-{i}"
        text = {"sha256": sha, "pages": [{"number": 1, "text": f"TEXT-{i}", "ocr": False}]}
        store.put("runs", prepared_text_key(sha), json.dumps(text).encode(), "application/json")
        samples.append({"sampleId": f"s{i}", "filename": f"{i}.pdf", "sha256": sha, "role": "dev"})
    # Highest scores first: the 9th sample (8.pdf) fails worst and must survive the cap.
    failures = [
        {"sample": f"{i}.pdf", "score": 0.9 - i / 100, "fields": [], "tables": []}
        for i in range(MAX_CONTEXT_SAMPLES + 1)
    ]
    feedback = [{"target": "field", "targetId": "sender", "sample": "7.pdf", "body": "note"}]
    queue = FakeQueue(
        jobs=[
            draft_job(
                stage="revise",
                dataPolicy="external",
                draft=REVISE_DRAFT,
                samples=samples,
                failures=failures,
                feedback=feedback,
            )
        ]
    )
    run_once(queue, deps, "w1")
    assert queue.completed
    [details] = [d for _, _, msg, d in queue.event_details if msg == "external model call"]
    assert details["samples"] == [f"s{i}" for i in range(MAX_CONTEXT_SAMPLES)]
    sent = [f"{i}.pdf" for i in range(1, MAX_CONTEXT_SAMPLES + 1)]  # 0.pdf scored highest
    assert details["referencedSamples"] == sorted(sent)
    prompt = str(provider.calls[0][1].prompt)
    assert '"sample": "8.pdf"' in prompt and '"sample": "0.pdf"' not in prompt


@pytest.mark.parametrize(
    ("model", "shown"),
    [("fast", "fast"), (None, "template")],  # None: the template's own step models
)
def test_revise_failures_header_names_the_iteration_they_came_from(
    fixture_specs_dir: Path, model: str | None, shown: str
) -> None:
    failures = [{"sample": "a.pdf", "score": 0.5, "fields": [], "tables": []}]
    prompt = revise_prompt(
        fixture_specs_dir,
        failures=failures,
        failuresFrom={"templateVersion": 3, "model": model},
    )
    assert f'<evaluation_failures templateVersion="3" model="{shown}">' in prompt


DIAGNOSTICS: dict[str, Any] = {
    "from": {"draftVersion": 4, "jobIds": ["j1"], "at": "2026-10-21T10:00:00.000Z"},
    "steps": [{"step": "head", "sample": "a.pdf", "calls": 5, "emptyCalls": 4, "seconds": 2}],
    "columns": [],
    "missedKeys": [],
}


def test_context_includes_run_diagnostics(fixture_specs_dir: Path) -> None:
    prompt = revise_prompt(fixture_specs_dir, diagnostics=DIAGNOSTICS)
    assert '<run_diagnostics draftVersion="4">' in prompt
    assert '"emptyCalls": 4' in prompt and "</run_diagnostics>" in prompt
    # Job ids and the run time are for people (the preview), not the model.
    block = prompt.split("<run_diagnostics", 1)[1].split("</run_diagnostics>", 1)[0]
    assert "jobIds" not in block and '"at"' not in block and '"from"' not in block
    assert json.loads(block.split(">", 1)[1]) == {
        k: DIAGNOSTICS[k] for k in ("steps", "columns", "missedKeys")
    }
    assert "<run_diagnostics" not in revise_prompt(fixture_specs_dir)
    assert "<run_diagnostics" not in build_context(
        brief={}, draft=None, samples=[], example_yaml=None, diagnostics=None
    )


def diag_row(sample: str) -> dict[str, Any]:
    return {"step": "head", "sample": sample, "calls": 5, "emptyCalls": 4, "seconds": 1}


def diag_column(*samples: str) -> dict[str, Any]:
    return {
        "step": "s",
        "target": "items",
        "column": f"col-{samples[0]}",
        "issues": 1,
        "examples": ["x"],
        "message": "not a number",
        "samples": list(samples),
    }


def diag_keys(sample: str) -> dict[str, Any]:
    return {"sample": sample, "sections": ["kinds"], "keys": [f"K-{sample}"], "total": 1}


def test_revise_drops_diagnostics_rows_of_samples_that_are_not_dev(
    fixture_specs_dir: Path,
) -> None:
    mixed = {
        "from": {"draftVersion": 4, "jobIds": ["j1"], "at": "2026-10-21T10:00:00.000Z"},
        "steps": [diag_row("a.pdf"), diag_row("h.pdf")],
        "columns": [diag_column("a.pdf"), diag_column("a.pdf", "h.pdf")],
        "missedKeys": [diag_keys("a.pdf"), diag_keys("h.pdf")],
    }
    prompt = revise_prompt(fixture_specs_dir, diagnostics=mixed)
    block = prompt.split("<run_diagnostics", 1)[1].split("</run_diagnostics>", 1)[0]
    assert "h.pdf" not in block
    assert '"sample": "a.pdf"' in block and "col-a.pdf" in block and "K-a.pdf" in block
    holdout_only = {
        **mixed,
        "steps": [diag_row("h.pdf")],
        "columns": [diag_column("h.pdf")],
        "missedKeys": [diag_keys("h.pdf")],
    }
    assert "<run_diagnostics" not in revise_prompt(fixture_specs_dir, diagnostics=holdout_only)


def test_external_revise_lists_the_samples_its_diagnostics_name(fixture_specs_dir: Path) -> None:
    provider, store, deps = make(fixture_specs_dir, location="external")
    provider.responses = [revise_response()]
    samples = [{"sampleId": "s1", "filename": "a.pdf", "sha256": "sha-a", "role": "dev"}]
    for name in ("b", "c", "d"):
        text = {"sha256": f"sha-{name}", "pages": [{"number": 1, "text": name, "ocr": False}]}
        store.put(
            "runs", prepared_text_key(f"sha-{name}"), json.dumps(text).encode(), "application/json"
        )
        samples.append(
            {"sampleId": f"s-{name}", "filename": f"{name}.pdf", "sha256": f"sha-{name}",
             "role": "dev"}
        )  # fmt: skip
    diagnostics = {
        "from": {"draftVersion": 4, "jobIds": ["j1"], "at": "2026-10-21T10:00:00.000Z"},
        "steps": [diag_row("b.pdf")],
        "columns": [diag_column("c.pdf")],
        "missedKeys": [diag_keys("d.pdf")],
    }
    queue = FakeQueue(
        jobs=[
            draft_job(
                stage="revise",
                dataPolicy="external",
                draft=REVISE_DRAFT,
                samples=samples,
                diagnostics=diagnostics,
            )
        ]
    )
    run_once(queue, deps, "w1")
    assert queue.completed
    [details] = [d for _, _, msg, d in queue.event_details if msg == "external model call"]
    assert details["referencedSamples"] == ["b.pdf", "c.pdf", "d.pdf"]


def test_draft_params_accept_diagnostics() -> None:
    base: dict[str, Any] = {"stage": "revise", "dataPolicy": "local", "brief": {}, "samples": []}
    assert DraftParams.model_validate({**base, "diagnostics": DIAGNOSTICS}).diagnostics
    assert DraftParams.model_validate(base).diagnostics is None
    with pytest.raises(ValidationError):
        DraftParams.model_validate({**base, "bogus": 1})


def revise_section_response(anchor: str) -> dict[str, Any]:
    response = revise_response()
    [change] = response["changes"]
    change["op"] = "putSection"  # only the section payload is read for putSection
    change["section"] |= {"id": "all", "anchor": anchor, "required": True, "repeat": False}
    return response


def test_revise_section_changes_get_one_timeout_check(
    fixture_specs_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    seen: list[Any] = []

    def stub(*a: Any, **_k: Any) -> dict[str, Any]:
        seen.append(a)
        raise DocumentError(TIMEOUT)

    monkeypatch.setattr("ingest_worker.drafting.segment_with_timeout", stub)
    provider, store, deps = make(fixture_specs_dir)
    provider.responses = [revise_section_response("^(a+)+$")]
    queue = FakeQueue(jobs=[draft_job(stage="revise", draft=REVISE_DRAFT)])
    run_once(queue, deps, "w1")
    assert len(provider.calls) == 1  # no feedback round
    [(_, reason)] = queue.reviewed
    assert "backtrack" in reason
    [(pages, _doc)] = seen
    assert pages == [("s1", ["PROTOCOL APPROVAL\nPVP/23/003"])]
    assert store.get_optional("runs", drafting_key("letter", "job-d")) is None


def test_revise_section_change_that_segments_in_time_stores_no_anchor_check(
    fixture_specs_dir: Path,
) -> None:
    provider, store, deps = make(fixture_specs_dir)
    provider.responses = [revise_section_response("^PROTOCOL")]
    queue = FakeQueue(jobs=[draft_job(stage="revise", draft=REVISE_DRAFT)])
    run_once(queue, deps, "w1")
    assert queue.completed and len(provider.calls) == 1
    body = json.loads(store.get("runs", drafting_key("letter", "job-d")))["body"]
    assert body["changes"][0]["op"] == "putSection" and "anchorCheck" not in body


def test_revise_without_section_changes_never_segments(
    fixture_specs_dir: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def stub(*_a: Any, **_k: Any) -> dict[str, Any]:
        raise AssertionError("segmented a revise without section changes")

    monkeypatch.setattr("ingest_worker.drafting.segment_with_timeout", stub)
    revise_prompt(fixture_specs_dir)


def test_survey_schema_asks_for_seen_in_on_every_candidate() -> None:
    item = SURVEY_SCHEMA["properties"]["candidates"]["items"]
    assert "seenIn" in item["required"]
    assert item["properties"]["seenIn"]["required"] == ["n", "of"]
    assert "In how many" in SURVEY.instructions


@pytest.mark.parametrize(
    ("seen", "samples", "expected"),
    [
        ({"n": 2, "of": 3}, 3, {"n": 2, "of": 3}),
        ({"n": 9, "of": 12}, 4, {"n": 4, "of": 4}),  # `of` is what was sent, n within it
        ({"n": -1, "of": 2}, 2, {"n": 0, "of": 2}),
        ({"n": 1, "of": 0}, 0, {"n": 0, "of": 0}),
    ],
)
def test_clamp_seen_in(seen: dict[str, int], samples: int, expected: dict[str, int]) -> None:
    body = {**SURVEY_BODY, "candidates": [{**SURVEY_BODY["candidates"][0], "seenIn": seen}]}
    assert clamp_seen_in(body, samples)["candidates"][0]["seenIn"] == expected
    assert body["candidates"][0]["seenIn"] == seen  # not mutated


def test_survey_job_stores_seen_in_against_the_samples_sent(fixture_specs_dir: Path) -> None:
    provider, store, deps = make(fixture_specs_dir)
    candidate = {**SURVEY_BODY["candidates"][0], "seenIn": {"n": 5, "of": 6}}
    provider.responses = [{**SURVEY_BODY, "candidates": [candidate]}]
    queue = FakeQueue(jobs=[draft_job()])

    run_once(queue, deps, "w1")

    result = json.loads(store.get("runs", drafting_key("letter", "job-d")))
    assert result["body"]["candidates"][0]["seenIn"] == {"n": 1, "of": 1}


FAILURES_FIXTURE = REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "revise-failures.json"
FAILURE_CASES: list[dict[str, Any]] = json.loads(FAILURES_FIXTURE.read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", FAILURE_CASES, ids=[c["name"] for c in FAILURE_CASES])
def test_select_failures_matches_the_shared_fixture(case: dict[str, Any]) -> None:
    picked = select_failures(case["failures"], set(case["dev"]))
    assert [f["sample"] for f in picked] == case["expected"]


def test_revise_labels_feedback_and_stores_the_ids_a_change_answers(
    fixture_specs_dir: Path,
) -> None:
    provider, store, deps = make(fixture_specs_dir)
    response = revise_response()
    response["changes"][0]["answers"] = ["F2", "f1", "F9", "F2"]
    provider.responses = [response]
    feedback = [
        {"id": "fb-1", "target": "field", "targetId": "sender", "sample": None, "body": "one"},
        {"id": "fb-2", "target": "step", "targetId": "head", "sample": None, "body": "two"},
    ]
    job = draft_job(
        stage="revise", draft=REVISE_DRAFT, feedback=feedback, feedbackIds=["fb-1", "fb-2"]
    )
    queue = FakeQueue(jobs=[job])
    run_once(queue, deps, "w1")
    assert queue.completed
    prompt = str(provider.calls[0][1].prompt)
    assert "- F1 [field sender]: one" in prompt and "- F2 [step head]: two" in prompt
    change_props = provider.calls[0][1].json_schema["properties"]["changes"]["items"]["properties"]
    assert change_props["answers"]["type"] == "array"
    body = json.loads(store.get("runs", drafting_key("letter", "job-d")))["body"]
    assert body["changes"][0]["answers"] == ["fb-2", "fb-1"]


def test_revise_change_without_answers_is_stored_without_them(fixture_specs_dir: Path) -> None:
    provider, store, deps = make(fixture_specs_dir)
    provider.responses = [revise_response()]
    feedback = [{"id": "fb-1", "target": "field", "targetId": "sender", "body": "one"}]
    queue = FakeQueue(jobs=[draft_job(stage="revise", draft=REVISE_DRAFT, feedback=feedback)])
    run_once(queue, deps, "w1")
    body = json.loads(store.get("runs", drafting_key("letter", "job-d")))["body"]
    assert "answers" not in body["changes"][0]


def test_revise_job_whose_feedback_has_no_ids_still_runs(fixture_specs_dir: Path) -> None:
    # Jobs queued before RV2 carry feedback without an id: answers resolve to nothing, no crash.
    provider, store, deps = make(fixture_specs_dir)
    response = revise_response()
    response["changes"][0]["answers"] = ["F1"]
    provider.responses = [response]
    feedback = [{"target": "field", "targetId": "sender", "sample": None, "body": "one"}]
    queue = FakeQueue(jobs=[draft_job(stage="revise", draft=REVISE_DRAFT, feedback=feedback)])
    run_once(queue, deps, "w1")
    assert queue.completed
    body = json.loads(store.get("runs", drafting_key("letter", "job-d")))["body"]
    assert "answers" not in body["changes"][0]


def test_a_survey_queues_its_ontology_suggestions_and_finishes(fixture_specs_dir: Path) -> None:
    """The survey finishes when the model replies: matching its candidates against the library
    (minutes on a large one) is a `suggest` job of its own, whose record is the survey's."""
    from ingest_worker.queue import ClaimedJob
    from ingest_worker.storage import ontology_suggestions_key

    from .test_ontology_suggest import library_store

    provider, store, deps = make(fixture_specs_dir)
    ontologies, _ = library_store()
    searched: list[str] = []
    lexical = ontologies.lexical_best
    ontologies.lexical_best = lambda *a, **k: searched.append("x") or lexical(*a, **k)  # type: ignore[method-assign]
    deps = dataclasses.replace(deps, ontologies=ontologies)
    body = {**SURVEY_BODY, "candidates": [
        {"name": "active_substance", "description": "", "where": "", "kind": "table", "seenIn": {"n": 1, "of": 1}},
        {"name": "batch_number", "description": "", "where": "", "kind": "field", "seenIn": {"n": 1, "of": 1}},
    ]}  # fmt: skip
    provider.responses = [body]
    library = [{"id": "domain", "version": 1, "label": "Domain", "terms": 3}]
    pinned = [{"ontologyId": "domain", "version": 1}]
    queue = FakeQueue(jobs=[draft_job(library=library, pinned=pinned)])
    run_once(queue, deps, "w1")

    assert queue.completed and searched == []  # nothing matched while the survey ran
    assert progress(queue) == expected_progress("surveyWithLibrary")
    assert store.get_optional("runs", ontology_suggestions_key("letter", "job-d")) is None
    [(project, params)] = queue.suggested
    assert project == "letter"
    assert params == {
        "surveyProposalId": "job-d",
        "candidates": [
            {"name": "active_substance", "description": "", "kind": "table"},
            {"name": "batch_number", "description": "", "kind": "field"},
        ],
        "library": library,
        "pinned": pinned,
        "dataPolicy": "local",
    }

    suggest = ClaimedJob(
        "job-s", "", "letter", 0, "", "", None, 1, 3, task="suggest", project_id="letter",
        params=params,
    )  # fmt: skip
    queue = FakeQueue(jobs=[suggest])
    run_once(queue, deps, "w1")
    record = json.loads(store.get("runs", ontology_suggestions_key("letter", "job-s")))
    assert record["surveyProposalId"] == "job-d"
    assert [s["ontologyId"] for s in record["pinned"]] == ["domain"]


def test_a_survey_replaces_the_projects_earlier_suggest_job_and_its_record(
    fixture_specs_dir: Path,
) -> None:
    """One `suggest` job per project, as the API's Refresh keeps it: the one it replaces goes,
    with its record."""
    from ingest_worker.storage import ontology_suggestions_key

    from .test_ontology_suggest import library_store

    provider, store, deps = make(fixture_specs_dir)
    ontologies, _ = library_store()
    deps = dataclasses.replace(deps, ontologies=ontologies)
    store.put("runs", ontology_suggestions_key("letter", "old-s"), b"{}", "application/json")
    provider.responses = [SURVEY_BODY]
    library = [{"id": "domain", "version": 1, "label": "Domain", "terms": 3}]
    queue = FakeQueue(jobs=[draft_job(library=library)])
    queue.suggest_removed = ["old-s"]
    run_once(queue, deps, "w1")
    assert queue.completed and len(queue.suggested) == 1
    assert store.get_optional("runs", ontology_suggestions_key("letter", "old-s")) is None


def test_a_survey_whose_suggestions_cannot_be_queued_still_finishes(
    fixture_specs_dir: Path,
) -> None:
    from .test_ontology_suggest import library_store

    provider, store, deps = make(fixture_specs_dir)
    ontologies, _ = library_store()
    deps = dataclasses.replace(deps, ontologies=ontologies)
    provider.responses = [SURVEY_BODY]
    library = [{"id": "domain", "version": 1, "label": "Domain", "terms": 3}]
    queue = FakeQueue(jobs=[draft_job(library=library)])
    queue.suggest_error = ConnectionError("database went away")
    run_once(queue, deps, "w1")
    assert queue.completed
    assert store.get("runs", drafting_key("letter", "job-d"))
    assert any(e[2] == "ontology suggestions failed" for e in queue.events)


def test_survey_without_a_library_writes_no_suggestions(fixture_specs_dir: Path) -> None:
    from ingest_worker.storage import ontology_suggestions_key

    provider, store, deps = make(fixture_specs_dir)
    provider.responses = [SURVEY_BODY]
    queue = FakeQueue(jobs=[draft_job()])
    run_once(queue, deps, "w1")
    assert store.get_optional("runs", ontology_suggestions_key("letter", "job-d")) is None
    assert queue.suggested == []


@pytest.mark.parametrize(
    ("calls", "reported"),
    [
        # (seconds, tokens): the first at once, then +500 tokens or 5 s later, never twice.
        ([(0, 10), (1, 300), (2, 510), (3, 600)], [10, 510]),
        ([(0, 10), (6, 40)], [10, 40]),
        ([(0, 10), (6, 10)], [10]),  # no new tokens: nothing new to say
    ],
)
def test_token_throttle(calls: list[tuple[float, int]], reported: list[int]) -> None:
    from ingest_worker.drafting import TokenThrottle

    now = [0.0]
    seen: list[int] = []
    throttle = TokenThrottle(seen.append, clock=lambda: now[0])
    for at, tokens in calls:
        now[0] = at
        throttle(tokens)
    assert seen == reported
