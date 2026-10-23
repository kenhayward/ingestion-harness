"""Outline levels and list membership from styles.xml and numbering.xml."""

from __future__ import annotations

from xml.etree.ElementTree import Element

from ingest_worker.decompose.package import open_package
from ingest_worker.decompose.styles import Styles
from tests.decompose.docx import NAMESPACES, W_NS, build_docx

STYLES = (
    f"<w:styles {NAMESPACES}>"
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"/>'
    '<w:style w:type="paragraph" w:styleId="Heading2"><w:pPr><w:outlineLvl w:val="1"/></w:pPr>'
    "</w:style>"
    '<w:style w:type="paragraph" w:styleId="ReportHead"><w:basedOn w:val="Heading2"/></w:style>'
    '<w:style w:type="paragraph" w:styleId="Plain"><w:basedOn w:val="Heading2"/>'
    '<w:pPr><w:outlineLvl w:val="9"/></w:pPr></w:style>'
    '<w:style w:type="paragraph" w:styleId="Bulleted"><w:pPr><w:numPr><w:numId w:val="1"/>'
    "</w:numPr></w:pPr></w:style>"
    "</w:styles>"
)
NUMBERING = (
    f"<w:numbering {NAMESPACES}>"
    '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>'
    '<w:lvl w:ilvl="1"><w:numFmt w:val="none"/></w:lvl></w:abstractNum>'
    '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>'
    "</w:abstractNum>"
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
    '<w:num w:numId="3"><w:abstractNumId w:val="0"/><w:lvlOverride w:ilvl="0"><w:lvl w:ilvl="0">'
    '<w:numFmt w:val="lowerLetter"/></w:lvl></w:lvlOverride></w:num>'
    "</w:numbering>"
)


def _one(ppr: str) -> tuple[Styles, Element]:
    pkg = open_package(
        build_docx(f"<w:p><w:pPr>{ppr}</w:pPr></w:p>", styles=STYLES, numbering=NUMBERING)
    )
    doc = pkg.xml("word/document.xml")
    assert doc is not None
    para = doc.find(f".//{{{W_NS}}}p")
    assert para is not None
    return Styles(pkg.xml("word/styles.xml"), pkg.xml("word/numbering.xml")), para


def test_outline_level_direct_beats_style() -> None:
    styles, para = _one('<w:pStyle w:val="Heading2"/><w:outlineLvl w:val="3"/>')
    assert styles.outline_level(para) == 3


def test_outline_level_from_style_chain() -> None:
    styles, para = _one('<w:pStyle w:val="ReportHead"/>')
    assert styles.outline_level(para) == 1


def test_level_nine_is_body_text() -> None:
    styles, para = _one('<w:pStyle w:val="Plain"/>')
    assert styles.outline_level(para) is None
    styles, para = _one('<w:pStyle w:val="Heading2"/><w:outlineLvl w:val="9"/>')
    assert styles.outline_level(para) is None


def test_no_outline_level_is_body_text() -> None:
    styles, para = _one("")
    assert styles.outline_level(para) is None


def test_list_info_direct_numbering() -> None:
    styles, para = _one('<w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr>')
    assert styles.list_info(para) == ("1", 1, False)
    styles, para = _one('<w:numPr><w:numId w:val="2"/></w:numPr>')
    assert styles.list_info(para) == ("2", 0, True)


def test_list_info_from_style_and_override() -> None:
    styles, para = _one('<w:pStyle w:val="Bulleted"/>')
    assert styles.list_info(para) == ("1", 0, False)
    styles, para = _one('<w:numPr><w:numId w:val="3"/></w:numPr>')
    assert styles.list_info(para) == ("3", 0, True)


def test_numid_zero_removes_numbering() -> None:
    styles, para = _one('<w:pStyle w:val="Bulleted"/><w:numPr><w:numId w:val="0"/></w:numPr>')
    assert styles.list_info(para) is None


def test_plain_paragraph_is_not_a_list() -> None:
    styles, para = _one("")
    assert styles.list_info(para) is None
