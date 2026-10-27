"""The Word/PDF twin scorer: headings, tables and words against the Word truth."""

from __future__ import annotations

import pytest

from ingest_worker.decompose.model import (
    Cell,
    DecomposedDocument,
    NoteRef,
    Paragraph,
    Row,
    Section,
    Table,
    TableNote,
    Text,
)
from ingest_worker.decompose.pdf.scoring import Score, score, total


def text(s: str) -> list:
    return [Text(text=s)]


def para(block_id: str, s: str) -> Paragraph:
    return Paragraph(id=block_id, inlines=text(s))


def section(sid: str, title: str, blocks: list | None = None, subs: list | None = None) -> Section:
    return Section(id=sid, title=text(title), blocks=blocks or [], sections=subs or [])


def table(tid: str, rows: list[list[str]], notes: list[TableNote] | None = None) -> Table:
    return Table(
        id=tid,
        column_widths=[1.0] * len(rows[0]),
        header_rows=1,
        rows=[
            Row(cells=[Cell(blocks=[para(f"{tid}-{r}-{c}", s)]) for c, s in enumerate(row)])
            for r, row in enumerate(rows)
        ],
        notes=notes or [],
    )


def doc(sections: list | None = None, blocks: list | None = None) -> DecomposedDocument:
    return DecomposedDocument(
        blocks=blocks or [],
        sections=sections or [],
        images=[],
        equations=[],
        notes=[],
        properties=[],
        report=[],
    )


def sample() -> DecomposedDocument:
    return doc(
        [
            section(
                "s1",
                "Scope",
                [
                    para("p1", "The scope of this plan."),
                    table("t1", [["Id", "Name"], ["1", "Alpha"]]),
                ],
                [section("s2", "Method", [para("p2", "How it is done.")])],
            )
        ]
    )


def test_identical_documents_score_full() -> None:
    s = score(sample(), sample())
    assert (s.headings_total, s.headings_found, s.levels_right) == (2, 2, 2)
    assert (s.tables_total, s.tables_found, s.shape_right) == (1, 1, 1)
    assert (s.cells_total, s.cells_right) == (4, 4)
    assert s.words_recall == 1.0
    assert s.words_precision == 1.0


def test_missing_heading_and_wrong_level_count() -> None:
    pdf = doc(
        [
            section("s1", "Scope", [para("p1", "The scope of this plan.")]),
            section("s2", "Method", [para("p2", "How it is done.")]),
            section("s3", "Extra heading"),
        ]
    )
    s = score(sample(), pdf)
    assert s.headings_total == 2
    assert s.headings_found == 2  # "Method" is found, but one level too high
    assert s.levels_right == 1
    dropped = score(sample(), doc([section("s1", "Scope")]))
    assert (dropped.headings_found, dropped.levels_right) == (1, 1)


def test_heading_keys_ignore_case_and_whitespace() -> None:
    pdf = doc([section("a", "S c o p e", subs=[section("b", "METHOD")])])
    assert score(sample(), pdf).headings_found == 2


def test_table_shape_and_cells() -> None:
    pdf = doc(
        [
            section(
                "s1",
                "Scope",
                [table("x", [["Id", "Name", "Extra"], ["1", "Alpha", ""], ["2", "Beta", ""]])],
            )
        ]
    )
    s = score(sample(), pdf)
    assert (s.tables_total, s.tables_found, s.shape_right) == (1, 1, 0)
    assert (s.cells_total, s.cells_right) == (4, 4)
    wrong = doc([section("s1", "Scope", [table("x", [["Id", "Name"], ["1", "Alfa"], ["9", "Z"]])])])
    s = score(sample(), wrong)
    assert (s.tables_found, s.shape_right) == (1, 0)
    assert (s.cells_total, s.cells_right) == (4, 3)
    unrelated = doc([section("s1", "Scope", [table("x", [["q", "r"], ["s", "t"]])])])
    s = score(sample(), unrelated)
    assert (s.tables_total, s.tables_found, s.cells_right) == (1, 0, 0)


def test_trailing_note_row_in_truth_is_not_a_missing_row() -> None:
    truth = doc(
        [
            section(
                "s1",
                "T",
                [table("t", [["Id", "Name"], ["1", "Alpha"], ["a. Source: survey", ""]])],
            )
        ]
    )
    pdf = doc(
        [
            section(
                "s1",
                "T",
                [
                    table(
                        "t",
                        [["Id", "Name"], ["1", "Alpha"]],
                        [TableNote(marker="a", inlines=text("Source: survey"))],
                    )
                ],
            )
        ]
    )
    s = score(truth, pdf)
    assert s.shape_right == 1
    assert (s.cells_total, s.cells_right) == (4, 4)


def test_text_form_tokens_are_not_words() -> None:
    truth = doc(blocks=[para("p", "alpha beta")])
    pdf = doc(blocks=[para("p", "alpha"), para("q", "gamma")])
    s = score(truth, pdf)
    assert s.words_recall == pytest.approx(0.5)
    assert s.words_precision == pytest.approx(0.5)


def test_total_weights_words() -> None:
    a = Score(2, 2, 1, 1, 1, 1, 4, 4, 1.0, 1.0, words_total=30)
    b = Score(1, 0, 0, 2, 1, 0, 6, 3, 0.5, 0.25, words_total=10)
    t = total([a, b])
    assert (t.headings_total, t.headings_found, t.levels_right) == (3, 2, 1)
    assert (t.tables_total, t.tables_found, t.shape_right) == (3, 2, 1)
    assert (t.cells_total, t.cells_right) == (10, 7)
    assert t.words_recall == pytest.approx((30 * 1.0 + 10 * 0.5) / 40)
    assert t.words_precision == pytest.approx((30 * 1.0 + 10 * 0.25) / 40)
    assert t.words_total == 40


def test_tokens_in_a_title_do_not_hide_the_heading() -> None:
    truth = doc([section("a", "Results")])
    truth.sections[0].title.append(NoteRef(note_id="n-word"))
    pdf = doc([section("b", "Results")])
    pdf.sections[0].title.append(NoteRef(note_id="n-pdf"))
    assert score(truth, pdf).headings_found == 1


def test_ligatures_and_untitled_sections() -> None:
    s = score(doc([section("a", "Ofﬁce"), section("b", "")]), doc([section("c", "Office")]))
    assert (s.headings_total, s.headings_found) == (1, 1)
    both = score(doc([section("a", "")]), doc([section("b", "")]))
    assert (both.headings_total, both.headings_found) == (0, 0)


def test_blank_cells_do_not_pair_tables() -> None:
    blank = [["", "", ""], ["", "", ""], ["x", "", ""]]
    other = [["", "", ""], ["", "", ""], ["y", "", ""]]
    truth = doc([section("s", "T", [table("a", blank)])])
    pdf = doc([section("s", "T", [table("b", other)])])
    s = score(truth, pdf)
    assert (s.tables_found, s.tables_extra) == (0, 1)


def test_undefined_rates_are_none() -> None:
    assert total([]).words_recall is None
    assert total([]).words_precision is None
    s = score(doc(blocks=[para("p", "alpha")]), doc())
    assert s.words_recall == 0.0
    assert s.words_precision is None
    assert score(doc(), doc(blocks=[para("p", "alpha")])).words_recall is None


def test_full_width_note_row_without_separator_is_stripped() -> None:
    note = Table(
        id="t",
        column_widths=[1.0, 1.0],
        header_rows=1,
        rows=[
            Row(cells=[Cell(blocks=[para("h1", "Id")]), Cell(blocks=[para("h2", "Name")])]),
            Row(cells=[Cell(blocks=[para("d1", "1")]), Cell(blocks=[para("d2", "Alpha")])]),
            Row(cells=[Cell(col_span=2, blocks=[para("n", "a Light source: lamp")])]),
        ],
    )
    truth = doc([section("s", "T", [note])])
    pdf = doc([section("s", "T", [table("p", [["Id", "Name"], ["1", "Alpha"]])])])
    s = score(truth, pdf)
    assert (s.tables_found, s.shape_right) == (1, 1)
    assert (s.cells_total, s.cells_right) == (4, 4)


def test_data_row_starting_with_a_letter_is_not_stripped() -> None:
    truth = doc([section("s", "T", [table("t", [["Id", "Name"], ["1", "Alpha"], ["a b", "Zed"]])])])
    pdf = doc([section("s", "T", [table("p", [["Id", "Name"], ["1", "Alpha"]])])])
    s = score(truth, pdf)
    assert (s.tables_found, s.shape_right) == (1, 0)
    assert s.cells_total == 6
