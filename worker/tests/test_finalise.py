"""One ending for process, re-run and publish (docs/design/worker-nodes-refactor.md, part 3):
document_of builds the draft from a state, finalise builds the graph, checks it against the
shapes and renders the outputs, by mode."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.pipeline import DocumentError, PipelineDeps, Prepared
from ingest_worker.storage import MemoryObjectStore, ontology_normalized_key, shacl_report_key
from ingest_worker.template import Template
from ingest_worker.template_pipeline import (
    DocState,
    ShapesViolated,
    document_of,
    finalise,
    write_drafts,
)

from .fakes import FakeQueue
from .test_template_pipeline import (
    BASE_IRI,
    JOB,
    SEMANTICS,
    SHAPED,
    TEMPLATE,
    mapped_deps,
    with_shapes,
)

DOC = Prepared(b"%PDF", 3, {"head": "", "body": ""}, "sha-1")
STATE = DocState(
    fields={"product": {"value": "Richfer capsules", "evidence": None, "page": 1}},
    tables={"results": [{"batch": "G1", "value": 1.0, "aliases": []}]},
    checks={"batch_check": {"rows": []}},
    issues=({"step": "data", "message": "x"},),
    models={"header": "local/qwen"},
)


def recipe(**extra: Any) -> dict[str, Any]:
    return {**TEMPLATE, "review": {"required": "on_warnings"}, **extra}


def setup(
    tmp_path: Path, template: dict[str, Any], shapes: bool = False
) -> tuple[PipelineDeps, Template]:
    deps, _ = mapped_deps(tmp_path, template, BASE_IRI)
    if shapes:
        with_shapes(deps)
    return deps, Template.model_validate(template)


def draft(template: Template, reasons: list[str] | None = None) -> dict[str, Any]:
    return document_of(JOB, DOC, template, STATE, list(reasons or []))


def test_document_of_builds_the_draft_from_a_state() -> None:
    template = Template.model_validate(recipe())
    document = document_of(JOB, DOC, template, STATE, ["1 normalisation issue(s)"])
    assert list(document) == [
        "document_id", "job_id", "source_sha256", "template", "extracted_at", "page_count",
        "models", "fields", "tables", "checks", "issues", "review_required", "review_reasons",
    ]  # fmt: skip
    assert document["template"] == {"id": "demo", "version": 1, "name": "Demo document"}
    assert (document["document_id"], document["source_sha256"]) == ("doc-1", "sha-1")
    assert document["page_count"] == 3 and document["models"] == {"header": "local/qwen"}
    assert document["issues"] == [{"step": "data", "message": "x"}]
    assert document["review_required"] is True


def test_a_draft_without_a_mapping_is_rendered_as_it_is(tmp_path: Path) -> None:
    deps, template = setup(tmp_path, recipe())
    document = draft(template)
    done = finalise(JOB, deps, FakeQueue(), template, document, mode="draft")
    assert done.graph is None and done.reasons == [] and done.document is document
    assert [o.output_id for o in done.outputs] == [
        "fields", "results", "batch_check", "issues", "document",
    ]  # fmt: skip
    assert isinstance(deps.store, MemoryObjectStore)
    assert not [k for b, k in deps.store.objects if b == "outputs"]  # finalise writes no drafts


def test_a_draft_takes_the_shapes_report_into_its_issues_and_reasons(tmp_path: Path) -> None:
    deps, template = setup(tmp_path, recipe(semantics=SHAPED), shapes=True)
    document = draft(template)
    done = finalise(JOB, deps, FakeQueue(), template, document, mode="draft")
    reason = "SHACL: ProtocolShape on product: a product code is short"
    assert done.reasons == [reason] and done.document["review_reasons"] == [reason]
    assert done.document["review_required"] is True
    assert done.graph is not None and "rdf" in [o.format for o in done.outputs]
    rendered = json.loads(next(o.body for o in done.outputs if o.output_id == "document"))
    assert rendered["review_reasons"] == [reason]
    assert deps.store.get_optional("runs", shacl_report_key("job-1")) is not None


def test_a_publish_delivering_rdf_is_refused_while_the_graph_violates_shapes(
    tmp_path: Path,
) -> None:
    template = recipe(semantics=SHAPED, delivery={"formats": ["json", "rdf"]})
    deps, recipe_ = setup(tmp_path, template, shapes=True)
    with pytest.raises(ShapesViolated) as refused:
        finalise(JOB, deps, FakeQueue(), recipe_, draft(recipe_), mode="publish")
    assert refused.value.reasons == ["SHACL: ProtocolShape on product: a product code is short"]


def test_a_publish_leaves_the_reviewed_document_as_it_is(tmp_path: Path) -> None:
    deps, template = setup(tmp_path, recipe(semantics=SHAPED), shapes=True)
    document = draft(template)
    done = finalise(JOB, deps, FakeQueue(), template, document, mode="publish")
    assert done.document["review_reasons"] == [] and done.document["issues"] == list(STATE.issues)


def test_a_publish_not_delivering_rdf_needs_no_shapes(tmp_path: Path) -> None:
    deps, template = setup(tmp_path, recipe(semantics=SHAPED))  # shapes not loaded
    done = finalise(JOB, deps, FakeQueue(), template, draft(template), mode="publish")
    assert done.graph is not None


def test_a_draft_needs_the_shapes_it_names(tmp_path: Path) -> None:
    deps, template = setup(tmp_path, recipe(semantics=SHAPED))  # shapes not loaded
    with pytest.raises(DocumentError, match="ex-shapes v1 is not available"):
        finalise(JOB, deps, FakeQueue(), template, draft(template), mode="draft")


def test_write_drafts_puts_each_output_in_the_outputs_bucket(tmp_path: Path) -> None:
    deps, template = setup(tmp_path, recipe(semantics=SEMANTICS))
    done = finalise(JOB, deps, FakeQueue(), template, draft(template), mode="draft")
    write_drafts(deps, done.outputs)
    assert isinstance(deps.store, MemoryObjectStore)
    written = {k: t for (b, k), (_, t) in deps.store.objects.items() if b == "outputs"}
    assert written == {
        "demo/v1/fields/doc-1.csv": "text/csv; charset=utf-8",
        "demo/v1/results/doc-1.csv": "text/csv; charset=utf-8",
        "demo/v1/batch_check/doc-1.csv": "text/csv; charset=utf-8",
        "demo/v1/issues/doc-1.csv": "text/csv; charset=utf-8",
        "demo/v1/document/doc-1.json": "application/json",
        "demo/v1/graph/doc-1.ttl": "text/turtle",
    }


def test_the_shapes_fixture_is_in_the_runs_bucket(tmp_path: Path) -> None:
    deps, _ = setup(tmp_path, recipe(semantics=SHAPED), shapes=True)
    assert deps.store.get_optional("runs", ontology_normalized_key("ex-shapes", 1))
