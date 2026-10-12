from __future__ import annotations

import re
from dataclasses import dataclass

from .specs import CopySelection, Section

PAGE_BREAK = "\n\f\n"


class MissingSectionsError(Exception):
    def __init__(self, missing: list[str]) -> None:
        super().__init__(f"required sections not found: {', '.join(missing)}")
        self.missing = missing


@dataclass(frozen=True)
class SectionSpan:
    """A matched section: [start, end) offsets into the joined document text."""

    id: str
    start: int
    end: int


def section_spans(text: str, sections: list[Section]) -> tuple[list[SectionSpan], list[str]]:
    """Where each section lies in `text`, in document order, plus the ids of unmatched sections.

    Each section starts at the first match of its anchor (multiline regex) and runs until the
    next matched anchor. When anchors match at the same position, the section declared earlier
    gets an empty span and the later one the text, so a catch-all start-of-text section yields to
    a more specific one. Shared by production segmentation and the workbench preview grid.
    Raises re.error for an invalid anchor.
    """
    starts: list[tuple[int, int, str]] = []
    unmatched: list[str] = []
    for order, section in enumerate(sections):
        match = re.search(section.anchor, text, re.MULTILINE)
        if match:
            starts.append((match.start(), order, section.id))
        else:
            unmatched.append(section.id)
    starts.sort()
    spans = [
        SectionSpan(section_id, start, starts[i + 1][0] if i + 1 < len(starts) else len(text))
        for i, (start, _, section_id) in enumerate(starts)
    ]
    return spans, unmatched


def segment(
    pages: list[str], sections: list[Section], page_marker: str | None = None
) -> dict[str, str]:
    """Split document text into sections (see section_spans). Missing optional sections map to
    "". With `page_marker` (a multiline regex such as the "[page N]" lines added to each page), a
    section starting mid-page is prefixed with that page's marker so its page stays known."""
    text = PAGE_BREAK.join(pages)
    spans, unmatched = section_spans(text, sections)
    required = {s.id for s in sections if s.required}
    missing = [section_id for section_id in unmatched if section_id in required]
    if missing:
        raise MissingSectionsError(missing)

    markers = (
        [(m.start(), m.group(0)) for m in re.finditer(page_marker, text, re.MULTILINE)]
        if page_marker
        else []
    )
    result = {s.id: "" for s in sections}
    for span in spans:
        body = text[span.start : span.end].strip()
        marker = next((m for pos, m in reversed(markers) if pos <= span.start), None)
        if body and marker and not body.startswith(marker):
            body = f"{marker}\n{body}"
        result[span.id] = body
    return result


def select_copy(pages: list[str], copies: CopySelection) -> tuple[int, list[str]]:
    """Keep one copy of a multi-copy document. Returns (index of first kept page, pages).

    Copies start on pages where `copies.anchor` matches. `last` keeps the last copy through to
    the end; `first` keeps everything before the second copy. Fewer than two matches: no-op.
    """
    pattern = re.compile(copies.anchor, re.MULTILINE)
    starts = [i for i, text in enumerate(pages) if pattern.search(text)]
    if len(starts) < 2:
        return 0, pages
    if copies.select == "last":
        return starts[-1], pages[starts[-1] :]
    return 0, pages[: starts[1]]
