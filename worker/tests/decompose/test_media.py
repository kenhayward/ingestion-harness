"""Pictures, figures and rendered drawings in the decomposed document."""

from __future__ import annotations

import io

import pytest
from PIL import Image as PILImage

from ingest_worker.decompose.body import walk_body
from ingest_worker.decompose.inline import InlineContext, RunStyles
from ingest_worker.decompose.media import MediaContext
from ingest_worker.decompose.model import (
    Block,
    Figure,
    ImageBlock,
    InlineImage,
    Paragraph,
    Table,
    Text,
)
from ingest_worker.decompose.package import DecompositionFailed, open_package
from tests.decompose.docx import build_docx
from tests.decompose.fakes import FakeRenderer
from tests.decompose.test_tables import tbl, tr

_PIC_URI = "http://schemas.openxmlformats.org/drawingml/2006/picture"
_WPS_URI = "http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
CHART_URI = "http://schemas.openxmlformats.org/drawingml/2006/chart"
_DGM_URI = "http://schemas.openxmlformats.org/drawingml/2006/diagram"


def _image(fmt: str) -> bytes:
    buf = io.BytesIO()
    PILImage.new("RGB", (4, 4), "red").save(buf, format=fmt)
    return buf.getvalue()


PNG = _image("PNG")
JPEG = _image("JPEG")
#: An EMF header record: type 1, then the " EMF" signature at offset 40.
EMF = b"\x01\x00\x00\x00" + b"\x00" * 36 + b" EMF" + b"\x00" * 64

# --- Builders --------------------------------------------------------------------------------


def _doc_pr(descr: str | None, title: str | None) -> str:
    attrs = "".join(
        f' {name}="{value}"' for name, value in (("descr", descr), ("title", title)) if value
    )
    return f'<wp:docPr id="1" name="Object 1"{attrs}/>'


def drawing(
    graphic: str,
    *,
    uri: str = _PIC_URI,
    cx: int = 914400,
    cy: int = 914400,
    descr: str | None = None,
    title: str | None = None,
    anchor: bool = False,
) -> str:
    container = "wp:anchor" if anchor else "wp:inline"
    return (
        f'<w:drawing><{container}><wp:extent cx="{cx}" cy="{cy}"/>{_doc_pr(descr, title)}'
        f'<a:graphic><a:graphicData uri="{uri}">{graphic}</a:graphicData></a:graphic>'
        f"</{container}></w:drawing>"
    )


def picture(rid: str = "rIdImg", **kwargs: object) -> str:
    graphic = f'<pic:pic><pic:blipFill><a:blip r:embed="{rid}"/></pic:blipFill></pic:pic>'
    return drawing(graphic, **kwargs)  # type: ignore[arg-type]


def text_box(*lines: str) -> str:
    paragraphs = "".join(f"<w:p><w:r><w:t>{line}</w:t></w:r></w:p>" for line in lines)
    return drawing(
        f"<wps:wsp><wps:txbx><w:txbxContent>{paragraphs}</w:txbxContent></wps:txbx></wps:wsp>",
        uri=_WPS_URI,
    )


def alternate(choice: str, fallback: str) -> str:
    return (
        f'<mc:AlternateContent><mc:Choice Requires="wps">{choice}</mc:Choice>'
        f"<mc:Fallback>{fallback}</mc:Fallback></mc:AlternateContent>"
    )


def run(inner: str) -> str:
    return f"<w:r>{inner}</w:r>"


def text_run(text: str) -> str:
    return f'<w:r><w:t xml:space="preserve">{text}</w:t></w:r>'


def para(*runs: str, jc: str | None = None, style: str | None = None) -> str:
    props = ""
    if jc or style:
        props = "<w:pPr>"
        props += f'<w:pStyle w:val="{style}"/>' if style else ""
        props += f'<w:jc w:val="{jc}"/>' if jc else ""
        props += "</w:pPr>"
    return f"<w:p>{props}{''.join(runs)}</w:p>"


def cell(*paragraphs: str) -> str:
    return f"<w:tc><w:tcPr/>{''.join(paragraphs)}</w:tc>"


IMAGE_REL = [("rIdImg", "image", "media/image1.png")]


def read(
    body: str,
    *,
    media: dict[str, bytes] | None = None,
    rels: list[tuple[str, str, str]] | None = None,
    extra_parts: dict[str, bytes] | None = None,
    renderer: FakeRenderer | None = None,
) -> tuple[list[Block], InlineContext, MediaContext]:
    pkg = open_package(
        build_docx(
            body,
            media={"image1.png": PNG} if media is None else media,
            rels=IMAGE_REL if rels is None else rels,
            extra_parts=extra_parts,
        )
    )
    mctx = MediaContext.for_package(pkg, renderer or FakeRenderer())
    ctx = InlineContext(styles=RunStyles.from_xml(pkg.xml("word/styles.xml")), media=mctx)
    blocks, _ = walk_body(pkg, ctx)
    return blocks, ctx, mctx


def flags(ctx: InlineContext) -> list[tuple[str, str | None]]:
    return [(f.code, f.at) for f in ctx.flags]


# --- Pictures --------------------------------------------------------------------------------


def test_inline_picture_size_and_alt() -> None:
    body = para(run(picture(cx=3448050, cy=4876800, descr="Vial", title="Ignored")))
    blocks, _, media = read(body)
    [image] = media.images
    assert (image.width_mm, image.height_mm) == (95.78, 135.47)
    assert image.alt == "Vial"
    assert (image.content_type, image.origin) == ("image/png", "embedded")
    assert media.image_bytes[image.id] == PNG
    assert media.originals == {}
    assert blocks == [ImageBlock(id="s-0#image-1", image_id=image.id)]


def test_alt_falls_back_to_title() -> None:
    _, _, media = read(para(run(picture(title="Closure"))))
    assert media.images[0].alt == "Closure"


def test_content_type_from_magic_bytes_not_extension() -> None:
    _, _, media = read(para(run(picture())), media={"image1.png": JPEG})
    assert media.images[0].content_type == "image/jpeg"


def test_centered_picture_alone_is_block() -> None:
    blocks, _, media = read(para(run(picture()), jc="center"))
    [image] = media.images
    assert blocks == [ImageBlock(id="s-0#image-1", image_id=image.id)]
    assert image.align == "center"


def test_picture_with_text_is_inline() -> None:
    blocks, _, media = read(para(text_run("See "), run(picture()), text_run(" here"), jc="center"))
    [image] = media.images
    assert blocks == [
        Paragraph(
            id="s-0#p-1",
            inlines=[Text(text="See "), InlineImage(image_id=image.id), Text(text=" here")],
        )
    ]
    assert image.align == "inline"


def test_picture_in_table_cell() -> None:
    body = tbl(
        tr(cell(para(run(picture()), jc="right"))), tr(cell(para(text_run("x")))), cols=[4000]
    )
    blocks, _, media = read(body)
    [table] = blocks
    assert isinstance(table, Table)
    [image] = media.images
    [block] = table.rows[0].cells[0].blocks
    assert block == ImageBlock(id=block.id, image_id=image.id)
    assert image.align == "right"


def test_anchored_picture_placed_at_paragraph_and_flagged() -> None:
    blocks, ctx, media = read(para(text_run("Before")) + para(run(picture(anchor=True))))
    assert [type(b) for b in blocks] == [Paragraph, ImageBlock]
    assert blocks[1] == ImageBlock(id="s-0#image-1", image_id=media.images[0].id)
    assert ("image_floating_anchored", "s-0#image-1") in flags(ctx)


def test_emf_converted_and_original_kept() -> None:
    renderer = FakeRenderer()
    _, ctx, media = read(
        para(run(picture())),
        media={"image1.emf": EMF},
        rels=[("rIdImg", "image", "media/image1.emf")],
        renderer=renderer,
    )
    [image] = media.images
    assert (image.content_type, image.origin) == ("image/png", "converted")
    assert image.original_content_type == "image/x-emf"
    assert media.image_bytes[image.id] == renderer.png
    assert media.originals[image.id] == EMF
    [fragment] = renderer.fragments
    assert list(fragment.parts.values()) == [EMF]
    assert ("image_converted", "s-0#image-1") in flags(ctx)


def test_emf_conversion_failure_fails_document() -> None:
    with pytest.raises(DecompositionFailed, match=r"image .* could not be converted"):
        read(
            para(run(picture())),
            media={"image1.emf": EMF},
            rels=[("rIdImg", "image", "media/image1.emf")],
            renderer=FakeRenderer(fails=True),
        )


def test_external_picture_is_rendered_as_a_drawing() -> None:
    renderer = FakeRenderer()
    _, _, media = read(
        para(run(picture())),
        media={},
        rels=[("rIdImg", "image", "https://example.invalid/a.png")],
        renderer=renderer,
    )
    assert media.images[0].origin == "rendered"
    assert len(renderer.fragments) == 1
    assert renderer.fragments[0].parts == {}


def test_external_picture_that_cannot_render_fails_document() -> None:
    with pytest.raises(DecompositionFailed, match="drawing at s-0#image-1 could not be rendered"):
        read(
            para(run(picture())),
            media={},
            rels=[("rIdImg", "image", "https://example.invalid/a.png")],
            renderer=FakeRenderer(fails=True),
        )


# --- Drawings --------------------------------------------------------------------------------

VML_FALLBACK = (
    '<w:pict><v:shape style="width:72pt;height:36pt"><v:imagedata r:id="rIdImg"/>'
    "<v:textbox><w:txbxContent><w:p><w:r><w:t>Line one</w:t></w:r></w:p>"
    "<w:p><w:r><w:t>Line two</w:t></w:r></w:p></w:txbxContent></v:textbox></v:shape></w:pict>"
)


def test_text_box_rendered_with_text_as_alt() -> None:
    renderer = FakeRenderer()
    blocks, ctx, media = read(
        para(run(alternate(text_box("Line one", "Line two"), VML_FALLBACK))), renderer=renderer
    )
    assert len(renderer.fragments) == 1
    assert "wps:wsp" in renderer.fragments[0].body_xml
    [image] = media.images
    assert image.alt == "Line one\nLine two"
    assert (image.origin, image.content_type) == ("rendered", "image/png")
    assert media.image_bytes[image.id] == renderer.png
    assert blocks == [ImageBlock(id="s-0#image-1", image_id=image.id)]
    assert ("drawing_rendered", "s-0#image-1") in flags(ctx)


def test_render_failure_uses_fallback_picture() -> None:
    _, ctx, media = read(
        para(run(alternate(text_box("Line one", "Line two"), VML_FALLBACK))),
        renderer=FakeRenderer(fails=True),
    )
    [image] = media.images
    assert media.image_bytes[image.id] == PNG
    assert image.alt == "Line one\nLine two"
    assert ("drawing_rendered", "s-0#image-1") in flags(ctx)


def test_render_failure_without_fallback_fails_document() -> None:
    with pytest.raises(DecompositionFailed, match="drawing at s-0#image-1 could not be rendered"):
        read(para(run(text_box("Alone"))), renderer=FakeRenderer(fails=True))


def test_vml_picture_is_rendered_with_its_size() -> None:
    renderer = FakeRenderer()
    _, _, media = read(para(run(VML_FALLBACK)), renderer=renderer)
    [image] = media.images
    assert (image.width_mm, image.height_mm) == (25.4, 12.7)
    assert image.alt == "Line one\nLine two"
    assert "media/image1.png" in [target for _, _, target in renderer.fragments[0].rels]


def test_drawing_inline_with_text() -> None:
    blocks, _, media = read(para(text_run("Shape: "), run(text_box("Inside"))))
    [image] = media.images
    assert blocks == [
        Paragraph(id="s-0#p-1", inlines=[Text(text="Shape: "), InlineImage(image_id=image.id)])
    ]
    assert image.align == "inline"


CHART = (
    f'<c:chartSpace xmlns:c="{CHART_URI}" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><c:chart>'
    "<c:title><c:tx><c:rich><a:p><a:r><a:t>Assay over time</a:t></a:r></a:p></c:rich></c:tx>"
    "</c:title><c:plotArea><c:barChart><c:ser><c:tx><c:strRef><c:f>S!B1</c:f><c:strCache>"
    "<c:pt idx='0'><c:v>Lot A</c:v></c:pt></c:strCache></c:strRef></c:tx>"
    "<c:val><c:numRef><c:numCache><c:pt idx='0'><c:v>99.5</c:v></c:pt></c:numCache>"
    "</c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>"
).encode()


def test_chart_text_as_alt() -> None:
    renderer = FakeRenderer()
    graphic = '<c:chart r:id="rIdChart"/>'
    _, _, media = read(
        para(run(drawing(graphic, uri=CHART_URI))),
        rels=[("rIdChart", "chart", "charts/chart1.xml")],
        extra_parts={"word/charts/chart1.xml": CHART},
        renderer=renderer,
    )
    assert media.images[0].alt == "Assay over time\nLot A\n99.5"
    assert renderer.fragments[0].parts == {"word/charts/chart1.xml": CHART}


DIAGRAM_DATA = (
    f'<dgm:dataModel xmlns:dgm="{_DGM_URI}" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><dgm:ptLst>'
    '<dgm:pt modelId="1"><dgm:t><a:p><a:r><a:t>Plan</a:t></a:r></a:p></dgm:t></dgm:pt>'
    '<dgm:pt modelId="2"><dgm:t><a:p><a:r><a:t>Do</a:t></a:r></a:p></dgm:t></dgm:pt>'
    "</dgm:ptLst></dgm:dataModel>"
).encode()


def test_smartart_text_as_alt() -> None:
    graphic = '<dgm:relIds r:dm="rIdData" r:lo="rIdLo" r:qs="rIdQs" r:cs="rIdCs"/>'
    _, _, media = read(
        para(run(drawing(graphic, uri=_DGM_URI))),
        rels=[("rIdData", "diagramData", "diagrams/data1.xml")],
        extra_parts={"word/diagrams/data1.xml": DIAGRAM_DATA},
    )
    assert media.images[0].alt == "Plan\nDo"


# --- Figures ---------------------------------------------------------------------------------


def test_figure_with_caption() -> None:
    body = para(run(picture()), jc="center") + para(
        text_run("Figure 1- Container Closure"), style="Caption"
    )
    blocks, ctx, media = read(body)
    [image] = media.images
    assert blocks == [
        Figure(
            id="s-0#image-1",
            image_id=image.id,
            numbered=True,
            caption=[Text(text="Container Closure")],
            caption_position="below",
        )
    ]
    assert ctx.caption_number_map[("figure", "1")] == "s-0#image-1"


def test_image_ids_are_deterministic() -> None:
    body = para(run(picture())) + para(text_run("a "), run(picture()), run(picture()))
    first = read(body)[2].images
    second = read(body)[2].images
    assert [i.id for i in first] == [i.id for i in second]
    assert len({i.id for i in first}) == 3


def test_fragment_keeps_only_internal_relationships_of_related_parts() -> None:
    chart_rels = (
        b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        b'<Relationship Id="rIdPic" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
        b'relationships/image" Target="../media/image1.png"/>'
        b'<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
        b'relationships/oleObject" Target="https://example.invalid/book.xlsx" '
        b'TargetMode="External"/></Relationships>'
    )
    renderer = FakeRenderer()
    read(
        para(run(drawing('<c:chart r:id="rIdChart"/>', uri=CHART_URI))),
        rels=[("rIdChart", "chart", "charts/chart1.xml")],
        extra_parts={
            "word/charts/chart1.xml": CHART,
            "word/charts/_rels/chart1.xml.rels": chart_rels,
        },
        renderer=renderer,
    )
    parts = renderer.fragments[0].parts
    assert parts["word/media/image1.png"] == PNG
    kept = parts["word/charts/_rels/chart1.xml.rels"].decode()
    assert "rIdPic" in kept and "example.invalid" not in kept
