from __future__ import annotations

import csv
import io
import json
from dataclasses import dataclass
from typing import Any, Literal

from .specs import CsvOutput, DocumentSpec, JsonOutput
from .storage import output_key

#: Prepended to every CSV so rows from different outputs can be joined after loading.
DOCUMENT_ID_COLUMN = "document_id"


#: CSVs carry a UTF-8 BOM: without it Excel decodes them with the Windows code page and
#: shows "Â°C" for "°C". Readers that honour the BOM (Excel, pandas, browsers, Python's
#: utf-8-sig) strip it.
CSV_CONTENT_TYPE = "text/csv; charset=utf-8"


def encode_csv(text: str) -> bytes:
    return text.encode("utf-8-sig")


def content_type(fmt: str) -> str:
    return CSV_CONTENT_TYPE if fmt == "csv" else "application/json"


@dataclass(frozen=True)
class RenderedOutput:
    output_id: str
    format: Literal["csv", "json"]
    key: str
    body: bytes
    row_count: int | None


def get_path(obj: Any, path: str) -> Any:
    """Dotted-path lookup ("a.b.0.c"). Empty path returns obj; missing keys return None."""
    if not path:
        return obj
    for part in path.split("."):
        if isinstance(obj, dict):
            obj = obj.get(part)
        elif isinstance(obj, list) and part.isdigit() and int(part) < len(obj):
            obj = obj[int(part)]
        else:
            return None
    return obj


def _cell(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, dict | list):
        return json.dumps(value, ensure_ascii=False, separators=(",", ":"))
    return str(value)


def render_csv(output: CsvOutput, result: dict[str, Any], document_id: str) -> tuple[bytes, int]:
    rows = get_path(result, output.rows_path)
    if rows is None:
        rows = []
    elif isinstance(rows, dict):
        rows = [rows]
    elif not isinstance(rows, list):
        raise ValueError(
            f"output {output.id!r}: rowsPath {output.rows_path!r} is not an object or array"
        )

    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow([DOCUMENT_ID_COLUMN, *(c.name for c in output.columns)])
    for row in rows:
        writer.writerow([document_id, *(_cell(get_path(row, c.path)) for c in output.columns)])
    return encode_csv(buf.getvalue()), len(rows)


def render_json(
    output: JsonOutput, results: dict[str, dict[str, Any]], meta: dict[str, Any]
) -> bytes:
    data = results if output.from_ == "*" else results[output.from_]
    return json.dumps({**meta, "data": data}, ensure_ascii=False, indent=2).encode("utf-8")


def render_outputs(
    spec: DocumentSpec,
    results: dict[str, dict[str, Any]],
    *,
    document_id: str,
    job_id: str,
    extracted_at: str,
    models: dict[str, str],
) -> list[RenderedOutput]:
    meta = {
        "document_id": document_id,
        "job_id": job_id,
        "spec_id": spec.id,
        "spec_version": spec.version,
        "extracted_at": extracted_at,
        "models": models,
    }
    rendered: list[RenderedOutput] = []
    for output in spec.outputs:
        key = output_key(spec.id, spec.version, output.id, document_id, output.format)
        if isinstance(output, CsvOutput):
            body, count = render_csv(output, results[output.from_], document_id)
            rendered.append(RenderedOutput(output.id, "csv", key, body, count))
        else:
            rendered.append(
                RenderedOutput(output.id, "json", key, render_json(output, results, meta), None)
            )
    return rendered
