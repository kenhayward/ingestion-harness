from __future__ import annotations

import json

from ingest_worker.outputs import get_path, render_csv, render_outputs
from ingest_worker.specs import CsvOutput, DocumentSpec


def test_get_path() -> None:
    obj = {"a": {"b": [{"c": 1}]}}
    assert get_path(obj, "") is obj
    assert get_path(obj, "a.b.0.c") == 1
    assert get_path(obj, "a.missing.c") is None
    assert get_path(obj, "a.b.5") is None


def test_render_csv_flattens_rows_and_prepends_document_id() -> None:
    output = CsvOutput.model_validate(
        {
            "id": "lines",
            "format": "csv",
            "from": "x",
            "rowsPath": "items",
            "columns": [
                {"name": "desc", "path": "description"},
                {"name": "qty", "path": "quantity"},
                {"name": "sku", "path": "sku"},
            ],
        }
    )
    body, count = render_csv(
        output,
        {"items": [{"description": 'Widget, "large"', "quantity": 2, "sku": None}]},
        "doc-1",
    )
    assert count == 1
    assert body.decode() == 'document_id,desc,qty,sku\ndoc-1,"Widget, ""large""",2,\n'


def test_render_csv_single_object_is_one_row() -> None:
    output = CsvOutput.model_validate(
        {"id": "h", "format": "csv", "from": "x", "columns": [{"name": "n", "path": "n"}]}
    )
    assert render_csv(output, {"n": True}, "d")[0].decode() == "document_id,n\nd,true\n"


def test_render_outputs_builds_keys_and_json_envelope() -> None:
    spec = DocumentSpec.model_validate(
        {
            "id": "demo",
            "version": 3,
            "title": "Demo",
            "document": {"sections": [{"id": "h", "anchor": "^H"}]},
            "extractions": [{"id": "e", "sections": ["h"], "prompt": "p", "schema": {}}],
            "outputs": [
                {
                    "id": "rows",
                    "format": "csv",
                    "from": "e",
                    "columns": [{"name": "a", "path": "a"}],
                },
                {"id": "all", "format": "json", "from": "*"},
            ],
        }
    )
    rendered = render_outputs(
        spec,
        {"e": {"a": 1}},
        document_id="doc",
        job_id="job",
        extracted_at="2026-01-01T00:00:00Z",
        models={"e": "fake/m"},
    )
    assert [o.key for o in rendered] == ["demo/v3/rows/doc.csv", "demo/v3/all/doc.json"]
    envelope = json.loads(rendered[1].body)
    assert envelope["data"] == {"e": {"a": 1}}
    assert envelope["spec_version"] == 3 and envelope["models"] == {"e": "fake/m"}
