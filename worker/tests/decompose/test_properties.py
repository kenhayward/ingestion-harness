"""Document properties: core, custom, and name/value fields in headers and footers."""

from __future__ import annotations

from ingest_worker.decompose.body import walk_body
from ingest_worker.decompose.inline import InlineContext, RunStyles, plain_text
from ingest_worker.decompose.model import Paragraph, Property
from ingest_worker.decompose.package import open_package
from ingest_worker.decompose.properties import properties_of
from tests.decompose.docx import NAMESPACES, build_docx

CORE = (
    '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/'
    'core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" '
    'xmlns:dcterms="http://purl.org/dc/terms/" '
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    "<dc:title>Annual Review</dc:title><dc:subject></dc:subject><dc:creator>A. Author</dc:creator>"
    "<cp:keywords>alpha, beta</cp:keywords>"
    '<dcterms:created xsi:type="dcterms:W3CDTF">2024-01-02T03:04:05Z</dcterms:created>'
    '<dcterms:modified xsi:type="dcterms:W3CDTF">2024-02-03T04:05:06Z</dcterms:modified>'
    "<dc:description>ignored</dc:description></cp:coreProperties>"
)
CUSTOM = (
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/custom-properties" '
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="2" name="Batch">'
    "<vt:lpwstr>B-17</vt:lpwstr></property>"
    '<property fmtid="{D5CDD505-2E9C-101B-9397-08002B2CF9AE}" pid="3" name="Revision">'
    "<vt:i4>4</vt:i4></property>"
    "</Properties>"
)


def _field(name: str, result: str) -> str:
    return (
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        '<w:r><w:instrText xml:space="preserve">'
        f" DOCVARIABLE {name} \\* MERGEFORMAT </w:instrText></w:r>"
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        f"<w:r><w:t>{result}</w:t></w:r>"
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
    )


def _cell(inner: str) -> str:
    return f"<w:tc><w:p>{inner}</w:p></w:tc>"


def _row(*cells: str) -> str:
    return "<w:tr>" + "".join(cells) + "</w:tr>"


def _text(t: str) -> str:
    return f"<w:r><w:t>{t}</w:t></w:r>"


def _hdr(inner: str) -> str:
    return f"<w:hdr {NAMESPACES}>{inner}</w:hdr>"


def _props(**kwargs: object) -> list[Property]:
    return properties_of(open_package(build_docx("<w:p/>", **kwargs)))  # type: ignore[arg-type]


def test_core_and_custom() -> None:
    props = _props(core=CORE, custom=CUSTOM)
    assert props == [
        Property(name="title", value="Annual Review", origin="core"),
        Property(name="author", value="A. Author", origin="core"),
        Property(name="keywords", value="alpha, beta", origin="core"),
        Property(name="created", value="2024-01-02T03:04:05Z", origin="core"),
        Property(name="modified", value="2024-02-03T04:05:06Z", origin="core"),
        Property(name="Batch", value="B-17", origin="custom"),
        Property(name="Revision", value="4", origin="custom"),
    ]


def test_no_property_parts_gives_nothing() -> None:
    assert _props() == []


def test_header_docvariables_and_label_rows() -> None:
    header = _hdr(
        "<w:tbl>"
        + _row(_cell(_text("Document Type:")), _cell(_text("Report Alpha")))
        + _row(_cell(_text("Subtype")), _cell(_text("Stability Report")))
        + _row(_cell(_text("Only one")), _cell(""))
        + _row(_cell(_text("a")), _cell(_text("b")), _cell(_text("c")))
        + _row(_cell(_text("x" * 41)), _cell(_text("long label, no colon")))
        + _row(_cell(_text("x" * 41 + ":")), _cell(_text("long label, colon")))
        + "</w:tbl>"
        + f"<w:p>{_field('owning_facility', 'Site One')}</w:p>"
        + f"<w:p>{_field('blank_var', '')}</w:p>"
    )
    props = _props(headers={"header1.xml": header})
    assert props == [
        Property(name=name, value=value, origin="header-field")
        for name, value in [
            ("Document Type", "Report Alpha"),
            ("Subtype", "Stability Report"),
            ("x" * 41, "long label, colon"),
            ("owning_facility", "Site One"),
        ]
    ]


def test_footers_and_every_header_are_found_by_relationship() -> None:
    footer = _hdr(f"<w:p>{_field('doc_code', 'D-9')}</w:p>")
    first = _hdr(f"<w:p>{_field('doc_code', 'D-9')}{_field('site', 'North')}</w:p>")
    second = _hdr(f"<w:p>{_field('site', 'South')}</w:p>")
    data = build_docx(
        "<w:p/>",
        headers={"header1.xml": first, "other-name.xml": second},
        extra_parts={"word/footer7.xml": ('<?xml version="1.0"?>' + footer).encode()},
        rels=[("rIdFooter", "footer", "footer7.xml")],
    )
    props = properties_of(open_package(data))
    assert [(p.name, p.value) for p in props] == [
        ("doc_code", "D-9"),
        ("site", "North"),
        ("site", "South"),
    ]


def test_duplicates_are_emitted_once() -> None:
    header = _hdr(f"<w:p>{_field('site', 'North')}</w:p><w:p>{_field('site', 'North')}</w:p>")
    props = _props(headers={"header1.xml": header, "header2.xml": header})
    assert props == [Property(name="site", value="North", origin="header-field")]


def test_header_with_a_picture_is_read() -> None:
    header = _hdr(
        "<w:p><w:r><w:drawing><wp:inline><a:graphic/></wp:inline></w:drawing></w:r>"
        f"{_field('site', 'North')}</w:p>"
    )
    assert _props(headers={"header1.xml": header}) == [
        Property(name="site", value="North", origin="header-field")
    ]


def test_header_text_not_in_content() -> None:
    header = _hdr(
        f"<w:p>{_text('Running title')}</w:p><w:p>{_field('site', 'North')}</w:p>"
        "<w:tbl>" + _row(_cell(_text("Label:")), _cell(_text("Value"))) + "</w:tbl>"
    )
    pkg = open_package(
        build_docx("<w:p><w:r><w:t>Body text</w:t></w:r></w:p>", headers={"header1.xml": header})
    )
    ctx = InlineContext(styles=RunStyles.from_xml(pkg.xml("word/styles.xml")))
    blocks, sections = walk_body(pkg, ctx)
    assert not sections
    assert [plain_text(b.inlines) for b in blocks if isinstance(b, Paragraph)] == ["Body text"]
    assert len(blocks) == 1
    assert ctx.closed_fields == []
    assert ctx.flags == []
