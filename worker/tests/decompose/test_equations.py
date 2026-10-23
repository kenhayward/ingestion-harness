"""Word equations as MathML, LaTeX and a rendered image."""

from __future__ import annotations

import pytest

from ingest_worker.decompose.equations import mathml_to_latex, omml_to_mathml
from ingest_worker.decompose.model import (
    EquationBlock,
    InlineEquation,
    Paragraph,
    Text,
)
from ingest_worker.decompose.package import DecompositionFailed, parse_xml
from tests.decompose.docx import NAMESPACES
from tests.decompose.fakes import FakeRenderer
from tests.decompose.test_media import flags, para, read, text_run

MATHML_NS = "http://www.w3.org/1998/Math/MathML"

# --- Builders --------------------------------------------------------------------------------


def r(text: str, props: str = "") -> str:
    rpr = f"<m:rPr>{props}</m:rPr>" if props else ""
    return f'<m:r>{rpr}<m:t xml:space="preserve">{text}</m:t></m:r>'


def frac(num: str, den: str) -> str:
    return f"<m:f><m:fPr><m:ctrlPr/></m:fPr><m:num>{num}</m:num><m:den>{den}</m:den></m:f>"


def sup(base: str, script: str) -> str:
    return f"<m:sSup><m:e>{base}</m:e><m:sup>{script}</m:sup></m:sSup>"


def sub(base: str, script: str) -> str:
    return f"<m:sSub><m:e>{base}</m:e><m:sub>{script}</m:sub></m:sSub>"


def nary(chr_: str, lower: str, upper: str, body: str, loc: str = "undOvr") -> str:
    return (
        f'<m:nary><m:naryPr><m:chr m:val="{chr_}"/><m:limLoc m:val="{loc}"/></m:naryPr>'
        f"<m:sub>{lower}</m:sub><m:sup>{upper}</m:sup><m:e>{body}</m:e></m:nary>"
    )


def o_math(inner: str) -> str:
    return f"<m:oMath>{inner}</m:oMath>"


def display(*equations: str) -> str:
    return f"<m:oMathPara>{''.join(o_math(e) for e in equations)}</m:oMathPara>"


def mathml(inner: str) -> str:
    """The OMML `inner` (the content of an `m:oMath`) as MathML."""
    root = parse_xml(f"<w:document {NAMESPACES}>{o_math(inner)}</w:document>".encode())
    return omml_to_mathml(root[0]) or "None"


def latex(inner: str) -> str | None:
    converted = omml_to_mathml(
        parse_xml(f"<w:document {NAMESPACES}>{o_math(inner)}</w:document>".encode())[0]
    )
    assert converted is not None
    return mathml_to_latex(converted)


def math_of(body: str) -> str:
    return f'<math xmlns="{MATHML_NS}">{body}</math>'


# --- Conversion ------------------------------------------------------------------------------


def test_fraction_and_superscript() -> None:
    omml = frac(sup(r("a"), r("2")), r("b"))
    expected = "<mfrac><msup><mi>a</mi><mn>2</mn></msup><mi>b</mi></mfrac>"
    assert "".join(mathml(omml).split()) == "".join(math_of(expected).split())
    assert latex(omml) == r"\frac{a^{2}}{b}"


def test_nary_sum_with_limits() -> None:
    omml = nary("∑", r("i=1"), r("n"), sub(r("x"), r("i")))
    assert latex(omml) == r"\sum_{i=1}^{n} x_{i}"
    assert mathml(omml) == math_of(
        "<mrow><munderover><mo>∑</mo><mrow><mi>i</mi><mo>=</mo><mn>1</mn></mrow><mi>n</mi>"
        "</munderover><msub><mi>x</mi><mi>i</mi></msub></mrow>"
    )


def test_mathml_is_serialised_without_whitespace_and_escaped() -> None:
    assert mathml(r("a&lt;b")) == math_of("<mi>a</mi><mo>&lt;</mo><mi>b</mi>")
    assert latex(r("a&lt;b")) == "a<b"


@pytest.mark.parametrize(
    ("omml", "expected"),
    [
        (r("12.5x"), "12.5x"),
        (sub(r("x"), r("i")), "x_{i}"),
        (
            "<m:sSubSup><m:e>"
            + r("x")
            + "</m:e><m:sub>"
            + r("i")
            + "</m:sub><m:sup>"
            + r("2")
            + "</m:sup></m:sSubSup>",
            "x_{i}^{2}",
        ),
        (sup(frac(r("a"), r("b")), r("2")), r"{\frac{a}{b}}^{2}"),
        (
            '<m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:deg/><m:e>'
            + r("x")
            + "</m:e></m:rad>",
            r"\sqrt{x}",
        ),
        ("<m:rad><m:deg>" + r("3") + "</m:deg><m:e>" + r("x") + "</m:e></m:rad>", r"\sqrt[3]{x}"),
        ("<m:d><m:e>" + r("a+b") + "</m:e></m:d>", r"\left(a+b\right)"),
        (
            '<m:d><m:dPr><m:begChr m:val="["/><m:endChr m:val=""/></m:dPr><m:e>'
            + r("a")
            + "</m:e><m:e>"
            + r("b")
            + "</m:e></m:d>",
            r"\left[a|b\right.",
        ),
        (
            '<m:d><m:dPr><m:begChr m:val="{"/><m:endChr m:val="}"/></m:dPr><m:e>'
            + r("x")
            + "</m:e></m:d>",
            r"\left\{x\right\}",
        ),
        (nary("∫", r("0"), r("1"), r("f"), loc="subSup"), r"\int_{0}^{1} f"),
        (nary("∑", r("i"), r("n"), r("x"), loc="subSup"), r"\sum\nolimits_{i}^{n} x"),
        (nary("∫", r("a"), r("b"), r("f")), r"\int\limits_{a}^{b} f"),
        (
            '<m:nary><m:naryPr><m:chr m:val="∏"/><m:supHide m:val="1"/></m:naryPr>'
            "<m:sub>" + r("k") + "</m:sub><m:sup/><m:e>" + r("a") + "</m:e></m:nary>",
            r"\prod_{k} a",
        ),
        (
            '<m:bar><m:barPr><m:pos m:val="top"/></m:barPr><m:e>' + r("x") + "</m:e></m:bar>",
            r"\bar{x}",
        ),
        ("<m:acc><m:e>" + r("y") + "</m:e></m:acc>", r"\hat{y}"),
        (
            '<m:acc><m:accPr><m:chr m:val="\u0303"/></m:accPr><m:e>' + r("y") + "</m:e></m:acc>",
            r"\tilde{y}",
        ),
        (
            "<m:func><m:fName>"
            + r("sin", '<m:sty m:val="p"/>')
            + "</m:fName><m:e>"
            + r("x")
            + "</m:e></m:func>",
            r"\operatorname{sin}x",
        ),
        (
            "<m:eqArr><m:e>" + r("x&amp;=1") + "</m:e><m:e>" + r("y&amp;=2") + "</m:e></m:eqArr>",
            r"\begin{aligned}x&=1\\y&=2\end{aligned}",
        ),
        (r("α≤β"), r"\alpha\leq\beta"),
        (r("if x", "<m:nor/>"), r"\text{if x}"),
        (r("R", '<m:sty m:val="p"/>'), r"\mathrm{R}"),
        (r("a{b}"), r"a\{b\}"),
    ],
)
def test_latex_covers_the_subset(omml: str, expected: str) -> None:
    assert latex(omml) == expected


def test_radical_and_delimiter_mathml() -> None:
    assert mathml("<m:rad><m:deg>" + r("3") + "</m:deg><m:e>" + r("x") + "</m:e></m:rad>") == (
        math_of("<mroot><mi>x</mi><mn>3</mn></mroot>")
    )
    assert mathml("<m:d><m:e>" + r("a") + "</m:e></m:d>") == math_of(
        '<mrow><mo fence="true" form="prefix">(</mo><mi>a</mi>'
        '<mo fence="true" form="postfix">)</mo></mrow>'
    )


def test_function_and_equation_array_mathml() -> None:
    func = "<m:func><m:fName>" + r("log") + "</m:fName><m:e>" + r("x") + "</m:e></m:func>"
    assert mathml(func) == math_of("<mrow><mi>log</mi><mo>\u2061</mo><mi>x</mi></mrow>")
    arr = "<m:eqArr><m:e>" + r("x&amp;=1") + "</m:e><m:e>" + r("y") + "</m:e></m:eqArr>"
    assert mathml(arr) == math_of(
        "<mtable><mtr><mtd><mi>x</mi></mtd><mtd><mrow><mo>=</mo><mn>1</mn></mrow></mtd></mtr>"
        "<mtr><mtd><mi>y</mi></mtd></mtr></mtable>"
    )


@pytest.mark.parametrize(
    "omml",
    [
        "<m:box><m:e>" + r("x") + "</m:e></m:box>",
        "<m:sPre><m:sub/><m:sup/><m:e>" + r("x") + "</m:e></m:sPre>",
        "<m:limLow><m:e>" + r("lim") + "</m:e><m:lim>" + r("n") + "</m:lim></m:limLow>",
        "<m:m><m:mr><m:e>" + r("1") + "</m:e></m:mr></m:m>",
        "<m:bar><m:e>" + r("x") + "</m:e></m:bar>",  # a bar below
        '<m:f><m:fPr><m:type m:val="lin"/></m:fPr><m:num/><m:den/></m:f>',
        frac(r("a"), "<m:groupChr><m:e>" + r("x") + "</m:e></m:groupChr>"),
    ],
)
def test_unsupported_constructs_give_none(omml: str) -> None:
    assert mathml(omml) == "None"


def test_tracked_changes_in_an_equation_are_accepted() -> None:
    omml = "<w:ins>" + r("a") + "</w:ins><w:del>" + r("b") + "</w:del>"
    assert mathml(omml) == math_of("<mi>a</mi>")


# --- In the document -------------------------------------------------------------------------


def test_inline_vs_display() -> None:
    body = para(text_run("Where "), o_math(r("x")), text_run(" holds.")) + para(
        display(frac(r("a"), r("b")), r("c"))
    )
    blocks, ctx, media = read(body)
    eq1, eq2, eq3 = media.equations
    assert blocks == [
        Paragraph(
            id="s-0#p-1",
            inlines=[
                Text(text="Where "),
                InlineEquation(equation_id=eq1.id),
                Text(text=" holds."),
            ],
        ),
        EquationBlock(id="s-0#equation-1", equation_id=eq2.id),
        EquationBlock(id="s-0#equation-2", equation_id=eq3.id),
    ]
    assert [e.id for e in media.equations] == [
        "s-0#p-1#eq-1",
        "s-0#equation-1#eq-1",
        "s-0#equation-2#eq-1",
    ]
    assert eq2.latex == r"\frac{a}{b}"
    assert eq3.mathml == math_of("<mi>c</mi>")
    images = {i.id: i for i in media.images}
    assert [images[e.image_id].origin for e in (eq1, eq2, eq3)] == ["rendered"] * 3
    assert images[eq1.image_id].align == "inline"
    assert images[eq2.image_id].align == "center"
    assert eq1.image_id == "s-0#p-1#eq-1#img-1"
    assert flags(ctx) == []


def test_equation_rendered_from_a_fragment_holding_it() -> None:
    renderer = FakeRenderer()
    _, _, media = read(para(display(r("x"))), renderer=renderer)
    [fragment] = renderer.fragments
    assert "<m:oMathPara><m:oMath" in fragment.body_xml
    assert ">x</m:t>" in fragment.body_xml
    [equation] = media.equations
    assert media.image_bytes[equation.image_id] == renderer.png


def test_unsupported_box_is_image_only_and_flagged() -> None:
    _, ctx, media = read(para(display("<m:box><m:e>" + r("x") + "</m:e></m:box>")))
    [equation] = media.equations
    assert (equation.mathml, equation.latex) == (None, None)
    assert equation.image_id in {i.id for i in media.images}
    assert flags(ctx) == [("equation_image_only", "s-0#equation-1")]


def test_equation_that_cannot_render_fails_document() -> None:
    with pytest.raises(DecompositionFailed, match=r"equation .* could not be rendered"):
        read(para(display(r("x"))), renderer=FakeRenderer(fails=True))


def test_tracked_changes_in_an_equation_are_counted_and_not_rendered() -> None:
    renderer = FakeRenderer()
    omml = "<w:ins>" + r("a") + "</w:ins><w:del>" + r("b") + "</w:del>"
    _, ctx, media = read(para(display(omml)), renderer=renderer)
    assert ctx.changes == 2
    assert media.equations[0].mathml == math_of("<mi>a</mi>")
    assert ">b</m:t>" not in renderer.fragments[0].body_xml


def test_display_equations_beside_text_are_inline() -> None:
    blocks, _, media = read(para(text_run("Thus "), display(r("x"))))
    [equation] = media.equations
    assert blocks == [
        Paragraph(
            id="s-0#p-1",
            inlines=[Text(text="Thus "), InlineEquation(equation_id=equation.id)],
        )
    ]
