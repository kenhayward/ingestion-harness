"""The decomposed document from the pieces: sections, paragraphs, lists and tables, their ids,
the ledger renamed to those ids, provenance and flags."""

from __future__ import annotations

from typing import Any

from ingest_worker.decompose.model import (
    Block,
    DecomposedDocument,
    Flag,
    ListBlock,
    Paragraph,
    Section,
    Table,
    Text,
)
from ingest_worker.decompose.pdf.build import Provenance, build_document
from ingest_worker.decompose.pdf.layout import parse_docling
from ingest_worker.decompose.pdf.outline import assign_headings
from ingest_worker.decompose.pdf.pieces import Ledger, Piece, attach_text
from ingest_worker.decompose.pdf.tables import join_split_tables
from ingest_worker.decompose.pdf.textlayer import TextLayer, read_text_layer
from tests.decompose.pdf import docling
from tests.decompose.pdf.fakes import FakeCropper
from tests.decompose.pdf.make_pdf import Page, Run, make_pdf
from tests.decompose.pdf.test_pdf_tables import SECOND, cell_runs, grid, simple, split_pages

WIDTH, HEIGHT = 595.0, 842.0


def bl(x0: float, y0: float, x1: float, y1: float) -> docling.Box:
    return (x0, HEIGHT - y0, x1, HEIGHT - y1)


def item(label: str, page: int, y: float, x0: float = 60, x1: float = 400) -> dict[str, Any]:
    """A Docling item around one line whose baseline is `y`."""
    return docling.text(label, page, bl(x0, y - 12, x1, y + 4))


def build(
    pages: list[Page], items: list[dict[str, Any]], *, headings: bool = True
) -> tuple[list[Piece], TextLayer, Ledger, list[Flag]]:
    text = read_text_layer(make_pdf(pages))
    layout = parse_docling(docling.doc([(WIDTH, HEIGHT)] * len(pages), items))
    pieces, ledger = attach_text(layout, text)
    flags: list[Flag] = []
    if headings:
        pieces, flags = assign_headings(pieces, [], ledger)
    return pieces, text, ledger, flags


def document(
    pieces: list[Piece], text: TextLayer, ledger: Ledger, flags: list[Flag] | None = None
) -> tuple[DecomposedDocument, dict[str, bytes], Provenance]:
    return build_document(
        pieces, text=text, ledger=ledger, cropper=FakeCropper(), properties=[], flags=flags or []
    )


def plain(inlines: list[Any]) -> str:
    return "".join(i.text for i in inlines if isinstance(i, Text))


def texts(blocks: list[Block]) -> list[str]:
    return [plain(b.inlines) for b in blocks if isinstance(b, Paragraph)]


def tree(sections: list[Section]) -> list[tuple[str, str, list[Any]]]:
    return [(s.id, plain(s.title), tree(s.sections)) for s in sections]


def owners(ledger: Ledger, text: TextLayer) -> set[str]:
    return {o for page in text.pages for os in ledger.entries(page.index).values() for o in os}


def owner_of(ledger: Ledger, text: TextLayer, page: int, char: str) -> list[str]:
    c = next(c for c in text.pages[page].chars if c.text == char)
    return ledger.entries(page)[c.index]


# --- Sections --------------------------------------------------------------------------------


def test_sections_nest_by_level() -> None:
    runs = [
        Run("1 Introduction", 72, 100),
        Run("Opening words.", 72, 130),
        Run("1.1 Scope", 72, 160),
        Run("1.2 Terms", 72, 190),
        Run("2 Methods", 72, 220),
    ]
    items = [
        item("section_header", 1, 100),
        item("text", 1, 130),
        item("section_header", 1, 160),
        item("section_header", 1, 190),
        item("section_header", 1, 220),
    ]
    pieces, text, ledger, flags = build([Page(runs=runs)], items)
    doc, images, _ = document(pieces, text, ledger, flags)
    assert doc.blocks == []
    assert images == {}
    assert tree(doc.sections) == [
        (
            "s-1-introduction",
            "Introduction",
            [
                ("s-1-introduction/s-1-1-scope", "Scope", []),
                ("s-1-introduction/s-1-2-terms", "Terms", []),
            ],
        ),
        ("s-2-methods", "Methods", []),
    ]
    assert texts(doc.sections[0].blocks) == ["Opening words."]
    assert doc.sections[0].blocks[0].id == "s-1-introduction#p-1"
    # the heading's chars are the section's, its typed number dropped
    assert owner_of(ledger, text, 0, "I") == ["s-1-introduction"]
    assert owner_of(ledger, text, 0, "S") == ["s-1-introduction/s-1-1-scope"]
    assert owner_of(ledger, text, 0, "1") == ["dropped:heading-number"]


def test_skipped_level_is_flagged_and_leading_blocks_kept() -> None:
    runs = [Run("Before any heading", 72, 70), Run("1 Top", 72, 100), Run("1.1.1 Deep", 72, 130)]
    items = [item("text", 1, 70), item("section_header", 1, 100), item("section_header", 1, 130)]
    pieces, text, ledger, flags = build([Page(runs=runs)], items)
    doc, _, _ = document(pieces, text, ledger, flags)
    assert texts(doc.blocks) == ["Before any heading"]
    assert doc.blocks[0].id == "s~lead#p-1"
    assert tree(doc.sections) == [("s-1-top", "Top", [("s-1-top/s-1-1-1-deep", "Deep", [])])]
    assert [(f.code, f.at) for f in doc.report] == [
        ("heading_skipped_level", "s-1-top/s-1-1-1-deep")
    ]


def test_title_has_no_typed_number_and_no_bold() -> None:
    runs = [Run("2.1 Scope", 72, 100, font="Helvetica-Bold")]
    pieces, text, ledger, flags = build([Page(runs=runs)], [item("section_header", 1, 100)])
    doc, _, _ = document(pieces, text, ledger, flags)
    section = doc.sections[0]
    assert section.id == "s-2-1-scope"
    assert section.title == [Text(text="Scope")]


def test_inferred_heading_flag_points_at_its_section() -> None:
    runs = [Run("Background", 72, 100), Run("Some text", 72, 130)]
    items = [item("section_header", 1, 100), item("text", 1, 130)]
    pieces, text, ledger, flags = build([Page(runs=runs)], items)
    assert [f.at for f in flags] == [pieces[0].ref]
    doc, _, _ = document(pieces, text, ledger, flags)
    assert [(f.message, f.at) for f in doc.report] == [("Heading level inferred", "s-background")]


# --- Paragraphs ------------------------------------------------------------------------------


def test_paragraph_split_at_a_line_is_joined() -> None:
    runs = [Run("Analytical Method for the Drug", 72, 100), Run("Substance used", 72, 114)]
    items = [item("text", 1, 100), item("text", 1, 114)]
    pieces, text, ledger, _ = build([Page(runs=runs)], items)
    doc, _, prov = document(pieces, text, ledger)
    assert texts(doc.blocks) == ["Analytical Method for the Drug Substance used"]
    assert owner_of(ledger, text, 0, "A") == ["s~lead#p-1"]
    assert owner_of(ledger, text, 0, "S") == ["s~lead#p-1"]
    assert prov.pages == {"s~lead#p-1": {0}}


def test_paragraph_split_at_a_page_break_is_joined() -> None:
    pages = [
        Page(runs=[Run("Opening.", 72, 100), Run("The batch was released to the", 72, 760)]),
        Page(runs=[Run("market in May.", 72, 80), Run("Closing.", 72, 200)]),
    ]
    items = [item("text", 1, 100), item("text", 1, 760), item("text", 2, 80), item("text", 2, 200)]
    pieces, text, ledger, _ = build(pages, items)
    doc, _, prov = document(pieces, text, ledger)
    assert texts(doc.blocks) == [
        "Opening.",
        "The batch was released to the market in May.",
        "Closing.",
    ]
    assert prov.pages[doc.blocks[1].id] == {0, 1}


def test_gap_too_wide_is_not_joined() -> None:
    runs = [Run("A heading-like line", 72, 100), Run("and more text", 72, 160)]
    items = [item("text", 1, 100), item("text", 1, 160)]
    pieces, text, ledger, _ = build([Page(runs=runs)], items)
    doc, _, _ = document(pieces, text, ledger)
    assert texts(doc.blocks) == ["A heading-like line", "and more text"]


def test_sentence_end_is_not_joined() -> None:
    runs = [Run("The method was validated.", 72, 100), Run("Results follow here", 72, 114)]
    items = [item("text", 1, 100), item("text", 1, 114)]
    pieces, text, ledger, _ = build([Page(runs=runs)], items)
    doc, _, _ = document(pieces, text, ledger)
    assert texts(doc.blocks) == ["The method was validated.", "Results follow here"]
    assert [b.id for b in doc.blocks] == ["s~lead#p-1", "s~lead#p-2"]


def test_no_join_across_columns() -> None:
    runs = [Run("The left column ends with", 72, 700), Run("words of the right one", 320, 100)]
    items = [item("text", 1, 700, 60, 280), item("text", 1, 100, 310, 540)]
    pieces, text, ledger, _ = build([Page(runs=runs)], items)
    doc, _, _ = document(pieces, text, ledger)
    assert texts(doc.blocks) == ["The left column ends with", "words of the right one"]


# --- Lists -----------------------------------------------------------------------------------


def test_list_nesting_and_markers_dropped() -> None:
    runs = [
        Run("Items:", 72, 80),
        Run("• First", 72, 100),
        Run("• Nested", 90, 114),
        Run("• Second", 72, 128),
    ]
    items = [
        item("text", 1, 80),
        docling.group(
            [
                item("list_item", 1, 100, 70, 400),
                item("list_item", 1, 114, 88, 400),
                item("list_item", 1, 128, 70, 400),
            ]
        ),
    ]
    pieces, text, ledger, _ = build([Page(runs=runs)], items)
    doc, _, prov = document(pieces, text, ledger)
    assert texts(doc.blocks[:1]) == ["Items:"]
    outer = doc.blocks[1]
    assert isinstance(outer, ListBlock)
    assert outer.id == "s~lead#list-1"
    assert not outer.ordered
    assert len(outer.items) == 2
    first, second = outer.items
    assert texts(first.blocks) == ["First"]
    nested = first.blocks[1]
    assert isinstance(nested, ListBlock)
    assert [texts(i.blocks) for i in nested.items] == [["Nested"]]
    assert texts(second.blocks) == ["Second"]
    assert "•" not in doc.model_dump_json()
    bullets = [c for c in text.pages[0].chars if c.text == "•"]
    assert len(bullets) == 3
    for c in bullets:
        assert ledger.entries(0)[c.index] == ["dropped:list-marker"]
    assert owner_of(ledger, text, 0, "N") == ["s~lead#list-1"]
    assert prov.pages["s~lead#list-1"] == {0}


def test_ordered_list() -> None:
    runs = [Run("1. Weigh the sample", 72, 100), Run("2. Dissolve it", 72, 114)]
    items = [docling.group([item("list_item", 1, 100), item("list_item", 1, 114)])]
    pieces, text, ledger, _ = build([Page(runs=runs)], items)
    doc, _, _ = document(pieces, text, ledger)
    block = doc.blocks[0]
    assert isinstance(block, ListBlock)
    assert block.ordered
    assert [texts(i.blocks) for i in block.items] == [["Weigh the sample"], ["Dissolve it"]]
    assert owner_of(ledger, text, 0, "1") == ["dropped:list-marker"]
    assert owner_of(ledger, text, 0, ".") == ["dropped:list-marker"]


# --- Orphans, empty pieces -------------------------------------------------------------------


def test_orphan_is_flagged_at_its_block() -> None:
    runs = [Run("Known text.", 72, 100), Run("Missed by layout.", 72, 300)]
    pieces, text, ledger, _ = build([Page(runs=runs)], [item("text", 1, 100)])
    assert pieces[1].orphan
    doc, _, _ = document(pieces, text, ledger)
    assert texts(doc.blocks) == ["Known text.", "Missed by layout."]
    assert [(f.code, f.severity, f.at, f.message) for f in doc.report] == [
        ("structure_inferred", "warning", "s~lead#p-2", "Text the layout analysis missed")
    ]
    assert owner_of(ledger, text, 0, "M") == ["s~lead#p-2"]


def test_whitespace_piece_gives_its_chars_to_the_block_before() -> None:
    runs = [Run("Words.", 72, 100), Run("   ", 72, 300)]
    pieces, text, ledger, _ = build([Page(runs=runs)], [item("text", 1, 100)])
    assert [p.orphan for p in pieces] == [False, True]  # a blank orphan, owning a space
    doc, _, _ = document(pieces, text, ledger)
    assert texts(doc.blocks) == ["Words."]
    assert owners(ledger, text) == {"s~lead#p-1"}
    assert doc.report == []


# --- Tables ----------------------------------------------------------------------------------


def test_table_takes_its_caption_and_renames_to_its_id() -> None:
    texts_ = {(0, 0): "A", (0, 1): "B", (1, 0): "1", (1, 1): "2"}
    runs = [Run("Table 1: Doses", 72, 90), *cell_runs(texts_), Run("After it.", 72, 200)]
    items = [
        item("text", 1, 90),
        grid(1, simple(2, 2), rows=2, cols=2),
        item("text", 1, 200),
    ]
    pieces, text, ledger, _ = build([Page(runs=runs)], items)
    doc, _, prov = document(pieces, text, ledger)
    table = doc.blocks[0]
    assert isinstance(table, Table)
    assert table.id == "s~lead#table-1"
    assert plain(table.caption) == "Doses"
    assert texts(doc.blocks[1:]) == ["After it."]
    # the caption paragraph keeps its unused ordinal, as in the Word reader
    assert doc.blocks[1].id == "s~lead#p-2"
    assert owner_of(ledger, text, 0, "D") == ["s~lead#table-1"]
    assert owner_of(ledger, text, 0, "B") == ["s~lead#table-1"]
    assert prov.regions == {"s~lead#table-1": [(0, pieces[1].bbox)]}
    assert [(f.at, f.message) for f in doc.report] == [
        ("s~lead#table-1", "Table grid inferred from layout")
    ]


def test_joined_table_has_a_region_per_page() -> None:
    items = [
        item("text", 1, 80),
        grid(1, simple(2, 2), rows=2, cols=2, top=700),
        grid(2, simple(2, 2), rows=2, cols=2),
        item("text", 2, 300),
    ]
    pieces, text, ledger, _ = build(split_pages(SECOND), items)
    boxes = [(p.page, p.bbox) for p in pieces if p.table is not None]
    pieces = join_split_tables(pieces, text, ledger)
    doc, _, prov = document(pieces, text, ledger)
    table = doc.blocks[1]
    assert isinstance(table, Table)
    assert prov.regions[table.id] == boxes
    assert prov.pages[table.id] == {0, 1}
    assert owners(ledger, text) == {
        "s~lead#p-1",
        table.id,
        "s~lead#p-2",
        "dropped:repeated-header",
    }
