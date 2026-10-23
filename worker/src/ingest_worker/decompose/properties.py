"""Document properties offered to the target: core, custom, and name/value fields of headers.

Headers and footers contribute nothing to content; they are read here only for the properties
they carry, a `DOCVARIABLE` field (its name and result) and a table row that pairs a label with
a value. Header and footer parts are found through the main part's relationships.
"""

from __future__ import annotations

import copy
from xml.etree.ElementTree import Element

from .inline import InlineContext, W, inlines_of, plain_text
from .model import Property
from .package import Package

_MAIN = "word/document.xml"
_REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"
_HEADER_FOOTER = (f"{_REL_BASE}header", f"{_REL_BASE}footer")
_DC = "{http://purl.org/dc/elements/1.1/}"
_CP = "{http://schemas.openxmlformats.org/package/2006/metadata/core-properties}"
_DCTERMS = "{http://purl.org/dc/terms/}"
_CUSTOM = "{http://schemas.openxmlformats.org/officeDocument/2006/custom-properties}"
_MC = "{http://schemas.openxmlformats.org/markup-compatibility/2006}"
_M = "{http://schemas.openxmlformats.org/officeDocument/2006/math}"

_CORE = (
    ("title", f"{_DC}title"),
    ("subject", f"{_DC}subject"),
    ("author", f"{_DC}creator"),
    ("keywords", f"{_CP}keywords"),
    ("created", f"{_DCTERMS}created"),
    ("modified", f"{_DCTERMS}modified"),
)
#: Elements that are not text a header can offer as a value; removed before reading, so that
#: reading a header never needs the media context and never records an image or equation.
_NON_TEXT = {
    f"{W}drawing",
    f"{W}pict",
    f"{W}object",
    f"{_MC}AlternateContent",
    f"{_M}oMath",
    f"{_M}oMathPara",
}
_LABEL_LIMIT = 40

#: A header property with its position in the part, so both kinds come out in document order.
Found = tuple[int, Property]


def properties_of(pkg: Package) -> list[Property]:
    """The core, custom and header-field properties of a package, in that order, each
    (name, value, origin) once."""
    found = [*_core(pkg), *_custom(pkg), *_header_fields(pkg)]
    seen: set[tuple[str, str, str]] = set()
    unique: list[Property] = []
    for prop in found:
        key = (prop.name, prop.value, prop.origin)
        if key not in seen:
            seen.add(key)
            unique.append(prop)
    return unique


def _core(pkg: Package) -> list[Property]:
    root = pkg.xml("docProps/core.xml")
    if root is None:
        return []
    props = []
    for name, tag in _CORE:
        el = root.find(tag)
        value = "".join(el.itertext()).strip() if el is not None else ""
        if value:
            props.append(Property(name=name, value=value, origin="core"))
    return props


def _custom(pkg: Package) -> list[Property]:
    root = pkg.xml("docProps/custom.xml")
    if root is None:
        return []
    props = []
    for el in root.findall(f"{_CUSTOM}property"):
        name = el.get("name")
        value = "".join(el.itertext()).strip()
        if name and value:
            props.append(Property(name=name, value=value, origin="custom"))
    return props


def _header_parts(pkg: Package) -> list[str]:
    """Every header and footer part the main part relates to, in relationship order."""
    parts: list[str] = []
    for rel in pkg.rels(_MAIN).values():
        if rel.type not in _HEADER_FOOTER or rel.external:
            continue
        target = pkg.target(_MAIN, rel.id)
        if target is not None and target not in parts:
            parts.append(target)
    return parts


def _header_fields(pkg: Package) -> list[Property]:
    props: list[Property] = []
    for part in _header_parts(pkg):
        root = pkg.xml(part)
        if root is None:
            continue
        _strip_non_text(root)
        order = {id(el): i for i, el in enumerate(root.iter())}
        found = [*_docvariables(root, part, order), *_label_rows(root, part, order)]
        props.extend(prop for _, prop in sorted(found, key=lambda item: item[0]))
    return props


def _strip_non_text(root: Element) -> None:
    for parent in list(root.iter()):
        for child in list(parent):
            if child.tag in _NON_TEXT:
                parent.remove(child)


def _docvariables(root: Element, part: str, order: dict[int, int]) -> list[Found]:
    """Each `DOCVARIABLE <name>` field of the part with its result, placed at the paragraph it
    closes in. A throwaway context reads the paragraphs, so nothing reaches the document's."""
    ctx = InlineContext()
    props: list[Found] = []
    for p in root.iter(f"{W}p"):
        before = len(ctx.closed_fields)
        inlines_of(p, ctx, at=part)
        for state in ctx.closed_fields[before:]:
            tokens = state.tokens
            name = tokens[1] if len(tokens) > 1 else ""
            value = state.result.strip()
            if state.kind == "DOCVARIABLE" and name and value:
                prop = Property(name=name, value=value, origin="header-field")
                props.append((order[id(p)], prop))
    return props


def _label_rows(root: Element, part: str, order: dict[int, int]) -> list[Found]:
    """Each table row of exactly two non-empty cells whose first reads as a label."""
    ctx = InlineContext()
    props: list[Found] = []
    for tbl in root.iter(f"{W}tbl"):
        for tr in tbl.findall(f"{W}tr"):
            cells = [_cell_text(tc, ctx, part) for tc in tr.findall(f"{W}tc")]
            if len(cells) != 2 or not all(cells):
                continue
            label, value = cells
            if not (label.endswith(":") or len(label) < _LABEL_LIMIT):
                continue
            name = label.removesuffix(":").strip()
            if name:
                prop = Property(name=name, value=value, origin="header-field")
                props.append((order[id(tr)], prop))
    return props


def _cell_text(tc: Element, ctx: InlineContext, part: str) -> str:
    texts = (
        plain_text(inlines_of(copy.deepcopy(p), ctx, at=part)).strip() for p in tc.findall(f"{W}p")
    )
    return " ".join(t for t in texts if t)
