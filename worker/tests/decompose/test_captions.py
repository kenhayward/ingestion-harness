"""Table and figure captions, table notes, and the wide hint of landscape tables."""

from __future__ import annotations

from xml.etree.ElementTree import Element

import pytest

from ingest_worker.decompose.body import adjacent_caption, walk_body
from ingest_worker.decompose.inline import FieldState, InlineContext, RunStyles, W, plain_text
from ingest_worker.decompose.model import Block, Cell, ImageBlock, Paragraph, Table, Text
from ingest_worker.decompose.package import open_package
from ingest_worker.decompose.tables import caption_parts, source_grid, structural_rows
from tests.decompose.docx import DEFAULT_STYLES, build_docx
from tests.decompose.test_tables import para, tbl, tc, tr

# --- Builders --------------------------------------------------------------------------------

SEQ_TABLE_13 = (
    '<w:p><w:r><w:t xml:space="preserve">Table </w:t></w:r>'
    '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
    '<w:r><w:instrText xml:space="preserve"> SEQ Table \\* ARABIC </w:instrText></w:r>'
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
    "<w:r><w:t>13</w:t></w:r>"
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
    '<w:r><w:t xml:space="preserve">: Dissolution</w:t></w:r></w:p>'
)


def sup(text: str) -> str:
    return f'<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>{text}</w:t></w:r>'


def cell_with(*runs: str) -> str:
    return f"<w:tc><w:tcPr/><w:p>{''.join(runs)}</w:p></w:tc>"


def run(text: str) -> str:
    return f'<w:r><w:t xml:space="preserve">{text}</w:t></w:r>'


def caption_p(text: str) -> str:
    return f'<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr>{run(text)}</w:p>'


def section_break(w: int, h: int, orient: str | None = None) -> str:
    attr = f' w:orient="{orient}"' if orient else ""
    return f'<w:sectPr><w:pgSz w:w="{w}" w:h="{h}"{attr}/></w:sectPr>'


def read(body: str, sect_pr: str | None = None) -> tuple[list[Block], InlineContext, list[Element]]:
    pkg = open_package(build_docx(body, styles=DEFAULT_STYLES, sect_pr=sect_pr))
    ctx = InlineContext(styles=RunStyles.from_xml(pkg.xml("word/styles.xml")))
    blocks, _ = walk_body(pkg, ctx)
    document = pkg.xml("word/document.xml")
    assert document is not None
    return blocks, ctx, document.findall(f"{W}body/{W}tbl")


def tables(blocks: list[Block]) -> list[Table]:
    return [b for b in blocks if isinstance(b, Table)]


def cell_text(cell: Cell) -> str:
    return "\n".join(plain_text(b.inlines) for b in cell.blocks if isinstance(b, Paragraph))


def grid(t: Table) -> list[list[str]]:
    return [[cell_text(c) for c in row.cells] for row in t.rows]


def flags(ctx: InlineContext) -> list[tuple[str, str, str | None]]:
    return [(f.code, f.severity, f.at) for f in ctx.flags]


DATA = (tr(tc("A"), tc("B")), tr(tc("1"), tc("2")))


# --- Caption rows ----------------------------------------------------------------------------


@pytest.mark.parametrize(
    "caption_row",
    [tr(tc("Table 13: Dissolution", span=2)), tr(tc(span=2, content=SEQ_TABLE_13))],
    ids=["typed", "seq-field"],
)
def test_merged_first_row_caption(caption_row: str) -> None:
    blocks, ctx, (el,) = read(tbl(caption_row, *DATA, cols=[100, 100]))
    (t,) = tables(blocks)
    assert t.caption == [Text(text="Dissolution")]
    assert t.numbered and t.caption_position == "above"
    assert grid(t) == [["A", "B"], ["1", "2"]]
    assert t.key == "dissolution"
    assert ctx.caption_number_map == {("table", "13"): t.id}
    assert ctx.flags == []
    assert structural_rows(el, ctx.styles).caption == 0


def test_caption_row_is_never_a_header_row() -> None:
    body = tbl(
        tr(tc("Table 2: Assay", span=2), header=True),
        tr(tc("A"), tc("B"), header=True),
        tr(tc("1"), tc("2")),
        cols=[100, 100],
    )
    (t,) = tables(read(body)[0])
    assert t.header_rows == 1
    assert [c.header for c in t.rows[0].cells] == [True, True]
    assert [c.header for c in t.rows[1].cells] == [False, False]


def test_full_width_first_row_without_prefix_stays_data() -> None:
    blocks, ctx, _ = read(tbl(tr(tc("Batch summary", span=2)), *DATA, cols=[100, 100]))
    (t,) = tables(blocks)
    assert grid(t)[0] == ["Batch summary"]
    assert t.caption == [] and not t.numbered and t.key is None
    assert flags(ctx) == [("caption_not_found", "info", t.id)]


# --- Caption paragraphs ----------------------------------------------------------------------


def test_caption_paragraph_after_figure_is_below() -> None:
    # Figures arrive with Task 7; the pairing rule is tested on a placeholder image block.
    caption = caption_parts([Text(text="Figure 1- Container Closure")], [])
    assert caption.inlines == [Text(text="Container Closure")]
    assert caption.numbered and (caption.kind, caption.number) == ("figure", "1")
    blocks: list[Block] = [
        Paragraph(id="s#p-1", inlines=[Text(text="Before.")]),
        ImageBlock(id="s#image-1", image_id="img-1"),
        Paragraph(id="s#p-2", inlines=[Text(text="Figure 1- Container Closure")]),
    ]
    assert adjacent_caption(blocks, 1, {"s#p-2": caption}, "figure", set()) == (2, "below")


def test_seq_field_number_removed_after_another_label() -> None:
    seq = FieldState(" SEQ Table \\* ARABIC ", in_result=True, result="4")
    caption = caption_parts([Text(text="Tabelle 4: Gehalt")], [seq])
    assert caption.inlines == [Text(text="Gehalt")]
    assert (caption.kind, caption.number, caption.numbered) == ("table", "4", True)


@pytest.mark.parametrize(
    ("before", "after", "position"),
    [(caption_p("Table 2: Assay"), "", "above"), ("", caption_p("Table 2: Assay"), "below")],
)
def test_caption_paragraph_next_to_table(before: str, after: str, position: str) -> None:
    body = before + tbl(*DATA, cols=[100, 100]) + after + para("After.")
    blocks, ctx, _ = read(body)
    t = tables(blocks)[0]
    assert t.caption == [Text(text="Assay")] and t.numbered
    assert t.caption_position == position and t.key == "assay"
    assert [plain_text(b.inlines) for b in blocks if isinstance(b, Paragraph)] == ["After."]
    assert ctx.caption_number_map == {("table", "2"): t.id}
    assert ctx.flags == []


def test_unnumbered_caption_style_paragraph() -> None:
    blocks, _, _ = read(caption_p("Batch summary") + tbl(*DATA, cols=[100, 100]))
    (t,) = tables(blocks)
    assert t.caption == [Text(text="Batch summary")] and not t.numbered


def test_seq_field_paragraph_is_a_caption_without_the_style() -> None:
    blocks, ctx, _ = read(SEQ_TABLE_13 + tbl(*DATA, cols=[100, 100]))
    (t,) = tables(blocks)
    assert t.caption == [Text(text="Dissolution")] and t.numbered
    assert ctx.caption_number_map == {("table", "13"): t.id}


def test_plain_paragraph_is_not_a_caption() -> None:
    blocks, _, _ = read(para("Table 2: Assay") + tbl(*DATA, cols=[100, 100]))
    assert isinstance(blocks[0], Paragraph)
    assert tables(blocks)[0].caption == []


def test_caption_between_two_tables_goes_to_the_next() -> None:
    body = tbl(*DATA, cols=[100, 100]) + caption_p("Table 2: Assay") + tbl(*DATA, cols=[100, 100])
    blocks, ctx, _ = read(body)
    first, second = tables(blocks)
    assert len(blocks) == 2
    assert first.caption == [] and second.caption == [Text(text="Assay")]
    assert second.caption_position == "above"
    assert flags(ctx) == [("caption_not_found", "info", first.id)]


def test_figure_caption_is_not_taken_by_a_table() -> None:
    blocks, ctx, _ = read(tbl(*DATA, cols=[100, 100]) + caption_p("Figure 3: Process"))
    (t,) = tables(blocks)
    assert t.caption == []
    assert isinstance(blocks[1], Paragraph)
    assert flags(ctx) == [("caption_not_found", "info", t.id)]


def test_a_figure_caption_directly_above_a_table_titles_it() -> None:
    """A figure laid out as a table (a flow chart of cells)."""
    blocks, ctx, _ = read(caption_p("Figure 2: Methodology") + tbl(*DATA, cols=[100, 100]))
    assert len(blocks) == 1
    (t,) = tables(blocks)
    assert (t.caption, t.caption_position) == ([Text(text="Methodology")], "above")
    assert flags(ctx) == []
    assert ctx.caption_number_map == {("figure", "2"): t.id}


def test_a_table_caption_wins_over_a_figure_caption_further_up() -> None:
    body = caption_p("Figure 2: Chart") + caption_p("Table 4: Assay") + tbl(*DATA, cols=[100, 100])
    blocks, _, _ = read(body)
    (t,) = tables(blocks)
    assert t.caption == [Text(text="Assay")]
    assert isinstance(blocks[0], Paragraph)


def test_table_with_a_caption_row_leaves_the_paragraph() -> None:
    body = tbl(tr(tc("Table 1: Assay", span=2)), *DATA, cols=[100, 100]) + caption_p("Note text")
    blocks, _, _ = read(body)
    assert tables(blocks)[0].caption == [Text(text="Assay")]
    assert isinstance(blocks[1], Paragraph)


# --- Notes -----------------------------------------------------------------------------------


def test_note_rows_attached_by_marker() -> None:
    body = tbl(
        tr(tc("Table 13: Dissolution", span=2)),
        tr(tc("Time"), cell_with(run("Release"), sup("a"))),
        tr(tc("30"), cell_with(run("85"), sup("b"))),
        tr(tc("a: Samples at infinity", span=2)),
        tr(tc("b. Mean of six", span=2)),
        cols=[100, 100],
    )
    blocks, ctx, (el,) = read(body)
    (t,) = tables(blocks)
    assert grid(t) == [["Time", "Releasea"], ["30", "85b"]]
    assert [(n.marker, n.inlines) for n in t.notes] == [
        ("a", [Text(text="Samples at infinity")]),
        ("b", [Text(text="Mean of six")]),
    ]
    assert ctx.flags == []
    rows = structural_rows(el, ctx.styles)
    assert (rows.caption, rows.notes, rows.unrecognised) == (0, (3, 4), ())
    assert len(source_grid(el)) == 5  # the source grid stays the raw grid


def test_note_in_following_one_cell_table() -> None:
    notes = tbl(tr(tc(content=para("a: Samples at infinity") + para("b) Mean"))), cols=[200])
    body = (
        tbl(tr(cell_with(run("Release"), sup("a")), cell_with(run("85"), sup("b"))), cols=[1, 1])
        + notes
        + para("After.")
    )
    blocks, ctx, _ = read(body)
    (t,) = tables(blocks)
    assert [(n.marker, plain_text(n.inlines)) for n in t.notes] == [
        ("a", "Samples at infinity"),
        ("b", "Mean"),
    ]
    assert len(blocks) == 2
    assert flags(ctx) == [("caption_not_found", "info", t.id)]


def test_unmatched_note_row_stays_and_flags() -> None:
    body = tbl(
        tr(tc("Time"), cell_with(run("Release"), sup("a"))),
        tr(tc("a: Samples at infinity", span=2)),
        tr(tc("b: Not referenced", span=2)),
        cols=[100, 100],
    )
    blocks, ctx, (el,) = read(body)
    (t,) = tables(blocks)
    assert grid(t) == [["Time", "Releasea"], ["b: Not referenced"]]
    assert [n.marker for n in t.notes] == ["a"]
    assert ("table_notes_unrecognised", "warning", t.id) in flags(ctx)
    rows = structural_rows(el, ctx.styles)
    assert (rows.caption, rows.notes, rows.unrecognised) == (None, (1,), (2,))


def test_following_table_with_unreferenced_notes_stays_and_flags() -> None:
    body = tbl(tr(tc("Release"), tc("85")), cols=[1, 1]) + tbl(
        tr(tc("a: Samples at infinity")), cols=[200]
    )
    blocks, ctx, _ = read(body)
    first, second = tables(blocks)
    assert first.notes == [] and grid(second) == [["a: Samples at infinity"]]
    assert ("table_notes_unrecognised", "warning", first.id) in flags(ctx)


def test_marker_in_plain_text_does_not_count() -> None:
    body = tbl(tr(tc("Release a"), tc("85")), tr(tc("a: Note", span=2)), cols=[1, 1])
    blocks, ctx, _ = read(body)
    (t,) = tables(blocks)
    assert t.notes == [] and grid(t)[-1] == ["a: Note"]
    assert ("table_notes_unrecognised", "warning", t.id) in flags(ctx)


# --- Wide ------------------------------------------------------------------------------------


def test_landscape_section_marks_wide() -> None:
    landscape = f"<w:p><w:pPr>{section_break(16838, 11906, 'landscape')}</w:pPr></w:p>"
    wider = f"<w:p><w:pPr>{section_break(16838, 11906)}</w:pPr></w:p>"
    body = (
        tbl(*DATA, cols=[1, 1])
        + landscape
        + tbl(*DATA, cols=[1, 1])
        + wider
        + tbl(*DATA, cols=[1, 1])
    )
    blocks, _, _ = read(body, sect_pr=section_break(11906, 16838))
    # landscape by orientation, landscape by shape, then the portrait final section
    assert [t.wide for t in tables(blocks)] == [True, True, False]


def test_nested_table_inherits_wide() -> None:
    inner = tbl(*DATA, cols=[1, 1])
    body = tbl(tr(tc(content=inner + para(""))), cols=[1])
    blocks, _, _ = read(body, sect_pr=section_break(16838, 11906, "landscape"))
    (outer,) = tables(blocks)
    nested = outer.rows[0].cells[0].blocks[0]
    assert outer.wide and isinstance(nested, Table) and nested.wide


# --- Flags -----------------------------------------------------------------------------------

UNMAPPED = '<w:r><w:sym w:font="Wingdings" w:char="F001"/></w:r>'


def test_nested_table_without_caption_is_not_flagged() -> None:
    inner = tbl(*DATA, cols=[1, 1])
    body = tbl(tr(tc("Table 1: Outer")), tr(tc(content=inner + para(""))), cols=[1])
    blocks, ctx, _ = read(body)
    (outer,) = tables(blocks)
    assert isinstance(outer.rows[0].cells[0].blocks[0], Table)
    assert ctx.flags == []


def test_flags_on_attached_caption_point_at_the_table() -> None:
    caption = (
        f'<w:p><w:pPr><w:pStyle w:val="Caption"/></w:pPr>{run("Table 2: Assay ")}{UNMAPPED}</w:p>'
    )
    blocks, ctx, _ = read(caption + tbl(*DATA, cols=[100, 100]))
    (t,) = tables(blocks)
    assert t.caption_position == "above"
    assert flags(ctx) == [("symbol_unmapped", "warning", t.id)]


def test_flags_in_attached_notes_table_point_at_the_table() -> None:
    notes = tbl(tr(cell_with(run("a: Samples "), UNMAPPED)), cols=[200])
    body = tbl(tr(tc("Table 1: Release", span=2)), tr(tc("x"), cell_with(sup("a"))), cols=[1, 1])
    blocks, ctx, _ = read(body + notes)
    (t,) = tables(blocks)
    assert [n.marker for n in t.notes] == ["a"]
    assert flags(ctx) == [("symbol_unmapped", "warning", t.id)]


# --- Multi-part caption numbers --------------------------------------------------------------


@pytest.mark.parametrize(
    ("typed", "rest", "kind", "number"),
    [
        ("Table 3-1: Alpha", "Alpha", "table", "3-1"),
        ("Table 14.2.1 Beta", "Beta", "table", "14.2.1"),
        ("Table A.1: Gamma", "Gamma", "table", "A.1"),
        ("Table A1 Delta", "Delta", "table", "A1"),
        ("Figure 2\u20133: Epsilon", "Epsilon", "figure", "2-3"),
        ("Figure 1- Container Closure", "Container Closure", "figure", "1"),
    ],
)
def test_multi_part_caption_number_is_removed_whole(
    typed: str, rest: str, kind: str, number: str
) -> None:
    caption = caption_parts([Text(text=typed)], [])
    assert caption.inlines == [Text(text=rest)]
    assert (caption.kind, caption.number, caption.numbered) == (kind, number, True)


def test_multi_part_caption_numbers_register_each_table() -> None:
    body = (
        caption_p("Table 3-1: Alpha")
        + tbl(*DATA, cols=[100, 100])
        + para("Between.")
        + caption_p("Table 3-2: Beta")
        + tbl(*DATA, cols=[100, 100])
    )
    blocks, ctx, _ = read(body)
    first, second = tables(blocks)
    assert first.caption == [Text(text="Alpha")] and second.caption == [Text(text="Beta")]
    assert ctx.caption_number_map == {("table", "3-1"): first.id, ("table", "3-2"): second.id}
