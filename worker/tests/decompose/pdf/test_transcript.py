"""The OCR model's page markdown parsed into blocks (spec section 15.3)."""

from __future__ import annotations

from ingest_worker.decompose.pdf.transcript import (
    TxBlock,
    TxEquation,
    TxFigure,
    TxHeading,
    TxListItem,
    TxParagraph,
    TxTable,
    parse_transcript,
)


def _text(block: TxBlock) -> str:
    assert isinstance(block, TxHeading | TxParagraph | TxListItem)
    return "".join(run[0] for run in block.runs)


def test_headings_paragraphs_lists() -> None:
    blocks = parse_transcript("# A\n\nText **bold** *it*.\n\n- one\n  - two\n1. three")
    assert [type(b) for b in blocks] == [TxHeading, TxParagraph, TxListItem, TxListItem, TxListItem]
    heading = blocks[0]
    assert isinstance(heading, TxHeading) and heading.level == 1 and _text(heading) == "A"
    para = blocks[1]
    assert isinstance(para, TxParagraph)
    assert _text(para) == "Text bold it."
    assert ("bold", frozenset({"bold"}), None) in para.runs
    assert ("it", frozenset({"italic"}), None) in para.runs
    items = [b for b in blocks if isinstance(b, TxListItem)]
    assert [(i.depth, i.marker, _text(i)) for i in items] == [
        (0, "-", "one"),
        (1, "-", "two"),
        (0, "1.", "three"),
    ]


def test_paragraph_lines_join() -> None:
    blocks = parse_transcript("first line\nsecond line\n\nnext")
    assert [_text(b) for b in blocks] == ["first line second line", "next"]


def test_front_matter_is_dropped() -> None:
    body = "# A\n\nText."
    raw = "---\nprimary_language: en\nis_rotation_valid: true\n---\n" + body
    assert parse_transcript(raw) == parse_transcript(body)


def test_table_spans_and_headers() -> None:
    blocks = parse_transcript(
        '<table><tr><th colspan="2">H</th></tr>'
        '<tr><td rowspan="2">a</td><td>b<br>c</td></tr><tr><td>d</td></tr></table>'
    )
    (table,) = blocks
    assert isinstance(table, TxTable)
    assert (table.rows, table.cols) == (3, 2)
    cells = {(c.row, c.col): c for c in table.cells}
    head = cells[(0, 0)]
    assert head.header and head.col_span == 2
    assert cells[(1, 0)].row_span == 2 and not cells[(1, 0)].header
    assert ["".join(r[0] for r in line) for line in cells[(1, 1)].lines] == ["b", "c"]
    assert "".join(r[0] for r in cells[(2, 1)].lines[0]) == "d"


def test_table_without_th_has_no_header() -> None:
    (table,) = parse_transcript(
        "<table><tr><td>a</td><td>b</td></tr><tr><td>c</td><td>d</td></tr></table>"
    )
    assert isinstance(table, TxTable)
    assert not any(c.header for c in table.cells)


def test_ragged_table_is_rectangular() -> None:
    (table,) = parse_transcript(
        "<table><tr><td>a<td>b</tr><tr><td>c</td><td>d</td><td>e</td></tr>"
        '<tr><td colspan="9">f</td></tr></table>'
    )
    assert isinstance(table, TxTable)
    covered: dict[tuple[int, int], int] = {}
    for c in table.cells:
        assert c.row + c.row_span <= table.rows and c.col + c.col_span <= table.cols
        for r in range(c.row, c.row + c.row_span):
            for k in range(c.col, c.col + c.col_span):
                covered[(r, k)] = covered.get((r, k), 0) + 1
    assert set(covered) == {(r, k) for r in range(table.rows) for k in range(table.cols)}
    assert set(covered.values()) == {1}


def test_text_around_a_table() -> None:
    blocks = parse_transcript("Table 3: Limits\n\n<table><tr><td>a</td></tr></table>\nAfter.")
    assert [type(b) for b in blocks] == [TxParagraph, TxTable, TxParagraph]


def test_display_and_inline_equations() -> None:
    assert parse_transcript("$$x^2$$") == [TxEquation("x^2")]
    assert parse_transcript("\\[x^2\\]") == [TxEquation("x^2")]
    assert parse_transcript("$$\nx^2 +\ny\n$$") == [TxEquation("x^2 +\ny")]
    (para,) = parse_transcript("so $a_1$ holds")
    assert _text(para) == "so $a_1$ holds"


def test_dollars_are_not_equations() -> None:
    (para,) = parse_transcript("costs $5 and $10 &amp; tax")
    assert _text(para) == "costs $5 and $10 & tax"


def test_figure_placeholder() -> None:
    assert parse_transcript("![A pump](page_10_20_300_200.png)") == [
        TxFigure("A pump", (10.0, 20.0, 310.0, 220.0))
    ]
    assert parse_transcript("![A pump](figure.png)") == [TxFigure("A pump", None)]


def test_sup_sub_and_links() -> None:
    (para,) = parse_transcript("m<sup>2</sup> H<sub>2</sub>O [site](https://x.example)")
    assert isinstance(para, TxParagraph)
    assert ("2", frozenset({"superscript"}), None) in para.runs
    assert ("2", frozenset({"subscript"}), None) in para.runs
    assert ("site", frozenset(), "https://x.example") in para.runs
    assert _text(para) == "m2 H2O site"


def test_empty_markdown() -> None:
    assert parse_transcript("") == []
    assert parse_transcript("---\nprimary_language: null\n---\n") == []


def test_display_closer_with_a_tail() -> None:
    assert parse_transcript(r"\[ E = mc^2 \] (1)") == [TxEquation("E = mc^2")]
    assert parse_transcript(r"\[x\],") == [TxEquation("x")]


def test_a_reference_line_is_not_an_equation() -> None:
    blocks = parse_transcript("\\[1\\] Smith wrote.\n\n# Results\n\nBody.")
    assert [type(b) for b in blocks] == [TxParagraph, TxHeading, TxParagraph]
    assert _text(blocks[0]) == "[1] Smith wrote."


def test_an_unclosed_opener_is_text() -> None:
    blocks = parse_transcript("$$ x +\n\n# Results\n\nBody.")
    assert [type(b) for b in blocks] == [TxParagraph, TxHeading, TxParagraph]
    assert _text(blocks[0]) == "$$ x +"


def test_spans_set_the_width() -> None:
    (table,) = parse_transcript(
        '<table><tr><td rowspan="2">a</td><td colspan="2">b</td></tr>'
        "<tr><td>c</td><td>d</td></tr></table>"
    )
    assert isinstance(table, TxTable)
    assert (table.rows, table.cols) == (2, 3)
    cells = {(c.row, c.col): c for c in table.cells}
    assert cells[(0, 1)].col_span == 2
    assert "".join(r[0] for r in cells[(1, 1)].lines[0]) == "c"
    assert "".join(r[0] for r in cells[(1, 2)].lines[0]) == "d"


def test_numbered_plain_lines_are_headings() -> None:
    """olmOCR writes headings as plain lines, numbered as typed (spec 15.3)."""
    blocks = parse_transcript(
        "3.2. Pump performance\nThe pump delivers a steady flow.\n\n4 Results\n\nAll passed."
    )
    assert [type(b) for b in blocks] == [TxHeading, TxParagraph, TxHeading, TxParagraph]
    first, _, second, _ = blocks
    assert isinstance(first, TxHeading) and first.typed and first.level == 2
    assert _text(first) == "3.2. Pump performance"
    assert isinstance(second, TxHeading) and second.level == 1


def test_a_lone_numbered_item_is_a_heading() -> None:
    blocks = parse_transcript("1. Introduction\n\nThis report covers it.")
    assert [type(b) for b in blocks] == [TxHeading, TxParagraph]


def test_numbered_lists_and_sentences_stay() -> None:
    blocks = parse_transcript(
        "1. Weigh the sample\n2. Dissolve it\n\n3.5 mg was added to the flask."
    )
    assert [type(b) for b in blocks] == [TxListItem, TxListItem, TxParagraph]
    long = "2.1 " + " ".join(["word"] * 20)
    assert [type(b) for b in parse_transcript(long)] == [TxParagraph]
    assert [type(b) for b in parse_transcript("12 samples were tested.")] == [TxParagraph]


def test_contents_lines_stay_lines() -> None:
    """A contents entry (a dot leader, then a page number) is a block of its own, never a
    heading, so the reader's contents rule can see it (spec 4.3, 15.3)."""
    blocks = parse_transcript(
        "CONTENTS\nSUMMARY ........................ 5\n"
        "3.2 Pump performance ........................ 12\nRESULTS . . . . . . 14"
    )
    assert [type(b) for b in blocks] == [TxParagraph] * 4
    assert [_text(b) for b in blocks][1] == "SUMMARY ........................ 5"


def test_simple_inline_math_becomes_text() -> None:
    (para,) = parse_transcript(
        r"Assay \( \geq 98\% \), pH \( 7.0 \pm 0.2 \) at \(25^\circ\)C and $x^2$"
    )
    assert _text(para) == r"Assay ≥ 98%, pH 7.0 ± 0.2 at 25°C and $x^2$"
