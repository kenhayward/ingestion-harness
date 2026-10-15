"""Hybrid ontology term retrieval for the mapping stage (ADR 0011).

Two rankings over the brief's vocabulary versions: lexical (labels and synonyms by trigram,
definitions by full text) and, when the versions have embeddings for the current model, semantic
(cosine distance to the output's embedding). They merge by reciprocal rank fusion, so a term
both find ranks first and neither ranking's raw scores need calibrating against the other.
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .ontology import OntologyStore, Term

#: Reciprocal rank fusion constant (Cormack et al.): damps the weight of the top ranks.
RRF_K = 60
#: How many rows each ranking contributes before fusion.
PER_RANKING = 50


@dataclass(frozen=True)
class Candidate:
    iri: str
    kind: str
    label: str
    definition: str
    parents: list[str]
    domain: list[str]
    range: list[str]
    score: float
    #: Which rankings found it: `lexical`, `semantic`.
    sources: frozenset[str]


def fuse(rankings: Sequence[Sequence[str]], k: int = RRF_K) -> list[tuple[str, float]]:
    """Reciprocal rank fusion: each IRI scores the sum of 1/(k + rank) over the rankings that
    hold it. Ties keep the order of first appearance."""
    scores: dict[str, float] = {}
    for ranking in rankings:
        for rank, iri in enumerate(ranking, start=1):
            scores[iri] = scores.get(iri, 0.0) + 1.0 / (k + rank)
    order = {iri: i for i, iri in enumerate(dict.fromkeys(i for r in rankings for i in r))}
    return sorted(scores.items(), key=lambda kv: (-kv[1], order[kv[0]]))


def shortlist(
    store: OntologyStore,
    versions: list[tuple[str, int]],
    query: str,
    kinds: Sequence[str],
    *,
    vector: list[float] | None,
    model_ref: str | None,
    k: int = 15,
) -> tuple[list[Candidate], bool]:
    """The k best terms of `kinds` for `query`, and whether embeddings took part."""
    lexical: list[Term] = store.lexical(versions, query, list(kinds), PER_RANKING) if query else []
    semantic: list[Term] = []
    used = bool(vector) and model_ref is not None and store.has_embeddings(versions, model_ref)
    if used and vector is not None and model_ref is not None:
        semantic = store.semantic(versions, model_ref, vector, list(kinds), PER_RANKING)
    terms = {t.iri: t for t in [*semantic, *lexical]}
    found = {"lexical": {t.iri for t in lexical}, "semantic": {t.iri for t in semantic}}
    fused = fuse([[t.iri for t in lexical], [t.iri for t in semantic]])
    out = [
        Candidate(
            iri=iri,
            kind=terms[iri].kind,
            label=terms[iri].label,
            definition=terms[iri].definition,
            parents=list(terms[iri].parents),
            domain=list(terms[iri].domain),
            range=list(terms[iri].range),
            score=round(score, 6),
            sources=frozenset(name for name, iris in found.items() if iri in iris),
        )
        for iri, score in fused[:k]
    ]
    return out, used
