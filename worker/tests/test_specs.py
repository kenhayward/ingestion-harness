from __future__ import annotations

from pathlib import Path

import pytest
from pydantic import ValidationError

from ingest_worker.specs import DocumentSpec, load_specs

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
    assert registry.get("example-invoice", 1).spec.title == "Supplier invoice"


def test_defaults_and_aliases() -> None:
    spec = DocumentSpec.model_validate(MINIMAL)
    assert spec.extractions[0].model == "default"
    assert spec.extractions[0].max_attempts == 2
    assert spec.extractions[0].schema_ == {"type": "object"}
    assert spec.document.ocr == "auto"


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
