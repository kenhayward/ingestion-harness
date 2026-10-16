from __future__ import annotations

import copy
from pathlib import Path

import pytest
from pydantic import ValidationError

from ingest_worker.specs import DocumentSpec, load_specs
from ingest_worker.workbench import SegmentDocument

from .covalidation import FIXTURE

MINIMAL = {
    "id": "demo",
    "version": 1,
    "title": "Demo",
    "document": {"sections": [{"id": "h", "anchor": "^H"}]},
    "extractions": [{"id": "e", "sections": ["h"], "prompt": "p.j2", "schema": {"type": "object"}}],
    "outputs": [{"id": "o", "format": "json", "from": "*"}],
}


def test_every_committed_spec_is_valid(specs_dir: Path) -> None:
    """Contract test shared with apps/api/test/spec-registry.test.ts — keep green."""
    registry = load_specs(specs_dir)
    assert (
        registry.get("process-validation-protocol", 1).spec.title == "Process Validation Protocol"
    )


def test_defaults_and_aliases() -> None:
    spec = DocumentSpec.model_validate(MINIMAL)
    assert spec.extractions[0].model == "default"
    assert spec.extractions[0].max_attempts == 2
    assert spec.extractions[0].schema_ == {"type": "object"}
    assert spec.document.ocr == "auto"


def test_copies_and_page_images() -> None:
    doc = {**MINIMAL["document"], "copies": {"anchor": "^APPROVAL"}}  # type: ignore[dict-item]
    ex = {**MINIMAL["extractions"][0], "pageImages": [1, 2]}  # type: ignore[dict-item]
    spec = DocumentSpec.model_validate({**MINIMAL, "document": doc, "extractions": [ex]})
    assert spec.document.copies is not None and spec.document.copies.select == "last"
    assert spec.extractions[0].page_images == [1, 2]
    assert DocumentSpec.model_validate(MINIMAL).extractions[0].page_images == []
    with pytest.raises(ValidationError):
        DocumentSpec.model_validate({**MINIMAL, "extractions": [{**ex, "pageImages": [0]}]})


ARRAY_SCHEMA = {
    "type": "object",
    "additionalProperties": False,
    "required": ["rows", "note"],
    "properties": {
        "rows": {"type": "array", "items": {"type": "object"}},
        "note": {"type": "string"},
    },
}


def chunked(**overrides: object) -> dict[str, object]:
    ex = {**MINIMAL["extractions"][0], "schema": ARRAY_SCHEMA, "chunkPages": 2, "mergePath": "rows"}  # type: ignore[dict-item]
    return {**MINIMAL, "extractions": [{**ex, **overrides}]}


def test_chunking_and_max_tokens() -> None:
    spec = DocumentSpec.model_validate(chunked(maxTokens=32000))
    ex = spec.extractions[0]
    assert (ex.chunk_pages, ex.merge_path, ex.max_tokens) == (2, "rows", 32000)
    assert DocumentSpec.model_validate(MINIMAL).extractions[0].max_tokens == 64000


@pytest.mark.parametrize(
    ("overrides", "message"),
    [
        ({"mergePath": None}, "mergePath"),
        ({"mergePath": "note"}, "array"),
        ({"mergePath": "missing"}, "array"),
        ({"sections": ["h", "h2"]}, "exactly one section"),
    ],
)
def test_chunking_is_validated(overrides: dict[str, object], message: str) -> None:
    raw = chunked(**overrides)
    raw["document"] = {"sections": [{"id": "h", "anchor": "^H"}, {"id": "h2", "anchor": "^J"}]}
    with pytest.raises(ValidationError, match=message):
        DocumentSpec.model_validate(raw)


def with_check(check: dict[str, object], **extra: object) -> dict[str, object]:
    base = {"id": "c", "values": "e.rows[*].a", "reference": "e.rows[*].b"}
    return {**MINIMAL, "checks": [{**base, **check}], **extra}


def test_checks_are_parsed_and_can_feed_outputs() -> None:
    outputs = [
        *MINIMAL["outputs"],
        {
            "id": "c_csv",
            "format": "csv",
            "from": "c",
            "rowsPath": "rows",  # type: ignore[list-item]
            "columns": [{"name": "v", "path": "value"}],
        },
    ]
    spec = DocumentSpec.model_validate(with_check({"maxDistance": 1}, outputs=outputs))
    assert spec.checks[0].max_distance == 1 and spec.checks[0].aliases is None
    assert DocumentSpec.model_validate(MINIMAL).checks == []


@pytest.mark.parametrize(
    ("check", "message"),
    [
        ({"values": "nope.rows[*].a"}, "unknown extraction"),
        ({"reference": "x"}, "unknown extraction"),
        ({"id": "e"}, "duplicate"),
    ],
)
def test_checks_are_validated(check: dict[str, object], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        DocumentSpec.model_validate(with_check(check))


def test_ocr_mode_is_validated() -> None:
    doc = {**MINIMAL["document"], "ocr": "always"}  # type: ignore[dict-item]
    assert DocumentSpec.model_validate({**MINIMAL, "document": doc}).document.ocr == "always"
    with pytest.raises(ValidationError):
        DocumentSpec.model_validate({**MINIMAL, "document": {**doc, "ocr": "sometimes"}})


@pytest.mark.parametrize(
    ("patch", "message"),
    [
        ({"extractions": [{**MINIMAL["extractions"][0], "sections": ["nope"]}]}, "unknown section"),  # type: ignore[dict-item]
        ({"outputs": [{"id": "o", "format": "json", "from": "missing"}]}, "unknown extraction"),
        ({"outputs": [MINIMAL["outputs"][0], MINIMAL["outputs"][0]]}, "duplicate output"),  # type: ignore[index]
        ({"unexpected": True}, "Extra inputs"),
    ],
)
def test_rejects_invalid_specs(patch: dict[str, object], message: str) -> None:
    with pytest.raises(ValidationError, match=message):
        DocumentSpec.model_validate({**MINIMAL, **patch})


def test_load_specs_reports_missing_prompt(tmp_path: Path) -> None:
    d = tmp_path / "demo" / "v1"
    d.mkdir(parents=True)
    (d / "spec.yaml").write_text(
        "id: demo\nversion: 1\ntitle: Demo\n"
        "document: {sections: [{id: h, anchor: '^H'}]}\n"
        "extractions: [{id: e, sections: [h], prompt: missing.j2, schema: {type: object}}]\n"
        "outputs: [{id: o, format: json, from: '*'}]\n",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="prompt not found"):
        load_specs(tmp_path)


def test_a_legacy_spec_cannot_repeat() -> None:
    doc = {"sections": [{"id": "h", "anchor": "^H", "repeat": True}]}
    with pytest.raises(ValidationError, match="repeat is supported in recipes only"):
        DocumentSpec.model_validate({**MINIMAL, "document": doc})


def test_a_segment_preview_checks_key_from() -> None:
    sections = copy.deepcopy(FIXTURE["base"]["document"]["sections"])
    sections[2]["keyFrom"] = "nope"
    with pytest.raises(ValidationError, match="must be a repeating section with a key"):
        SegmentDocument.model_validate({"sections": sections})
