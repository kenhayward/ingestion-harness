"""Workbench graph previews (ADR 0011): the open draft's ontology mapping rendered over the
newest finished test run of each chosen dev sample, as publishing would render it.

The API puts the samples (run, file name, sha256, the run's draft `document.json`) and the draft
in the job's params; the result goes to `graphs/{project}/{job}.json` in the runs bucket.
"""

from __future__ import annotations

import json
from typing import Any

import psycopg
from pydantic import BaseModel, ConfigDict, Field, ValidationError

from .pipeline import DocumentError, JobCancelled, PipelineDeps, check_cancelled
from .queue import ClaimedJob, JobQueue
from .rdf import GraphContext, render_graph, to_turtle, validate
from .shacl import load_graphs, outputs_by_property
from .storage import graph_preview_key, reviewed_document_key
from .template import Template

NO_BASE = "set the customer on the Linked data page"


class PreviewSample(BaseModel):
    model_config = ConfigDict(populate_by_name=True, extra="forbid")

    sample_id: str = Field(alias="sampleId")
    job_id: str = Field(alias="jobId")
    file_name: str = Field(alias="fileName")
    sha256: str = Field(min_length=1)
    document_key: str = Field(alias="documentKey")


class GraphPreviewParams(BaseModel):
    """What the API's createGraphJob puts in the job's params (GraphJobParams in TS)."""

    model_config = ConfigDict(extra="forbid")

    samples: list[PreviewSample] = Field(min_length=1)
    definition: Template


def _document(deps: PipelineDeps, sample: PreviewSample) -> dict[str, Any] | None:
    """The run's reviewed document if it was approved, else its draft; None if both are gone."""
    raw = deps.store.get_optional(deps.buckets.runs, reviewed_document_key(sample.job_id))
    if raw is None:
        raw = deps.store.get_optional(deps.buckets.outputs, sample.document_key)
    return None if raw is None else dict(json.loads(raw))


def run_graph_preview(job: ClaimedJob, deps: PipelineDeps, queue: JobQueue) -> dict[str, Any]:
    try:
        params = GraphPreviewParams.model_validate(job.params or {})
    except ValidationError as exc:
        raise DocumentError(f"invalid graph preview parameters: {exc}") from exc
    if job.project_id is None:
        raise DocumentError("graph preview without a project")
    template = params.definition
    if template.semantics is None:
        raise DocumentError("the recipe has no ontology mapping")
    base = deps.linked_data.effective_base() if deps.linked_data else None
    if base is None:
        raise DocumentError(NO_BASE)
    pins = [(o.id, o.version) for o in template.semantics.ontologies]
    store = deps.ontologies

    def concepts(scheme: str, label: str) -> str | None:
        return store.concept_by_label(pins, scheme, label) if store else None

    shapes = ontology_graph = None
    if template.semantics.shapes:
        shapes = load_graphs(deps, [(p.id, p.version) for p in template.semantics.shapes])
        ontology_graph = load_graphs(deps, pins)
    by_property = outputs_by_property(template)
    samples: list[dict[str, Any]] = []
    for sample in params.samples:
        check_cancelled(job, queue)
        document = _document(deps, sample)
        if document is None:
            queue.event(
                job.id, "warn", "graph preview skipped a sample", {"sampleId": sample.sample_id}
            )
            continue
        # The sample's own sha256: drafts from before graphs do not carry it.
        document["source_sha256"] = sample.sha256
        try:
            graph = render_graph(template, document, GraphContext(base, concepts))
            turtle = to_turtle(graph).decode("utf-8")
        except psycopg.Error:
            raise
        except Exception as exc:  # rdflib refuses IRIs it cannot write with a plain Exception
            raise DocumentError(f"cannot render the graph of {sample.file_name}: {exc}") from exc
        samples.append(
            {
                "sampleId": sample.sample_id,
                "fileName": sample.file_name,
                "turtle": turtle,
                "triples": len(graph),
                "report": (
                    validate(graph, shapes, ontology_graph, by_property).to_json()
                    if shapes is not None and ontology_graph is not None
                    else None
                ),
            }
        )
    result = {"samples": samples}
    check_cancelled(job, queue)
    key = graph_preview_key(job.project_id, job.id)
    deps.store.put(deps.buckets.runs, key, json.dumps(result).encode(), "application/json")
    if queue.is_cancelled(job):  # a newer preview replaced this one while it wrote
        deps.store.delete(deps.buckets.runs, key)
        raise JobCancelled(job.id)
    return result
