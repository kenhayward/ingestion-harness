"""Ontology term embeddings (ADR 0011): the semantic half of the mapping stage's retrieval.

A version's terms are embedded after its import, and again by an `embed` job when the embedding
model changes. Each term is embedded once per model and text (`text_sha256`). Embedding never
fails an import: anything that stops it is a `embedding skipped` warn event, and retrieval for
that version stays lexical.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .llm.registry import ModelResolutionError
from .pipeline import DocumentError, PipelineDeps
from .queue import ClaimedJob, JobQueue

#: Terms per embedding call.
EMBED_BATCH = 64
EMBEDDING_SKIPPED = "embedding skipped"
TERMS_EMBEDDED = "terms embedded"


@dataclass(frozen=True)
class EmbeddingTerm:
    """What a term is embedded from (parents as labels, so the text reads as words)."""

    kind: str
    iri: str
    label: str
    alt_labels: list[str]
    definition: str
    parents: list[str]


def term_text(label: str, alt_labels: list[str], definition: str, parents: list[str]) -> str:
    parts = [label]
    if alt_labels:
        parts.append("Also: " + ", ".join(alt_labels))
    if definition.strip():
        parts.append(definition.strip())
    if parents:
        parts.append("Parents: " + ", ".join(parents))
    return "\n".join(parts)


def _sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def embed_version(
    deps: PipelineDeps,
    queue: JobQueue,
    job_id: str,
    ontology_id: str,
    version: int,
    *,
    model_ref: str | None = None,
    strict: bool = False,
) -> int:
    """Embed the version's terms whose text changed under `model_ref` (default: the current
    setting); the number embedded. Policy problems skip with an event. A model that does not
    resolve skips too, unless `strict` (an `embed` job: the worker's registry may not have
    caught up with the setting yet, so it raises and the job is retried)."""
    store = deps.ontologies
    model_ref = model_ref or deps.embedding_model
    if store is None or model_ref is None:
        return 0

    def skip(reason: str) -> int:
        queue.event(job_id, "warn", EMBEDDING_SKIPPED, {"model": model_ref, "reason": reason})
        return 0

    try:
        provider, model_id = deps.models.resolve_embedding(model_ref)
    except ModelResolutionError as exc:
        if strict:
            raise RuntimeError(f"embedding model {model_ref} does not resolve yet: {exc}") from exc
        return skip(str(exc))
    if deps.models.location(provider.name) == "external":
        restricted = store.local_only_sources([(ontology_id, version)])
        if restricted:
            return skip(
                f"{', '.join(restricted)} is local only and {model_ref} is an external model"
            )

    existing = store.existing_embeddings(ontology_id, version, model_ref)
    todo: list[tuple[str, str, str, str]] = []  # kind, iri, sha, text
    for term in store.embedding_terms(ontology_id, version):
        text = term_text(term.label, term.alt_labels, term.definition, term.parents)
        sha = _sha(text)
        if existing.get((term.kind, term.iri)) != sha:
            todo.append((term.kind, term.iri, sha, text))
    for start in range(0, len(todo), EMBED_BATCH):
        batch = todo[start : start + EMBED_BATCH]
        vectors = provider.embed(model_id, [t[3] for t in batch])
        store.store_embeddings(
            ontology_id,
            version,
            model_ref,
            [
                (kind, iri, sha, vec)
                for (kind, iri, sha, _), vec in zip(batch, vectors, strict=True)
            ],
        )
    if todo:
        queue.event(job_id, "info", TERMS_EMBEDDED, {"model": model_ref, "terms": len(todo)})
    return len(todo)


def embed_after_import(
    deps: PipelineDeps, queue: JobQueue, job_id: str, ontology_id: str, version: int
) -> None:
    """The import's last step: a failure is an event, never the import's."""
    try:
        embed_version(deps, queue, job_id, ontology_id, version)
    except Exception as exc:
        queue.event(
            job_id,
            "warn",
            EMBEDDING_SKIPPED,
            {"model": deps.embedding_model, "reason": f"{type(exc).__name__}: {exc}"},
        )


class EmbedParams(BaseModel):
    """What the API's OntologyRepo.createEmbedJobs puts in the job's params."""

    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    ontology_id: str = Field(alias="ontologyId", min_length=1)
    version: int = Field(gt=0)
    #: The model the job was queued for: the worker may not have seen the new setting yet.
    model: str = Field(min_length=1)


def run_embed(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> int:
    """An `embed` job: embed a ready version under the current embedding model. Provider
    outages raise (retried); bad params go to review."""
    try:
        params = EmbedParams.model_validate(job.params or {})
    except ValidationError as exc:
        raise DocumentError(f"invalid embed parameters: {exc}") from exc
    return embed_version(
        deps, queue, job.id, params.ontology_id, params.version, model_ref=params.model, strict=True
    )
