"""The Pipeline stage's check of occurrence filters on the dev samples (plan
2026-10-21-occurrence-filter, Tasks C2 and C3)."""

from __future__ import annotations

import copy
from typing import Any

import pytest

from ingest_worker.occurrence_check import occurrence_findings, occurrence_round

# Two kinds of table in one repeating section, two batches each.
KINDS_PAGES = [
    "STABILITY REPORT\nContents",
    "Table 1: Study 7 - Batch 11 - Appearance and Water Content Results\nT0 Complies",
    "Table 2: Study 7 - Batch 11 - Assay\nResults\nT0 99.1",
    "Table 3: Study 7 - Batch 12 - Appearance and Water Content Results\nT0 Complies",
    "Table 4: Study 7 - Batch 12 - Assay\nResults\nT0 98.7",
]


def _step(
    sid: str, table: str, section: str, match: str | None = None, **kw: Any
) -> dict[str, Any]:
    step: dict[str, Any] = {"type": "extract", "id": sid, "table": table, "sections": [section]}
    if match is not None:
        step["occurrences"] = {"match": match}
    return {**step, **kw}


def _definition(*steps: dict[str, Any], section: dict[str, Any] | None = None) -> dict[str, Any]:
    tables = sorted({s["table"] for s in steps})
    return {
        "id": "report",
        "version": 1,
        "name": "Report",
        "document": {
            "sections": [
                {"id": "front", "anchor": r"\A"},
                section
                or {
                    "id": "tables",
                    "anchor": r"^Table \d+:",
                    "repeat": True,
                    "key": r"^Table (\d+):",
                },
            ]
        },
        "outputs": {
            "fields": [],
            "tables": [{"id": t, "columns": [{"id": "result", "type": "text"}]} for t in tables],
        },
        "pipeline": list(steps),
    }


def _findings(definition: dict[str, Any], pages: list[str] = KINDS_PAGES) -> list[str]:
    return occurrence_findings([("dev.pdf", pages)], definition)[0]


def test_steps_reading_every_occurrence_of_several_kinds_are_told_to_filter() -> None:
    lines = _findings(
        _definition(_step("appearance", "appearance", "tables"), _step("assay", "assay", "tables"))
    )
    assert len(lines) == 1
    assert "'appearance', 'assay'" in lines[0]
    assert 'read every occurrence of "tables"' in lines[0]
    assert "2 kinds" in lines[0]
    assert '2 like "Table 1: Study 7 - Batch 11 - Appearance and Water Content Results' in lines[0]
    assert '2 like "Table 2: Study 7 - Batch 11 - Assay Results' in lines[0]
    assert "occurrenceMatch" in lines[0]


def test_filters_that_split_the_kinds_pass() -> None:
    definition = _definition(
        _step("appearance", "appearance", "tables", "Appearance and Water"),
        _step("assay", "assay", "tables", r"Assay\s+Results"),
    )
    assert _findings(definition) == []


def test_a_filter_matching_no_occurrence_is_reported_with_the_headings() -> None:
    definition = _definition(
        _step("appearance", "appearance", "tables", "Appearance"),
        _step("assay", "assay", "tables", "Chromatographic Purity"),
    )
    lines = _findings(definition)
    assert any(
        "step 'assay': occurrenceMatch 'Chromatographic Purity' matches none of the 4 occurrences"
        in line
        and '"Table 2: Study 7 - Batch 11 - Assay Results' in line
        for line in lines
    ), lines


def test_a_kind_no_filter_reads_is_reported() -> None:
    lines = _findings(_definition(_step("appearance", "appearance", "tables", "Appearance")))
    assert len(lines) == 1
    assert 'occurrences of "tables" no step reads' in lines[0]
    assert '2 like "Table 2: Study 7 - Batch 11 - Assay Results' in lines[0]


def test_steps_wanting_every_occurrence_of_one_kind_of_block_are_left_alone() -> None:
    """A per-batch block holding a header table and a results table: both steps rightly read
    every occurrence, and the headings are all of one kind."""
    pages = [
        "REPORT",
        "1. BATCH 11 PACKED AS HDPE BOTTLE\nPackaging: bottle\nResults: T0 Complies",
        "2. BATCH 12 PACKED AS HDPE BOTTLE\nPackaging: bottle\nResults: T0 Complies",
        "3. BATCH 13 PACKED AS HDPE BOTTLE\nPackaging: bottle\nResults: T0 Complies",
    ]
    batch = {"id": "batch", "anchor": r"^\d+\. BATCH", "repeat": True, "key": r"BATCH (\d+)"}
    definition = _definition(
        _step("packaging", "packaging", "batch"),
        _step("results", "results", "batch"),
        section=batch,
    )
    assert _findings(definition, pages) == []


def test_occurrence_lengths_are_counted_in_pages() -> None:
    pages = [*KINDS_PAGES[:2], "more", "more", KINDS_PAGES[2]]
    definition = _definition(_step("appearance", "appearance", "tables"))
    assert occurrence_findings([("dev.pdf", pages)], definition)[1] == {"tables": 3}


def _body(*steps: dict[str, Any]) -> dict[str, Any]:
    return {"notes": "", "changes": [{"op": "putStep", "step": s, "reason": "r"} for s in steps]}


@pytest.mark.parametrize(("extra_pages", "kept"), [(0, False), (8, True)])
def test_chunk_pages_on_short_occurrences_are_dropped(extra_pages: int, kept: bool) -> None:
    """Each occurrence is already its own call: chunking one of a few pages only splits a table
    from its heading. Over 8 pages, chunking stays."""
    pages = [*KINDS_PAGES[:2], *["more rows"] * extra_pages, *KINDS_PAGES[2:]]
    draft = _definition()
    draft["outputs"]["tables"] = [
        {"id": t, "columns": [{"id": "result", "type": "text"}]} for t in ("appearance", "assay")
    ]
    body = _body(
        _step("appearance", "appearance", "tables", "Appearance", chunkPages=1),
        _step("assay", "assay", "tables", r"Assay\s+Results"),
    )
    fitted, lines = occurrence_round([("dev.pdf", pages)], draft, copy.deepcopy(body))
    assert lines == []
    assert ("chunkPages" in fitted["changes"][0]["step"]) is kept
    if not kept:
        assert (
            "Ignored chunkPages on 'appearance': the longest occurrence of 'tables' in the dev "
            "samples is 1 page, and each occurrence is already its own call."
        ) in fitted["notes"]
    else:
        assert fitted["notes"] == ""


def test_samples_that_do_not_segment_are_skipped() -> None:
    """A sample missing a required section gives no findings (the sections stage reports it)."""
    definition = _definition(_step("appearance", "appearance", "tables"))
    definition["document"]["sections"].append({"id": "end", "anchor": "^THE END", "required": True})
    assert occurrence_findings([("dev.pdf", KINDS_PAGES)], definition) == ([], {})
