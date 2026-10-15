"""Drafting: context assembly (holdout never included) and the survey stage."""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.config import REPO_ROOT
from ingest_worker.draft_stages import REVISE_SCHEMA
from ingest_worker.drafting import (
    DRAFT_MAX_TOKENS,
    MAX_CONTEXT_SAMPLES,
    MAX_SAMPLE_CHARS,
    SURVEY,
    SURVEY_SCHEMA,
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
from ingest_worker.storage import MemoryObjectStore, drafting_key, prepared_text_key
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
    assert store.get_optional("runs", "job-d/draft-survey/attempt-1.json") is not None
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
    assert store.get_optional("runs", "job-d/draft-sections-anchors/attempt-1.json") is not None


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


def revise_section_response(anchor: str) -> dict[str, Any]:
    response = revise_response()
    [change] = response["changes"]
    change["op"] = "putSection"  # only the section payload is read for putSection
    change["section"] |= {"id": "all", "anchor": anchor, "required": True}
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


def test_survey_job_also_writes_ontology_suggestions(fixture_specs_dir: Path) -> None:
    from ingest_worker.storage import ontology_suggestions_key

    from .fakes import MemoryOntologyStore
    from .test_ontology_suggest import library_store

    provider, store, deps = make(fixture_specs_dir)
    ontologies, _ = library_store()
    deps = dataclasses.replace(deps, ontologies=ontologies)
    body = {**SURVEY_BODY, "candidates": [
        {"name": "active_substance", "description": "", "where": "", "kind": "table", "seenIn": {"n": 1, "of": 1}},
        {"name": "batch_number", "description": "", "where": "", "kind": "field", "seenIn": {"n": 1, "of": 1}},
    ]}  # fmt: skip
    provider.responses = [body]
    library = [{"id": "domain", "version": 1, "label": "Domain", "terms": 3}]
    queue = FakeQueue(jobs=[draft_job(library=library, pinned=[])])
    run_once(queue, deps, "w1")
    assert queue.completed
    record = json.loads(store.get("runs", ontology_suggestions_key("letter", "job-d")))
    assert record["surveyProposalId"] == "job-d"
    assert [s["ontologyId"] for s in record["suggestions"]] == ["domain"]
    assert isinstance(ontologies, MemoryOntologyStore)


def test_failed_suggestions_never_fail_the_survey(fixture_specs_dir: Path) -> None:
    from .test_ontology_suggest import library_store

    provider, store, deps = make(fixture_specs_dir)
    ontologies, _ = library_store()
    ontologies.lexical_best = lambda *a, **k: (_ for _ in ()).throw(RuntimeError("index down"))  # type: ignore[method-assign]
    deps = dataclasses.replace(deps, ontologies=ontologies)
    provider.responses = [SURVEY_BODY]
    library = [{"id": "domain", "version": 1, "label": "Domain", "terms": 3}]
    queue = FakeQueue(jobs=[draft_job(library=library)])
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
