"""Hybrid term retrieval for the mapping stage (ADR 0011): lexical, semantic, fused by RRF."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.ontology import parse_ontology
from ingest_worker.retrieval import RRF_K, fuse, shortlist

from .fakes import MemoryOntologyStore, fake_vector

FIXTURE = Path(__file__).parent / "fixtures" / "mapping-recall"
VERSIONS = [("pharma", 1)]
MODEL = "emb/fake"


@pytest.mark.parametrize(
    ("rankings", "expected"),
    [
        ([], []),
        ([["a", "b"]], ["a", "b"]),
        ([["a", "b"], ["b", "a"]], ["a", "b"]),  # a tie keeps the first ranking's order
        # c: 1/63 + 1/61 = 0.032266 just beats b: 2/62 = 0.032258.
        ([["a", "b", "c"], ["c", "b"]], ["c", "b", "a"]),
        ([["a"], ["b"], ["b"]], ["b", "a"]),
    ],
)
def test_fuse(rankings: list[list[str]], expected: list[str]) -> None:
    fused = fuse(rankings)
    assert [iri for iri, _ in fused] == expected
    if rankings and rankings[0]:
        top = rankings[0][0]
        assert dict(fused)[top] >= 1 / (RRF_K + 1)


def store(embedded: bool = True) -> MemoryOntologyStore:
    s = MemoryOntologyStore()
    s.saved[VERSIONS[0]] = parse_ontology(
        (FIXTURE / "ontology.ttl").read_bytes(), "text/turtle", "ontology.ttl"
    )
    if embedded:
        from ingest_worker.embeddings import term_text

        s.store_embeddings(
            *VERSIONS[0],
            MODEL,
            [
                (
                    t.kind,
                    t.iri,
                    "sha",
                    fake_vector(term_text(t.label, t.alt_labels, t.definition, t.parents)),
                )
                for t in s.embedding_terms(*VERSIONS[0])
            ],
        )
    return s


CASES: list[dict[str, Any]] = json.loads((FIXTURE / "cases.json").read_text(encoding="utf-8"))[
    "cases"
]


def recall(mode: str, k: int) -> float:
    s = store()
    hits = 0
    for case in CASES:
        vector = fake_vector(case["query"]) if mode != "lexical" else None
        found, _ = shortlist(
            s,
            VERSIONS,
            "" if mode == "semantic" else case["query"],
            case["kinds"],
            vector=vector,
            model_ref=MODEL,
            k=k,
        )
        iris = {c.iri for c in found}
        hits += sum(1 for e in case["expected"] if e in iris)
    return hits / sum(len(c["expected"]) for c in CASES)


def test_recall_at_15_of_lexical_semantic_and_hybrid() -> None:
    lexical, semantic, hybrid = recall("lexical", 15), recall("semantic", 15), recall("hybrid", 15)
    assert lexical >= 0.6
    assert hybrid >= max(lexical, semantic) - 0.1
    assert hybrid >= 0.8


def test_shortlist_keeps_the_kinds_asked_for_and_says_whether_it_used_embeddings() -> None:
    found, semantic = shortlist(
        store(), VERSIONS, "batch", ["class"], vector=fake_vector("batch"), model_ref=MODEL, k=15
    )
    assert semantic is True
    assert found and all(c.kind == "class" for c in found)
    assert found[0].iri == "https://ex.example/pharma#Batch"
    assert {"lexical", "semantic"} <= set().union(*(c.sources for c in found))


def test_without_embeddings_retrieval_is_lexical() -> None:
    found, semantic = shortlist(
        store(embedded=False),
        VERSIONS,
        "expiry date",
        ["datatype_property"],
        vector=fake_vector("expiry date"),
        model_ref=MODEL,
        k=3,
    )
    assert semantic is False
    assert found[0].iri == "https://ex.example/pharma#expiryDate"
    assert all(c.sources == frozenset({"lexical"}) for c in found)


def test_a_candidate_carries_what_the_model_needs_to_choose() -> None:
    [top, *_] = shortlist(
        store(), VERSIONS, "batch number", ["datatype_property"], vector=None, model_ref=None, k=1
    )[0]
    assert top.label == "batch number"
    assert top.domain == ["https://ex.example/pharma#Batch"]
    assert top.range == ["http://www.w3.org/2001/XMLSchema#string"]
    assert "identifier" in top.definition


@pytest.mark.integration
def test_pg_lexical_and_semantic_retrieval() -> None:
    """Needs IH_TEST_DATABASE_URL on a throwaway pgvector database with db/migrations applied."""
    url = os.environ.get("IH_TEST_DATABASE_URL")
    if not url:
        pytest.skip("IH_TEST_DATABASE_URL not set")
    import psycopg

    from ingest_worker.embeddings import term_text
    from ingest_worker.ontology import PgOntologyStore

    conn = psycopg.connect(url, autocommit=True)
    conn.execute("DELETE FROM ontologies WHERE id = 'pharma-worker-test'")
    conn.execute("INSERT INTO ontologies (id, label) VALUES ('pharma-worker-test', 'P')")
    conn.execute(
        """INSERT INTO ontology_versions (ontology_id, version, file_name, media_type, sha256, bytes)
           VALUES ('pharma-worker-test', 1, 'p.ttl', 'text/turtle', 'abc', 10)"""
    )
    pg = PgOntologyStore(conn)
    pg.save(
        "pharma-worker-test",
        1,
        parse_ontology((FIXTURE / "ontology.ttl").read_bytes(), "text/turtle", "o.ttl"),
    )
    versions = [("pharma-worker-test", 1)]
    lexical = pg.lexical(versions, "expiry date", ["datatype_property"], 5)
    assert lexical[0].iri == "https://ex.example/pharma#expiryDate"
    assert pg.has_embeddings(versions, MODEL) is False
    pg.store_embeddings(
        "pharma-worker-test",
        1,
        MODEL,
        [
            (
                t.kind,
                t.iri,
                "sha",
                fake_vector(term_text(t.label, t.alt_labels, t.definition, t.parents)),
            )
            for t in pg.embedding_terms("pharma-worker-test", 1)
        ],
    )
    assert pg.has_embeddings(versions, MODEL) is True
    semantic = pg.semantic(versions, MODEL, fake_vector("expiry date"), ["datatype_property"], 5)
    assert "https://ex.example/pharma#expiryDate" in [t.iri for t in semantic]
    found, used = shortlist(
        pg, versions, "lot number", ["datatype_property"], vector=fake_vector("lot number"),
        model_ref=MODEL, k=3,
    )  # fmt: skip
    assert used and found[0].iri == "https://ex.example/pharma#batchNumber"
    conn.execute("DELETE FROM ontologies WHERE id = 'pharma-worker-test'")
    conn.close()
