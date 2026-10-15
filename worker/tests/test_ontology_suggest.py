"""Ontology suggestions for the survey (ADR 0011 follow-up)."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.config import REPO_ROOT
from ingest_worker.llm.registry import ModelRegistry, ProviderConfig
from ingest_worker.main import run_once
from ingest_worker.ontology import parse_ontology, trigram_similarity
from ingest_worker.ontology_suggest import (
    LibraryVersion,
    SuggestCandidate,
    SuggestionRecord,
    SuggestParams,
    SuggestPin,
    library_key,
    suggest_ontologies,
)
from ingest_worker.pipeline import Buckets, PipelineDeps
from ingest_worker.queue import ClaimedJob
from ingest_worker.storage import MemoryObjectStore, ontology_suggestions_key

from .fakes import FakeProvider, FakeQueue, MemoryOntologyStore, fake_vector

RECALL = Path(__file__).parent / "fixtures" / "mapping-recall" / "ontology.ttl"


@pytest.mark.parametrize(
    ("a", "b", "expected"),
    [
        ("substance", "active substance", 10 / 17),
        ("date", "expiry date", 5 / 12),
        ("expiry date", "expiry date", 1.0),
        ("", "anything", 0.0),
        ("Batch", "batch", 1.0),
    ],
)
def test_trigram_similarity_follows_pg_trgm(a: str, b: str, expected: float) -> None:
    assert trigram_similarity(a, b) == pytest.approx(expected, abs=1e-6)


def recall_store() -> MemoryOntologyStore:
    s = MemoryOntologyStore()
    s.saved[("pharma", 1)] = parse_ontology(RECALL.read_bytes(), "text/turtle", "o.ttl")
    return s


def test_lexical_best_gives_one_hit_per_version_above_the_threshold() -> None:
    s = recall_store()
    s.saved[("copy", 1)] = s.saved[("pharma", 1)]
    hits = s.lexical_best([("pharma", 1), ("copy", 1)], "expiry date", ["datatype_property"], 0.45)
    assert {(h.ontology_id, h.version) for h in hits} == {("pharma", 1), ("copy", 1)}
    assert all(h.term.iri == "https://ex.example/pharma#expiryDate" for h in hits)
    assert all(h.similarity >= 0.45 for h in hits)
    assert s.lexical_best([("pharma", 1)], "zzz qqq", ["datatype_property"], 0.45) == []


def test_semantic_best_uses_cosine_similarity() -> None:
    from ingest_worker.embeddings import term_text

    s = recall_store()
    s.store_embeddings(
        "pharma",
        1,
        "emb/fake",
        [
            (
                t.kind,
                t.iri,
                "sha",
                fake_vector(term_text(t.label, t.alt_labels, t.definition, t.parents)),
            )
            for t in s.embedding_terms("pharma", 1)
        ],
    )
    target = next(t for t in s.embedding_terms("pharma", 1) if t.iri.endswith("#expiryDate"))
    vector = fake_vector(
        term_text(target.label, target.alt_labels, target.definition, target.parents)
    )
    hits = s.semantic_best([("pharma", 1)], "emb/fake", vector, ["datatype_property"], 0.6)
    assert hits[0].term.iri.endswith("#expiryDate")
    assert hits[0].similarity == pytest.approx(1.0)


SUGGEST = Path(__file__).parent / "fixtures" / "ontology-suggest"
SHARED = json.loads(
    (
        REPO_ROOT / "packages" / "shared" / "test" / "fixtures" / "ontology-suggestions.json"
    ).read_text(encoding="utf-8")
)


def library_store() -> tuple[MemoryOntologyStore, list[LibraryVersion]]:
    s = MemoryOntologyStore()
    library = []
    for name, terms in [("domain", 3), ("merged", 4), ("units", 3)]:
        s.saved[(name, 1)] = parse_ontology(
            (SUGGEST / f"{name}.ttl").read_bytes(), "text/turtle", f"{name}.ttl"
        )
        library.append(LibraryVersion(id=name, version=1, label=name.title(), terms=terms))
    return s, library


def cand(name: str, kind: str = "field", description: str = "") -> SuggestCandidate:
    return SuggestCandidate(name=name, description=description, kind=kind)  # type: ignore[arg-type]


CANDIDATES = [
    cand("active_substance", "table"),
    cand("batch_number"),
    cand("expiry_date"),
    cand("unit_of_measure"),
    cand("strength"),
    cand("signatory_name"),
]


@pytest.mark.parametrize(
    "case", SHARED["libraryKeys"], ids=[c["name"] for c in SHARED["libraryKeys"]]
)
def test_library_key_matches_the_shared_fixture(case: dict[str, Any]) -> None:
    versions = [(v["id"], v["version"]) for v in case["versions"]]
    assert library_key(versions, case["model"]) == case["key"]


def test_shared_params_and_record_parse() -> None:
    assert (
        SuggestParams.model_validate(SHARED["params"]).model_dump(by_alias=True) == SHARED["params"]
    )
    assert (
        SuggestionRecord.model_validate(SHARED["record"]).model_dump(by_alias=True)
        == SHARED["record"]
    )


def test_set_cover_picks_the_module_then_units_and_lists_the_merged_copy() -> None:
    s, library = library_store()
    out = suggest_ontologies(s, CANDIDATES, library, [], vectors=None, model_ref=None)
    assert [x["ontologyId"] for x in out["suggestions"]] == ["domain", "units"]
    assert out["suggestions"][0]["covers"] == ["active_substance", "batch_number", "expiry_date"]
    assert [x["ontologyId"] for x in out["alsoMatched"]] == ["merged"]
    assert out["uncovered"] == ["signatory_name"]
    ev = out["suggestions"][0]["evidence"][0]
    assert ev == {
        "candidate": "active_substance",
        "iri": "https://ex.example/domain#ActiveSubstance",
        "label": "Active substance",
        "kind": "class",
        "via": "lexical",
        "similarity": 1.0,
    }


def test_a_generic_label_does_not_cover_a_longer_name() -> None:
    s, library = library_store()
    out = suggest_ontologies(
        s, [cand("expiry_date")], library[2:], [], vectors=None, model_ref=None
    )
    # units' "date" vs "expiry date" is 5/12 < MIN_LEXICAL.
    assert out["suggestions"] == [] and out["uncovered"] == ["expiry_date"]


def test_pins_count_first_and_are_never_suggested() -> None:
    s, library = library_store()
    out = suggest_ontologies(
        s,
        CANDIDATES,
        library,
        [SuggestPin(ontology_id="domain", version=1)],
        vectors=None,
        model_ref=None,
    )
    assert out["pinned"] == [
        {
            "ontologyId": "domain",
            "version": 1,
            "label": "Domain",
            "covers": ["active_substance", "batch_number", "expiry_date"],
        }
    ]
    assert [x["ontologyId"] for x in out["suggestions"]] == ["units"]
    # merged adds nothing beyond the pin: not even "also matched" (it covers only pinned ground).
    assert out["alsoMatched"] == []


def test_a_pin_missing_from_the_store_covers_nothing() -> None:
    s, library = library_store()
    out = suggest_ontologies(
        s,
        CANDIDATES,
        library,
        [SuggestPin(ontology_id="gone", version=4)],
        vectors=None,
        model_ref=None,
    )
    assert out["pinned"] == [{"ontologyId": "gone", "version": 4, "label": "gone", "covers": []}]
    assert [x["ontologyId"] for x in out["suggestions"]] == ["domain", "units"]


def test_min_gain_stops_a_single_candidate_ontology() -> None:
    s, library = library_store()
    out = suggest_ontologies(s, [cand("strength")], library, [], vectors=None, model_ref=None)
    assert out["suggestions"] == [] and out["uncovered"] == ["strength"]


def test_blank_candidate_names_are_uncovered_not_errors() -> None:
    s, library = library_store()
    out = suggest_ontologies(
        s, [cand(""), cand("___"), *CANDIDATES[:3]], library, [], vectors=None, model_ref=None
    )
    assert out["candidates"] == 5
    assert "" in out["uncovered"] and "___" in out["uncovered"]


def test_semantic_hits_count_and_say_how_they_were_found() -> None:
    from ingest_worker.embeddings import term_text

    s, library = library_store()
    for name in ("domain", "units"):
        s.store_embeddings(
            name, 1, "emb/fake",
            [(t.kind, t.iri, "sha", fake_vector(term_text(t.label, t.alt_labels, t.definition, t.parents)))
             for t in s.embedding_terms(name, 1)],
        )  # fmt: skip
    # "signatory" shares no trigram-similar label, but its vector equals the strength term's.
    candidates = [
        cand("signatory", description="strength"),
        cand("strength"),
        cand("unit_of_measure"),
    ]
    vectors = [fake_vector("strength"), fake_vector("strength"), fake_vector("unit of measure")]
    out = suggest_ontologies(
        s, candidates, library[:1] + library[2:], [], vectors=vectors, model_ref="emb/fake"
    )
    units = next(x for x in out["suggestions"] if x["ontologyId"] == "units")
    assert "signatory" in units["covers"]
    vias = {e["candidate"]: e["via"] for e in units["evidence"]}
    assert vias["signatory"] == "semantic" and vias["strength"] == "both"


LIBRARY = [
    {"id": "domain", "version": 1, "label": "Domain", "terms": 3},
    {"id": "units", "version": 1, "label": "Units", "terms": 3},
]
JOB_CANDIDATES = [
    {"name": "active_substance", "description": "", "kind": "table"},
    {"name": "batch_number", "description": "", "kind": "field"},
    {"name": "expiry_date", "description": "", "kind": "field"},
]


def suggest_deps(
    embedder: str | None = None,
) -> tuple[FakeProvider, MemoryObjectStore, PipelineDeps]:
    s, _ = library_store()
    emb = FakeProvider("emb")
    store = MemoryObjectStore()
    configs = {"emb": ProviderConfig(name="emb", kind="openai-chat", location=embedder or "local")}  # type: ignore[arg-type]
    deps = PipelineDeps(
        store=store,
        specs={},  # type: ignore[arg-type]
        models=ModelRegistry({"emb": emb}, configs, {}),
        extract_text=lambda _pdf: [],
        buckets=Buckets("inbox", "outputs", "runs"),
        ontologies=s,
        embedding_model="emb/nomic" if embedder else None,
    )
    if embedder:
        from ingest_worker.embeddings import term_text

        s.store_embeddings(
            "domain", 1, "emb/nomic",
            [(t.kind, t.iri, "sha", fake_vector(term_text(t.label, t.alt_labels, t.definition, t.parents)))
             for t in s.embedding_terms("domain", 1)],
        )  # fmt: skip
    return emb, store, deps


def suggest_job(**params: Any) -> ClaimedJob:
    base = {
        "surveyProposalId": "survey-1",
        "candidates": JOB_CANDIDATES,
        "library": LIBRARY,
        "pinned": [],
        "dataPolicy": "local",
    }
    return ClaimedJob(
        id="job-s", document_id="", spec_id="letter", spec_version=0, bucket="", object_key="",
        model_override=None, attempts=1, max_attempts=3, task="suggest", test=True,
        project_id="letter", params={**base, **params},
    )  # fmt: skip


def test_suggest_job_writes_the_record() -> None:
    _, store, deps = suggest_deps()
    queue = FakeQueue(jobs=[suggest_job()])
    run_once(queue, deps, "w1")
    assert queue.completed
    record = SuggestionRecord.model_validate(
        json.loads(store.get("runs", ontology_suggestions_key("letter", "job-s")))
    )
    assert record.survey_proposal_id == "survey-1"
    assert record.library_key == "lexical|domain@1,units@1"
    assert [s.ontology_id for s in record.suggestions] == ["domain"]
    assert record.notes == ["Retrieval was lexical only: no embedding model is set."]


def test_a_local_project_never_embeds_with_an_external_model() -> None:
    emb, store, deps = suggest_deps(embedder="external")
    queue = FakeQueue(jobs=[suggest_job()])
    run_once(queue, deps, "w1")
    assert emb.embed_calls == []
    record = json.loads(store.get("runs", ontology_suggestions_key("letter", "job-s")))
    assert any("may only use local models" in n for n in record["notes"])


def test_an_external_project_embeds_and_logs_the_call() -> None:
    emb, _, deps = suggest_deps(embedder="external")
    queue = FakeQueue(jobs=[suggest_job(dataPolicy="external")])
    run_once(queue, deps, "w1")
    assert emb.embed_calls
    assert any(
        e[2] == "external model call" and e[3]["purpose"] == "embedding"
        for e in queue.event_details
    )


def test_invalid_suggest_params_need_review() -> None:
    _, _, deps = suggest_deps()
    queue = FakeQueue(jobs=[suggest_job(extra=1)])
    run_once(queue, deps, "w1")
    assert queue.reviewed
