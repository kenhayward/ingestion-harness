"""Apply reviewer edits to a draft template document (document.json).

Edits target a field (`field`) or a table cell (`table`, 1-based `row`, `column`). Values are
re-normalised with the field/column type; issues for edited targets are replaced, checks are
re-run on the edited data, and edited fields are marked `edited: true`. The draft itself is
never modified — a new document is returned.
"""

from __future__ import annotations

import copy
from typing import Any

from .checks import run_check
from .normalize import normalize_value
from .template import CheckStep, Template


def step_results(
    template: Template, fields: dict[str, Any], tables: dict[str, list[dict[str, Any]]]
) -> dict[str, Any]:
    """Rebuild the per-step results that check paths refer to."""
    results: dict[str, Any] = {}
    for step in template.extract_steps():
        if step.table is not None:
            results[step.id] = {"rows": tables.get(step.table, [])}
        else:
            results[step.id] = {f: fields[f] for f in step.fields if f in fields}
    return results


def run_checks(
    template: Template, fields: dict[str, Any], tables: dict[str, Any]
) -> dict[str, Any]:
    results = step_results(template, fields, tables)
    checks: dict[str, Any] = {}
    for step in template.pipeline:
        if isinstance(step, CheckStep):
            checks[step.id] = results[step.id] = run_check(template.compile_check(step), results)
    return checks


def apply_edits(
    template: Template, draft: dict[str, Any], edits: list[dict[str, Any]]
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

    for edit in edits:
        if edit.get("field"):
            field_id = edit["field"]
            definition = next((f for f in template.outputs.fields if f.id == field_id), None)
            if definition is None:
                raise ValueError(f"edit targets unknown field {field_id!r}")
            value, issue = normalize_value(
                edit["value"], definition.type, options=definition.enum, date_order=order
            )
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
        value, issue = normalize_value(
            edit["value"], column.type, options=column.enum, date_order=order
        )
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
    doc["checks"] = run_checks(template, fields, tables)
    return doc
