"""Minimal .docx builder for the decomposition tests."""

from __future__ import annotations

import io
import zipfile

W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
NAMESPACES = (
    f'xmlns:w="{W_NS}" xmlns:r="{R_NS}" '
    'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" '
    'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" '
    'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture" '
    'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" '
    'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" '
    'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup" '
    'xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" '
    'xmlns:v="urn:schemas-microsoft-com:vml" '
    'xmlns:o="urn:schemas-microsoft-com:office:office" '
    'xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" '
    'xmlns:dgm="http://schemas.openxmlformats.org/drawingml/2006/diagram"'
)
_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
_REL_BASE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/"

DEFAULT_STYLES = (
    f"<w:styles {NAMESPACES}>"
    + "".join(
        f'<w:style w:type="paragraph" w:styleId="Heading{n}"><w:name w:val="heading {n}"/>'
        f'<w:pPr><w:outlineLvl w:val="{n - 1}"/></w:pPr></w:style>'
        for n in (1, 2, 3)
    )
    + '<w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="caption"/></w:style>'
    "</w:styles>"
)


def _part(root: str) -> str:
    return _DECL + root


def build_docx(
    body: str,
    *,
    styles: str | None = None,
    numbering: str | None = None,
    footnotes: str | None = None,
    endnotes: str | None = None,
    headers: dict[str, str] | None = None,
    core: str | None = None,
    custom: str | None = None,
    media: dict[str, bytes] | None = None,
    rels: list[tuple[str, str, str]] | None = None,
    sect_pr: str | None = None,
    extra_parts: dict[str, bytes] | None = None,
) -> bytes:
    """Build a minimal valid package. `rels` entries are (id, type suffix or URI, target); a
    target starting `http` is external. `extra_parts` adds raw parts by package path."""
    parts: dict[str, str | bytes] = dict(extra_parts or {})
    overrides = ['<Override PartName="/word/document.xml" ContentType="application/xml"/>']
    doc_rels: list[tuple[str, str, str]] = [("rIdStyles", "styles", "styles.xml")]
    parts["word/styles.xml"] = _part(styles if styles is not None else DEFAULT_STYLES)
    optional = {
        "numbering": ("word/numbering.xml", numbering),
        "footnotes": ("word/footnotes.xml", footnotes),
        "endnotes": ("word/endnotes.xml", endnotes),
    }
    for rel_type, (name, content) in optional.items():
        if content is not None:
            parts[name] = _part(content)
            doc_rels.append((f"rId_{rel_type}", rel_type, name.removeprefix("word/")))
    for name, content in (headers or {}).items():
        parts[f"word/{name}"] = _part(content)
        doc_rels.append((f"rId_{name}", "header", name))
    for name, data in (media or {}).items():
        parts[f"word/media/{name}"] = data
    doc_rels.extend(rels or [])

    root_rels = [("rId1", "officeDocument", "word/document.xml")]
    if core is not None:
        parts["docProps/core.xml"] = _part(core)
        root_rels.append(("rIdCore", "core-properties", "docProps/core.xml"))
    if custom is not None:
        parts["docProps/custom.xml"] = _part(custom)
        root_rels.append(("rIdCustom", "custom-properties", "docProps/custom.xml"))

    sect = sect_pr or ""
    parts["word/document.xml"] = _part(
        f"<w:document {NAMESPACES}><w:body>{body}{sect}</w:body></w:document>"
    )
    parts["word/_rels/document.xml.rels"] = _part(_rels_xml(doc_rels))
    parts["_rels/.rels"] = _part(_rels_xml(root_rels))
    parts["[Content_Types].xml"] = _part(
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        '<Default Extension="xml" ContentType="application/xml"/>'
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + "".join(overrides)
        + "</Types>"
    )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in parts.items():
            zf.writestr(name, content)
    return buf.getvalue()


def _rels_xml(rels: list[tuple[str, str, str]]) -> str:
    items = "".join(
        f'<Relationship Id="{rid}" '
        f'Type="{typ if typ.startswith("http") else _REL_BASE + typ}" Target="{target}"'
        + (' TargetMode="External"' if target.startswith("http") else "")
        + "/>"
        for rid, typ, target in rels
    )
    return f'<Relationships xmlns="{REL_NS}">{items}</Relationships>'
