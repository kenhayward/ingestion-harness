"""Page furniture and contents dropped from the pieces, under guards."""

from __future__ import annotations

from typing import Any

from ingest_worker.decompose.model import Property
from ingest_worker.decompose.pdf.furniture import Dropped, drop_furniture, dropped_flag
from ingest_worker.decompose.pdf.layout import parse_docling
from ingest_worker.decompose.pdf.pieces import Piece, attach_text
from ingest_worker.decompose.pdf.textlayer import read_text_layer
from tests.decompose.pdf import docling
from tests.decompose.pdf.make_pdf import Img, Page, Run, make_pdf

HEIGHT = 842.0
TOP = 40.0
FOOT = 800.0
#: Blank pages, so that a contents list's page numbers are inside the document.
PADDING = [Page() for _ in range(19)]


def bl(x0: float, y0: float, x1: float, y1: float) -> docling.Box:
    return (x0, HEIGHT - y0, x1, HEIGHT - y1)


def build(pages: list[Page], items: list[dict[str, Any]] | None = None):
    text = read_text_layer(make_pdf(pages))
    layout = parse_docling(docling.doc([(595, HEIGHT)] * len(pages), items or []))
    pieces, ledger = attach_text(layout, text)
    return pieces, text, ledger


def texts(pieces: list[Piece]) -> list[str]:
    return [line.text for p in pieces for line in p.lines]


def test_repeated_footer_is_dropped() -> None:
    pages = [Page(runs=[Run("Body", 72, 300), Run(f"Page {n}", 280, FOOT)]) for n in range(1, 5)]
    pieces, text, ledger = build(pages)
    kept, dropped, props = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["Body"] * 4
    assert dropped.furniture == {0: 1, 1: 1, 2: 1, 3: 1}
    assert dropped.contents_pages == ()
    assert props == []
    footer = next(c for c in text.pages[0].chars if c.text == "P")
    assert ledger.entries(0)[footer.index] == ["dropped:furniture"]


def test_furniture_label_in_the_body_is_kept() -> None:
    pages = [Page(runs=[Run("Looks like a header", 72, 400)])]
    item = docling.text("page_header", 1, bl(60, 385, 300, 410), furniture=True)
    pieces, text, ledger = build(pages, [item])
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["Looks like a header"]
    assert dropped.furniture == {}
    assert dropped_flag(dropped) is None


def test_furniture_label_in_the_band_is_dropped() -> None:
    pages = [Page(runs=[Run("Confidential", 72, TOP), Run("Body", 72, 300)])]
    item = docling.text("page_header", 1, bl(60, 25, 300, 50), furniture=True)
    pieces, text, ledger = build(pages, [item])
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["Body"]
    assert dropped.furniture == {0: 1}


def test_header_copy_of_a_heading_keeps_the_heading() -> None:
    pages = [Page(runs=[Run("Stability Report", 72, TOP)]) for _ in range(4)]
    pages[0].runs.append(Run("Stability Report", 72, 300))
    item = docling.text("section_header", 1, bl(60, 285, 300, 310), level=1)
    pieces, text, ledger = build(pages, [item])
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["Stability Report"]
    assert kept[0].label == "section_header"
    assert dropped.furniture == {0: 1, 1: 1, 2: 1, 3: 1}


def test_contents_block_is_dropped() -> None:
    runs = [Run("Contents", 72, 200)] + [
        Run(f"Chapter {n} ........ {n * 3}", 72, 230 + 20 * n) for n in range(4)
    ]
    pages = [Page(runs=[Run("Cover", 72, 300)]), Page(runs=[*runs, Run("Body text", 72, 500)])]
    pages += PADDING
    items = [
        docling.text("text", 1, bl(60, 285, 300, 310)),
        docling.text("section_header", 2, bl(60, 185, 300, 210), level=1),
        docling.text("text", 2, bl(60, 220, 400, 320)),
        docling.text("text", 2, bl(60, 485, 300, 510)),
    ]
    pieces, text, ledger = build(pages, items)
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["Cover", "Body text"]
    assert dropped.contents_pages == (1,)
    flag = dropped_flag(dropped)
    assert flag is not None
    assert flag.code == "structure_inferred"
    assert flag.severity == "info"
    assert flag.at is None
    assert "contents and lists on page 2" in flag.message
    char = next(c for c in text.pages[1].chars if c.text == "C")
    assert ledger.entries(1)[char.index] == ["dropped:contents"]


def test_run_of_dot_leader_lines_is_dropped_without_a_heading() -> None:
    runs = [Run(f"Item {n} ...... {n}", 72, 200 + 20 * n) for n in range(3)]
    pieces, text, ledger = build([Page(runs=[*runs, Run("Body", 72, 500)]), *PADDING])
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["Body"]
    assert dropped.contents_pages == (0,)


def test_a_leader_line_past_the_last_page_is_kept() -> None:
    entries = [Run(f"{t} ...... {n}", 72, 200 + 20 * k) for k, (t, n) in enumerate(ENTRIES)]
    spec = [Run(f"{t} load ........ {n}", 72, 300 + 20 * k) for k, (t, n) in enumerate(LOADS)]
    pieces, text, ledger = build([Page(runs=[*entries, *spec, Run("Body", 72, 500)]), *PADDING])
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert len(text.pages) == 20
    assert texts(kept) == [r.text for r in spec] + ["Body"]
    assert dropped.contents_pages == (0,)


def test_a_run_of_leader_lines_past_the_last_page_is_kept() -> None:
    spec = [Run(f"{t} load ........ {n}", 72, 300 + 20 * k) for k, (t, n) in enumerate(LOADS)]
    pieces, text, ledger = build([Page(runs=spec), *PADDING])
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == [
        "Max load ........ 250",
        "Peak load ........ 300",
        "Burst load ........ 400",
    ]
    assert dropped == Dropped({}, ())


def test_a_page_number_going_back_ends_a_run() -> None:
    entries = [Run(f"{t} ...... {n}", 72, 200 + 20 * k) for k, (t, n) in enumerate(ENTRIES)]
    pieces, text, ledger = build([Page(runs=[*entries, Run("Room ...... 4", 72, 300)]), *PADDING])
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["Room ...... 4"]
    assert dropped.contents_pages == (0,)


def test_body_lines_ending_in_numbers_before_a_contents_run_are_kept() -> None:
    body = [Run("Stored in room 1", 72, 160), Run("Moved to room 2", 72, 180)]
    entries = [Run(f"{t} ...... {n}", 72, 200 + 20 * k) for k, (t, n) in enumerate(ENTRIES)]
    pieces, text, ledger = build([Page(runs=[*body, *entries]), *PADDING])
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["Stored in room 1", "Moved to room 2"]
    assert dropped.contents_pages == (0,)


ENTRIES = [("Scope", 3), ("Method", 5), ("Results", 9)]
LOADS = [("Max", 250), ("Peak", 300), ("Burst", 400)]


def test_single_contents_like_line_is_kept() -> None:
    pieces, text, ledger = build([Page(runs=[Run("Results 12", 72, 300)])])
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["Results 12"]
    assert dropped == Dropped({}, ())


def test_header_field_becomes_property() -> None:
    pages = [Page(runs=[Run("Document Type: Report", 72, TOP)]) for _ in range(4)]
    pieces, text, ledger = build(pages)
    kept, dropped, props = drop_furniture(pieces, text, ledger)
    assert kept == []
    assert props == [Property(name="Document Type", value="Report", origin="header-field")]
    assert dropped.furniture == {0: 1, 1: 1, 2: 1, 3: 1}


def test_flag_message_counts_lines_and_pages() -> None:
    flag = dropped_flag(Dropped({0: 2, 1: 2, 2: 1}, (1, 2)))
    assert flag is not None
    assert flag.message == (
        "Dropped as page furniture: 5 lines on 3 pages; contents and lists on pages 2"
        + chr(0x2013)
        + "3"
    )


def test_contents_run_stops_at_a_following_heading_and_caption() -> None:
    runs = [Run(f"Item {n} ...... {n}", 72, 200 + 20 * n) for n in range(4)]
    runs += [Run("Chapter 1", 72, 400), Run("Table 1", 72, 450)]
    items = [
        docling.text("text", 1, bl(60, 185, 400, 290)),
        docling.text("section_header", 1, bl(60, 385, 300, 410), level=1),
        docling.text("caption", 1, bl(60, 435, 300, 460)),
    ]
    pieces, text, ledger = build([Page(runs=runs), *PADDING], items)
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["Chapter 1", "Table 1"]
    assert dropped.contents_pages == (0,)


def test_leaderless_line_ends_a_run_with_leaders_in_the_majority() -> None:
    runs = [Run(f"Item {n} ...... {n}", 72, 200 + 20 * n) for n in range(4)]
    runs.append(Run("Appendix 1", 72, 300))
    pieces, text, ledger = build([Page(runs=runs), *PADDING])
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["Appendix 1"]
    assert dropped.contents_pages == (0,)


def test_heading_led_list_without_leaders_keeps_the_next_heading() -> None:
    pages = [
        Page(
            runs=[
                Run("Contents", 72, 200),
                Run("Introduction 3", 72, 230),
                Run("Method 5", 72, 250),
            ]
        ),
        Page(runs=[Run("1 Introduction", 72, 200)]),
        *PADDING,
    ]
    items = [
        docling.text("section_header", 1, bl(60, 185, 300, 210), level=1),
        docling.text("text", 1, bl(60, 215, 300, 260)),
        docling.text("section_header", 2, bl(60, 185, 300, 210), level=1),
    ]
    pieces, text, ledger = build(pages, items)
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["1 Introduction"]
    assert dropped.contents_pages == (0,)


def _table_page(
    rows: list[tuple[str, str]], *, label: str = "table", heading: str | None = None
) -> tuple[list[Page], list[dict[str, Any]]]:
    runs = [Run(heading, 72, 150)] if heading else []
    runs += [
        Run(text, 78 + 200 * c, 219 + 30 * r)
        for r, row in enumerate(rows)
        for c, text in enumerate(row)
    ]
    runs.append(Run("Body", 72, 500))
    table = docling.table(
        1,
        bl(72, 200, 472, 200 + 30 * len(rows)),
        [(r, c) for r in range(len(rows)) for c in range(2)],
        rows=len(rows),
        cols=2,
    )
    table["label"] = label
    for cell in table["data"]["table_cells"]:
        r, c = cell["start_row_offset_idx"], cell["start_col_offset_idx"]
        cell["bbox"] = {
            "l": 72 + 200 * c,
            "t": 200 + 30 * r,
            "r": 72 + 200 * c + 200,
            "b": 230 + 30 * r,
            "coord_origin": "TOPLEFT",
        }
    items = [table, docling.text("text", 1, bl(60, 485, 300, 510))]
    if heading:
        items.insert(0, docling.text("section_header", 1, bl(60, 135, 300, 160), level=1))
    return [Page(runs=runs)], items


CONTENTS_ROWS = [("Intro", "3"), ("Method", "5"), ("Results", "9")]


def test_table_after_a_contents_heading_is_dropped() -> None:
    pages, items = _table_page(CONTENTS_ROWS, heading="Contents")
    pieces, text, ledger = build(pages, items)
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["Body"]
    assert all(p.table is None for p in kept)
    assert dropped.contents_pages == (0,)
    char = next(c for c in text.pages[0].chars if c.text == "I")
    assert ledger.entries(0)[char.index] == ["dropped:contents"]


def test_document_index_table_is_dropped() -> None:
    pages, items = _table_page(CONTENTS_ROWS, label="document_index")
    pieces, text, ledger = build(pages, items)
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["Body"]
    assert dropped.contents_pages == (0,)


def test_data_table_without_a_contents_heading_is_kept() -> None:
    for rows in (
        [("Apples", "5"), ("Pears", "7"), ("Plums", "9")],
        [("Batch size", "321"), ("Months", "30"), ("Lots", "12")],
    ):
        pages, items = _table_page(rows)
        pieces, text, ledger = build(pages, items)
        kept, dropped, _ = drop_furniture(pieces, text, ledger)
        assert sum(p.table is not None for p in kept) == 1
        assert dropped.contents_pages == ()


def test_table_after_a_contents_heading_must_read_as_entries() -> None:
    pages, items = _table_page(
        [("Batch", "321"), ("Months", "30"), ("Lots", "12")], heading="Contents"
    )
    pieces, text, ledger = build(pages, items)
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert sum(p.table is not None for p in kept) == 1
    assert dropped.contents_pages == ()


def test_footer_on_too_few_pages_is_kept() -> None:
    pages = [Page(runs=[Run("Body", 72, 300), Run("Draft 7", 280, FOOT)]) for _ in range(2)]
    pages += [Page(runs=[Run("Body", 72, 300)]) for _ in range(2)]
    pieces, text, ledger = build(pages)
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept).count("Draft 7") == 2
    assert dropped.furniture == {}


def test_piece_mixing_furniture_and_body_lines_keeps_the_body() -> None:
    pages = [
        Page(runs=[Run("Confidential", 72, TOP), Run("Opening line", 72, 90), Run("More", 72, 300)])
        for _ in range(3)
    ]
    items = [docling.text("text", n, bl(60, 20, 300, 320)) for n in (1, 2, 3)]
    pieces, text, ledger = build(pages, items)
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert [[ln.text for ln in p.lines] for p in kept] == [["Opening line", "More"]] * 3
    assert dropped.furniture == {0: 1, 1: 1, 2: 1}


def test_leader_lines_labelled_as_headings_are_contents() -> None:
    names = ["SUMMARY", "INTRODUCTION", "METHODS", "RESULTS"]
    runs = [Run("Table of Contents", 72, 200)] + [
        Run(f"{name}.......{6 + 2 * n}", 72, 230 + 20 * n) for n, name in enumerate(names)
    ]
    items = [docling.text("section_header", 1, bl(60, 185, 300, 210), level=1)] + [
        docling.text("section_header", 1, bl(60, 215 + 20 * n, 300, 235 + 20 * n), level=1)
        for n in range(4)
    ]
    items.append(docling.text("section_header", 2, bl(60, 185, 300, 210), level=1))
    pages = [Page(runs=runs), Page(runs=[Run("1 SUMMARY", 72, 200)]), *PADDING]
    pieces, text, ledger = build(pages, items)
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["1 SUMMARY"]
    assert dropped.contents_pages == (0,)


# --- Printed line numbers and page numbers ---------------------------------------------------

BODY = ["Stability data", "were collected", "at each station", "over six months", "and reviewed"]


def numbered(lines: list[str], first: int = 2190, x: float = 40, top: float = 200) -> list[Run]:
    """Each line at x 72 with its printed line number in the left margin."""
    runs: list[Run] = []
    for k, line in enumerate(lines):
        y = top + 14 * k
        runs += [Run(str(first + k), x, y, size=8), Run(line, 72, y)]
    return runs


def test_margin_line_numbers_are_dropped() -> None:
    runs = [*numbered(["Table 7: Protocol design", *BODY]), Run("Page 8 of 120", 260, FOOT)]
    items = [
        docling.text("caption", 1, bl(30, 188, 400, 204)),
        docling.text("text", 1, bl(30, 202, 400, 274)),
    ]
    pieces, text, ledger = build([Page(runs=runs)], items)
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert [[ln.text for ln in p.lines] for p in kept] == [["Table 7: Protocol design"], BODY]
    assert kept[0].label == "caption"
    assert dropped.line_numbers == {0: 6}
    assert dropped.furniture == {0: 1}
    digit = next(c for c in text.pages[0].chars if c.text == "9")
    assert ledger.entries(0)[digit.index] == ["dropped:line-number"]
    flag = dropped_flag(dropped)
    assert flag is not None
    assert flag.message == "Dropped as page furniture: 1 line on 1 page; 6 line numbers on 1 page"


def test_line_numbers_outside_any_item_are_dropped() -> None:
    pieces, text, ledger = build([Page(runs=numbered(BODY))], [])
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == BODY
    assert dropped.line_numbers == {0: 5}
    assert dropped_flag(dropped) is not None


def test_numbered_list_beside_body_text_is_kept() -> None:
    items = [f"{n} Item number {n}" for n in range(1, 7)]
    runs = [Run(line, 72, 200 + 14 * k) for k, line in enumerate(items)]
    runs.append(Run("A paragraph under the list", 72, 320))
    pieces, text, ledger = build([Page(runs=runs)])
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == [*items, "A paragraph under the list"]
    assert dropped.line_numbers == {}


def test_numbers_that_do_not_increase_are_kept() -> None:
    runs = numbered(BODY)
    runs[2] = Run("2199", 40, 214, size=8)  # 2190, 2199, 2192, ...
    pieces, text, ledger = build([Page(runs=runs)])
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert dropped.line_numbers == {}
    assert "2190" in " ".join(texts(kept))


def test_too_few_numbered_lines_are_kept() -> None:
    runs = numbered(BODY[:3]) + [Run(f"Plain line {k}", 72, 300 + 14 * k) for k in range(6)]
    pieces, text, ledger = build([Page(runs=runs)])
    _, dropped, _ = drop_furniture(pieces, text, ledger)
    assert dropped.line_numbers == {}


def test_a_table_first_column_of_numbers_is_kept() -> None:
    pages, items = _table_page([("1", "Apples"), ("2", "Pears"), ("3", "Plums"), ("4", "Figs")])
    pages[0].runs += [Run("5", 78, 339), Run("Kiwis", 278, 339)]
    items[0]["prov"] = docling.table(1, bl(72, 200, 472, 350), [], rows=5, cols=2)["prov"]
    pieces, text, ledger = build(pages, items)
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert dropped.line_numbers == {}
    assert sum(p.table is not None for p in kept) == 1


def test_page_numbers_in_the_band_are_dropped_on_any_page() -> None:
    for label in ("8", "A3 8", "A3-8", "Page 8 of 120", "- 8 -", "8/120", "iv"):
        pages = [Page(runs=[Run("Body", 72, 300), Run(label, 280, FOOT)])]
        pieces, text, ledger = build(pages)
        kept, dropped, _ = drop_furniture(pieces, text, ledger)
        assert texts(kept) == ["Body"], label
        assert dropped.furniture == {0: 1}, label


def test_a_number_in_the_body_is_not_a_page_number() -> None:
    pieces, text, ledger = build([Page(runs=[Run("Body", 72, 300), Run("8", 280, 400)])])
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["Body", "8"]
    assert dropped.furniture == {}


def test_a_picture_over_a_footer_page_number_is_dropped() -> None:
    pages = [Page(runs=[Run("Body", 72, 300), Run("A3 8", 280, FOOT)])]
    items = [
        docling.text("text", 1, bl(60, 285, 300, 310)),
        docling.picture(1, bl(270, 785, 330, 806)),
        docling.text("text", 1, bl(275, 790, 320, 804)),
    ]
    pieces, text, ledger = build(pages, items)
    assert any(p.picture is not None for p in pieces)
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["Body"]
    assert all(p.picture is None for p in kept)
    assert dropped.pictures == {0: 1}
    flag = dropped_flag(dropped)
    assert flag is not None
    assert flag.message == "Dropped as page furniture: 1 line and 1 picture on 1 page"


def test_a_picture_holding_the_page_number_is_dropped() -> None:
    pages = [Page(runs=[Run("Body", 72, 300), Run("A3 8", 280, FOOT)])]
    items = [docling.picture(1, bl(270, 785, 330, 806))]
    pieces, text, ledger = build(pages, items)
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert all(p.picture is None for p in kept)
    assert dropped.pictures == {0: 1}
    eight = next(c for c in text.pages[0].chars if c.text == "8")
    assert ledger.entries(0)[eight.index] == ["dropped:furniture"]


def test_a_footer_picture_over_an_image_or_other_text_is_kept() -> None:
    logo = Page(runs=[Run("Body", 72, 300), Run("8", 280, FOOT)], images=[Img(250, 785, 80, 20)])
    named = Page(runs=[Run("Body", 72, 300), Run("Acme Labs", 260, FOOT)])
    for page in (logo, named):
        pieces, text, ledger = build([page], [docling.picture(1, bl(250, 785, 340, 806))])
        kept, dropped, _ = drop_furniture(pieces, text, ledger)
        assert sum(p.picture is not None for p in kept) == 1
        assert dropped.pictures == {}


def test_line_numbers_carry_on_into_the_top_band() -> None:
    runs = [Run("2189", 40, 70, size=8), Run("Opening line", 72, 70), *numbered(BODY)]
    pieces, text, ledger = build([Page(runs=runs)])
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["Opening line", *BODY]
    assert dropped.line_numbers == {0: 6}
