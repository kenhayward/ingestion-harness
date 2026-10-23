"""Pictures and drawings in a Word document's flow, as images of the decomposed document.

A picture (`pic:pic` with an embedded blip) keeps its bytes when they are PNG or JPEG, judged by
their magic bytes; EMF, WMF and other formats are rendered to PNG through the `Renderer`, with
the original kept. A drawing (shape, group, canvas, SmartArt, chart, VML or OLE object) is
rendered from a fragment holding it, falling back to the picture stored beside it, and its own
text becomes the image's alt text so no text is lost. Anything that cannot be turned into an
image fails the document.
"""

from __future__ import annotations

import io
import posixpath
import re
from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Literal
from xml.etree import ElementTree
from xml.etree.ElementTree import Element
from xml.sax.saxutils import quoteattr

from PIL import Image as PILImage
from PIL import UnidentifiedImageError

from .ids import child_id
from .model import Equation, Flag, Image, ImageBlock, InlineImage
from .package import DecompositionFailed, Package, Rel
from .render import _NAMESPACES, Renderer, RenderFragment

if TYPE_CHECKING:
    from .inline import InlineContext

_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
_R = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
_WP = "{http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing}"
_A = "{http://schemas.openxmlformats.org/drawingml/2006/main}"
_PIC = "{http://schemas.openxmlformats.org/drawingml/2006/picture}"
_MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
_V = "{urn:schemas-microsoft-com:vml}"
_O = "{urn:schemas-microsoft-com:office:office}"
_C = "{http://schemas.openxmlformats.org/drawingml/2006/chart}"
_DGM = "{http://schemas.openxmlformats.org/drawingml/2006/diagram}"

_PIC_URI = "http://schemas.openxmlformats.org/drawingml/2006/picture"
_PKG_RELS = "http://schemas.openxmlformats.org/package/2006/relationships"
#: Prefixes the fragment's serialised XML keeps, beyond the ones a fragment document declares,
#: so that `mc:Ignorable` lists inside a drawing still name declared prefixes.
_EXTRA_PREFIXES = {
    "wp14": "http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing",
    "a14": "http://schemas.microsoft.com/office/drawing/2010/main",
}
for _prefix, _uri in {**_NAMESPACES, **_EXTRA_PREFIXES}.items():
    ElementTree.register_namespace(_prefix, _uri)

#: Run children that are pictures or drawings.
MEDIA_TAGS = {f"{_W}drawing", f"{_W}pict", f"{_W}object"}
_ALTERNATE = f"{_MC}AlternateContent"
#: Content that is not part of a drawing's text: rejected tracked changes, and the fallback
#: copy of a drawing that is read from its preferred form.
_SKIPPED = {f"{_W}del", f"{_W}moveFrom", f"{_MC}Fallback"}
_PARAGRAPHS = {f"{_W}p", f"{_A}p"}
_TEXT = {f"{_W}t", f"{_A}t"}
_TABS = {f"{_W}tab", f"{_W}ptab"}

_EMU_PER_MM = 36000
_TWIPS_PER_MM = 1440 / 25.4
#: The resolution `ConverterRenderer` renders at, for a drawing whose size is not declared.
_RENDER_DPI = 300
_DEFAULT_PAGE_WIDTH = 12240
_MAX_PAGE_WIDTH = 31680
_DEFAULT_EMU = 914400  # one inch, for a conversion whose size is unknown
_LENGTH = re.compile(r"^\s*([0-9.]+)\s*(pt|in|cm|mm|px|pc)?\s*$")
_MM_PER_UNIT = {"pt": 25.4 / 72, "in": 25.4, "cm": 10.0, "mm": 1.0, "px": 25.4 / 96, "pc": 25.4 / 6}

Align = Literal["left", "center", "right", "inline"]
Origin = Literal["embedded", "converted", "rendered"]
Format = Literal["png", "jpeg", "emf", "wmf", "gif", "bmp", "tiff"]

_CONTENT_TYPES: dict[Format, str] = {
    "png": "image/png",
    "jpeg": "image/jpeg",
    "emf": "image/x-emf",
    "wmf": "image/x-wmf",
    "gif": "image/gif",
    "bmp": "image/bmp",
    "tiff": "image/tiff",
}
_EXTENSIONS: dict[Format, str] = {
    "png": "png",
    "jpeg": "jpg",
    "emf": "emf",
    "wmf": "wmf",
    "gif": "gif",
    "bmp": "bmp",
    "tiff": "tif",
}


def sniff(data: bytes) -> Format | None:
    """An image's format by its magic bytes, or None when it is not one this reader knows."""
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if data.startswith(b"\xff\xd8\xff"):
        return "jpeg"
    if len(data) >= 44 and data[:4] == b"\x01\x00\x00\x00" and data[40:44] == b" EMF":
        return "emf"
    if data.startswith(b"\xd7\xcd\xc6\x9a") or data[:6] in (
        b"\x01\x00\x09\x00\x00\x03",
        b"\x02\x00\x09\x00\x00\x03",
    ):
        return "wmf"
    if data[:6] in (b"GIF87a", b"GIF89a"):
        return "gif"
    if data.startswith(b"BM"):
        return "bmp"
    if data[:4] in (b"II*\x00", b"MM\x00*"):
        return "tiff"
    return None


@dataclass(frozen=True)
class _Picture:
    """An image's bytes as stored, with where they came from."""

    data: bytes
    content_type: Literal["image/png", "image/jpeg"]
    origin: Origin
    original: bytes | None = None
    original_content_type: str | None = None


@dataclass
class MediaContext:
    """The images and equations read so far, the images' bytes and originals (by image id), and
    what is needed to read more: the package, the part being read (for its relationships) and
    the renderer."""

    pkg: Package
    renderer: Renderer
    part: str = "word/document.xml"
    page_width_twips: int = _DEFAULT_PAGE_WIDTH
    styles_xml: bytes | None = None
    images: list[Image] = field(default_factory=list)
    image_bytes: dict[str, bytes] = field(default_factory=dict)
    originals: dict[str, bytes] = field(default_factory=dict)
    equations: list[Equation] = field(default_factory=list)
    _counts: dict[tuple[str, str], int] = field(default_factory=dict)

    @classmethod
    def for_package(cls, pkg: Package, renderer: Renderer) -> MediaContext:
        """A context for the main document part, with its page width and styles."""
        return cls(
            pkg=pkg,
            renderer=renderer,
            page_width_twips=_page_width(pkg),
            styles_xml=pkg.part("word/styles.xml"),
        )

    def new_id(self, at: str, kind: str = "img") -> str:
        """The next id of a `kind` (an image, `img`, or an equation, `eq`) inside the block or
        paragraph `at`."""
        key = (at, kind)
        self._counts[key] = self._counts.get(key, 0) + 1
        return child_id(at, kind, self._counts[key])

    def add(
        self,
        image_id: str,
        picture: _Picture,
        size: tuple[float, float] | None,
        align: Align,
        alt: str | None,
    ) -> Image:
        width, height = size if size is not None else _pixel_size_mm(picture.data, image_id)
        image = Image(
            id=image_id,
            content_type=picture.content_type,
            width_mm=round(width, 2),
            height_mm=round(height, 2),
            align=align,
            alt=alt,
            origin=picture.origin,
            original_content_type=picture.original_content_type,
        )
        self.images.append(image)
        self.image_bytes[image_id] = picture.data
        if picture.original is not None:
            self.originals[image_id] = picture.original
        return image

    def add_rendered(self, image_id: str, png: bytes, align: Align) -> Image:
        """A PNG the renderer made, sized from its pixels, recorded as image `image_id`."""
        return self.add(image_id, _Picture(png, "image/png", "rendered"), None, align, None)

    # -- package --

    def related(self, rel_id: str | None) -> tuple[str, bytes] | None:
        """The package path and bytes an internal relationship of the part points to."""
        if not rel_id:
            return None
        target = self.pkg.target(self.part, rel_id)
        data = self.pkg.part(target) if target is not None else None
        return None if target is None or data is None else (target, data)

    def referenced(self, el: Element) -> tuple[dict[str, bytes], list[tuple[str, str, str]]]:
        """The parts and document relationships a fragment holding `el` needs: every internal
        relationship `el` names, with the parts those parts relate to in turn."""
        parts: dict[str, bytes] = {}
        rels: list[tuple[str, str, str]] = []
        own = self.pkg.rels(self.part)
        for rel_id in dict.fromkeys(_rel_ids(el)):
            rel = own.get(rel_id)
            found = self.related(rel_id)
            if rel is None or found is None:
                continue
            target, data = found
            parts[target] = data
            rels.append((rel_id, rel.type, posixpath.relpath(target, "word")))
            kept: list[Rel] = []
            for sub in self.pkg.rels(target).values():
                sub_target = self.pkg.target(target, sub.id)  # None when external
                sub_data = self.pkg.part(sub_target) if sub_target is not None else None
                if sub_target is not None and sub_data is not None:
                    parts[sub_target] = sub_data
                    kept.append(sub)
            if kept:
                directory, base = posixpath.split(target)
                parts[posixpath.join(directory, "_rels", f"{base}.rels")] = _rels_xml(kept)
        return parts, rels

    # -- rendering --

    def fragment(
        self, body_xml: str, parts: dict[str, bytes], rels: list[tuple[str, str, str]]
    ) -> RenderFragment:
        return RenderFragment(body_xml, self.page_width_twips, self.styles_xml, parts, rels)

    def as_stored(self, data: bytes, size: tuple[float, float] | None) -> _Picture | None:
        """`data` as a PNG or JPEG: kept when it is one, else rendered to PNG; None if it
        could not be."""
        fmt = sniff(data)
        if fmt == "png":
            return _Picture(data, "image/png", "embedded")
        if fmt == "jpeg":
            return _Picture(data, "image/jpeg", "embedded")
        if fmt is None:
            return None
        cx, cy = (
            (round(size[0] * _EMU_PER_MM), round(size[1] * _EMU_PER_MM))
            if size is not None
            else (_DEFAULT_EMU, _DEFAULT_EMU)
        )
        name = f"media/source.{_EXTENSIONS[fmt]}"
        body = _picture_xml("rIdSource", max(cx, 1), max(cy, 1))
        png = self.renderer.render(
            self.fragment(body, {f"word/{name}": data}, [("rIdSource", "image", name)])
        )
        if png is None:
            return None
        return _Picture(png, "image/png", "converted", data, _CONTENT_TYPES[fmt])

    # -- text --

    def drawing_lines(self, el: Element) -> Iterator[str]:
        """The text of a drawing, one paragraph (or chart value) per line, in reading order."""
        for child in el:
            tag = child.tag
            if tag in _SKIPPED:
                continue
            if tag in _PARAGRAPHS:
                nested: list[str] = []
                line = "".join(self._paragraph_text(child, nested))
                if line.strip():
                    yield line
                yield from nested
            elif tag == f"{_C}v":
                if (child.text or "").strip():
                    yield child.text or ""
            elif tag == f"{_C}chart" and child.get(f"{_R}id"):
                yield from self._part_lines(child.get(f"{_R}id"))
            elif tag == f"{_DGM}relIds":
                yield from self._part_lines(child.get(f"{_R}dm"))
            else:
                yield from self.drawing_lines(child)

    def _paragraph_text(self, el: Element, nested: list[str]) -> Iterator[str]:
        """The text of a paragraph; the lines of a drawing inside it go to `nested`."""
        for child in el:
            tag = child.tag
            if tag in _SKIPPED:
                continue
            if tag in _TEXT:
                yield child.text or ""
            elif tag in _TABS:
                yield " "
            elif tag in MEDIA_TAGS or tag == _ALTERNATE:
                nested.extend(self.drawing_lines(child))
            else:
                yield from self._paragraph_text(child, nested)

    def _part_lines(self, rel_id: str | None) -> Iterator[str]:
        found = self.related(rel_id)
        if found is None:
            return
        root = self.pkg.xml(found[0])
        if root is not None:
            yield from self.drawing_lines(root)


# --- Reading ---------------------------------------------------------------------------------


def is_media(run_child: Element) -> bool:
    """Whether a run's child is a picture or drawing (possibly in markup-compatibility form)."""
    return run_child.tag in MEDIA_TAGS or (
        run_child.tag == _ALTERNATE and _choose(run_child)[0] is not None
    )


def media_of(
    run_child: Element,
    ctx: InlineContext,
    *,
    at: str,
    in_text: bool,
    paragraph: Element | None = None,
) -> InlineImage | ImageBlock | None:
    """The image a run's picture or drawing becomes, recorded in `ctx.media`.

    In text it is an `InlineImage`; alone in its paragraph it is an `ImageBlock` with id `at`,
    aligned as `paragraph` is. `at` is also where flags are raised and what the image id is
    made from. None when `run_child` holds no picture or drawing.
    """
    media = ctx.media
    if media is None:
        raise DecompositionFailed("pictures and drawings need a media context", at)
    el, fallback = _choose(run_child)
    if el is None:
        return None
    align: Align = "inline" if in_text else _paragraph_align(paragraph)
    image_id = media.new_id(at)
    if el.tag == f"{_W}drawing":
        image = _read_drawing(el, fallback, media, ctx, at=at, image_id=image_id, align=align)
    else:
        size = _vml_size_mm(el)
        image = _render(el, el, media, ctx, at=at, image_id=image_id, align=align, size=size)
    if in_text:
        return InlineImage(image_id=image.id)
    return ImageBlock(id=at, image_id=image.id)


def _choose(run_child: Element) -> tuple[Element | None, Element | None]:
    """The picture or drawing to read, and the element holding its fallback picture, if any."""
    if run_child.tag in MEDIA_TAGS:
        return run_child, None
    if run_child.tag != _ALTERNATE:
        return None, None
    fallback = run_child.find(f"{_MC}Fallback")
    for choice in run_child.findall(f"{_MC}Choice"):
        for child in choice:
            if child.tag in MEDIA_TAGS:
                return child, fallback
    if fallback is not None:
        for child in fallback:
            if child.tag in MEDIA_TAGS:
                return child, child
    return None, None


def _read_drawing(
    el: Element,
    fallback: Element | None,
    media: MediaContext,
    ctx: InlineContext,
    *,
    at: str,
    image_id: str,
    align: Align,
) -> Image:
    container = el.find(f"{_WP}inline")
    if container is None:
        container = el.find(f"{_WP}anchor")
    if container is not None and container.tag == f"{_WP}anchor":
        _flag(
            ctx, "image_floating_anchored", at, f"floating image {image_id} placed at its paragraph"
        )
    size = _extent_mm(container)
    alt = _doc_pr_alt(container)
    data = container.find(f"{_A}graphic/{_A}graphicData") if container is not None else None
    pic = data.find(f"{_PIC}pic") if data is not None else None
    if pic is not None:
        blip = pic.find(f".//{_A}blip")
        found = media.related(blip.get(f"{_R}embed") if blip is not None else None)
        if found is not None:
            picture = media.as_stored(found[1], size)
            if picture is None:
                raise DecompositionFailed(f"image {image_id} could not be converted", at)
            if picture.origin == "converted":
                _flag(ctx, "image_converted", at, f"image {image_id} converted to PNG")
            return media.add(image_id, picture, size, align, alt)
        # A linked or missing picture is not fetched: what Word drew for it is rendered.
    return _render(
        el, fallback, media, ctx, at=at, image_id=image_id, align=align, size=size, alt=alt
    )


def _render(
    el: Element,
    fallback: Element | None,
    media: MediaContext,
    ctx: InlineContext,
    *,
    at: str,
    image_id: str,
    align: Align,
    size: tuple[float, float] | None,
    alt: str | None = None,
) -> Image:
    """A drawing rendered from a fragment holding it, else its stored fallback picture; its
    text, when it has any, is the alt text."""
    text = "\n".join(media.drawing_lines(el))
    alt = text or alt
    parts, rels = media.referenced(el)
    body = f"<w:p><w:r>{ElementTree.tostring(el, encoding='unicode')}</w:r></w:p>"
    png = media.renderer.render(media.fragment(body, parts, rels))
    if png is not None:
        _flag(ctx, "drawing_rendered", at, f"drawing rendered to image {image_id}")
        return media.add(image_id, _Picture(png, "image/png", "rendered"), size, align, alt)
    found = media.related(_fallback_rel(fallback)) if fallback is not None else None
    picture = media.as_stored(found[1], size) if found is not None else None
    if picture is None:
        raise DecompositionFailed(f"drawing at {at} could not be rendered", at)
    _flag(
        ctx,
        "drawing_rendered",
        at,
        f"drawing could not be rendered; its stored picture is image {image_id}",
    )
    if picture.origin == "converted":
        _flag(ctx, "image_converted", at, f"image {image_id} converted to PNG")
    return media.add(image_id, picture, size, align, alt)


# --- Helpers ---------------------------------------------------------------------------------


def _flag(
    ctx: InlineContext,
    code: Literal["image_floating_anchored", "image_converted", "drawing_rendered"],
    at: str,
    message: str,
) -> None:
    severity: Literal["info", "warning"] = "warning" if code == "drawing_rendered" else "info"
    ctx.flags.append(Flag(code=code, severity=severity, at=at, message=message))


def _paragraph_align(paragraph: Element | None) -> Align:
    jc = paragraph.find(f"{_W}pPr/{_W}jc") if paragraph is not None else None
    value = jc.get(f"{_W}val") if jc is not None else None
    if value == "center":
        return "center"
    if value in ("right", "end"):
        return "right"
    return "left"


def _extent_mm(container: Element | None) -> tuple[float, float] | None:
    extent = container.find(f"{_WP}extent") if container is not None else None
    if extent is None:
        return None
    try:
        cx, cy = int(extent.get("cx", "")), int(extent.get("cy", ""))
    except ValueError:
        return None
    if cx <= 0 or cy <= 0:
        return None
    return cx / _EMU_PER_MM, cy / _EMU_PER_MM


def _vml_size_mm(el: Element) -> tuple[float, float] | None:
    """A VML shape's size from its `style`, or an OLE object's original size in twips."""
    for shape in el.iter():
        style = shape.get("style")
        if not style:
            continue
        props = dict(
            (k.strip().lower(), v) for k, _, v in (p.partition(":") for p in style.split(";"))
        )
        width, height = _length_mm(props.get("width")), _length_mm(props.get("height"))
        if width and height:
            return width, height
    try:
        dxa, dya = int(el.get(f"{_W}dxaOrig", "")), int(el.get(f"{_W}dyaOrig", ""))
    except ValueError:
        return None
    return (dxa / _TWIPS_PER_MM, dya / _TWIPS_PER_MM) if dxa > 0 and dya > 0 else None


def _length_mm(value: str | None) -> float | None:
    match = _LENGTH.match(value or "")
    if match is None:
        return None
    try:
        number = float(match.group(1))
    except ValueError:
        return None
    return number * _MM_PER_UNIT[match.group(2) or "px"] or None


def _pixel_size_mm(data: bytes, image_id: str) -> tuple[float, float]:
    """An image's size from its pixels, at its own resolution or the renderer's."""
    try:
        with PILImage.open(io.BytesIO(data)) as img:
            width, height = img.size
            dpi = img.info.get("dpi", (_RENDER_DPI, _RENDER_DPI))
    except (UnidentifiedImageError, OSError) as exc:
        raise DecompositionFailed(f"image {image_id} is unreadable") from exc
    x_dpi, y_dpi = (float(d) or _RENDER_DPI for d in dpi)
    return width / x_dpi * 25.4, height / y_dpi * 25.4


def _doc_pr_alt(container: Element | None) -> str | None:
    doc_pr = container.find(f"{_WP}docPr") if container is not None else None
    if doc_pr is None:
        return None
    return (doc_pr.get("descr") or "").strip() or (doc_pr.get("title") or "").strip() or None


def _rels_xml(rels: list[Rel]) -> bytes:
    """A `.rels` part listing `rels`, all internal, so a fragment never links outside itself."""
    items = "".join(
        f"<Relationship Id={quoteattr(r.id)} Type={quoteattr(r.type)} "
        f"Target={quoteattr(r.target)}/>"
        for r in rels
    )
    return f'<Relationships xmlns="{_PKG_RELS}">{items}</Relationships>'.encode()


def _rel_ids(el: Element) -> Iterator[str]:
    for node in el.iter():
        for key, value in node.attrib.items():
            if key.startswith(_R) or key == f"{_O}relid":
                yield value


def _fallback_rel(fallback: Element) -> str | None:
    """The relationship id of the picture stored as a drawing's fallback."""
    for node in fallback.iter():
        if node.tag == f"{_A}blip" and (rid := node.get(f"{_R}embed")):
            return rid
        if node.tag == f"{_V}imagedata" and (rid := node.get(f"{_R}id") or node.get(f"{_O}relid")):
            return rid
    return None


def _picture_xml(rel_id: str, cx: int, cy: int) -> str:
    """A paragraph holding one inline picture of the given size, for converting its image."""
    return (
        f'<w:p><w:r><w:drawing><wp:inline><wp:extent cx="{cx}" cy="{cy}"/>'
        '<wp:docPr id="1" name="Picture"/><a:graphic>'
        f'<a:graphicData uri="{_PIC_URI}"><pic:pic><pic:nvPicPr><pic:cNvPr id="1" name="Picture"/>'
        f'<pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="{rel_id}"/><a:stretch>'
        '<a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/>'
        f'<a:ext cx="{cx}" cy="{cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom>'
        "</pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"
    )


def _page_width(pkg: Package) -> int:
    """The page width of the document's last section, in twips."""
    document = pkg.xml("word/document.xml")
    size = document.find(f"{_W}body/{_W}sectPr/{_W}pgSz") if document is not None else None
    try:
        width = int(size.get(f"{_W}w", "")) if size is not None else _DEFAULT_PAGE_WIDTH
    except ValueError:
        return _DEFAULT_PAGE_WIDTH
    return width if 0 < width <= _MAX_PAGE_WIDTH else _DEFAULT_PAGE_WIDTH
