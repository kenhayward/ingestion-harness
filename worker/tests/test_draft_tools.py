"""Drafting tools: testing anchors on the dev samples and reading sample pages, and how the
sections and revise stages hold a conversation with them."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.config import REPO_ROOT
from ingest_worker.draft_tools import (
    MAX_READ_PAGES,
    MAX_READ_TOTAL,
    anchor_tool,
    drafting_tools,
    sample_pages_tool,
)
from ingest_worker.drafting import DRAFT_PROGRESS, DraftParamSample, DraftSample
from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.pipeline import Buckets, DocumentError, PipelineDeps
from ingest_worker.specs import load_specs
from ingest_worker.storage import (
    MemoryObjectStore,
    draft_log_key,
    drafting_key,
    prepared_text_key,
)
from ingest_worker.tool_loop import SUBMIT, ToolError

from .fakes import FakeQueue, ToolFakeProvider
from .test_drafting import DRAFT, REVISE_DRAFT, draft_job, sections_body

SAMPLES = [
    DraftSample("s1", "a.pdf", "dev", ["PROTOCOL APPROVAL\nPVP/23/003", "TOTALS\nTOTALS"]),
    DraftSample("s2", "b.pdf", "dev", ["Something else\nTOTALS", "end"]),
]


def put(sid: str, anchor: str, **more: Any) -> dict[str, Any]:
    return {"op": "putSection", "id": sid, "anchor": anchor, **more}


# --- test_anchors ----------------------------------------------------------------------------


def test_test_anchors_reports_where_each_section_starts_and_what_misses() -> None:
    tool = anchor_tool(SAMPLES, DRAFT)
    text = tool.run({"changes": [put("approval", "^PROTOCOL APPROVAL"), put("totals", "^TOTALS")]})
    assert "Tested on 2 dev sample(s)" in text
    assert "sample\tall\tapproval\ttotals" in text
    assert 'a.pdf\tp1 "[page 1]"\tp1 "PROTOCOL APPROVAL"\tp2 "TOTALS" (2x)' in text
    assert 'b.pdf\tp1 "[page 1]"\t-\tp1 "TOTALS"' in text
    assert "section \"approval\" is required but anchor '^PROTOCOL APPROVAL' missed: b.pdf" in text
    assert tool.describe({"changes": [put("a", "^A"), put("b", "^B")]}) == (
        "Testing 2 anchors on 2 dev samples"
    )


def test_test_anchors_says_when_every_anchor_found_its_section() -> None:
    text = anchor_tool(SAMPLES, DRAFT).run({"changes": [put("totals", "^.*TOTALS")]})
    assert "Every proposed anchor found its section where required." in text


def test_test_anchors_refuses_an_invalid_regex_before_testing() -> None:
    with pytest.raises(ToolError, match="invalid regular expression"):
        anchor_tool(SAMPLES, DRAFT).run({"changes": [put("x", "^(unclosed")]})


def test_test_anchors_reports_a_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    def slow(*_a: Any, **_k: Any) -> dict[str, Any]:
        raise DocumentError(
            "preview took longer than 10s; an anchor may backtrack catastrophically"
        )

    monkeypatch.setattr("ingest_worker.drafting.segment_with_timeout", slow)
    with pytest.raises(ToolError, match="backtrack"):
        anchor_tool(SAMPLES, DRAFT).run({"changes": [put("x", "^(a+)+$")]})


# --- read_sample_pages -----------------------------------------------------------------------


def pages_setup(
    external: bool = False, pages: int = 8
) -> tuple[Any, FakeQueue, list[DraftParamSample]]:
    store = MemoryObjectStore()
    text = {"pages": [{"number": n, "text": f"text of page {n}"} for n in range(1, pages + 1)]}
    store.put("runs", prepared_text_key("sha-c"), json.dumps(text).encode(), "application/json")
    deps = PipelineDeps(
        store=store,
        specs={},
        models=ModelRegistry({}, {}, {}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
    )
    queue = FakeQueue()
    samples = [
        DraftParamSample.model_validate(
            {"sampleId": "s9", "filename": "c.pdf", "sha256": "sha-c", "role": "dev"}
        ),
        DraftParamSample.model_validate(
            {"sampleId": "h1", "filename": "h.pdf", "sha256": "sha-h", "role": "holdout"}
        ),
    ]
    tool = sample_pages_tool(
        draft_job(stage="revise"),
        deps,
        queue,
        stage="revise",
        model_ref="cloud/big",
        external=external,
        samples=samples,
    )
    return tool, queue, samples


def test_read_sample_pages_returns_the_pages_asked_for() -> None:
    tool, queue, _ = pages_setup()
    text = tool.run({"file": "c.pdf", "fromPage": 2, "toPage": 3})
    assert text.startswith("c.pdf, pages 2-3 of 8")
    assert "[page 2]\ntext of page 2" in text and "[page 3]\ntext of page 3" in text
    assert "page 4" not in text
    assert queue.event_details == []  # a local model: nothing leaves the deployment
    assert tool.describe({"file": "c.pdf", "fromPage": 2, "toPage": 3}) == (
        "Reading pages 2 to 3 of c.pdf"
    )


def test_read_sample_pages_caps_the_pages_of_one_read() -> None:
    tool, _, _ = pages_setup(pages=20)
    text = tool.run({"file": "c.pdf", "fromPage": 1, "toPage": 20})
    assert f"pages 1-{MAX_READ_PAGES} of 20" in text


@pytest.mark.parametrize(
    ("args", "message"),
    [
        ({"file": "h.pdf", "fromPage": 1, "toPage": 1}, "not a dev sample"),
        ({"file": "nope.pdf", "fromPage": 1, "toPage": 1}, "dev samples: c.pdf"),
        ({"file": "c.pdf", "fromPage": 9, "toPage": 9}, "has 8 page"),
        ({"file": "c.pdf", "fromPage": 3, "toPage": 2}, "toPage must not be before"),
    ],
)
def test_read_sample_pages_refuses(args: dict[str, Any], message: str) -> None:
    tool, _, _ = pages_setup()
    with pytest.raises(ToolError, match=message):
        tool.run(args)


def test_read_sample_pages_stops_at_the_runs_budget(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("ingest_worker.draft_tools.MAX_READ_TOTAL", 100)
    tool, _, _ = pages_setup(pages=40)
    first = tool.run({"file": "c.pdf", "fromPage": 1, "toPage": 5})
    assert "(cut at the reading limit)" in first
    with pytest.raises(ToolError, match="budget for this run is spent"):
        tool.run({"file": "c.pdf", "fromPage": 6, "toPage": 6})
    assert MAX_READ_TOTAL == 60_000


def test_reading_for_an_external_model_is_logged() -> None:
    tool, queue, _ = pages_setup(external=True)
    tool.run({"file": "c.pdf", "fromPage": 1, "toPage": 2})
    [details] = [d for _, _, msg, d in queue.event_details if msg == "external model call"]
    assert details == {
        "stage": "revise",
        "model": "cloud/big",
        "samples": ["s9"],
        "pages": [1, 2],
        "purpose": "tool",
    }


def test_which_stages_offer_which_tools() -> None:
    def names(stage: str, samples: list[DraftSample]) -> list[str]:
        tool, _, _ = pages_setup()
        tools = drafting_tools(stage, samples=samples, draft=DRAFT, pages_tool=lambda: tool)
        return [t.spec.name for t in tools]

    assert names("sections", SAMPLES) == ["test_anchors"]
    assert names("revise", SAMPLES) == ["test_anchors", "read_sample_pages"]
    assert names("revise", []) == ["read_sample_pages"]
    assert names("sections", []) == []
    for stage in ("survey", "outputs", "steps"):
        assert names(stage, SAMPLES) == []


# --- the stages with tools -------------------------------------------------------------------


def tool_deps(
    specs_dir: Path, tool_calls: bool = True, location: str = "local"
) -> tuple[ToolFakeProvider, MemoryObjectStore, PipelineDeps]:
    provider = ToolFakeProvider("drafter")
    store = MemoryObjectStore()
    text = {"pages": [{"number": 1, "text": "PROTOCOL APPROVAL\nPVP/23/003", "ocr": False}]}
    store.put("runs", prepared_text_key("sha-a"), json.dumps(text).encode(), "application/json")
    config = ProviderConfig.model_validate(
        {"name": "drafter", "kind": "openai-chat", "location": location, "toolCalls": tool_calls}
    )
    deps = PipelineDeps(
        store=store,
        specs=load_specs(specs_dir),
        models=ModelRegistry({"drafter": provider}, {"drafter": config}, {"draft": "drafter/big"}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        example_template="id: example\n",
    )
    return provider, store, deps


def test_the_sections_stage_tests_anchors_before_it_answers(fixture_specs_dir: Path) -> None:
    provider, store, deps = tool_deps(fixture_specs_dir)
    provider.token_stream = [40]
    provider.turns = [
        [("test_anchors", {"changes": [put("approval", "^SIGNATURES")]})],
        [("test_anchors", {"changes": [put("approval", "^PROTOCOL APPROVAL")]})],
        [(SUBMIT, sections_body("^PROTOCOL APPROVAL"))],
    ]
    queue = FakeQueue(jobs=[draft_job(stage="sections")])
    run_once(queue, deps, "w1")
    assert queue.completed and provider.calls == []  # no single replies
    first_result = provider.converse_calls[1][1].messages[-1].tool_results[0]
    assert "matched none of the dev samples" in first_result.content
    _, request = provider.converse_calls[0]
    assert [t.name for t in request.tools] == ["test_anchors", SUBMIT]
    assert "calling submit" in request.messages[0].text
    body = json.loads(store.get("runs", drafting_key("letter", "job-d")))["body"]
    [row] = body["anchorCheck"]["samples"]
    assert {c["id"]: c["found"] for c in row["sections"]}["approval"] is True
    events = [d for _, _, msg, d in queue.event_details if msg == DRAFT_PROGRESS]
    tool_events = [e for e in events if e.get("tool")]
    assert [e["tool"] for e in tool_events] == [
        {"name": "test_anchors", "summary": "Testing 1 anchor on 1 dev sample"},
        {"name": "test_anchors", "summary": "Testing 1 anchor on 1 dev sample"},
    ]
    assert [e["toolCalls"] for e in tool_events] == [1, 2]
    assert tool_events[1]["tokens"] == 80  # the conversation's tokens so far
    assert events[-2]["tool"] is None and events[-2]["toolCalls"] == 2


def test_a_tool_run_reports_the_running_tool_on_the_progress_line(
    fixture_specs_dir: Path,
) -> None:
    """Shared fixture draft-progress.json (TS DraftProgressSchema): the model phase's events of
    a conversation carry the running tool (null between tools) and the calls so far."""
    from .test_drafting import expected_progress, progress

    provider, _, deps = tool_deps(fixture_specs_dir)
    provider.token_stream = [40]
    provider.turns = [
        [("test_anchors", {"changes": [put("approval", "^SIGNATURES")]})],
        [(SUBMIT, sections_body("^PROTOCOL APPROVAL"))],
    ]
    queue = FakeQueue(jobs=[draft_job(stage="sections")])
    run_once(queue, deps, "w1")
    assert queue.completed
    assert progress(queue) == expected_progress("sectionsWithTools")


LOG_FIXTURE = REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "draft-log.json"


def logged(store: MemoryObjectStore) -> dict[str, Any]:
    """The job's model log, its prompts blanked (the fixture pins the shape, not the context)."""
    log = json.loads(store.get("runs", draft_log_key("job-d")))
    for round_ in log["rounds"]:
        for entry in round_["entries"]:
            if entry["kind"] == "prompt":
                entry["text"] = "<prompt>"
    return log


def expected_log(case: str) -> dict[str, Any]:
    cases: dict[str, dict[str, Any]] = json.loads(LOG_FIXTURE.read_text("utf-8"))
    return cases[case]


def test_the_model_log_records_the_conversation(fixture_specs_dir: Path) -> None:
    """Shared fixture draft-log.json (TS DraftLogSchema): every reply, tool call, tool result
    and rejected answer of a run with tools."""
    provider, store, deps = tool_deps(fixture_specs_dir)
    provider.turns = [
        [("test_anchors", {"changes": [put("approval", "^SIGNATURES")]})],
        [(SUBMIT, {"notes": ""})],
        [(SUBMIT, sections_body("^PROTOCOL APPROVAL"))],
    ]
    queue = FakeQueue(jobs=[draft_job(stage="sections")])
    run_once(queue, deps, "w1")
    assert queue.completed
    assert logged(store) == expected_log("toolRun")


def test_the_model_log_records_single_replies(fixture_specs_dir: Path) -> None:
    from .test_drafting import SURVEY_BODY, make

    provider, store, deps = make(fixture_specs_dir)
    provider.responses = [{"summary": "x"}, SURVEY_BODY]
    queue = FakeQueue(jobs=[draft_job()])
    run_once(queue, deps, "w1")
    assert queue.completed
    assert logged(store) == expected_log("singleReplies")


def test_the_model_log_keeps_the_error_that_ended_a_run(fixture_specs_dir: Path) -> None:
    from ingest_worker.llm.base import RefusalError

    provider, store, deps = tool_deps(fixture_specs_dir)
    provider.turns = [
        [("test_anchors", {"changes": [put("approval", "^SIGNATURES")]})],
        RefusalError("model refused the request (category=cyber)"),
    ]
    queue = FakeQueue(jobs=[draft_job(stage="sections")])
    run_once(queue, deps, "w1")
    [(_, reason)] = queue.reviewed
    entries = logged(store)["rounds"][0]["entries"]
    assert [e["kind"] for e in entries][-2:] == ["toolResult", "error"]
    assert entries[-1]["message"] == reason


def test_an_endpoint_with_tool_calls_off_drafts_with_single_replies(
    fixture_specs_dir: Path,
) -> None:
    provider, _, deps = tool_deps(fixture_specs_dir, tool_calls=False)
    provider.responses = [sections_body("^PROTOCOL APPROVAL")]
    queue = FakeQueue(jobs=[draft_job(stage="sections")])
    run_once(queue, deps, "w1")
    assert queue.completed and provider.converse_calls == [] and len(provider.calls) == 1
    events = [d for _, _, msg, d in queue.event_details if msg == DRAFT_PROGRESS]
    assert all("toolCalls" not in e for e in events)


def test_a_stage_without_tools_drafts_with_single_replies(fixture_specs_dir: Path) -> None:
    from .test_drafting import SURVEY_BODY

    provider, _, deps = tool_deps(fixture_specs_dir)
    provider.responses = [SURVEY_BODY]
    queue = FakeQueue(jobs=[draft_job()])
    run_once(queue, deps, "w1")
    assert queue.completed and provider.converse_calls == []


def test_revise_reads_pages_of_a_dev_sample_left_out_of_the_prompt(
    fixture_specs_dir: Path,
) -> None:
    provider, store, deps = tool_deps(fixture_specs_dir, location="external")
    text = {"pages": [{"number": 1, "text": "NINTH SAMPLE PAGE ONE"}]}
    store.put("runs", prepared_text_key("sha-9"), json.dumps(text).encode(), "application/json")
    samples = [
        {"sampleId": f"s{n}", "filename": f"{n}.pdf", "sha256": "sha-a", "role": "dev"}
        for n in range(1, 9)
    ] + [{"sampleId": "s9", "filename": "9.pdf", "sha256": "sha-9", "role": "dev"}]
    provider.turns = [
        [("read_sample_pages", {"file": "9.pdf", "fromPage": 1, "toPage": 1})],
        [(SUBMIT, {"notes": "nothing to change", "changes": []})],
    ]
    job = draft_job(stage="revise", dataPolicy="external", samples=samples, draft=REVISE_DRAFT)
    queue = FakeQueue(jobs=[job])
    run_once(queue, deps, "w1")
    assert queue.completed, queue.reviewed
    assert "9.pdf" not in provider.converse_calls[0][1].messages[0].text  # not in the prompt
    result = provider.converse_calls[1][1].messages[-1].tool_results[0]
    assert "NINTH SAMPLE PAGE ONE" in result.content
    logged = [d for _, _, msg, d in queue.event_details if msg == "external model call"]
    assert logged[-1]["samples"] == ["s9"] and logged[-1]["purpose"] == "tool"
