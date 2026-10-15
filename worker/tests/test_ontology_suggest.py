"""Ontology suggestions for the survey (ADR 0011 follow-up)."""

from __future__ import annotations

from pathlib import Path

import pytest

from ingest_worker.ontology import parse_ontology, trigram_similarity

from .fakes import MemoryOntologyStore, fake_vector

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
