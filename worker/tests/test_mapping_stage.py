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
        "nodeClass": "",
        "nodeValue": "",
        "nodeUnit": "",
        "nodeUnitProperty": "",
        "valueLink": "",
        "valueProperty": "",
        "unitProperty": "",
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


def test_a_local_term_used_but_not_declared_is_declared_for_the_model() -> None:
    """A model that names a term under the recipe's namespace without putLocalTerm (seen on a
    real run: every table link invented, none declared) gets the declaration added, its kind
    from where it was used, rather than a failed run."""
    ns = "https://data.acme.example/def/batch/"
    body, errors = convert_with(
        DRAFT,
        [
            blank("setDocumentMapping", documentClass=f"{PH}BatchRecord"),
            blank(
                "putTableMapping",
                "tests",
                tableLink=f"{ns}has_test_result",
                rowClass=f"{ns}AssayRun",
            ),
            blank("putFieldMapping", "tests.assay", property=f"{ns}assayName"),
        ],
        local_namespace=ns,
    )
    assert errors == []
    declared = {c["term"]["iri"]: c["term"] for c in body["changes"] if c["op"] == "putLocalTerm"}
    assert declared == {
        f"{ns}has_test_result": {
            "iri": f"{ns}has_test_result",
            "kind": "object_property",
            "label": "has test result",
        },
        f"{ns}AssayRun": {"iri": f"{ns}AssayRun", "kind": "class", "label": "assay run"},
        f"{ns}assayName": {
            "iri": f"{ns}assayName",
            "kind": "datatype_property",
            "label": "assay name",
        },
    }
    implied = next(c for c in body["changes"] if c["op"] == "putLocalTerm")
    assert implied["confidence"] == "low"
    assert "not declared" in implied["reason"]


def test_a_declared_local_term_is_never_declared_twice() -> None:
    ns = "https://data.acme.example/def/batch/"
    body, errors = convert_with(
        DRAFT,
        [
            blank("setDocumentMapping", documentClass=f"{PH}BatchRecord"),
            blank("putLocalTerm", localIri=f"{ns}Stage", localKind="class", localLabel="Stage"),
            blank("putFieldMapping", "lot", property=f"{ns}lotCode"),
        ],
        local_namespace=ns,
    )
    assert errors == []
    terms = [c["term"] for c in body["changes"] if c["op"] == "putLocalTerm"]
    assert [t["iri"] for t in terms] == [f"{ns}Stage", f"{ns}lotCode"]


def test_local_terms_the_draft_already_declares_may_be_used_again() -> None:
    ns = "https://data.acme.example/def/batch/"
    draft = {
        **MAPPED_DRAFT,
        "semantics": {
            **MAPPED_DRAFT["semantics"],
            "local": [{"iri": f"{ns}lotCode", "kind": "datatype_property", "label": "lot code"}],
        },
    }
    body, errors = convert_with(
        draft, [blank("putFieldMapping", "lot", property=f"{ns}lotCode")], local_namespace=ns
    )
    assert errors == []
    assert [c["op"] for c in body["changes"]] == ["putFieldMapping"]


def test_without_a_base_iri_an_invented_term_is_still_refused() -> None:
    _, errors = convert_with(
        DRAFT,
        [
            blank("setDocumentMapping", documentClass=f"{PH}BatchRecord"),
            blank("putFieldMapping", "lot", property="https://data.acme.example/def/batch/x"),
        ],
        local_namespace=None,
    )
    assert any("is not in the shortlist" in e for e in errors)


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


def test_without_a_base_iri_the_prompt_says_local_terms_are_not_available(
    fixture_specs_dir: Path,
) -> None:
    """Reported: with no customer set, the model declared local terms (refused: no base IRI),
    then left a table's row class empty, and ran out of tries. It must know up front."""
    drafting, _, _, deps = make(fixture_specs_dir)
    drafting.responses = [GOOD]
    run(deps, mapping_job())
    prompt = drafting.calls[0][1].prompt
    assert "Local terms are not available" in prompt
    assert "leave the table and its columns unmapped" in prompt
    assert "Declare local terms under" not in prompt


def test_with_a_base_iri_the_prompt_names_the_local_namespace(fixture_specs_dir: Path) -> None:
    from .fakes import MemoryLinkedDataSettings

    drafting, _, _, deps = make(fixture_specs_dir)
    deps.linked_data = MemoryLinkedDataSettings("https://id.example/acme/")
    drafting.responses = [GOOD]
    run(deps, mapping_job())
    prompt = drafting.calls[0][1].prompt
    assert "Declare local terms under https://id.example/acme/def/batch/" in prompt
    assert "Local terms are not available" not in prompt


@pytest.mark.parametrize(
    ("namespace", "way_out"),
    [
        ("https://ex.example/local#", "declare a local term for it"),
        (None, "local terms are not available here"),
    ],
)
def test_a_table_without_a_row_class_says_how_to_resolve_it(
    namespace: str | None, way_out: str
) -> None:
    inputs = MappingInputs.model_validate(PARAMS_MAPPING)
    data = {
        "notes": "",
        "changes": [
            blank(
                "setDocumentMapping", documentClass=f"{PH}BatchRecord", documentIri="doc/{source}"
            ),
            blank("putTableMapping", "tests", tableLink=f"{PH}hasResult", rowClass=""),
        ],
    }
    _, errors = convert_mapping(data, DRAFT, inputs, SHORTLISTS, local_namespace=namespace)
    [error] = [e for e in errors if "rowClass" in e]
    assert error.startswith("changes[1].rowClass: a table needs a row class")
    assert way_out in error
    assert error.endswith("or leave the table and its columns unmapped")


# --- value nodes ------------------------------------------------------------------------------


def classes_of(*iris: str) -> list[Candidate]:
    return [
        Candidate(
            i, "class", re.split(r"[#/]", i)[-1], "", [], [], [], 0.01, frozenset({"lexical"})
        )
        for i in iris
    ]


def objects_of(*iris: str) -> list[Candidate]:
    return [
        Candidate(
            i, "object_property", re.split(r"[#/]", i)[-1], "", [], [], [], 0.01,
            frozenset({"lexical"}),
        )
        for i in iris
    ]  # fmt: skip


NODE_SHORTLISTS = {
    **SHORTLISTS,
    "tests.assay": [*shortlist_of(f"{PH}testName"), *classes_of(f"{PH}TestResult")],
    "expires": [*shortlist_of(f"{PH}expiryDate"), *classes_of(f"{PH}Specification")],
    "#valueNodes": [*objects_of(f"{PH}hasResult"), *shortlist_of(f"{PH}resultValue")],
}
QUDT_UNIT = "http://qudt.org/vocab/unit/"
DOC_WITH_DEFAULTS = blank(
    "setDocumentMapping",
    documentClass=f"{PH}BatchRecord",
    valueLink=f"{PH}hasResult",
    valueProperty=f"{PH}resultValue",
)
TABLE = blank("putTableMapping", "tests", tableLink=f"{PH}hasResult", rowClass=f"{PH}TestResult")


def convert_nodes(
    changes: list[dict[str, Any]], draft: dict[str, Any] | None = None
) -> tuple[dict[str, Any], list[str]]:
    inputs = MappingInputs.model_validate(PARAMS_MAPPING)
    return convert_mapping(
        {"notes": "", "changes": changes},
        draft or DRAFT,
        inputs,
        NODE_SHORTLISTS,
        local_namespace="https://ex.example/local#",
    )


def node(target: str, **over: Any) -> dict[str, Any]:
    return blank("putFieldMapping", target, valueAs="node", **over)


def test_value_as_includes_node_and_the_new_keys_are_plain_strings() -> None:
    from ingest_worker.mapping_stage import MAPPING_SCHEMA

    item = MAPPING_SCHEMA["properties"]["changes"]["items"]["properties"]
    assert "node" in item["valueAs"]["enum"]
    keys = ("nodeClass", "nodeValue", "nodeUnit", "nodeUnitProperty", "valueLink")
    for key in (*keys, "valueProperty", "unitProperty"):
        assert item[key] == {"type": "string"}, key


def test_a_value_node_takes_the_answers_defaults() -> None:
    body, errors = convert_nodes(
        [DOC_WITH_DEFAULTS, node("expires", nodeClass=f"{PH}Specification")]
    )
    assert errors == []
    document, expires = body["changes"]
    assert document["valueNodes"] == {"link": "pharma:hasResult", "value": "pharma:resultValue"}
    assert expires["mapping"] == {"node": {"class": f"{PH}Specification"}}


def test_a_value_node_takes_the_drafts_defaults() -> None:
    draft = {
        **MAPPED_DRAFT,
        "semantics": {
            **MAPPED_DRAFT["semantics"],
            "valueNodes": {"link": "pharma:hasResult", "value": "pharma:resultValue"},
        },
    }
    body, errors = convert_nodes([node("expires", nodeClass=f"{PH}Specification")], draft)
    assert errors == []
    assert body["changes"][0]["mapping"] == {"node": {"class": "pharma:Specification"}}


def test_a_value_node_without_any_link_or_value_property_is_refused() -> None:
    _, errors = convert_nodes(
        [
            blank("setDocumentMapping", documentClass=f"{PH}BatchRecord"),
            node("expires", nodeClass=f"{PH}Specification"),
        ]
    )
    assert any("a value node needs a link" in e for e in errors), errors
    assert any("a value node needs a value property" in e for e in errors), errors


def test_a_value_nodes_own_terms_are_kept() -> None:
    own = node(
        "expires",
        property=f"{PH}hasResult",
        nodeClass=f"{PH}Specification",
        nodeValue=f"{PH}expiryDate",
    )
    body, errors = convert_nodes(
        [blank("setDocumentMapping", documentClass=f"{PH}BatchRecord"), own]
    )
    assert errors == []
    assert body["changes"][1]["mapping"] == {
        "property": f"{PH}hasResult",
        "node": {"class": f"{PH}Specification", "value": f"{PH}expiryDate"},
    }


def test_a_value_nodes_class_must_be_a_class() -> None:
    _, errors = convert_nodes([DOC_WITH_DEFAULTS, node("expires", nodeClass=f"{PH}expiryDate")])
    assert any(f"{PH}expiryDate is a datatype_property, not a class" in e for e in errors), errors


def test_implied_local_node_terms_get_their_kinds() -> None:
    ns = "https://data.acme.example/def/batch/"
    document = blank(
        "setDocumentMapping",
        documentClass=f"{PH}BatchRecord",
        valueLink=f"{ns}hasOutcome",
        valueProperty=f"{ns}value",
        unitProperty=f"{ns}unit",
    )
    inputs = MappingInputs.model_validate(PARAMS_MAPPING)
    body, errors = convert_mapping(
        {"notes": "", "changes": [document, node("expires", nodeClass=f"{ns}ExpiryDatum")]},
        DRAFT,
        inputs,
        NODE_SHORTLISTS,
        local_namespace=ns,
    )
    assert errors == []
    declared = [c["term"] for c in body["changes"] if c["op"] == "putLocalTerm"]
    assert {t["iri"]: t["kind"] for t in declared} == {
        f"{ns}hasOutcome": "object_property",
        f"{ns}value": "datatype_property",
        f"{ns}unit": "object_property",
        f"{ns}ExpiryDatum": "class",
    }


def test_a_unit_outside_qudt_units_is_refused() -> None:
    change = node(
        "expires",
        nodeClass=f"{PH}Specification",
        nodeUnit="https://units.example/day",
        nodeUnitProperty=f"{PH}hasResult",
    )
    _, errors = convert_nodes([DOC_WITH_DEFAULTS, change])
    assert any("a unit is a QUDT unit" in e for e in errors), errors


def test_a_qudt_unit_is_kept_at_most_medium_and_declares_its_prefix() -> None:
    document = {**DOC_WITH_DEFAULTS, "unitProperty": f"{PH}hasResult"}
    change = node("expires", nodeClass=f"{PH}Specification", nodeUnit=f"{QUDT_UNIT}DAY")
    body, errors = convert_nodes([document, change])
    assert errors == []
    document_change, expires = body["changes"]
    assert document_change["prefixes"]["unit"] == QUDT_UNIT
    assert expires["mapping"]["node"] == {"class": f"{PH}Specification", "unit": f"{QUDT_UNIT}DAY"}
    assert expires["confidence"] == "medium"
    assert "unit not checked against the library" in expires["reason"]


def test_a_unit_needs_a_unit_property() -> None:
    change = node("expires", nodeClass=f"{PH}Specification", nodeUnit=f"{QUDT_UNIT}DAY")
    _, errors = convert_nodes([DOC_WITH_DEFAULTS, change])
    assert any("a unit needs a unit property" in e for e in errors), errors


def test_a_list_cannot_be_a_value_node() -> None:
    draft = json.loads(json.dumps(DRAFT))
    draft["outputs"]["fields"].append({"id": "tags", "type": "list"})
    draft["pipeline"][0]["fields"].append("tags")
    change = node("tags", nodeClass=f"{PH}Specification")
    _, errors = convert_nodes([DOC_WITH_DEFAULTS, change], draft)
    assert any("a list cannot be a value node" in e for e in errors), errors


def test_a_value_node_column_is_merged_into_its_table() -> None:
    body, errors = convert_nodes(
        [DOC_WITH_DEFAULTS, TABLE, node("tests.assay", nodeClass=f"{PH}TestResult")]
    )
    assert errors == []
    table = body["changes"][1]["mapping"]
    assert table["columns"]["assay"] == {"node": {"class": f"{PH}TestResult"}}


def test_every_field_and_column_gets_class_candidates() -> None:
    from ingest_worker.mapping_stage import stage_shortlists

    store = MemoryOntologyStore()
    store.saved[("pharma", 1)] = parse_ontology(FIXTURE.read_bytes(), "text/turtle", "o.ttl")
    outputs = outputs_of(DRAFT)
    queries = {o.path: o.name for o in outputs}
    queries["expires"] = "test result specification expiry date"
    shortlists = stage_shortlists(store, [("pharma", 1)], outputs, queries, {}, None)
    expires = shortlists["expires"]
    assert any(c.kind == "class" for c in expires)  # a date column gets classes now
    assert not any(c.kind in ("concept", "scheme") for c in expires)
    assert sum(c.kind != "class" for c in expires) <= 5  # and fewer properties
    assert {c.iri for c in shortlists["#valueNodes"]} >= {f"{PH}hasResult", f"{PH}resultValue"}


def test_the_prompt_explains_value_nodes(fixture_specs_dir: Path) -> None:
    drafting, _, _, deps = make(fixture_specs_dir)
    drafting.responses = [GOOD]
    run(deps, mapping_job())
    prompt = drafting.calls[0][1].prompt
    assert "- node:" in prompt and "nodeClass" in prompt and "valueLink" in prompt
    assert "prefer node over a literal with a generic property" in prompt
    assert '<candidates output="value nodes' in prompt


# --- mapping memory (docs/design/mapping-memory.md) ----------------------------------------------


def remembered(
    answer: dict[str, Any],
    *,
    name: str = "Lot number",
    kind: str = "field",
    type_: str = "text",
    status: str = "learned",
    votes: int = 1,
    refusals: int = 0,
    external: bool = False,
    id_: str = "m1",
    table: str | None = None,
) -> Any:
    from ingest_worker.mapping_memory import MemoryEntry, Vote, signature_of

    sig = signature_of(kind, name, "", type_, table)
    return MemoryEntry(
        id_, kind, sig.key, name, "", type_, sig.unit, answer, ("pharma",), status,
        tuple(Vote(f"r{i}", "lot", 1, name, "", table, external) for i in range(votes)),
        refusals,
    )  # fmt: skip


def with_memory(deps: PipelineDeps, *entries: Any) -> PipelineDeps:
    from dataclasses import replace

    from ingest_worker.mapping_memory import MemoryMappingMemoryStore

    return replace(deps, mapping_memory=MemoryMappingMemoryStore(entries))


def lot_change(body: dict[str, Any]) -> dict[str, Any] | None:
    return next((c for c in body["changes"] if c.get("field") == "lot"), None)


def candidates_of(prompt: str, path: str) -> str:
    start = prompt.index(f'<candidates output="{path}">')
    return prompt[start : prompt.index("</candidates>", start)]


def test_an_empty_memory_changes_nothing(fixture_specs_dir: Path) -> None:
    prompts, bodies = [], []
    for memory in (False, True):
        drafting, _, store, deps = make(fixture_specs_dir)
        if memory:
            deps = with_memory(deps)
        drafting.responses = [GOOD]
        run(deps, mapping_job())
        prompts.append(drafting.calls[0][1].prompt)
        bodies.append(json.loads(store.get("runs", drafting_key("batch", "job-m")))["body"])
    assert prompts[0] == prompts[1]
    assert bodies[0] == bodies[1]


def test_a_confirmed_answer_is_preselected_over_the_models(fixture_specs_dir: Path) -> None:
    drafting, _, store, deps = make(fixture_specs_dir)
    deps = with_memory(
        deps, remembered({"form": "literal", "property": f"{PH}batchNumber"}, status="confirmed")
    )
    other = {
        "notes": "",
        "changes": [
            GOOD["changes"][0],
            blank("putFieldMapping", "lot", property=f"{PH}productName"),
        ],
    }
    drafting.responses = [other]
    run(deps, mapping_job())
    body = json.loads(store.get("runs", drafting_key("batch", "job-m")))["body"]
    lot = lot_change(body)
    assert lot is not None
    assert lot["mapping"] == {"property": f"{PH}batchNumber"}
    assert lot["remembered"] == {"entryId": "m1", "votes": 1, "status": "confirmed"}
    assert lot["confidence"] == "high"
    prompt = drafting.calls[0][1].prompt
    assert "<already_mapped>" in prompt and "- lot:" in prompt
    assert "from remembered mappings" in body["notes"]


@pytest.mark.parametrize(("votes", "confidence"), [(1, "medium"), (2, "high")])
def test_learned_answers_are_preselected_greedily(
    fixture_specs_dir: Path, votes: int, confidence: str
) -> None:
    drafting, _, store, deps = make(fixture_specs_dir)
    deps = with_memory(
        deps, remembered({"form": "literal", "property": f"{PH}batchNumber"}, votes=votes)
    )
    drafting.responses = [{"notes": "", "changes": [GOOD["changes"][0]]}]
    run(deps, mapping_job())
    lot = lot_change(json.loads(store.get("runs", drafting_key("batch", "job-m")))["body"])
    assert lot is not None and lot["confidence"] == confidence


def test_an_answer_refused_more_than_accepted_is_only_hinted(fixture_specs_dir: Path) -> None:
    drafting, _, store, deps = make(fixture_specs_dir)
    deps = with_memory(
        deps, remembered({"form": "literal", "property": f"{PH}batchNumber"}, refusals=2)
    )
    drafting.responses = [{"notes": "", "changes": [GOOD["changes"][0]]}]
    run(deps, mapping_job())
    body = json.loads(store.get("runs", drafting_key("batch", "job-m")))["body"]
    assert lot_change(body) is None
    prompt = drafting.calls[0][1].prompt
    assert "<already_mapped>" not in prompt
    assert 'Accepted before for "Lot number" in 1 recipe' in prompt


def test_a_rejected_answer_is_removed_from_the_options(fixture_specs_dir: Path) -> None:
    drafting, _, _, deps = make(fixture_specs_dir)
    drafting.responses = [GOOD]
    run(deps, mapping_job())
    assert f"{PH}batchNumber" in candidates_of(drafting.calls[0][1].prompt, "lot")
    drafting, _, _, deps = make(fixture_specs_dir)
    deps = with_memory(
        deps, remembered({"form": "literal", "property": f"{PH}batchNumber"}, status="rejected")
    )
    drafting.responses = [{"notes": "", "changes": [GOOD["changes"][0]]}]
    run(deps, mapping_job())
    assert f"{PH}batchNumber" not in candidates_of(drafting.calls[0][1].prompt, "lot")


def test_remembered_terms_join_the_short_list(fixture_specs_dir: Path) -> None:
    """A similar output's remembered term is offered even when retrieval missed it."""
    drafting, _, store, deps = make(fixture_specs_dir)
    deps = with_memory(
        deps, remembered({"form": "literal", "property": f"{PH}approvalDate"}, name="Lot numbers")
    )
    chosen = blank("putFieldMapping", "lot", property=f"{PH}approvalDate")
    drafting.responses = [{"notes": "", "changes": [GOOD["changes"][0], chosen]}]
    run(deps, mapping_job())
    assert f"{PH}approvalDate" in candidates_of(drafting.calls[0][1].prompt, "lot")
    lot = lot_change(json.loads(store.get("runs", drafting_key("batch", "job-m")))["body"])
    assert lot is not None and "remembered" not in lot  # the model chose it: no provenance


@pytest.mark.parametrize("shareable", [False, True])
def test_an_external_model_sees_only_wording_that_may_leave(
    fixture_specs_dir: Path, shareable: bool
) -> None:
    """Wording from local-only projects never reaches an external model: not as a hint, not
    as a pre-selection."""
    answer = {"form": "literal", "property": f"{PH}batchNumber"}
    drafting, _, _, deps = make(fixture_specs_dir, drafter="external", embedder=None)
    deps = with_memory(deps, remembered(answer, name="Lot numbers", external=shareable))
    drafting.responses = [{"notes": "", "changes": [GOOD["changes"][0]]}]
    run(deps, mapping_job(dataPolicy="external"))
    assert ('"Lot numbers"' in drafting.calls[0][1].prompt) is shareable

    drafting, _, store, deps = make(fixture_specs_dir, drafter="external", embedder=None)
    deps = with_memory(deps, remembered(answer, status="confirmed", external=shareable))
    drafting.responses = [{"notes": "", "changes": [GOOD["changes"][0]]}]
    run(deps, mapping_job(dataPolicy="external"))
    lot = lot_change(json.loads(store.get("runs", drafting_key("batch", "job-m")))["body"])
    assert (lot is not None) is shareable


def test_an_answer_whose_term_is_not_in_the_pinned_ontologies_is_ignored(
    fixture_specs_dir: Path,
) -> None:
    drafting, _, store, deps = make(fixture_specs_dir)
    deps = with_memory(
        deps,
        remembered({"form": "literal", "property": "https://other.example/x"}, status="confirmed"),
    )
    drafting.responses = [{"notes": "", "changes": [GOOD["changes"][0]]}]
    run(deps, mapping_job())
    assert lot_change(json.loads(store.get("runs", drafting_key("batch", "job-m")))["body"]) is None
    assert "other.example" not in drafting.calls[0][1].prompt


def test_a_remembered_table_lets_the_model_map_its_columns(fixture_specs_dir: Path) -> None:
    drafting, _, store, deps = make(fixture_specs_dir)
    table = remembered(
        {"form": "table", "link": f"{PH}hasResult", "class": f"{PH}TestResult"},
        name="tests", kind="table", type_="", status="confirmed",
    )  # fmt: skip
    deps = with_memory(deps, table)
    column = blank("putFieldMapping", "tests.assay", property=f"{PH}testName")
    drafting.responses = [{"notes": "", "changes": [GOOD["changes"][0], column]}]
    queue = run(deps, mapping_job())
    assert queue.completed, queue.reviewed
    body = json.loads(store.get("runs", drafting_key("batch", "job-m")))["body"]
    tests = next(c for c in body["changes"] if c.get("table") == "tests")
    assert tests["mapping"]["link"] == f"{PH}hasResult"
    assert tests["mapping"]["columns"]["assay"] == {"property": f"{PH}testName"}
    assert len(drafting.calls) == 1  # no "map table tests first" round


def test_remembered_value_node_defaults_fill_the_document_change(fixture_specs_dir: Path) -> None:
    from ingest_worker.mapping_memory import MemoryEntry, Vote, defaults_key

    drafting, _, store, deps = make(fixture_specs_dir)
    defaults = MemoryEntry(
        "d1", "document", defaults_key(["pharma"]), "pharma", "", "", "",
        {"form": "valueNodes", "link": f"{PH}hasResult", "value": f"{PH}resultValue"},
        ("pharma",), "confirmed", (Vote("r1", "#valueNodes", 1, "pharma", "", None, False),),
    )  # fmt: skip
    deps = with_memory(deps, defaults)
    drafting.responses = [GOOD]
    run(deps, mapping_job())
    body = json.loads(store.get("runs", drafting_key("batch", "job-m")))["body"]
    document = next(c for c in body["changes"] if c["op"] == "setDocumentMapping")
    assert document["valueNodes"] == {
        "link": "pharma:hasResult",
        "value": "pharma:resultValue",
    }


def test_signatures_are_embedded_once_and_kept(fixture_specs_dir: Path) -> None:
    drafting, embedding, _, deps = make(fixture_specs_dir)
    deps = with_memory(deps, remembered({"form": "literal", "property": f"{PH}batchNumber"}))
    drafting.responses = [GOOD]
    run(deps, mapping_job())
    memory = deps.mapping_memory
    assert memory is not None
    assert memory.vectors("emb/nomic", ["m1"])  # type: ignore[attr-defined]
    calls = len(embedding.embed_calls)
    drafting.responses = [GOOD]
    run(deps, mapping_job())
    assert len(embedding.embed_calls) == calls + 2  # the outputs twice; the entry not again
