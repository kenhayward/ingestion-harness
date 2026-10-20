"""Apply reviewer edits to a draft template document (document.json).

Edits target a field (`field`) or a table cell (`table`, 1-based `row`, `column`). Values are
re-normalised with the field/column type; issues for edited targets are replaced, checks are
re-run on the edited data, and edited fields are marked `edited: true`. The draft itself is
never modified — a new document is returned.
"""

from __future__ import annotations

import copy
from typing import Any

from . import normalize
from .checks import run_check
from .normalize import check_value, pattern_matcher, pattern_pairs
from .queue import ClaimedJob
from .template import CheckStep, Template, ValueDef


def step_results(
    template: Template, fields: dict[str, Any], tables: dict[str, list[dict[str, Any]]]
) -> dict[str, Any]:
    """Rebuild the per-step results that check paths refer to."""
    results: dict[str, Any] = {}
    for step in template.filling_steps():  # extract and plugin steps
        if step.table is not None:
            results[step.id] = {"rows": tables.get(step.table, [])}
        else:
            results[step.id] = {f: fields[f] for f in step.fields if f in fields}
    return results


def run_checks(
    template: Template,
    fields: dict[str, Any],
    tables: dict[str, Any],
    job: ClaimedJob | None = None,
) -> dict[str, Any]:
    """Every check on the values, reference checks and check plugins alike. A check plugin
    needs the job (`CheckContext.job`); without one a stand-in test job is used."""
    from .plugins import check_context, resolve_checks, run_check_plugin, stand_in_job

    results = step_results(template, fields, tables)
    plugged = resolve_checks(template)
    checks: dict[str, Any] = {}
    for step in template.pipeline:
        if not isinstance(step, CheckStep):
            continue
        if step.id in plugged:
            ctx = check_context(job or stand_in_job(template), template, step, results, tables)
            result = run_check_plugin(plugged[step.id], ctx)
        else:
            result = run_check(template.compile_check(step), results)
        checks[step.id] = results[step.id] = result
    return checks


def apply_edits(
    template: Template,
    draft: dict[str, Any],
    edits: list[dict[str, Any]],
    job: ClaimedJob | None = None,
) -> dict[str, Any]:
    doc = copy.deepcopy(draft)
    fields: dict[str, Any] = doc["fields"]
    tables: dict[str, list[dict[str, Any]]] = doc["tables"]
    issues: list[dict[str, Any]] = doc.get("issues", [])
    order = template.document.date_order

    def drop_issues(target: str, row: int | None, column: str | None) -> None:
        issues[:] = [
            i
            for i in issues
            if not (i["target"] == target and i.get("row") == row and i.get("column") == column)
        ]

    def definition_of(edit: dict[str, Any]) -> ValueDef | None:
        if edit.get("field"):
            return next((f for f in template.outputs.fields if f.id == edit["field"]), None)
        table = next((t for t in template.outputs.tables if t.id == edit.get("table")), None)
        return (
            next((c for c in table.columns if c.id == edit.get("column")), None) if table else None
        )

    # Every edit's pattern checks in one time-capped child (a pattern may backtrack).
    matches = pattern_matcher(
        pattern_pairs(
            [(e["value"], d) for e in edits if (d := definition_of(e)) is not None], order
        ),
        normalize.PATTERN_TIMEOUT_S,
    )

    for edit in edits:
        if edit.get("field"):
            field_id = edit["field"]
            definition = next((f for f in template.outputs.fields if f.id == field_id), None)
            if definition is None:
                raise ValueError(f"edit targets unknown field {field_id!r}")
            value, issue = check_value(edit["value"], definition, order, matches)
            entry = fields.setdefault(field_id, {"value": None, "evidence": None, "page": None})
            entry.update(value=value, edited=True)
            drop_issues(field_id, None, None)
            if issue:
                issues.append(
                    {
                        "step": "review",
                        "target": field_id,
                        "row": None,
                        "column": None,
                        "raw": edit["value"],
                        "message": issue,
                    }
                )
            continue

        table_id, row, column_id = edit.get("table"), edit.get("row"), edit.get("column")
        table = next((t for t in template.outputs.tables if t.id == table_id), None)
        column = next((c for c in table.columns if c.id == column_id), None) if table else None
        if table is None or column is None:
            raise ValueError(f"edit targets unknown table/column {table_id!r}.{column_id!r}")
        rows = tables.setdefault(table.id, [])
        if not isinstance(row, int) or not 1 <= row <= len(rows):
            raise ValueError(f"edit targets row {row} of {table.id!r}, which has {len(rows)} rows")
        value, issue = check_value(edit["value"], column, order, matches)
        rows[row - 1][column.id] = value
        drop_issues(table.id, row, column.id)
        if issue:
            issues.append(
                {
                    "step": "review",
                    "target": table.id,
                    "row": row,
                    "column": column.id,
                    "raw": edit["value"],
                    "message": issue,
                }
            )

    doc["issues"] = issues
    doc["checks"] = run_checks(template, fields, tables, job)
    return doc
