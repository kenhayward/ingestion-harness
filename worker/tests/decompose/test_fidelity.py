"""Fidelity checks: text accounting against an independent walk of the source, table grids and
references."""

from __future__ import annotations

import re

import pytest

from ingest_worker.decompose import fidelity, references, tables
from ingest_worker.decompose.body import walk_body
from ingest_worker.decompose.fidelity import (
    IMAGE_ONLY_EQUATION,
    DecompositionFailed,
    check,
    source_text_units,
)
from ingest_worker.decompose.forms import located_text_form, text_form
from ingest_worker.decompose.inline import InlineContext, RunStyles
from ingest_worker.decompose.media import MediaContext
from ingest_worker.decompose.model import (
    Cell,
    DecomposedDocument,
    Figure,
    ImageBlock,
    InlineImage,
    NoteRef,
    Paragraph,
    Row,
    Section,
    Table,
    Text,
    XRef,
)
from ingest_worker.decompose.package import DecompositionFailed as PackageFailed
from ingest_worker.decompose.package import Package, open_package
from ingest_worker.decompose.references import notes_of, resolve_references
from tests.decompose.docx import NAMESPACES, build_docx
from tests.decompose.fakes import FakeRenderer
from tests.decompose.test_body import h as body_h
from tests.decompose.test_body import li as body_li
from tests.decompose.test_body import p as body_p
from tests.decompose.test_captions import DATA, SEQ_TABLE_13, caption_p, cell_with
from tests.decompose.test_captions import run as caption_run
from tests.decompose.test_captions import sup as caption_sup
from tests.decompose.test_equations import display, frac, o_math, r
from tests.decompose.test_media import EMPTY_VML, PNG, alternate, empty_shape, picture, text_box
from tests.decompose.test_references import (
    begin,
    bookmark,
    bookmark_end,
    end,
    field,
    instr,
    notes_part,
    separate,
    seq_caption,
)
from tests.decompose.test_tables import para as table_para
from tests.decompose.test_tables import tbl, tc, tr

STYLES = (
    f"<w:styles {NAMESPACES}>"
    + "".join(
        f'<w:style w:type="paragraph" w:styleId="Heading{n}"><w:name w:val="heading {n}"/>'
        f'<w:pPr><w:outlineLvl w:val="{n - 1}"/></w:pPr></w:style>'
        for n in (1, 2, 3)
    )
    + '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/></w:style>'
    '<w:style w:type="paragraph" w:styleId="TOC1"><w:name w:val="toc 1"/></w:style>'
    '<w:style w:type="paragraph" w:styleId="TableofFigures">'
    '<w:name w:val="table of figures"/></w:style>'
    '<w:style w:type="character" w:styleId="Hidden"><w:rPr><w:vanish/></w:rPr></w:style>'
    "</w:styles>"
)
NUMBERING = (
    f"<w:numbering {NAMESPACES}>"
    '<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl>'
    '<w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>'
    '<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>'
    "</w:numbering>"
)
IMAGE = {"rels": [("rIdImg", "image", "media/image1.png")], "media": {"image1.png": PNG}}


# --- Builders --------------------------------------------------------------------------------


def run(text: str, props: str = "") -> str:
    rpr = f"<w:rPr>{props}</w:rPr>" if props else ""
    return f'<w:r>{rpr}<w:t xml:space="preserve">{text}</w:t></w:r>'


def para(*runs: str, style: str | None = None, list_level: int | None = None) -> str:
    props = f'<w:pStyle w:val="{style}"/>' if style else ""
    if list_level is not None:
        props += f'<w:numPr><w:ilvl w:val="{list_level}"/><w:numId w:val="1"/></w:numPr>'
    return f"<w:p>{f'<w:pPr>{props}</w:pPr>' if props else ''}{''.join(runs)}</w:p>"


def heading(text: str, level: int = 1, *extra: str) -> str:
    return para(*extra, run(text), style=f"Heading{level}")


def sup(text: str) -> str:
    return run(text, '<w:vertAlign w:val="superscript"/>')


def cell(*paragraphs: str, props: str = "") -> str:
    return f"<w:tc><w:tcPr>{props}</w:tcPr>{''.join(paragraphs)}</w:tc>"


def decompose(body: str, **parts: object) -> tuple[DecomposedDocument, Package, InlineContext]:
    """The decomposition pipeline up to the check: body, notes, then references."""
    kwargs: dict[str, object] = {"styles": STYLES, "numbering": NUMBERING, **parts}
    pkg = open_package(build_docx(body, **kwargs))  # type: ignore[arg-type]
    media = MediaContext.for_package(pkg, FakeRenderer())
    ctx = InlineContext(styles=RunStyles.from_xml(pkg.xml("word/styles.xml")), media=media)
    blocks, sections = walk_body(pkg, ctx)
    notes = notes_of(pkg, ctx)
    doc = DecomposedDocument(
        blocks=blocks,
        sections=sections,
        images=media.images,
        equations=media.equations,
        notes=notes,
        properties=[],
        report=list(ctx.flags),
    )
    return resolve_references(doc, ctx), pkg, ctx


def rich_body() -> str:
    """A document holding most of what the decomposer reads."""
    return (
        para(run("Contents"))
        + para(field('TOC \\o "1-3"', "Results\t3"), style="TOC1")
        + heading("Results", 1, bookmark("_Toc1"), bookmark_end())
        + para(
            run("Dose\tlevel 5"),
            '<w:r><w:sym w:font="Symbol" w:char="F0B0"/></w:r>',
            run("C, see "),
            field("REF _Toc1 \\h", "Results"),
            run(" and Table 13."),
            run(" hidden", '<w:rStyle w:val="Hidden"/>'),
            '<w:r><w:footnoteReference w:id="2"/></w:r>',
            "<w:del><w:r><w:delText> deleted</w:delText></w:r></w:del>",
            "<w:ins><w:r><w:t> inserted</w:t></w:r></w:ins>",
        )
        + para(run("First item"), list_level=0)
        + para(run("Nested item"), list_level=1)
        + seq_caption("Table", 13, "Dissolution")
        + tbl(
            tr(cell(para(run("Time"))), cell(para(run("Release"), sup("a")))),
            tr(cell(para(run("30")), props='<w:vMerge w:val="restart"/>'), tc("85")),
            tr(cell(para(), props="<w:vMerge/>"), tc("90")),
            tr(tc("a: Samples at infinity", span=2)),
            cols=[100, 100],
        )
        + heading("Figures", 2)
        + para(f"<w:r>{picture(descr='A plot')}</w:r>")
        + para(run("Figure 1: The plot"), style="Caption")
        + para(run("Thus "), o_math(frac(r("a"), r("b"))), run(" holds."))
        + para(f"<w:r>{text_box('Box line one', 'Box line two')}</w:r>")
    )


def rich() -> tuple[DecomposedDocument, Package, InlineContext]:
    return decompose(
        rich_body(),
        footnotes=notes_part("footnote", (2, run(" A footnote."))),
        **IMAGE,
    )


def results(doc: DecomposedDocument) -> Section:
    return doc.sections[0]


def figures(doc: DecomposedDocument) -> Section:
    return doc.sections[0].sections[0]


# --- Passing ---------------------------------------------------------------------------------


def test_clean_document_passes() -> None:
    doc, pkg, ctx = rich()
    assert check(doc, pkg, ctx) is None


def test_source_units_apply_only_the_documented_conversions() -> None:
    doc, pkg, ctx = rich()
    section = results(doc).id
    table = next(b for b in results(doc).blocks if isinstance(b, Table))
    figure = figures(doc).blocks[0]
    equation = doc.equations[0]
    assert equation.mathml is not None
    assert source_text_units(pkg, ctx) == [
        "Contents",
        "Results",
        f"Dose level 5°C, see ⟦xref:{section}⟧ and ⟦xref:{table.id}⟧.⟦note:fn-2⟧ inserted",
        "First item",
        "Nested item",
        "Dissolution",
        "Time",
        "Releasea",
        "30",
        "85",
        "90",
        "a: Samples at infinity",
        "Figures",
        "The plot",
        "⟦img⟧ A plot",
        f"Thus ⟦eq:{equation.mathml}⟧ holds.",
        "⟦img⟧ Box line one Box line two",
        "A footnote.",
    ]
    assert text_form(doc) == source_text_units(pkg, ctx)
    assert figure.id.startswith(figures(doc).id)


def test_decomposition_failed_is_the_package_error() -> None:
    assert fidelity.DecompositionFailed is PackageFailed


# --- Failing ---------------------------------------------------------------------------------


def test_lost_paragraph_fails_with_place() -> None:
    body = (
        heading("Alpha")
        + para(run("One."))
        + heading("Beta")
        + para(run("Two."))
        + para(run("Three."))
    )
    doc, pkg, ctx = decompose(body)
    beta = doc.sections[1]
    lost = beta.model_copy(update={"blocks": beta.blocks[:1]})
    mutated = doc.model_copy(update={"sections": [doc.sections[0], lost]})
    with pytest.raises(DecompositionFailed) as failed:
        check(mutated, pkg, ctx)
    assert failed.value.at == beta.id
    assert "Three." in failed.value.detail
    assert "unit 4" in failed.value.detail


def test_changed_text_fails_with_both_texts_truncated() -> None:
    long = "x" * 300
    doc, pkg, ctx = decompose(heading("Alpha") + para(run(long)))
    (section,) = doc.sections
    paragraph = section.blocks[0]
    assert isinstance(paragraph, Paragraph)
    changed = paragraph.model_copy(update={"inlines": [Text(text="y" * 300)]})
    mutated = doc.model_copy(
        update={"sections": [section.model_copy(update={"blocks": [changed]})]}
    )
    with pytest.raises(DecompositionFailed) as failed:
        check(mutated, pkg, ctx)
    assert failed.value.at == section.id
    assert "x" * 120 in failed.value.detail and "x" * 121 not in failed.value.detail
    assert "y" * 120 in failed.value.detail and "y" * 121 not in failed.value.detail


def test_wrong_merge_fails() -> None:
    doc, pkg, ctx = rich()
    section = results(doc)
    table = next(b for b in section.blocks if isinstance(b, Table))
    merged = table.rows[1].cells[0]
    assert merged.row_span == 2
    rows = list(table.rows)
    rows[1] = Row(cells=[merged.model_copy(update={"row_span": 1}), *rows[1].cells[1:]])
    wrong = table.model_copy(update={"rows": rows})
    blocks = [wrong if b is table else b for b in section.blocks]
    mutated = doc.model_copy(update={"sections": [section.model_copy(update={"blocks": blocks})]})
    assert text_form(mutated) == text_form(doc)  # only the grid shows it
    with pytest.raises(DecompositionFailed) as failed:
        check(mutated, pkg, ctx)
    assert failed.value.at == table.id


def test_a_row_of_only_continue_cells_is_left_out_on_both_sides() -> None:
    restart, cont = '<w:vMerge w:val="restart"/>', "<w:vMerge/>"
    body = heading("Data") + tbl(
        tr(cell(para(run("A")), props=restart), cell(para(run("B")), props=restart)),
        tr(cell(para(), props=cont), cell(para(), props=cont)),
        tr(tc("C"), tc("D")),
        cols=[1, 1],
    )
    doc, pkg, ctx = decompose(body)
    (table,) = doc.sections[0].blocks
    assert isinstance(table, Table) and len(table.rows) == 2
    assert check(doc, pkg, ctx) is None


def test_text_moved_between_cells_fails() -> None:
    body = heading("Data") + tbl(tr(tc("A"), tc("")), tr(tc("B"), tc("C")), cols=[1, 1])
    doc, pkg, ctx = decompose(body)
    (section,) = doc.sections
    (table,) = section.blocks
    assert isinstance(table, Table)
    first, second = table.rows
    moved = [
        Row(cells=[first.cells[0], second.cells[0]]),
        Row(cells=[Cell(blocks=[]), second.cells[1]]),
    ]
    mutated = doc.model_copy(
        update={
            "sections": [
                section.model_copy(update={"blocks": [table.model_copy(update={"rows": moved})]})
            ]
        }
    )
    assert text_form(mutated) == text_form(doc)
    with pytest.raises(DecompositionFailed) as failed:
        check(mutated, pkg, ctx)
    assert failed.value.at == table.id


def _with_first_paragraph(doc: DecomposedDocument, inline: object) -> DecomposedDocument:
    section = doc.sections[0]
    paragraph = section.blocks[0]
    assert isinstance(paragraph, Paragraph)
    changed = paragraph.model_copy(update={"inlines": [*paragraph.inlines, inline]})
    blocks = [changed, *section.blocks[1:]]
    return doc.model_copy(
        update={"sections": [section.model_copy(update={"blocks": blocks}), *doc.sections[1:]]}
    )


@pytest.mark.parametrize(
    ("inline", "named"),
    [
        (NoteRef(note_id="fn-99"), "fn-99"),
        (XRef(target_id="s-nowhere", text="x"), "s-nowhere"),
        (XRef(target_id="bookmark:_Ref1", text="x"), "bookmark:_Ref1"),
        (InlineImage(image_id="img-missing"), "img-missing"),
    ],
)
def test_dangling_reference_fails(inline: object, named: str) -> None:
    doc, pkg, ctx = rich()
    with pytest.raises(DecompositionFailed) as failed:
        check(_with_first_paragraph(doc, inline), pkg, ctx)
    assert named in failed.value.detail
    assert failed.value.at == results(doc).id


def test_dangling_image_block_and_equation_image_fail() -> None:
    doc, pkg, ctx = rich()
    section = figures(doc)
    image = next(b for b in section.blocks if isinstance(b, ImageBlock))
    gone = image.model_copy(update={"image_id": "img-gone"})
    blocks = [gone if b is image else b for b in section.blocks]
    sub = section.model_copy(update={"blocks": blocks})
    mutated = doc.model_copy(
        update={"sections": [results(doc).model_copy(update={"sections": [sub]})]}
    )
    with pytest.raises(DecompositionFailed, match="img-gone"):
        check(mutated, pkg, ctx)

    equation = doc.equations[0].model_copy(update={"image_id": "eq-image-gone"})
    with pytest.raises(DecompositionFailed, match="eq-image-gone"):
        check(doc.model_copy(update={"equations": [equation]}), pkg, ctx)


def test_drawing_text_accounted_via_alt() -> None:
    doc, pkg, ctx = rich()
    box_image = next(i for i in doc.images if i.alt == "Box line one\nBox line two")
    check(doc, pkg, ctx)
    images = [i.model_copy(update={"alt": None}) if i is box_image else i for i in doc.images]
    with pytest.raises(DecompositionFailed) as failed:
        check(doc.model_copy(update={"images": images}), pkg, ctx)
    assert "Box line one" in failed.value.detail
    assert failed.value.at == figures(doc).id


def test_a_shape_that_draws_nothing_is_left_out_on_both_sides() -> None:
    shape = alternate(empty_shape(anchor=True), EMPTY_VML)
    doc, pkg, ctx = decompose(para(f"<w:r>{shape}</w:r>" + run("Approaches")))
    assert doc.images == []
    check(doc, pkg, ctx)


def test_image_only_equation_compared_by_its_image() -> None:
    body = heading("Maths") + para(
        run("See "), o_math("<m:box><m:e>" + r("x") + "</m:e></m:box>"), run(".")
    )
    doc, pkg, ctx = decompose(body)
    (equation,) = doc.equations
    assert equation.mathml is None
    assert text_form(doc) == ["Maths", f"See ⟦eq:{equation.image_id}⟧."]
    check(doc, pkg, ctx)


def test_unbalanced_field_end_is_ignored_on_both_sides() -> None:
    body = heading("A") + para(run("x"), '<w:r><w:fldChar w:fldCharType="end"/></w:r>', run("y"))
    doc, pkg, ctx = decompose(body)
    assert source_text_units(pkg, ctx) == ["A", "xy"]
    check(doc, pkg, ctx)


# --- Text the decomposer loses ---------------------------------------------------------------


@pytest.mark.parametrize(
    ("body", "lost"),
    [
        (
            para(
                "<w:r><w:ruby><w:rubyPr/><w:rt><w:r><w:t>top</w:t></w:r></w:rt>"
                "<w:rubyBase><w:r><w:t>base</w:t></w:r></w:rubyBase></w:ruby></w:r>"
            ),
            "topbase",
        ),
    ],
    ids=["ruby"],
)
def test_text_the_decomposer_drops_is_refused(body: str, lost: str) -> None:
    doc, pkg, ctx = decompose(heading("A") + body)
    assert text_form(doc) == ["A"]
    with pytest.raises(DecompositionFailed, match=lost):
        check(doc, pkg, ctx)


# --- The synthetic corpus passes -------------------------------------------------------------

#: Documents built with the other decomposition tests' builders, each decomposed in full and
#: checked: a refusal here is a false one, a bug in the source walk.
CORPUS: dict[str, str] = {
    "rich": rich_body(),
    "hierarchy": body_h(1, "Intro")
    + body_p("Para.")
    + body_h(2, "Sub")
    + body_h(2, "Sub")
    + body_h(1, "Next")
    + body_p(""),
    "lists": body_li(1, 0, "a")
    + body_li(1, 1, "b")
    + body_p("")
    + body_li(1, 0, "c")
    + body_p("x"),
    "content control": "<w:sdt><w:sdtPr/><w:sdtContent>"
    + body_p("in control")
    + "</w:sdtContent></w:sdt>",
    "caption rows": tbl(tr(tc("Table 13: Dissolution", span=2)), *DATA, cols=[100, 100])
    + tbl(tr(tc(span=2, content=SEQ_TABLE_13)), *DATA, cols=[100, 100]),
    "note rows": tbl(
        tr(tc("Table 13: Dissolution", span=2)),
        tr(tc("Time"), cell_with(caption_run("Release"), caption_sup("a"))),
        tr(tc("30"), cell_with(caption_run("85"), caption_sup("b"))),
        tr(tc("a: Samples at infinity", span=2)),
        tr(tc("b. Mean of six", span=2)),
        cols=[100, 100],
    ),
    "unrecognised note rows": tbl(
        tr(tc("Time"), cell_with(caption_run("Release"), caption_sup("a"))),
        tr(tc("a: Samples at infinity", span=2)),
        tr(tc("b: Not referenced", span=2)),
        cols=[100, 100],
    ),
    "notes table": tbl(
        tr(
            cell_with(caption_run("Release"), caption_sup("a")),
            cell_with(caption_run("85"), caption_sup("b")),
        ),
        cols=[1, 1],
    )
    + tbl(tr(tc(content=table_para("a: Samples at infinity") + table_para("b) Mean"))), cols=[200])
    + table_para("After."),
    "captions around tables": tbl(tr(tc("a")), cols=[1])
    + caption_p("Table 2: between")
    + tbl(tr(tc("b")), cols=[1])
    + caption_p("Table 3: after")
    + caption_p("Figure 4: nothing here"),
    "merges and fillers": tbl(
        tr(tc("A", vmerge="restart"), tc("1"), tc("x", span=2)),
        tr(tc("A2", vmerge="continue"), tc("2"), after=2),
        tr(tc("y"), before=2),
        cols=[1, 1, 1, 1],
    ),
    "nested table": tbl(
        tr(tc(content=tbl(*DATA, cols=[1, 1]) + table_para("below")), tc("side")), cols=[1, 1]
    ),
    "deleted row": tbl(
        tr(tc("kept")), tr(tc("gone"), trpr='<w:del w:id="1" w:author="a"/>'), cols=[1]
    ),
    "figure and inline image": para(f"<w:r>{picture(descr='A plot')}</w:r>")
    + para(run("Figure 1: The plot"), style="Caption")
    + para(run("Icon "), f"<w:r>{picture(title='gear')}</w:r>", run(" here.")),
    "heading with only a picture": heading("H")
    + para(f"<w:r>{picture(descr='Logo')}</w:r>", style="Heading2")
    + para(run("body")),
    "text boxes": para(f"<w:r>{text_box('In box', 'Second')}</w:r>")
    + para(run("Before "), f"<w:r>{text_box('Inline box')}</w:r>"),
    "equations": para(run("Thus "), o_math(frac(r("a"), r("b"))), run("."))
    + para(display(frac(r("a"), r("b")), r("c")))
    + para(display("<m:box><m:e>" + r("x") + "</m:e></m:box>"), list_level=0)
    + para(run("Eq "), o_math(r("y")), style="Heading1"),
    "fields": heading("Target", 1, bookmark("_Ref5"))
    + para(
        field("REF _Ref5 \\h", "Target"),
        field("REF _RefGone \\h", "Table 9"),
        field("PAGE", "7"),
        field('HYPERLINK "https://example.org"', "site"),
        field('HYPERLINK \\l "_Ref5"', "back"),
        field('HYPERLINK "javascript:alert(1)"', "click"),
    )
    + para(begin(), instr("REF _Ref5 \\h"), separate(), run("Tar"))
    + para(run("get"), end(), run(" tail")),
    "generated lists": para(run("Contents"))
    + para(begin(), instr('TOC \\o "1-3"'), separate(), run("Entry\t2"), style="TOC1")
    + para(run("Entry two\t3"), style="TOC1")
    + para(end())
    + para(run("Table 1: A\t2"), style="TableofFigures")
    + heading("After")
    + para(run("Body text.")),
    "typed references": heading("Data")
    + seq_caption("Table", 13, "Dissolution")
    + tbl(tr(tc("A"), tc("B")), cols=[2000, 2000])
    + para(run("see Table "), run("13", "<w:b/>"), run(" and Table 13, not Table 14."))
    + para(field('HYPERLINK "https://example.org"', "Table 13 online")),
    "characters": para(
        run("a\tb\N{NO-BREAK SPACE}c"),
        "<w:r><w:softHyphen/><w:noBreakHyphen/><w:cr/>"
        '<w:br w:type="page"/><w:ptab w:alignment="left"/></w:r>',
        '<w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r>',
        '<w:r><w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/></w:rPr><w:t>abc</w:t></w:r>',
        '<w:r><w:sym w:font="Unknown" w:char="F0B0"/></w:r>',
    ),
    "changes, comments and hidden text": para(
        "<w:ins><w:r><w:t>new </w:t></w:r></w:ins>",
        "<w:del><w:r><w:delText>old </w:delText></w:r></w:del>",
        "<w:moveTo><w:r><w:t>moved </w:t></w:r></w:moveTo>",
        "<w:moveFrom><w:r><w:t>away </w:t></w:r></w:moveFrom>",
        '<w:commentRangeStart w:id="0"/>',
        run("kept"),
        '<w:commentRangeEnd w:id="0"/><w:r><w:commentReference w:id="0"/></w:r>',
        run(" hidden", "<w:vanish/>"),
        run(" styled hidden", '<w:rStyle w:val="Hidden"/>'),
    ),
    "empty heading": para(style="Heading1") + para(run("after")),
    "empty headings between headings": heading("Before")
    + para(run("one"))
    + para(style="Heading1")
    + para(run("two"))
    + para('<w:r><w:t xml:space="preserve">  </w:t></w:r>', style="Heading2")
    + para("<w:r><w:br/></w:r>", style="Heading1")
    + para(run("three"))
    + heading("After"),
    "footnotes": para(run("Text"), '<w:r><w:footnoteReference w:id="3"/></w:r>'),
    "typed heading numbers": heading("1 Introduction", 1, run("", "<w:b/>"))
    + para(run("x"))
    + para(run("1", "<w:b/>"), run(".1	"), run("Scope", "<w:i/>"), style="Heading2")
    + heading("2023 Results"),
}


@pytest.mark.parametrize("name", list(CORPUS))
def test_synthetic_corpus_passes(name: str) -> None:
    note = run(" Note with ") + "</w:p>" + tbl(tr(tc("in note")), cols=[1]) + "<w:p>" + run("end")
    footnotes = notes_part("footnote", (2, run(" A footnote.")), (3, note))
    doc, pkg, ctx = decompose(CORPUS[name], footnotes=footnotes, **IMAGE)
    check(doc, pkg, ctx)
    located = located_text_form(doc, image_only=IMAGE_ONLY_EQUATION)
    assert [unit for unit, _ in located] == source_text_units(pkg, ctx)


def test_empty_headings_are_left_out_on_both_sides() -> None:
    doc, pkg, ctx = decompose(CORPUS["empty headings between headings"])
    check(doc, pkg, ctx)
    assert [s.id for s in doc.sections] == ["s-before", "s-after"]
    units = source_text_units(pkg, ctx)
    assert "[]" not in units
    assert units == ["Before", "one", "two", "three", "After"]


def test_typed_heading_numbers_are_left_out_on_both_sides() -> None:
    doc, pkg, ctx = decompose(CORPUS["typed heading numbers"])
    check(doc, pkg, ctx)
    assert source_text_units(pkg, ctx) == ["Introduction", "x", "Scope", "2023 Results"]


# --- Fix round 1 -----------------------------------------------------------------------------


def source_only(body: str, **parts: object) -> tuple[Package, InlineContext]:
    """A package and a fresh context, for a source the decomposer itself would refuse."""
    kwargs: dict[str, object] = {"styles": STYLES, "numbering": NUMBERING, **parts}
    pkg = open_package(build_docx(body, **kwargs))  # type: ignore[arg-type]
    return pkg, InlineContext(styles=RunStyles.from_xml(pkg.xml("word/styles.xml")))


def test_unterminated_field_is_refused_by_the_source_walk() -> None:
    open_field = begin() + instr("TOC") + separate() + run("entry")
    pkg, ctx = source_only(para(open_field) + para(run("Swallowed")))
    with pytest.raises(DecompositionFailed, match="the body never closed"):
        source_text_units(pkg, ctx)

    footnotes = notes_part("footnote", (1, open_field))
    pkg, ctx = source_only(para(run("Body")), footnotes=footnotes)
    with pytest.raises(DecompositionFailed, match="the footnotes never closed"):
        source_text_units(pkg, ctx)


def test_lost_or_moved_picture_without_alt_text_fails() -> None:
    body = heading("A") + para(f"<w:r>{picture()}</w:r>") + para(run("after"))
    doc, pkg, ctx = decompose(body, **IMAGE)
    (section,) = doc.sections
    image, after = section.blocks
    assert isinstance(image, ImageBlock)
    assert text_form(doc) == ["A", "⟦img⟧", "after"]
    check(doc, pkg, ctx)

    lost = doc.model_copy(update={"sections": [section.model_copy(update={"blocks": [after]})]})
    with pytest.raises(DecompositionFailed, match="⟦img⟧"):
        check(lost, pkg, ctx)

    moved = doc.model_copy(
        update={"sections": [section.model_copy(update={"blocks": [after, image]})]}
    )
    with pytest.raises(DecompositionFailed, match="⟦img⟧"):
        check(moved, pkg, ctx)


def test_dropped_footnote_reference_fails() -> None:
    doc, pkg, ctx = rich()
    section = results(doc)
    paragraph = next(b for b in section.blocks if isinstance(b, Paragraph))
    inlines = [i for i in paragraph.inlines if not isinstance(i, NoteRef)]
    assert len(inlines) < len(paragraph.inlines)
    blocks = [
        paragraph.model_copy(update={"inlines": inlines}) if b is paragraph else b
        for b in section.blocks
    ]
    mutated = doc.model_copy(update={"sections": [section.model_copy(update={"blocks": blocks})]})
    with pytest.raises(DecompositionFailed, match="note:fn-2") as failed:
        check(mutated, pkg, ctx)
    assert failed.value.at == section.id


@pytest.mark.parametrize(
    "embedded",
    [
        '<w:altChunk r:id="rIdChunk"/>',
        '<w:p><w:subDoc r:id="rIdChunk"/></w:p>',
    ],
    ids=["altChunk", "subDoc"],
)
def test_embedded_documents_are_refused(embedded: str) -> None:
    body = heading("A") + embedded + para(run("after"))
    with pytest.raises(DecompositionFailed, match="embedded documents") as failed:
        decompose(body)
    assert failed.value.at is not None and failed.value.at.startswith("s-a")
    pkg, ctx = source_only(body)
    with pytest.raises(DecompositionFailed, match="embedded documents"):
        source_text_units(pkg, ctx)


ALTERNATE_TEXT = (
    '<mc:AlternateContent><mc:Choice Requires="w14">{choice}</mc:Choice>'
    "<mc:Fallback>{fallback}</mc:Fallback></mc:AlternateContent>"
)


def test_custom_xml_and_alternate_content_are_read_in_place() -> None:
    body = (
        heading("A")
        + '<w:customXml w:element="block">'
        + para(run("in block custom XML"))
        + "</w:customXml>"
        + para(run("Run "), '<w:customXml w:element="run">', run("in custom XML"), "</w:customXml>")
        + para(
            run("Paragraph "),
            ALTERNATE_TEXT.format(choice=run("choice"), fallback=run("fallback")),
        )
        + para(
            run("Run "),
            "<w:r>"
            + ALTERNATE_TEXT.format(
                choice='<w:sym w:font="Wingdings" w:char="F0FC"/>', fallback="<w:t>check</w:t>"
            )
            + "</w:r>",
        )
        + ALTERNATE_TEXT.format(
            choice=para(run("block choice")), fallback=para(run("block fallback"))
        )
    )
    doc, pkg, ctx = decompose(body)
    assert text_form(doc) == [
        "A",
        "in block custom XML",
        "Run in custom XML",
        "Paragraph fallback",
        "Run check",
        "block fallback",
    ]
    check(doc, pkg, ctx)


def test_heading_holding_only_a_picture_agrees_on_both_sides() -> None:
    body = (
        heading("H")
        + para(f"<w:r>{picture(descr='Logo')}</w:r>", style="Heading2")
        + para(run("body"))
        + para(f"<w:r>{picture()}</w:r>", style="Heading2")
    )
    doc, pkg, ctx = decompose(body, **IMAGE)
    assert doc.sections[0].sections[0].title[0].kind == "inline_image"
    assert text_form(doc) == ["H", "⟦img⟧ Logo", "body", "⟦img⟧"]
    assert source_text_units(pkg, ctx) == text_form(doc)
    check(doc, pkg, ctx)


def test_typed_reference_split_by_a_bold_run_is_left_as_text_on_both_sides() -> None:
    body = (
        heading("Data")
        + seq_caption("Table", 13, "Dissolution")
        + tbl(tr(tc("A"), tc("B")), cols=[2000, 2000])
        + para(run("see Table "), run("13", "<w:b/>"), run(" and Table 13."))
    )
    doc, pkg, ctx = decompose(body)
    table = next(b for b in doc.sections[0].blocks if isinstance(b, Table))
    unit = f"see Table 13 and ⟦xref:{table.id}⟧."
    assert unit in text_form(doc)
    assert source_text_units(pkg, ctx) == text_form(doc)
    check(doc, pkg, ctx)


# --- Multi-part caption numbers --------------------------------------------------------------

MULTI_PART = (
    heading("Results")
    + caption_p("Table 3-1: Alpha")
    + tbl(tr(tc("A"), tc("B")), cols=[2000, 2000])
    + caption_p("Table 3-2: Beta")
    + tbl(tr(tc("C"), tc("D")), cols=[2000, 2000])
    + caption_p("Figure 14.2.1: Gamma")
    + para(f"<w:r>{picture()}</w:r>")
    + para(run("See Table 3-2 for beta and Figure 14.2.1."))
)
#: The patterns before multi-part numbers were read, standing in for a decomposer that cuts a
#: caption number, or matches a typed reference, short.
_SHORT_CAPTION = re.compile(r"^\s*(Table|Figure)\s*(\d+)\s*[:.\-\u2013\u2014]?\s*", re.I)
_SHORT_REFERENCE = re.compile(r"\b(Table|Figure)\s+(\d+)\b")


def test_multi_part_numbers_cut_whole_and_referenced_on_both_sides() -> None:
    doc, pkg, ctx = decompose(MULTI_PART, **IMAGE)
    (section,) = doc.sections
    first, second = (b for b in section.blocks if isinstance(b, Table))
    (figure,) = (b for b in section.blocks if isinstance(b, Figure))
    assert first.caption == [Text(text="Alpha")] and second.caption == [Text(text="Beta")]
    assert figure.caption == [Text(text="Gamma")]
    *_, last = section.blocks
    assert isinstance(last, Paragraph)
    assert last.inlines == [
        Text(text="See "),
        XRef(target_id=second.id, text="Table 3-2"),
        Text(text=" for beta and "),
        XRef(target_id=figure.id, text="Figure 14.2.1"),
        Text(text="."),
    ]
    assert source_text_units(pkg, ctx) == text_form(doc)
    check(doc, pkg, ctx)


def test_a_caption_number_cut_short_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(tables, "CAPTION_PREFIX", _SHORT_CAPTION)
    doc, pkg, ctx = decompose(MULTI_PART, **IMAGE)
    first = next(b for b in doc.sections[0].blocks if isinstance(b, Table))
    assert first.caption == [Text(text="1: Alpha")]  # the decomposer got it wrong
    with pytest.raises(DecompositionFailed, match="differs from the source"):
        check(doc, pkg, ctx)


def test_a_typed_reference_matched_short_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(references, "TYPED_REFERENCE", _SHORT_REFERENCE)
    doc, pkg, ctx = decompose(MULTI_PART, **IMAGE)
    *_, last = doc.sections[0].blocks
    assert isinstance(last, Paragraph)
    assert not any(isinstance(i, XRef) for i in last.inlines)  # the decomposer got it wrong
    with pytest.raises(DecompositionFailed, match="differs from the source"):
        check(doc, pkg, ctx)


# --- Symbol fonts set by styles --------------------------------------------------------------

_SYMBOL_FONT = '<w:rFonts w:ascii="Symbol" w:hAnsi="Symbol"/>'
SYMBOL_STYLES = STYLES.replace(
    "</w:styles>",
    f'<w:style w:type="character" w:styleId="Sym"><w:rPr>{_SYMBOL_FONT}</w:rPr></w:style>'
    '<w:style w:type="character" w:styleId="SymChild"><w:basedOn w:val="Sym"/></w:style>'
    f'<w:style w:type="paragraph" w:styleId="SymPara"><w:rPr>{_SYMBOL_FONT}</w:rPr></w:style>'
    "</w:styles>",
)
SYMBOL_DEFAULTS = (
    STYLES.replace("</w:styles>", "", 1).replace(
        f"<w:styles {NAMESPACES}>",
        f"<w:styles {NAMESPACES}><w:docDefaults><w:rPrDefault><w:rPr>{_SYMBOL_FONT}</w:rPr>"
        "</w:rPrDefault></w:docDefaults>",
    )
    + "</w:styles>"
)


@pytest.mark.parametrize(
    "body",
    [
        para(run("5 "), run("m", '<w:rStyle w:val="Sym"/>'), run("g")),
        para(run("5 "), run(chr(0xF06D), '<w:rStyle w:val="Sym"/>'), run("g")),
        para(run("5 "), run("m", '<w:rStyle w:val="SymChild"/>'), run("g")),
    ],
    ids=["character-style", "private-use", "based-on"],
)
def test_symbol_font_from_a_character_style_on_both_sides(body: str) -> None:
    doc, pkg, ctx = decompose(body, styles=SYMBOL_STYLES)
    assert text_form(doc) == ["5 µg"]
    assert source_text_units(pkg, ctx) == ["5 µg"]
    assert [f.code for f in doc.report] == []
    check(doc, pkg, ctx)


@pytest.mark.parametrize(
    ("body", "styles"),
    [(para(run("m"), style="SymPara"), SYMBOL_STYLES), (para(run("m")), SYMBOL_DEFAULTS)],
    ids=["paragraph-style", "defaults"],
)
def test_symbol_font_from_a_paragraph_style_or_the_defaults_on_both_sides(
    body: str, styles: str
) -> None:
    doc, pkg, ctx = decompose(body, styles=styles)
    assert text_form(doc) == ["µ"]
    assert source_text_units(pkg, ctx) == ["µ"]
    check(doc, pkg, ctx)


@pytest.mark.parametrize(
    ("props", "expected"),
    [
        ('<w:rFonts w:ascii="Times New Roman" w:cs="Symbol"/>', "m"),
        ('<w:rFonts w:ascii="Times New Roman" w:cs="Symbol"/><w:cs/>', "µ"),
        ('<w:rStyle w:val="Sym"/><w:rFonts w:ascii="Arial"/>', "m"),
        ('<w:rStyle w:val="Sym"/><w:rFonts w:asciiTheme="minorHAnsi"/>', "m"),
    ],
    ids=["complex-script-slot", "complex-script-run", "direct-overrides-style", "theme-font"],
)
def test_symbol_font_slot_chosen_by_the_text(props: str, expected: str) -> None:
    doc, pkg, ctx = decompose(para(run("m", props)), styles=SYMBOL_STYLES)
    assert text_form(doc) == [expected]
    assert source_text_units(pkg, ctx) == [expected]
    check(doc, pkg, ctx)


# --- Duplicate ids ---------------------------------------------------------------------------


def test_duplicate_block_ids_are_refused() -> None:
    doc, pkg, ctx = decompose(heading("Alpha") + para(run("One.")) + para(run("Two.")))
    (section,) = doc.sections
    first, second = section.blocks
    clash = second.model_copy(update={"id": first.id})
    mutated = doc.model_copy(
        update={"sections": [section.model_copy(update={"blocks": [first, clash]})]}
    )
    with pytest.raises(DecompositionFailed, match=f"duplicate id {first.id}"):
        check(mutated, pkg, ctx)


def test_a_block_with_a_section_id_is_refused() -> None:
    doc, pkg, ctx = decompose(para(run("Before.")) + heading("Alpha") + para(run("One.")))
    (section,) = doc.sections
    (leading,) = doc.blocks
    mutated = doc.model_copy(update={"blocks": [leading.model_copy(update={"id": section.id})]})
    with pytest.raises(DecompositionFailed, match=f"duplicate id {section.id}"):
        check(mutated, pkg, ctx)


def test_deleted_fraction_is_image_only_on_both_sides() -> None:
    gone = '<w:del w:id="8" w:author="x">' + r("a") + "</w:del>"
    ctrl = '<m:ctrlPr><w:del w:id="9" w:author="x"><w:rPr/></w:del></m:ctrlPr>'
    fraction = f"<m:f><m:fPr>{ctrl}</m:fPr><m:num>{gone}</m:num><m:den>{gone}</m:den></m:f>"
    doc, pkg, ctx = decompose(heading("Maths") + para(display(r("y=") + fraction)))
    (equation,) = doc.equations
    assert equation.mathml is None
    assert source_text_units(pkg, ctx) == ["Maths", IMAGE_ONLY_EQUATION]
    check(doc, pkg, ctx)
