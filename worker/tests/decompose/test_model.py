from __future__ import annotations

import pytest
from pydantic import TypeAdapter, ValidationError

from ingest_worker.decompose.model import (
    Cell,
    DecomposedDocument,
    Flag,
    Inline,
    Link,
    Paragraph,
    Row,
    Section,
    Table,
    Text,
)


def test_extra_fields_forbidden() -> None:
    with pytest.raises(ValidationError):
        Text.model_validate({"text": "a", "marks": [], "bogus": 1})


def test_marks_reject_unknown() -> None:
    with pytest.raises(ValidationError):
        Text.model_validate({"text": "a", "marks": ["strike"]})


def test_frozen() -> None:
    t = Text(text="a")
    with pytest.raises(ValidationError):
        t.text = "b"  # type: ignore[misc]


def test_inline_discriminated_and_recursive() -> None:
    link = TypeAdapter(Inline).validate_python(
        {"kind": "link", "href": "x", "inlines": [{"kind": "text", "text": "a"}]}
    )
    assert isinstance(link, Link)
    assert link.inlines == [Text(text="a")]


def test_document_round_trip_with_nested_blocks() -> None:
    cell = Cell(blocks=[Paragraph(id="p", inlines=[Text(text="x")])])
    table = Table(id="t", column_widths=[1.0], header_rows=1, rows=[Row(cells=[cell])])
    doc = DecomposedDocument(
        blocks=[table],
        sections=[Section(id="s-a", title=[Text(text="A")], blocks=[], sections=[])],
        images=[],
        equations=[],
        notes=[],
        properties=[],
        report=[],
    )
    assert DecomposedDocument.model_validate_json(doc.model_dump_json()) == doc


def test_unknown_flag_code_rejected() -> None:
    with pytest.raises(ValidationError):
        Flag.model_validate({"code": "nope", "severity": "info", "message": "m"})
