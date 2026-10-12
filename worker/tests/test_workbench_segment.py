"""Segmentation preview grid: the same spans as production segment(), per-anchor errors."""

from __future__ import annotations

from typing import Any

import pytest

from ingest_worker.segment import segment
from ingest_worker.workbench import SegmentDocument, segment_samples

PAGES = [
    "PROTOCOL APPROVAL\nPrepared by: A\n",
    "1.0 PURPOSE\nValidate the blend\n2.0 PRODUCT DETAILS\nFolic acid 5 mg tablets\n",
]


def doc(**overrides: Any) -> SegmentDocument:
    base: dict[str, Any] = {
        "sections": [
            {"id": "approvals", "anchor": r"(?i)^PROTOCOL APPROVAL"},
            {"id": "purpose", "anchor": r"^\d+\.0 PURPOSE"},
            {"id": "product", "anchor": r"^\d+\.0 PRODUCT DETAILS"},
            {"id": "references", "anchor": r"^\d+\.0 REFERENCES", "required": False},
        ]
    }
    return SegmentDocument.model_validate({**base, **overrides})


def cells(result: dict[str, Any], sample: int = 0) -> dict[str, dict[str, Any]]:
    return {c["id"]: c for c in result["samples"][sample]["sections"]}


def test_grid_reports_page_line_and_size_per_section() -> None:
    result = segment_samples([("s1", PAGES)], doc())
    assert result["anchorErrors"] == {}
    sample = result["samples"][0]
    assert sample["sampleId"] == "s1"
    assert sample["firstPage"] == 1 and sample["pageCount"] == 2
    assert sample["error"] is None and sample["missingRequired"] == []
    c = cells(result)
    assert c["approvals"]["page"] == 1 and c["approvals"]["line"] == "PROTOCOL APPROVAL"
    assert c["purpose"]["page"] == 2 and c["purpose"]["line"] == "1.0 PURPOSE"
    assert c["product"]["found"] is True and c["product"]["chars"] > 0
    assert c["references"] == {
        "id": "references",
        "found": False,
        "page": None,
        "line": None,
        "chars": 0,
    }


def test_grid_sizes_match_production_segmentation() -> None:
    document = doc(pageMarkers=False)
    result = segment_samples([("s1", PAGES)], document)
    production = segment(PAGES, list(document.sections))
    for section_id, cell in cells(result).items():
        assert cell["chars"] == len(production[section_id])


def test_invalid_anchor_is_reported_and_skipped_not_fatal() -> None:
    broken = doc(
        sections=[
            {"id": "approvals", "anchor": r"(?i)^PROTOCOL APPROVAL"},
            {"id": "purpose", "anchor": r"^(\d+\.0 PURPOSE"},  # unclosed group
        ]
    )
    result = segment_samples([("s1", PAGES)], broken)
    assert "purpose" in result["anchorErrors"]
    assert "unterminated" in result["anchorErrors"]["purpose"]
    c = cells(result)
    assert c["approvals"]["found"] is True
    assert c["purpose"]["found"] is False


def test_missing_required_sections_are_listed() -> None:
    result = segment_samples([("s1", ["PROTOCOL APPROVAL\nonly"])], doc())
    assert result["samples"][0]["missingRequired"] == ["purpose", "product"]


def test_unprepared_samples_get_an_error_row_and_others_still_segment() -> None:
    result = segment_samples([("s0", None), ("s1", PAGES)], doc())
    assert result["samples"][0] == {
        "sampleId": "s0",
        "firstPage": 1,
        "pageCount": 0,
        "error": "not prepared",
        "missingRequired": [],
        "sections": [],
    }
    assert cells(result, 1)["purpose"]["found"] is True


def test_copy_selection_keeps_the_last_copy_and_numbers_original_pages() -> None:
    pages = [
        "PROTOCOL APPROVAL\nblank",
        "1.0 PURPOSE\nx",
        "PROTOCOL APPROVAL\nexecuted",
        "1.0 PURPOSE\ny",
    ]
    result = segment_samples(
        [("s1", pages)],
        doc(
            sections=[
                {"id": "approvals", "anchor": r"^PROTOCOL APPROVAL"},
                {"id": "purpose", "anchor": r"^\d+\.0 PURPOSE"},
            ],
            copies={"anchor": r"^PROTOCOL APPROVAL", "select": "last"},
        ),
    )
    sample = result["samples"][0]
    assert sample["firstPage"] == 3 and sample["pageCount"] == 2
    assert cells(result)["purpose"]["page"] == 4


def test_invalid_copies_anchor_is_an_anchor_error_and_copies_are_ignored() -> None:
    result = segment_samples([("s1", PAGES)], doc(copies={"anchor": "(", "select": "last"}))
    assert "copies" in result["anchorErrors"]
    assert result["samples"][0]["firstPage"] == 1


@pytest.mark.parametrize("long_line", ["X" * 500])
def test_matched_lines_are_trimmed(long_line: str) -> None:
    result = segment_samples(
        [("s1", [long_line])], doc(sections=[{"id": "all", "anchor": r"\A"}], pageMarkers=False)
    )
    assert len(cells(result)["all"]["line"]) == 200
