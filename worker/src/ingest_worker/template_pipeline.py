"""Run a document template: shared preparation (OCR, copies, page markers, sections), then the
template's steps in order, typed normalisation, checks, outputs and the review decision.

Outputs ({templateId}/v{version}/<output>/{documentId}.<ext>):
    fields     one-row CSV, one column per field (normalised values)
    <table>    one CSV per table
    <check>    one CSV per check step
    issues     values that could not be normalised (kept as written)
    document   JSON with field evidence/pages, tables, checks, issues, review decision
"""

from __future__ import annotations

import csv
import io
import json
from datetime import UTC, datetime
from typing import Any

from .extract import ExtractionResult
from .llm.base import LLMProvider
from .llm.registry import ModelResolutionError
from .normalize import normalize_value
from .outputs import DOCUMENT_ID_COLUMN, RenderedOutput, _cell
from .pipeline import (
    DocumentError,
    PipelineDeps,
    Prepared,
    ProcessResult,
    page_images,
    prepare_document,
    publish_outputs,
    resolve_models,
    run_check_with_event,
    run_step_extraction,
)
from .queue import ClaimedJob, JobQueue
from .review import apply_edits, run_checks
from .specs import Extraction, LoadedTemplate
from .storage import output_key, page_preview_key, reviewed_document_key
from .template import CheckStep, ExtractStep, Template, compile_step

ISSUE_COLUMNS = ["step", "target", "row", "column", "raw", "message"]


def process_template_job(
    job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, loaded: LoadedTemplate
) -> ProcessResult:
    template = loaded.template
    compiled = {s.id: compile_step(template, s) for s in template.extract_steps()}
    resolved = resolve_models(job, deps, list(compiled.values()))
    doc = prepare_document(job, deps, queue, template.document)
    _save_previews(job, deps, queue, doc.pdf, doc.total_pages)

    fields: dict[str, dict[str, Any]] = {}
    tables: dict[str, list[dict[str, Any]]] = {}
    checks: dict[str, Any] = {}
    issues: list[dict[str, Any]] = []
    step_results: dict[str, Any] = {}  # normalised, keyed by step id (check paths use these)
    models_used: dict[str, str] = {}

    for step in template.pipeline:
        if isinstance(step, CheckStep):
            check = template.compile_check(step)
            checks[step.id] = step_results[step.id] = run_check_with_event(
                job, queue, check, step_results
            )
            continue
        result = _run_step(
            job,
            deps,
            queue,
            loaded,
            step,
            compiled[step.id],
            resolved[step.id],
            doc,
            fields,
            tables,
            trigger="process",
        )
        models_used[step.id] = result.model_ref
        step_results[step.id] = _normalise_step(template, step, result.data, fields, tables, issues)

    reasons = _review_reasons(template, checks, issues)
    if reasons:
        queue.event(job.id, "warn", "review required", {"reasons": reasons})

    document = {
        "document_id": job.document_id,
        "job_id": job.id,
        "template": {"id": template.id, "version": template.version, "name": template.name},
        "extracted_at": datetime.now(UTC).isoformat(),
        "page_count": doc.total_pages,
        "models": models_used,
        "fields": fields,
        "tables": tables,
        "checks": checks,
        "issues": issues,
        "review_required": bool(reasons),
        "review_reasons": reasons,
    }
    outputs = render_document(template, document)
    for o in outputs:
        content_type = "text/csv" if o.format == "csv" else "application/json"
        deps.store.put(deps.buckets.outputs, o.key, o.body, content_type)
    return ProcessResult(outputs, reasons)


def publish_template_job(
    job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, loaded: LoadedTemplate
) -> list[RenderedOutput]:
    """Apply the reviewer's edits to the draft (never modified) and deliver to the target."""
    template = loaded.template
    draft_key = output_key(template.id, template.version, "document", job.document_id, "json")
    draft = json.loads(deps.store.get(deps.buckets.outputs, draft_key))
    edits = queue.review_edits(job.id)
    decision = queue.review_decision(job.id) or {}
    try:
        document = apply_edits(template, draft, edits)
    except ValueError as exc:
        raise DocumentError(f"cannot apply review edits: {exc}") from exc
    document["review"] = {
        "decision": "approved",
        "reviewer": decision.get("reviewer"),
        "note": decision.get("note"),
        "reviewed_at": decision.get("reviewed_at"),
        "edits": edits,
    }
    document["published_at"] = datetime.now(UTC).isoformat()
    # Keep the reviewed document next to the job's run data: the final target may be an S3 the
    # API cannot read, and references/regression need the approved values.
    deps.store.put(
        deps.buckets.runs,
        reviewed_document_key(job.id),
        json.dumps(document, ensure_ascii=False, indent=2).encode("utf-8"),
        "application/json",
    )
    published = publish_outputs(deps, render_document(template, document))
    queue.event(job.id, "info", "published", {"edits": len(edits), "outputs": len(published)})
    return published


def context_values(
    template: Template,
    step: ExtractStep,
    fields: dict[str, dict[str, Any]],
    tables: dict[str, list[dict[str, Any]]],
) -> list[dict[str, str]]:
    """Render a step's `context` from earlier results: field values as-is, table columns as
    distinct values with counts (most frequent first), e.g. "G17230211 (13x), GTT230211 (2x)"."""
    out = []
    for name, path in step.context.items():
        head, _, column = path.partition(".")
        if column:
            counts: dict[str, int] = {}
            for row in tables.get(head, []):
                cell = row.get(column)
                for v in cell if isinstance(cell, list) else [cell]:
                    if v not in (None, ""):
                        counts[str(v)] = counts.get(str(v), 0) + 1
            ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
            text = ", ".join(f"{v} ({n}x)" for v, n in ranked) or "(none)"
        else:
            value = (fields.get(head) or {}).get("value")
            text = ", ".join(map(str, value)) if isinstance(value, list) else str(value)
        out.append({"name": name, "path": path, "text": text})
    return out


def _run_step(
    job: ClaimedJob,
    deps: PipelineDeps,
    queue: JobQueue,
    loaded: LoadedTemplate,
    step: ExtractStep,
    ex: Extraction,
    model: tuple[LLMProvider, str],
    doc: Prepared,
    fields: dict[str, dict[str, Any]],
    tables: dict[str, list[dict[str, Any]]],
    *,
    trigger: str,
    extra_instructions: str | None = None,
) -> ExtractionResult:
    """Run one extract step with context from earlier steps; record it in step_runs."""
    provider, model_id = model
    context = dict(ex.prompt_context or {})
    context["step_context"] = context_values(loaded.template, step, fields, tables)
    if extra_instructions:
        guidance = f"Reviewer guidance for this re-run: {extra_instructions}"
        base = context.get("instructions")
        context["instructions"] = f"{base}\n\n{guidance}" if base else guidance
    ex = ex.model_copy(update={"prompt_context": context})
    images = page_images(job, deps, queue, doc.pdf, ex.page_images, doc.total_pages)
    run: dict[str, Any] = {
        "step_id": step.id,
        "trigger": trigger,
        "model": f"{provider.name}/{model_id}",
        "attempts": 0,
        "input_tokens": None,
        "output_tokens": None,
        "started_at": datetime.now(UTC).isoformat(),
    }
    try:
        result = run_step_extraction(
            job, deps, loaded.directory, ex, provider, model_id, doc.sections, images
        )
    except Exception as exc:
        attempts = getattr(exc.__cause__, "attempts", [])
        queue.record_step_run(
            job.id,
            {
                **run,
                "attempts": len(attempts),
                "status": "failed",
                "error": str(exc)[:2000],
                "finished_at": datetime.now(UTC).isoformat(),
            },
        )
        raise

    def total(key: str) -> int | None:
        values = [getattr(a, key) for a in result.attempts if getattr(a, key) is not None]
        return sum(values) if values else None

    queue.record_step_run(
        job.id,
        {
            **run,
            "model": result.model_ref,
            "attempts": len(result.attempts),
            "input_tokens": total("input_tokens"),
            "output_tokens": total("output_tokens"),
            "status": "succeeded",
            "finished_at": datetime.now(UTC).isoformat(),
        },
    )
    queue.event(
        job.id,
        "info",
        f"extracted {step.id}" if trigger == "process" else f"re-ran {step.id}",
        {"model": result.model_ref, "attempts": len(result.attempts)},
    )
    return result


def rerun_template_job(
    job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, loaded: LoadedTemplate
) -> ProcessResult:
    """Re-run one extract step of a document in review: OCR text is reused from the runs
    bucket, only that step calls the model, its outputs are replaced, checks re-run, and the
    draft goes back to review."""
    template = loaded.template
    params = job.rerun or {}
    step = next((s for s in template.extract_steps() if s.id == params.get("step")), None)
    if step is None:
        raise DocumentError(
            f"no extract step {params.get('step')!r} in {template.id} v{template.version}"
        )
    ex = compile_step(template, step)
    if params.get("pageImages"):  # reviewer shows the model the page(s) to read directly
        ex = ex.model_copy(update={"page_images": [int(n) for n in params["pageImages"]]})
    try:
        model = deps.models.resolve(params.get("model") or job.model_override or step.model)
    except ModelResolutionError as exc:
        raise DocumentError(f"re-run of {step.id!r}: {exc}") from exc

    draft_key = output_key(template.id, template.version, "document", job.document_id, "json")
    document = json.loads(deps.store.get(deps.buckets.outputs, draft_key))
    fields: dict[str, dict[str, Any]] = document["fields"]
    tables: dict[str, list[dict[str, Any]]] = document["tables"]
    doc = prepare_document(job, deps, queue, template.document)

    result = _run_step(
        job,
        deps,
        queue,
        loaded,
        step,
        ex,
        model,
        doc,
        fields,
        tables,
        trigger="rerun",
        extra_instructions=params.get("instructions"),
    )
    issues = [i for i in document.get("issues", []) if i.get("step") != step.id]
    _normalise_step(template, step, result.data, fields, tables, issues)
    checks = run_checks(template, fields, tables)
    reasons = [f"re-run of step {step.id}", *_review_reasons(template, checks, issues)]
    document.update(
        fields=fields,
        tables=tables,
        checks=checks,
        issues=issues,
        review_required=True,
        review_reasons=reasons,
        models={**document.get("models", {}), step.id: result.model_ref},
        reruns=[
            *document.get("reruns", []),
            {
                "step": step.id,
                "model": result.model_ref,
                "instructions": params.get("instructions"),
                "page_images": params.get("pageImages"),
                "at": datetime.now(UTC).isoformat(),
            },
        ],
    )
    outputs = render_document(template, document)
    for o in outputs:
        content_type = "text/csv" if o.format == "csv" else "application/json"
        deps.store.put(deps.buckets.outputs, o.key, o.body, content_type)
    return ProcessResult(outputs, reasons)


def _save_previews(
    job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, pdf: bytes, pages: int
) -> None:
    """JPEG previews for the review screen. A convenience: failures never fail the job."""
    try:
        for index in range(pages):
            key = page_preview_key(job.id, index + 1)
            deps.store.put(deps.buckets.runs, key, deps.render_preview(pdf, index), "image/jpeg")
    except Exception as exc:
        queue.event(job.id, "warn", "page previews unavailable", {"error": repr(exc)})


def _normalise_step(
    template: Template,
    step: ExtractStep,
    data: dict[str, Any],
    fields: dict[str, dict[str, Any]],
    tables: dict[str, list[dict[str, Any]]],
    issues: list[dict[str, Any]],
) -> dict[str, Any]:
    order = template.document.date_order
    if step.fields:
        normalised: dict[str, Any] = {}
        for field_id in step.fields:
            definition = template.field(field_id)
            entry = data.get(field_id) or {}
            value, issue = normalize_value(
                entry.get("value"), definition.type, options=definition.enum, date_order=order
            )
            fields[field_id] = normalised[field_id] = {
                "value": value,
                "evidence": entry.get("evidence"),
                "page": entry.get("page"),
            }
            if issue:
                issues.append(
                    {
                        "step": step.id,
                        "target": field_id,
                        "row": None,
                        "column": None,
                        "raw": entry.get("value"),
                        "message": issue,
                    }
                )
        return normalised

    assert step.table is not None
    table = template.table(step.table)
    rows: list[dict[str, Any]] = []
    for n, raw_row in enumerate(data.get("rows", []), start=1):
        row: dict[str, Any] = {}
        for column in table.columns:
            value, issue = normalize_value(
                raw_row.get(column.id), column.type, options=column.enum, date_order=order
            )
            row[column.id] = value
            if issue:
                issues.append(
                    {
                        "step": step.id,
                        "target": table.id,
                        "row": n,
                        "column": column.id,
                        "raw": raw_row.get(column.id),
                        "message": issue,
                    }
                )
        rows.append(row)
    tables[table.id] = rows
    return {"rows": rows}


def _review_reasons(
    template: Template, checks: dict[str, Any], issues: list[dict[str, Any]]
) -> list[str]:
    policy = template.review.required
    if policy == "never":
        return []
    reasons = ["review policy: always"] if policy == "always" else []
    if issues:
        reasons.append(f"{len(issues)} normalisation issue(s)")
    for check_id, result in checks.items():
        unmatched = sum(1 for r in result["rows"] if r["status"] == "unmatched")
        if unmatched:
            reasons.append(f"check {check_id}: {unmatched} unmatched")
    return reasons


def _csv(header: list[str], rows: list[list[Any]]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(header)
    writer.writerows([[_cell(v) for v in row] for row in rows])
    return buf.getvalue().encode("utf-8")


def render_document(template: Template, document: dict[str, Any]) -> list[RenderedOutput]:
    """Render a (draft or reviewed) document into the template's outputs."""
    doc_id = document["document_id"]
    fields, tables = document["fields"], document["tables"]

    def key(output_id: str, fmt: str) -> str:
        return output_key(template.id, template.version, output_id, doc_id, fmt)  # type: ignore[arg-type]

    out: list[RenderedOutput] = []
    if template.outputs.fields:
        ids = [f.id for f in template.outputs.fields]
        values = [(fields.get(i) or {}).get("value") for i in ids]
        out.append(
            RenderedOutput(
                "fields",
                "csv",
                key("fields", "csv"),
                _csv([DOCUMENT_ID_COLUMN, *ids], [[doc_id, *values]]),
                1,
            )
        )
    for table in template.outputs.tables:
        cols = [c.id for c in table.columns]
        rows = tables.get(table.id, [])
        body = _csv(
            [DOCUMENT_ID_COLUMN, *cols], [[doc_id, *(r.get(c) for c in cols)] for r in rows]
        )
        out.append(RenderedOutput(table.id, "csv", key(table.id, "csv"), body, len(rows)))
    check_cols = ["value", "status", "matched", "distance", "count"]
    for check_id, result in document["checks"].items():
        rows = result["rows"]
        body = _csv(
            [DOCUMENT_ID_COLUMN, *check_cols], [[doc_id, *(r[c] for c in check_cols)] for r in rows]
        )
        out.append(RenderedOutput(check_id, "csv", key(check_id, "csv"), body, len(rows)))
    issues = document["issues"]
    body = _csv(
        [DOCUMENT_ID_COLUMN, *ISSUE_COLUMNS],
        [[doc_id, *(i.get(c) for c in ISSUE_COLUMNS)] for i in issues],
    )
    out.append(RenderedOutput("issues", "csv", key("issues", "csv"), body, len(issues)))
    body = json.dumps(document, ensure_ascii=False, indent=2).encode("utf-8")
    out.append(RenderedOutput("document", "json", key("document", "json"), body, None))
    return out
