"""Bullets the layout analysis took for pictures, given back to their list items."""

from __future__ import annotations

from ingest_worker.decompose.model import ListBlock
from ingest_worker.decompose.pdf import decompose_pdf
from ingest_worker.decompose.pdf.bullets import bullets_from_pictures
from ingest_worker.decompose.pdf.layout import LayoutPicture, LayoutText, parse_docling
from ingest_worker.decompose.pdf.textlayer import read_text_layer
from tests.decompose.pdf import docling
from tests.decompose.pdf.fakes import FakeCropper, FakeLayout
from tests.decompose.pdf.make_pdf import Img, Page, Run, make_pdf

HEIGHT = 842.0
ITEM = "A targeted stability study of the product."


def bl(x0: float, y0: float, x1: float, y1: float) -> docling.Box:
    return (x0, HEIGHT - y0, x1, HEIGHT - y1)


def page(**kwargs: object) -> Page:
    """A paragraph, then a bulleted line: the bullet at x=91, its text from x=108."""
    runs = [Run("The applicant should apply a strategy.", 72, 100), Run("•", 91, 130)]
    runs.append(Run(ITEM, 108, 130))
    return Page(runs=runs, **kwargs)  # type: ignore[arg-type]


BULLET = bl(88, 119, 98, 133)


def items(*, picture: docling.Box = BULLET) -> list[dict[str, object]]:
    """Docling's answer: the paragraph, the bullet as a picture of its own, the item as text."""
    return [
        docling.text("text", 1, bl(70, 88, 400, 104)),
        docling.picture(1, picture),
        docling.text("text", 1, bl(106, 119, 400, 134)),
    ]


def recover(p: Page, found: list[dict[str, object]] | None = None) -> list[object]:
    text = read_text_layer(make_pdf([p]))
    layout = parse_docling(docling.doc([(595, HEIGHT)], found or items()))
    return list(bullets_from_pictures(layout, text).items)


def test_a_bullet_taken_for_a_picture_joins_the_text_beside_it() -> None:
    found = recover(page())
    assert not any(isinstance(i, LayoutPicture) for i in found)
    texts = [i for i in found if isinstance(i, LayoutText)]
    assert [t.label for t in texts] == ["text", "list_item"]
    assert texts[1].bbox[0] == 88  # widened over the bullet


def test_a_picture_over_an_image_or_more_than_a_bullet_stays() -> None:
    for p, picture in (
        (page(images=[Img(89, 120, 8, 10)]), BULLET),  # an image object under it
        (page(), bl(88, 119, 160, 133)),  # it takes in some of the item's words too
        (page(), bl(88, 60, 98, 133)),  # too tall for a bullet
    ):
        found = recover(p, items(picture=picture))
        assert sum(isinstance(i, LayoutPicture) for i in found) == 1


def test_a_bullet_with_no_text_beside_it_stays_a_picture() -> None:
    lone = [docling.text("text", 1, bl(70, 88, 400, 104)), docling.picture(1, BULLET)]
    found = recover(page(), lone)
    assert sum(isinstance(i, LayoutPicture) for i in found) == 1


def test_the_item_is_delivered_as_a_list_with_no_image() -> None:
    layout = FakeLayout(lambda first, last: docling.doc([(595, HEIGHT)], items()))
    doc = decompose_pdf(make_pdf([page()]), layout=layout, cropper=FakeCropper()).document
    assert doc.images == []
    assert not any(f.code == "drawing_rendered" for f in doc.report)
    [lst] = [b for b in doc.blocks if isinstance(b, ListBlock)]
    [[para]] = [item.blocks for item in lst.items]
    assert "".join(i.text for i in para.inlines) == ITEM  # type: ignore[union-attr]
