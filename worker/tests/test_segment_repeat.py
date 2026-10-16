"""Repeating sections in segmentation (spec 2026-10-16): occurrences, keys, keyFrom, key issues."""

from __future__ import annotations

import pytest

from ingest_worker.pipeline import PAGE_MARKER, mark_pages
from ingest_worker.segment import (
    PAGE_BREAK,
    MissingSectionsError,
    key_issues,
    section_spans,
    segment,
    segment_occurrences,
)
from ingest_worker.specs import Section

from .covalidation import BATCHES, PAGES, SECTIONS, edited

B1, B2, B3 = BATCHES


def _text(pages: list[str] | None = None) -> str:
    return PAGE_BREAK.join(pages if pages is not None else PAGES)


def _without_key(section_id: str) -> list[Section]:
    return [s.model_copy(update={"key": None}) if s.id == section_id else s for s in SECTIONS]


def _covalidation(appearance_source: str = "own") -> list[tuple[str, int, str | None, str | None]]:
    rows: list[tuple[str, int, str | None, str | None]] = [("front", 0, None, None)]
    for i, batch in enumerate(BATCHES):
        rows += [
            ("batch", i, batch, "own"),
            ("appearance", i, batch, appearance_source),
            ("microbial", i, batch, "own"),
        ]
    return [*rows, ("conclusion", 0, None, None)]


@pytest.mark.parametrize(
    ("sections", "expected"),
    [
        pytest.param(
            [Section(id="a", anchor="^Table")], [("a", 0, None, None)], id="non_repeating"
        ),
        pytest.param(SECTIONS, _covalidation(), id="covalidation"),
        pytest.param(
            _without_key("appearance"), _covalidation("inherited"), id="key_from_nearest_preceding"
        ),
        pytest.param(
            [Section(id="b", anchor=r"^\d\.", repeat=True, key=r"(BATCH|LOT)\s+(?P<key>\w+)")],
            [("b", i, b, "own") for i, b in enumerate(BATCHES)]
            + [("b", 3, None, None)],  # "4. CONCLUSION"
            id="key_group_named",
        ),
        pytest.param(
            [Section(id="b", anchor=r"^\d\. STUDY", repeat=True, key=r"\d{7}")],
            [("b", i, b, "own") for i, b in enumerate(BATCHES)],
            id="key_whole_match",
        ),
        pytest.param(
            [Section(id="b", anchor=r"^\d\. STUDY", repeat=True, key=r"LOT (\w+)")],
            [("b", i, None, None) for i in range(3)],
            id="key_no_match_is_none",
        ),
        pytest.param(
            [Section(id="z", anchor="^(?=Table)", repeat=True)],
            [("z", i, None, None) for i in range(6)],
            id="zero_width_anchor",
        ),
    ],
)
def test_section_spans_repeats(
    sections: list[Section], expected: list[tuple[str, int, str | None, str | None]]
) -> None:
    spans, unmatched = section_spans(_text(), sections)
    assert [(s.id, s.index, s.key, s.key_source) for s in spans] == expected
    assert unmatched == []


def test_an_occurrence_ends_at_the_next_start_of_any_section() -> None:
    text = _text()
    spans, _ = section_spans(text, SECTIONS)
    first_microbial = next(s for s in spans if s.id == "microbial")
    body = text[first_microbial.start : first_microbial.end]
    assert "Microbial Purity" in body and f"BATCH {B2}" not in body


def test_a_key_before_the_first_source_occurrence_is_none() -> None:
    pages = edited(
        "Study STUDY-202432", "Table 0: Study-202432 - Appearance and Water Content Results", 0
    )
    spans, _ = section_spans(_text(pages), _without_key("appearance"))
    first = next(s for s in spans if s.id == "appearance")
    assert (first.index, first.key, first.key_source) == (0, None, None)


def test_own_key_wins_over_key_from() -> None:
    pages = edited(f"Batch {B2} - Appearance", "Batch 9999999 - Appearance", 2)
    spans, _ = section_spans(_text(pages), SECTIONS)
    second = [s for s in spans if s.id == "appearance"][1]
    assert (second.key, second.own_key, second.key_source) == ("9999999", "9999999", "own")


@pytest.mark.parametrize(
    ("pages", "messages"),
    [
        pytest.param(PAGES, [], id="clean"),
        pytest.param(
            edited("Appearance and Water", "Apperance and Water", 3),
            [f"appearance: no occurrence for batch {B3}"],
            id="missing_for_one_batch",
        ),
        pytest.param(
            edited(f"Batch {B2} - Appearance", "Batch 9999999 - Appearance", 2),
            [
                "appearance occurrence 2: key 9999999 is not a batch key",
                f"appearance occurrence 2: key 9999999 differs from batch {B2} above it",
                f"appearance: no occurrence for batch {B2}",
            ],
            id="key_not_a_source_key",
        ),
        pytest.param(
            edited(
                "Study STUDY-202432",
                "Table 0: Study-202432 - Appearance and Water Content Results",
                0,
            ),
            ["appearance occurrence 1: no key"],
            id="occurrence_before_first_heading",
        ),
    ],
)
def test_key_issues(pages: list[str], messages: list[str]) -> None:
    spans, _ = section_spans(_text(pages), SECTIONS)
    assert [i.message for i in key_issues(SECTIONS, spans)] == messages


def test_sections_without_key_from_are_never_checked() -> None:
    plain = [s.model_copy(update={"key_from": None}) for s in SECTIONS]
    spans, _ = section_spans(_text(edited("Appearance and Water", "Apperance and Water", 3)), plain)
    assert key_issues(plain, spans) == []


def test_key_issues_skip_a_key_from_target_left_out() -> None:
    """The preview drops sections with an invalid anchor: a keyFrom naming one is not checked."""
    kept = [s for s in SECTIONS if s.id != "batch"]
    spans, _ = section_spans(_text(), kept)
    assert key_issues(kept, spans) == []


def test_segment_occurrences_marks_pages_and_joins_text() -> None:
    result = segment_occurrences(mark_pages(PAGES, 1), SECTIONS, page_marker=PAGE_MARKER)
    occ = result.occurrences["appearance"]
    assert [(o.index, o.count, o.key, o.key_source, o.page) for o in occ] == [
        (1, 3, B1, "own", 2),
        (2, 3, B2, "own", 3),
        (3, 3, B3, "own", 4),
    ]
    assert all(o.text.startswith("[page ") for o in occ)
    assert result.sections["appearance"] == "\n\n".join(o.text for o in occ)
    assert set(result.occurrences) == {"batch", "appearance", "microbial"}
    assert result.key_issues == []


def test_segment_without_repeats_is_unchanged() -> None:
    plain = [Section(id="front", anchor=r"\A"), Section(id="tables", anchor="^Table")]
    assert segment(PAGES, plain) == segment_occurrences(PAGES, plain).sections
    assert segment_occurrences(PAGES, plain).occurrences == {}


def test_a_required_repeating_section_without_occurrences_is_missing() -> None:
    with pytest.raises(MissingSectionsError):
        segment_occurrences(["no tables here"], [Section(id="t", anchor="^Table", repeat=True)])


def test_an_optional_repeating_section_without_occurrences_is_empty() -> None:
    sections = [
        Section(id="all", anchor=r"\A"),
        Section(id="t", anchor="^Table", repeat=True, required=False),
    ]
    result = segment_occurrences(["no tables here"], sections)
    assert result.occurrences["t"] == [] and result.sections["t"] == ""
