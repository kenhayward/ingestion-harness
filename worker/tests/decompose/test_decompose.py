"""The decomposition entry point: the whole pipeline on one .docx, and its report."""

from __future__ import annotations

import struct
import time
import zlib

import pytest

import ingest_worker.decompose as decompose_module
from ingest_worker.decompose import (
    DECOMPOSER_VERSION,
    Decomposition,
    DecompositionFailed,
    DecompositionRejected,
    decompose_docx,
)
from ingest_worker.decompose.inline import plain_text
from ingest_worker.decompose.model import Figure, Paragraph, Property, Section, Table, Text
from tests.decompose.docx import DEFAULT_STYLES, NAMESPACES, build_docx
from tests.decompose.fakes import FakeRenderer
from tests.decompose.test_captions import cell_with, section_break, sup
from tests.decompose.test_captions import run as text
from tests.decompose.test_media import CHART_URI, EMF, PNG, drawing, picture
from tests.decompose.test_references import field, notes_part
from tests.decompose.test_tables import tbl, tc, tr

IMAGE = {"media": {"image1.png": PNG}, "rels": [("rIdImg", "image", "media/image1.png")]}
DEGREE = '<w:r><w:sym w:font="Symbol" w:char="F0B0"/></w:r>'


def heading(level: int, title: str = "") -> str:
    runs = text(title) if title else ""
    return f'<w:p><w:pPr><w:pStyle w:val="Heading{level}"/></w:pPr>{runs}</w:p>'


def para(*runs: str, jc: str | None = None, style: str | None = None) -> str:
    props = f'<w:pStyle w:val="{style}"/>' if style else ""
    props += f'<w:jc w:val="{jc}"/>' if jc else ""
    return f"<w:p>{f'<w:pPr>{props}</w:pPr>' if props else ''}{''.join(runs)}</w:p>"


def docvariable(name: str, value: str) -> str:
    return field(f"DOCVARIABLE {name} \\* MERGEFORMAT", value)


def tree(sections: list[Section]) -> list[object]:
    return [(s.id, tree(s.sections)) for s in sections]


def blocks_of(section: Section, kind: type) -> list:  # type: ignore[type-arg]
    return [b for b in section.blocks if isinstance(b, kind)]


# --- A document shaped like the sample -------------------------------------------------------

ASSAY_TABLE = tbl(
    tr(tc("Table 1: Assay results", span=5)),
    tr(
        tc("Batch"),
        cell_with(text("Assay"), sup("a")),
        tc("pH"),
        cell_with(text("Water"), sup("b")),
        tc("Appearance"),
    ),
    tr(tc("B-1"), tc("99.1"), tc("6.8"), tc("0.4"), tc("White")),
    tr(tc("a: Mean of three determinations", span=5)),
    tr(tc("b: By titration", span=5)),
    cols=[1000] * 5,
)
SITE_TABLE = tbl(
    tr(*(tc(f"H{n}") for n in range(1, 12))),
    tr(*(tc(str(n)) for n in range(1, 12))),
    cols=[500] * 11,
)
HEADER = (
    f"<w:hdr {NAMESPACES}>"
    + para(docvariable("doc_number", "RPT-0042"))
    + para(docvariable("owning_site", "Site One"))
    + "</w:hdr>"
)


def sample_like() -> bytes:
    portrait = f"<w:p><w:pPr>{section_break(11906, 16838)}</w:pPr></w:p>"
    landscape = f"<w:p><w:pPr>{section_break(16838, 11906, 'landscape')}</w:pPr></w:p>"
    body = (
        heading(1, "Introduction")
        + para(text("Scope of the study."))
        + heading(2, "Results")
        + para(text("First results."))
        + heading(2, "Results")
        + para(text("Second results."))
        + heading(1)
        + para(text("Under an empty heading."))
        + heading(1, "Stability")
        + heading(2, "Results")
        + ASSAY_TABLE
        + para(text("Stored at 25 "), DEGREE, text("C."))
        + portrait
        + para(text("Table 2: Results by site"), style="Caption")
        + SITE_TABLE
        + landscape
        + heading(2, "Figures")
        + para(f"<w:r>{picture(descr='Assay trend')}</w:r>", jc="center")
        + para(text("Figure 1- Assay trend over time"), style="Caption")
        + para(text("See the trend."), '<w:r><w:footnoteReference w:id="2"/></w:r>')
    )
    return build_docx(
        body,
        styles=DEFAULT_STYLES,
        headers={"header1.xml": HEADER},
        footnotes=notes_part("footnote", (2, text(" Measured monthly."))),
        sect_pr=section_break(11906, 16838),
        **IMAGE,  # type: ignore[arg-type]
    )


def test_sample_like_report() -> None:
    renderer = FakeRenderer()
    result = decompose_docx(sample_like(), renderer=renderer)
    doc = result.document

    assert tree(doc.sections) == [
        (
            "s-introduction",
            [("s-introduction/s-results", []), ("s-introduction/s-results~2", [])],
        ),
        ("s-untitled", []),
        ("s-stability", [("s-stability/s-results", []), ("s-stability/s-figures", [])]),
    ]
    assert doc.sections[1].title == [Text(text="[]")]

    stability = doc.sections[2]
    results, figures = stability.sections
    assay, sites = blocks_of(results, Table)
    assert assay.caption == [Text(text="Assay results")] and assay.numbered
    assert sites.caption == [Text(text="Results by site")] and sites.numbered
    assert [(n.marker, plain_text(n.inlines)) for n in assay.notes] == [
        ("a", "Mean of three determinations"),
        ("b", "By titration"),
    ]
    assert len(assay.column_widths) == 5 and len(assay.rows) == 2
    assert len(sites.column_widths) == 11
    assert (assay.wide, sites.wide) == (False, True)
    assert "Stored at 25 °C." in [plain_text(p.inlines) for p in blocks_of(results, Paragraph)]

    (figure,) = blocks_of(figures, Figure)
    assert figure.caption == [Text(text="Assay trend over time")]
    assert figure.numbered and figure.caption_position == "below"
    (image,) = doc.images
    assert image.id == figure.image_id and image.alt == "Assay trend"
    assert result.image_bytes == {image.id: PNG}
    assert result.originals == {}
    assert [n.id for n in doc.notes] == ["fn-2"]

    assert doc.properties == [
        Property(name="doc_number", value="RPT-0042", origin="header-field"),
        Property(name="owning_site", value="Site One", origin="header-field"),
    ]
    assert {f.code for f in doc.report} == {"heading_empty"}
    assert renderer.fragments == []


def test_result_is_checked_and_deterministic() -> None:
    first = decompose_docx(sample_like(), renderer=FakeRenderer())
    second = decompose_docx(sample_like(), renderer=FakeRenderer())
    assert isinstance(first, Decomposition)
    assert first == second
    assert DECOMPOSER_VERSION == 1


# --- The report ------------------------------------------------------------------------------


def test_changes_accepted_flag_counts() -> None:
    body = heading(1, "A") + para(
        "<w:ins><w:r><w:t>new </w:t></w:r></w:ins>",
        "<w:del><w:r><w:delText>old </w:delText></w:r></w:del>",
        text("kept"),
    )
    doc = decompose_docx(build_docx(body), renderer=FakeRenderer()).document
    changes = [f for f in doc.report if f.code == "changes_accepted"]
    assert [(f.severity, f.at) for f in changes] == [("info", None)]
    assert "2" in changes[0].message

    clean = decompose_docx(build_docx(heading(1, "A") + para(text("x"))), renderer=FakeRenderer())
    assert clean.document.report == []


def test_flags_are_ordered_by_document_position() -> None:
    body = (
        heading(1, "A")
        + para(text("see "), field("REF _Missing \\h", "nowhere"))
        + heading(1, "B")
        + para('<w:r><w:sym w:font="Wingdings" w:char="F001"/></w:r>')
        + heading(3, "Deep")
        + para("<w:ins><w:r><w:t>new</w:t></w:r></w:ins>")
    )
    doc = decompose_docx(build_docx(body), renderer=FakeRenderer()).document
    assert [(f.code, f.at) for f in doc.report] == [
        ("changes_accepted", None),
        ("xref_unmatched", "s-a#p-1"),
        ("symbol_unmapped", "s-b#p-1"),
        ("heading_skipped_level", "s-b/s-deep"),
    ]


# --- Failures --------------------------------------------------------------------------------


def test_unreadable_source_is_rejected() -> None:
    with pytest.raises(DecompositionRejected):
        decompose_docx(b"not a zip", renderer=FakeRenderer())


def test_rendering_failure_fails_the_document() -> None:
    body = heading(1, "A") + para(f"<w:r>{picture()}</w:r>")
    data = build_docx(
        body, media={"image1.emf": EMF}, rels=[("rIdImg", "image", "media/image1.emf")]
    )
    with pytest.raises(DecompositionFailed):
        decompose_docx(data, renderer=FakeRenderer(fails=True))
    converted = decompose_docx(data, renderer=FakeRenderer())
    (image,) = converted.document.images
    assert converted.originals == {image.id: EMF}


# --- Hostile input is refused, never a crash or a hang ---------------------------------------

_DEEP = 3000


def _png_header(width: int, height: int) -> bytes:
    """A PNG that claims `width` by `height` pixels, with almost no data."""

    def chunk(kind: bytes, data: bytes) -> bytes:
        crc = zlib.crc32(kind + data) & 0xFFFFFFFF
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", crc)

    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", header)
        + chunk(b"IDAT", zlib.compress(b"\0"))
        + chunk(b"IEND", b"")
    )


#: A picture with no `wp:extent`, so its size is read from its pixels.
_UNSIZED_PICTURE = (
    '<w:p><w:r><w:drawing><wp:inline><wp:docPr id="1" name="p"/><a:graphic>'
    '<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">'
    '<pic:pic><pic:blipFill><a:blip r:embed="rIdImg"/></pic:blipFill></pic:pic>'
    "</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>"
)


@pytest.mark.parametrize(
    "body",
    [
        "<w:sdt><w:sdtContent>" * _DEEP + para(text("x")) + "</w:sdtContent></w:sdt>" * _DEEP,
        "<w:p>" + "<w:smartTag>" * _DEEP + text("x") + "</w:smartTag>" * _DEEP + "</w:p>",
    ],
    ids=["block-sdt", "smart-tag"],
)
def test_deep_nesting_is_rejected(body: str) -> None:
    with pytest.raises(DecompositionRejected, match="document nesting too deep"):
        decompose_docx(build_docx(body), renderer=FakeRenderer())


def test_recursion_anywhere_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    def recurse(*_: object) -> None:
        raise RecursionError

    monkeypatch.setattr(decompose_module, "walk_body", recurse)
    with pytest.raises(DecompositionRejected, match="document nesting too deep"):
        decompose_docx(build_docx(para(text("x"))), renderer=FakeRenderer())


def test_chart_that_contains_itself_is_rejected() -> None:
    graphic = '<c:chart r:id="rIdChart"/>'
    chart = (
        '<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" '
        f'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        f"{graphic}</c:chartSpace>"
    )
    data = build_docx(
        para(f"<w:r>{drawing(graphic, uri=CHART_URI)}</w:r>"),
        rels=[("rIdChart", "chart", "charts/chart1.xml")],
        extra_parts={"word/charts/chart1.xml": chart.encode()},
    )
    with pytest.raises(DecompositionRejected):
        decompose_docx(data, renderer=FakeRenderer())


@pytest.mark.parametrize(
    "size", [(60000, 60000), (10000, 10000)], ids=["bomb-error", "bomb-warning"]
)
def test_decompression_bomb_image_is_rejected(size: tuple[int, int]) -> None:
    data = build_docx(
        _UNSIZED_PICTURE,
        media={"big.png": _png_header(*size)},
        rels=[("rIdImg", "image", "media/big.png")],
    )
    with pytest.raises(DecompositionRejected, match="image too large"):
        decompose_docx(data, renderer=FakeRenderer())


def test_grid_bomb_is_refused_fast() -> None:
    row = '<w:tr><w:trPr><w:gridBefore w:val="999"/></w:trPr><w:tc><w:p/></w:tc></w:tr>'
    body = '<w:tbl><w:tblGrid><w:gridCol w:w="1"/></w:tblGrid>' + row * 200 + "</w:tbl>"
    data = build_docx(body)
    started = time.perf_counter()
    with pytest.raises((DecompositionFailed, DecompositionRejected)):
        decompose_docx(data, renderer=FakeRenderer())
    assert time.perf_counter() - started < 1.0
