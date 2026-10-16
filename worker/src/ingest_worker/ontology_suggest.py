"""Ontology suggestions for the Workbench survey (ADR 0011 follow-up; spec
docs/superpowers/specs/2026-10-15-survey-ontology-suggestions-design.md).

Each survey candidate is looked up in the term index of every library version: lexically (its
name, pg_trgm similarity against labels and synonyms) and, when allowed, semantically (its name
and description, cosine against the term embeddings). A candidate is covered by an ontology when
one of its terms clears an absolute threshold. A greedy set cover then picks the few ontologies
that cover most candidates, starting from the brief's pins. Mirrors
packages/shared/src/ontology-suggestions.ts.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .llm.registry import ModelResolutionError
from .mapping_stage import CLASS_KINDS, PROPERTY_KINDS
from .pipeline import DocumentError, PipelineDeps, check_cancelled
from .queue import ClaimedJob, JobQueue
from .storage import ontology_suggestions_key

if TYPE_CHECKING:
    from .ontology import OntologyStore, TermHit

MIN_LEXICAL = 0.45
MIN_SEMANTIC = 0.6
MIN_GAIN = 2
MAX_SUGGESTIONS = 5
MAX_EVIDENCE = 5
MAX_ALSO_MATCHED = 5

_MODEL = ConfigDict(extra="forbid", populate_by_name=True)


class LibraryVersion(BaseModel):
    model_config = _MODEL

    id: str = Field(min_length=1)
    version: int = Field(gt=0)
    label: str
    terms: int = Field(ge=0)


class SuggestPin(BaseModel):
    model_config = _MODEL

    ontology_id: str = Field(alias="ontologyId", min_length=1)
    version: int = Field(gt=0)


class SuggestCandidate(BaseModel):
    #: Survey candidates also carry `where` and `seenIn`; only these three are read.
    model_config = ConfigDict(extra="ignore")

    name: str
    description: str
    kind: Literal["field", "table"]


class SuggestParams(BaseModel):
    """jobs.params of a `suggest` job (TS SuggestParamsSchema)."""

    model_config = _MODEL

    survey_proposal_id: str = Field(alias="surveyProposalId", min_length=1)
    candidates: list[SuggestCandidate]
    library: list[LibraryVersion]
    pinned: list[SuggestPin]
    data_policy: Literal["local", "external"] = Field(alias="dataPolicy")


class Evidence(BaseModel):
    model_config = _MODEL

    candidate: str
    iri: str
    label: str
    kind: str
    via: Literal["lexical", "semantic", "both"]
    similarity: float


class Cover(BaseModel):
    model_config = _MODEL

    ontology_id: str = Field(alias="ontologyId")
    version: int
    label: str
    covers: list[str]


class Suggestion(Cover):
    evidence: list[Evidence]


class AlsoMatched(Cover):
    #: The candidates it covers beyond the pins and the suggestions (older records: none).
    adds: list[str] = Field(default_factory=list)
    evidence: list[Evidence] = Field(default_factory=list)


class SuggestionRecord(BaseModel):
    """What a survey or refresh writes (TS SuggestionRecordSchema)."""

    model_config = _MODEL

    survey_proposal_id: str = Field(alias="surveyProposalId")
    created_at: str = Field(alias="createdAt")
    candidates: int
    library_key: str = Field(alias="libraryKey")
    suggestions: list[Suggestion]
    pinned: list[Cover]
    also_matched: list[AlsoMatched] = Field(alias="alsoMatched")
    uncovered: list[str]
    notes: list[str]


def library_key(versions: list[tuple[str, int]], model_ref: str | None) -> str:
    """TS ontologyLibraryKey: the embedding model, then the sorted id@version list."""
    ids = ",".join(f"{i}@{v}" for i, v in sorted(versions))
    return f"{model_ref or 'lexical'}|{ids}"


def lexical_query(name: str) -> str:
    """`active_substance` -> `active substance`; blank when the name has no letters or digits."""
    return " ".join(re.findall(r"[A-Za-z0-9]+", name.replace("_", " ")))


def semantic_query(c: SuggestCandidate) -> str:
    return f"{lexical_query(c.name)}: {c.description}".strip(" :")


@dataclass
class _Hit:
    term_iri: str
    label: str
    kind: str
    similarity: float
    via: set[str] = field(default_factory=set)


def _kinds(c: SuggestCandidate) -> list[str]:
    return list(CLASS_KINDS) if c.kind == "table" else [*PROPERTY_KINDS, *CLASS_KINDS]


def _merge(into: dict[tuple[str, int], _Hit], hits: list[TermHit], via: str) -> None:
    for h in hits:
        key = (h.ontology_id, h.version)
        old = into.get(key)
        if old is not None and old.term_iri == h.term.iri:
            old.via.add(via)
            old.similarity = max(old.similarity, h.similarity)
        elif old is None or h.similarity > old.similarity:
            into[key] = _Hit(h.term.iri, h.term.label, h.term.kind, h.similarity, {via})


def suggest_ontologies(
    store: OntologyStore,
    candidates: list[SuggestCandidate],
    library: list[LibraryVersion],
    pinned: list[SuggestPin],
    *,
    vectors: list[list[float]] | None,
    model_ref: str | None,
) -> dict[str, Any]:
    pins = [(p.ontology_id, p.version) for p in pinned]
    queried = list(dict.fromkeys([(v.id, v.version) for v in library] + pins))
    labels = {(v.id, v.version): v.label for v in library}
    sizes = {(v.id, v.version): v.terms for v in library}

    # hits[i][version] = candidate i's best term in that version.
    hits: list[dict[tuple[str, int], _Hit]] = []
    for c in candidates:
        found: dict[tuple[str, int], _Hit] = {}
        text = lexical_query(c.name)
        if text:
            _merge(found, store.lexical_best(queried, text, _kinds(c), MIN_LEXICAL), "lexical")
        hits.append(found)
    if vectors is not None and model_ref is not None:
        # One pass over the library's embeddings for every candidate.
        semantic = store.semantic_best(
            queried, model_ref, vectors, [_kinds(c) for c in candidates], MIN_SEMANTIC
        )
        for found, matches in zip(hits, semantic, strict=True):
            _merge(found, matches, "semantic")

    cover = {v: {i for i, h in enumerate(hits) if v in h} for v in queried}
    covered: set[int] = set().union(*(cover[p] for p in pins)) if pins else set()
    chosen: list[tuple[str, int]] = []
    pool = sorted(v for v in queried if v not in pins)

    def rank(v: tuple[str, int], covered: set[int]) -> tuple[int, float, int]:
        gain = cover[v] - covered
        return (len(gain), sum(hits[i][v].similarity for i in gain), -sizes.get(v, 0))

    while len(chosen) < MAX_SUGGESTIONS:
        best = max(
            (v for v in pool if v not in chosen),
            key=lambda v: rank(v, covered),
            default=None,
        )
        if best is None or len(cover[best] - covered) < MIN_GAIN:
            break
        chosen.append(best)
        covered |= cover[best]

    names = [c.name for c in candidates]

    def entry(v: tuple[str, int]) -> dict[str, Any]:
        return {
            "ontologyId": v[0],
            "version": v[1],
            "label": labels.get(v, v[0]),
            "covers": [names[i] for i in sorted(cover[v])],
        }

    def evidence(v: tuple[str, int], only: set[int] | None = None) -> list[dict[str, Any]]:
        out = []
        for i in sorted(cover[v] if only is None else only)[:MAX_EVIDENCE]:
            h = hits[i][v]
            via = "both" if len(h.via) == 2 else next(iter(h.via))
            out.append(
                {
                    "candidate": names[i],
                    "iri": h.term_iri,
                    "label": h.label,
                    "kind": h.kind,
                    "via": via,
                    "similarity": round(h.similarity, 3),
                }
            )
        return out

    # Also matched: the ontologies left out that would still add candidates beyond the pins and
    # the suggestions (below MIN_GAIN, or past MAX_SUGGESTIONS), most added first, with the
    # terms behind what they add. One that only repeats covered ground is not worth listing.
    adds = {v: cover[v] - covered for v in pool if v not in chosen}
    also = sorted(
        (v for v, extra in adds.items() if extra),
        key=lambda v: (-len(adds[v]), -len(cover[v]), v),
    )[:MAX_ALSO_MATCHED]
    return {
        "candidates": len(candidates),
        "suggestions": [{**entry(v), "evidence": evidence(v)} for v in chosen],
        "pinned": [entry(p) for p in pins],
        "alsoMatched": [
            {
                **entry(v),
                "adds": [names[i] for i in sorted(adds[v])],
                "evidence": evidence(v, adds[v]),
            }
            for v in also
        ],
        "uncovered": [names[i] for i in range(len(candidates)) if i not in covered],
    }


def _vectors(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    candidates: list[SuggestCandidate],
    library: list[tuple[str, int]],
    data_policy: str,
    stage: str,
    notes: list[str],
) -> tuple[list[list[float]] | None, str | None]:
    """The candidates' embeddings and the model, or (None, None) with a note: lexical only."""
    ref = deps.embedding_model
    if ref is None:
        notes.append("Retrieval was lexical only: no embedding model is set.")
        return None, None
    try:
        provider, model_id = deps.models.resolve_embedding(ref)
    except ModelResolutionError as exc:
        notes.append(f"Retrieval was lexical only: {exc}.")
        return None, None
    external = deps.models.location(provider.name) == "external"
    if external and data_policy == "local":
        notes.append(
            f"Retrieval was lexical only: the embedding model {ref} is external and this "
            "project may only use local models."
        )
        return None, None
    store = deps.ontologies
    if store is None or not store.has_embeddings(library, ref):
        notes.append(f"Retrieval was lexical only: no ontology is embedded for {ref} yet.")
        return None, None
    try:
        vectors = provider.embed(model_id, [semantic_query(c) for c in candidates])
    except Exception as exc:  # an outage costs the semantic half, never the suggestions
        notes.append(f"Retrieval was lexical only: the embedding model failed: {exc}.")
        return None, None
    if external:
        queue.event(
            job.id,
            "info",
            "external model call",
            {"stage": stage, "purpose": "embedding", "model": ref, "candidates": len(candidates)},
        )
    return vectors, ref


def run_suggestions(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    *,
    survey_proposal_id: str,
    candidates: list[SuggestCandidate],
    library: list[LibraryVersion],
    pinned: list[SuggestPin],
    data_policy: str,
    stage: str,
) -> dict[str, Any]:
    """Compute and write a suggestion record (runs bucket) for this job; returns it."""
    store = deps.ontologies
    if store is None:
        raise DocumentError("ontology suggestions need the ontology library")
    if job.project_id is None:
        raise DocumentError("ontology suggestions without a project")
    versions = [(v.id, v.version) for v in library]
    notes: list[str] = []
    vectors, ref = _vectors(job, deps, queue, candidates, versions, data_policy, stage, notes)
    body = suggest_ontologies(store, candidates, library, pinned, vectors=vectors, model_ref=ref)
    record = SuggestionRecord.model_validate(
        {
            "surveyProposalId": survey_proposal_id,
            "createdAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
            "libraryKey": library_key(versions, deps.embedding_model),
            "notes": notes,
            **body,
        }
    ).model_dump(by_alias=True)
    check_cancelled(job, queue)
    deps.store.put(
        deps.buckets.runs,
        ontology_suggestions_key(job.project_id, job.id),
        json.dumps(record).encode(),
        "application/json",
    )
    return record


def queue_suggestions(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    *,
    candidates: list[SuggestCandidate],
    library: list[LibraryVersion],
    pinned: list[SuggestPin],
    data_policy: Literal["local", "external"],
) -> str:
    """A survey's suggestions, as a `suggest` job of their own: matching the candidates against
    a large library takes minutes, and the survey is done when the model replies. The job's
    record names this survey (`surveyProposalId` = the survey job), so the Survey tab shows it as
    the survey's; the project's earlier suggest job and its record are replaced."""
    if job.project_id is None:
        raise DocumentError("ontology suggestions without a project")
    params = SuggestParams.model_validate(
        {
            "surveyProposalId": job.id,
            "candidates": [c.model_dump() for c in candidates],
            "library": [v.model_dump(by_alias=True) for v in library],
            "pinned": [p.model_dump(by_alias=True) for p in pinned],
            "dataPolicy": data_policy,
        }
    ).model_dump(by_alias=True)
    suggest_id, removed = queue.queue_suggest(job.project_id, params)
    for old in removed:
        deps.store.delete(deps.buckets.runs, ontology_suggestions_key(job.project_id, old))
    return suggest_id


def run_suggest(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> dict[str, Any]:
    """The `suggest` task: Refresh suggestions on the Survey tab."""
    try:
        params = SuggestParams.model_validate(job.params or {})
    except ValidationError as exc:
        raise DocumentError(f"invalid suggestion parameters: {exc}") from exc
    return run_suggestions(
        job,
        deps,
        queue,
        survey_proposal_id=params.survey_proposal_id,
        candidates=params.candidates,
        library=params.library,
        pinned=params.pinned,
        data_policy=params.data_policy,
        stage="suggest",
    )
