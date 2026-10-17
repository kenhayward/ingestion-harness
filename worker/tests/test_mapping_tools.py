"""The mapping stage's tools: searching the pinned ontologies beyond the shortlist and looking a
term up, so the model can choose a term retrieval missed."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ingest_worker.drafting import DRAFT_PROGRESS
from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.mapping_stage import MappingInputs, convert_mapping
from ingest_worker.ontology import parse_ontology
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore, drafting_key, prepared_text_key
from ingest_worker.tool_loop import SUBMIT

from .fakes import MemoryOntologyStore, ToolFakeProvider
from .test_mapping_stage import (
    DRAFT,
    FIXTURE,
    GOOD,
    PARAMS_MAPPING,
    PH,
    SHORTLISTS,
    blank,
    mapping_job,
    run,
    shortlist_of,
)


def test_a_term_found_by_a_search_may_be_chosen() -> None:
    inputs = MappingInputs.model_validate(PARAMS_MAPPING)
    data = {
        "notes": "",
        "changes": [blank("putFieldMapping", "lot", property=f"{PH}storageCondition")],
    }
    _, errors = convert_mapping(data, DRAFT, inputs, SHORTLISTS, searched=[])
    assert (
        f"changes[0].property: {PH}storageCondition is not in the shortlist or your searches; "
        "choose a candidate, search for a term or declare a local term"
    ) in errors
    _, errors = convert_mapping(
        data, DRAFT, inputs, SHORTLISTS, searched=shortlist_of(f"{PH}storageCondition")
    )
    assert not [e for e in errors if "storageCondition" in e]


def test_the_store_looks_a_term_up_by_iri() -> None:
    store = MemoryOntologyStore()
    store.saved[("pharma", 1)] = parse_ontology(FIXTURE.read_bytes(), "text/turtle", "o.ttl")
    term = store.term([("pharma", 1)], f"{PH}BatchRecord")
    assert term is not None and term.label == "Batch record"
    assert term.parents == [f"{PH}Document"]
    assert store.term([("pharma", 1)], f"{PH}Nothing") is None
    assert store.term([("other", 1)], f"{PH}BatchRecord") is None


def tool_make(fixture_specs_dir: Path) -> tuple[ToolFakeProvider, MemoryObjectStore, PipelineDeps]:
    drafting = ToolFakeProvider("drafter")
    store = MemoryObjectStore()
    text = {"pages": [{"number": 1, "text": "Lot: G17230211", "ocr": False}]}
    store.put("runs", prepared_text_key("sha-a"), json.dumps(text).encode(), "application/json")
    ontologies = MemoryOntologyStore()
    ontologies.saved[("pharma", 1)] = parse_ontology(FIXTURE.read_bytes(), "text/turtle", "o.ttl")
    configs = {"drafter": ProviderConfig(name="drafter", kind="openai-chat", location="local")}  # type: ignore[arg-type]
    deps = PipelineDeps(
        store=store,
        specs=load_specs(fixture_specs_dir),
        models=ModelRegistry({"drafter": drafting}, configs, {"draft": "drafter/big"}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        ontologies=ontologies,
        embedding_model=None,
    )
    return drafting, store, deps


def test_the_mapping_model_searches_and_looks_up_a_term_before_choosing_it(
    fixture_specs_dir: Path,
) -> None:
    drafting, store, deps = tool_make(fixture_specs_dir)
    answer: dict[str, Any] = {
        "notes": "n",
        "changes": [
            *GOOD["changes"],
            blank("putFieldMapping", "expires", property=f"{PH}storageCondition"),
        ],
    }
    drafting.turns = [
        [("search_terms", {"query": "storage condition", "kind": "property", "limit": 5})],
        [("term_detail", {"iri": f"{PH}storageCondition"}), ("term_detail", {"iri": f"{PH}Nope"})],
        [(SUBMIT, answer)],
    ]
    queue = run(deps, mapping_job())
    assert queue.completed, queue.reviewed
    first, second = drafting.converse_calls[0][1], drafting.converse_calls[1][1]
    assert [t.name for t in first.tools] == ["search_terms", "term_detail", SUBMIT]
    found = second.messages[-1].tool_results[0].content
    assert f"{PH}storageCondition" in found and "storage condition" in found
    detail, missing = drafting.converse_calls[2][1].messages[-1].tool_results
    assert "storage condition" in detail.content and "datatype_property" in detail.content
    assert missing.is_error and "no term" in missing.content
    body = json.loads(store.get("runs", drafting_key("batch", "job-m")))["body"]
    assert body["changes"][-1]["mapping"] == {"property": f"{PH}storageCondition"}
    events = [d for _, _, msg, d in queue.event_details if msg == DRAFT_PROGRESS]
    assert events[0]["stage"] == "mapping" and events[0]["phase"] == "reading"
    assert [e["tool"]["summary"] for e in events if e.get("tool")] == [
        'Searching the ontologies for "storage condition"',
        f"Looking up {PH}storageCondition",
        f"Looking up {PH}Nope",
    ]


def test_without_tools_the_mapping_reports_its_phases(fixture_specs_dir: Path) -> None:
    from .test_mapping_stage import make

    drafting, _, _, deps = make(fixture_specs_dir, embedder=None, embedded=False)
    drafting.responses = [GOOD]
    queue = run(deps, mapping_job())
    assert queue.completed
    events = [d for _, _, msg, d in queue.event_details if msg == DRAFT_PROGRESS]
    assert [(e["phase"], e["attempt"]) for e in events] == [("reading", None), ("model", 1)]
    assert all("toolCalls" not in e for e in events)
