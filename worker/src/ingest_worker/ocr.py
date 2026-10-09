"""OCR for image-only / low-text PDF pages using a vision model (default: olmOCR 2).

Pages are rendered to PNG (longest side 1288px, as olmOCR was trained on), sent with olmOCR's
prompt, and the YAML front matter it returns is parsed. When the model reports the page is
rotated, the page is re-rendered with the suggested clockwise correction and retried once.
"""

from __future__ import annotations

import html
import io
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any

import yaml

from .llm.base import LLMProvider, VisionRequest
from .specs import OcrMode

#: olmOCR v4 "no anchoring" YAML prompt — the model is fine-tuned on this exact text.
OLMOCR_PROMPT = (
    "Attached is one page of a document that you must process. Just return the plain text "
    "representation of this document as if you were reading it naturally. Convert equations "
    "to LateX and tables to HTML.\n"
    "If there are any figures or charts, label them with the following markdown syntax "
    "![Alt text describing the contents of the figure](page_startx_starty_width_height.png)\n"
    "Return your output as markdown, with a front matter section on top specifying values for "
    "the primary_language, is_rotation_valid, rotation_correction, is_table, and is_diagram "
    "parameters."
)

#: (pdf bytes, page index, longest side px, clockwise rotation degrees) -> PNG bytes
PageRenderer = Callable[[bytes, int, int, int], bytes]


@dataclass(frozen=True)
class OcrSettings:
    model: str
    min_chars: int = 25
    longest_dim: int = 1288
    max_tokens: int = 8000
    temperature: float | None = 0.1
    #: Pages OCR'd in parallel. Match the server's parallel-request capacity.
    concurrency: int = 1


@dataclass
class OcrPage:
    index: int
    text: str
    rotation: int
    raw: list[str] = field(default_factory=list)


def pages_needing_ocr(pages: list[str], mode: OcrMode, min_chars: int) -> list[int]:
    if mode == "never":
        return []
    if mode == "always":
        return list(range(len(pages)))
    return [i for i, text in enumerate(pages) if len("".join(text.split())) < min_chars]


_FRONT_MATTER = re.compile(r"\A\s*---\s*\n(.*?)\n---\s*\n?", re.DOTALL)
_TABLE = re.compile(r"<table\b.*?</table>", re.DOTALL | re.IGNORECASE)
_ROW = re.compile(r"<tr\b[^>]*>(.*?)</tr>", re.DOTALL | re.IGNORECASE)
_CELL = re.compile(r"<t[dh]\b[^>]*>(.*?)</t[dh]>", re.DOTALL | re.IGNORECASE)
_TAG = re.compile(r"<[^>]+>")


def _flatten_table(match: re.Match[str]) -> str:
    """HTML table -> one text line per row, cells separated by two spaces (like pypdf layout
    text), so spec section anchors match OCR'd and native pages alike."""
    rows = []
    for row in _ROW.findall(match.group(0)):
        cells = [" ".join(html.unescape(_TAG.sub(" ", c)).split()) for c in _CELL.findall(row)]
        rows.append("  ".join(cells))
    return "\n".join(rows)


def parse_olmocr(raw: str) -> tuple[str, dict[str, Any]]:
    """Split olmOCR output into (plain text, front-matter metadata)."""
    meta: dict[str, Any] = {}
    body = raw
    if match := _FRONT_MATTER.match(raw):
        try:
            loaded = yaml.safe_load(match.group(1))
            meta = loaded if isinstance(loaded, dict) else {}
        except yaml.YAMLError:
            meta = {}
        body = raw[match.end() :]
    return _TABLE.sub(_flatten_table, body).strip(), meta


def render_page_png(pdf: bytes, index: int, longest_dim: int, rotation: int = 0) -> bytes:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(pdf)
    try:
        page = doc[index]
        width, height = page.get_size()
        bitmap = page.render(scale=longest_dim / max(width, height), rotation=rotation)
        buf = io.BytesIO()
        bitmap.to_pil().save(buf, format="PNG")
        return buf.getvalue()
    finally:
        doc.close()


def ocr_page(
    provider: LLMProvider,
    model_id: str,
    pdf: bytes,
    index: int,
    settings: OcrSettings,
    render: PageRenderer,
) -> OcrPage:
    def run(rotation: int) -> tuple[str, dict[str, Any], str]:
        image = render(pdf, index, settings.longest_dim, rotation)
        result = provider.complete_vision(
            model_id,
            VisionRequest(
                prompt=OLMOCR_PROMPT,
                image_png=image,
                max_tokens=settings.max_tokens,
                temperature=settings.temperature,
            ),
        )
        text, meta = parse_olmocr(result.text)
        return text, meta, result.text

    text, meta, raw = run(0)
    page = OcrPage(index, text, 0, [raw])
    correction = meta.get("rotation_correction")
    if meta.get("is_rotation_valid") is False and correction in (90, 180, 270):
        text, _, raw = run(int(correction))
        page = OcrPage(index, text, int(correction), [*page.raw, raw])
    return page
