from __future__ import annotations

from ingest_worker.decompose.ids import child_id, normalise_title, section_id


def test_section_id_slug() -> None:
    assert section_id(None, "Dissolution Results", 1) == "s-dissolution-results"


def test_repeat_occurrence_suffix() -> None:
    assert section_id(None, "Dissolution Results", 2) == "s-dissolution-results~2"


def test_empty_title_is_untitled() -> None:
    assert section_id(None, "", 1) == "s-untitled"


def test_nested_keeps_parent_path() -> None:
    parent = section_id(None, "Results", 1)
    assert section_id(parent, "Dissolution Results", 1) == "s-results/s-dissolution-results"
    assert child_id(section_id(parent, "Tables", 1), "table", 3) == "s-results/s-tables#table-3"


def test_child_id() -> None:
    assert child_id("s-results", "table", 3) == "s-results#table-3"


def test_normalise_title() -> None:
    assert normalise_title("  Full   Width -- Test!  ") == "full-width-test"
    assert normalise_title("".join(map(chr, (0xFF26, 0xFF55, 0xFF4C, 0xFF4C)))) == "full"
    assert len(normalise_title("a" * 100)) == 60
    assert normalise_title("***") == "untitled"
