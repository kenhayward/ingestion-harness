"""Bullets the layout analysis took for pictures, given back to their list items.

Docling sometimes labels a bullet glyph a picture of its own, beside the text item for the line it
starts: it would be cropped to an image of a dot, flagged as a rendered drawing, and its item read
as a paragraph. So a small picture on a born-digital page with no image object under it, whose
text-layer chars are only bullets, joins the body text item that starts just to its right on the
same line: that item takes in its box and becomes a list item, whose marker the build drops. With
no such item beside it, the picture stays as it is.
"""

from __future__ import annotations

from ingest_worker.decompose.pdf.layout import (
    BBox,
    LayoutDoc,
    LayoutItem,
    LayoutPicture,
    LayoutText,
)
from ingest_worker.decompose.pdf.textlayer import PageText, TextLayer

#: The glyphs a list marker may be made of (build.py's `_MARKER` drops them).
_BULLETS = frozenset("•●○▪■")
#: A bullet's picture is at most this many points wide and high.
_SMALL = 24.0
#: The item's text starts at most this many points to the right of the bullet.
_GAP = 36.0
#: The labels of a text item a bullet can start.
_BODY = frozenset({"text", "paragraph", "list_item"})


def bullets_from_pictures(layout: LayoutDoc, text: TextLayer) -> LayoutDoc:
    """The layout with each picture that is only a bullet dropped, and the text item it starts
    widened over it and made a list item."""
    pages = {p.index: p for p in text.pages if p.kind == "born_digital"}
    joined: dict[str, BBox] = {}
    dropped: set[str] = set()
    for item in layout.items:
        page = pages.get(item.page)
        if isinstance(item, LayoutPicture) and page is not None and _bullet(item, page):
            beside = _beside(item, layout.items)
            if beside is not None:
                joined[beside.ref] = _union(joined.get(beside.ref, beside.bbox), item.bbox)
                dropped.add(item.ref)
    if not dropped:
        return layout
    items: list[LayoutItem] = []
    for item in layout.items:
        if item.ref in dropped:
            continue
        if isinstance(item, LayoutText) and item.ref in joined:
            item = LayoutText(
                item.ref,
                "list_item",
                item.page,
                joined[item.ref],
                item.level,
                item.layer,
                item.group,
            )
        items.append(item)
    return LayoutDoc(tuple(items))


def _bullet(picture: LayoutPicture, page: PageText) -> bool:
    x0, y0, x1, y1 = picture.bbox
    if x1 - x0 > _SMALL or y1 - y0 > _SMALL:
        return False
    if any(_overlap(picture.bbox, image) for image in page.images):
        return False
    chars = [
        c.text
        for c in page.chars
        if c.text.strip() and x0 <= (c.x0 + c.x1) / 2 <= x1 and y0 <= (c.y0 + c.y1) / 2 <= y1
    ]
    return bool(chars) and all(ch in _BULLETS for c in chars for ch in c)


def _beside(picture: LayoutPicture, items: tuple[LayoutItem, ...]) -> LayoutText | None:
    """The nearest body text item on the picture's line that starts just to its right."""
    mid = (picture.bbox[1] + picture.bbox[3]) / 2
    found = [
        i
        for i in items
        if isinstance(i, LayoutText)
        and i.page == picture.page
        and i.layer == "body"
        and i.label in _BODY
        and i.bbox[1] <= mid <= i.bbox[3]
        and picture.bbox[0] <= i.bbox[0] <= picture.bbox[2] + _GAP
    ]
    return min(found, key=lambda i: i.bbox[0], default=None)


def _overlap(a: BBox, b: BBox) -> bool:
    return min(a[2], b[2]) > max(a[0], b[0]) and min(a[3], b[3]) > max(a[1], b[1])


def _union(a: BBox, b: BBox) -> BBox:
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))
