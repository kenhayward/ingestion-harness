"""The shared comparison forms, pinned by the vectors in the contract package."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from ingest_worker.decompose.forms import grid_forms, normalise, text_form
from ingest_worker.decompose.model import DecomposedDocument

VECTORS = (
    Path(__file__).resolve().parents[3]
    / "packages"
    / "bridge-contract"
    / "vectors"
    / "comparison-forms.json"
)


def _vectors() -> list[dict[str, Any]]:
    loaded: list[dict[str, Any]] = json.loads(VECTORS.read_text(encoding="utf-8"))
    return loaded


@pytest.mark.parametrize("vector", _vectors(), ids=lambda v: str(v["name"]))
def test_vectors_match(vector: dict[str, Any]) -> None:
    doc = DecomposedDocument.model_validate(vector["document"])
    assert text_form(doc) == vector["text_form"]
    assert grid_forms(doc) == vector["grid_forms"]


def test_vectors_cover_the_required_cases() -> None:
    names = {v["name"] for v in _vectors()}
    assert {
        "merged-cells",
        "captioned-table-with-notes",
        "cross-reference",
        "image-only-equation",
        "no-break-space-and-line-break",
    } <= names


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("  a  b ", "a b"),
        ("a\u00a0\u00a0b", "a b"),
        ("a\nb\tc", "a b c"),
        ("e\u0301", "\u00e9"),  # NFC
        ("a\u2003\u202fb\u3000", "a b"),
        ("a\u200bb", "a\u200bb"),  # a zero-width space is not whitespace
        ("", ""),
        (" \n ", ""),
    ],
)
def test_normalise(raw: str, expected: str) -> None:
    assert normalise(raw) == expected
