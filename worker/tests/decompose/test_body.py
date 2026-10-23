"""The section tree, paragraphs and lists of the body."""

from __future__ import annotations

from ingest_worker.decompose.body import walk_body
from ingest_worker.decompose.inline import InlineContext, RunStyles, plain_text
from ingest_worker.decompose.model import Block, ListBlock, Paragraph, Section
from ingest_worker.decompose.package import open_package
from tests.decompose.docx import DEFAULT_STYLES, NAMESPACES, build_docx

STYLES = DEFAULT_STYLES.replace(
    "</w:styles>",
    '<w:style w:type="paragraph" w:styleId="ReportHead"><w:basedOn w:val="Heading2"/></w:style>'
    "</w:styles>",
)
NUMBERING = (
    f"<w:numbering {NAMESPACES}>"
    '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl>'
    '<w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>'
    '<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>'
    "</w:abstractNum>"
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    '<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>'
    "</w:numbering>"
)


def h(level: int, text: str) -> str:
    return (
        f'<w:p><w:pPr><w:pStyle w:val="Heading{level}"/></w:pPr><w:r><w:t>{text}</w:t></w:r></w:p>'
    )


def p(text: str) -> str:
    return f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>" if text else "<w:p/>"


def li(num_id: int, ilvl: int, text: str) -> str:
    return (
        f'<w:p><w:pPr><w:numPr><w:ilvl w:val="{ilvl}"/><w:numId w:val="{num_id}"/></w:numPr>'
        f"</w:pPr><w:r><w:t>{text}</w:t></w:r></w:p>"
    )


def walk(body: str) -> tuple[list[Block], list[Section], InlineContext]:
    pkg = open_package(build_docx(body, styles=STYLES, numbering=NUMBERING))
    ctx = InlineContext(styles=RunStyles.from_xml(pkg.xml("word/styles.xml")))
    blocks, sections = walk_body(pkg, ctx)
    return blocks, sections, ctx


def texts(blocks: list[Block]) -> list[str]:
    out = []
    for b in blocks:
        assert isinstance(b, Paragraph)
        out.append(plain_text(b.inlines))
    return out


def title(s: Section) -> str:
    return plain_text(s.title)


def all_ids(sections: list[Section]) -> list[str]:
    ids: list[str] = []
    for s in sections:
        ids.append(s.id)
        ids.extend(all_ids(s.sections))
    return ids


def test_hierarchy_from_styles() -> None:
    _, sections, _ = walk(
        h(1, "A") + p("a1") + h(2, "B") + p("b1") + h(2, "C") + p("c1") + h(1, "D") + p("d1")
    )
    assert [title(s) for s in sections] == ["A", "D"]
    a, d = sections
    assert texts(a.blocks) == ["a1"]
    assert [title(s) for s in a.sections] == ["B", "C"]
    assert [texts(s.blocks) for s in a.sections] == [["b1"], ["c1"]]
    assert texts(d.blocks) == ["d1"] and d.sections == []
    assert [s.id for s in a.sections] == ["s-a/s-b", "s-a/s-c"]
    assert a.blocks[0].id == "s-a#p-1"


def test_custom_heading_style_by_outline_level() -> None:
    body = '<w:p><w:pPr><w:pStyle w:val="ReportHead"/></w:pPr><w:r><w:t>Custom</w:t></w:r></w:p>'
    _, sections, ctx = walk(h(1, "Top") + body)
    assert [title(s) for s in sections[0].sections] == ["Custom"]
    assert ctx.flags == []


def test_repeated_titles_get_occurrence_ids() -> None:
    _, sections, _ = walk(
        h(1, "Results") + h(2, "Dissolution Results") + h(2, "Dissolution Results")
    )
    assert [s.id for s in sections[0].sections] == [
        "s-results/s-dissolution-results",
        "s-results/s-dissolution-results~2",
    ]


def test_titles_with_the_same_slug_get_occurrence_ids() -> None:
    _, sections, _ = walk(h(1, "A/B") + h(1, "A B"))
    assert [s.id for s in sections] == ["s-a-b", "s-a-b~2"]


def test_ids_survive_an_inserted_section() -> None:
    body = h(1, "Intro") + h(2, "Scope") + p("x") + h(1, "Results") + h(2, "Scope")
    _, before, _ = walk(body)
    _, after, _ = walk(h(1, "Preface") + p("new") + body)
    assert set(all_ids(before)) < set(all_ids(after))
    assert "s-preface" in all_ids(after)


def test_empty_heading_kept_and_flagged() -> None:
    _, sections, ctx = walk(h(1, "") + p("body"))
    assert [title(s) for s in sections] == ["[]"]
    assert texts(sections[0].blocks) == ["body"]
    assert [(f.code, f.at) for f in ctx.flags] == [("heading_empty", "s-untitled")]


def test_skipped_level_nests_and_flags() -> None:
    _, sections, ctx = walk(h(1, "A") + h(3, "Deep") + h(2, "B"))
    assert [title(s) for s in sections[0].sections] == ["Deep", "B"]
    assert [(f.code, f.at) for f in ctx.flags] == [("heading_skipped_level", "s-a/s-deep")]


def test_document_starting_at_level_two_is_not_flagged() -> None:
    _, sections, ctx = walk(h(2, "A") + p("a") + h(3, "B") + p("b") + h(2, "C"))
    assert [title(s) for s in sections] == ["A", "C"]
    assert [title(s) for s in sections[0].sections] == ["B"]
    assert ctx.flags == []


def test_leading_blocks_before_first_heading() -> None:
    blocks, sections, _ = walk(p("lead") + p("") + p("more") + h(1, "A"))
    assert texts(blocks) == ["lead", "more"]
    assert [b.id for b in blocks] == ["s-0#p-1", "s-0#p-2"]
    assert [title(s) for s in sections] == ["A"]


def test_heading_with_numbering_is_still_a_heading() -> None:
    body = (
        '<w:p><w:pPr><w:pStyle w:val="Heading1"/><w:numPr><w:numId w:val="2"/></w:numPr></w:pPr>'
        "<w:r><w:t>Numbered</w:t></w:r></w:p>" + p("text")
    )
    blocks, sections, _ = walk(body)
    assert blocks == [] and [title(s) for s in sections] == ["Numbered"]
    assert texts(sections[0].blocks) == ["text"]


def test_nested_lists_and_bullets() -> None:
    blocks, _, _ = walk(
        li(1, 0, "a") + li(1, 1, "a1") + li(1, 0, "b") + li(2, 0, "one") + li(2, 0, "two")
    )
    bullets, ordered = blocks
    assert isinstance(bullets, ListBlock) and isinstance(ordered, ListBlock)
    assert bullets.ordered is False and ordered.ordered is True
    assert [len(i.blocks) for i in bullets.items] == [2, 1]
    nested = bullets.items[0].blocks[1]
    assert isinstance(nested, ListBlock) and nested.ordered is False
    assert texts(nested.items[0].blocks) == ["a1"]
    assert texts(ordered.items[1].blocks) == ["two"]
    assert [bullets.id, nested.id, ordered.id] == ["s-0#list-1", "s-0#list-2", "s-0#list-3"]


def test_paragraph_between_list_paragraphs_ends_the_list() -> None:
    blocks, _, _ = walk(li(2, 0, "one") + p("between") + li(2, 0, "two"))
    assert [type(b) for b in blocks] == [ListBlock, Paragraph, ListBlock]


def test_content_control_unwrapped() -> None:
    body = (
        f"<w:sdt><w:sdtPr/><w:sdtContent>{h(1, 'In control')}{p('inside')}</w:sdtContent></w:sdt>"
    )
    _, sections, _ = walk(body + p("after"))
    assert [title(s) for s in sections] == ["In control"]
    assert texts(sections[0].blocks) == ["inside", "after"]
