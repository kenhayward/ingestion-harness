from __future__ import annotations

import pytest

from ingest_worker.segment import MissingSectionsError, segment
from ingest_worker.specs import Section

SECTIONS = [
    Section(id="header", anchor=r"^INVOICE"),
    Section(id="lines", anchor=r"^Description\s+Qty"),
    Section(id="notes", anchor=r"^Notes", required=False),
    Section(id="totals", anchor=r"^Subtotal"),
]


def test_splits_on_anchors_across_pages() -> None:
    pages = [
        "INVOICE #42\nAcme Ltd\nDescription Qty Price\nWidget 2 5.00",
        "Gadget 1 3.00\nSubtotal 13.00\nTotal 13.00",
    ]
    result = segment(pages, SECTIONS)
    assert result["header"].startswith("INVOICE #42")
    assert "Acme" in result["header"] and "Widget" not in result["header"]
    assert "Widget" in result["lines"] and "Gadget" in result["lines"]
    assert result["totals"].startswith("Subtotal")
    assert result["notes"] == ""


def test_sections_are_ordered_by_position_not_spec_order() -> None:
    pages = ["Subtotal 1\nINVOICE 1\nDescription Qty\nx"]
    result = segment(pages, SECTIONS)
    assert result["totals"] == "Subtotal 1"


def test_missing_required_sections_raise() -> None:
    with pytest.raises(MissingSectionsError) as exc:
        segment(["INVOICE only"], SECTIONS)
    assert exc.value.missing == ["lines", "totals"]
