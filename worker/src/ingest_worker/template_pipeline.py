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

from .normalize import normalize_value
from .outputs import DOCUMENT_ID_COLUMN, RenderedOutput, _cell
from .pipeline import (
    PipelineDeps,
    page_images,
    prepare_document,
    resolve_models,
    run_check_with_event,
    run_step_extraction,
)
from .queue import ClaimedJob, JobQueue
from .specs import LoadedTemplate
from .storage import output_key
from .template import CheckStep, ExtractStep, Template, compile_step

ISSUE_COLUMNS = ["step", "target", "row", "column", "raw", "message"]


def process_template_job(
    job: ClaimedJob, deps: PipelineDeps, queue: JobQueue, loaded: LoadedTemplate
) -> list[RenderedOutput]:
    template = loaded.template
    compiled = {s.id: compile_step(template, s) for s in template.extract_steps()}
    resolved = resolve_models(job, deps, list(compiled.values()))
    doc = prepare_document(job, deps, queue, template.document)

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
        ex = compiled[step.id]
        provider, model_id = resolved[step.id]
        images = page_images(job, deps, queue, doc.pdf, ex.page_images, doc.total_pages)
        result = run_step_extraction(
            job, deps, loaded.directory, ex, provider, model_id, doc.sections, images
        )
        models_used[step.id] = result.model_ref
        step_results[step.id] = _normalise_step(template, step, result.data, fields, tables, issues)
        queue.event(
            job.id,
            "info",
            f"extracted {step.id}",
            {"model": result.model_ref, "attempts": len(result.attempts)},
        )

    reasons = _review_reasons(template, checks, issues)
    if reasons:
        queue.event(job.id, "warn", "review required", {"reasons": reasons})

    outputs = _render(template, job, fields, tables, checks, issues, models_used, reasons)
    for o in outputs:
        content_type = "text/csv" if o.format == "csv" else "application/json"
        deps.store.put(deps.buckets.outputs, o.key, o.body, content_type)
    return outputs


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


def _render(
    template: Template,
    job: ClaimedJob,
    fields: dict[str, dict[str, Any]],
    tables: dict[str, list[dict[str, Any]]],
    checks: dict[str, Any],
    issues: list[dict[str, Any]],
    models_used: dict[str, str],
    reasons: list[str],
) -> list[RenderedOutput]:
    doc_id = job.document_id

    def key(output_id: str, fmt: str) -> str:
        return output_key(template.id, template.version, output_id, doc_id, fmt)  # type: ignore[arg-type]

    out: list[RenderedOutput] = []
    if template.outputs.fields:
        ids = [f.id for f in template.outputs.fields]
        body = _csv([DOCUMENT_ID_COLUMN, *ids], [[doc_id, *(fields[i]["value"] for i in ids)]])
        out.append(RenderedOutput("fields", "csv", key("fields", "csv"), body, 1))
    for table in template.outputs.tables:
        cols = [c.id for c in table.columns]
        rows = tables.get(table.id, [])
        body = _csv([DOCUMENT_ID_COLUMN, *cols], [[doc_id, *(r[c] for c in cols)] for r in rows])
        out.append(RenderedOutput(table.id, "csv", key(table.id, "csv"), body, len(rows)))
    check_cols = ["value", "status", "matched", "distance", "count"]
    for check_id, result in checks.items():
        rows = result["rows"]
        body = _csv(
            [DOCUMENT_ID_COLUMN, *check_cols], [[doc_id, *(r[c] for c in check_cols)] for r in rows]
        )
        out.append(RenderedOutput(check_id, "csv", key(check_id, "csv"), body, len(rows)))
    body = _csv(
        [DOCUMENT_ID_COLUMN, *ISSUE_COLUMNS],
        [[doc_id, *(i[c] for c in ISSUE_COLUMNS)] for i in issues],
    )
    out.append(RenderedOutput("issues", "csv", key("issues", "csv"), body, len(issues)))

    document = {
        "document_id": doc_id,
        "job_id": job.id,
        "template": {"id": template.id, "version": template.version, "name": template.name},
        "extracted_at": datetime.now(UTC).isoformat(),
        "models": models_used,
        "fields": fields,
        "tables": tables,
        "checks": checks,
        "issues": issues,
        "review_required": bool(reasons),
        "review_reasons": reasons,
    }
    body = json.dumps(document, ensure_ascii=False, indent=2).encode("utf-8")
    out.append(RenderedOutput("document", "json", key("document", "json"), body, None))
    return out
