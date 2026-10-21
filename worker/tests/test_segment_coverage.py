"""missed_keys: repeating-section keys a key pattern finds that no anchor caught."""

from __future__ import annotations

from ingest_worker.segment import MAX_MISSED_KEYS, MissedKey, missed_keys, section_spans
from ingest_worker.specs import Section

ANCHOR = r"^\s*Table\s+\d+:\s.*Results\s*$"
KEY = r"^\s*Table\s+(\d+):"

CONTENTS = (
    "Contents\n"
    "Table 1: Study A - Assay and Chromatographic Purity (HDPE\n"
    "bottle - X Results.....25\n"
    "Table 2: Study A - Assay Results.....26\n"
    "Table 3: Study B - Assay and Chromatographic Purity (HDPE\n"
    "bottle - Y Results.....27\n"
)


def _body(*titles: str) -> str:
    return CONTENTS + "\f\n" + "\n".join(f"{t}\nrow data\n" for t in titles)


def _spans(text: str, sections: list[Section]):  # type: ignore[no-untyped-def]
    return section_spans(text, sections)[0]


def test_wrapped_titles_are_missed() -> None:
    text = _body(
        "Table\xa01: Study A - Assay and Chromatographic Purity (HDPE\n   bottle - X) Results",
        "Table\xa02: Study A - Assay Results",
        "Table\xa03: Study B - Assay and Chromatographic Purity (HDPE\n   bottle - Y) Results",
    )
    sections = [Section(id="result_tables", anchor=ANCHOR, repeat=True, key=KEY)]
    spans = _spans(text, sections)
    assert [s.key for s in spans] == ["2"]
    assert missed_keys(text, sections, spans) == [
        MissedKey(
            ("result_tables",), "1", "Table\xa01: Study A - Assay and Chromatographic Purity (HDPE"
        ),
        MissedKey(
            ("result_tables",), "3", "Table\xa03: Study B - Assay and Chromatographic Purity (HDPE"
        ),
    ]


def _kinds(text: str) -> list[Section]:
    return [
        Section(id="kind_a", anchor=r"^Table \d+: A\b", repeat=True, key=r"^Table (\d+):"),
        Section(id="kind_b", anchor=r"^Table \d+: B\b", repeat=True, key=r"^Table (\d+):"),
    ]


def test_shared_key_pattern_is_one_group() -> None:
    text = "Table 1: A one\nx\nTable 2: B two\nx\nTable 3: A three\nx\nTable 4: B four\n"
    sections = _kinds(text)
    assert missed_keys(text, sections, _spans(text, sections)) == []
    broken = text.replace("Table 4: B four", "Table 4: C four")
    assert missed_keys(broken, sections, _spans(broken, sections)) == [
        MissedKey(("kind_a", "kind_b"), "4", "Table 4: C four")
    ]


def test_listed_only_in_contents_is_missed() -> None:
    text = _body("Table 1: Study A - Results", "Table 2: Study A - Results")
    sections = [Section(id="t", anchor=ANCHOR, repeat=True, key=KEY)]
    spans = _spans(text, sections)
    keys = [m.key for m in missed_keys(text, sections, spans)]
    assert keys == ["3"]
    assert "5" not in keys


def test_unanchored_key_is_skipped() -> None:
    text = "Table 1: Results\nsee 12 and 13\nTable 2: Results\n"
    sections = [Section(id="t", anchor=r"^Table 1:", repeat=True, key=r"(\d+)")]
    assert missed_keys(text, sections, _spans(text, sections)) == []


def test_inline_flag_before_caret_still_counts_as_anchored() -> None:
    text = "table 1: x\ntable 2: x\n"
    sections = [Section(id="t", anchor=r"^table 1:", repeat=True, key=r"(?i)^table (\d+):")]
    assert [m.key for m in missed_keys(text, sections, _spans(text, sections))] == ["2"]


def test_keyfrom_only_and_unmatched_groups_report_nothing() -> None:
    text = "Table 1: Results\nTable 2: Results\n"
    sections = [
        Section(id="src", anchor=r"^Table \d+:", repeat=True, key=KEY),
        Section(id="follow", anchor=r"^NOPE", repeat=True, keyFrom="src"),
        Section(id="nothing", anchor=r"^ZZZ", repeat=True, key=r"^ZZZ (\d+)"),
    ]
    assert missed_keys(text, sections, _spans(text, sections)) == []
    # a group whose anchor matched nothing is reported elsewhere, even if its key pattern finds keys
    sections = [Section(id="t", anchor=r"^NOPE", repeat=True, key=KEY)]
    assert missed_keys(text, sections, _spans(text, sections)) == []


def test_line_is_cut_at_120_characters() -> None:
    text = "Table 2: ok\nTable 1: " + "x" * 300 + "\n"
    sections = [Section(id="t", anchor=r"^Table 2:", repeat=True, key=KEY)]
    found = missed_keys(text, sections, _spans(text, sections))
    assert [(m.key, len(m.line)) for m in found] == [("1", 120)]


def test_cap_constant() -> None:
    assert MAX_MISSED_KEYS == 20
