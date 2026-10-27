"""Scanned pages turned into pieces on a synthetic text layer (spec section 15.3)."""

from __future__ import annotations

import io

from PIL import Image

from ingest_worker.decompose.pdf.crop import RotatedCropper
from ingest_worker.decompose.pdf.layout import LayoutPicture
from ingest_worker.decompose.pdf.scanned import (
    drop_scanned_furniture,
    normalise_levels,
    recognise_page,
)
from ingest_worker.decompose.pdf.textlayer import PageText
from ingest_worker.decompose.pdf.transcript import (
    TxBlock,
    TxEquation,
    TxFigure,
    TxHeading,
    TxParagraph,
    parse_transcript,
)

#: A4 in points, and the image the OCR model was sent (longest side 1288 px).
_W, _H = 595.0, 842.0
_PX = (910, 1288)
_SCALE = _H / 1288


def _page(index: int = 2) -> PageText:
    return PageText(
        index=index,
        width=_W,
        height=_H,
        chars=(),
        image_area=1.0,
        images=((0.0, 0.0, _W, _H),),
    )


def _picture(ref: str, box: tuple[float, float, float, float], page: int = 2) -> LayoutPicture:
    return LayoutPicture(ref=ref, page=page, bbox=box, captions=())


def _px(box: tuple[float, float, float, float]) -> str:
    """A placeholder name for a box in points."""
    x0, y0, x1, y1 = (round(v / _SCALE) for v in box)
    return f"page_{x0}_{y0}_{x1 - x0}_{y1 - y0}.png"


def _recognise(
    markdown: str,
    regions: list[LayoutPicture] | None = None,
    *,
    rotation: int = 0,
    left_out_words: int = 0,
):  # type: ignore[no-untyped-def]
    return recognise_page(
        _page(),
        parse_transcript(markdown),
        regions or [],
        rotation=rotation,
        render_px=_PX,
        left_out_words=left_out_words,
    )


def test_blocks_become_pieces_in_order() -> None:
    page = _recognise(
        "# Scope\n\nSome text here.\n\n- one\n- two\n\n"
        "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>"
    )
    labels = [p.label for p in page.pieces]
    assert labels == ["section_header", "text", "list_item", "list_item", "table"]
    items = [p for p in page.pieces if p.label == "list_item"]
    assert items[0].group is not None and items[0].group == items[1].group
    assert all(p.page == 2 and p.recognised for p in page.pieces)
    assert page.pieces[0].level == 1
    assert page.pieces[1].lines[0].text == "Some text here."
    assert items[0].lines[0].text.startswith("•")
    chars = page.page.chars
    assert chars and all(c.visible for c in chars)
    assert all(c.y0 > _H for c in chars)
    table = page.pieces[-1]
    assert table.table is not None and (table.table.rows, table.table.cols) == (2, 2)
    assert table.cells is not None
    assert table.cells[(1, 1)][0].text == "2"
    assert [c.header for c in table.table.cells if c.row == 0] == [True, True]


def test_marks_survive() -> None:
    page = _recognise("Plain **bold** m<sup>2</sup>")
    (piece,) = page.pieces
    line = piece.lines[0]
    assert any(c.bold for c in line.chars if c.text == "b")
    runs = line.runs()
    assert any(r.text == "2" and "superscript" in r.marks for r in runs)
    assert line.text == "Plain bold m2"


def test_links_become_page_links() -> None:
    page = _recognise("See [the site](https://x.example) now")
    (box, uri) = page.page.links[0]
    assert uri == "https://x.example"
    inside = [c for c in page.page.chars if box[0] <= (c.x0 + c.x1) / 2 <= box[2]]
    assert "".join(c.text for c in inside).replace(" ", "") == "thesite"


def test_figure_matched_by_box() -> None:
    a = (50.0, 100.0, 250.0, 300.0)
    b = (300.0, 400.0, 550.0, 700.0)
    markdown = f"![Second]({_px(b)})\n\n![First]({_px(a)})"
    page = _recognise(markdown, [_picture("#/pictures/0", a), _picture("#/pictures/1", b)])
    pictures = [p for p in page.pieces if p.picture is not None]
    assert [(p.picture.ref, p.lines[0].text) for p in pictures if p.picture] == [
        ("#/pictures/1", "Second"),
        ("#/pictures/0", "First"),
    ]
    assert [p.bbox for p in pictures] == [b, a]
    assert [f.code for f in page.flags] == ["page_recognised"]


def test_unmatched_region_goes_last_and_flags() -> None:
    a = (50.0, 100.0, 250.0, 300.0)
    c = (50.0, 500.0, 250.0, 700.0)
    markdown = f"![Pump]({_px(a)})\n\nText after.\n\n![Ghost](page_900_900_10_10.png)"
    page = _recognise(markdown, [_picture("#/pictures/0", a), _picture("#/pictures/1", c)])
    assert [p.label for p in page.pieces] == ["picture", "text", "picture"]
    assert page.pieces[-1].bbox == c
    messages = " ".join(f.message for f in page.flags)
    assert "picture" in messages and "left out" in messages
    assert len(page.flags) == 3


def test_rotated_page_matches_in_order() -> None:
    a = (50.0, 100.0, 250.0, 300.0)
    b = (300.0, 400.0, 550.0, 700.0)
    markdown = f"![First]({_px(b)})\n\n![Second]({_px(a)})"
    page = _recognise(
        markdown, [_picture("#/pictures/1", b), _picture("#/pictures/0", a)], rotation=90
    )
    pictures = [p for p in page.pieces if p.picture is not None]
    assert [p.lines[0].text for p in pictures] == ["First", "Second"]
    assert [p.bbox for p in pictures] == [a, b]  # top to bottom


def test_display_equation_takes_unmatched_region() -> None:
    eq = (200.0, 200.0, 400.0, 230.0)
    page = _recognise("Before.\n\n$$x^2$$\n\nAfter.", [_picture("#/pictures/0", eq)])
    assert [p.label for p in page.pieces] == ["text", "formula", "text"]
    formula = page.pieces[1]
    assert formula.bbox == eq and formula.latex == "x^2" and formula.picture is None
    assert [f.code for f in page.flags] == ["page_recognised"]


def test_display_equation_without_region_is_text() -> None:
    page = _recognise("$$x^2$$")
    (piece,) = page.pieces
    assert piece.label == "text" and piece.lines[0].text == "$$x^2$$"
    assert [f.code for f in page.flags] == ["page_recognised", "structure_inferred"]
    assert page.flags[1].at == piece.ref


def test_empty_page_flagged() -> None:
    page = recognise_page(_page(), [], [], rotation=0, render_px=_PX, left_out_words=0)
    assert page.pieces == []
    (flag,) = page.flags
    assert flag.code == "page_recognised" and flag.at is None
    assert "page 3: no text was recognised" in flag.message


def test_every_page_flagged() -> None:
    (flag,) = _recognise("Text.").flags
    assert flag.code == "page_recognised" and flag.severity == "warning"
    assert flag.message == "page 3 was read by the OCR model"


def test_left_out_words_in_flag() -> None:
    (flag,) = _recognise("Text.", left_out_words=4).flags
    assert flag.message == (
        "page 3 was read by the OCR model; "
        "page 3: 4 words of visible text over the scan were left out"
    )


def test_normalise_levels() -> None:
    pages: dict[int, list[TxBlock]] = {
        1: [TxHeading(3, (("A", frozenset(), None),))],
        2: [TxHeading(4, (("B", frozenset(), None),)), TxParagraph((("t", frozenset(), None),))],
    }
    out = normalise_levels(pages)
    assert [b.level for b in out[1] if isinstance(b, TxHeading)] == [1]
    assert [b.level for b in out[2] if isinstance(b, TxHeading)] == [2]


def _para(text: str) -> TxParagraph:
    return TxParagraph(((text, frozenset(), None),))


def test_scanned_furniture() -> None:
    pages: dict[int, list[TxBlock]] = {
        n: [_para(f"Body {chr(65 + n)}"), _para(f"Page {n + 1} of 4")] for n in range(4)
    }
    kept, dropped = drop_scanned_furniture(pages)
    assert all(len(blocks) == 1 for blocks in kept.values())
    assert dropped == {0: 1, 1: 1, 2: 1, 3: 1}
    two = {n: [_para("Body"), _para(f"Page {n + 1}")] for n in range(2)}
    kept, dropped = drop_scanned_furniture(two)
    assert kept == two and dropped == {}


def test_furniture_keeps_equations_and_figures() -> None:
    pages: dict[int, list[TxBlock]] = {
        n: [TxEquation("x"), _para("Body"), TxFigure("f", None)] for n in range(3)
    }
    kept, dropped = drop_scanned_furniture(pages)
    assert kept == pages and dropped == {}


def test_rotated_cropper() -> None:
    class Inner:
        def crop(self, page: int, bbox: tuple[float, float, float, float]) -> bytes:
            out = io.BytesIO()
            Image.new("RGB", (10, 20), "white").save(out, format="PNG")
            return out.getvalue()

    cropper = RotatedCropper(Inner(), {2: 90})
    turned = Image.open(io.BytesIO(cropper.crop(2, (0, 0, 1, 1))))
    assert turned.size == (20, 10)
    upright = Image.open(io.BytesIO(cropper.crop(1, (0, 0, 1, 1))))
    assert upright.size == (10, 20)
