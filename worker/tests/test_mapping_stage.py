"""The Workbench mapping stage (ADR 0011): shortlists from the brief's ontologies, a flat model
schema, conversion to typed mapping changes, and the rules fed back to the model."""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.mapping_stage import (
    MAPPING,
    MAX_MAPPING_TERMS,
    MappingInputs,
    compact_iri,
    convert_mapping,
    outputs_of,
)
from ingest_worker.ontology import parse_ontology
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.retrieval import Candidate
from ingest_worker.specs import load_specs
from ingest_worker.storage import MemoryObjectStore, drafting_key, prepared_text_key

from .fakes import FakeProvider, FakeQueue, MemoryOntologyStore
from .test_draft_stages import _union_count

PH = "https://ex.example/pharma#"
FIXTURE = Path(__file__).parent / "fixtures" / "mapping-recall" / "ontology.ttl"

DRAFT: dict[str, Any] = {
    "id": "batch",
    "version": 1,
    "name": "Batch record",
    "document": {"sections": [{"id": "all", "anchor": "\\A"}]},
    "outputs": {
        "fields": [
            {"id": "lot", "name": "Lot number", "type": "text", "description": "The batch id"},
            {"id": "expires", "type": "date", "description": "Use by"},
            {"id": "form", "type": "enum", "enum": ["tablet", "capsule"]},
        ],
        "tables": [
            {
                "id": "tests",
                "columns": [{"id": "assay", "type": "text"}, {"id": "ok", "type": "boolean"}],
            }
        ],
    },
    "pipeline": [
        {
            "type": "extract",
            "id": "head",
            "fields": ["lot", "expires", "form"],
            "sections": ["all"],
        },
        {"type": "extract", "id": "rows", "table": "tests", "sections": ["all"]},
    ],
}

PARAMS_MAPPING: dict[str, Any] = {
    "versions": [{"id": "pharma", "version": 1, "localOnly": False, "label": "Pharma"}],
    "guidance": "Prefer the pharma vocabulary.",
    "observed": {
        "lot": [{"value": "G17230211", "count": 2, "snippet": "Lot: G17230211", "sample": "a.pdf"}],
        "expires": [{"value": "2025-03-31", "count": 1, "snippet": None, "sample": "held.pdf"}],
    },
}


def shortlist_of(*iris: str) -> list[Candidate]:
    return [
        Candidate(
            i,
            "datatype_property",
            re.split(r"[#/]", i)[-1],
            "",
            [],
            [],
            [],
            0.01,
            frozenset({"lexical"}),
        )
        for i in iris
    ]


SHORTLISTS = {
    "": [*shortlist_of(f"{PH}BatchRecord")],
    "lot": shortlist_of(f"{PH}batchNumber", f"{PH}productName"),
    "expires": shortlist_of(f"{PH}expiryDate"),
    "form": shortlist_of(f"{PH}dosageForm"),
    "tests": shortlist_of(f"{PH}hasResult", f"{PH}TestResult"),
    "tests.assay": shortlist_of(f"{PH}testName"),
    "tests.ok": shortlist_of(f"{PH}conforms"),
}


def blank(op: str, target: str = "", **over: Any) -> dict[str, Any]:
    """A flat change with every key present, empty placeholders where unused."""
    change: dict[str, Any] = {
        "op": op,
        "target": target,
        "property": "",
        "valueAs": "literal",
        "entityClass": "",
        "entityIri": "",
        "conceptScheme": "",
        "conceptValues": [],
        "matchByLabel": False,
        "tableLink": "",
        "rowClass": "",
        "rowIri": "",
        "documentClass": "",
        "documentIri": "",
        "localIri": "",
        "localKind": "",
        "localLabel": "",
        "localDefinition": "",
        "confidence": "high",
        "reason": "r",
        "evidence": [],
    }
    return {**change, **over}


def convert(changes: list[dict[str, Any]]) -> tuple[dict[str, Any], list[str]]:
    inputs = MappingInputs.model_validate(PARAMS_MAPPING)
    return convert_mapping(
        {"notes": "n", "changes": changes},
        DRAFT,
        inputs,
        SHORTLISTS,
        local_namespace="https://ex.example/local#",
    )


def test_the_model_schema_has_no_union_types() -> None:
    assert _union_count(MAPPING.schema) == 0


def test_outputs_are_the_document_fields_tables_and_columns() -> None:
    assert [o.path for o in outputs_of(DRAFT)] == [
        "",
        "lot",
        "expires",
        "form",
        "tests",
        "tests.assay",
        "tests.ok",
    ]


@pytest.mark.parametrize(
    ("iri", "prefixes", "curie"),
    [
        (f"{PH}batchNumber", {"pharma": PH}, "pharma:batchNumber"),
        ("https://other.example/x", {"pharma": PH}, "https://other.example/x"),
    ],
)
def test_compact_iri(iri: str, prefixes: dict[str, str], curie: str) -> None:
    assert compact_iri(iri, prefixes) == curie


def test_converts_flat_changes_to_mapping_ops_with_curies_and_alternatives() -> None:
    body, errors = convert(
        [
            blank(
                "setDocumentMapping", documentClass=f"{PH}BatchRecord", documentIri="batch/{source}"
            ),
            blank("putFieldMapping", "lot", property=f"{PH}batchNumber", evidence=["G17230211"]),
            blank(
                "putFieldMapping",
                "form",
                property=f"{PH}dosageForm",
                valueAs="concept",
                conceptValues=[{"value": "tablet", "concept": ""}],
                confidence="low",
            ),
            blank(
                "putTableMapping", "tests", tableLink=f"{PH}hasResult", rowClass=f"{PH}TestResult"
            ),
            blank("putFieldMapping", "tests.assay", property=f"{PH}testName"),
            blank(
                "putLocalTerm",
                localIri="https://ex.example/local#stage",
                localKind="datatype_property",
                localLabel="stage",
            ),
            blank("putFieldMapping", "tests.ok", property="https://ex.example/local#stage"),
        ]
    )
    assert errors == []
    document, lot, form, table, local = body["changes"]
    assert document == {
        "op": "setDocumentMapping",
        "document": {"class": "pharma:BatchRecord", "iri": "batch/{source}"},
        "ontologies": [{"id": "pharma", "version": 1}],
        "prefixes": {"pharma": PH},
        "reason": "r",
        "confidence": "high",
    }
    assert lot == {
        "op": "putFieldMapping",
        "field": "lot",
        # Full IRI: the draft declares no prefix, and the change must stand without the
        # document change that declares one.
        "mapping": {"property": f"{PH}batchNumber"},
        "reason": "r",
        "confidence": "high",
        "evidence": ["G17230211"],
        "alternatives": [{"iri": f"{PH}productName", "label": "productName", "score": 0.01}],
    }
    assert form["mapping"] == {"property": f"{PH}dosageForm", "concepts": {}}
    assert form["confidence"] == "low"
    # Columns are merged into their table's mapping.
    assert table["mapping"] == {
        "link": f"{PH}hasResult",
        "class": f"{PH}TestResult",
        "columns": {
            "assay": {"property": f"{PH}testName"},
            "ok": {"property": "https://ex.example/local#stage"},
        },
    }
    assert local["term"] == {
        "iri": "https://ex.example/local#stage",
        "kind": "datatype_property",
        "label": "stage",
    }


@pytest.mark.parametrize(
    ("change", "error"),
    [
        (
            blank("putFieldMapping", "lot", property="https://elsewhere.example/x"),
            "not in the shortlist",
        ),
        (blank("putFieldMapping", "nope", property=f"{PH}batchNumber"), "no output nope"),
        (
            blank(
                "putFieldMapping",
                "lot",
                property=f"{PH}batchNumber",
                valueAs="entity",
                entityClass=f"{PH}BatchRecord",
                entityIri="batch/{name|slug}",
            ),
            "name is not available",
        ),
        (
            blank(
                "putFieldMapping",
                "lot",
                property=f"{PH}batchNumber",
                valueAs="entity",
                entityClass=f"{PH}BatchRecord",
                entityIri="batch/{value|lower}",
            ),
            "lower is not an IRI filter",
        ),
        (
            blank("putFieldMapping", "tests.assay", property=f"{PH}testName"),
            "map table tests first",
        ),
        (
            blank("setDocumentMapping", documentClass=f"{PH}BatchRecord", documentIri="d/{lot}"),
            "lot is not available",
        ),
    ],
)
def test_changes_the_rules_refuse(change: dict[str, Any], error: str) -> None:
    _, errors = convert([change])
    assert any(error in e for e in errors), errors


# --- the draft job --------------------------------------------------------------------------


def mapping_job(**params: Any) -> ClaimedJob:
    base: dict[str, Any] = {
        "stage": "mapping",
        "dataPolicy": "local",
        "briefVersion": 1,
        "brief": {"purpose": "Batch records"},
        "draft": DRAFT,
        "samples": [{"sampleId": "s1", "filename": "a.pdf", "sha256": "sha-a", "role": "dev"}],
        "mapping": PARAMS_MAPPING,
    }
    return ClaimedJob(
        "job-m", "", "batch", 0, "", "", None, 1, 3, task="draft", test=True,
        project_id="batch", params={**base, **params},
    )  # fmt: skip


def make(
    fixture_specs_dir: Path,
    *,
    drafter: str = "local",
    embedder: str | None = "local",
    embedded: bool = True,
) -> tuple[FakeProvider, FakeProvider, MemoryObjectStore, PipelineDeps]:
    drafting = FakeProvider("drafter")
    embedding = FakeProvider("emb")
    store = MemoryObjectStore()
    text = {"sha256": "sha-a", "pages": [{"number": 1, "text": "Lot: G17230211", "ocr": False}]}
    store.put("runs", prepared_text_key("sha-a"), json.dumps(text).encode(), "application/json")
    ontologies = MemoryOntologyStore()
    ontologies.saved[("pharma", 1)] = parse_ontology(FIXTURE.read_bytes(), "text/turtle", "o.ttl")
    configs = {
        "drafter": ProviderConfig(name="drafter", kind="openai-chat", location=drafter),  # type: ignore[arg-type]
        "emb": ProviderConfig(name="emb", kind="openai-chat", location=embedder or "local"),  # type: ignore[arg-type]
    }
    deps = PipelineDeps(
        store=store,
        specs=load_specs(fixture_specs_dir),
        models=ModelRegistry(
            {"drafter": drafting, "emb": embedding}, configs, {"draft": "drafter/big"}
        ),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        ontologies=ontologies,
        embedding_model="emb/nomic" if embedder else None,
    )
    if embedded:
        from ingest_worker.embeddings import embed_version

        embed_version(deps, FakeQueue(), "setup", "pharma", 1)
        embedding.embed_calls.clear()
    return drafting, embedding, store, deps


GOOD = {
    "notes": "Mapped what the vocabulary covers.",
    "changes": [
        blank("setDocumentMapping", documentClass=f"{PH}BatchRecord", documentIri="doc/{source}"),
        blank("putFieldMapping", "lot", property=f"{PH}batchNumber"),
    ],
}


def run(deps: PipelineDeps, job: ClaimedJob) -> FakeQueue:
    queue = FakeQueue(jobs=[job])
    run_once(queue, deps, "w1")
    return queue


def test_a_mapping_run_writes_typed_changes_from_the_shortlists(fixture_specs_dir: Path) -> None:
    drafting, embedding, store, deps = make(fixture_specs_dir)
    drafting.responses = [GOOD]
    queue = run(deps, mapping_job())
    assert queue.completed, queue.reviewed
    result = json.loads(store.get("runs", drafting_key("batch", "job-m")))
    assert result["stage"] == "mapping"
    ops = [c["op"] for c in result["body"]["changes"]]
    assert ops == ["setDocumentMapping", "putFieldMapping"]
    assert result["body"]["changes"][1]["mapping"] == {"property": f"{PH}batchNumber"}
    [(_, request)] = drafting.calls
    assert "Prefer the pharma vocabulary." in request.prompt
    assert f"{PH}batchNumber" in request.prompt
    assert "G17230211" in request.prompt
    assert embedding.embed_calls  # the outputs were embedded for semantic retrieval
    assert "lexical only" not in result["body"]["notes"]


def test_the_shortlist_rule_is_fed_back_to_the_model(fixture_specs_dir: Path) -> None:
    drafting, _, _, deps = make(fixture_specs_dir)
    bad = {
        "notes": "",
        "changes": [blank("putFieldMapping", "lot", property="https://x.example/y")],
    }
    drafting.responses = [bad, GOOD]
    queue = run(deps, mapping_job())
    assert queue.completed
    assert len(drafting.calls) == 2
    assert "not in the shortlist" in drafting.calls[1][1].prompt


def test_observed_values_of_samples_not_sent_are_dropped(fixture_specs_dir: Path) -> None:
    drafting, _, _, deps = make(fixture_specs_dir)
    drafting.responses = [GOOD]
    run(deps, mapping_job())
    [(_, request)] = drafting.calls
    assert "2025-03-31" not in request.prompt  # seen only in held.pdf, which is not a dev sample


def test_a_mapping_request_too_long_for_the_loaded_context_needs_review(
    fixture_specs_dir: Path,
) -> None:
    from ingest_worker.drafting import context_reason
    from ingest_worker.llm.base import ContextExceededError

    drafting, _, _, deps = make(fixture_specs_dir)
    drafting.responses = [ContextExceededError("openai 400: Context size has been exceeded.")]
    queue = run(deps, mapping_job())
    assert not queue.failed and len(drafting.calls) == 1
    assert queue.reviewed == [("job-m", context_reason(16_000))]


def test_a_local_only_ontology_refuses_an_external_drafter_before_any_call(
    fixture_specs_dir: Path,
) -> None:
    drafting, _, _, deps = make(fixture_specs_dir, drafter="external")
    versions = [{**PARAMS_MAPPING["versions"][0], "localOnly": True}]
    queue = run(
        deps, mapping_job(dataPolicy="external", mapping={**PARAMS_MAPPING, "versions": versions})
    )
    [(_, reason)] = queue.reviewed
    assert "local only" in reason
    assert drafting.calls == []


def test_an_external_embedder_on_a_local_project_falls_back_to_lexical(
    fixture_specs_dir: Path,
) -> None:
    drafting, embedding, store, deps = make(fixture_specs_dir, embedder="external", embedded=False)
    drafting.responses = [GOOD]
    run(deps, mapping_job())
    assert embedding.embed_calls == []
    notes = json.loads(store.get("runs", drafting_key("batch", "job-m")))["body"]["notes"]
    assert "lexical only" in notes and "external" in notes


def test_versions_without_embeddings_are_lexical_and_say_so(fixture_specs_dir: Path) -> None:
    drafting, _, store, deps = make(fixture_specs_dir, embedded=False)
    drafting.responses = [GOOD]
    run(deps, mapping_job())
    notes = json.loads(store.get("runs", drafting_key("batch", "job-m")))["body"]["notes"]
    assert "lexical only for pharma v1" in notes


def test_external_calls_are_logged_with_the_samples_and_ontologies(fixture_specs_dir: Path) -> None:
    drafting, _, _, deps = make(fixture_specs_dir, drafter="external")
    drafting.responses = [GOOD]
    queue = run(deps, mapping_job(dataPolicy="external"))
    [event] = [e for e in queue.event_details if e[2] == "external model call"]
    assert event[3]["stage"] == "mapping"
    assert event[3]["ontologies"] == ["pharma v1"]
    assert event[3]["samples"] == ["s1"]


def test_the_context_stays_within_the_term_budget() -> None:
    assert MAX_MAPPING_TERMS == 300


# --- review fixes ----------------------------------------------------------------------------


def convert_with(
    draft: dict[str, Any], changes: list[dict[str, Any]], **kw: Any
) -> tuple[dict[str, Any], list[str]]:
    inputs = MappingInputs.model_validate(PARAMS_MAPPING)
    return convert_mapping({"notes": "", "changes": changes}, draft, inputs, SHORTLISTS, **kw)


MAPPED_DRAFT = {
    **DRAFT,
    "semantics": {"prefixes": {"pharma": PH}, "document": {"class": "pharma:BatchRecord"}},
}


def test_with_a_mapping_terms_stay_iris_unless_the_draft_declares_their_prefix() -> None:
    other = {**SHORTLISTS, "expires": shortlist_of("http://purl.org/dc/terms/date")}
    inputs = MappingInputs.model_validate(PARAMS_MAPPING)
    body, errors = convert_mapping(
        {
            "notes": "",
            "changes": [
                blank("putFieldMapping", "lot", property=f"{PH}batchNumber"),
                blank("putFieldMapping", "expires", property="http://purl.org/dc/terms/date"),
            ],
        },
        MAPPED_DRAFT,
        inputs,
        other,
    )
    assert errors == []
    lot, expires = body["changes"]
    assert lot["mapping"]["property"] == "pharma:batchNumber"  # declared by the draft
    assert expires["mapping"]["property"] == "http://purl.org/dc/terms/date"  # never a bare CURIE


def test_a_field_change_stays_valid_without_the_document_change() -> None:
    """Each change is applied on its own: a field change never relies on a prefix only the
    document change declares."""
    body, errors = convert(
        [
            blank("setDocumentMapping", documentClass=f"{PH}BatchRecord"),
            blank("putFieldMapping", "lot", property=f"{PH}batchNumber"),
        ]
    )
    assert errors == []
    document, lot = body["changes"]
    assert document["document"]["class"] == "pharma:BatchRecord"
    assert lot["mapping"]["property"] == f"{PH}batchNumber"


def test_a_first_mapping_needs_the_document_change() -> None:
    _, errors = convert([blank("putFieldMapping", "lot", property=f"{PH}batchNumber")])
    assert any("map the document first" in e for e in errors)


def test_local_terms_live_under_the_recipe_namespace() -> None:
    ns = "https://data.acme.example/def/batch/"
    _, errors = convert_with(
        DRAFT,
        [
            blank("setDocumentMapping", documentClass=f"{PH}BatchRecord"),
            blank("putLocalTerm", localIri=f"{PH}invented", localKind="class", localLabel="x"),
        ],
        local_namespace=ns,
    )
    assert any(f"local terms live under {ns}" in e for e in errors)
    _, ok = convert_with(
        DRAFT,
        [
            blank("setDocumentMapping", documentClass=f"{PH}BatchRecord"),
            blank("putLocalTerm", localIri=f"{ns}stage", localKind="class", localLabel="stage"),
        ],
        local_namespace=ns,
    )
    assert ok == []
    _, none = convert_with(
        DRAFT,
        [
            blank("setDocumentMapping", documentClass=f"{PH}BatchRecord"),
            blank("putLocalTerm", localIri=f"{ns}stage", localKind="class", localLabel="stage"),
        ],
        local_namespace=None,
    )
    assert any("set the customer under Administration > Linked data" in e for e in none)


def test_terms_imported_from_a_local_only_ontology_refuse_an_external_drafter(
    fixture_specs_dir: Path,
) -> None:
    drafting, _, _, deps = make(fixture_specs_dir, drafter="external")
    assert deps.ontologies is not None
    store = deps.ontologies
    assert isinstance(store, MemoryOntologyStore)
    store.saved[("pharma", 1)].terms[0].defined_in = "secret@1"
    store.local_only_ids.add("secret")
    queue = run(deps, mapping_job(dataPolicy="external"))
    [(_, reason)] = queue.reviewed
    assert "secret" in reason and "local only" in reason
    assert drafting.calls == []


def test_an_embedding_outage_falls_back_to_lexical(fixture_specs_dir: Path) -> None:
    from ingest_worker.llm.base import LLMError

    drafting, embedding, store, deps = make(fixture_specs_dir)
    embedding.embed = lambda model, texts: (_ for _ in ()).throw(LLMError("down"))  # type: ignore[method-assign]
    drafting.responses = [GOOD]
    queue = run(deps, mapping_job())
    assert queue.completed
    notes = json.loads(store.get("runs", drafting_key("batch", "job-m")))["body"]["notes"]
    assert "lexical only" in notes and "down" in notes
