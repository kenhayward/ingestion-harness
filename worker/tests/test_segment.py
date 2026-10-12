from __future__ import annotations

import pytest

from ingest_worker.segment import (
    PAGE_BREAK,
    MissingSectionsError,
    SectionSpan,
    section_spans,
    segment,
    select_copy,
)
from ingest_worker.specs import CopySelection, Section

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


# --- copy selection (documents that contain e.g. a blank protocol followed by the executed one)

COPY_PAGES = [
    "TITLE",
    "1.0 PROTOCOL APPROVAL\nblank",
    "15.0 TEST DATA\nBATCH NO.:",
    "TITLE",
    "1.0 PROTOCOL APPROVAL\nsigned",
    "15.0 TEST DATA\nBATCH NO.: G17230211",
]


def test_select_copy_last_keeps_pages_from_the_last_anchor_match() -> None:
    sel = CopySelection(anchor=r"^\W*1\.0 PROTOCOL APPROVAL", select="last")
    assert select_copy(COPY_PAGES, sel) == (4, COPY_PAGES[4:])


def test_select_copy_first_stops_before_the_second_copy() -> None:
    sel = CopySelection(anchor=r"^\W*1\.0 PROTOCOL APPROVAL", select="first")
    assert select_copy(COPY_PAGES, sel) == (0, COPY_PAGES[:4])


def test_select_copy_is_a_no_op_for_single_copy_documents() -> None:
    sel = CopySelection(anchor=r"^\W*1\.0 PROTOCOL APPROVAL")
    pages = COPY_PAGES[:3]
    assert select_copy(pages, sel) == (0, pages)
    assert select_copy(["no anchor here"], sel) == (0, ["no anchor here"])


def test_coinciding_anchors_give_the_text_to_the_later_declared_section() -> None:
    """A catch-all start section (start-of-text anchor) yields to a specific one starting at the same place."""
    sections = [
        Section(id="zz_front", anchor=r"\A"),
        Section(id="approvals", anchor=r"^APPROVAL"),
        Section(id="body", anchor=r"^BODY"),
    ]
    result = segment(["APPROVAL\nsigned\nBODY\ntext"], sections)
    assert result == {"zz_front": "", "approvals": "APPROVAL\nsigned", "body": "BODY\ntext"}


def test_sections_starting_mid_page_carry_their_page_marker() -> None:
    pages = ["[page 1]\nINVOICE 1\nDescription Qty\nx", "[page 2]\nmore rows\nSubtotal 1"]
    result = segment(pages, SECTIONS, page_marker=r"^\[page \d+\]$")
    assert result["header"] == "[page 1]\nINVOICE 1"
    assert result["lines"].startswith("[page 1]\nDescription Qty")
    assert result["totals"] == "[page 2]\nSubtotal 1"


def test_section_spans_are_in_document_order_with_unmatched_ids() -> None:
    text = "Subtotal 1\nINVOICE 1\nDescription Qty\nx"
    spans, unmatched = section_spans(text, SECTIONS)
    assert [s.id for s in spans] == ["totals", "header", "lines"]
    assert unmatched == ["notes"]
    assert spans[0] == SectionSpan("totals", 0, text.index("INVOICE"))
    assert spans[-1].end == len(text)


def test_segment_bodies_equal_their_spans() -> None:
    pages = ["INVOICE #42\nAcme\nDescription Qty\nWidget", "Subtotal 13.00"]
    text = PAGE_BREAK.join(pages)
    spans, _ = section_spans(text, SECTIONS)
    result = segment(pages, SECTIONS)
    for span in spans:
        assert result[span.id] == text[span.start : span.end].strip()
