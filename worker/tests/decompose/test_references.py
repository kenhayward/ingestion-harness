"""Notes, cross-references, hyperlinks, typed references and the generated lists that are dropped."""

from __future__ import annotations

import pytest

from ingest_worker.decompose.body import walk_body
from ingest_worker.decompose.inline import InlineContext, RunStyles
from ingest_worker.decompose.media import MediaContext
from ingest_worker.decompose.model import (
    Block,
    DecomposedDocument,
    Figure,
    Inline,
    Link,
    NoteRef,
    Paragraph,
    Table,
    Text,
    XRef,
)
from ingest_worker.decompose.package import DecompositionFailed, open_package
from ingest_worker.decompose.references import notes_of, resolve_references
from tests.decompose.docx import NAMESPACES, build_docx
from tests.decompose.fakes import FakeRenderer
from tests.decompose.test_media import PNG, picture
from tests.decompose.test_tables import tbl, tc, tr

STYLES = (
    f"<w:styles {NAMESPACES}>"
    + "".join(
        f'<w:style w:type="paragraph" w:styleId="Heading{n}"><w:name w:val="heading {n}"/>'
        f'<w:pPr><w:outlineLvl w:val="{n - 1}"/></w:pPr></w:style>'
        for n in (1, 2)
    )
    + '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/></w:style>'
    '<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/></w:style>'
    '<w:style w:type="paragraph" w:styleId="TableofFigures">'
    '<w:name w:val="table of figures"/></w:style>'
    "</w:styles>"
)

# --- Builders --------------------------------------------------------------------------------


def run(text: str) -> str:
    return f'<w:r><w:t xml:space="preserve">{text}</w:t></w:r>'


def para(*runs: str, style: str | None = None) -> str:
    props = f'<w:pPr><w:pStyle w:val="{style}"/></w:pPr>' if style else ""
    return f"<w:p>{props}{''.join(runs)}</w:p>"


def heading(text: str, *extra: str) -> str:
    return para(*extra, run(text), style="Heading1")


def bookmark(name: str, bid: int = 1) -> str:
    return f'<w:bookmarkStart w:id="{bid}" w:name="{name}"/>'


def bookmark_end(bid: int = 1) -> str:
    return f'<w:bookmarkEnd w:id="{bid}"/>'


def begin() -> str:
    return '<w:r><w:fldChar w:fldCharType="begin"/></w:r>'


def instr(text: str) -> str:
    return f'<w:r><w:instrText xml:space="preserve"> {text} </w:instrText></w:r>'


def separate() -> str:
    return '<w:r><w:fldChar w:fldCharType="separate"/></w:r>'


def end() -> str:
    return '<w:r><w:fldChar w:fldCharType="end"/></w:r>'


def field(instruction: str, result: str) -> str:
    return begin() + instr(instruction) + separate() + run(result) + end()


def seq_caption(label: str, number: int, title: str) -> str:
    return para(
        run(f"{label} "),
        field(f"SEQ {label} \\* ARABIC", str(number)),
        run(f": {title}"),
        style="Caption",
    )


def notes_part(tag: str, *notes: tuple[int, str]) -> str:
    """A footnotes or endnotes part with Word's separator notes and `notes` as (id, text)."""
    mark = "footnoteRef" if tag == "footnote" else "endnoteRef"
    parts = [
        f'<w:{tag} w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:{tag}>',
        f'<w:{tag} w:type="continuationSeparator" w:id="0">'
        f"<w:p><w:r><w:continuationSeparator/></w:r></w:p></w:{tag}>",
    ]
    for nid, inner in notes:
        parts.append(f'<w:{tag} w:id="{nid}"><w:p><w:r><w:{mark}/></w:r>{inner}</w:p></w:{tag}>')
    return f"<w:{tag}s {NAMESPACES}>{''.join(parts)}</w:{tag}s>"


def decompose(
    body: str,
    *,
    footnotes: str | None = None,
    endnotes: str | None = None,
    rels: list[tuple[str, str, str]] | None = None,
    media: dict[str, bytes] | None = None,
    extra_parts: dict[str, bytes] | None = None,
) -> tuple[DecomposedDocument, InlineContext]:
    pkg = open_package(
        build_docx(
            body,
            styles=STYLES,
            footnotes=footnotes,
            endnotes=endnotes,
            rels=rels,
            media=media,
            extra_parts=extra_parts,
        )
    )
    media_ctx = MediaContext.for_package(pkg, FakeRenderer())
    ctx = InlineContext(styles=RunStyles.from_xml(pkg.xml("word/styles.xml")), media=media_ctx)
    blocks, sections = walk_body(pkg, ctx)
    notes = notes_of(pkg, ctx)
    doc = DecomposedDocument(
        blocks=blocks,
        sections=sections,
        images=media_ctx.images,
        equations=media_ctx.equations,
        notes=notes,
        properties=[],
        report=list(ctx.flags),
    )
    return resolve_references(doc, ctx), ctx


def paragraphs(blocks: list[Block]) -> list[Paragraph]:
    return [b for b in blocks if isinstance(b, Paragraph)]


def texts(blocks: list[Block]) -> list[str]:
    return ["".join(_text(i) for i in p.inlines) for p in paragraphs(blocks)]


def _text(item: Inline) -> str:
    if isinstance(item, Text):
        return item.text
    if isinstance(item, XRef):
        return item.text
    if isinstance(item, Link):
        return "".join(_text(i) for i in item.inlines)
    return ""


def xref_flags(doc: DecomposedDocument) -> list[tuple[str, str | None]]:
    return [(f.severity, f.at) for f in doc.report if f.code == "xref_unmatched"]


# --- Notes -----------------------------------------------------------------------------------


def test_footnote_and_endnote_become_notes() -> None:
    body = para(
        run("Text"),
        '<w:r><w:footnoteReference w:id="2"/></w:r>',
        run(" and more"),
        '<w:r><w:endnoteReference w:id="1"/></w:r>',
    )
    doc, _ = decompose(
        body,
        footnotes=notes_part("footnote", (2, run(" A footnote."))),
        endnotes=notes_part("endnote", (1, run(" An endnote."))),
    )
    assert doc.blocks[0] == Paragraph(
        id="s-0#p-1",
        inlines=[
            Text(text="Text"),
            NoteRef(note_id="fn-2"),
            Text(text=" and more"),
            NoteRef(note_id="en-1"),
        ],
    )
    assert [n.id for n in doc.notes] == ["fn-2", "en-1"]
    assert doc.notes[0].blocks == [Paragraph(id="fn-2#p-1", inlines=[Text(text="A footnote.")])]
    assert doc.notes[1].blocks == [Paragraph(id="en-1#p-1", inlines=[Text(text="An endnote.")])]


def test_picture_in_footnote_resolves_against_the_notes_part() -> None:
    rels = (
        b'<?xml version="1.0" encoding="UTF-8"?>'
        b'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        b'<Relationship Id="rIdNote" '
        b'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" '
        b'Target="media/note.png"/></Relationships>'
    )
    doc, ctx = decompose(
        para(run("Body"), '<w:r><w:footnoteReference w:id="1"/></w:r>'),
        footnotes=notes_part("footnote", (1, f"<w:r>{picture('rIdNote')}</w:r>")),
        extra_parts={"word/_rels/footnotes.xml.rels": rels, "word/media/note.png": PNG},
    )
    assert len(doc.notes) == 1
    assert [type(b).__name__ for b in doc.notes[0].blocks] == ["ImageBlock"]
    assert ctx.media is not None
    assert ctx.media.part == "word/document.xml"


# --- Cross-reference fields ------------------------------------------------------------------


def test_ref_field_to_table_bookmark() -> None:
    body = (
        heading("Results")
        + para(bookmark("_Ref1"), run("Table "), field("SEQ Table", "4"), bookmark_end())
        + tbl(tr(tc("A"), tc("B")), cols=[2000, 2000])
        + para(run("As "), field("REF _Ref1 \\h", "Table 4"), run(" shows."))
        + para(run("Missing "), field("REF _RefGone \\h", "Table 9"), run("."))
    )
    doc, _ = decompose(body)
    section = doc.sections[0]
    table = next(b for b in section.blocks if isinstance(b, Table))
    refs = paragraphs(section.blocks)
    assert refs[0].inlines == [
        Text(text="As "),
        XRef(target_id=table.id, text="Table 4"),
        Text(text=" shows."),
    ]
    assert refs[1].inlines == [Text(text="Missing Table 9.")]
    assert ("warning", refs[1].id) in xref_flags(doc)


def test_bookmarks_in_headings_cells_and_figures() -> None:
    body = (
        heading("Method", bookmark("_Toc1"))
        + tbl(
            tr(tc("A"), f"<w:tc><w:p>{bookmark('_InCell')}{run('B')}</w:p></w:tc>"),
            cols=[2000, 2000],
        )
        + para(f"<w:r>{picture()}</w:r>")
        + para(bookmark("_Fig1"), run("Figure 1: A picture"), style="Caption")
        + para(
            field("REF _Toc1 \\h", "Method"),
            field("REF _InCell \\h", "B"),
            field("PAGEREF _Fig1 \\h", "3"),
        )
    )
    doc, _ = decompose(
        body, rels=[("rIdImg", "image", "media/image1.png")], media={"image1.png": PNG}
    )
    section = doc.sections[0]
    table = next(b for b in section.blocks if isinstance(b, Table))
    figure = next(b for b in section.blocks if isinstance(b, Figure))
    assert paragraphs(section.blocks)[-1].inlines == [
        XRef(target_id=section.id, text="Method"),
        XRef(target_id=table.id, text="B"),
        XRef(target_id=figure.id, text="3"),
    ]


# --- Hyperlinks ------------------------------------------------------------------------------


def test_internal_and_external_hyperlinks() -> None:
    body = heading("Intro", bookmark("_Toc9")) + para(
        '<w:hyperlink r:id="rIdLink">',
        run("site"),
        "</w:hyperlink>",
        run(" "),
        '<w:hyperlink w:anchor="_Toc9">',
        run("intro"),
        "</w:hyperlink>",
        run(" "),
        field('HYPERLINK "https://example.org/b"', "field site"),
        run(" "),
        field('HYPERLINK \\l "_Toc9"', "field intro"),
    )
    doc, _ = decompose(body, rels=[("rIdLink", "hyperlink", "https://example.org/a")])
    section = doc.sections[0]
    assert paragraphs(section.blocks)[0].inlines == [
        Link(href="https://example.org/a", inlines=[Text(text="site")]),
        Text(text=" "),
        XRef(target_id=section.id, text="intro"),
        Text(text=" "),
        Link(href="https://example.org/b", inlines=[Text(text="field site")]),
        Text(text=" "),
        XRef(target_id=section.id, text="field intro"),
    ]


def test_unsafe_link_scheme_keeps_text_only() -> None:
    doc, _ = decompose(para(field('HYPERLINK "javascript:alert(1)"', "click")))
    assert doc.blocks[0] == Paragraph(id="s-0#p-1", inlines=[Text(text="click")])


# --- Dropped fields --------------------------------------------------------------------------


def test_toc_spanning_paragraphs_is_dropped_whole() -> None:
    entries = [
        para(
            *([begin(), instr('TOC \\o "1-3" \\h'), separate()] if i == 0 else []),
            f'<w:hyperlink w:anchor="_Toc{i}">',
            run(f"Entry {i}"),
            field(f"PAGEREF _Toc{i} \\h", str(i + 1)),
            "</w:hyperlink>",
            style="TOC1",
        )
        for i in range(30)
    ]
    body = (
        para(run("Contents"))
        + "".join(entries)
        + para(end())
        + heading("First")
        + para(run("Body text."))
    )
    doc, _ = decompose(body)
    assert texts(doc.blocks) == ["Contents"]
    assert texts(doc.sections[0].blocks) == ["Body text."]
    assert doc.report == []


def test_list_of_tables_dropped() -> None:
    body = (
        para(begin(), instr('TOC \\h \\z \\c "Table"'), separate(), run("Table 1: A\t2"))
        + para(run("Table 2: B\t3"), end())
        + para(run("Table of figures by style\t4"), style="TableofFigures")
        + para(run("Kept."))
    )
    doc, _ = decompose(body)
    assert texts(doc.blocks) == ["Kept."]


def test_unterminated_field_refuses_the_document() -> None:
    body = para(begin(), instr("TOC"), separate(), run("entry")) + para(run("Swallowed"))
    with pytest.raises(DecompositionFailed, match="never closed"):
        decompose(body)


def test_nested_field_keeps_outer_result() -> None:
    body = heading("Target", bookmark("_Ref5")) + para(
        begin(),
        instr("REF"),
        field("DOCPROPERTY Name", "_Ref5"),
        instr("\\h"),
        separate(),
        run("outer "),
        field("PAGE", "7"),
        end(),
        begin(),
        instr("IF"),
        field("MERGEFIELD x", "1"),
        instr('= 1 "yes" "no"'),
        separate(),
        run("yes"),
        end(),
    )
    doc, _ = decompose(body)
    inlines = paragraphs(doc.sections[0].blocks)[0].inlines
    assert "".join(_text(i) for i in inlines) == "outer 7yes"
    assert "DOCPROPERTY" not in str(inlines)
    assert "MERGEFIELD" not in str(inlines)


# --- Typed references ------------------------------------------------------------------------


def test_typed_reference_matched() -> None:
    body = (
        heading("Data")
        + seq_caption("Table", 13, "Dissolution")
        + tbl(tr(tc("A"), tc("B")), cols=[2000, 2000])
        + para(run("see Table 13 for the data."))
    )
    doc, _ = decompose(body)
    section = doc.sections[0]
    table = next(b for b in section.blocks if isinstance(b, Table))
    assert table.caption == [Text(text="Dissolution")]
    assert paragraphs(section.blocks)[0].inlines == [
        Text(text="see "),
        XRef(target_id=table.id, text="Table 13"),
        Text(text=" for the data."),
    ]
    assert xref_flags(doc) == []


def test_typed_reference_unmatched_flags() -> None:
    body = heading("Data") + para(run("Figure 2 shows it."))
    doc, _ = decompose(body)
    section = doc.sections[0]
    assert paragraphs(section.blocks)[0].inlines == [Text(text="Figure 2 shows it.")]
    assert xref_flags(doc) == [("info", paragraphs(section.blocks)[0].id)]


def test_typed_reference_not_matched_inside_captions_or_links() -> None:
    body = (
        seq_caption("Table", 1, "See Table 1 again")
        + tbl(tr(tc("A"), tc("B")), cols=[2000, 2000])
        + para(field('HYPERLINK "https://example.org"', "Table 1 online"))
    )
    doc, _ = decompose(body)
    table = next(b for b in doc.blocks if isinstance(b, Table))
    assert table.caption == [Text(text="See Table 1 again")]
    assert paragraphs(doc.blocks)[0].inlines == [
        Link(href="https://example.org", inlines=[Text(text="Table 1 online")])
    ]
    assert xref_flags(doc) == []
