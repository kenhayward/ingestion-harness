"""Page furniture and contents dropped from the pieces, under guards."""

from __future__ import annotations

from typing import Any

from ingest_worker.decompose.model import Property
from ingest_worker.decompose.pdf.furniture import Dropped, drop_furniture, dropped_flag
from ingest_worker.decompose.pdf.layout import parse_docling
from ingest_worker.decompose.pdf.pieces import Piece, attach_text
from ingest_worker.decompose.pdf.textlayer import read_text_layer
from tests.decompose.pdf import docling
from tests.decompose.pdf.make_pdf import Page, Run, make_pdf

HEIGHT = 842.0
TOP = 40.0
FOOT = 800.0


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
    pieces, text, ledger = build([Page(runs=[*runs, Run("Body", 72, 500)])])
    kept, dropped, _ = drop_furniture(pieces, text, ledger)
    assert texts(kept) == ["Body"]
    assert dropped.contents_pages == (0,)


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
