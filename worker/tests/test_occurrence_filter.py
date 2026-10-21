"""A step's occurrence filter (plan 2026-10-21-occurrence-filter): the head it is judged on, the
match, and a job's calls and rows when steps filter one repeating section."""

from __future__ import annotations

import pytest

from ingest_worker.segment import (
    OCCURRENCE_HEAD_CHARS,
    Occurrence,
    occurrence_head,
    occurrence_matches,
)


def _occ(text: str) -> Occurrence:
    return Occurrence(1, 1, None, None, None, text)


@pytest.mark.parametrize(
    ("text", "head"),
    [
        ("Table 1: Appearance\nResults", "Table 1: Appearance Results"),
        # A title wrapped over lines, OCR spacing and a page break read as one line.
        (
            "Table 2:   Assay and\n   Chromatographic\tPurity\n\f\nResults",
            "Table 2: Assay and Chromatographic Purity Results",
        ),
        # Page markers are not part of the heading.
        ("[page 37]\nTable 3: Dissolution\n[page 38]\nResults", "Table 3: Dissolution Results"),
        ("  \n Table 4  ", "Table 4"),
    ],
)
def test_occurrence_head(text: str, head: str) -> None:
    assert occurrence_head(text) == head


def test_occurrence_head_is_cut_at_its_length() -> None:
    assert len(occurrence_head("word " * 400)) <= OCCURRENCE_HEAD_CHARS


@pytest.mark.parametrize(
    ("pattern", "text", "matches"),
    [
        (
            "Appearance and Water Content",
            "Table 1: Study 9 - Appearance and Water\nContent Results",
            True,
        ),
        (r"appearance\s+and\s+water", "Table 1: APPEARANCE AND WATER CONTENT", True),
        ("Microbial Purity", "Table 1: Appearance and Water Content Results\nT0 Complies", False),
        # The body is not the heading: words of another kind far below it never match.
        (
            "Microbial Purity",
            "Table 1: Appearance Results\n" + "T0 Complies\n" * 80 + "Microbial Purity",
            False,
        ),
        (
            r"Assay.*\(Niraparib",
            "Table 2: Assay and Chromatographic Purity\n(Niraparib tosylate) Results",
            True,
        ),
    ],
)
def test_occurrence_matches(pattern: str, text: str, matches: bool) -> None:
    assert occurrence_matches(pattern, _occ(text)) is matches
