"""Inline content of a paragraph: marks, characters, whitespace, tracked changes, fields."""

from __future__ import annotations

from xml.etree.ElementTree import Element

from ingest_worker.decompose.inline import (
    InlineContext,
    RunStyles,
    inlines_of,
    merge_runs,
    plain_text,
)
from ingest_worker.decompose.model import Break, Inline, Text
from ingest_worker.decompose.package import open_package
from tests.decompose.docx import NAMESPACES, W_NS, build_docx

STYLES = (
    f"<w:styles {NAMESPACES}>"
    '<w:style w:type="character" w:styleId="Emph"><w:rPr><w:i/></w:rPr></w:style>'
    '<w:style w:type="paragraph" w:styleId="BoldPara"><w:rPr><w:b/></w:rPr></w:style>'
    '<w:style w:type="paragraph" w:styleId="BoldChild"><w:basedOn w:val="BoldPara"/></w:style>'
    "</w:styles>"
)


def _para(body: str) -> tuple[Element, InlineContext]:
    pkg = open_package(build_docx(body, styles=STYLES))
    doc = pkg.xml("word/document.xml")
    assert doc is not None
    p = doc.find(f".//{{{W_NS}}}p")
    assert p is not None
    return p, InlineContext(styles=RunStyles.from_xml(pkg.xml("word/styles.xml")))


def _inlines(body: str) -> tuple[list[Inline], InlineContext]:
    p, ctx = _para(body)
    return inlines_of(p, ctx, at="p1"), ctx


def _marks(inlines: list[Inline]) -> list[set[str]]:
    return [set(i.marks) for i in inlines if isinstance(i, Text)]


def test_marks_from_direct_and_style() -> None:
    body = (
        '<w:p><w:pPr><w:pStyle w:val="BoldChild"/></w:pPr>'
        "<w:r><w:t>a</w:t></w:r>"
        '<w:r><w:rPr><w:rStyle w:val="Emph"/><w:b w:val="1"/></w:rPr><w:t>b</w:t></w:r>'
        '<w:r><w:rPr><w:b w:val="0"/></w:rPr><w:t>c</w:t></w:r></w:p>'
    )
    inl, _ = _inlines(body)
    assert _marks(inl) == [{"bold"}, {"bold", "italic"}, set()]


def test_char_style_and_direct_marks() -> None:
    body = (
        "<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>x</w:t></w:r>"
        '<w:r><w:rPr><w:rStyle w:val="Emph"/></w:rPr><w:t>y</w:t></w:r>'
        '<w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>z</w:t></w:r>'
        '<w:r><w:rPr><w:u w:val="none"/></w:rPr><w:t>w</w:t></w:r></w:p>'
    )
    inl, _ = _inlines(body)
    assert _marks(inl) == [{"bold"}, {"italic"}, {"underline"}, set()]


def test_super_and_subscript() -> None:
    def run(text: str, va: str | None = None) -> str:
        rpr = f'<w:rPr><w:vertAlign w:val="{va}"/></w:rPr>' if va else ""
        return f"<w:r>{rpr}<w:t>{text}</w:t></w:r>"

    body = (
        "<w:p>"
        + run("x")
        + run("2", "superscript")
        + run("H")
        + run("2", "subscript")
        + run("O")
        + "</w:p>"
    )
    inl, _ = _inlines(body)
    assert inl == [
        Text(text="x"),
        Text(text="2", marks=frozenset({"superscript"})),
        Text(text="H"),
        Text(text="2", marks=frozenset({"subscript"})),
        Text(text="O"),
    ]


def test_symbol_font_characters() -> None:
    body = (
        '<w:p><w:r><w:sym w:font="Symbol" w:char="F0B0"/></w:r>'
        '<w:r><w:sym w:font="Symbol" w:char="F0B1"/></w:r>'
        '<w:r><w:sym w:font="Wingdings" w:char="F001"/></w:r></w:p>'
    )
    inl, ctx = _inlines(body)
    assert plain_text(inl) == "°±�"
    assert [(f.code, f.at) for f in ctx.flags] == [("symbol_unmapped", "p1")]
    assert "F001" in ctx.flags[0].message.upper()


def test_wingdings_arrows_between_steps_are_arrows() -> None:
    """A flow drawn in a table: Wingdings down arrows between its steps."""
    body = '<w:p><w:r><w:sym w:font="Wingdings" w:char="F0E2"/></w:r></w:p>'
    inl, ctx = _inlines(body)
    assert plain_text(inl) == "⬇"
    assert ctx.flags == []


def test_symbol_font_text_and_private_use() -> None:
    body = (
        '<w:p><w:r><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr>'
        "<w:t>a b</w:t></w:r>"
        "<w:r><w:t></w:t></w:r></w:p>"
    )
    inl, ctx = _inlines(body)
    assert plain_text(inl) == "\u03b1 \u03b2±"
    assert ctx.flags == []


def test_special_characters_round_trip_through_accounting() -> None:
    body = (
        "<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b\u00a0c</w:t><w:softHyphen/><w:t>d</w:t>"
        "<w:noBreakHyphen/><w:t>e</w:t><w:cr/><w:t>f</w:t></w:r></w:p>"
    )
    inl, _ = _inlines(body)
    assert plain_text(inl) == "a b\u00a0cd\u2011e\nf"
    assert Break() in inl


def test_breaks_and_ptab() -> None:
    body = (
        '<w:p><w:r><w:t>a</w:t><w:br w:type="page"/><w:br w:type="column"/>'
        '<w:br w:type="textWrapping"/><w:t>b</w:t><w:br/><w:ptab w:alignment="left"/>'
        "<w:t>c</w:t></w:r></w:p>"
    )
    inl, _ = _inlines(body)
    assert plain_text(inl) == "a\nb\n c"


def test_tracked_changes_accepted() -> None:
    body = (
        "<w:p><w:r><w:t>keep </w:t></w:r>"
        '<w:ins w:id="1"><w:r><w:t>added </w:t></w:r></w:ins>'
        '<w:del w:id="2"><w:r><w:delText>gone</w:delText></w:r></w:del>'
        '<w:moveFrom w:id="3"><w:r><w:t>moved-out</w:t></w:r></w:moveFrom>'
        '<w:moveTo w:id="4"><w:r><w:t>moved-in</w:t></w:r></w:moveTo>'
        '<w:r><w:rPr><w:b/><w:rPrChange w:id="5"><w:rPr/></w:rPrChange></w:rPr><w:t>!</w:t></w:r>'
        "</w:p>"
    )
    inl, ctx = _inlines(body)
    assert plain_text(inl) == "keep added moved-in!"
    assert ctx.changes == 5


def test_comments_and_hidden_dropped() -> None:
    body = (
        '<w:p><w:commentRangeStart w:id="0"/><w:r><w:t>seen</w:t></w:r>'
        '<w:commentRangeEnd w:id="0"/>'
        '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr>'
        '<w:commentReference w:id="0"/></w:r>'
        "<w:r><w:rPr><w:vanish/></w:rPr><w:t>hidden</w:t></w:r>"
        "<w:r><w:rPr><w:specVanish/></w:rPr><w:t>hidden2</w:t></w:r>"
        '<w:r><w:rPr><w:vanish w:val="0"/></w:rPr><w:t>shown</w:t></w:r></w:p>'
    )
    inl, _ = _inlines(body)
    assert plain_text(inl) == "seenshown"


def test_field_result_kept_instruction_dropped() -> None:
    body = (
        '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        '<w:r><w:instrText xml:space="preserve"> DATE \\@ "d MMMM yyyy" </w:instrText></w:r>'
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        "<w:r><w:t>23 October 2026</w:t></w:r>"
        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    )
    inl, ctx = _inlines(body)
    assert plain_text(inl) == "23 October 2026"
    assert ctx.fields == []
    assert [f.kind for f in ctx.closed_fields] == ["DATE"]


def test_open_field_kind_exposed_on_stack() -> None:
    body = (
        '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        "<w:r><w:instrText> REF _Ref1 \\h </w:instrText></w:r>"
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        "<w:r><w:t>Table 1</w:t></w:r></w:p>"
    )
    inl, ctx = _inlines(body)
    assert plain_text(inl) == "Table 1"
    assert [(f.kind, f.in_result) for f in ctx.fields] == [("REF", True)]


def test_fld_simple_and_nested_fields() -> None:
    body = (
        '<w:p><w:fldSimple w:instr=" PAGEREF _Toc1 \\h "><w:r><w:t>12</w:t></w:r></w:fldSimple>'
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        "<w:r><w:instrText> QUOTE </w:instrText></w:r>"
        '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        "<w:r><w:instrText> SEQ Table </w:instrText></w:r>"
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        "<w:r><w:t>3</w:t></w:r>"
        '<w:r><w:fldChar w:fldCharType="end"/></w:r>'
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        "<w:r><w:t>toc</w:t></w:r>"
        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>'
    )
    inl, ctx = _inlines(body)
    assert plain_text(inl) == "12toc"
    assert [f.kind for f in ctx.closed_fields] == ["PAGEREF", "SEQ", "QUOTE"]


def test_hyperlink_and_unknown_container_keep_result() -> None:
    body = (
        '<w:p><w:hyperlink r:id="rId9"><w:r><w:t>site</w:t></w:r></w:hyperlink>'
        '<w:smartTag w:uri="x" w:element="y"><w:r><w:t>!</w:t></w:r></w:smartTag></w:p>'
    )
    inl, _ = _inlines(body)
    assert plain_text(inl) == "site!"


def test_merge_runs_joins_equal_marks_only() -> None:
    bold = frozenset({"bold"})
    merged = merge_runs(
        [
            Text(text="a"),
            Text(text="b"),
            Text(text="c", marks=bold),
            Break(),
            Text(text="d", marks=bold),
            Text(text=""),
        ]
    )
    assert merged == [
        Text(text="ab"),
        Text(text="c", marks=bold),
        Break(),
        Text(text="d", marks=bold),
    ]


def test_field_end_inside_deletion_keeps_later_text() -> None:
    body = (
        '<w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r>'
        "<w:r><w:instrText> REF x </w:instrText></w:r>"
        '<w:del w:id="1"><w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        "<w:r><w:delText>old</w:delText></w:r>"
        '<w:r><w:fldChar w:fldCharType="end"/></w:r></w:del></w:p>'
        "<w:p><w:r><w:t>later</w:t></w:r></w:p>"
    )
    pkg = open_package(build_docx(body, styles=STYLES))
    doc = pkg.xml("word/document.xml")
    assert doc is not None
    ctx = InlineContext()
    paras = doc.findall(f".//{{{W_NS}}}p")
    first = inlines_of(paras[0], ctx, at="p1")
    later = inlines_of(paras[1], ctx, at="p2")
    assert plain_text(first) == ""
    assert plain_text(later) == "later"
    assert ctx.fields == []


def test_unmatched_field_end_is_ignored() -> None:
    body = (
        '<w:p><w:r><w:fldChar w:fldCharType="end"/></w:r>'
        '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'
        "<w:r><w:t>kept</w:t></w:r></w:p>"
    )
    inl, ctx = _inlines(body)
    assert plain_text(inl) == "kept"
    assert ctx.fields == []
