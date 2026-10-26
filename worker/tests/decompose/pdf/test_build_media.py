"""Pictures, figures, formulas, footnotes, links, properties and unmapped symbols in the built
document, and the cropper that renders a page region (spec sections 4.7 and 4.8)."""

from __future__ import annotations

import io
from dataclasses import replace
from typing import Any

from PIL import Image as PILImage

from ingest_worker.decompose.forms import text_form
from ingest_worker.decompose.model import (
    DecomposedDocument,
    Equation,
    EquationBlock,
    Figure,
    Flag,
    ImageBlock,
    Link,
    Note,
    NoteRef,
    Paragraph,
    Property,
    Table,
    Text,
)
from ingest_worker.decompose.pdf.build import Provenance, build_document, pdf_properties
from ingest_worker.decompose.pdf.crop import PdfiumCropper
from ingest_worker.decompose.pdf.layout import parse_docling
from ingest_worker.decompose.pdf.outline import assign_headings
from ingest_worker.decompose.pdf.pieces import Ledger, Piece, attach_text
from ingest_worker.decompose.pdf.textlayer import TextLayer, read_text_layer
from ingest_worker.decompose.properties import _CORE
from tests.decompose.pdf import docling
from tests.decompose.pdf.fakes import FakeCropper
from tests.decompose.pdf.make_pdf import Img, Page, Run, make_pdf
from tests.decompose.pdf.test_build import HEIGHT, WIDTH, bl, item, owner_of, plain
from tests.decompose.pdf.test_pdf_tables import cell_runs, grid, simple, sup

Links = list[tuple[int, tuple[float, float, float, float], str]]


def build(
    pages: list[Page], items: list[dict[str, Any]], *, links: Links | None = None
) -> tuple[list[Piece], TextLayer, Ledger, list[Flag]]:
    text = read_text_layer(make_pdf(pages, links=links or []))
    layout = parse_docling(docling.doc([(WIDTH, HEIGHT)] * len(pages), items))
    pieces, ledger = attach_text(layout, text)
    pieces, flags = assign_headings(pieces, [], ledger)
    return pieces, text, ledger, flags


def document(
    pieces: list[Piece],
    text: TextLayer,
    ledger: Ledger,
    flags: list[Flag],
    cropper: FakeCropper | None = None,
) -> tuple[DecomposedDocument, dict[str, bytes], Provenance]:
    return build_document(
        pieces,
        text=text,
        ledger=ledger,
        cropper=cropper or FakeCropper(),
        properties=[],
        flags=flags,
    )


def picture(box: tuple[float, float, float, float]) -> dict[str, Any]:
    return docling.picture(1, bl(*box))


def chars_of(text: TextLayer, page: int, word: str) -> list[int]:
    """The indexes of the chars of the first run of chars that spell `word`."""
    chars = [c for c in text.pages[page].chars if not c.text.isspace()]
    letters = "".join(c.text for c in chars)
    start = letters.index(word.replace(" ", ""))
    return [c.index for c in chars[start : start + len(word.replace(" ", ""))]]


def owners_of(ledger: Ledger, page: int, indexes: list[int]) -> set[str]:
    entries = ledger.entries(page)
    return {o for i in indexes for o in entries[i]}


# --- Pictures --------------------------------------------------------------------------------


def test_captioned_picture_is_a_figure() -> None:
    runs = [
        Run("Before.", 72, 100),
        Run("Axis", 120, 250),
        Run("Figure 2: Dose response", 72, 420),
    ]
    page = Page(runs=runs, images=[Img(100, 200, 300, 180)])
    items = [item("text", 1, 100), picture((90, 190, 410, 390)), item("caption", 1, 420)]
    pieces, text, ledger, flags = build([page], items)
    cropper = FakeCropper()
    doc, images, prov = document(pieces, text, ledger, flags, cropper)

    assert [type(b).__name__ for b in doc.blocks] == ["Paragraph", "Figure"]
    figure = doc.blocks[1]
    assert figure == Figure(
        id="s~lead#image-1",
        image_id="s~lead#image-1#img-1",
        numbered=True,
        caption=[Text(text="Dose response")],
        caption_position="below",
    )
    [image] = doc.images
    assert image.id == "s~lead#image-1#img-1"
    assert image.origin == "cropped"
    assert image.content_type == "image/png"
    assert (image.width_mm, image.height_mm) == (112.89, 70.56)  # 320 x 200 pt
    assert image.align == "left"
    assert image.alt == "Axis"
    assert cropper.calls == [(0, (90.0, 190.0, 410.0, 390.0))]
    assert list(images) == [image.id]
    assert images[image.id].startswith(b"\x89PNG")
    # the caption's number is dropped; the rest of it, and the text inside, are the figure's
    assert owners_of(ledger, 0, chars_of(text, 0, "Dose response")) == {figure.id}
    assert owners_of(ledger, 0, chars_of(text, 0, "Axis")) == {figure.id}
    assert owners_of(ledger, 0, chars_of(text, 0, "Figure 2:")) == {"dropped:caption-number"}
    assert prov.pages[figure.id] == {0}
    assert doc.report == []


def test_docling_caption_above_makes_a_figure() -> None:
    runs = [Run("Dose response", 72, 180), Run("After.", 72, 420)]
    page = Page(runs=runs, images=[Img(100, 200, 300, 180)])
    items = [item("text", 1, 180), picture((90, 190, 410, 390)), item("text", 1, 420)]
    raw = docling.doc([(WIDTH, HEIGHT)], items)
    raw["texts"][0]["text"] = "Dose response"
    raw["pictures"][0]["captions"] = [{"$ref": "#/texts/0"}]
    text = read_text_layer(make_pdf([page]))
    pieces, ledger = attach_text(parse_docling(raw), text)
    doc, _, _ = document(pieces, text, ledger, [])
    assert [type(b).__name__ for b in doc.blocks] == ["Figure", "Paragraph"]
    figure = doc.blocks[0]
    assert isinstance(figure, Figure)
    assert (figure.numbered, plain(figure.caption), figure.caption_position) == (
        False,
        "Dose response",
        "above",
    )
    # the caption paragraph keeps the ordinal it was given, unused, as for a table
    assert doc.blocks[1].id == "s~lead#p-2"
    assert owners_of(ledger, 0, chars_of(text, 0, "Dose response")) == {figure.id}


def test_uncaptioned_picture_is_an_image_block() -> None:
    # centred on the page: its centre is the page's
    page = Page(runs=[Run("Text.", 72, 100)], images=[Img(197.5, 200, 200, 100)])
    items = [item("text", 1, 100), picture((197.5, 200, 397.5, 300))]
    pieces, text, ledger, flags = build([page], items)
    doc, images, prov = document(pieces, text, ledger, flags)
    assert doc.blocks[1] == ImageBlock(id="s~lead#image-1", image_id="s~lead#image-1#img-1")
    [image] = doc.images
    assert (image.alt, image.align) == (None, "center")
    assert list(images) == [image.id]
    assert prov.pages["s~lead#image-1"] == {0}
    assert doc.report == []


def test_text_inside_a_picture_is_its_alt() -> None:
    runs = [Run("Concentration", 120, 250), Run("Time (h)", 200, 360)]
    page = Page(runs=runs, images=[Img(100, 200, 300, 180)])
    pieces, text, ledger, flags = build([page], [picture((90, 190, 410, 390))])
    doc, _, _ = document(pieces, text, ledger, flags)
    [image] = doc.images
    assert image.alt == "Concentration Time (h)"
    assert owner_of(ledger, text, 0, "C") == ["s~lead#image-1"]
    assert owner_of(ledger, text, 0, "T") == ["s~lead#image-1"]
    assert text_form(doc) == ["⟦img⟧ Concentration Time (h)"]


def test_drawing_is_flagged() -> None:
    rulings = [(100, 200 + 20 * n, 400, 200 + 20 * n) for n in range(6)]
    small = Img(100, 200, 100, 50)  # an image object, but over far less than 80% of the box
    pages = [Page(lines=rulings), Page(lines=rulings, images=[small])]
    items = [docling.picture(1, bl(90, 190, 410, 310)), docling.picture(2, bl(90, 190, 410, 310))]
    pieces, text, ledger, flags = build(pages, items)
    doc, _, _ = document(pieces, text, ledger, flags)
    assert [b.id for b in doc.blocks] == ["s~lead#image-1", "s~lead#image-2"]
    assert [(f.code, f.severity, f.at, f.message) for f in doc.report] == [
        (
            "drawing_rendered",
            "warning",
            "s~lead#image-1",
            "drawing rendered to image s~lead#image-1#img-1",
        ),
        (
            "drawing_rendered",
            "warning",
            "s~lead#image-2",
            "drawing rendered to image s~lead#image-2#img-1",
        ),
    ]


# --- Formulas --------------------------------------------------------------------------------


def test_formula_is_an_image_equation() -> None:
    runs = [Run("Above.", 72, 100), Run("E = mc", 250, 300)]
    items = [item("text", 1, 100), item("formula", 1, 300, 200, 395)]
    pieces, text, ledger, flags = build([Page(runs=runs)], items)
    cropper = FakeCropper()
    doc, images, _ = document(pieces, text, ledger, flags, cropper)
    block_id = "s~lead#equation-1"
    assert doc.blocks[1] == EquationBlock(id=block_id, equation_id=f"{block_id}#eq-1")
    assert doc.equations == [
        Equation(id=f"{block_id}#eq-1", mathml=None, latex=None, image_id=f"{block_id}#eq-1#img-1")
    ]
    [image] = doc.images
    assert (image.id, image.origin, image.alt, image.align) == (
        f"{block_id}#eq-1#img-1",
        "cropped",
        None,
        "center",
    )
    assert list(images) == [image.id]
    assert cropper.calls == [(0, pieces[1].bbox)]
    assert owner_of(ledger, text, 0, "E") == [block_id]
    assert owner_of(ledger, text, 0, "m") == [block_id]
    assert [(f.code, f.severity, f.at, f.message) for f in doc.report] == [
        (
            "equation_image_only",
            "warning",
            block_id,
            f"equation {block_id}#eq-1 kept as an image only",
        )
    ]


# --- Footnotes -------------------------------------------------------------------------------


def footnote_page(marker: bool = True) -> Page:
    runs = [Run("The dose", 72, 100)]
    if marker:
        runs.append(Run("1", 118, 100, size=7, rise=3))
    runs += [Run("was given.", 124, 100), Run("1 See the protocol.", 72, 800, size=9)]
    return Page(runs=runs)


def test_footnote_links_to_its_marker() -> None:
    items = [item("text", 1, 100), item("footnote", 1, 800)]
    pieces, text, ledger, flags = build([footnote_page()], items)
    doc, _, prov = document(pieces, text, ledger, flags)
    assert doc.blocks == [
        Paragraph(
            id="s~lead#p-1",
            inlines=[Text(text="The dose"), NoteRef(note_id="fn-1"), Text(text=" was given.")],
        )
    ]
    assert doc.notes == [
        Note(id="fn-1", blocks=[Paragraph(id="fn-1#p-1", inlines=[Text(text="See the protocol.")])])
    ]
    body_marker, note_marker = (c.index for c in text.pages[0].chars if c.text == "1")
    # both markers are dropped: the note token stands for them in the text form
    assert ledger.entries(0)[body_marker] == ["dropped:note-marker"]
    assert ledger.entries(0)[note_marker] == ["dropped:note-marker"]
    assert owners_of(ledger, 0, chars_of(text, 0, "See the protocol.")) == {"fn-1"}
    assert owners_of(ledger, 0, chars_of(text, 0, "The dose")) == {"s~lead#p-1"}
    assert prov.pages["fn-1"] == {0}
    assert text_form(doc) == ["The dose⟦note:fn-1⟧ was given.", "See the protocol."]
    assert doc.report == []


def test_unmatched_footnote_stays_and_is_flagged() -> None:
    items = [item("text", 1, 100), item("footnote", 1, 800)]
    pieces, text, ledger, flags = build([footnote_page(marker=False)], items)
    doc, _, _ = document(pieces, text, ledger, flags)
    assert [plain(b.inlines) for b in doc.blocks if isinstance(b, Paragraph)] == [
        "The dose was given.",
        "1 See the protocol.",
    ]
    assert doc.notes == []
    assert owner_of(ledger, text, 0, "1") == ["s~lead#p-2"]
    assert [(f.code, f.severity, f.at, f.message) for f in doc.report] == [
        ("structure_inferred", "warning", "s~lead#p-2", "Footnote with no marker found")
    ]


def test_unmatched_footnote_does_not_stop_a_join_across_the_page() -> None:
    pages = [
        Page(runs=[Run("The batch was released to the", 72, 760), Run("a Unused.", 72, 800)]),
        Page(runs=[Run("market in May.", 72, 80)]),
    ]
    items = [item("text", 1, 760), item("footnote", 1, 800), item("text", 2, 80)]
    pieces, text, ledger, flags = build(pages, items)
    doc, _, _ = document(pieces, text, ledger, flags)
    assert [plain(b.inlines) for b in doc.blocks if isinstance(b, Paragraph)] == [
        "The batch was released to the market in May.",
        "a Unused.",
    ]


SUP = frozenset({"superscript"})


def test_footnote_taken_as_a_table_note_leaves_its_marker_as_text() -> None:
    texts = {(0, 0): "A", (0, 1): "B", (1, 0): "1", (1, 1): "2"}
    runs = [
        Run("The dose", 72, 60),
        Run("1", 118, 60, size=7, rise=3),
        Run("was given.", 124, 60),
        *cell_runs(texts),
        sup("1", 1, 1),
        Run("1 : measured at 25 °C", 72, 160),  # a table note's marker, and a footnote's
    ]
    items = [
        item("text", 1, 60),
        grid(1, simple(2, 2), rows=2, cols=2),
        docling.text("footnote", 1, bl(60, 148, 400, 165)),
    ]
    pieces, text, ledger, flags = build([Page(runs=runs)], items)
    doc, _, _ = document(pieces, text, ledger, flags)
    assert doc.blocks[0] == Paragraph(
        id="s~lead#p-1",
        inlines=[Text(text="The dose"), Text(text="1", marks=SUP), Text(text=" was given.")],
    )
    table = doc.blocks[1]
    assert isinstance(table, Table)
    assert [n.marker for n in table.notes] == ["1"]
    assert doc.notes == []
    assert "note_ref" not in doc.model_dump_json()
    assert owner_of(ledger, text, 0, "1") == ["s~lead#p-1"]


def test_a_power_after_a_unit_is_not_a_footnote_marker() -> None:
    runs = [
        Run("The area is 5 m", 72, 100),
        Run("2", 148.5, 100, size=7, rise=3),
        Run("on site.", 154, 100),
        Run("2 Measured by laser.", 72, 800, size=9),
    ]
    items = [item("text", 1, 100), item("footnote", 1, 800)]
    pieces, text, ledger, flags = build([Page(runs=runs)], items)
    doc, _, _ = document(pieces, text, ledger, flags)
    assert doc.blocks[0] == Paragraph(
        id="s~lead#p-1",
        inlines=[Text(text="The area is 5 m"), Text(text="2", marks=SUP), Text(text=" on site.")],
    )
    assert doc.notes == []
    assert owner_of(ledger, text, 0, "2") == ["s~lead#p-1"]
    assert [(f.at, f.message) for f in doc.report] == [
        ("s~lead#p-2", "Footnote with no marker found")
    ]


def test_a_footnote_takes_its_real_marker_not_a_unit_power() -> None:
    runs = [
        Run("The dose", 72, 100),
        Run("2", 118, 100, size=7, rise=3),
        Run("was given.", 124, 100),
        Run("The area is 5 m", 72, 130),
        Run("2", 148.5, 130, size=7, rise=3),
        Run("on site.", 154, 130),
        Run("2 Measured by laser.", 72, 800, size=9),
    ]
    items = [item("text", 1, 100), item("text", 1, 130), item("footnote", 1, 800)]
    pieces, text, ledger, flags = build([Page(runs=runs)], items)
    doc, _, _ = document(pieces, text, ledger, flags)
    first, second = doc.blocks
    assert isinstance(first, Paragraph) and isinstance(second, Paragraph)
    assert NoteRef(note_id="fn-1") in first.inlines
    assert second.inlines[1] == Text(text="2", marks=SUP)
    assert [n.id for n in doc.notes] == ["fn-1"]


def test_a_carried_over_line_starting_with_an_article_is_no_letter_marker() -> None:
    runs = [
        Run("The dose", 72, 100),
        Run("a", 118, 100, size=7, rise=3),
        Run("was given.", 124, 100),
        Run("a total of 12 batches.", 72, 800, size=9),
    ]
    items = [item("text", 1, 100), item("footnote", 1, 800)]
    pieces, text, ledger, flags = build([Page(runs=runs)], items)
    doc, _, _ = document(pieces, text, ledger, flags)
    assert doc.notes == []
    assert plain(doc.blocks[1].inlines) == "a total of 12 batches."  # type: ignore[union-attr]
    assert owner_of(ledger, text, 0, "a") == ["s~lead#p-1"]
    assert [f.message for f in doc.report] == ["Footnote with no marker found"]


# --- Links -----------------------------------------------------------------------------------


def test_link_annotation_wraps_text() -> None:
    runs = [Run("See", 72, 100), Run("example.com", 100, 100), Run("now.", 200, 100)]
    links: Links = [(0, (98, 88, 190, 104), "https://example.com")]
    pieces, text, ledger, flags = build([Page(runs=runs)], [item("text", 1, 100)], links=links)
    assert text.pages[0].links == (((98.0, 88.0, 190.0, 104.0), "https://example.com"),)
    doc, _, _ = document(pieces, text, ledger, flags)
    assert doc.blocks == [
        Paragraph(
            id="s~lead#p-1",
            inlines=[
                Text(text="See "),
                Link(href="https://example.com", inlines=[Text(text="example.com")]),
                Text(text=" now."),
            ],
        )
    ]


# --- Unmapped symbols ------------------------------------------------------------------------


def test_unmapped_symbol_is_flagged() -> None:
    runs = [Run("Before.", 72, 100), Run("Ab", 72, 130)]
    pieces, text, ledger, flags = build(
        [Page(runs=runs)], [item("text", 1, 100), item("text", 1, 130)]
    )
    b = next(c for c in text.pages[0].chars if c.text == "b")
    text = replace(text, unmapped_symbols=((0, b.font, "b"),))
    doc, _, _ = document(pieces, text, ledger, flags)
    assert [(f.code, f.severity, f.at, f.message) for f in doc.report] == [
        ("symbol_unmapped", "warning", "s~lead#p-2", f"no mapping for code 0062 in font {b.font}")
    ]


# --- Properties ------------------------------------------------------------------------------


def test_info_dictionary_properties() -> None:
    data = make_pdf(
        [Page()],
        info={
            "/Title": "T",
            "/Author": "A. Writer",
            "/Keywords": "dose; batch",
            "/CreationDate": "D:20240102030405+01'00'",
            "/ModDate": "D:20250607",
        },
    )
    props = pdf_properties(data)
    assert props == [
        Property(name="title", value="T", origin="pdf-info"),
        Property(name="author", value="A. Writer", origin="pdf-info"),
        Property(name="keywords", value="dose; batch", origin="pdf-info"),
        Property(name="created", value="2024-01-02T03:04:05+01:00", origin="pdf-info"),
        Property(name="modified", value="2025-06-07", origin="pdf-info"),
    ]
    assert {p.name for p in props} <= {name for name, _ in _CORE}
    assert pdf_properties(make_pdf([Page()])) == []


# --- Cropping --------------------------------------------------------------------------------


def test_pdfium_cropper_crops_the_box() -> None:
    data = make_pdf([Page(images=[Img(100, 200, 144, 72)]), Page(rotate=90)])
    cropper = PdfiumCropper(data, dpi=144)
    with PILImage.open(io.BytesIO(cropper.crop(0, (100, 200, 244, 272)))) as png:
        assert png.format == "PNG"
        assert png.size == (288, 144)  # 2 px per point
        grey = png.convert("L")
        assert grey.getpixel((144, 72)) == 128  # the image's grey, not the white page
    with PILImage.open(io.BytesIO(cropper.crop(0, (300, 400, 372, 436)))) as blank:
        assert blank.convert("L").getpixel((10, 10)) == 255
    with PILImage.open(io.BytesIO(cropper.crop(1, (0, 0, 72, 36)))) as rotated:
        assert rotated.size == (144, 72)
    cropper.close()
