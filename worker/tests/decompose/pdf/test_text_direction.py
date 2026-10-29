"""Text that runs up or down the page, and text drawn at another scale, read as lines."""

from __future__ import annotations

import pytest

from ingest_worker.decompose.model import DecomposedDocument, Paragraph, Section, Text
from ingest_worker.decompose.pdf import decompose_pdf
from tests.decompose.pdf import docling
from tests.decompose.pdf.fakes import FakeCropper, FakeLayout
from tests.decompose.pdf.make_pdf import Page, Run, make_pdf

HEIGHT = 842.0


def bl(x0: float, y0: float, x1: float, y1: float) -> docling.Box:
    return (x0, HEIGHT - y0, x1, HEIGHT - y1)


def paragraphs(doc: DecomposedDocument) -> list[str]:
    out: list[str] = []

    def walk(blocks: list[object], sections: list[Section]) -> None:
        for b in blocks:
            if isinstance(b, Paragraph):
                out.append("".join(i.text for i in b.inlines if isinstance(i, Text)))
        for s in sections:
            walk(list(s.blocks), list(s.sections))

    walk(list(doc.blocks), list(doc.sections))
    return out


def read(runs: list[Run], boxes: list[docling.Box]) -> DecomposedDocument:
    items = [docling.text("text", 1, box) for box in boxes]
    layout = FakeLayout(lambda first, last: docling.doc([(595, HEIGHT)], items))
    return decompose_pdf(make_pdf([Page(runs)]), layout=layout, cropper=FakeCropper()).document


def test_lines_drawn_at_another_scale_stay_apart() -> None:
    # The first line's font is 320 points, shrunk 20 times: it is 16-point type, as the others.
    runs = [
        Run("Final version", 250, 480, size=16, scale=0.05),
        Run("Adopted on 1 November 2023", 226, 500, size=16),
        Run("Currently under consultation", 211, 520, size=16),
    ]
    doc = read(runs, [bl(205, 464, 500, 526)])
    assert paragraphs(doc) == [
        "Final version Adopted on 1 November 2023 Currently under consultation"
    ]


@pytest.mark.parametrize(
    ("angle", "x", "y", "box"),
    [
        (90, 500, 600, bl(488, 490, 504, 604)),  # up the side of a figure, from its foot
        (270, 300, 300, bl(296, 296, 312, 410)),  # down it, from its top
    ],
)
def test_text_that_runs_up_or_down_reads_in_order(
    angle: int, x: float, y: float, box: docling.Box
) -> None:
    runs = [Run("A paragraph of text.", 72, 100), Run("Risk Management", x, y, angle=angle)]
    doc = read(runs, [bl(70, 88, 400, 104), box])
    assert paragraphs(doc) == ["A paragraph of text.", "Risk Management"]


def test_labels_printed_over_each_other_are_two_lines() -> None:
    runs = [Run("Water", 470, 405, size=9), Run("Tablet", 465, 409, size=9)]
    doc = read(runs, [bl(460, 396, 520, 412)])
    assert paragraphs(doc) == ["Water Tablet"]


def test_a_subscript_beside_its_word_stays_in_its_line() -> None:
    # "(d" at 10 points, "50" lowered at 6.6 points, then ")": Helvetica's widths place them.
    runs = [Run("(d", 400, 525, size=10), Run("50", 408.9, 528.6, size=6.6), Run(")", 416.3, 525)]
    doc = read(runs, [bl(395, 514, 430, 531)])
    assert paragraphs(doc) == ["(d50)"]


def test_a_subscript_on_a_page_drawn_at_font_size_1_stays_in_its_line() -> None:
    # C at 12 points, "max" lowered 0.9 points at 8, as matrices on fonts set at 1 point.
    runs = [
        Run("AUC, C", 300, 525, size=12, scale=12),
        Run("max", 341.6, 525.9, size=8, scale=8),
        Run(", body", 355, 525, size=12, scale=12),
    ]
    doc = read(runs, [bl(295, 512, 420, 530)])
    assert paragraphs(doc) == ["AUC, Cmax, body"]


def test_a_word_printed_twice_in_one_place_is_read_once() -> None:
    # drawn apart: pdfium merges a copy drawn soon after the first itself
    between = [Run(word, 72, 400 + 12 * k) for k, word in enumerate(("One", "Two", "Six", "Ten"))]
    runs = [Run("Drying", 231, 328), Run("granules", 270, 328), *between, Run("Drying", 231, 328)]
    doc = read(runs, [bl(225, 318, 330, 332), bl(70, 388, 120, 440)])
    assert paragraphs(doc) == ["Drying granules", "One Two Six Ten"]
