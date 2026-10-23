"""Word equations (OMML) as MathML, LaTeX derived from it, and a rendered image.

The converter covers a defined subset of OMML: text runs, fractions, scripts, radicals,
delimiters, n-ary operators, bars and accents, functions and equation arrays. Anything else
gives no MathML, and the equation is kept as its image only, flagged. MathML is built as an
element tree, so text is escaped, and serialised with no whitespace between elements. Every
equation is also rendered through the `Renderer`; one that cannot be rendered fails the
document.
"""

from __future__ import annotations

import copy
import re
from collections.abc import Callable, Iterator
from typing import TYPE_CHECKING
from xml.etree import ElementTree
from xml.etree.ElementTree import Element

from .model import Equation, Flag
from .package import DecompositionFailed, parse_xml

if TYPE_CHECKING:
    from .inline import InlineContext

M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"
_W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
MATHML = "http://www.w3.org/1998/Math/MathML"
_MML = f"{{{MATHML}}}"

O_MATH = f"{M}oMath"
O_MATH_PARA = f"{M}oMathPara"

_ON = {"1", "on", "true"}
#: Tracked changes inside an equation: read as accepted.
_ACCEPTED = {f"{_W}ins", f"{_W}moveTo"}
_REJECTED = {f"{_W}del", f"{_W}moveFrom"}
#: Markup inside an equation that carries no content of its own.
_IGNORED = {
    f"{_W}{name}"
    for name in (
        "rPr",
        "bookmarkStart",
        "bookmarkEnd",
        "proofErr",
        "permStart",
        "permEnd",
        "commentRangeStart",
        "commentRangeEnd",
    )
}
_INTEGRALS = {"∫", "∬", "∭", "∮", "∯", "∰"}
#: Word's combining accent characters, as the spacing characters MathML puts over a base.
_SPACING_ACCENTS = {
    "\u0300": "`",
    "\u0301": "´",
    "\u0302": "^",
    "\u0303": "~",
    "\u0304": "¯",
    "\u0305": "¯",
    "\u0306": "˘",
    "\u0307": "˙",
    "\u0308": "¨",
    "\u030c": "ˇ",
    "\u20d7": "→",
}
_FUNCTION_APPLICATION = "\u2061"
_STY_VARIANTS = {"p": "normal", "b": "bold", "bi": "bold-italic"}


class _Unsupported(Exception):
    """A construct outside the converter's subset."""


def _m(tag: str, *children: Element, text: str | None = None, **attrs: str) -> Element:
    el = Element(tag, attrs)
    el.text = text
    el.extend(children)
    return el


# --- OMML to MathML --------------------------------------------------------------------------


def omml_to_mathml(o: Element) -> str | None:
    """An `m:oMath` as a MathML `<math>` string, or None when it holds anything outside the
    supported subset."""
    try:
        children = _content(o)
    except _Unsupported:
        return None
    root = _m("math", *children, xmlns=MATHML)
    return ElementTree.tostring(root, encoding="unicode", short_empty_elements=False)


def _flag_on(props: Element | None, name: str) -> bool:
    el = props.find(f"{M}{name}") if props is not None else None
    return el is not None and el.get(f"{M}val", "1").lower() in _ON


def _val(props: Element | None, name: str, default: str) -> str:
    el = props.find(f"{M}{name}") if props is not None else None
    if el is None:
        return default
    return el.get(f"{M}val", default)


def _content(parent: Element) -> list[Element]:
    """The MathML of the math elements under `parent` (an `m:oMath` or an argument)."""
    out: list[Element] = []
    for child in parent:
        tag = child.tag
        if tag in _ACCEPTED:
            out.extend(_content(child))
        elif tag in _REJECTED or tag in _IGNORED or (tag.startswith(M) and tag.endswith("Pr")):
            continue
        elif tag in _CONVERTERS:
            out.extend(_CONVERTERS[tag](child))
        else:
            raise _Unsupported(tag)
    return out


def _row(items: list[Element]) -> Element:
    """One element for a list of them: the only one, or an `mrow` of them."""
    return items[0] if len(items) == 1 else _m("mrow", *items)


def _arg(parent: Element, name: str) -> Element:
    """The MathML of argument `name` of `parent`, as one element."""
    arg = parent.find(f"{M}{name}")
    return _row(_content(arg) if arg is not None else [])


def _run(r: Element) -> list[Element]:
    props = r.find(f"{M}rPr")
    texts: list[str] = []
    for child in r:
        if child.tag == f"{M}t":
            texts.append(child.text or "")
        elif child.tag not in (f"{M}rPr", f"{_W}rPr"):
            raise _Unsupported(child.tag)
    text = "".join(texts)
    if _flag_on(props, "nor"):
        return [_m("mtext", text=text)] if text else []
    variant = _STY_VARIANTS.get(_val(props, "sty", "i"))
    return list(_tokens(text, variant))


_NUMBER = re.compile(r"[0-9]+(?:\.[0-9]+)?")


def _tokens(text: str, variant: str | None) -> Iterator[Element]:
    """Text as `mn` for digit runs, `mi` for letters and `mo` for anything else but spaces."""
    i = 0
    while i < len(text):
        ch = text[i]
        number = _NUMBER.match(text, i)
        if number is not None:
            yield _m("mn", text=number.group())
            i = number.end()
            continue
        if ch.isalpha():
            yield _m("mi", text=ch, **({"mathvariant": variant} if variant else {}))
        elif not ch.isspace():
            yield _m("mo", text=ch)
        i += 1


def _fraction(f: Element) -> list[Element]:
    if _val(f.find(f"{M}fPr"), "type", "bar") != "bar":
        raise _Unsupported("fraction type")
    return [_m("mfrac", _arg(f, "num"), _arg(f, "den"))]


def _sup(el: Element) -> list[Element]:
    return [_m("msup", _arg(el, "e"), _arg(el, "sup"))]


def _sub(el: Element) -> list[Element]:
    return [_m("msub", _arg(el, "e"), _arg(el, "sub"))]


def _sub_sup(el: Element) -> list[Element]:
    return [_m("msubsup", _arg(el, "e"), _arg(el, "sub"), _arg(el, "sup"))]


def _radical(el: Element) -> list[Element]:
    deg = el.find(f"{M}deg")
    degree = _content(deg) if deg is not None else []
    if _flag_on(el.find(f"{M}radPr"), "degHide") or not degree:
        return [_m("msqrt", _arg(el, "e"))]
    return [_m("mroot", _arg(el, "e"), _row(degree))]


def _delimiter(el: Element) -> list[Element]:
    props = el.find(f"{M}dPr")
    begin = _val(props, "begChr", "(")
    end = _val(props, "endChr", ")")
    sep = _val(props, "sepChr", "|")
    items: list[Element] = [_m("mo", text=begin, fence="true", form="prefix")]
    for n, e in enumerate(el.findall(f"{M}e")):
        if n:
            items.append(_m("mo", text=sep, separator="true"))
        items.append(_row(_content(e)))
    items.append(_m("mo", text=end, fence="true", form="postfix"))
    return [_m("mrow", *items)]


def _nary(el: Element) -> list[Element]:
    props = el.find(f"{M}naryPr")
    op_char = _val(props, "chr", "∫")
    loc = _val(props, "limLoc", "subSup" if op_char in _INTEGRALS else "undOvr")
    op = _m("mo", text=op_char)
    lower = None if _flag_on(props, "subHide") else _arg(el, "sub")
    upper = None if _flag_on(props, "supHide") else _arg(el, "sup")
    under, over, both = ("munder", "mover", "munderover")
    if loc == "subSup":
        under, over, both = ("msub", "msup", "msubsup")
    if lower is not None and upper is not None:
        operator = _m(both, op, lower, upper)
    elif lower is not None:
        operator = _m(under, op, lower)
    elif upper is not None:
        operator = _m(over, op, upper)
    else:
        operator = op
    return [_m("mrow", operator, _arg(el, "e"))]


def _bar(el: Element) -> list[Element]:
    if _val(el.find(f"{M}barPr"), "pos", "bot") != "top":
        raise _Unsupported("bar below")
    return [_m("mover", _arg(el, "e"), _m("mo", text="¯"), accent="true")]


def _accent(el: Element) -> list[Element]:
    char = _val(el.find(f"{M}accPr"), "chr", "\u0302")
    mark = _SPACING_ACCENTS.get(char, char)
    return [_m("mover", _arg(el, "e"), _m("mo", text=mark), accent="true")]


def _function(el: Element) -> list[Element]:
    name = el.find(f"{M}fName")
    texts: list[str] = []
    for r in name if name is not None else []:
        if r.tag != f"{M}r":
            raise _Unsupported("function name")
        texts.extend(t.text or "" for t in r.findall(f"{M}t"))
    function = _m("mi", text="".join(texts).strip())
    return [_m("mrow", function, _m("mo", text=_FUNCTION_APPLICATION), _arg(el, "e"))]


def _equation_array(el: Element) -> list[Element]:
    rows: list[Element] = []
    for e in el.findall(f"{M}e"):
        cells: list[list[Element]] = [[]]
        for item in _content(e):
            if item.tag == "mo" and item.text == "&":
                cells.append([])
            else:
                cells[-1].append(item)
        rows.append(_m("mtr", *(_m("mtd", _row(c)) if c else _m("mtd") for c in cells)))
    return [_m("mtable", *rows)]


_CONVERTERS: dict[str, Callable[[Element], list[Element]]] = {
    f"{M}r": _run,
    f"{M}f": _fraction,
    f"{M}sSup": _sup,
    f"{M}sSub": _sub,
    f"{M}sSubSup": _sub_sup,
    f"{M}rad": _radical,
    f"{M}d": _delimiter,
    f"{M}nary": _nary,
    f"{M}bar": _bar,
    f"{M}acc": _accent,
    f"{M}func": _function,
    f"{M}eqArr": _equation_array,
}


# --- MathML to LaTeX -------------------------------------------------------------------------

_GREEK = {
    "α": "alpha", "β": "beta", "γ": "gamma", "δ": "delta", "ε": "epsilon", "ϵ": "epsilon",
    "ζ": "zeta", "η": "eta", "θ": "theta", "ϑ": "vartheta", "ι": "iota", "κ": "kappa",
    "λ": "lambda", "μ": "mu", "ν": "nu", "ξ": "xi", "π": "pi", "ϖ": "varpi", "ρ": "rho",
    "ϱ": "varrho", "σ": "sigma", "ς": "varsigma", "τ": "tau", "υ": "upsilon", "φ": "phi",
    "ϕ": "phi", "χ": "chi", "ψ": "psi", "ω": "omega", "Γ": "Gamma", "Δ": "Delta",
    "Θ": "Theta", "Λ": "Lambda", "Ξ": "Xi", "Π": "Pi", "Σ": "Sigma", "Υ": "Upsilon",
    "Φ": "Phi", "Ψ": "Psi", "Ω": "Omega",
}  # fmt: skip
_SYMBOLS = {
    **{ch: f"\\{name}" for ch, name in _GREEK.items()},
    "±": r"\pm", "∓": r"\mp", "×": r"\times", "÷": r"\div", "·": r"\cdot", "⋅": r"\cdot",
    "∗": r"\ast", "−": "-", "≤": r"\leq", "≥": r"\geq", "≠": r"\neq", "≈": r"\approx",
    "≡": r"\equiv", "∝": r"\propto", "∼": r"\sim", "≪": r"\ll", "≫": r"\gg", "∞": r"\infty",
    "→": r"\rightarrow", "←": r"\leftarrow", "↔": r"\leftrightarrow", "⇒": r"\Rightarrow",
    "⇐": r"\Leftarrow", "⇔": r"\Leftrightarrow", "∈": r"\in", "∉": r"\notin",
    "⊂": r"\subset", "⊆": r"\subseteq", "⊃": r"\supset", "⊇": r"\supseteq", "∪": r"\cup",
    "∩": r"\cap", "∂": r"\partial", "∇": r"\nabla", "∀": r"\forall", "∃": r"\exists",
    "¬": r"\neg", "∧": r"\wedge", "∨": r"\vee", "…": r"\ldots", "⋯": r"\cdots",
    "°": r"^{\circ}", "′": "'", "″": "''", "{": r"\{", "}": r"\}", "#": r"\#", "%": r"\%",
    "&": r"\&", "$": r"\$", "_": r"\_", "\\": r"\backslash", "~": r"\sim",
    _FUNCTION_APPLICATION: "",
}  # fmt: skip
#: Characters with no meaning of their own in maths mode.
_UNMAPPED = {"^"}
_LARGE_OPERATORS = {
    "∑": r"\sum", "∏": r"\prod", "∐": r"\coprod", "∫": r"\int", "∬": r"\iint",
    "∭": r"\iiint", "∮": r"\oint", "⋃": r"\bigcup", "⋂": r"\bigcap", "⋁": r"\bigvee",
    "⋀": r"\bigwedge", "⨁": r"\bigoplus", "⨂": r"\bigotimes",
}  # fmt: skip
_ACCENTS = {
    "^": r"\hat", "~": r"\tilde", "¯": r"\bar", "‾": r"\bar", "˙": r"\dot", "¨": r"\ddot",
    "→": r"\vec", "´": r"\acute", "`": r"\grave", "ˇ": r"\check", "˘": r"\breve",
}  # fmt: skip
_FENCES = {
    "": ".", "(": "(", ")": ")", "[": "[", "]": "]", "|": "|", "/": "/",
    "{": r"\{", "}": r"\}", "⟨": r"\langle", "⟩": r"\rangle", "〈": r"\langle",
    "〉": r"\rangle", "‖": r"\|", "⌊": r"\lfloor", "⌋": r"\rfloor", "⌈": r"\lceil",
    "⌉": r"\rceil",
}  # fmt: skip
_VARIANTS = {"normal": r"\mathrm", "bold": r"\mathbf", "bold-italic": r"\boldsymbol"}
_TEXT_ESCAPES = {
    "\\": r"\textbackslash{}", "{": r"\{", "}": r"\}", "$": r"\$", "&": r"\&", "#": r"\#",
    "%": r"\%", "_": r"\_", "^": r"\textasciicircum{}", "~": r"\textasciitilde{}",
}  # fmt: skip
_COMMAND_END = re.compile(r"\\[A-Za-z]+$")


def mathml_to_latex(mathml: str) -> str | None:
    """LaTeX for MathML as `omml_to_mathml` writes it, or None when it holds anything the
    mapping doesn't cover."""
    root = parse_xml(mathml.encode("utf-8"))
    if _local(root) != "math":
        return None
    try:
        return _join(list(root))
    except _Unsupported:
        return None


def _local(el: Element) -> str:
    return el.tag.removeprefix(_MML)


def _join(items: list[Element]) -> str:
    """The LaTeX of a sequence of elements, spaced where a command would run into a letter,
    and after an n-ary operator."""
    out = ""
    after_operator = False
    for item in items:
        piece = _latex(item)
        if piece and (after_operator or (_COMMAND_END.search(out) and piece[0].isalpha())):
            out += " "
        out += piece
        after_operator = _is_large_operator(item)
    return out


def _large_operator(el: Element) -> str | None:
    """The character of the large operator `el` is, alone or with limits; None if not one."""
    if _local(el) in ("munderover", "msubsup", "munder", "mover", "msub", "msup"):
        el = el[0] if len(el) else el
    if _local(el) == "mo" and (el.text or "") in _LARGE_OPERATORS:
        return el.text
    return None


def _is_large_operator(el: Element) -> bool:
    return _large_operator(el) is not None


def _group(el: Element) -> str:
    return "{" + _latex(el) + "}"


def _base(el: Element) -> str:
    """The LaTeX of a script's base, braced unless it is one token or a fenced group."""
    latex = _latex(el)
    simple = (_local(el) in ("mi", "mn", "mo") and len(el.text or "") <= 1) or _fenced(el)
    return latex if simple else "{" + latex + "}"


def _fenced(el: Element) -> bool:
    return (
        _local(el) == "mrow"
        and len(el) >= 2
        and el[0].get("form") == "prefix"
        and el[-1].get("form") == "postfix"
    )


def _token(text: str) -> str:
    out: list[str] = []
    for ch in text:
        if ch in _UNMAPPED:
            raise _Unsupported(ch)
        out.append(_SYMBOLS.get(ch, ch))
    return _join_tokens(out)


def _join_tokens(pieces: list[str]) -> str:
    out = ""
    for piece in pieces:
        if out and piece and _COMMAND_END.search(out) and piece[0].isalpha():
            out += " "
        out += piece
    return out


def _latex(el: Element) -> str:
    name = _local(el)
    kids = list(el)
    text = el.text or ""
    if name == "mi":
        variant = el.get("mathvariant")
        if variant is not None:
            if variant not in _VARIANTS:
                raise _Unsupported(variant)
            return f"{_VARIANTS[variant]}{{{_token(text)}}}"
        return _token(text) if len(text) == 1 else f"\\operatorname{{{_token(text)}}}"
    if name == "mn":
        return text
    if name == "mo":
        if el.get("fence") == "true":
            if text not in _FENCES:
                raise _Unsupported(text)
            return ("\\left" if el.get("form") == "prefix" else "\\right") + _FENCES[text]
        return _LARGE_OPERATORS.get(text) or _token(text)
    if name == "mtext":
        return "\\text{" + "".join(_TEXT_ESCAPES.get(ch, ch) for ch in text) + "}"
    if name == "mrow":
        return _join(kids)
    if name == "mfrac" and len(kids) == 2:
        return f"\\frac{_group(kids[0])}{_group(kids[1])}"
    if name == "msqrt" and len(kids) == 1:
        return f"\\sqrt{_group(kids[0])}"
    if name == "mroot" and len(kids) == 2:
        return f"\\sqrt[{_latex(kids[1])}]{_group(kids[0])}"
    if name in ("msup", "msub", "msubsup", "munder", "mover", "munderover"):
        return _scripts(el, name, kids)
    if name == "mtable":
        rows = [_table_row(row) for row in kids]
        return "\\begin{aligned}" + "\\\\".join(rows) + "\\end{aligned}"
    raise _Unsupported(name)


def _table_row(row: Element) -> str:
    if _local(row) != "mtr" or any(_local(cell) != "mtd" for cell in row):
        raise _Unsupported("table row")
    return "&".join(_join(list(cell)) for cell in row)


def _scripts(el: Element, name: str, kids: list[Element]) -> str:
    """Sub- and superscripts, limits of a large operator, and accents."""
    expected = 3 if name in ("msubsup", "munderover") else 2
    if len(kids) != expected:
        raise _Unsupported(name)
    op = _large_operator(kids[0])
    if name == "mover" and op is None:
        accent = _ACCENTS.get(kids[1].text or "") if _local(kids[1]) == "mo" else None
        if accent is None or el.get("accent") != "true":
            raise _Unsupported("over")
        return f"{accent}{_group(kids[0])}"
    if name.startswith("mu") and op is None:
        raise _Unsupported(name)
    base = _base(kids[0])
    if op is not None:
        limits = name.startswith("mu")
        if limits and op in _INTEGRALS:
            base += "\\limits"
        elif not limits and op not in _INTEGRALS:
            base += "\\nolimits"
    lower = kids[1] if name in ("msub", "msubsup", "munder", "munderover") else None
    upper = kids[-1] if name in ("msup", "msubsup", "mover", "munderover") else None
    return (
        base
        + (f"_{_group(lower)}" if lower is not None else "")
        + (f"^{_group(upper)}" if upper is not None else "")
    )


# --- Equations in the document ---------------------------------------------------------------


def _accepted(o: Element, ctx: InlineContext) -> Element:
    """A copy of `o` with its tracked changes accepted, each counted in `ctx.changes`."""
    source = copy.deepcopy(o)

    def accept(parent: Element) -> None:
        index = 0
        while index < len(parent):
            child = parent[index]
            if child.tag in _REJECTED:
                ctx.changes += 1
                del parent[index]
            elif child.tag in _ACCEPTED:
                ctx.changes += 1
                accept(child)
                parent[index : index + 1] = list(child)
                index += len(child)
            else:
                accept(child)
                index += 1

    accept(source)
    return source


def equation_of(o: Element, ctx: InlineContext, *, at: str, display: bool) -> Equation:
    """The equation an `m:oMath` becomes, inside the paragraph or block `at`, recorded with its
    rendered image in `ctx.media`. A display equation is rendered in display form."""
    media = ctx.media
    if media is None:
        raise DecompositionFailed("equations need a media context", at)
    equation_id = media.new_id(at, "eq")
    source = _accepted(o, ctx)
    mathml = omml_to_mathml(source)
    latex = mathml_to_latex(mathml) if mathml is not None else None
    xml = ElementTree.tostring(source, encoding="unicode")
    body = f"<w:p><m:oMathPara>{xml}</m:oMathPara></w:p>" if display else f"<w:p>{xml}</w:p>"
    parts, rels = media.referenced(source)
    png = media.renderer.render(media.fragment(body, parts, rels))
    if png is None:
        raise DecompositionFailed(f"equation {equation_id} could not be rendered", at)
    image = media.add_rendered(media.new_id(equation_id), png, "center" if display else "inline")
    if mathml is None:
        ctx.flags.append(
            Flag(
                code="equation_image_only",
                severity="warning",
                at=at,
                message=f"equation {equation_id} kept as an image only",
            )
        )
    equation = Equation(id=equation_id, mathml=mathml, latex=latex, image_id=image.id)
    media.equations.append(equation)
    return equation
